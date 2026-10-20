import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnInWindowsJob } from '../windows-job.mjs';

// Resolve an executable or an official npm entry point; never execute a shell shim.
export function resolveCli(name, { env = process.env, platform = process.platform, explicitPath } = {}) {
  // An explicit runtime is a user choice, so an invalid value must never silently
  // select another installation from PATH (which may have different behaviour).
  if (explicitPath !== undefined) {
    if (typeof explicitPath !== 'string' || !explicitPath || !path.isAbsolute(explicitPath)) {
      throw new Error(`${name} executable path must be an absolute file path.`);
    }
    if (platform === 'win32' && path.basename(explicitPath).toLowerCase() !== `${name}.exe`) {
      throw new Error(`${name} executable path must name ${name}.exe on Windows.`);
    }
    let resolved;
    try {
      resolved = realpathSync(explicitPath);
      if (!statSync(resolved).isFile()) throw new Error('not a regular file');
    } catch {
      throw new Error(`${name} executable path does not exist or is not a regular file: ${explicitPath}`);
    }
    return { command: resolved, args: [] };
  }
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  if (platform === 'win32') {
    dirs.push(path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm'));
    dirs.push(path.join(env.USERPROFILE || os.homedir(), '.local', 'bin'));
  }
  const packageName = name === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
  const entry = name === 'codex' ? 'bin/codex.js' : 'cli.js';
  for (const dir of [...new Set(dirs)]) {
    // Ignore relative PATH entries, so a project cannot shadow the official CLI.
    if (!path.isAbsolute(dir)) continue;
    const native = path.join(dir, name + (platform === 'win32' ? '.exe' : ''));
    if (existsSync(native)) return { command: realpathSync(native), args: [] };
    const js = path.join(dir, 'node_modules', packageName, entry);
    if (!existsSync(js)) continue;
    if (name === 'codex' && platform === 'win32') {
      try {
        const req = createRequire(js);
        const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
        const pkg = req.resolve(`@openai/codex-win32-${arch}/package.json`);
        const triple = arch === 'arm64' ? 'aarch64' : 'x86_64';
        const binary = path.join(path.dirname(pkg), 'vendor', `${triple}-pc-windows-msvc`, 'bin', 'codex.exe');
        if (existsSync(binary)) return { command: binary, args: [] };
      } catch { /* Older official npm packages use the JS launcher. */ }
    }
    return { command: process.execPath, args: [js] };
  }
  return null;
}

export function subscriptionEnv(provider, env = process.env) {
  const result = { ...env };
  // Avoid fallback to a separately billed API credential inherited by the host.
  const denied = provider === 'codex'
    ? ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT', 'CODEX_THREAD_ID']
    : ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
  for (const key of denied) delete result[key];
  return result;
}

export function spawnCli(cli, args, options = {}) {
  if (options.workerLifecycle?.kind === 'windows-job-v1') {
    return spawnInWindowsJob(cli, args, { cwd: options.cwd, env: options.env, jobName: options.workerLifecycle.jobName });
  }
  return spawn(cli.command, [...(cli.args || []), ...args], {
    windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], ...options,
    // These cannot be overridden by model input or callers.
    shell: false, windowsHide: true,
  });
}

export async function terminateCli(child) {
  if (child.jobClosed) {
    if (child.exitCode == null && child.signalCode == null) child.kill();
    await child.jobClosed;
    return;
  }
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise(resolve => child.once('close', resolve));
  if (process.platform === 'win32' && child.jobName) {
    // Kill the supervisor through its retained process handle. Closing its job
    // handle stops descendants without looking up a potentially reused PID.
    child.kill();
  } else if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    // Stop only this child process tree, never by executable name.
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    await new Promise(resolve => {
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('close', resolve);
    });
  }
  if (child.exitCode == null && child.signalCode == null) child.kill();
  await exited;
}

export function safeError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redacted]')
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,]+/gi, '$1[redacted]')
    .slice(0, 2000);
}

export function captureCli(cli, args, { timeout = 12000, cwd, env, spawnProcess = spawnCli } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnProcess(cli, args, { cwd, env }); } catch (error) { reject(error); return; }
    let stdout = '', stderr = '', done = false;
    const settle = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => { child.kill(); settle(new Error('CLI response timed out')); }, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1048576); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.on('error', error => settle(error));
    child.on('close', code => settle(null, { code, stdout, stderr }));
    child.stdin.end();
  });
}

export function makeLineReader(stream, onLine, onFailure, maxLine = 16 * 1024 * 1024) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
      if (line.length > maxLine) { onFailure(new Error('CLI event exceeds size limit')); return; }
      if (line.trim()) onLine(line);
    }
    if (buffer.length > maxLine) { buffer = ''; onFailure(new Error('CLI event exceeds size limit')); }
  });
  stream.on('end', () => { if (buffer.trim()) onLine(buffer); buffer = ''; });
}

export const providerBase = (id, name) => ({ id, name, installed: false, authenticated: false,
  authMode: 'none', version: null, models: [], quota: [], updatedAt: new Date().toISOString() });
