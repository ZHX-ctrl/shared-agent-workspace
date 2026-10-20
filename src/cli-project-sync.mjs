import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { JsonRpcClient } from './adapters/rpc.mjs';
import { resolveCli, subscriptionEnv } from './adapters/process.mjs';
import { CODEX_SERVER_ARGS } from './adapters/codex.mjs';
import { ensureCodexProject, projectPathKey } from './codex-projects.mjs';

const fail = message => new Error(message);
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
export async function readAll(rpc, method, params = {}) {
  const rows = [], seen = new Set(); let cursor;
  for (let page = 0; page < 100; page++) {
    const result = await rpc.request(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) throw fail('Codex 列表响应无法核验。');
    rows.push(...result.data);
    if (result.nextCursor == null) return rows;
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || seen.has(result.nextCursor)) throw fail('Codex 列表分页异常。');
    cursor = result.nextCursor; seen.add(cursor);
  }
  throw fail('Codex 列表超过核验范围。');
}
export function assertIdle(thread) {
  if (!thread || !['idle', 'notLoaded'].includes(thread.status?.type)
    || thread.turns?.some(t => ['inProgress', 'in_progress', 'running'].includes(t.status))) {
    throw fail('对应 Codex CLI 会话仍在运行或状态不明，请先结束该任务。');
  }
}

// Uses only the official CLI protocol. Never opens the desktop, checks whether
// it is running, or reads/writes its private sidebar cache.
export function createCliProjectSync({ Rpc = JsonRpcClient, resolve = resolveCli,
  canonicalize = realpath, register = ensureCodexProject, env = process.env,
  backupDir = path.resolve('data/project-sync-receipts') } = {}) {
  async function connect(cwd, executable, action) {
    const cli = resolve('codex', { explicitPath: executable });
    if (!cli) throw fail('未找到官方 Codex CLI。');
    const rpc = new Rpc(cli, CODEX_SERVER_ARGS, { cwd, env: subscriptionEnv('codex', env) });
    rpc.on('request', message => rpc.reject(message.id, 'Project management does not approve agent actions'));
    try {
      await rpc.request('initialize', { clientInfo: { name: 'shared_workspace_cli_projects', version: '0.2.0' }, capabilities: { experimentalApi: true } });
      rpc.notify('initialized');
      return await action(rpc);
    } finally { await rpc.close(); }
  }
  function exact(rows, projectPath, expectedId) {
    const key = projectPathKey(projectPath);
    const matches = rows.filter(p => p.roots?.some(r => projectPathKey(r.path) === key));
    if (matches.length > 1) throw fail('同一目录有多个 Codex CLI 项目，未修改。');
    const result = matches[0];
    if (result && (result.roots.length !== 1 || (expectedId && result.id !== expectedId))) throw fail('Codex CLI 项目身份或目录已变化，未修改。');
    if (expectedId && rows.some(p => p.id === expectedId && p !== result)) throw fail('Codex CLI 项目已指向其他目录，未修改。');
    return result;
  }
  return {
    async prepare(project, patch, executable) {
      const projectPath = await canonicalize(project.path);
      const operation = patch.removed === true ? 'remove' : 'rename';
      let native = await connect(projectPath, executable, async rpc => exact(await readAll(rpc, 'project/list'), projectPath,
        project.nativeCodex?.nativeProjectId || (project.nativeCodex?.source === 'codex_app_server' ? project.nativeCodex.projectId : undefined)));
      if (!native && operation === 'rename') {
        const created = await register({ projectPath, name: project.name, executable });
        native = { id: created.projectId, name: created.name };
        if (!native.id) throw fail('Codex CLI 项目登记未确认。');
      }
      return { id: randomUUID(), status: 'pending', phase: 'checking', integration: 'cli', operation,
        projectPath, projectId: native?.id, nativeProjectId: native?.id, expectedName: native?.name,
        ...(operation === 'rename' ? { name: patch.name } : {}), requestedAt: new Date().toISOString() };
    },
    async apply(project, job, executable) {
      if (job.integration !== 'cli' || projectPathKey(await canonicalize(project.path)) !== projectPathKey(job.projectPath)) throw fail('CLI 项目操作与当前目录不匹配。');
      return connect(project.path, executable, async rpc => {
        const native = exact(await readAll(rpc, 'project/list'), job.projectPath, job.nativeProjectId);
        if (job.operation === 'rename' && (!native || ![job.expectedName, job.name].includes(native.name))) throw fail('Codex CLI 项目已被另外改名或移除，停止覆盖。');
        const threads = native ? [...await readAll(rpc, 'thread/list', { projectId: native.id, archived: false, sourceKinds: SOURCE_KINDS }),
          ...await readAll(rpc, 'thread/list', { projectId: native.id, archived: true, sourceKinds: SOURCE_KINDS })] : [];
        const ids = [...new Set(threads.map(t => t.id))];
        for (const threadId of ids) assertIdle((await rpc.request('thread/read', { threadId, includeTurns: true })).thread);
        await mkdir(backupDir, { recursive: true });
        try { await writeFile(path.join(backupDir, `${job.id}.json`), JSON.stringify({ job, before: native || null, threadIds: ids }, null, 2), { flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (job.operation === 'rename') {
          await rpc.request('project/update', { projectId: native.id, name: job.name });
          const verified = (await rpc.request('project/read', { projectId: native.id })).project;
          if (verified?.id !== native.id || verified.name !== job.name || verified.roots?.length !== 1
            || projectPathKey(verified.roots[0].path) !== projectPathKey(job.projectPath)) throw fail('Codex CLI 改名读回未通过。');
        } else if (job.operation === 'remove') {
          if (native) {
            for (const threadId of ids) await rpc.request('thread/metadata/update', { threadId, projectId: '' });
            await rpc.request('project/delete', { projectId: native.id });
          }
          const remaining = await readAll(rpc, 'project/list');
          if (remaining.some(p => p.id === job.nativeProjectId || p.roots?.some(r => projectPathKey(r.path) === projectPathKey(job.projectPath)))) throw fail('Codex CLI 项目移除读回未通过。');
          for (const threadId of ids) {
            const thread = (await rpc.request('thread/read', { threadId, includeTurns: false })).thread;
            if (thread?.id !== threadId || thread.projectId) throw fail('移除后聊天保留与解绑核验未通过。');
          }
        } else throw fail('未知 CLI 项目操作。');
        return { complete: true, nativeProjectId: native?.id || job.nativeProjectId,
          source: 'codex_app_server', checkedAt: new Date().toISOString(), threadIds: ids };
      });
    },
  };
}
