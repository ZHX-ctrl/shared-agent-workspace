import { JsonRpcClient } from './rpc.mjs';
import { resolveCli, captureCli, subscriptionEnv, providerBase, safeError } from './process.mjs';

// Process-local overrides. These do not change ~/.codex/config.toml. A custom
// API provider in the user's configuration cannot redirect this adapter's work.
export const CODEX_SERVER_ARGS = ['app-server', '--listen', 'stdio://',
  '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"'];

export function normalizeCodexQuota(response = {}) {
  const buckets = response.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length
    ? Object.entries(response.rateLimitsByLimitId)
    : response.rateLimits ? [[response.rateLimits.limitId || 'codex', response.rateLimits]] : [];
  return buckets.flatMap(([bucketId, snapshot]) => ['primary', 'secondary'].flatMap(windowId => {
    const window = snapshot?.[windowId];
    if (!window || typeof window !== 'object') return [];
    const minutes = window.windowDurationMins;
    const duration = Number.isFinite(minutes) && minutes > 0
      ? minutes % 1440 === 0 ? `${minutes / 1440}天` : minutes % 60 === 0 ? `${minutes / 60}小时` : `${minutes}分钟`
      : null;
    const label = duration ? `${duration}额度` : `额度窗口${windowId === 'primary' ? 1 : 2}`;
    return [{ id: `${bucketId}:${windowId}`, label: `${snapshot.limitName || bucketId} · ${label}`,
      usedPercent: Number.isFinite(window.usedPercent) ? Math.max(0, Math.min(100, window.usedPercent)) : null,
      resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
      windowMinutes: Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null }];
  }));
}

export function normalizeCodexUsage(tokenUsage = {}) {
  const last = tokenUsage.last || {};
  const result = {};
  if (Number.isFinite(last.inputTokens)) result.inputTokens = last.inputTokens;
  if (Number.isFinite(last.outputTokens)) result.outputTokens = last.outputTokens;
  if (Number.isFinite(tokenUsage.modelContextWindow)) result.contextWindow = tokenUsage.modelContextWindow;
  // The last model request/response is the context estimate; total is lifetime
  // accumulation and must never be shown as context-window occupancy.
  if (Number.isFinite(last.totalTokens)) result.contextTokens = last.totalTokens;
  result.contextEstimate = true;
  return result;
}

export function codexFailedStatus(error) {
  const code = JSON.stringify(error?.codexErrorInfo || error?.data || '').toLowerCase();
  return code.includes('usagelimitexceeded') || code.includes('usage_limit_exceeded')
    || /usage limit|quota (?:exhausted|exceeded)|rate limit.*reached/i.test(error?.message || '')
    ? 'quota_exhausted' : 'failed';
}

export function isMissingCodexResume(error, sessionId) {
  // Only the app-server's exact missing-rollout response is recoverable.
  // thread/read's "thread not loaded" is NOT proof that a session is missing.
  // Source: openai/codex request_processors/thread_processor.rs,
  // thread_store_resume_read_error (ThreadNotFound -> invalid_request).
  return typeof sessionId === 'string' && sessionId.length > 0 && error?.code === -32600
    && error.message === `no rollout found for thread id ${sessionId}`;
}

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const updateIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const itemKey = (turnId, itemId) => `${turnId}:${itemId}`;
const reviewCommand = command => nonempty(command) ? command
  : Array.isArray(command) && command.length && command.every(value => typeof value === 'string') ? JSON.stringify(command) : null;
const reviewableFileChange = file => nonempty(file.path) && typeof file.diff === 'string'
  && (file.diff.trim().length > 0 || file.kind === 'delete');

function approvalFiles(method, params, item) {
  if (method === 'item/permissions/requestApproval') {
    const fs = params.permissions?.fileSystem;
    if (!fs) return [];
    return [
      ...(fs.read || []).map(path => ({ path, kind: 'read', diff: null })),
      ...(fs.write || []).map(path => ({ path, kind: 'write', diff: null })),
      ...(fs.entries || []).map(entry => ({ path: entry.path?.type === 'path' ? entry.path.path : null, kind: entry.access, diff: null })),
    ];
  }
  if (method !== 'item/fileChange/requestApproval') return [];
  const changes = params.changes || (item?.type === 'fileChange' ? item.changes : null);
  if (!Array.isArray(changes)) return [];
  return changes.map(change => ({ path: change.path, kind: typeof change.kind === 'string' ? change.kind : change.kind?.type || 'unknown',
    diff: typeof change.diff === 'string' ? change.diff : null }));
}

async function approvalDetails(rpc, method, params, run) {
  const turnId = params.turnId || run.turnId;
  const key = turnId && params.itemId ? itemKey(turnId, params.itemId) : null;
  let item = key ? run.items?.get(key) : null;
  let command = reviewCommand(params.command) || (item?.type === 'commandExecution' ? reviewCommand(item.command) : null);
  let files = approvalFiles(method, params, item);
  const lacksDetails = method === 'item/commandExecution/requestApproval' ? !command
    : method === 'item/fileChange/requestApproval' ? !files.length || !files.every(reviewableFileChange) : false;
  if (lacksDetails && key) {
    try {
      // Only read this active thread and only accept the matching turn/item.
      // A similar item elsewhere in history is never evidence for this action.
      const result = await rpc.request('thread/read', { threadId: run.sessionId, includeTurns: true });
      if (result.thread?.id === run.sessionId) {
        const turn = result.thread.turns?.find(candidate => candidate.id === turnId);
        const found = turn?.items?.find(candidate => candidate.id === params.itemId);
        if (found) { item = found; run.items?.set(key, found); }
      }
    } catch { /* Missing evidence is displayed as unreviewable, never guessed. */ }
    command = reviewCommand(params.command) || (item?.type === 'commandExecution' ? reviewCommand(item.command) : null);
    files = approvalFiles(method, params, item);
  }
  const requiresSandboxEscape = params.sandboxPermissions === 'require_escalated' || params.sandbox_permissions === 'require_escalated'
    || /(?:without|outside(?: of)?)\s+(?:the\s+)?sandbox|unsandboxed|沙箱外|脱离沙箱/i.test(params.reason || '');
  const canApprove = method === 'item/commandExecution/requestApproval' ? Boolean(command)
    : method === 'item/fileChange/requestApproval' ? files.length > 0 && files.every(reviewableFileChange)
    : files.length > 0 && files.every(file => nonempty(file.path));
  const targets = files.filter(file => nonempty(file.path)).map(file => file.path);
  const action = method === 'item/commandExecution/requestApproval' ? '执行命令'
    : method === 'item/fileChange/requestApproval' ? '修改文件' : '访问文件';
  let title = requiresSandboxEscape ? `Codex 请求仅这次在沙箱外${action}` : `Codex 请求${action}`;
  let summary = command ? `将执行下方命令。` : targets.length ? `将${action}：${targets.join('、')}。` : '尚未取得具体命令或文件目标。';
  if (requiresSandboxEscape) summary += '批准仅授权这一次沙箱外重试，不会永久关闭沙箱或批准后续操作。';
  if (!canApprove) { title = `无法审核：Codex 请求${action}`; summary += '操作明细不足，当前请求不能批准。'; }
  let reason = nonempty(params.reason) ? `Codex 提供的原始原因：${params.reason}` : 'Codex 未提供额外原因。';
  if (/^command failed; retry without sandbox\?$/i.test((params.reason || '').trim())) {
    reason = '之前的操作执行失败，Codex 请求仅这一次在沙箱外重试。';
  }
  const cwd = nonempty(params.cwd) ? params.cwd : nonempty(item?.cwd) ? item.cwd : run.cwd;
  return { kind: method, title, canApprove, details: { summary, reason, requiresSandboxEscape,
    ...(cwd ? { cwd } : {}), ...(command ? { command } : {}), files, raw: params }, request: params };
}

export class CodexAdapter {
  constructor({ onProviderUpdate = () => {}, resolve = resolveCli, capture = captureCli, Rpc = JsonRpcClient } = {}) {
    this.onProviderUpdate = onProviderUpdate; this.resolve = resolve; this.capture = capture; this.Rpc = Rpc;
    this.connections = new Set(); this.activeRuns = new Map(); this.snapshot = providerBase('codex', 'Codex');
    this.quotaRefreshPromise = null; this.quotaRevision = 0; this.quotaAccountKey = null; this.closed = false;
  }
  publish(patch) {
    this.snapshot = { ...this.snapshot, ...patch, updatedAt: new Date().toISOString() };
    this.onProviderUpdate(this.snapshot); return this.snapshot;
  }
  observeAccount(auth) {
    const authenticated = auth.account?.type === 'chatgpt';
    // Kept only in memory, never emitted or written to project metadata.
    const key = authenticated ? JSON.stringify(auth.account) : null;
    const changed = key !== this.quotaAccountKey;
    this.quotaAccountKey = key;
    if (changed || !authenticated) this.quotaRevision++;
    this.publish({ installed: true, authenticated, authMode: auth.account?.type || 'none',
      connectionCheckedAt: new Date().toISOString(),
      ...((changed || !authenticated) ? { quota: [], quotaUpdatedAt: null, quotaCheckedAt: null,
        quotaError: authenticated ? null : '未确认 ChatGPT 订阅登录，额度不可读取。' } : {}) });
  }
  async connect(cwd, workerLifecycle) {
    if (this.closed) throw new Error('Codex 连接已关闭。');
    const cli = this.resolve('codex');
    if (!cli) throw new Error('未找到 Codex CLI。请先安装官方 Codex CLI 并使用 codex login 登录订阅。');
    const rpc = new this.Rpc(cli, CODEX_SERVER_ARGS, { cwd, env: subscriptionEnv('codex'), workerLifecycle });
    this.connections.add(rpc); rpc.on('closed', () => this.connections.delete(rpc));
    // No UI owner exists while connecting/inspecting: refuse any server request.
    const deny = message => this.respondToRequest(rpc, message, null);
    rpc.on('request', deny);
    try {
      // CLI project membership is gated by this negotiated protocol capability.
      // It does not change subscription billing, sandboxing, or approval policy.
      await rpc.request('initialize', { clientInfo: { name: 'shared_agent_workspace', title: 'Shared Agent Workspace', version: '0.1.0' },
        capabilities: { experimentalApi: true } });
      rpc.notify('initialized');
      const auth = await rpc.request('account/read', { refreshToken: false });
      this.observeAccount(auth);
      return { rpc, cli, auth, quotaAccountKey: this.quotaAccountKey, detachDeny: () => rpc.off('request', deny) };
    } catch (error) { await rpc.close(); throw error; }
  }
  async inspect() {
    const cli = this.resolve('codex');
    if (!cli) return this.publish({ ...providerBase('codex', 'Codex'), connectionCheckedAt: new Date().toISOString(),
      quotaUpdatedAt: null, quotaCheckedAt: null, quotaError: null, error: '未安装 Codex CLI。' });
    let connection;
    let state = { ...providerBase('codex', 'Codex'), installed: true, error: null };
    try {
      const version = await this.capture(cli, ['--version'], { env: subscriptionEnv('codex') });
      state.version = version.code === 0 ? version.stdout.trim().split('\n')[0] : null;
      connection = await this.connect();
      const { rpc, auth } = connection;
      state.authMode = auth.account?.type || 'none'; state.authenticated = state.authMode === 'chatgpt';
      if (!state.authenticated) {
        state.error = state.authMode === 'none' ? '请运行 codex login，使用 ChatGPT 订阅登录。' : '当前不是 ChatGPT 订阅登录；已阻止使用额外付费 API。';
      } else {
        let cursor; let pages = 0;
        do {
          const models = await rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
          state.models.push(...(models.data || []).map(model => ({ id: model.model || model.id, name: model.displayName || model.model || model.id,
            efforts: (model.supportedReasoningEfforts || []).map(option => option.reasoningEffort),
            defaultEffort: model.defaultReasoningEffort, isDefault: Boolean(model.isDefault) })));
          cursor = models.nextCursor;
        } while (cursor && ++pages < 10);
        await this.refreshQuota({ rpc });
      }
    } catch (error) { state.error = safeError(error); }
    finally { await connection?.rpc.close(); }
    const previous = this.snapshot;
    return this.publish({ ...state, connectionCheckedAt: new Date().toISOString(),
      quota: previous.quota, quotaUpdatedAt: previous.quotaUpdatedAt ?? null,
      quotaCheckedAt: state.error ? new Date().toISOString() : previous.quotaCheckedAt ?? null,
      quotaError: state.error || previous.quotaError || null });
  }
  async refreshQuota({ rpc: inspectionRpc } = {}) {
    // All callers share this read; neither idle refresh nor inspection starts a
    // thread/turn, enumerates models, or selects an alternate billing method.
    if (this.quotaRefreshPromise) return this.quotaRefreshPromise;
    if (this.closed) return this.snapshot;
    const operation = (async () => {
      let connection;
      let revision = null;
      try {
        let rpc = inspectionRpc;
        if (!rpc) {
          rpc = [...this.activeRuns.values()].find(run => run.isActive() && !run.rpc.closed)?.rpc;
          if (rpc) {
            const auth = await rpc.request('account/read', { refreshToken: false });
            this.observeAccount(auth);
            if (auth.account?.type !== 'chatgpt') throw new Error('未确认 ChatGPT 订阅登录，未读取额度。');
          }
        }
        if (!rpc) {
          connection = await this.connect();
          if (connection.auth.account?.type !== 'chatgpt') throw new Error('未确认 ChatGPT 订阅登录，未读取额度。');
          rpc = connection.rpc;
        }
        revision = this.quotaRevision;
        const quota = normalizeCodexQuota(await rpc.request('account/rateLimits/read'));
        if (revision !== null && revision !== this.quotaRevision) return this.snapshot;
        if (!quota.length) throw new Error('官方工具尚未返回可读取的额度窗口。');
        const observedAt = new Date().toISOString();
        this.quotaRevision++;
        return this.publish({ quota: quota.map(window => ({ ...window, observedAt })),
          quotaUpdatedAt: observedAt, quotaCheckedAt: observedAt, quotaError: null });
      } catch (error) {
        if (revision !== null && revision !== this.quotaRevision) return this.snapshot;
        // Preserve the last actual observation. A failed attempt is not a new
        // quota reading and must not make old values look freshly observed.
        return this.publish({ quotaCheckedAt: new Date().toISOString(), quotaError: safeError(error) });
      } finally { await connection?.rpc.close(); }
    })();
    this.quotaRefreshPromise = operation;
    try { return await operation; }
    finally { if (this.quotaRefreshPromise === operation) this.quotaRefreshPromise = null; }
  }
  async respondToRequest(rpc, message, run) {
    const { id, method, params = {} } = message;
    const sameRun = run && params.threadId === run.sessionId && (!run.turnId || !params.turnId || params.turnId === run.turnId);
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'];
    let decision = 'deny', canApprove = false;
    if (supported.includes(method) && sameRun && !run.signal?.aborted && run.onApproval) {
      try {
        const approval = await approvalDetails(rpc, method, params, run);
        canApprove = approval.canApprove;
        decision = await run.onApproval(approval);
      } catch { decision = 'deny'; }
    }
    if (rpc.closed) return;
    const allow = canApprove && decision === 'allow' && !run?.signal?.aborted;
    if (method === 'item/permissions/requestApproval') {
      rpc.respond(id, { permissions: allow ? params.permissions : {}, scope: 'turn' });
    } else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      rpc.respond(id, { decision: allow ? 'accept' : 'decline' });
    } else if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      rpc.respond(id, { decision: 'denied' });
    } else if (method === 'mcpServer/elicitation/request') {
      run?.onEvent?.({ type: 'tool', message: '此操作需要额外输入；当前窗口没有表单输入，已拒绝。' });
      rpc.respond(id, { action: 'decline' });
    } else if (method === 'item/tool/requestUserInput') {
      run?.onEvent?.({ type: 'tool', message: '助手请求补充信息。请停止后在对话中提供答案。', request: params });
      rpc.respond(id, { answers: {} });
    } else {
      rpc.reject(id, 'This client does not implement this request; no action was approved.');
    }
  }
  async sendUpdate(runId, update) {
    if (!update || typeof update.id !== 'string' || !updateIdPattern.test(update.id)
      || typeof update.sourceRunId !== 'string' || !updateIdPattern.test(update.sourceRunId)
      || !nonempty(update.text) || update.text.length > 8000) {
      return { status: 'deferred', reason: '协作通知格式无效，未发送。' };
    }
    const active = this.activeRuns.get(runId);
    if (!active || !active.isActive()) return { status: 'deferred', reason: '此任务没有可接收通知的活动轮次；保留到后续交接。' };
    // Keep both in-flight and settled acknowledgements. A timeout may already
    // have reached the model, so the same update ID must never be resent.
    if (active.updates.has(update.id)) return active.updates.get(update.id);
    const delivery = (async () => {
      try {
        // Only append input to this exact active turn. Never create/resume a
        // thread, start a turn, or override its model/permissions here.
        const result = await active.rpc.request('turn/steer', { threadId: active.sessionId,
          expectedTurnId: active.turnId, input: [{ type: 'text', text: update.text }] });
        if (result?.turnId !== active.turnId) return { status: 'unknown', reason: '原生服务未返回匹配的轮次确认；为避免重复通知，不自动重试。' };
        return { status: 'accepted', turnId: result.turnId };
      } catch (error) {
        return Number.isInteger(error?.code)
          ? { status: 'deferred', reason: `原生服务拒绝本轮协作通知：${safeError(error)}` }
          : { status: 'unknown', reason: `协作通知是否送达尚不明确，不自动重试：${safeError(error)}` };
      }
    })();
    active.updates.set(update.id, delivery);
    return delivery;
  }
  async run(options) {
    const { cwd, prompt, model, effort, signal, onEvent = () => {} } = options;
    let sessionId = options.sessionId || null, connection, abortHandler, cancelTimer, activeUpdateState;
    if (signal?.aborted) return { sessionId, status: 'cancelled' };
    try {
      connection = await this.connect(cwd, options.workerLifecycle);
      const { rpc, auth, detachDeny } = connection;
      if (signal?.aborted) return { sessionId, status: 'cancelled' };
      if (auth.account?.type !== 'chatgpt') throw new Error('仅允许 ChatGPT 订阅登录。请使用 codex login；此窗口不会改用 API 计费。');
      const threadParams = { cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', modelProvider: 'openai', ...(model ? { model } : {}),
        ...(nonempty(options.backgroundInstructions) ? { developerInstructions: options.backgroundInstructions } : {}) };
      // Assign a new chat at creation. A new thread may not have a rollout yet,
      // so immediately calling metadata/update on it can fail before turn/start.
      const startParams = { ...threadParams, ...(options.nativeProjectId ? { projectId: options.nativeProjectId } : {}) };
      let threadResult, recoveredFrom = null;
      if (sessionId) {
        try {
          threadResult = await rpc.request('thread/resume', { ...threadParams, threadId: sessionId, excludeTurns: true });
        } catch (error) {
          if (signal?.aborted) return { sessionId, status: 'cancelled' };
          if (!isMissingCodexResume(error, sessionId)) throw error;
          recoveredFrom = sessionId;
          // No turn/start has been sent. This is a single fresh attempt, never
          // a recursive retry, and the original prompt below remains intact.
          threadResult = await rpc.request('thread/start', startParams);
        }
      } else {
        threadResult = await rpc.request('thread/start', startParams);
      }
      sessionId = threadResult.thread.id;
      onEvent({ type: 'session', sessionId, ...(recoveredFrom ? { recoveredFrom, recoveryReason: 'native_rollout_missing' } : {}) });
      if (options.nativeProjectId) {
        if (threadResult.thread.projectId !== options.nativeProjectId) {
          await rpc.request('thread/metadata/update', { threadId: sessionId, projectId: options.nativeProjectId });
        }
        if (nonempty(options.chatTitle)) await rpc.request('thread/name/set', { threadId: sessionId, name: options.chatTitle });
      }
      if (recoveredFrom) onEvent({ type: 'tool', method: 'workspace/sessionRecovered', previousSessionId: recoveredFrom,
        sessionId, message: 'Codex 未找到原生会话记录；已建立新会话，并将使用完整的本次项目交接上下文继续。原有工作台历史保留。' });
      if (signal?.aborted) return { sessionId, status: 'cancelled' };
      const run = { ...options, onEvent, sessionId, turnId: null, items: new Map() };
      detachDeny(); rpc.on('request', message => { void this.respondToRequest(rpc, message, run); });
      let settled = false, started = false, lastError = null;
      const itemTexts = new Map();
      let resolveResult;
      const completion = new Promise(resolve => { resolveResult = resolve; });
      const finish = result => {
        if (settled) return; settled = true;
        if (this.activeRuns.get(options.runId) === activeUpdateState) this.activeRuns.delete(options.runId);
        clearTimeout(cancelTimer); resolveResult({ sessionId, ...result });
      };
      rpc.on('closed', error => finish({ status: signal?.aborted ? 'cancelled' : 'failed', error: safeError(error) }));
      rpc.on('notification', ({ method, params = {} }) => {
        if (method === 'account/rateLimits/updated') {
          if (!this.snapshot.authenticated || connection.quotaAccountKey !== this.quotaAccountKey) return;
          const incoming = normalizeCodexQuota(params);
          if (!incoming.length) return;
          const observedAt = new Date().toISOString();
          this.quotaRevision++;
          const merged = new Map(this.snapshot.quota.map(q => [q.id, q])); incoming.forEach(q => merged.set(q.id, { ...q, observedAt }));
          const update = { quota: [...merged.values()], quotaUpdatedAt: observedAt, quotaCheckedAt: observedAt, quotaError: null };
          this.publish(update); onEvent({ type: 'quota', ...update }); return;
        }
        if (params.threadId !== sessionId) return;
        if (method === 'turn/started') { run.turnId = params.turn?.id || run.turnId; return; }
        if (run.turnId && params.turnId && params.turnId !== run.turnId) return;
        if ((method === 'item/started' || method === 'item/completed') && params.item?.id && (params.turnId || run.turnId)
          && !['reasoning', 'agentMessage'].includes(params.item.type)) {
          run.items.set(itemKey(params.turnId || run.turnId, params.item.id), params.item);
        }
        if (method === 'item/agentMessage/delta') {
          const id = params.itemId || 'message'; itemTexts.set(id, (itemTexts.get(id) || '') + (params.delta || ''));
          onEvent({ type: 'text_delta', text: params.delta || '' });
        } else if (method === 'item/completed' && params.item?.type === 'agentMessage') {
          itemTexts.set(params.item.id, params.item.text || '');
          onEvent({ type: 'text', text: [...itemTexts.values()].join('\n\n') });
        } else if (method === 'thread/tokenUsage/updated') {
          onEvent({ type: 'usage', usage: normalizeCodexUsage(params.tokenUsage) });
        } else if (method === 'error') {
          lastError = params.error; onEvent({ type: 'error', message: safeError(params.error) });
        } else if (method === 'turn/completed') {
          const turn = params.turn || {};
          if (run.turnId && turn.id !== run.turnId) return;
          const error = turn.error || lastError;
          const status = turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'cancelled' : codexFailedStatus(error);
          finish({ status, ...(error ? { error: safeError(error) } : {}) });
        } else if (((method === 'item/started' || method === 'item/completed') && !['reasoning', 'agentMessage'].includes(params.item?.type))
          || method === 'turn/diff/updated' || method === 'turn/plan/updated') {
          onEvent({ type: 'tool', method, item: params.item, message: params.item?.type || method, ...(params.plan ? { plan: params.plan } : {}) });
        }
      });
      abortHandler = () => {
        if (settled) return;
        if (run.turnId) void rpc.request('turn/interrupt', { threadId: sessionId, turnId: run.turnId }).catch(() => {});
        else if (!started) { rpc.close(); return; }
        // If a graceful interrupt stalls, terminate this exact process tree.
        // The finally block awaits process exit before returning cancellation.
        cancelTimer = setTimeout(() => rpc.close(), 10000);
      };
      signal?.addEventListener('abort', abortHandler, { once: true });
      if (signal?.aborted) { abortHandler(); return await completion; }
      started = true;
      const turnResult = await rpc.request('turn/start', { threadId: sessionId,
        input: [{ type: 'text', text: typeof options.userMessage === 'string' ? options.userMessage : prompt }, ...(options.inputs || [])],
        ...(model ? { collaborationMode: { mode: options.planMode ? 'plan' : 'default', settings: { model, reasoning_effort: effort || null, developer_instructions: null } } } : {}),
        approvalPolicy: 'on-request', approvalsReviewer: 'user',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false },
        ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      run.turnId = turnResult.turn?.id || run.turnId;
      if (nonempty(options.runId) && nonempty(run.turnId) && !settled && !signal?.aborted && !rpc.closed) {
        activeUpdateState = { rpc, sessionId, turnId: run.turnId, updates: new Map(),
          isActive: () => !settled && !signal?.aborted && !rpc.closed && run.turnId === activeUpdateState.turnId };
        this.activeRuns.set(options.runId, activeUpdateState);
        onEvent({ type: 'control_ready', capability: 'peer_updates' });
      }
      if (signal?.aborted) abortHandler();
      return await completion;
    } catch (error) {
      const message = safeError(error); onEvent({ type: 'error', message });
      return { sessionId, status: signal?.aborted ? 'cancelled' : codexFailedStatus(error), error: message };
    } finally {
      if (this.activeRuns.get(options.runId) === activeUpdateState) this.activeRuns.delete(options.runId);
      clearTimeout(cancelTimer); signal?.removeEventListener('abort', abortHandler); await connection?.rpc.close();
    }
  }
  async close() {
    this.closed = true;
    await Promise.all([...this.connections].map(rpc => rpc.close()));
    await this.quotaRefreshPromise;
    this.connections.clear();
  }
}
