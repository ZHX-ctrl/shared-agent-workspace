import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const hostPath = fileURLToPath(new URL('./windows-job-host.ps1', import.meta.url));
const jobPattern = /^Local\\SharedAgentWorkspace-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const powershell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const hostArguments = mode => ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', hostPath, '-Mode', mode];

function validateJobName(name) {
  if (typeof name !== 'string' || !jobPattern.test(name)) throw new TypeError('Invalid workspace Windows Job name.');
}

// Returns the actual hidden host ChildProcess synchronously; its three standard
// streams belong exclusively to the CLI. The control pipe is separate and is
// held only by this parent. Closing that pipe or killing the host kills the Job.
export function spawnInWindowsJob(cli, args = [], { cwd, env = process.env, jobName = `Local\\SharedAgentWorkspace-${randomUUID()}`, startupTimeout = 30000 } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows Job Objects require Windows.');
  validateJobName(jobName);
  if (!Number.isSafeInteger(startupTimeout) || startupTimeout < 1000 || startupTimeout > 120000) throw new TypeError('Invalid Windows Job startup timeout.');
  if (!cli || typeof cli.command !== 'string' || !path.isAbsolute(cli.command)) throw new TypeError('The CLI executable must be an absolute path.');
  const argumentsList = [...(cli.args || []), ...args];
  if (argumentsList.some(arg => typeof arg !== 'string' || arg.includes('\0')) || cli.command.includes('\0')) throw new TypeError('Invalid CLI argument.');
  if (cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) throw new TypeError('The working directory must be an absolute path.');
  const pipeName = `SharedAgentWorkspace-control-${randomUUID()}`;
  const token = randomBytes(32).toString('hex');
  const config = Buffer.from(JSON.stringify({ command: cli.command, args: argumentsList, cwd: cwd || process.cwd(), jobName, pipeName, token, startupTimeout })).toString('base64');
  const server = createServer();
  const sockets = new Set();
  let child, timer, settled = false, stopped = false, control = null;
  let readyResolve, readyReject;
  const jobReady = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Consumers may use ordinary ChildProcess events only.
  jobReady.catch(() => {});
  const failReady = error => { if (!settled) { settled = true; readyReject(error); } };
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  server.on('connection', socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '', authenticated = false;
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      if (socket === control && !stopped && !settled) failReady(new Error('Windows Job host disconnected before startup.'));
    });
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 65536) { socket.destroy(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!authenticated) {
          if (control || stopped || message.type !== 'created' || message.token !== token || message.jobName !== jobName) { socket.destroy(); return; }
          authenticated = true; control = socket;
          // The helper has already created the Job. An old helper cannot obtain
          // this one-time authorization from a restarted parent/new pipe.
          socket.write(`${JSON.stringify({ type: 'start', token })}\n`);
        } else if (message.type === 'started') {
          if (!settled) { settled = true; clearTimeout(timer); readyResolve({ jobName, pid: message.pid }); }
        } else if (message.type === 'error') {
          failReady(new Error(`Windows Job host: ${message.message}`));
        }
      }
    });
  });
  server.on('error', error => { failReady(error); if (child) child.kill(); cleanup(); });
  server.listen(`\\\\.\\pipe\\${pipeName}`);
  try {
    child = spawn(powershell(), hostArguments('Run'), {
      cwd, env: { ...env, SHARED_WORKSPACE_JOB_CONFIG: config }, windowsHide: true,
      shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) { failReady(error); cleanup(); throw error; }
  timer = setTimeout(() => {
    failReady(new Error('Windows Job host startup timed out.'));
    cleanup(); child.kill();
  }, startupTimeout);
  timer.unref();
  child.jobName = jobName;
  child.jobReady = jobReady;
  child.jobClosed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.once('error', error => { failReady(error); cleanup(); });
  child.once('exit', (code, signal) => { failReady(new Error(`Windows Job host exited before startup (${code}/${signal}).`)); cleanup(); });
  return child;
}

// Failure to open/query is not absence: only ERROR_FILE_NOT_FOUND means absent.
// An existing empty Job may still be starting and MUST retain its scope lock.
export async function probeWindowsJob(jobName, { timeout = 15000 } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows Job Objects require Windows.');
  validateJobName(jobName);
  return await new Promise((resolve, reject) => {
    const child = spawn(powershell(), [...hostArguments('Probe'), '-JobName', jobName], {
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', done = false;
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Windows Job probe timed out; lifecycle is unknown.')); }, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 65536) { child.kill(); finish(new Error('Windows Job probe output too large.')); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (code !== 0) { finish(new Error(`Windows Job probe failed (${code}): ${stderr.trim()}`)); return; }
      try {
        const result = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
        if (typeof result.exists !== 'boolean' || (result.exists && (!Number.isSafeInteger(result.activeProcesses) || result.activeProcesses < 0))) throw new Error('Invalid Windows Job probe result.');
        finish(null, result);
      } catch (error) { finish(error); }
    });
  });
}
