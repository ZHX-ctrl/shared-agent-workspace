import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, readdir, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolveCli, spawnCli, subscriptionEnv, terminateCli } from './adapters/process.mjs';
import { acquireClaudeLifecycleLocks } from './claude-lifecycle-lock.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const states = new Set(['archiving', 'archived', 'restoring', 'restored', 'deleting', 'deleted']);
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const within = (root, target) => { const relative = path.relative(key(root), key(target)); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); };
const fail = message => { throw new Error(message); };
const exists = async file => { try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

// Refuse links at every existing path component; realpath alone would silently
// follow a junction outside the intended data tree. Missing suffixes are allowed.
async function safePath(file, { directory = false } = {}) {
  if (!path.isAbsolute(file)) fail('Claude 会话路径必须是绝对路径。');
  const resolved = path.resolve(file), root = path.parse(resolved).root;
  let current = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const info = await exists(current);
    if (!info) return resolved;
    if (info.isSymbolicLink()) fail('Claude 会话路径含符号链接或目录联接，已停止同步。');
    if (current !== resolved && !info.isDirectory()) fail('Claude 会话路径的父目录无效。');
    if (current === resolved && directory && !info.isDirectory()) fail('Claude 会话目录无效。');
  }
  return resolved;
}

async function powershell(script, input = null) {
  if (process.platform !== 'win32') fail('当前 Claude 安全生命周期实现仅验证了 Windows；未执行操作。');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from("[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)\n[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n" + script, 'utf16le').toString('base64');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Claude 本机会话安全检查超时。')); }, 10000);
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-4096); }); child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法执行 Claude 本机会话安全检查。')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error('Claude 本机会话安全检查未通过；未覆盖已有文件。')); });
    child.stdin.on('error', () => {}); child.stdin.end(input == null ? '' : JSON.stringify(input));
  });
}

// Official local registry only; no inference, authentication-file reads or
// transcript reads. https://code.claude.com/docs/en/agent-view#list-sessions-as-json
export function readClaudeActiveSessions(cli, { claudeHome, env = process.env, spawnProcess = spawnCli, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, output = '';
    const finish = (error, rows) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const cleanup = child ? terminateCli(child) : Promise.resolve();
      void cleanup.then(() => error ? reject(error) : resolve(rows), () => reject(new Error('Claude 活动会话检查未能正常结束。')));
    };
    try {
      const safeEnv = subscriptionEnv('claude', env); delete safeEnv.CLAUDECODE;
      if (claudeHome) safeEnv.CLAUDE_CONFIG_DIR = claudeHome;
      child = spawnProcess(cli, ['agents', '--json'], { cwd: claudeHome, env: safeEnv });
    } catch { finish(new Error('无法启动 Claude 活动会话检查，未执行同步。')); return; }
    timer = setTimeout(() => finish(new Error('Claude 活动会话检查超时，未执行同步。')), Math.max(1, Math.min(timeout, 20000)));
    child.stderr.resume(); child.stdin.on('error', () => {}); child.stdin.end();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 2 * 1024 * 1024) finish(new Error('Claude 活动会话列表过大，未执行同步。'));
    });
    child.on('error', () => finish(new Error('Claude 活动会话检查失败，未执行同步。')));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) { finish(new Error('Claude 无法确认活动会话，未执行同步。')); return; }
      try { finish(null, normalizeActiveSessions(JSON.parse(output))); }
      catch { finish(new Error('Claude 活动会话列表无法核对，未执行同步。')); }
    });
  });
}

function normalizeActiveSessions(rows) {
  if (!Array.isArray(rows) || rows.length > 4096) fail('Claude 活动会话列表无效。');
  return rows.map(row => {
    if (!row || !['interactive', 'background'].includes(row.kind)
      || (row.sessionId != null && !UUID.test(row.sessionId))
      || (row.pid != null && (!Number.isSafeInteger(row.pid) || row.pid <= 0))
      || (row.status != null && !['busy', 'waiting', 'idle'].includes(row.status))
      || (row.state != null && !['working', 'blocked', 'done', 'failed', 'stopped'].includes(row.state))
      || (row.cwd != null && (typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd)))) fail('Claude 活动会话列表字段无效。');
    return { kind: row.kind, sessionId: row.sessionId?.toLowerCase() || null, pid: row.pid || null,
      status: row.status || null, state: row.state || null, cwd: row.cwd ? path.resolve(row.cwd) : null };
  });
}

async function moveNoReplace(source, destination, kind) {
  await safePath(source); await safePath(destination);
  if (await exists(destination)) fail('Claude 恢复或暂存位置已有文件，未覆盖。');
  // File.Move/Directory.Move do not replace the destination. fs.rename can
  // overwrite a destination created after a precheck, even on Windows.
  await powershell(`$ErrorActionPreference='Stop'
$x=[Console]::In.ReadToEnd() | ConvertFrom-Json
if ($x.kind -eq 'directory') { [IO.Directory]::Move($x.source,$x.destination) }
else { [IO.File]::Move($x.source,$x.destination) }`, { source, destination, kind });
}

async function snapshot(file) {
  await safePath(file); const info = await exists(file); if (!info) return null;
  const entries = [];
  async function visit(target, relative) {
    if (entries.length > 20000) fail('Claude 会话文件数量超出安全检查范围。');
    const before = await lstat(target);
    if (before.isSymbolicLink()) fail('Claude 会话内部含符号链接或目录联接，已停止同步。');
    if (before.isDirectory()) {
      entries.push({ path: relative, kind: 'directory' });
      for (const name of (await readdir(target)).sort()) await visit(path.join(target, name), relative ? `${relative}/${name}` : name);
      return;
    }
    if (!before.isFile() || before.nlink > 1) fail('Claude 会话含特殊文件或硬链接，已停止同步。');
    const hash = createHash('sha256'); for await (const chunk of createReadStream(target)) hash.update(chunk);
    const after = await lstat(target);
    if (after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) fail('Claude 会话仍在变化，请稍后重试。');
    entries.push({ path: relative, kind: 'file', size: before.size, hash: hash.digest('hex'), mtimeMs: before.mtimeMs });
  }
  await visit(file, ''); return entries;
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameContent = (a, b) => equal(a?.map(({ mtimeMs, ...entry }) => entry), b?.map(({ mtimeMs, ...entry }) => entry));
const remainingContent = (current, original) => !!current && current.every(({ mtimeMs, ...entry }) => {
  const expected = original.find(item => item.path === entry.path);
  if (!expected) return false;
  const { mtimeMs: ignored, ...content } = expected; return equal(entry, content);
});

export function createClaudeChatLifecycle({ claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), sdk,
  archiveRoot = path.join(claudeHome, 'shared-workspace-archive'),
  cli,
  getActiveSessions, acquireLocks = acquireClaudeLifecycleLocks,
  moveExclusive = moveNoReplace, stabilityMs = 120 } = {}) {
  const home = path.resolve(claudeHome), projects = path.join(home, 'projects'), archive = path.resolve(archiveRoot);
  const plans = new WeakSet(); let sdkPromise;
  async function assertInactive(sessions, allowIdleSessionIds = []) {
    let rows;
    try {
      if (getActiveSessions) rows = normalizeActiveSessions(await getActiveSessions());
      else {
        const executable = cli || resolveCli('claude');
        if (!executable) fail('未找到 Claude Code CLI，无法确认活动会话。');
        rows = normalizeActiveSessions(await readClaudeActiveSessions(executable, { claudeHome: home }));
      }
    }
    catch { fail('无法确认 Claude 会话是否仍在运行，未执行同步；请稍后重试。'); }
    for (const row of rows) {
      const live = row.pid || row.status || ['working', 'blocked'].includes(row.state);
      const matched = sessions.some(s => s.sessionId === row.sessionId);
      // Only the desktop coordinator can preflight a specifically owned idle
      // interactive session. Running/unknown sessions remain protected.
      if (matched && allowIdleSessionIds.includes(row.sessionId) && row.kind === 'interactive' && row.status === 'idle') continue;
      if (matched && (live || !['done', 'failed', 'stopped'].includes(row.state))) {
        throw Object.assign(new Error('这条 Claude 会话仍在运行或等待输入，请先结束该会话，再重试同步。'),
          { code: 'CLAUDE_SESSION_ACTIVE', sessionId: row.sessionId });
      }
      if (!row.sessionId && (live || row.kind === 'interactive')) {
        let working;
        if (row.cwd) { try { working = await realpath(row.cwd); } catch { /* Unknown owner stays blocked. */ } }
        if (!working || sessions.some(s => within(s.projectPath, working))) fail('同一项目中有身份尚未确定的 Claude 会话，暂不能安全同步。');
      }
    }
  }
  const api = async () => {
    if (!sdk && key(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) !== key(home)) fail('Claude SDK 与指定数据目录不一致，已停止同步。');
    return sdk || (sdkPromise ||= import('@anthropic-ai/claude-agent-sdk'));
  };
  async function roots() {
    if (!within(home, archive) || key(home) === key(archive) || within(projects, archive)) fail('Claude 暂存目录必须位于其本机数据目录内，且不能位于 projects 中。');
    for (const value of [home, projects, archive]) await safePath(value, { directory: true });
    if (!(await exists(home))?.isDirectory()) fail('未找到 Claude 本机数据目录。');
    // An existing mounted archive root must remain on the same filesystem.
    const a = await exists(archive), h = await lstat(home);
    if (a && a.dev !== h.dev) fail('Claude 暂存目录必须和原会话位于同一卷。');
  }
  const archiveDir = id => path.join(archive, id);
  async function canonicalSession(item) {
    if (item.agent !== 'claude' || !UUID.test(item.sessionId) || !path.isAbsolute(item.cwd || '') || !path.isAbsolute(item.projectPath || '')) fail('Claude 原生会话关联无效。');
    await safePath(item.cwd, { directory: true }); await safePath(item.projectPath, { directory: true });
    const cwd = await realpath(item.cwd), projectPath = await realpath(item.projectPath);
    if (!within(projectPath, cwd)) fail('Claude 会话文件夹不属于该项目。');
    return { agent: 'claude', sessionId: item.sessionId.toLowerCase(), cwd, projectPath };
  }
  async function locate(id) {
    const found = [];
    if (!await exists(projects)) return found;
    // Enumerate project directory names only, and stat this exact UUID. Never
    // read unrelated transcripts or derive ownership from a conversation title.
    for (const entry of await readdir(projects, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        const linked = path.join(projects, entry.name);
        if (await exists(path.join(linked, `${id}.jsonl`)) || await exists(path.join(linked, id))) fail('Claude 会话也出现在链接目录中，无法安全确定唯一归属。');
        continue;
      }
      if (!entry.isDirectory()) continue;
      const dir = path.join(projects, entry.name); await safePath(dir, { directory: true });
      const transcript = path.join(dir, `${id}.jsonl`), sidecar = path.join(dir, id);
      if (await exists(transcript) || await exists(sidecar)) found.push({ transcript, sidecar });
    }
    if (found.length > 1) fail('Claude 会话 UUID 出现在多个项目目录，已停止自动同步。');
    return found;
  }
  async function verifySdk(session, shouldExist) {
    const info = await (await api()).getSessionInfo(session.sessionId, { dir: session.cwd });
    if (!shouldExist) { if (info) fail('Claude 会话仍可从官方 SDK 读取，尚未完成同步。'); return; }
    if (info?.sessionId?.toLowerCase() !== session.sessionId || typeof info.cwd !== 'string') fail('Claude SDK 无法核对这条会话的身份。');
    await safePath(info.cwd, { directory: true });
    if (key(await realpath(info.cwd)) !== key(session.cwd)) fail('Claude 会话和工作台文件夹不一致，已停止同步。');
  }
  async function verifyTranscriptIdentity(session, file) {
    await safePath(file); let pending = '', confirmed = false;
    const inspectLine = line => {
      if (!line.trim()) return;
      let row; try { row = JSON.parse(line); } catch { fail('Claude 主会话包含无效记录，无法确认归属。'); }
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail('Claude 主会话记录无效。');
      // SDK getSessionInfo can fall back to the caller's cwd and requested ID;
      // explicitly read only these ownership fields from this exact transcript.
      if (row.sessionId != null && (typeof row.sessionId !== 'string' || row.sessionId.toLowerCase() !== session.sessionId)) fail('Claude 主会话内部 UUID 不一致。');
      if (row.isSidechain === true) fail('这份 Claude 记录属于子会话，不能作为主聊天同步。');
      if (row.cwd != null && (typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd) || key(row.cwd) !== key(session.cwd))) fail('Claude 主会话内部工作目录不一致。');
      if (row.sessionId && row.cwd) confirmed = true;
    };
    for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
      pending += chunk; let at;
      while ((at = pending.indexOf('\n')) >= 0) { inspectLine(pending.slice(0, at)); pending = pending.slice(at + 1); }
      if (pending.length > 16 * 1024 * 1024) fail('Claude 主会话单条记录过大，无法安全校验。');
    }
    inspectLine(pending);
    if (!confirmed) fail('Claude 主会话缺少明确 UUID 和工作目录，无法确认归属。');
  }
  async function loadManifest(session) {
    const file = path.join(archiveDir(session.sessionId), 'manifest.json'); await safePath(file);
    if (!await exists(file)) return null;
    if ((await lstat(file)).size > 8 * 1024 * 1024) fail('Claude 暂存清单异常。');
    let m; try { m = JSON.parse(await readFile(file, 'utf8')); } catch { fail('Claude 暂存清单无法读取，未继续操作。'); }
    if (m.version !== 1 || !states.has(m.state) || m.identity?.sessionId !== session.sessionId
      || key(m.identity?.cwd || '.') !== key(session.cwd) || key(m.identity?.projectPath || '.') !== key(session.projectPath)
      || key(m.home || '.') !== key(home) || !Array.isArray(m.components)) fail('Claude 暂存清单与当前会话身份不一致。');
    const seen = new Set();
    for (const part of m.components) {
      if (!['transcript', 'sidecar'].includes(part.name) || seen.has(part.name) || !Array.isArray(part.snapshot) || !part.snapshot.length) fail('Claude 暂存清单结构无效。');
      seen.add(part.name);
      const relative = path.relative(projects, part.source || '');
      const bits = relative.split(path.sep);
      if (!within(projects, part.source || '.') || bits.length !== 2 || bits[1] !== (part.name === 'transcript' ? `${session.sessionId}.jsonl` : session.sessionId)) fail('Claude 暂存清单的原位置越界。');
      if (part.kind !== (part.name === 'transcript' ? 'file' : 'directory')) fail('Claude 暂存清单类型无效。');
      if (part.snapshot[0]?.path !== '' || part.snapshot[0]?.kind !== part.kind) fail('Claude 暂存清单根节点无效。');
      const paths = new Set();
      for (const entry of part.snapshot) {
        if (typeof entry.path !== 'string' || entry.path.includes('\\') || entry.path.split('/').some(p => p === '..') || path.isAbsolute(entry.path)
          || paths.has(entry.path) || !['file', 'directory'].includes(entry.kind) || (entry.kind === 'file' && (!HASH.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 0))) fail('Claude 暂存校验记录无效。');
        paths.add(entry.path);
      }
    }
    if (!seen.has('transcript')) fail('Claude 暂存清单缺少主会话记录。');
    return m;
  }
  const destination = (session, part) => path.join(archiveDir(session.sessionId), part.name === 'transcript' ? 'transcript.jsonl' : 'session');
  async function writeManifest(session, manifest) {
    await roots(); await safePath(archiveDir(session.sessionId), { directory: true });
    await mkdir(archiveDir(session.sessionId), { recursive: true });
    const target = path.join(archiveDir(session.sessionId), 'manifest.json'), temporary = path.join(archiveDir(session.sessionId), `.manifest-${randomUUID()}.tmp`);
    await safePath(target);
    try { await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async function inspect(session, operation) {
    const saved = await loadManifest(session), locations = await locate(session.sessionId);
    if (saved && !['restored', 'deleted'].includes(saved.state)) {
      for (const part of saved.components) {
        const source = await snapshot(part.source), staged = await snapshot(destination(session, part));
        if (source && staged) fail('Claude 原位置和暂存位置都有记录，未覆盖或删除任何一份。');
        if (!source && !staged && saved.state !== 'deleting') fail('Claude 暂存记录不完整，请先修复缺失文件。');
        const matches = saved.state === 'deleting' ? remainingContent : sameContent;
        if ((source && !matches(source, part.snapshot)) || (staged && !matches(staged, part.snapshot))) fail('Claude 暂存或原会话校验失败，已停止同步。');
        if (saved.state === 'archived' && source) fail('Claude 恢复位置已被占用，未覆盖。');
        if (part.name === 'transcript' && (source || staged)) await verifyTranscriptIdentity(session, source ? part.source : destination(session, part));
      }
      if (locations[0] && !saved.components.some(p => p.source === locations[0].transcript)) fail('Claude 暂存和本机位置不一致。');
      if (saved.state === 'deleting' && operation !== 'delete') fail('Claude 上次删除尚未完成，请先重试删除。');
      return { session, manifest: saved, absent: false };
    }
    if (!locations.length) {
      await verifySdk(session, false);
      if (operation !== 'delete' && saved?.state !== 'deleted') fail('没有找到这条 Claude 本机会话或可恢复暂存。');
      if (operation !== 'delete') fail('这条 Claude 会话已删除，无法恢复。');
      return { session, manifest: saved, absent: true };
    }
    if (saved?.state === 'deleted') fail('已删除的 Claude UUID 再次出现记录，无法自动确认归属。');
    const native = locations[0];
    if (!(await exists(native.transcript))?.isFile()) fail('Claude 主会话记录缺失，无法确认归属。');
    await verifyTranscriptIdentity(session, native.transcript);
    await verifySdk(session, true);
    const components = [];
    for (const [name, source, kind] of [['transcript', native.transcript, 'file'], ['sidecar', native.sidecar, 'directory']]) {
      const data = await snapshot(source);
      if (data && data[0].kind !== kind) fail('Claude 会话记录类型与官方目录结构不符。');
      if (data) components.push({ name, source, kind, snapshot: data });
    }
    return { session, absent: false, manifest: { version: 1, home, identity: session, state: 'restored', components } };
  }
  async function stable(items, operation, allowIdleSessionIds = []) {
    await assertInactive(items, allowIdleSessionIds);
    const first = await Promise.all(items.map(item => inspect(item, operation)));
    if (stabilityMs > 0) await new Promise(resolve => setTimeout(resolve, stabilityMs));
    await assertInactive(items, allowIdleSessionIds);
    const second = await Promise.all(items.map(item => inspect(item, operation)));
    if (!equal(first, second)) fail('Claude 会话在检查期间发生变化，请结束任务后重试。');
    return second;
  }
  async function prepare({ operation, sessions, allowIdleSessionIds = [], desktopNativeSessionIds = [] }) {
    if (!['archive', 'unarchive', 'delete'].includes(operation) || !Array.isArray(sessions)) fail('未知 Claude 聊天同步操作。');
    await roots();
    const unique = new Map();
    for (const item of sessions) {
      const session = await canonicalSession(item), prior = unique.get(session.sessionId);
      if (prior && !equal(prior, session)) fail('Claude 会话关联冲突。');
      unique.set(session.sessionId, session);
    }
    if (!Array.isArray(desktopNativeSessionIds) || desktopNativeSessionIds.some(id => !unique.has(id))
      || (desktopNativeSessionIds.length && operation === 'delete')) fail('Claude 桌面归档会话预检参数无效。');
    if (!Array.isArray(allowIdleSessionIds) || allowIdleSessionIds.some(id => !unique.has(id))
      || (operation !== 'delete' && allowIdleSessionIds.some(id => !desktopNativeSessionIds.includes(id)))) fail('Claude 桌面空闲会话预检参数无效。');
    const items = await stable([...unique.values()], operation, allowIdleSessionIds);
    if (items.some(item => desktopNativeSessionIds.includes(item.session.sessionId) && item.absent)) fail('Claude 桌面对应的本机会话文件已缺失，未自动归档或恢复。');
    const plan = Object.freeze({ operation, sessions: Object.freeze([...unique.values()].map(Object.freeze)), items,
      allowIdleSessionIds: Object.freeze([...allowIdleSessionIds]), desktopNativeSessionIds: Object.freeze([...new Set(desktopNativeSessionIds)]) });
    plans.add(plan); return plan;
  }
  async function verifyInventory(session, visible) {
    await verifySdk(session, visible);
    const rows = await (await api()).listSessions({ dir: session.cwd, includeWorktrees: false, includeProgrammatic: true });
    if (!Array.isArray(rows) || rows.some(row => row.sessionId?.toLowerCase() === session.sessionId) !== visible) fail('Claude 官方会话列表读回核对未通过，请重试同步。');
  }
  async function restorePayload(session, manifest, lease) {
    const m = structuredClone(manifest);
    if (m.state !== 'restored') {
      m.state = 'restoring'; await writeManifest(session, m);
      for (const part of [...m.components].reverse()) {
        const staged = destination(session, part);
        if (!await exists(staged)) continue;
        if (await exists(part.source)) fail('Claude 恢复位置已有文件，未覆盖。');
        await safePath(path.dirname(part.source), { directory: true });
        if (!await exists(path.dirname(part.source))) fail('Claude 原项目数据目录缺失，未另建或覆盖。');
        await assertInactive([session]); lease.assertHeld(); await moveExclusive(staged, part.source, part.kind);
      }
      for (const part of m.components) if (await exists(destination(session, part)) || !sameContent(await snapshot(part.source), part.snapshot)) fail('Claude 恢复完整性校验失败。');
      lease.assertHeld(); m.state = 'restored'; await writeManifest(session, m);
    }
    await verifyInventory(session, true);
  }
  async function apply(plan, { onProgress = async () => {}, beforeDelete, beforeDesktopArchive } = {}) {
    if (!plans.has(plan)) fail('Claude 同步计划无效，请重新预检。');
    await roots();
    const lease = await acquireLocks({ lockRoot: path.join(archive, '.locks'), sessionIds: plan.sessions.map(s => s.sessionId).sort() });
    try {
    lease.assertHeld();
    if (plan.allowIdleSessionIds.length && plan.operation === 'delete' && typeof beforeDelete !== 'function') fail('Claude 桌面会话必须先通过官方入口结束，未执行本地删除。');
    if (plan.desktopNativeSessionIds.length && typeof beforeDesktopArchive !== 'function') fail('Claude 桌面归档必须通过官方入口核验，未执行本地暂存。');
    let items = await stable(plan.sessions, plan.operation, plan.allowIdleSessionIds);
    let desktop;
    if (plan.desktopNativeSessionIds.length || typeof beforeDesktopArchive === 'function') {
      // Old workbench versions moved transcripts into a local vault. Restore
      // only those exact verified payloads before using Desktop's reversible
      // archive state; Desktop must never point to a missing transcript.
      for (const item of items.filter(item => plan.desktopNativeSessionIds.includes(item.session.sessionId))) {
        if (item.absent) fail('Claude 桌面的原会话文件已缺失，未继续归档或恢复。');
        lease.assertHeld();
        await restorePayload(item.session, item.manifest, lease);
      }
      lease.assertHeld(); desktop = await beforeDesktopArchive();
      if (desktop?.status !== 'verified' || desktop.operation !== plan.operation || !Array.isArray(desktop.sessions)
        || desktop.sessions.length !== plan.desktopNativeSessionIds.length
        || plan.desktopNativeSessionIds.some(id => !desktop.sessions.includes(id))) fail('Claude 桌面归档结果未核验，工作台记录已保留。');
      // A verified native desktop archive changes visibility without moving
      // transcripts, so its exact idle interactive process may remain alive.
      // The exception never covers local-vault payloads, busy/unknown sessions
      // or deletion; stable still checks activity twice around file snapshots.
      const permittedIdle = plan.allowIdleSessionIds.filter(id => plan.desktopNativeSessionIds.includes(id));
      // Opening an already restored desktop session can briefly initialize its
      // process between either activity read. Retry only the full read-only
      // check for those exact verified desktop IDs; never replay the UI action.
      const settleDeadline = Date.now() + 5000;
      for (let attempt = 0; ; attempt++) {
        try { lease.assertHeld(); items = await stable(plan.sessions, plan.operation, permittedIdle); break; }
        catch (error) {
          if (error.code !== 'CLAUDE_SESSION_ACTIVE' || !permittedIdle.includes(error.sessionId)
            || attempt >= 24 || Date.now() >= settleDeadline) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.min(200, settleDeadline - Date.now())));
        }
      }
    }
    if (plan.operation === 'delete' && beforeDelete) {
      // Persist exact ownership snapshots first, so a partial desktop deletion
      // can be resumed safely even if it removed the transcript before failing.
      for (const item of items) if (!item.absent) {
        lease.assertHeld();
        const manifest = structuredClone(item.manifest); manifest.state = 'deleting';
        await writeManifest(item.session, manifest);
      }
      desktop = await beforeDelete();
      // No idle exception after Desktop's deletion; SDK file mutations require
      // that its native session has actually stopped and still matches snapshots.
      items = await stable(plan.sessions, plan.operation);
    }
    const affected = [], alreadyAbsent = [];
    for (const item of items) {
      const { session } = item;
      if (item.absent) { alreadyAbsent.push(session.sessionId); continue; }
      if (plan.desktopNativeSessionIds.includes(session.sessionId)) {
        lease.assertHeld(); await verifyInventory(session, true);
        affected.push(session.sessionId);
        await onProgress({ agent: 'claude', sessionId: session.sessionId, operation: plan.operation, archiveKind: 'claude-desktop-native' });
        continue;
      }
      await assertInactive([session]);
      // Recheck after earlier sessions changed, before this session's first write.
      const current = await inspect(session, plan.operation);
      if (!equal(current, item)) fail('Claude 会话在同步前发生变化，请重新预检。');
      const m = structuredClone(item.manifest);
      lease.assertHeld();
      if (plan.operation === 'archive') {
        m.state = 'archiving'; await writeManifest(session, m);
        for (const part of m.components) {
          const target = destination(session, part);
          if (await exists(target)) continue;
          if (!sameContent(await snapshot(part.source), part.snapshot)) fail('Claude 会话在暂存前发生变化。');
          await assertInactive([session]); lease.assertHeld(); await moveExclusive(part.source, target, part.kind);
        }
        for (const part of m.components) if (await exists(part.source) || !sameContent(await snapshot(destination(session, part)), part.snapshot)) fail('Claude 暂存完整性校验失败。');
        lease.assertHeld(); m.state = 'archived'; await writeManifest(session, m); await verifyInventory(session, false);
      } else if (plan.operation === 'unarchive') {
        await restorePayload(session, m, lease);
      } else {
        m.state = 'deleting'; await writeManifest(session, m);
        const transcript = m.components.find(p => p.name === 'transcript');
        if (await exists(transcript.source)) {
          await verifySdk(session, true); await assertInactive([session]); lease.assertHeld();
          await (await api()).deleteSession(session.sessionId, { dir: session.cwd });
        }
        // Recover a partial official SDK delete (transcript removed but its
        // owned sidecar remained), and purge only the verified staged payload.
        for (const part of m.components) for (const target of [part.source, destination(session, part)]) {
          if (!await exists(target)) continue;
          if (!remainingContent(await snapshot(target), part.snapshot)) fail('Claude 删除重试时发现记录变化，已停止清理。');
          await safePath(target); await assertInactive([session]); lease.assertHeld();
          await rm(target, { recursive: part.kind === 'directory', force: false });
        }
        await verifyInventory(session, false);
        lease.assertHeld(); m.state = 'deleted'; await writeManifest(session, m);
      }
      affected.push(session.sessionId);
      lease.assertHeld(); await onProgress({ agent: 'claude', sessionId: session.sessionId, operation: plan.operation, archiveKind: 'workbench-local-staging' });
    }
    const archiveMode = !plan.desktopNativeSessionIds.length ? 'local-vault' : plan.desktopNativeSessionIds.length === plan.sessions.length ? 'desktop-native' : 'mixed';
    return { operation: plan.operation, sessions: plan.sessions.map(s => s.sessionId), affected, alreadyAbsent,
      archiveKind: archiveMode === 'local-vault' ? 'workbench-local-staging' : archiveMode === 'desktop-native' ? 'claude-desktop-native' : 'mixed',
      archiveMode, ...(desktop ? { desktop } : {}) };
    } finally { await lease.release(); }
  }
  return { prepare, apply };
}
