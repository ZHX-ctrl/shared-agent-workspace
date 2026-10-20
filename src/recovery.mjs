// Recovery only observes an exact parent-bound worker lifecycle. It never kills
// a process, retries a model, or treats a stale record/empty Job as process exit.
const pendingByStore = new WeakMap();

async function defaultProbeWorker(jobName) {
  const { probeWindowsJob } = await import('./windows-job.mjs');
  return probeWindowsJob(jobName);
}

export async function verifyWorkerExit(run, { probeWorker = defaultProbeWorker } = {}) {
  const expectedJobName = `Local\\SharedAgentWorkspace-${run?.id}`;
  const lifecycle = run?.workerLifecycle;
  if (typeof run?.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(run.id)
    || lifecycle?.kind !== 'windows-job-v1' || lifecycle.jobName !== expectedJobName) {
    return { verified: false, reason: '缺少可核实的原工作进程组标记；尚未确认进程退出，继续保留工作范围占用。' };
  }
  let result;
  try { result = await probeWorker(expectedJobName); }
  catch {
    return { verified: false, reason: '检查原工作进程组失败，进程状态仍未知；继续保留工作范围占用，稍后可再次核实。' };
  }
  if (result?.exists === true) {
    return { verified: false, reason: '原工作进程组仍存在，可能正在运行或启动；即使暂时没有活动进程，也继续保留工作范围占用。' };
  }
  if (result?.exists !== false) {
    return { verified: false, reason: '未取得原工作进程组已退出的明确证据；继续保留工作范围占用，等待核实。' };
  }
  return { verified: true, evidence: { kind: 'windows-job-absent', jobName: expectedJobName, observedAt: new Date().toISOString(), exists: false },
    reason: '已确认原工作进程组不存在。' };
}

async function inspectRun(store, id, probeWorker) {
  let run = store.getRun(id);
  if (!run) throw new Error('运行不存在。');
  if (run.status !== 'recovery_pending') return run;
  const verification = await verifyWorkerExit(run, { probeWorker });
  // A concurrently finished run must not be rewritten using an older probe.
  run = store.getRun(id);
  if (!run || run.status !== 'recovery_pending') return run;
  if (!verification.verified) {
    return store.updateRun(id, { interruptionReason: verification.reason, recoveryLastCheckedAt: new Date().toISOString() });
  }
  const { evidence } = verification;
  const now = evidence.observedAt;
  // Commit evidence before making the run terminal. If interrupted between
  // writes, recovery remains pending and must verify absence again on restart.
  await store.appendRunEvent(id, { type: 'recovery_verified', status: 'interrupted', workerExitVerifiedAt: now, evidence });
  return store.updateRun(id, { status: 'interrupted', endedAt: now, workerExitVerifiedAt: now,
    workerExitEvidence: evidence, recoveryLastCheckedAt: now,
    interruptionReason: '已确认原工作进程组不存在；本次运行已中断，原有历史和进度保留，可重新接续。' });
}

export async function recoverRun(store, id, { probeWorker = defaultProbeWorker } = {}) {
  // Deduplicate concurrent UI/startup probes for the same Store and run.
  let pending = pendingByStore.get(store);
  if (!pending) { pending = new Map(); pendingByStore.set(store, pending); }
  if (pending.has(id)) return pending.get(id);
  const operation = inspectRun(store, id, probeWorker);
  pending.set(id, operation);
  try { return await operation; }
  finally { if (pending.get(id) === operation) pending.delete(id); }
}
