import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);

// This queue only supplies context to an already-running local hook. A lease is
// acknowledged after the helper writes stdout, never as proof the model read it.
export function createProgressInbox({ runId, isActive = () => true, onProgressEvent = () => {} } = {}) {
  const pending = new Map(), seen = new Map(), acknowledged = new Set();
  let closed = false;
  const available = () => !closed && validId(runId) && isActive();
  return {
    enqueue(update) {
      if (!available()) return { status: 'deferred', reason: 'inactive_run' };
      if (!update || !validId(update.id) || !validId(update.sourceRunId) || update.sourceRunId === runId ||
          typeof update.text !== 'string' || !update.text.trim() || update.text.length > 8000) return { status: 'deferred', reason: 'invalid_update' };
      const signature = createHash('sha256').update(JSON.stringify([update.sourceRunId, update.text])).digest('hex');
      const prior = seen.get(update.id);
      if (prior && prior.signature !== signature) return { status: 'deferred', reason: 'update_id_conflict' };
      if (prior) {
        if (prior.provided) return { status: 'provided', reason: 'provided_to_hook' };
        return pending.get(update.id)?.lease ? { status: 'unknown', reason: 'hook_delivery_in_flight' } : { status: 'queued', reason: 'next_tool_boundary' };
      }
      if (pending.size >= 128 || seen.size >= 4096) return { status: 'deferred', reason: 'inbox_full' };
      pending.set(update.id, { update: { id: update.id, sourceRunId: update.sourceRunId, text: update.text } });
      seen.set(update.id, { signature, provided: false });
      return { status: 'queued', reason: 'next_tool_boundary' };
    },
    handle(payload) {
      if (!available() || payload?.runId !== runId || payload.hookEventName !== 'PostToolUse') return {};
      if (payload.action === 'take') {
        for (const entry of pending.values()) {
          // No expiry: a dead helper may have already written stdout. Only an
          // explicit release before a successful write permits redelivery.
          if (entry.lease) continue;
          entry.lease = { id: randomBytes(24).toString('hex') };
          onProgressEvent({ type: 'peer_update', updateId: entry.update.id, sourceRunId: entry.update.sourceRunId,
            status: 'unknown', reason: 'hook_delivery_in_flight' });
          return { leaseId: entry.lease.id, update: entry.update };
        }
        return {};
      }
      if (!validId(payload.leaseId)) return {};
      if (payload.action === 'ack' && acknowledged.has(payload.leaseId)) return { acknowledged: true };
      for (const [id, entry] of pending) {
        if (entry.lease?.id !== payload.leaseId) continue;
        if (payload.action === 'release') {
          entry.lease = null;
          onProgressEvent({ type: 'peer_update', updateId: id, sourceRunId: entry.update.sourceRunId,
            status: 'queued', reason: 'next_tool_boundary' });
          return {};
        }
        if (payload.action !== 'ack') return {};
        pending.delete(id); seen.get(id).provided = true; acknowledged.add(payload.leaseId);
        onProgressEvent({ type: 'peer_update', updateId: id, sourceRunId: entry.update.sourceRunId,
          status: 'provided', reason: 'provided_to_hook' });
        return { acknowledged: true };
      }
      return {};
    },
    close() { closed = true; pending.clear(); seen.clear(); acknowledged.clear(); },
  };
}

export function createProgressRequestHandler({ token, inbox, isClosed = () => false, onResponse = () => {} }) {
  return async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
    const supplied = Buffer.from(request.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
    if (request.method !== 'POST' || request.url !== '/progress' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(403).end('{}'); return;
    }
    onResponse(response);
    try {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 4096) { response.writeHead(413).end('{}'); return; } }
      const result = isClosed() ? {} : inbox.handle(JSON.parse(body));
      if (!response.destroyed && !response.writableEnded) response.end(JSON.stringify(result));
    } catch { if (!response.destroyed && !response.writableEnded) response.end('{}'); }
  };
}

// Only known tool schemas can become approvable. Preserve the original input
// separately: these fields are a review view, never a rewritten tool request.
export function normalizeClaudeApproval(payload, { cwd } = {}) {
  const input = payload?.input;
  const tool = payload?.tool_name;
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const validPath = value => text(value) && !/[\x00-\x1f\x7f]/.test(value);
  const absolute = value => validPath(value) && (path.isAbsolute(value) || path.win32.isAbsolute(value));
  const directory = absolute(cwd) ? cwd : '';
  const targetPath = value => {
    if (!validPath(value)) return '';
    if (absolute(value)) return value;
    if (!directory) return '';
    return (path.win32.isAbsolute(directory) ? path.win32 : path).resolve(directory, value);
  };
  const details = { cwd: directory, summary: '此工具的操作明细尚不完整，或工作台尚未支持审查这种工具。请拒绝后让助手换用可审查的操作。', raw: payload };
  let canApprove = false;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (['Bash', 'PowerShell'].includes(tool) && text(input.command) && directory) {
      details.command = input.command;
      details.summary = `请求${input.run_in_background === true ? '后台' : ''}执行下方完整命令。所示工作目录是本次会话的启动目录；命令仍可能自行切换目录。${input.timeout !== undefined ? `工具请求的超时参数：${input.timeout} 毫秒。` : ''}`;
      canApprove = true;
    } else if (tool === 'Write' && targetPath(input.file_path) && typeof input.content === 'string') {
      details.files = [{ path: targetPath(input.file_path), kind: 'write',
        diff: `【完整待写入内容开始】\n${input.content}\n【完整待写入内容结束】` }];
      details.summary = '将向该路径写入下方完整内容；文件已存在时会覆盖原内容。这里展示的是待写入内容，不是新旧文件差异。';
      canApprove = true;
    } else if (tool === 'Edit' && targetPath(input.file_path) && typeof input.old_string === 'string' && input.old_string.length > 0 &&
      typeof input.new_string === 'string' && (input.replace_all === undefined || typeof input.replace_all === 'boolean')) {
      details.files = [{ path: targetPath(input.file_path), kind: 'update',
        diff: `【原文本片段开始】\n${input.old_string}\n【原文本片段结束】\n\n【替换为以下文本】\n${input.new_string}\n【替换文本结束】` }];
      details.summary = `将${input.replace_all === true ? '替换所有匹配的' : '替换一个匹配的'}文本片段。下方仅是此次替换的旧文本和新文本，不是整个文件的完整差异。`;
      canApprove = true;
    } else if (tool === 'Read' && targetPath(input.file_path)) {
      details.files = [{ path: targetPath(input.file_path), kind: 'read' }];
      details.permissions = { tool, input };
      details.summary = '请求读取这个文件。下面列出完整读取参数；这是读取权限，不会修改文件。';
      canApprove = true;
    } else if (['Glob', 'Grep'].includes(tool) && text(input.pattern) && targetPath(input.path ?? directory)) {
      details.files = [{ path: targetPath(input.path ?? directory), kind: 'read' }];
      details.permissions = { tool, input, searchRoot: targetPath(input.path ?? directory) };
      details.summary = '请求在该范围内搜索文件或文本。下面列出完整搜索条件；这是读取权限，不会修改文件。';
      canApprove = true;
    } else if (tool === 'WebFetch' && text(input.url) && text(input.prompt)) {
      let url;
      try { url = new URL(input.url); } catch {}
      if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
        details.permissions = { tool, input };
        details.summary = '请求访问下面的网址，并按所列要求读取内容。';
        canApprove = true;
      }
    } else if (tool === 'WebSearch' && text(input.query)) {
      details.permissions = { tool, input };
      details.summary = '请求将下面的搜索词发送给网络搜索服务。请核对完整搜索内容和域名限制。';
      canApprove = true;
    }
  }
  return { kind: 'claude/tool', title: `Claude Code 请求使用 ${typeof tool === 'string' ? tool : '未知工具'}`,
    canApprove, details, request: payload };
}

export function createPermissionRequestHandler({ token, onApproval, signal, cwd, isClosed = () => false, onResponse = () => {} }) {
  return async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const supplied = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (request.method !== 'POST' || request.url !== '/permission' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(403).end('{}'); return;
    }
    onResponse(response);
    const deny = message => { if (!response.writableEnded) response.end(JSON.stringify({ behavior: 'deny', message })); };
    try {
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 1048576) { response.writeHead(413); deny('Permission request too large'); request.destroy(); return; } }
      const payload = JSON.parse(body);
      if (isClosed() || signal?.aborted || !onApproval) { deny('Approval host unavailable or run stopped'); return; }
      if (typeof payload.tool_name !== 'string' || !payload.input || typeof payload.input !== 'object' || Array.isArray(payload.input)) {
        deny('Invalid permission request'); return;
      }
      if (['AskUserQuestion', 'ExitPlanMode'].includes(payload.tool_name)) {
        deny('This tool needs structured user input not supported by this window. Ask the user in the conversation.'); return;
      }
      const approval = normalizeClaudeApproval(payload, { cwd });
      const decision = await onApproval(approval);
      if (!approval.canApprove) {
        deny('This operation has incomplete or unsupported review details. Ask for a complete, reviewable tool operation.');
      } else if (decision === 'allow' && !isClosed() && !signal?.aborted) {
        if (!response.writableEnded) response.end(JSON.stringify({ behavior: 'allow', updatedInput: payload.input }));
      } else deny('The user denied this action or the run was stopped.');
    } catch { deny('The permission request could not be approved.'); }
  };
}

export async function createPermissionBridge({ onApproval, signal, cwd, runId, isActive = () => true, onPeerUpdate } = {}) {
  const token = randomBytes(32).toString('hex');
  const progressToken = randomBytes(32).toString('hex');
  let closed = false, closing;
  const responses = new Set();
  const inbox = createProgressInbox({ runId, isActive: () => !signal?.aborted && isActive(), onProgressEvent: onPeerUpdate });
  const onResponse = response => { responses.add(response); response.on('close', () => responses.delete(response)); };
  const permission = createPermissionRequestHandler({ token, onApproval, signal, cwd, isClosed: () => closed, onResponse });
  const progress = createProgressRequestHandler({ token: progressToken, inbox, isClosed: () => closed, onResponse });
  const server = http.createServer((request, response) => request.url === '/progress' ? progress(request, response) : permission(request, response));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const close = async () => {
    if (closed) return closing; closed = true; inbox.close();
    for (const response of responses) if (!response.writableEnded) response.end(JSON.stringify({ behavior: 'deny', message: 'Run closed' }));
    closing = new Promise(resolve => server.close(resolve));
    await closing;
  };
  const base = `http://127.0.0.1:${server.address().port}`;
  return { url: `${base}/permission`, token, progressUrl: `${base}/progress`, progressToken, enqueueUpdate: update => inbox.enqueue(update), close };
}
