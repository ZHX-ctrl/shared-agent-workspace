import { createDesktopCodexProjectRegistrar, openCodexThreadDeepLink } from './desktop-codex-projects.mjs';
import { desktopIsRunning } from './native-project-sync.mjs';
import { JsonRpcClient } from './adapters/rpc.mjs';
import { resolveCli, subscriptionEnv } from './adapters/process.mjs';
import { CODEX_SERVER_ARGS } from './adapters/codex.mjs';
import { projectPathKey } from './codex-projects.mjs';
import { assertIdle, readAll } from './cli-project-sync.mjs';

const allSources = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const key = projectPathKey;
const sameRoot = (p, root) => p?.roots?.length === 1 && key(p.roots[0].path) === key(root);

// Register through the official desktop URI and read its own completed mapping.
// Never write its cache, approve trust, restart it, or send a model prompt.
export function createDesktopSidebarSync({
  registrar = createDesktopCodexProjectRegistrar({ timeoutMs: 0 }),
  isRunning = desktopIsRunning, openThread = openCodexThreadDeepLink, Rpc = JsonRpcClient, resolve = resolveCli,
} = {}) {
  return {
    async sync(project, sessions, executable) {
      let registration = await registrar.readDesktopCodexProject({ projectPath: project.path });
      const previous = project.desktopCodex || {};
      const checkedAt = new Date().toISOString();
      if (!registration) {
        if (!await isRunning()) return { status: 'waiting_desktop', checkedAt,
          ...(previous.launchRequestedAt ? { launchRequestedAt: previous.launchRequestedAt } : {}) };
        try {
          registration = await registrar.ensureDesktopCodexProject({ projectPath: project.path,
            allowLaunch: !previous.launchRequestedAt });
        } catch (error) {
          if (error.code !== 'DESKTOP_REGISTRATION_PENDING') throw error;
          return { status: 'waiting_trust', launchRequestedAt: previous.launchRequestedAt || checkedAt, checkedAt };
        }
      }
      const cli = resolve('codex', { explicitPath: executable });
      if (!cli) throw new Error('未找到 Codex CLI，桌面项目已登记但聊天归属尚未核验。');
      const rpc = new Rpc(cli, CODEX_SERVER_ARGS, { cwd: project.path, env: subscriptionEnv('codex') });
      rpc.on('request', m => rpc.reject(m.id, 'Sidebar registration never approves agent actions'));
      try {
        await rpc.request('initialize', { clientInfo: { name: 'shared_workspace_sidebar', version: '1.0' }, capabilities: { experimentalApi: true } });
        rpc.notify('initialized');
        const target = (await rpc.request('project/read', { projectId: registration.nativeProjectId })).project;
        if (target?.id !== registration.nativeProjectId || !sameRoot(target, project.path)) throw new Error('桌面项目与工作台目录不一致，未变更聊天归属。');
        const oldId = project.nativeCodex?.nativeProjectId || project.nativeCodex?.projectId;
        const threads = [];
        for (const session of sessions.filter(s => s.agent === 'codex')) {
          const thread = (await rpc.request('thread/read', { threadId: session.sessionId, includeTurns: true })).thread;
          if (thread?.id !== session.sessionId || key(thread.cwd) !== key(session.cwd)
              || (thread.projectId && ![oldId, target.id].includes(thread.projectId))) throw new Error('聊天目录或所属项目已变化，停止自动移动。');
          assertIdle(thread); threads.push(thread);
        }
        for (const thread of threads) {
          if (thread.projectId !== target.id) await rpc.request('thread/metadata/update', { threadId: thread.id, projectId: target.id });
          const verified = (await rpc.request('thread/read', { threadId: thread.id, includeTurns: false })).thread;
          if (verified?.projectId !== target.id) throw new Error('聊天归属读回未通过。');
        }
        // The desktop may create its own native row for a CLI-only folder. Only
        // remove the exact former workbench-owned, now-empty registry row.
        if (oldId && oldId !== target.id) {
          const old = (await readAll(rpc, 'project/list')).find(p => p.id === oldId);
          if (sameRoot(old, project.path) && old.metadata?.['shared-agent-workspace.origin'] === 'local-workbench') {
            const remaining = [...await readAll(rpc, 'thread/list', { projectId: oldId, archived: false, sourceKinds: allSources }),
              ...await readAll(rpc, 'thread/list', { projectId: oldId, archived: true, sourceKinds: allSources })];
            if (!remaining.length) await rpc.request('project/delete', { projectId: oldId });
          }
        }
        const sessionIds = threads.map(t => t.id);
        const unseen = sessionIds.filter(id => !previous.sessionIds?.includes(id));
        const result = { projectId: registration.projectId, nativeProjectId: target.id, name: registration.name, checkedAt };
        // Other app-server processes do not invalidate the desktop's in-memory
        // thread catalog. Its official thread link loads the newly saved thread
        // and applies the native project mapping, without submitting any turn.
        if (unseen.length && !await isRunning()) return { ...result, status: 'waiting_desktop', sessionIds: previous.sessionIds || [] };
        for (const threadId of unseen) await openThread(threadId);
        return { ...result, status: 'registered', sessionIds };
      } finally { await rpc.close(); }
    },
  };
}
