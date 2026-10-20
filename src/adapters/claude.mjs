import { fileURLToPath } from 'node:url';
import { resolveCli, captureCli, spawnCli, subscriptionEnv, providerBase, safeError, makeLineReader, terminateCli } from './process.mjs';
import { createPermissionBridge } from './permission-bridge.mjs';
import { readClaudeCatalog } from './claude-catalog.mjs';
import { readClaudeQuota } from './claude-quota.mjs';
import { createClaudeUsageTracker } from './claude-usage.mjs';
export { normalizeClaudeUsage } from './claude-usage.mjs';

// Session-only settings: preserve CLAUDE.md, hooks, skills, and normal permission
// checks, while preventing API credentials from being an automatic fallback.
export const CLAUDE_SUBSCRIPTION_SETTINGS = {
  forceLoginMethod: 'claudeai', apiKeyHelper: '',
  env: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '' },
};
const settingsArgs = ['--settings', JSON.stringify(CLAUDE_SUBSCRIPTION_SETTINGS)];

export function claudeRunSettings() {
  // Settings list keys merge across sources, and matching hooks run together:
  // https://code.claude.com/docs/en/settings#lists-merge-instead-of-overriding
  // https://code.claude.com/docs/en/hooks#hook-handler-fields
  // Exec-form args keep Windows/Unicode paths out of a shell. This adds no
  // permission decision and does not replace or disable the user's hooks.
  return { ...CLAUDE_SUBSCRIPTION_SETTINGS, hooks: { PostToolUse: [{ hooks: [{
    type: 'command', command: process.execPath,
    args: [fileURLToPath(new URL('./progress-helper.mjs', import.meta.url))], timeout: 5,
  }] }] } };
}

export function normalizeClaudeQuota(info = {}, observedAt = new Date().toISOString()) {
  // The official SDK defines utilization as a fraction from 0 to 1. Do not
  // infer it from a warning/rejection, tokens, or undocumented unifiedWindows.
  // https://code.claude.com/docs/en/agent-sdk/python#ratelimitinfo
  const status = ['allowed', 'allowed_warning', 'rejected'].includes(info.status) ? info.status : null;
  const resetsAt = Number.isSafeInteger(info.resetsAt) && info.resetsAt > 0 ? info.resetsAt : null;
  const usedPercent = Number.isFinite(info.utilization) && info.utilization >= 0 && info.utilization <= 1
    ? Math.round(info.utilization * 10000) / 100 : null;
  if (!status && resetsAt === null && usedPercent === null) return [];
  const limitType = typeof info.rateLimitType === 'string' && /^[a-z0-9_-]{1,80}$/i.test(info.rateLimitType) ? info.rateLimitType : 'current';
  const labels = { five_hour: '5小时额度', seven_day: '7天额度', seven_day_opus: 'Opus 7天额度', seven_day_sonnet: 'Sonnet 7天额度' };
  return [{ id: `claude:${limitType}`, label: limitType === 'current' ? 'Claude 使用限制' : `Claude · ${labels[limitType] || limitType}`,
    usedPercent, resetsAt, status, observedAt }];
}

export class ClaudeAdapter {
  constructor({ onProviderUpdate = () => {}, resolve = resolveCli, capture = captureCli, spawnProcess = spawnCli, permissionBridge = createPermissionBridge, catalog = readClaudeCatalog, quota = readClaudeQuota } = {}) {
    this.onProviderUpdate = onProviderUpdate; this.resolve = resolve; this.capture = capture; this.spawnProcess = spawnProcess; this.permissionBridge = permissionBridge;
    this.snapshot = providerBase('claude', 'Claude Code'); this.children = new Set(); this.active = new Map(); this.quotaAccountKey = null;
    this.catalog = catalog;
    this.readQuota = quota; this.quotaRefreshPromise = null; this.quotaRevision = 0; this.closed = false;
  }
  async sendUpdate(runId, update) {
    const active = this.active.get(runId);
    if (!active || active.signal?.aborted || active.child.exitCode !== null || active.child.signalCode !== null) return { status: 'deferred', reason: 'inactive_run' };
    return active.bridge.enqueueUpdate?.(update) || { status: 'deferred', reason: 'progress_hook_unavailable' };
  }
  publish(patch) { this.snapshot = { ...this.snapshot, ...patch, updatedAt: new Date().toISOString() }; this.onProviderUpdate(this.snapshot); return this.snapshot; }
  async auth(cli, cwd) {
    const result = await this.capture(cli, [...settingsArgs, 'auth', 'status'], { env: subscriptionEnv('claude'), cwd });
    let auth;
    try { auth = JSON.parse(result.stdout); } catch { throw new Error('Claude Code 未返回可验证的 JSON 登录状态。请更新官方 CLI 并重新登录。'); }
    const authenticated = result.code === 0 && auth.loggedIn === true && auth.authMethod === 'claude.ai';
    const key = authenticated ? JSON.stringify(auth) : null;
    const changed = key !== this.quotaAccountKey;
    this.quotaAccountKey = key;
    if (changed || !authenticated) this.quotaRevision++;
    this.publish({ installed: true, authenticated, authMode: auth.authMethod || 'unknown', connectionCheckedAt: new Date().toISOString(),
      ...((changed || !authenticated) ? { quota: [], quotaUpdatedAt: null, quotaCheckedAt: null,
        quotaError: authenticated ? null : '未确认 Claude 订阅登录，额度不可读取。' } : {}) });
    return { loggedIn: result.code === 0 && auth.loggedIn === true, method: auth.authMethod || 'unknown' };
  }
  async inspect() {
    const cli = this.resolve('claude');
    if (!cli) return this.publish({ ...providerBase('claude', 'Claude Code'), connectionCheckedAt: new Date().toISOString(),
      quotaUpdatedAt: null, quotaCheckedAt: null, quotaError: null, error: '未安装 Claude Code。连接后才能读取真实登录和使用状态。' });
    const state = { ...providerBase('claude', 'Claude Code'), installed: true };
    try {
      const version = await this.capture(cli, ['--version'], { env: subscriptionEnv('claude') });
      state.version = version.code === 0 ? version.stdout.trim().split('\n')[0] : null;
      const auth = await this.auth(cli);
      state.authMode = auth.method; state.authenticated = auth.loggedIn && auth.method === 'claude.ai';
      if (!state.authenticated) state.error = auth.loggedIn ? '当前不是 Claude 订阅登录；已阻止额外 API 计费。' : '请使用 claude auth login 登录 Claude 订阅。';
      else {
        try {
          state.models = await this.catalog(cli, { settings: CLAUDE_SUBSCRIPTION_SETTINGS, env: subscriptionEnv('claude') });
          state.modelSource = 'official_cli_initialize';
        } catch (error) {
          state.error = `Claude 订阅已登录，模型列表暂未读取成功；仍可使用官方默认模型。${safeError(error)}`;
        }
        await this.refreshQuota();
      }
    } catch (error) { state.error = safeError(error); }
    // Only a successful official get_usage read refreshes quota timestamps.
    // Authentication/catalog checks must not erase an earlier observation.
    return this.publish({ ...state, connectionCheckedAt: new Date().toISOString(), quota: this.snapshot.quota,
      quotaUpdatedAt: this.snapshot.quotaUpdatedAt ?? null, quotaCheckedAt: this.snapshot.quotaCheckedAt ?? null,
      quotaError: this.snapshot.quotaError ?? null });
  }
  async refreshQuota() {
    if (this.quotaRefreshPromise) return this.quotaRefreshPromise;
    if (this.closed) return this.snapshot;
    const operation = (async () => {
      let revision = null;
      try {
        const cli = this.resolve('claude');
        if (!cli) throw new Error('未找到 Claude Code，无法读取订阅额度。');
        const auth = await this.auth(cli);
        if (!auth.loggedIn || auth.method !== 'claude.ai') throw new Error('未确认 Claude 订阅登录，未读取额度。');
        revision = this.quotaRevision;
        const quota = await this.readQuota(cli, {settings:CLAUDE_SUBSCRIPTION_SETTINGS,env:subscriptionEnv('claude')});
        if (this.closed || revision !== this.quotaRevision) return this.snapshot;
        if (!Array.isArray(quota) || !quota.length) throw new Error('Claude 官方工具未返回额度窗口，保留上次读数。');
        const observedAt = new Date().toISOString();
        this.quotaRevision++;
        return this.publish({quota:quota.map(window=>({...window,observedAt})),quotaUpdatedAt:observedAt,
          quotaCheckedAt:observedAt,quotaError:null,quotaSource:'official_cli_get_usage'});
      } catch(error) {
        if (this.closed || (revision !== null && revision !== this.quotaRevision)) return this.snapshot;
        return this.publish({quotaCheckedAt:new Date().toISOString(),quotaError:safeError(error)});
      }
    })();
    this.quotaRefreshPromise = operation;
    try { return await operation; }
    finally { if (this.quotaRefreshPromise === operation) this.quotaRefreshPromise = null; }
  }
  async run({ id, runId = id, cwd, prompt, model, effort, sessionId = null, onEvent = () => {}, onApproval, signal, workerLifecycle }) {
    let child, bridge, abortHandler, cancelTimer;
    if (signal?.aborted) return { sessionId, status: 'cancelled' };
    try {
      const cli = this.resolve('claude');
      if (!cli) throw new Error('未安装 Claude Code，当前不能运行此助手。');
      const auth = await this.auth(cli, cwd);
      if (!auth.loggedIn || auth.method !== 'claude.ai') throw new Error('仅支持已登录的 Claude 订阅；请使用 claude auth login。不会改用 API 计费。');
      const quotaAccountKey = this.quotaAccountKey;
      if (signal?.aborted) return { sessionId, status: 'cancelled' };
      bridge = await this.permissionBridge({ onApproval, signal, runId, cwd, onPeerUpdate: onEvent,
        isActive: () => !!child && this.active.get(runId)?.child === child && child.exitCode === null && child.signalCode === null });
      if (signal?.aborted) return { sessionId, status: 'cancelled' };
      const helperPath = fileURLToPath(new URL('./permission-helper.mjs', import.meta.url));
      const config = { mcpServers: { saw_permissions: { type: 'stdio', command: process.execPath, args: [helperPath] } } };
      const hasProgress = typeof runId === 'string' && runId.length > 0 && bridge.progressUrl && bridge.enqueueUpdate;
      const runSettingsArgs = hasProgress ? ['--settings', JSON.stringify(claudeRunSettings())] : settingsArgs;
      const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--permission-mode', 'default', ...runSettingsArgs, '--mcp-config', JSON.stringify(config), '--permission-prompt-tool', 'mcp__saw_permissions__approve'];
      // An explicit default clears a prior CLI model override for this run.
      args.push('--model', model || 'default');
      if (effort) args.push('--effort', effort);
      if (sessionId) args.push('--resume', sessionId);
      child = this.spawnProcess(cli, args, { cwd, workerLifecycle, env: { ...subscriptionEnv('claude'), SAW_PERMISSION_URL: bridge.url, SAW_PERMISSION_TOKEN: bridge.token,
        ...(hasProgress ? { SAW_PROGRESS_URL: bridge.progressUrl, SAW_PROGRESS_TOKEN: bridge.progressToken, SAW_PROGRESS_RUN_ID: runId } : {}) } });
      this.children.add(child);
      let finalResult = null, protocolError = null, lastError = null, rateLimited = false, deltaId = 'message';
      const usageTracker = createClaudeUsageTracker();
      const itemTexts = new Map();
      const completion = new Promise(resolve => {
        child.on('error', error => { protocolError = error; });
        child.on('close', code => {
          this.children.delete(child);
          if (this.active.get(runId)?.child === child) this.active.delete(runId);
          if (signal?.aborted) { resolve({ sessionId, status: 'cancelled' }); return; }
          const error = protocolError ? safeError(protocolError) : finalResult?.is_error ? safeError(finalResult.result || finalResult.errors?.join('; ') || 'Claude run failed') : lastError;
          if (rateLimited && (!finalResult || finalResult.is_error)) resolve({ sessionId, status: 'quota_exhausted', error: error || 'Claude 订阅额度暂不可用。' });
          else if (code !== 0 || !finalResult || finalResult.is_error || protocolError) resolve({ sessionId, status: 'failed', error: error || `Claude Code 未完成任务（退出码 ${code}）。` });
          else if (finalResult.permission_denials?.length) resolve({ sessionId, status: 'failed', error: '部分操作被权限检查拒绝，请查看工具记录后决定下一步。' });
          else resolve({ sessionId, status: 'completed' });
        });
      });
      child.stderr.setEncoding('utf8'); child.stderr.on('data', () => {});
      child.stdin.on('error', error => { protocolError = error; });
      makeLineReader(child.stdout, line => {
        let event;
        try { event = JSON.parse(line); } catch { protocolError = new Error('Claude Code 返回了无效 JSON。'); void terminateCli(child); return; }
        if (event.session_id && event.session_id !== sessionId) { sessionId = event.session_id; onEvent({ type: 'session', sessionId }); }
        if (event.type === 'stream_event' && !event.parent_tool_use_id) {
          if (event.event?.type === 'message_start') deltaId = event.event.message?.id || deltaId;
          if (event.event?.delta?.type === 'text_delta') {
            const text = event.event.delta.text || ''; itemTexts.set(deltaId, (itemTexts.get(deltaId) || '') + text); onEvent({ type: 'text_delta', text });
          }
        } else if (event.type === 'assistant' && !event.parent_tool_use_id) {
          const text = (event.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
          if (text) { itemTexts.set(event.message?.id || deltaId, text); onEvent({ type: 'text', text: [...itemTexts.values()].join('\n\n') }); }
          for (const item of event.message?.content || []) if (item.type === 'tool_use') onEvent({ type: 'tool', message: item.name, item });
          onEvent({ type: 'usage', usage: usageTracker.update(event) });
          if (event.error) { lastError = safeError(event.error); rateLimited ||= /rate_limit|quota|usage_limit/.test(lastError); onEvent({ type: 'error', message: lastError }); }
        } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) if (block.type === 'tool_result') {
            const result = { type: 'tool_result', tool_use_id: block.tool_use_id, is_error: block.is_error, content: block.content };
            onEvent({ type: 'tool', message: block.is_error ? '工具执行失败' : '工具执行结果', item: result,
              tool_use_id: block.tool_use_id, is_error: block.is_error, content: block.content,
              ...(event.parent_tool_use_id ? { parent_tool_use_id: event.parent_tool_use_id } : {}) });
          }
        } else if (event.type === 'result') {
          finalResult = event;
          if (!itemTexts.size && event.result) onEvent({ type: 'text', text: event.result });
          onEvent({ type: 'usage', usage: usageTracker.update(event) });
          rateLimited ||= /rate_limit|quota|usage.limit|hit.your.limit/i.test(`${event.subtype || ''} ${event.result || ''} ${(event.errors || []).join(' ')}`);
          if (event.permission_denials?.length) onEvent({ type: 'tool', message: '操作权限被拒绝', denials: event.permission_denials });
        } else if (event.type === 'rate_limit_event') {
          // Optional fields describe only the window actually reported.
          const info = event.rate_limit_info || {};
          rateLimited ||= info.status === 'rejected';
          onEvent({ type: 'tool', message: 'Claude 使用限制更新', limitStatus: info.status, resetsAt: info.resetsAt ?? null });
          const observedAt = new Date().toISOString();
          const windows = normalizeClaudeQuota(info, observedAt);
          if (windows.length && this.snapshot.authenticated && quotaAccountKey === this.quotaAccountKey) {
            const merged = new Map(this.snapshot.quota.map(window => [window.id, window]));
            for (const window of windows) {
              const previous = merged.get(window.id);
              merged.set(window.id, previous && window.usedPercent === null && previous.usedPercent !== null
                ? {...window,usedPercent:previous.usedPercent,resetsAt:window.resetsAt??previous.resetsAt,
                  observedAt:previous.observedAt,statusObservedAt:observedAt} : window);
            }
            this.quotaRevision++;
            const update = { quota: [...merged.values()], quotaUpdatedAt: observedAt, quotaCheckedAt: observedAt, quotaError: null };
            this.publish(update); onEvent({ type: 'quota', ...update });
          }
        } else if (event.type === 'system') {
          onEvent({ type: 'tool', message: event.subtype || 'Claude 系统事件', ...(event.model ? { model: event.model } : {}) });
        }
      }, error => { protocolError = error; void terminateCli(child); });
      abortHandler = () => {
        if (this.active.get(runId)?.child === child) this.active.delete(runId);
        void bridge.close();
        // Windows kill(SIGINT) is not a console Ctrl+C and can orphan tools;
        // terminate the exact tree instead. POSIX first allows a graceful stop.
        if (process.platform === 'win32') void terminateCli(child);
        else { child.kill('SIGINT'); cancelTimer = setTimeout(() => { void terminateCli(child); }, 5000); }
      };
      signal?.addEventListener('abort', abortHandler, { once: true });
      if (hasProgress && !signal?.aborted) {
        this.active.set(runId, { child, bridge, signal });
        onEvent({ type: 'control_ready', capability: 'peer_updates' });
      }
      // Prompt is data on stdin, never shell text or process command-line code.
      child.stdin.end(prompt);
      if (signal?.aborted) abortHandler();
      return await completion;
    } catch (error) { const message = safeError(error); onEvent({ type: 'error', message }); return { sessionId, status: signal?.aborted ? 'cancelled' : 'failed', error: message }; }
    finally {
      clearTimeout(cancelTimer); signal?.removeEventListener('abort', abortHandler);
      if (this.active.get(runId)?.child === child) this.active.delete(runId);
      if (child) { await terminateCli(child); this.children.delete(child); }
      await bridge?.close();
    }
  }
  async close() { this.closed = true; this.active.clear(); await Promise.all([...this.children].map(child => terminateCli(child))); await this.quotaRefreshPromise; }
}
