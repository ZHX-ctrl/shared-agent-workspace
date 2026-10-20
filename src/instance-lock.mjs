import net from 'node:net';
import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';

function endpointFor(canonicalPath) {
  const identity = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
  const digest = createHash('sha256').update(identity).digest('hex');
  if (process.platform === 'win32') return `\\\\.\\pipe\\shared-agent-workspace-${digest}`;
  if (process.platform === 'linux') {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 20 || (major === 20 && minor < 8)) {
      throw new Error('Linux 实例锁需要 Node.js 20.8 或更新版本支持抽象 Unix socket。');
    }
    return `\0shared-agent-workspace-${digest}`;
  }
  throw new Error('当前平台尚未实现可靠的跨进程实例锁；为避免覆盖项目记录，服务不会启动。当前支持 Windows 和 Linux。');
}

/**
 * Kernel-owned named pipes (Windows) / abstract sockets (Linux) disappear when
 * the owning process exits, including crashes. No pid file or socket file is
 * removed, so an old process cannot unlink a new process's live lock. These
 * endpoints carry no data: connections are immediately destroyed.
 */
export async function acquireInstanceLock(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('实例锁需要本地数据目录。');
  const resolved = path.resolve(dataDir);
  await mkdir(resolved, { recursive: true });
  const canonical = await realpath(resolved);
  const endpoint = endpointFor(canonical);
  const server = net.createServer({ pauseOnConnect: true }, socket => socket.destroy());
  await new Promise((resolve, reject) => {
    const onError = error => {
      server.removeListener('listening', onListening);
      const wrapped = new Error(error.code === 'EADDRINUSE'
        ? '该数据目录已有一个项目窗口服务正在运行，请使用已有窗口。'
        : `无法取得项目窗口的实例锁（${error.code ?? '未知错误'}）。`);
      wrapped.code = error.code === 'EADDRINUSE' ? 'WORKSPACE_ALREADY_RUNNING' : 'WORKSPACE_LOCK_FAILED';
      wrapped.cause = error;
      reject(wrapped);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ path: endpoint, exclusive: true, readableAll: false, writableAll: false });
  });
  // The HTTP service owns process lifetime. A lock alone must not leave a failed
  // startup alive indefinitely. The OS releases this handle on process exit.
  server.unref();
  server.on('error', error => {
    process.emitWarning(`项目窗口实例锁监听错误：${error.code ?? '未知错误'}`, { code: 'WORKSPACE_LOCK_LISTENER_ERROR' });
  });
  let releasePromise;
  return function release() {
    releasePromise ??= new Promise((resolve, reject) => {
      server.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    });
    return releasePromise;
  };
}
