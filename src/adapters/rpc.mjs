import { EventEmitter } from 'node:events';
import { makeLineReader, safeError, spawnCli, terminateCli } from './process.mjs';

export class JsonRpcClient extends EventEmitter {
  constructor(cli, args, { cwd, env, workerLifecycle, spawnProcess = spawnCli, timeout = 20000 } = {}) {
    super(); this.pending = new Map(); this.nextId = 1; this.timeout = timeout; this.closed = false;
    this.child = spawnProcess(cli, args, { cwd, env, workerLifecycle });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', () => {}); // Never forward raw CLI diagnostics/credentials to the UI.
    makeLineReader(this.child.stdout, line => {
      let message;
      try { message = JSON.parse(line); } catch { this.fail(new Error('Invalid JSON from Codex app-server')); return; }
      if (message.method && message.id !== undefined) { this.emit('request', message); return; }
      if (message.method) { this.emit('notification', message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(safeError(message.error)); error.code = message.error.code; error.data = message.error.data;
        pending.reject(error);
      } else pending.resolve(message.result);
    }, error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('close', (code, signal) => this.fail(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})`)));
    this.child.stdin.on('error', error => this.fail(error));
  }
  write(message) {
    if (this.closed) throw new Error('Codex app-server connection is closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}, { timeout = this.timeout } = {}) {
    if (this.closed) return Promise.reject(new Error('Codex app-server connection is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  notify(method, params = {}) { this.write({ method, params }); }
  respond(id, result) { if (!this.closed) this.write({ id, result }); }
  reject(id, message = 'Unsupported client request') { if (!this.closed) this.write({ id, error: { code: -32601, message } }); }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear(); this.emit('closed', error);
    this.termination ||= terminateCli(this.child);
  }
  close() { this.fail(new Error('Codex app-server connection closed')); return this.termination || Promise.resolve(); }
}
