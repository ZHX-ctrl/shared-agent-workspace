import { createHash, randomUUID } from 'node:crypto';
import { makeLineReader, spawnCli, subscriptionEnv, terminateCli } from './process.mjs';

const windows = {
  five_hour: '5小时额度', seven_day: '7天额度', seven_day_opus: 'Opus 7天额度',
  seven_day_sonnet: 'Sonnet 7天额度', seven_day_oauth_apps: '应用 7天额度',
};
const subscriptionOnlyEnv = {
  ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', CLAUDE_CODE_OAUTH_TOKEN: '',
  CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '',
};
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeWindow(id, label, value, observedAt) {
  if (!value || typeof value !== 'object') return null;
  // get_usage utilization is already a PERCENT (0-100). In contrast,
  // rate_limit_event's utilization is a fraction (0-1); do not share that parser.
  const usedPercent = Number.isFinite(value.utilization) && value.utilization >= 0 && value.utilization <= 100
    ? Math.round(value.utilization * 100) / 100 : null;
  const resetMs = typeof value.resets_at === 'string' && isoTimestamp.test(value.resets_at)
    ? Date.parse(value.resets_at) : NaN;
  const resetsAt = Number.isFinite(resetMs) && resetMs > 0 ? Math.floor(resetMs / 1000) : null;
  if (usedPercent === null && resetsAt === null) return null;
  return { id: `claude:${id}`, label, usedPercent, resetsAt, status: null, observedAt };
}

export function normalizeClaudeQuotaResponse(response, observedAt = new Date().toISOString()) {
  if (!response || response.rate_limits_available !== true || !response.rate_limits || typeof response.rate_limits !== 'object') return [];
  const result = [];
  for (const [id, label] of Object.entries(windows)) {
    const value = normalizeWindow(id, label, response.rate_limits[id], observedAt);
    if (value) result.push(value);
  }
  // This field is explicitly declared by SDKControlGetUsageResponse. Do not
  // scrape arbitrary provider-private fields, transcripts or monetary spend.
  const scoped = response.rate_limits.model_scoped;
  if (Array.isArray(scoped)) {
    const seen = new Set();
    for (const entry of scoped.slice(0, 100)) {
      const name = typeof entry?.display_name === 'string' ? entry.display_name.trim() : '';
      if (!name || name.length > 80 || !/^[\p{L}\p{N} ._+[\]()-]+$/u.test(name) || seen.has(name)) continue;
      const key = createHash('sha256').update(name).digest('hex').slice(0, 16);
      const value = normalizeWindow(`model:${key}`, `${name} 7天额度`, entry, observedAt);
      if (value) { result.push(value); seen.add(name); }
    }
  }
  return result;
}

// Verified against the official @anthropic-ai/claude-agent-sdk 0.3.303:
// sdk.d.ts SDKControlGetUsageRequest/Response (lines 4313-4422), and sdk.mjs
// usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true}).
// https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
// Experimental upstream contract: fail explicitly on empty/unsupported output.
// Caller verifies claude.ai authentication first. The official CLI performs
// the authenticated metadata request; this module never reads credential files.
export function readClaudeQuota(cli, { settings = {}, env = process.env, spawnProcess = spawnCli, cwd, timeout = 15000 } = {}) {
  const safeEnv = subscriptionEnv('claude', env);
  delete safeEnv.CLAUDECODE;
  const safeSettings = { ...settings, forceLoginMethod: 'claudeai', apiKeyHelper: '',
    env: { ...(settings.env || {}), ...subscriptionOnlyEnv } };
  const args = ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk',
    '--tools', '', '--model', 'default', '--settings', JSON.stringify(safeSettings)];
  const requestPrefix = `quota-${randomUUID()}`;
  const duration = Number.isFinite(timeout) ? Math.min(18000, Math.max(1, timeout)) : 15000;
  return new Promise((resolve, reject) => {
    let child, completed = false, timer, phase = 'initialize';
    const finish = (error, quota) => {
      if (completed) return;
      completed = true; clearTimeout(timer);
      if (!child) { reject(error || new Error('Claude 额度读取进程未启动。')); return; }
      try { child.stdin.end(); } catch { /* It may already have exited. */ }
      void terminateCli(child).then(() => error ? reject(error) : resolve(quota),
        () => reject(new Error('Claude 额度读取进程未能正常结束。')));
    };
    const send = request => {
      try { child.stdin.write(JSON.stringify({ type: 'control_request', request_id: `${requestPrefix}:${phase}`, request }) + '\n'); }
      catch { finish(new Error('无法发送 Claude 额度读取请求。')); }
    };
    try { child = spawnProcess(cli, args, { cwd, env: safeEnv }); }
    catch { finish(new Error('无法启动 Claude 额度读取。')); return; }
    timer = setTimeout(() => finish(new Error('Claude 额度读取超时，请检查网络后重试。')), duration);
    child.stderr.resume();
    child.on('error', () => finish(new Error('Claude 额度读取进程启动失败。')));
    child.on('close', () => finish(new Error('Claude 在返回额度前已退出。')));
    child.stdin.on('error', () => finish(new Error('Claude 额度读取连接已关闭。')));
    makeLineReader(child.stdout, line => {
      if (completed) return;
      let event;
      try { event = JSON.parse(line); } catch { finish(new Error('Claude 额度接口返回了无效数据。')); return; }
      if (!event || typeof event !== 'object') { finish(new Error('Claude 额度接口返回了无效数据。')); return; }
      if (['assistant', 'result', 'stream_event', 'user', 'control_request'].includes(event.type)) {
        finish(new Error('Claude 额度检查收到非查询事件，已停止。')); return;
      }
      if (event.type !== 'control_response') return;
      if (event.response?.request_id !== `${requestPrefix}:${phase}` || event.response?.subtype !== 'success') {
        finish(new Error('当前 Claude CLI 未能完成额度查询，请更新 CLI 或稍后重试。')); return;
      }
      if (phase === 'initialize') {
        phase = 'usage';
        // Without skip_behaviors the CLI scans seven days of local transcripts.
        // Never send a /usage user prompt or enter the model loop for this meter.
        send({ subtype: 'get_usage', skip_behaviors: true });
        return;
      }
      const quota = normalizeClaudeQuotaResponse(event.response.response);
      finish(quota.length ? null : new Error('Claude 暂未返回可用的订阅额度数据，请检查网络后重试；这不代表额度为零。'), quota);
    }, () => finish(new Error('Claude 额度数据超过读取限制。')), 1024 * 1024);
    send({ subtype: 'initialize', hooks: null });
  });
}
