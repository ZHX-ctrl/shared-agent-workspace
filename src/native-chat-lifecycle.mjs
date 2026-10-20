import path from 'node:path';
import os from 'node:os';
import { realpath } from 'node:fs/promises';
import { JsonRpcClient } from './adapters/rpc.mjs';
import { resolveCli, subscriptionEnv } from './adapters/process.mjs';
import { CODEX_SERVER_ARGS } from './adapters/codex.mjs';
import { createClaudeChatLifecycle } from './claude-chat-lifecycle.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const fail = message => { throw new Error(message); };
const missing = (error, id) => error?.code === -32600 &&
  [`thread not found: ${id}`, `thread not loaded: ${id}`, `no rollout found for thread id ${id}`].includes(error.message);
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

function createCodexChatLifecycle({ Rpc = JsonRpcClient, resolve = resolveCli,
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
  return async function sync({ operation, sessions, executable, onProgress = async () => {}, beforeDelete, beforeApply, beforeTargets, desktopArchive, project }) {
    if (!['archive', 'unarchive', 'delete'].includes(operation)) fail('未知聊天同步操作。');
    if (sessions.some(item => item.agent !== 'codex')) fail('Codex 会话关联无效，未执行同步。');
    if (!sessions.length) return { operation, sessions: [], affected: [] };
    for (const item of sessions) {
      if (!UUID.test(item.sessionId) || !path.isAbsolute(item.cwd)) fail('原生会话关联无效，未执行同步。');
    }
    const cli = resolve('codex', { explicitPath: executable });
    if (!cli) fail('未找到官方 Codex 工具，聊天同步尚未完成。');
    const rpc = new Rpc(cli, CODEX_SERVER_ARGS, { cwd: sessions[0].cwd, env: subscriptionEnv('codex') });
    rpc.on('request', message => rpc.reject(message.id, 'Chat management cannot approve agent actions'));
    const targets = new Map();
    const absent = new Set();
    async function list(params) {
      const rows = []; const cursors = new Set(); let cursor;
      for (let page = 0; page < 100; page++) {
        const result = await rpc.request('thread/list', { limit: 100, sourceKinds: SOURCE_KINDS, ...params, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result?.data)) fail('Codex 会话列表格式异常。');
        rows.push(...result.data);
        if (result.nextCursor == null) return rows;
        if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor)) fail('Codex 会话分页异常。');
        cursor = result.nextCursor; cursors.add(cursor);
      }
      fail('Codex 会话检查超出范围，未确认同步。');
    }
    function idle(thread) {
      if (!['idle', 'notLoaded'].includes(thread?.status?.type)) fail('对应 Codex 聊天或子任务仍在运行，请先结束任务再操作。');
      if (thread?.turns?.some(turn => ['inProgress', 'in_progress', 'running'].includes(turn.status))) fail('对应 Codex 聊天还有未结束的轮次，请先在官方工具结束任务。');
    }
    async function confirmedAbsent(id) {
      // "not loaded" by itself is ambiguous. Require successful reads of both
      // persisted inventories, including app-server and spawned agent sources.
      // Do not filter by the saved cwd: a moved session must not be mistaken
      // for a deleted session merely because its former folder is now empty.
      return !(await list({ archived: false })).some(item => item.id === id)
        && !(await list({ archived: true })).some(item => item.id === id);
    }
    async function verifyAbsent(id) {
      if (!sessions.some(item => item.sessionId === id) && !targets.has(id)) return false;
      try { await rpc.request('thread/read', { threadId: id, includeTurns: false }); return false; }
      catch (error) { if (missing(error, id)) return confirmedAbsent(id); throw error; }
    }
    try {
      await rpc.request('initialize', { clientInfo: { name: 'shared_workspace_chat_management', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      rpc.notify('initialized');
      for (const session of sessions) {
        let thread;
        try { thread = (await rpc.request('thread/read', { threadId: session.sessionId, includeTurns: true }))?.thread; }
        catch (error) {
          if (operation === 'delete' && missing(error, session.sessionId) && await confirmedAbsent(session.sessionId, session.cwd)) { absent.add(session.sessionId); continue; }
          throw error;
        }
        if (thread?.id !== session.sessionId || typeof thread.cwd !== 'string' || key(await realpath(thread.cwd)) !== key(await realpath(session.cwd))) fail('原生聊天与工作台记录的文件夹不一致，已停止同步。');
        idle(thread);
        const projectRoot = key(await realpath(session.projectPath));
        const rootRelative = path.relative(projectRoot, key(await realpath(thread.cwd)));
        if (rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) fail('原生聊天不属于该项目。');
        targets.set(thread.id, { ...thread, rootId: session.sessionId });
        for (const archived of [false, true]) {
          for (const child of await list({ ancestorThreadId: thread.id, archived })) {
            if (!UUID.test(child.id) || typeof child.cwd !== 'string') fail('Codex 子任务记录无效。');
            const relative = path.relative(projectRoot, key(await realpath(child.cwd)));
            if (relative.startsWith('..') || path.isAbsolute(relative)) fail('该聊天含有其他文件夹的子任务，已停止自动同步。');
            idle(child);
            targets.set(child.id, { ...child, rootId: thread.id });
          }
        }
      }
      const guarded = new Map(sessions.map(session => [session.sessionId, session]));
      for (const target of targets.values()) guarded.set(target.id, { agent: 'codex', sessionId: target.id, cwd: target.cwd,
        projectPath: sessions.find(session => session.sessionId === target.rootId)?.projectPath });
      // Native descendants can also be explicitly resumed by a different
      // workbench chat. Check the complete family before either provider acts.
      const verifyTargets = () => beforeTargets?.({ operation, sessions: [...guarded.values()] });
      await verifyTargets();
      // A fresh read catches activity that began while checking other sessions.
      for (const target of targets.values()) idle((await rpc.request('thread/read', { threadId: target.id, includeTurns: true })).thread);
      // Preflight Desktop before either provider mutates. Preserve the exact
      // roots and descendants so an unsafe linked task cannot be skipped.
      const archivePlan = operation !== 'delete' && desktopArchive
        ? await desktopArchive.prepare({ operation, targets: [...targets.values()], sessions, project }) : null;
      // The other provider must pass its complete preflight before either side
      // mutates. Its apply is retryable; a later Codex failure remains pending.
      if (beforeApply) await beforeApply();
      await verifyTargets();
      for (const target of targets.values()) idle((await rpc.request('thread/read', { threadId: target.id, includeTurns: true })).thread);
      // A desktop-connected deletion goes through the desktop first so its own
      // app-server emits thread/deleted and invalidates its live catalog. This
      // hook runs only after all session/cwd/descendant checks have succeeded.
      const desktop = operation === 'delete' && beforeDelete ? await beforeDelete({ targets: [...targets.values()], sessions,
        alreadyAbsent: [...absent], verifyAbsent }) : archivePlan ? await desktopArchive.apply(archivePlan, { onProgress }) : undefined;
      if (archivePlan && (desktop?.status !== 'verified' || desktop.operation !== operation
          || !Array.isArray(desktop.sessions)
          || JSON.stringify([...desktop.sessions].sort()) !== JSON.stringify(sessions.map(s => s.sessionId).sort()))) {
        fail('Codex 桌面归档或恢复的核验回执不完整，工作台记录已保留。');
      }
      const affected = [...targets.keys()];
      for (const target of targets.values()) {
        const archivedRows = await list({ cwd: target.cwd, archived: true });
        let isArchived = archivedRows.some(row => row.id === target.id);
        if (operation !== 'delete' && !isArchived) {
          // The official desktop action may have moved the
          // rollout. Never inspect the preflight's now-stale file path.
          const current = (await rpc.request('thread/read', { threadId: target.id, includeTurns: false })).thread;
          if (current?.id !== target.id) fail('Codex 会话身份在同步后发生变化。');
          if (typeof current.path === 'string') {
            const relative = path.relative(key(path.join(codexHome, 'archived_sessions')), key(await realpath(current.path)));
            isArchived = Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && relative.endsWith(`-${target.id}.jsonl`));
          }
        }
        if (operation === 'delete') {
          // Deleting a parent also deletes its spawned descendants. Verify a
          // child before sending an extra request, so retries remain bounded.
          try { await rpc.request('thread/read', { threadId: target.id, includeTurns: false }); }
          catch (error) { if (missing(error, target.id) && await confirmedAbsent(target.id, target.cwd)) continue; throw error; }
          await rpc.request('thread/delete', { threadId: target.id });
        } else if ((operation === 'archive') !== isArchived) {
          await rpc.request(`thread/${operation}`, { threadId: target.id });
        }
        await onProgress({ agent: 'codex', sessionId: target.id, operation });
      }
      // Query both lists: read failures alone must not be mistaken for deletion.
      for (const cwd of new Set([...targets.values()].map(item => item.cwd))) {
        const active = new Set((await list({ cwd, archived: false })).map(item => item.id));
        const archived = new Set((await list({ cwd, archived: true })).map(item => item.id));
        for (const target of [...targets.values()].filter(item => item.cwd === cwd)) {
          if (operation === 'delete') {
            if (active.has(target.id) || archived.has(target.id)) fail('Codex 删除后的列表核对未通过。');
            try {
              await rpc.request('thread/read', { threadId: target.id, includeTurns: false });
              fail('Codex 删除后仍可读取这条会话，请重试同步。');
            } catch (error) { if (!missing(error, target.id)) throw error; }
          } else if (operation === 'archive') {
            if (active.has(target.id)) fail('Codex 归档后的读回核对未通过。');
            if (!archived.has(target.id)) {
              // Metadata-only sessions can be omitted from either inventory.
              // Verify the real persisted archived rollout, never infer success
              // from an empty list alone.
              const saved = (await rpc.request('thread/read', { threadId: target.id, includeTurns: false })).thread;
              if (saved?.id !== target.id || typeof saved.path !== 'string') fail('Codex 归档后的读回核对未通过。');
              const archivedRoot = key(path.join(codexHome, 'archived_sessions'));
              const relative = path.relative(archivedRoot, key(await realpath(saved.path)));
              if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith(`-${target.id}.jsonl`)) fail('Codex 归档后的读回核对未通过。');
            }
          } else {
            if (archived.has(target.id)) fail('Codex 恢复后的会话仍在归档列表。');
            if (!active.has(target.id)) {
              // The official active list omits metadata-only/empty chats even
              // after a successful unarchive. Verify the returned persisted
              // rollout in the official active-session directory in that case.
              const restored = (await rpc.request('thread/read', { threadId: target.id, includeTurns: false })).thread;
              if (restored?.id !== target.id || typeof restored.path !== 'string') fail('Codex 恢复后的记录无法核对。');
              const sessionsRoot = key(path.join(codexHome, 'sessions'));
              const relative = path.relative(sessionsRoot, key(await realpath(restored.path)));
              if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith(`-${target.id}.jsonl`)) fail('Codex 恢复后的记录未进入活动会话目录。');
            }
          }
        }
      }
      for (const id of absent) if (!await verifyAbsent(id)) fail('已删除的 Codex 会话在核验期间重新出现，工作台记录已保留。');
      return { operation, sessions: sessions.map(item => item.sessionId), affected, alreadyAbsent: [...absent], ...(desktop ? { desktop } : {}) };
    } finally { await rpc.close(); }
  };
}

export function createNativeChatLifecycle({ claudeLifecycle = createClaudeChatLifecycle(), ...codexOptions } = {}) {
  const syncCodex = createCodexChatLifecycle(codexOptions);
  return async function sync({ operation, sessions, onProgress = async () => {}, claudeDesktopDeletion, claudeDesktopArchive, beforeTargets, ...options }) {
    if (!['archive', 'unarchive', 'delete'].includes(operation)) fail('未知聊天同步操作。');
    if (!Array.isArray(sessions)) fail('原生会话关联无效，未执行同步。');
    for (const session of sessions) {
      if (!['codex', 'claude'].includes(session?.agent)) fail('此聊天关联了尚未接入管理的助手，未执行同步。');
      if (!UUID.test(session.sessionId) || typeof session.cwd !== 'string' || !path.isAbsolute(session.cwd)
        || typeof session.projectPath !== 'string' || !path.isAbsolute(session.projectPath)) fail('原生会话关联无效，未执行同步。');
    }
    if (!sessions.length) return { operation, sessions: [], affected: [], providers: {} };
    const codexSessions = sessions.filter(item => item.agent === 'codex');
    const claudeSessions = sessions.filter(item => item.agent === 'claude');
    const desktopPlan = operation === 'delete' && claudeSessions.length && claudeDesktopDeletion
      ? await claudeDesktopDeletion.prepare({ sessions: claudeSessions }) : null;
    const archivePlan = operation !== 'delete' && claudeSessions.length && claudeDesktopArchive
      ? await claudeDesktopArchive.prepare({ operation, sessions: claudeSessions }) : null;
    const plan = claudeSessions.length ? await claudeLifecycle.prepare({ operation, sessions: claudeSessions,
      ...(desktopPlan ? { allowIdleSessionIds: desktopPlan.allowIdleSessionIds } : {}),
      ...(archivePlan ? { desktopNativeSessionIds: archivePlan.desktopSessionIds, allowIdleSessionIds: archivePlan.allowIdleSessionIds } : {}) }) : null;
    const verifiedReceipt = (result, expected, provider) => {
      const ids = expected.map(item => item.sessionId).sort();
      if (!Array.isArray(result?.sessions) || JSON.stringify([...result.sessions].sort()) !== JSON.stringify(ids)) {
        fail(`${provider} 会话管理返回的核验结果不完整，工作台记录已保留。`);
      }
    };
    let claude;
    const applyClaude = async () => {
      if (plan) { claude = await claudeLifecycle.apply(plan, { onProgress,
        ...(desktopPlan ? { beforeDelete: () => claudeDesktopDeletion.apply(desktopPlan, { onProgress }) } : {}),
        ...(archivePlan ? { beforeDesktopArchive: () => claudeDesktopArchive.apply(archivePlan, { onProgress }) } : {}) });
        verifiedReceipt(claude, claudeSessions, 'Claude'); }
    };
    let codex;
    if (codexSessions.length) {
      codex = await syncCodex({ ...options, operation, sessions: codexSessions, onProgress, beforeApply: applyClaude,
        ...(beforeTargets ? { beforeTargets: data => beforeTargets({ ...data, sessions: [...data.sessions, ...claudeSessions] }) } : {}) });
      verifiedReceipt(codex, codexSessions, 'Codex');
    } else { if (beforeTargets) await beforeTargets({ operation, sessions: claudeSessions }); await applyClaude(); }
    const results = [codex, claude].filter(Boolean);
    return { operation, sessions: sessions.map(item => item.sessionId),
      affected: results.flatMap(result => result.affected || []),
      alreadyAbsent: results.flatMap(result => result.alreadyAbsent || []),
      providers: { ...(codex ? { codex } : {}), ...(claude ? { claude } : {}) },
      ...(codex?.desktop ? { desktop: codex.desktop } : {}) };
  };
}

export const syncNativeChats = createNativeChatLifecycle();
