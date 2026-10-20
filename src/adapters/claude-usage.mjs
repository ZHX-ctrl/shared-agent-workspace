const tokens = value => Number.isSafeInteger(value) && value >= 0;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const modelId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+\[\]-]{0,199}$/.test(value);

// CLI assistant usage describes a single API request; result usage aggregates
// steps and is never the current context. Assistant output_tokens is the API's
// message_start placeholder, so it is not added to this input-context estimate.
// https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-per-step-usage
// https://code.claude.com/docs/en/agent-sdk/cost-tracking#why-are-output-tokens-zero
export function normalizeClaudeUsage(event = {}) {
  if (!record(event) || event.parent_tool_use_id || !['assistant', 'result'].includes(event.type)) return {};
  const usage = event.type === 'assistant' ? event.message?.usage : event.usage;
  if (!record(usage)) return {};
  const result = {};
  if (tokens(usage.input_tokens)) result.inputTokens = usage.input_tokens;
  if (tokens(usage.output_tokens)) result.outputTokens = usage.output_tokens;
  if (event.type !== 'assistant' || !tokens(usage.input_tokens)) return result;
  // Cache fields are optional on non-cached requests. Present but invalid fields
  // invalidate the estimate; don't coerce null, strings or negative values to 0.
  const cacheRead = usage.cache_read_input_tokens === undefined ? 0 : usage.cache_read_input_tokens;
  const cacheCreated = usage.cache_creation_input_tokens === undefined ? 0 : usage.cache_creation_input_tokens;
  const total = usage.input_tokens + cacheRead + cacheCreated;
  if (tokens(cacheRead) && tokens(cacheCreated) && tokens(total)) {
    result.contextTokens = total;
    result.contextEstimate = true;
    result.contextBasis = 'last_request_input';
  }
  return result;
}

// Each run owns its tracker. Emits complete snapshots because the server stores
// usage by replacement. Result totals cannot erase the last request's estimate.
// ModelUsage.contextWindow is official CLI metadata, but use it only when one
// exact model is reported and it is the latest main-loop assistant's model.
// https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py
export function createClaudeUsageTracker() {
  let latest = {}, context = {}, currentModel = null;
  const snapshot = () => ({ ...latest });
  return {
    update(event = {}) {
      if (!record(event) || event.parent_tool_use_id || !['assistant', 'result'].includes(event.type)) return snapshot();
      const normalized = normalizeClaudeUsage(event);
      if (event.type === 'assistant') {
        // Missing/invalid usage is an unknown *new* request, never evidence that
        // the preceding request or its model window is still current.
        currentModel = modelId(event.message?.model) ? event.message.model : null;
        context = normalized.contextTokens !== undefined ? {
          contextTokens: normalized.contextTokens,
          contextEstimate: true,
          contextBasis: 'last_request_input',
          ...(currentModel ? { contextModel: currentModel } : {}),
        } : {};
        latest = { ...normalized, ...context };
      } else {
        // Always clear an earlier window before reading a new result. Don't
        // choose the first/largest entry, infer an alias, or reuse a stale model.
        latest = { ...normalized, ...context };
        if (context.contextTokens !== undefined && currentModel && record(event.modelUsage)) {
          const names = Object.keys(event.modelUsage);
          if (names.length === 1 && names[0] === currentModel) {
            const window = event.modelUsage[currentModel]?.contextWindow;
            if (tokens(window) && window > 0) latest.contextWindow = window;
          }
        }
      }
      return snapshot();
    },
    snapshot,
    reset() { latest = {}; context = {}; currentModel = null; return snapshot(); },
  };
}
