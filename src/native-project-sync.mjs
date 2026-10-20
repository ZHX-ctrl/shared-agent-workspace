import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename, rm, realpath, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { JsonRpcClient } from './adapters/rpc.mjs';
import { resolveCli, subscriptionEnv } from './adapters/process.mjs';
import { CODEX_SERVER_ARGS } from './adapters/codex.mjs';
import { projectPathKey } from './codex-projects.mjs';

const exec = promisify(execFile);
const fail = (message, code = 'PROJECT_SYNC_FAILED') => Object.assign(new Error(message), { code });
const hash = value => createHash('sha256').update(value).digest('hex');
const key = value => projectPathKey(value, 'win32');
const nonempty = value => typeof value === 'string' && value.length > 0;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
export const LIVE_PROJECT_SYNC_MESSAGE = 'Codex 桌面项目实时管理接口尚未接通。此次改名或移除未执行，原项目和资料保留；不会等待退出 Codex 后再自动执行。';

// Unknown processes/denied process inspection are not proof the desktop exited.
// Modern Windows distributions run ChatGPT.exe; older ones run Codex.exe.
export async function desktopIsRunning({ run = exec, platform = process.platform } = {}) {
  if (platform !== 'win32') throw fail('项目侧栏同步目前仅支持 Windows。');
  const { stdout } = await run(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe' OR Name = 'Codex.exe'\" | Select-Object ExecutablePath) | ConvertTo-Json -Compress"],
    { windowsHide: true, shell: false, timeout: 8000, maxBuffer: 65536 });
  const rows = JSON.parse(stdout.trim() || '[]');
  return (Array.isArray(rows) ? rows : [rows]).some(row => {
    const filename = row.ExecutablePath;
    // Only the known official CLI locations are excluded; unknown locations
    // conservatively block changes, including portable desktop installs.
    return !nonempty(filename) || !(/[/\\]OpenAI[/\\]Codex[/\\]bin[/\\][^/\\]+[/\\]codex\.exe$/i.test(filename)
      || /[/\\]app[/\\]resources[/\\]codex\.exe$/i.test(filename)
      || /[/\\]@openai[/\\]codex[^/\\]*[/\\].*[/\\]codex\.exe$/i.test(filename));
  });
}

export function findDesktopProject(state, projectPath, codexHome, expectedId) {
  if (!record(state?.['local-projects']) || !Array.isArray(state['project-order'])) throw fail('Codex 项目登记格式无法识别，未修改。');
  const matches = Object.entries(state['local-projects']).filter(([, p]) => Array.isArray(p?.rootPaths) && p.rootPaths.some(p => key(p) === key(projectPath)));
  if (matches.length > 1) throw fail('同一文件夹存在多个 Codex 项目，请先在 Codex 中整理。');
  const found = matches[0];
  if (!found) {
    if (expectedId && state['local-projects'][expectedId]) throw fail('Codex 项目的源文件夹已改变，停止同步。');
    return null;
  }
  const [id, project] = found;
  if (project.id !== id || (expectedId && expectedId !== id) || project.rootPaths.length !== 1
    || !state['project-order'].includes(id) || project.chatGptBacking || project.chatGptBackingCreation || project.retiredChatGptBacking) {
    throw fail('Codex 项目身份、源文件夹或关联已改变，请重新核对；未修改。');
  }
  const mappings = state['app-server-project-id-by-legacy-project-id-by-host'];
  const ids = [...new Set(Object.entries(mappings || {}).filter(([host]) => host.startsWith('local:') && key(host.slice(6)) === key(codexHome))
    .map(([, entries]) => entries?.[id]).filter(nonempty))];
  if (ids.length !== 1) throw fail('Codex 项目后台身份不明确，请先完成项目登记。');
  return { projectId: id, nativeProjectId: ids[0], expectedName: project.name, roots: [...project.rootPaths] };
}

// This patch is used ONLY with the desktop closed. Never mutate its live cache.
// Keep unrelated fields byte-equivalent at the value level; preserve all files
// and chats, and move memberships of a removed project to projectless.
export function patchDesktopProject(state, job, threadIds = []) {
  const next = structuredClone(state);
  const id = job.projectId;
  const project = id && next['local-projects']?.[id];
  if (job.operation === 'rename') {
    if (!project) throw fail('Codex 项目已被移除，不能改名。');
    if (project.name !== job.expectedName && project.name !== job.name) throw fail('Codex 项目已被另外改名，停止覆盖。');
    project.name = job.name;
    project.updatedAt = Date.now();
  } else if (job.operation === 'remove') {
    if (project) delete next['local-projects'][id];
    for (const field of ['project-order', 'pinned-project-ids']) if (Array.isArray(next[field])) next[field] = next[field].filter(value => value !== id);
    for (const field of ['project-appearances', 'sidebar-project-thread-orders']) if (record(next[field])) delete next[field][id];
    if (next['selected-project']?.type === 'local' && next['selected-project'].projectId === id) delete next['selected-project'];
    const assignments = next['thread-project-assignments'];
    const detached = new Set(threadIds);
    for (const [threadId, assignment] of Object.entries(assignments || {})) {
      if (id && assignment?.projectKind === 'local' && assignment.projectId === id) { delete assignments[threadId]; detached.add(threadId); }
    }
    if (detached.size) next['projectless-thread-ids'] = [...new Set([...(next['projectless-thread-ids'] || []), ...detached])];
    // Preserve old native-ID mappings for audit/idempotency. On re-add, the
    // official desktop creates a new legacy project identity for this folder.
  } else throw fail('未知项目同步操作。');
  return next;
}

async function listAll(rpc, method, params = {}) {
  const data = [], seen = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    const response = await rpc.request(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(response?.data)) throw fail('Codex 列表响应不完整，停止同步。');
    data.push(...response.data);
    if (response.nextCursor == null) return data;
    cursor = response.nextCursor;
    if (!nonempty(cursor) || seen.has(cursor)) throw fail('Codex 分页异常，停止同步。');
    seen.add(cursor);
  }
  throw fail('Codex 列表超过核验范围，停止同步。');
}

export function createNativeProjectSync({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  requireLive = false,
  isRunning = desktopIsRunning, Rpc = JsonRpcClient, resolve = resolveCli, canonicalize = realpath,
  backupDir = new URL('../work/project-sync-receipts/', import.meta.url),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), quietMs = 1000 } = {}) {
  const statePath = path.join(codexHome, '.codex-global-state.json');
  const liveUnavailable = () => Object.assign(fail(LIVE_PROJECT_SYNC_MESSAGE, 'LIVE_PROJECT_SYNC_UNAVAILABLE'), { statusCode: 503 });
  async function read() { return JSON.parse(await readFile(statePath, 'utf8')); }
  async function prepare(project, patch) {
    if (requireLive) throw liveUnavailable();
    const projectPath = await canonicalize(project.path);
    if (!key(projectPath)) throw fail('项目路径不是 Windows 绝对路径。');
    const state = await read();
    const identity = findDesktopProject(state, projectPath, codexHome, project.nativeCodex?.projectId);
    const operation = patch.removed === true ? 'remove' : 'rename';
    if (!identity && operation === 'rename') throw fail('此项目还未登记到 Codex，请先在项目信息中添加到 Codex，再改名。');
    return { id: randomUUID(), status: 'pending', operation, ...(operation === 'rename' ? { name: patch.name } : {}),
      projectPath, ...identity, requestedAt: new Date().toISOString(), phase: 'waiting_for_desktop_exit' };
  }

  async function apply(project, job, executable) {
    // The current user requires live synchronization. Never silently fall back
    // to private cache edits after the app exits, including saved older jobs.
    if (requireLive) throw liveUnavailable();
    if (await isRunning()) return { waiting: true };
    await sleep(quietMs);
    if (await isRunning()) return { waiting: true };
    if (!job || !/^[0-9a-f-]{36}$/i.test(job.id) || !['rename', 'remove'].includes(job.operation)
      || key(await canonicalize(project.path)) !== key(job.projectPath)) throw fail('待同步项目路径无效，未修改。');
    const source = await readFile(statePath, 'utf8');
    const state = JSON.parse(source);
    const identity = findDesktopProject(state, job.projectPath, codexHome, job.projectId);
    if (identity && job.nativeProjectId && identity.nativeProjectId !== job.nativeProjectId) throw fail('Codex 后台项目身份已变化，停止同步。');
    if (!identity && job.operation === 'rename') throw fail('Codex 项目已移除，不能改名。');
    // Validate conflicts before any native mutation.
    patchDesktopProject(state, job);
    const cli = resolve('codex', { explicitPath: executable });
    if (!cli) throw fail('未找到官方 Codex CLI。');
    const rpc = new Rpc(cli, CODEX_SERVER_ARGS, { cwd: project.path, env: { ...subscriptionEnv('codex'), CODEX_HOME: codexHome } });
    rpc.on('request', message => rpc.reject(message.id, 'Project sync never approves agent actions'));
    let threadIds = [];
    try {
      await rpc.request('initialize', { clientInfo: { name: 'shared_workspace_project_sync', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      rpc.notify('initialized');
      const all = await listAll(rpc, 'project/list');
      const matches = all.filter(p => p.roots?.some(root => key(root.path) === key(job.projectPath)));
      if (matches.length > 1) throw fail('同一文件夹有多个 Codex 后台项目，停止同步。');
      const native = matches[0];
      if (native && (native.roots.length !== 1 || (job.nativeProjectId && native.id !== job.nativeProjectId))) throw fail('Codex 项目身份或源文件夹发生变化，停止同步。');
      if (job.nativeProjectId && all.some(p => p.id === job.nativeProjectId && p !== native)) throw fail('Codex 项目路径发生变化，停止同步。');
      if (!native && job.operation === 'rename') throw fail('Codex 后台项目不存在。');
      if (job.operation === 'rename' && native.name !== job.expectedName && native.name !== job.name) throw fail('Codex 项目已被另外改名，停止覆盖。');
      if (native && job.operation === 'remove') {
        for (const archived of [false, true]) {
          const threads = await listAll(rpc, 'thread/list', { projectId: native.id, archived, sourceKinds: [] });
          if (threads.some(t => t.status?.type === 'active')) throw fail('Codex 项目仍有任务运行，请结束后再移除。');
          for (const thread of threads) {
            if (!nonempty(thread.id)) throw fail('Codex 聊天身份无效，停止同步。');
            const saved = (await rpc.request('thread/read', { threadId: thread.id, includeTurns: true }))?.thread;
            if (saved?.id !== thread.id || saved.turns?.some(turn => ['inProgress', 'in_progress'].includes(turn.status))) throw fail('Codex 聊天尚未结束或无法核验，停止移除项目。');
          }
          threadIds.push(...threads.map(t => t.id));
        }
      }
      // Record only the affected project metadata, no conversation contents.
      await mkdir(backupDir, { recursive: true });
      const receiptPath = path.join(String(backupDir instanceof URL ? (await import('node:url')).fileURLToPath(backupDir) : backupDir), job.id + '.json');
      try { await writeFile(receiptPath, JSON.stringify({ job, native: native || null,
        desktopProject: state['local-projects'][job.projectId] || null, threadIds, cacheHash: hash(source),
        previousPosition: state['project-order'].indexOf(job.projectId),
        previousPinnedPosition: state['pinned-project-ids']?.indexOf(job.projectId) ?? -1,
        previousAppearance: state['project-appearances']?.[job.projectId],
        previousThreadOrder: state['sidebar-project-thread-orders']?.[job.projectId],
        previousSelection: state['selected-project']?.projectId === job.projectId ? state['selected-project'] : undefined,
        previousAssignments: Object.fromEntries(Object.entries(state['thread-project-assignments'] || {})
          .filter(([, assignment]) => assignment?.projectKind === 'local' && assignment.projectId === job.projectId)),
      }, null, 2), { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (await isRunning()) return { waiting: true };
      if (native && job.operation === 'rename') {
        await rpc.request('project/update', { projectId: native.id, name: job.name });
        const verified = (await rpc.request('project/read', { projectId: native.id })).project;
        if (verified?.name !== job.name || verified?.id !== native.id) throw fail('Codex 项目改名未通过读回核验。');
      } else if (native) {
        // Project deletion removes the registration, never the chats. Detach
        // memberships explicitly to match the desktop Remove action.
        for (const threadId of threadIds) await rpc.request('thread/metadata/update', { threadId, projectId: '' });
        await rpc.request('project/delete', { projectId: native.id });
        if ((await listAll(rpc, 'project/list')).some(p => p.id === native.id)) throw fail('Codex 项目仍存在，未完成移除。');
      }
      // A lost reply / restart may leave native metadata already updated. Replay
      // converges; do not report success before the desktop cache also commits.
      if (await isRunning()) return { waiting: true };
      if (await readFile(statePath, 'utf8') !== source) return { waiting: true };
      // Recover detached IDs from the durable receipt after partial completion.
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      threadIds = [...new Set([...threadIds, ...(receipt.threadIds || [])])];
      const next = patchDesktopProject(state, job, threadIds);
      const temp = statePath + '.shared-workspace-' + job.id + '.tmp';
      try {
        // A crash may leave only this operation's temporary cache file.
        await rm(temp, { force: true });
        const output = await open(temp, 'wx');
        try { await output.writeFile(JSON.stringify(next)); await output.sync(); } finally { await output.close(); }
        if (await isRunning() || await readFile(statePath, 'utf8') !== source) return { waiting: true };
        await rename(temp, statePath);
      } finally { await rm(temp, { force: true }); }
      const checked = await read();
      if (job.operation === 'rename' ? checked['local-projects']?.[job.projectId]?.name !== job.name
        : Object.values(checked['local-projects'] || {}).some(p => p.rootPaths?.some(root => key(root) === key(job.projectPath)))) throw fail('Codex 侧栏登记未通过读回核验。');
      return { complete: true, projectId: job.projectId, nativeProjectId: native?.id || job.nativeProjectId,
        checkedAt: new Date().toISOString(), desktopVisibility: 'next_launch' };
    } finally { await rpc.close(); }
  }
  return { prepare, apply };
}
