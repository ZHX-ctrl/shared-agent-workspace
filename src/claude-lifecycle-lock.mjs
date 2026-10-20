import path from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = message => { throw new Error(message); };
const present = async file => {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

async function safeDirectory(directory) {
  const root = path.parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await present(current);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) fail('Claude 同步锁目录含链接或不是普通目录，已停止操作。');
  }
}

// These handles coordinate cooperating workbench processes only. They cannot
// lock an official Claude CLI that independently resumes the same session.
// OS handles release on helper termination; never unlink a supposedly stale
// lock file or infer ownership from a reused PID.
const lockScript = `$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$handles=New-Object 'System.Collections.Generic.List[System.IDisposable]'
$failed=$false
try {
  $request=[Console]::In.ReadLine() | ConvertFrom-Json
  foreach ($file in $request.files) {
    $handle=[IO.File]::Open($file,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $handles.Add($handle)
  }
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  [Console]::In.ReadToEnd() | Out-Null
} catch {
  $failed=$true
  [Console]::Out.WriteLine('UNAVAILABLE')
  [Console]::Out.Flush()
} finally {
  for ($index=$handles.Count-1; $index -ge 0; $index--) { $handles[$index].Dispose() }
}
if ($failed) { exit 1 }
`;

/** Acquire all exact session locks, or release every handle already acquired. */
export async function acquireClaudeLifecycleLocks({ lockRoot, sessionIds, timeoutMs = 10000,
  spawnProcess = spawn, platform = process.platform } = {}) {
  if (platform !== 'win32') fail('Claude 同步锁目前只验证了 Windows，未执行操作。');
  if (typeof lockRoot !== 'string' || !path.isAbsolute(lockRoot) || !Array.isArray(sessionIds)
      || sessionIds.some(id => typeof id !== 'string' || !UUID.test(id))) fail('Claude 同步锁关联无效。');
  const ids = [...new Set(sessionIds.map(id => id.toLowerCase()))].sort();
  if (!ids.length) return { assertHeld() {}, async release() {} };
  const directory = path.resolve(lockRoot);
  await safeDirectory(directory);
  await mkdir(directory, { recursive: true });
  await safeDirectory(directory);
  const files = ids.map(id => path.join(directory, `${id}.lock`));
  for (const file of files) {
    const info = await present(file);
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size !== 0)) {
      fail('Claude 同步锁位置已有非锁文件，未覆盖或删除。');
    }
  }
  const duration = Number.isFinite(timeoutMs) ? Math.max(100, Math.min(30000, timeoutMs)) : 10000;
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let child;
  try {
    child = spawnProcess(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(lockScript, 'utf16le').toString('base64')],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { fail('无法启动 Claude 同步锁，未执行操作。'); }
  let ready = false, released = false, alive = true, buffer = '', acquisitionError;
  let resolveReady, rejectReady, resolveClosed;
  const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const stopAcquiring = message => {
    acquisitionError ||= new Error(message);
    if (!ready) rejectReady(acquisitionError);
  };
  child.stderr.resume();
  child.stdin.on('error', () => stopAcquiring('Claude 同步锁连接已关闭，未继续操作。'));
  child.on('error', () => {
    // A spawn failure owns no handle. A later process error (for example a
    // failed kill) does not prove exit: require the actual close event.
    if (!Number.isInteger(child.pid)) { alive = false; resolveClosed(); }
    stopAcquiring('Claude 同步锁进程未启动，未执行操作。');
  });
  child.on('close', () => {
    alive = false; resolveClosed();
    stopAcquiring('Claude 同步锁已退出，未继续操作。');
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    if (buffer.length > 1024) { stopAcquiring('Claude 同步锁返回异常，未继续操作。'); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (line === 'READY' && !ready && !acquisitionError) { ready = true; resolveReady(); }
      else if (line) stopAcquiring('另一工作台正在同步此聊天，或同步锁暂不可用，请稍后重试。');
    }
  });
  const timer = setTimeout(() => stopAcquiring('取得 Claude 同步锁超时，未执行操作。'), duration);
  const waitForClose = async () => {
    if (!alive) return;
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Claude 同步锁尚未释放。')), duration); })]);
    } finally { clearTimeout(timer); }
  };
  const closeHelper = async () => {
    try { child.stdin.end(); } catch { /* An already-closed pipe owns no lock. */ }
    try { await waitForClose(); }
    catch {
      try { child.kill(); } catch { /* Report failure if its close cannot be confirmed. */ }
      await waitForClose();
    }
  };
  try {
    child.stdin.write(`${JSON.stringify({ files })}\n`);
    await readyPromise;
  } catch (error) {
    await closeHelper();
    throw error;
  } finally { clearTimeout(timer); }
  const lease = {
    assertHeld() {
      if (!ready || released || !alive || child.exitCode != null || child.signalCode != null || acquisitionError) {
        fail('Claude 同步锁已失效，已停止后续文件操作，请重试同步。');
      }
    },
    async release() {
      if (released) return;
      released = true;
      await closeHelper();
    },
  };
  try { lease.assertHeld(); }
  catch (error) { await lease.release(); throw error; }
  return lease;
}
