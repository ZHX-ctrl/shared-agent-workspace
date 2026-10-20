import { randomUUID } from 'node:crypto';
import { makeLineReader, spawnCli, subscriptionEnv, terminateCli } from './process.mjs';

const selectableAliases = new Set(['default', 'opus', 'sonnet', 'haiku']);
const effortLevels = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const modelId = /^[a-zA-Z0-9][a-zA-Z0-9._:\[\]-]{0,159}$/;
const subscriptionOnlyEnv = {
  ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: '', CLAUDE_CODE_OAUTH_TOKEN: '',
  CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '',
};

// A workbench selection policy, not proof of a model's remaining subscription
// allowance. Never publish the account, commands, paths or raw init response.
export function normalizeClaudeCatalog(entries) {
  if (!Array.isArray(entries)) return [];
  const result = [], seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !selectableAliases.has(entry.value) || seen.has(entry.value)) continue;
    const resolved = typeof entry.resolvedModel === 'string' && modelId.test(entry.resolvedModel) ? entry.resolvedModel : null;
    const description = typeof entry.description === 'string' ? entry.description : '';
    if (/fable/i.test(entry.value) || (resolved && /fable/i.test(resolved))) continue;
    if (/requires?\s+(?:additional\s+|extra\s+)?(?:usage\s+credits|extra\s+usage)|usage\s+credits\s+(?:are\s+)?required/i.test(description)) continue;
    if (entry.value === 'default' && !resolved) continue;
    const name = typeof entry.displayName === 'string' && entry.displayName.trim()
      ? entry.displayName.trim().slice(0, 100) : entry.value;
    const efforts = entry.supportsEffort === true && Array.isArray(entry.supportedEffortLevels)
      ? [...new Set(entry.supportedEffortLevels.filter(value => effortLevels.has(value)))] : [];
    result.push({ id: entry.value, name, isDefault: entry.value === 'default', efforts,
      ...(resolved ? { resolvedModel: resolved } : {}) });
    seen.add(entry.value);
  }
  return result;
}

// Official SDK: Query.initialize sends this control frame before any prompt;
// ClaudeSDKClient.get_server_info only reads the initialization response.
// https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py
// https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/client.py
// Authentication must already be verified by the caller. This does not inspect
// credential files, send user messages, resume sessions or request inference.
export function readClaudeCatalog(cli, { settings = {}, env = process.env, spawnProcess = spawnCli, cwd, timeout = 12000 } = {}) {
  const safeEnv = subscriptionEnv('claude', env);
  delete safeEnv.CLAUDECODE;
  const safeSettings = { ...settings, forceLoginMethod: 'claudeai', apiKeyHelper: '',
    env: { ...(settings.env || {}), ...subscriptionOnlyEnv } };
  const args = ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk',
    '--tools', '', '--model', 'default', '--settings', JSON.stringify(safeSettings)];
  const requestId = `catalog-${randomUUID()}`;
  const duration = Number.isFinite(timeout) ? Math.min(18000, Math.max(1, timeout)) : 12000;
  return new Promise((resolve, reject) => {
    let child, completed = false, timer;
    const finish = (error, models) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (!child) { reject(error || new Error('Claude 模型目录进程未启动。')); return; }
      try { child.stdin.end(); } catch { /* The process may already have exited. */ }
      // This retained child handle/PID only. Never terminate by process name.
      void terminateCli(child).then(() => error ? reject(error) : resolve(models),
        () => reject(new Error('Claude 模型目录进程未能正常结束。')));
    };
    try { child = spawnProcess(cli, args, { cwd, env: safeEnv }); }
    catch { finish(new Error('无法启动 Claude 模型目录检查。')); return; }
    timer = setTimeout(() => finish(new Error('Claude 模型目录读取超时，请稍后重试。')), duration);
    child.stderr.resume(); // Never log or return CLI diagnostics/account values.
    child.on('error', () => finish(new Error('Claude 模型目录进程启动失败。')));
    child.on('close', () => finish(new Error('Claude 在返回模型目录前已退出。')));
    child.stdin.on('error', () => finish(new Error('Claude 模型目录连接已关闭。')));
    makeLineReader(child.stdout, line => {
      if (completed) return;
      let event;
      try { event = JSON.parse(line); } catch { finish(new Error('Claude 模型目录返回了无效数据。')); return; }
      if (!event || typeof event !== 'object') { finish(new Error('Claude 模型目录返回了无效数据。')); return; }
      if (['assistant', 'result', 'stream_event', 'user', 'control_request'].includes(event.type)) {
        finish(new Error('Claude 模型目录检查收到非初始化事件，已停止。')); return;
      }
      if (event.type !== 'control_response') return;
      if (event.response?.request_id !== requestId || event.response?.subtype !== 'success'
          || !Array.isArray(event.response?.response?.models)) {
        finish(new Error('Claude 未返回有效的模型目录初始化结果。')); return;
      }
      const models = normalizeClaudeCatalog(event.response.response.models);
      finish(models.length ? null : new Error('Claude 未返回符合订阅选择策略的模型选项。'), models);
    }, () => finish(new Error('Claude 模型目录数据超过读取限制。')), 1024 * 1024);
    try {
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: requestId,
        request: { subtype: 'initialize', hooks: null } }) + '\n');
    } catch { finish(new Error('无法发送 Claude 模型目录初始化请求。')); }
  });
}
