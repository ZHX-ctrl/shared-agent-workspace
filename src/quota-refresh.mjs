// One lightweight account read while a page is connected. Model execution is
// deliberately not part of this scheduler's interface.
export function createQuotaRefresher({ hasViewers, getProvider, refresh,
  authMode = 'chatgpt', intervalMs = 60_000, maxBackoffMs = 10 * 60_000, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout }) {
  let timer = null, inFlight = null, closed = false;
  let failures = 0, nextAttemptAt = 0, lastAttemptAt = 0, lastObservation = null;
  const timestamp = value => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; };
  const eligible = () => {
    const state = getProvider();
    return !closed && hasViewers() && state?.installed === true && state.authenticated === true && state.authMode === authMode;
  };
  const clearTimer = () => { if (timer !== null) { cancel(timer); timer = null; } };
  const dueAt = () => Math.max(lastAttemptAt + intervalMs,
    timestamp(getProvider()?.quotaCheckedAt) + intervalMs,
    timestamp(getProvider()?.quotaUpdatedAt) + intervalMs, nextAttemptAt);

  function update() {
    clearTimer();
    const state = getProvider();
    if (state?.quotaUpdatedAt && state.quotaUpdatedAt !== lastObservation && !state.quotaError) {
      lastObservation = state.quotaUpdatedAt; failures = 0; nextAttemptAt = 0;
    }
    if (!eligible() || inFlight) return;
    timer = schedule(() => { timer = null; void check(); }, Math.max(0, dueAt() - now()));
    timer?.unref?.();
  }

  function check() {
    if (inFlight) return inFlight;
    if (!eligible()) return Promise.resolve();
    if (now() < dueAt()) { update(); return Promise.resolve(); }
    lastAttemptAt = now();
    const operation = Promise.resolve().then(async () => {
      if (!eligible()) return;
      const state = await refresh();
      if (state?.quotaError) throw new Error('quota_read_failed');
      failures = 0; nextAttemptAt = 0;
    }).catch(() => {
      failures++;
      nextAttemptAt = now() + Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(failures, 8));
    }).finally(() => { if (inFlight === operation) inFlight = null; update(); });
    inFlight = operation;
    return operation;
  }

  return { update, check, close() { closed = true; clearTimer(); return inFlight ?? Promise.resolve(); } };
}
