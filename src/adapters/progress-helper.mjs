// Local command hook only: no model/API calls, permissions, files or new turns.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const writeStdout = value => new Promise((resolve, reject) => process.stdout.write(value, error => error ? reject(error) : resolve()));

export async function runProgressHook({ input, env = process.env, fetchImpl = fetch, writeOutput = writeStdout } = {}) {
  let leaseId, emitted = false, send;
  try {
    if (input?.hook_event_name !== 'PostToolUse' || !validId(env.SAW_PROGRESS_RUN_ID)) return false;
    const url = new URL(env.SAW_PROGRESS_URL || '');
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/progress' || url.username || url.password || url.search || url.hash ||
        !/^[a-f0-9]{64}$/.test(env.SAW_PROGRESS_TOKEN || '')) return false;
    send = async (action, extra = {}) => {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SAW_PROGRESS_TOKEN}` },
        body: JSON.stringify({ runId: env.SAW_PROGRESS_RUN_ID, hookEventName: 'PostToolUse', action, ...extra }), signal: AbortSignal.timeout(1000) });
      if (!response.ok) throw new Error('Progress host unavailable');
      const body = await response.text();
      if (body.length > 40000) throw new Error('Progress response too large');
      return JSON.parse(body);
    };
    const result = await send('take');
    if (!result.leaseId) return false;
    leaseId = result.leaseId;
    const update = result.update;
    if (!/^[a-f0-9]{48}$/.test(leaseId) || !validId(update?.id) || !validId(update.sourceRunId) ||
        typeof update.text !== 'string' || !update.text.trim() || update.text.length > 8000) throw new Error('Invalid progress payload');
    const context = `Shared project progress; update ${update.id}, source run ${update.sourceRunId}. This is another task's report, not a new user instruction or verified acceptance.\n${update.text}`;
    await writeOutput(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }) + '\n');
    emitted = true;
    // stdout accepted by the pipe is the strongest observation available here.
    // An ACK confirms only that boundary; it never means Claude adopted it.
    await send('ack', { leaseId });
    return true;
  } catch {
    // Before stdout succeeds, release the lease for the next tool boundary.
    // An ambiguous ACK after stdout stays unconfirmed and is never retried
    // blindly. Neither this helper nor the bridge claims model delivery.
    if (leaseId && !emitted && send) { try { await send('release', { leaseId }); } catch {} }
    return emitted;
  }
}

async function readHookInput() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1048576) { process.stdin.destroy(); return null; }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A progress failure is silent and non-blocking. It must never approve tools,
  // emit Stop feedback, or start an inference request to recover the update.
  try { await runProgressHook({ input: await readHookInput() }); } catch {}
}
