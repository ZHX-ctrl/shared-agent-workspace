import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { Store } from './store.mjs';
import { buildContext } from './context.mjs';
import { validateScopes } from './coordination.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { recoverRun, verifyWorkerExit } from './recovery.mjs';
import { createPeerUpdates } from './peer-updates.mjs';
import { createQuotaRefresher } from './quota-refresh.mjs';
import { ensureDesktopCodexProject } from './desktop-codex-projects.mjs';
import { readComposerCatalog } from './composer-catalog.mjs';
import { listSelectableFolders, createSelectableFolder, validateSelectedFolder } from './folder-picker.mjs';
import { listProjectFiles, previewProjectFile, saveChatAttachment } from './workspace-files.mjs';
import { syncNativeChats } from './native-chat-lifecycle.mjs';
import { createDesktopDeletionSync } from './desktop-deletion.mjs';
import { createNativeProjectSync, LIVE_PROJECT_SYNC_MESSAGE } from './native-project-sync.mjs';
import { withinProjectRoot } from './project-location.mjs';
import { createCliProjectSync } from './cli-project-sync.mjs';
import { ensureCodexProject } from './codex-projects.mjs';
import { createDesktopSidebarSync } from './desktop-sidebar.mjs';
import { createClaudeDesktop } from './claude-desktop.mjs';
import { createClaudeDesktopDeletion } from './claude-desktop-deletion.mjs';
import { createClaudeDesktopArchive } from './claude-desktop-archive.mjs';
import { createDesktopArchiveSync } from './desktop-archive.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const ACTIVE = new Set(['queued', 'running', 'awaiting_approval', 'stopping', 'recovery_pending']);
const SUBSCRIPTION_AUTH = new Set(['chatgpt', 'claude.ai', 'claudeai', 'subscription']);
const MODEL_ID = /^[a-zA-Z0-9._:/@+-]{1,150}$/;
const now = () => new Date().toISOString();
const readableError = e => String(e?.message ?? e).slice(0, 4000);
const transientProjectSyncError = error => ['EBUSY', 'EPERM', 'EACCES', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'RPC_CLOSED'].includes(error?.code)
  || /timed? ?out|timeout|connection closed|连接中断|app.server.*exited/i.test(String(error?.message || ''));

function assertString(value, label, max = 64000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw Object.assign(new Error(`${label}不能为空，且不能超过 ${max} 个字符。`), { statusCode: 400 });
  }
  return value.trim();
}

async function readJson(req, limit = 128 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求内容过大。'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('请求必须是有效 JSON。'), { statusCode: 400 }); }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export async function createWorkspaceServer(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? path.join(ROOT, 'data'));
  let runtime = {};
  try { runtime = JSON.parse(await fs.readFile(path.join(dataDir, 'runtime.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`工作台运行时配置读取失败：${readableError(error)}`); }
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)
    || (runtime.codexExecutable !== undefined && (typeof runtime.codexExecutable !== 'string' || !runtime.codexExecutable.trim()))
    || (runtime.projectRoot !== undefined && (typeof runtime.projectRoot !== 'string' || !path.isAbsolute(runtime.projectRoot)))
    || (runtime.projectIntegration !== undefined && !['cli', 'desktop'].includes(runtime.projectIntegration))
    || (runtime.desktopProjectRegistration !== undefined && typeof runtime.desktopProjectRegistration !== 'boolean')
    || (runtime.claudeDesktopAutoOpen !== undefined && typeof runtime.claudeDesktopAutoOpen !== 'boolean')) {
    throw new Error('工作台运行时配置无效：codexExecutable 和 projectRoot 必须使用有效的本机绝对路径。');
  }
  const projectRoot = options.projectRoot ?? runtime.projectRoot
    ?? (process.platform === 'win32' && dataDir === path.join(ROOT, 'data') ? 'E:\\AI' : undefined);
  const cliMode = (options.projectIntegration ?? runtime.projectIntegration) === 'cli';
  const desktopProjectRegistration = cliMode && (options.desktopProjectRegistration ?? runtime.desktopProjectRegistration ?? false);
  const store = options.store ?? new Store(dataDir, { projectRoot });
  const releaseInstance = await acquireInstanceLock(dataDir);
  try {
    await store.init();
    for (const run of store.snapshot().runs.filter(run => run.status === 'recovery_pending')) {
      await recoverRun(store, run.id, { probeWorker: options.recoveryProbe });
    }
  } catch (error) { await releaseInstance(); throw error; }
  const providerState = new Map();
  const connections = new Set();
  const executions = new Map();
  const approvals = new Map();
  const sessionToken = randomBytes(32).toString('hex');
  let serial = Promise.resolve();
  let refreshing;
  let closed = false;
  let listeningPort;
  let adapterMap;
  let quotaRefresher;
  let codexExecutable = runtime.codexExecutable;
  const registerCodexProject = options.registerCodexProject ?? (options.adapters ? null : cliMode ? ensureCodexProject : ensureDesktopCodexProject);
  const synchronizeChats = options.syncNativeChats ?? syncNativeChats;
  const activeChatSyncs = new Set();
  const projectSynchronizer = options.projectSynchronizer ?? (cliMode ? createCliProjectSync({ backupDir: path.join(dataDir, 'project-sync-receipts') })
    : createNativeProjectSync({ requireLive: true, backupDir: path.join(dataDir, 'project-sync-receipts') }));
  let projectSyncTick;
  let sidebarSyncTick;
  const sidebarSynchronizer = desktopProjectRegistration ? (options.sidebarSynchronizer ?? createDesktopSidebarSync()) : null;
  const desktopDeletion = options.desktopDeletion ?? (desktopProjectRegistration && !options.adapters && process.platform === 'win32' ? createDesktopDeletionSync() : null);
  const claudeDesktop = options.claudeDesktop === undefined
    ? (!options.adapters && process.platform === 'win32' && process.arch === 'x64' ? createClaudeDesktop({ projectRoot: store.projectRoot }) : null)
    : options.claudeDesktop;
  const claudeDesktopAutoOpen = Boolean(claudeDesktop && (options.claudeDesktopAutoOpen ?? runtime.claudeDesktopAutoOpen ?? true));
  const claudeDesktopDeletion = options.claudeDesktopDeletion === undefined
    ? (claudeDesktop && !options.adapters && process.platform === 'win32' ? createClaudeDesktopDeletion() : null)
    : options.claudeDesktopDeletion;
  const desktopArchive = options.desktopArchive === undefined
    ? (desktopProjectRegistration && !options.adapters && process.platform === 'win32' ? createDesktopArchiveSync() : null)
    : options.desktopArchive;
  const claudeDesktopArchive = options.claudeDesktopArchive === undefined
    ? (claudeDesktop && !options.adapters && process.platform === 'win32' ? createClaudeDesktopArchive() : null)
    : options.claudeDesktopArchive;
  const activeDesktopOpens = new Set();

  function serialMutation(fn) {
    const result = serial.then(() => {
      if (closed) throw Object.assign(new Error('工作台正在关闭，请重新打开后再操作。'), { statusCode: 503 });
      return fn();
    });
    serial = result.catch(() => {});
    return result;
  }

  function snapshot() {
    const saved = store.snapshot();
    for (const project of saved.projects) project.desktopClaudeOpening = activeDesktopOpens.has(project.id);
    for (const project of saved.projects) for (const chat of project.chats) {
      // Summarize the same complete session mapping used by mutations, including
      // recovered and superseded sessions, instead of guessing from visible runs.
      try {
        const sessions = store.nativeChatSessions(project.id, chat.id);
        chat.desktopClaudeOpening = activeDesktopOpens.has(chat.id);
        chat.claudeDesktopSessions = claudeDesktopSessions(project, chat, saved.runs, sessions);
        chat.nativeSync = { codexSessionCount: sessions.filter(s => s.agent === 'codex').length,
          claudeSessionCount: sessions.filter(s => s.agent === 'claude').length,
          totalSessionCount: sessions.length,
          unsupportedProviders: [...new Set(sessions.filter(s => !['codex', 'claude'].includes(s.agent)).map(s => s.agent))],
          inProgress: activeChatSyncs.has(chat.id) };
      } catch (error) { chat.nativeSync = { error: readableError(error), inProgress: false }; }
    }
    return {
      ...saved,
      projectLocation: { root: store.projectRoot, restricted: store.restrictProjectRoot,
        pendingMigration: saved.projects.filter(p => store.restrictProjectRoot && !p.removed && !withinProjectRoot(store.projectRoot, p.path))
          .map(p => ({ id: p.id, name: p.name, path: p.path })) },
      providers: ['codex', 'claude'].map(id => providerState.get(id) ?? {
        id, name: id === 'codex' ? 'Codex' : 'Claude Code', installed: false,
        authenticated: false, authMode: 'unknown', models: [], quota: [], updatedAt: null,
        error: '尚未检查连接。',
      }),
      approvals: [...approvals.values()].map(({ resolve, ...a }) => a),
      sync: {
        nativeBidirectionalSupported: false,
        projectIntegration: cliMode ? 'cli' : 'desktop',
        desktopProjectRegistration,
        desktopDeletionSupported: Boolean(desktopDeletion),
        claudeDesktopDeletionSupported: Boolean(claudeDesktopDeletion),
        desktopArchiveSupported: Boolean(desktopArchive),
        claudeDesktopArchiveSupported: Boolean(claudeDesktopArchive),
        claudeDesktop: { supported: Boolean(claudeDesktop), autoOpen: claudeDesktopAutoOpen },
        claudeChatManagement: { deletion: claudeDesktopDeletion ? 'desktop-and-local-sdk' : 'local-sdk', archive: claudeDesktopArchive ? 'desktop-native-or-local-vault' : 'local-vault' },
        cliExecutable: cliMode ? codexExecutable : undefined,
        liveProjectManagementSupported: cliMode || Boolean(options.projectSynchronizer),
        message: cliMode ? `工作台通过本机 Codex CLI 独立运行。${desktopProjectRegistration ? '新项目会自动添加到已打开的 Codex 桌面项目栏；首次目录信任由官方窗口确认，确认后自动核验聊天归属。桌面未打开时等待登记，不影响 CLI 聊天。' : '项目改名、移除通过 CLI 完成；聊天归档、恢复、删除同步对应会话。'}Claude Code 使用独立订阅，共享项目文件和工作台记录。`
          : '两位助手共用本窗口的项目记录与同一本机目录；切换时提供相关历史和进度。聊天正文保存在工作台；归档、恢复和删除作用于已关联的本机会话。已接入 Claude 桌面的聊天同步官方归档状态，未登记桌面的聊天使用可恢复的本地暂存。',
      },
      limitations: [
        '目录归属是任务协调措施，不能替代操作系统隔离；需要审批的动作仍由你决定。',
        '额度按官方账户窗口显示。页面连接时约每分钟只读刷新 Codex 和 Claude；执行中接收官方限制事件。读取失败保留上次读数并标注，未知数值不作估计。',
      ],
    };
  }

  function publish() {
    if (closed) return;
    const event = `data: ${JSON.stringify({ type: 'state', state: snapshot() })}\n\n`;
    for (const res of connections) {
      if (res.destroyed || res.writableLength > 2 * 1024 * 1024) {
        res.destroy(); connections.delete(res); continue;
      }
      res.write(event);
    }
  }

  function onProviderUpdate(update) {
    if (!update || !['codex', 'claude'].includes(update.id)) return;
    providerState.set(update.id, { ...providerState.get(update.id), ...update });
    publish();
    quotaRefresher?.update();
  }

  try {
    if (options.adapters) adapterMap = options.adapters;
    else {
      adapterMap = (await import('./adapters/index.mjs')).createAdapters({ onProviderUpdate, codexExecutable: runtime.codexExecutable });
      codexExecutable = runtime.codexExecutable;
    }
  } catch (error) { await releaseInstance(); throw error; }

  const quotaRefreshers = ['codex', 'claude'].map(id => createQuotaRefresher({
    hasViewers: () => !closed && !refreshing && connections.size > 0,
    getProvider: () => typeof adapterMap[id]?.refreshQuota === 'function' ? providerState.get(id) : null,
    authMode: id === 'codex' ? 'chatgpt' : 'claude.ai',
    intervalMs: options.quotaRefreshIntervalMs ?? 60_000,
    refresh: async () => {
      let value;
      try { value = await adapterMap[id].refreshQuota(); }
      catch (error) { value = { ...providerState.get(id), quotaCheckedAt: now(), quotaError: readableError(error) }; }
      if (!closed) onProviderUpdate({ ...value, id });
      return value;
    },
  }));
  quotaRefresher = { update: () => { for (const refresher of quotaRefreshers) refresher.update(); },
    close: () => Promise.all(quotaRefreshers.map(refresher => refresher.close())) };

  const peerUpdates = createPeerUpdates({ store, adapters: adapterMap,
    getExecution: id => executions.get(id), isClosing: () => closed, publish });

  async function refreshProviders() {
    if (closed) return snapshot().providers;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      await Promise.all(['codex', 'claude'].map(async id => {
        try {
          const value = await adapterMap[id].inspect();
          onProviderUpdate({ ...value, id });
        } catch (error) {
          onProviderUpdate({ id, name: id === 'codex' ? 'Codex' : 'Claude Code',
            installed: providerState.get(id)?.installed ?? false, authenticated: false,
            models: [], authMode: 'unknown', updatedAt: now(), connectionCheckedAt: now(),
            quotaCheckedAt: now(), quotaError: readableError(error), error: readableError(error) });
        }
      }));
      return snapshot().providers;
    })();
    try { return await refreshing; } finally { refreshing = null; quotaRefresher.update(); }
  }

  async function preflight(projectId, tasks) {
    const project = store.getProject(projectId);
    if (!project) throw Object.assign(new Error('没有找到这个项目。'), { statusCode: 404 });
    if (project.projectSync && project.projectSync.status !== 'completed') throw new Error('项目有未完成的改名或移除同步，请先完成同步，再运行任务。');
    if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 4) {
      throw Object.assign(new Error('每次需要 1–4 个任务。'), { statusCode: 400 });
    }
    const clean = tasks.map(task => {
      if (!task || typeof task !== 'object') throw new Error('任务格式无效。');
      const chatId = task.chatId === undefined ? project.defaultChatId : task.chatId;
      const chat = store.getChat(projectId, chatId);
      if (!chat) throw Object.assign(new Error('没有找到这个项目中的聊天。'), { statusCode: 404 });
      if (chat.lifecycle?.status === 'pending') throw Object.assign(new Error('此聊天还有未完成的同步操作，请先重试同步。'), { statusCode: 409 });
      if (chat.archived) throw Object.assign(new Error('请先恢复已归档的聊天，再继续发送消息。'), { statusCode: 409 });
      if (!['codex', 'claude'].includes(task.agent)) throw new Error('请选择 Codex 或 Claude Code。');
      assertString(task.message, '任务');
      const message = task.message;
      const provider = providerState.get(task.agent);
      if (!provider?.installed) throw new Error(`${task.agent === 'codex' ? 'Codex' : 'Claude Code'} 工具尚未找到。请先安装并使用官方工具登录。`);
      if (!provider.authenticated) throw new Error(`${provider.name} 尚未通过官方工具登录订阅账户。`);
      if (!SUBSCRIPTION_AUTH.has(provider.authMode)) {
        throw new Error(`${provider.name} 当前未确认使用订阅登录，已停止派发，避免额外 API 计费。`);
      }
      let model = task.model || undefined;
      let effort = task.effort || undefined;
      if (model && (!MODEL_ID.test(model) || !(provider.models ?? []).some(m => m.id === model))) {
        throw new Error('所选模型不在当前工具返回的可用列表中，请刷新后重选。');
      }
      const selected = (provider.models ?? []).find(m => m.id === model);
      const availableEfforts = (selected?.efforts ?? []).map(v => typeof v === 'string' ? v : v.id ?? v.reasoningEffort);
      if (effort && (!selected || !availableEfforts.includes(effort))) {
        throw new Error('所选思考强度未被此模型确认支持。');
      }
      if (task.planMode && task.agent !== 'codex') throw new Error('计划模式目前只接通 Codex。');
      const inputs = Array.isArray(task.inputs) ? task.inputs : [];
      if (inputs.length > 20) throw new Error('附件或技能数量过多。');
      for (const input of inputs) {
        if (!input || !['skill', 'mention'].includes(input.type) || typeof input.name !== 'string' || typeof input.path !== 'string' || input.name.length > 200 || input.path.length > 2000) throw new Error('技能或应用引用无效。');
      }
      if (inputs.length && task.agent !== 'codex') throw new Error('技能或应用附件目前只接通 Codex。');
      return { agent: task.agent, message, model, effort, scope: task.scope || '', chatId, planMode: Boolean(task.planMode), inputs, contextVersion: chat.contextVersion || 0 };
    });
    const activeRuns = store.snapshot().runs.filter(r => r.projectId === projectId && ACTIVE.has(r.status));
    let normalized;
    if (clean.length === 1 && !clean[0].scope) {
      if (activeRuns.length) throw new Error('项目已有任务运行或尚待确认退出，请先完成、停止或检查退出状态后再接力。');
      const actualPath = await fs.realpath(project.path);
      if (!(await fs.stat(actualPath)).isDirectory()) throw new Error('项目路径不是目录。');
      normalized = [{ ...clean[0], scopePath: actualPath }];
    } else {
      normalized = await validateScopes(project.path, clean, activeRuns);
    }
    return { project, tasks: normalized };
  }

  async function registerProject(projectId) {
    const project = store.getProject(projectId);
    if (!project) throw Object.assign(new Error('没有找到这个项目。'), { statusCode: 404 });
    if (project.projectSync && project.projectSync.status !== 'completed') throw new Error('项目有未完成的同步，请先完成后再登记。');
    if (!registerCodexProject) throw new Error('当前测试执行器未配置 Codex 项目登记接口。');
    await store.setNativeCodexProject(projectId, { status: 'pending' });
    publish();
    try {
      const registered = await registerCodexProject({ projectPath: project.path, name: project.name, executable: codexExecutable });
      if (!['registered', 'already_registered'].includes(registered.status) || !registered.projectId) throw new Error('未能确认 Codex 项目登记结果。');
      await store.setNativeCodexProject(projectId, { status: 'registered', projectId: registered.projectId,
        source: registered.source,
        ...(registered.nativeProjectId ? { nativeProjectId: registered.nativeProjectId } : {}),
        name: registered.name ?? project.name, updatedAt: registered.checkedAt ?? now() });
    } catch (error) {
      // Folder and workbench history remain usable. Retrying first checks the
      // desktop's exact registered path; never create a second native RPC row.
      await store.setNativeCodexProject(projectId, { status: 'failed', error: readableError(error) });
    }
    publish();
    return store.getProject(projectId);
  }

  function claudeDesktopSessions(project, chat, runs = store.snapshot().runs, sessions = store.nativeChatSessions(project.id, chat.id)) {
    // Only the latest native session for each current scope/context may be
    // continued. Recovered/edited-away history must not select the wrong UUID.
    const mapped = sessions.filter(s => s.agent === 'claude');
    const scopes = new Set(), result = [];
    for (const run of runs.filter(r => r.projectId === project.id && r.chatId === chat.id
        && r.agent === 'claude' && r.sessionId && (r.contextVersion || 0) === (chat.contextVersion || 0) && !r.superseded)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
      const scope = run.scope || '';
      if (scopes.has(scope)) continue;
      scopes.add(scope);
      const session = mapped.find(s => s.sessionId === run.sessionId);
      if (session && !result.some(s => s.sessionId === session.sessionId)) result.push({ ...session, scope, lastUsedAt: run.createdAt });
    }
    return result;
  }

  async function openClaudeDesktop(projectId, chatId, sessionId) {
    const project = store.getProject(projectId);
    if (!project || project.removed) throw Object.assign(new Error('项目已移除或不存在。'), { statusCode: 404 });
    if (!claudeDesktop) throw new Error('当前环境没有启用 Claude 桌面连接，CLI 聊天仍可使用。');
    if (projectSyncPending(project)) throw new Error('项目还有未完成的改名或移除操作，请先完成。');
    let session;
    if (chatId) {
      const chat = store.getChat(projectId, chatId);
      if (!chat) throw Object.assign(new Error('没有找到这条聊天。'), { statusCode: 404 });
      if (chat.archived || chat.lifecycle?.status === 'pending') throw new Error('请先恢复聊天并完成待处理的同步，再到 Claude 桌面继续。');
      if (store.snapshot().runs.some(r => r.projectId === projectId && ACTIVE.has(r.status))) {
        throw Object.assign(new Error('此项目还有任务在运行或待确认退出，请等任务结束后再到 Claude 桌面继续。'), { statusCode: 409 });
      }
      const sessions = claudeDesktopSessions(project, chat);
      session = sessionId ? sessions.find(s => s.sessionId === sessionId) : sessions.length === 1 ? sessions[0] : null;
      if (!session) throw new Error(sessions.length ? '请选择这条聊天对应的 Claude 会话，不能打开其他聊天的会话。' : '这条聊天还没有 Claude 会话；先在工作台选择 Claude Code 发送一条消息。');
    }
    const operationKey = chatId || projectId;
    activeDesktopOpens.add(operationKey);
    try {
      await store.setClaudeDesktop(projectId, chatId, { status: 'pending', ...(session ? { sessionId: session.sessionId } : {}) });
      publish();
      const receipt = await claudeDesktop.open({ projectPath: project.path, cwd: session?.cwd || project.path, ...(session ? { sessionId: session.sessionId } : {}) });
      if (receipt?.status !== 'request_sent') throw new Error('未收到 Claude 官方桌面打开回执。');
      await store.setClaudeDesktop(projectId, chatId, receipt);
      return receipt;
    } catch (error) {
      const receipt = { status: 'failed', error: readableError(error) };
      await store.setClaudeDesktop(projectId, chatId, receipt);
      return receipt;
    } finally { activeDesktopOpens.delete(operationKey); publish(); }
  }

  function projectSyncPending(project) { return project.projectSync && project.projectSync.status !== 'completed'; }

  async function processSidebarSyncs() {
    if (closed || !sidebarSynchronizer || sidebarSyncTick) return sidebarSyncTick;
    sidebarSyncTick = serialMutation(async () => {
      const state = store.snapshot();
      for (const project of state.projects) {
        if (project.removed || project.kind === 'scratch' || project.nativeCodex?.status !== 'registered'
            || (project.desktopCodex?.nextRetryAt && project.desktopCodex.nextRetryAt > Date.now())
            || (project.projectSync && project.projectSync.status !== 'completed')
            || state.runs.some(r => r.projectId === project.id && ACTIVE.has(r.status))) continue;
        const sessions = project.chats.flatMap(c => store.nativeChatSessions(project.id, c.id));
        const ids = [...new Set(sessions.filter(s => s.agent === 'codex').map(s => s.sessionId))].sort();
        if (project.desktopCodex?.status === 'registered'
            && JSON.stringify([...(project.desktopCodex.sessionIds || [])].sort()) === JSON.stringify(ids)) continue;
        try {
          const result = await sidebarSynchronizer.sync(project, sessions, codexExecutable);
          await store.setDesktopCodexProject(project.id, result);
        } catch (error) {
          await store.setDesktopCodexProject(project.id, { ...project.desktopCodex, status: 'failed', error: readableError(error), checkedAt: now(), nextRetryAt: Date.now() + 60000 });
        }
        publish();
        // At most one official folder prompt is opened per tick.
        break;
      }
    }).finally(() => { sidebarSyncTick = null; });
    return sidebarSyncTick;
  }

  async function processProjectSyncs() {
    if (closed || projectSyncTick) return projectSyncTick;
    if (!store.snapshot().projects.some(p => p.projectSync?.status === 'pending')) return;
    projectSyncTick = serialMutation(async () => {
      for (const project of store.snapshot().projects.filter(p => p.projectSync?.status === 'pending')) {
        const job = project.projectSync;
        if (job.nextRetryAt && job.nextRetryAt > Date.now()) continue;
        try {
          if (store.snapshot().runs.some(run => run.projectId === project.id && ACTIVE.has(run.status))) continue;
          let desktop;
          if (desktopDeletion && job.operation === 'remove') {
            desktop = await desktopDeletion.removeProject(project);
            if (desktop.waiting) {
              if (job.phase !== 'waiting_desktop') { await store.setProjectSync(project.id, { ...job, phase: 'waiting_desktop' }); publish(); }
              continue;
            }
          }
          const receipt = await projectSynchronizer.apply(project, job, codexExecutable);
          if (receipt?.waiting) continue;
          if (!receipt?.complete) throw new Error('未能核验 Codex 项目同步结果。');
          await store.completeProjectSync(project.id, job.id, { ...receipt, ...(desktop ? { desktop } : {}) });
          publish();
        } catch (error) {
          const retries = (job.retryCount || 0) + 1;
          const retry = retries <= 3 && transientProjectSyncError(error);
          await store.setProjectSync(project.id, { ...job, status: retry ? 'pending' : 'failed', error: readableError(error),
            retryCount: retries, phase: error.code === 'LIVE_PROJECT_SYNC_UNAVAILABLE' ? 'live_unavailable' : retry ? 'retry_wait' : 'failed', nextRetryAt: retry ? Date.now() + 2000 * (2 ** (retries - 1)) : undefined });
          publish();
        }
      }
    }).finally(() => { projectSyncTick = null; });
    return projectSyncTick;
  }

  async function changeProject(projectId, body) {
    const project = store.getProject(projectId);
    if (project.kind === 'scratch') throw new Error('无项目聊天不使用项目改名或移除。');
    if (store.snapshot().runs.some(run => run.projectId === projectId && ACTIVE.has(run.status))) throw new Error('项目中仍有任务，请结束后再修改。');
    if (!cliMode && !options.projectSynchronizer) throw Object.assign(new Error(LIVE_PROJECT_SYNC_MESSAGE), { statusCode: 503 });
    if (body.retry === true && Object.keys(body).length === 1) {
      if (!project.projectSync || project.projectSync.status === 'completed') throw new Error('没有待重试的项目同步。');
      return store.setProjectSync(projectId, { ...project.projectSync, status: 'pending', phase: 'checking', error: undefined, retryCount: 0, nextRetryAt: undefined });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['name', 'removed', 'confirm'].includes(key))
      || (body.name !== undefined && body.removed !== undefined)) throw new Error('每次只能改名或移除一个项目。');
    if (project.projectSync && project.projectSync.status !== 'completed') throw new Error('已有项目同步未完成，请先重试同步。');
    let patch;
    if (body.removed === true && body.confirm === true) patch = { removed: true };
    else if (typeof body.name === 'string') patch = { name: assertString(body.name, '项目名称', 80) };
    else throw new Error('请提供项目名称或确认移除项目。');
    if (patch.name === project.name) return project;
    const job = await projectSynchronizer.prepare(project, patch, codexExecutable);
    return store.setProjectSync(projectId, job);
  }

  function providerSession(projectId, task) {
    return store.snapshot().runs.filter(r => r.projectId === projectId && r.chatId === task.chatId && r.agent === task.agent &&
      (r.scope || '') === (task.scope || '') && (r.contextVersion || 0) === (task.contextVersion || 0) && r.sessionId && !ACTIVE.has(r.status))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]?.sessionId;
  }

  async function queueTasks(projectId, requested) {
    return serialMutation(async () => {
      if (closed) throw Object.assign(new Error('工作台正在关闭，请重新打开后再派发任务。'), { statusCode: 503 });
      const { project, tasks } = await preflight(projectId, requested);
      // A desktop handoff uses the original session, not a fork. Never resume
      // it in the workbench while another native window still owns it.
      if (claudeDesktop && !requested[0]?.editMessageId) for (const task of tasks.filter(t => t.agent === 'claude')) {
        const sessionId = providerSession(projectId, task);
        if (sessionId) await claudeDesktop.assertAvailable({ projectPath: project.path, cwd: task.scopePath, sessionId });
      }
      if (requested[0]?.editMessageId) {
        if (tasks.length !== 1) throw new Error('只能单独编辑最后一轮。');
        const edited = await store.supersedeLastTurn(projectId, tasks[0].chatId, requested[0].editMessageId);
        tasks[0].contextVersion = edited.contextVersion;
      }
      const runs = [];
      for (const task of tasks) {
        const conversation = store.getChat(projectId, task.chatId);
        if (conversation.title === '新对话' && !project.messages.some(item => item.chatId === task.chatId && item.role === 'user')) {
          await store.updateChat(projectId, task.chatId, { title: task.message.replace(/\s+/g, ' ').slice(0, 40).trim() });
        }
        const run = await store.createRun({ ...task, projectId, sessionId: providerSession(projectId, task) });
        await store.appendMessage(projectId, { role: 'user', text: task.message, runId: run.id, agent: task.agent, chatId: task.chatId });
        await store.appendRunEvent(run.id, { type: 'status', status: 'queued' });
        runs.push(run);
      }
      publish();
      for (const run of runs) {
        const controller = new AbortController();
        const execution = { controller, promise: null, controlReady: false };
        executions.set(run.id, execution);
        execution.promise = execute(project.id, run, controller).catch(async error => {
          const current = store.getRun(run.id);
          const uncertain = Boolean(current?.workerLifecycle);
          await store.updateRun(run.id, uncertain
            ? { status: 'recovery_pending', error: readableError(error), recoveryDetectedAt: now(),
              interruptionReason: '运行收尾未能完成记录；尚未确认进程退出，继续保留工作范围占用。' }
            : { status: 'failed', error: readableError(error), endedAt: now() });
          publish();
        }).finally(() => executions.delete(run.id));
      }
      return runs;
    });
  }

  async function requestApproval(run, controller, request) {
    if (controller.signal.aborted) return Promise.resolve('deny');
    await store.appendRunEvent(run.id, { type: 'approval_requested', kind: request.kind,
      title: request.title, details: request.details, canApprove: request.canApprove !== false });
    if (controller.signal.aborted) return 'deny';
    return new Promise(resolve => {
      const id = randomUUID();
      let settled = false;
      function settle(decision) {
        if (settled) return;
        settled = true; approvals.delete(id);
        controller.signal.removeEventListener('abort', aborted);
        void (async () => {
          try {
            await store.appendRunEvent(run.id, { type: 'approval_decision', approvalId: id, decision });
            const current = store.getRun(run.id);
            if (current && current.status === 'awaiting_approval') {
              await store.updateRun(run.id, { status: controller.signal.aborted ? 'stopping' : 'running' });
            }
            resolve(controller.signal.aborted ? 'deny' : decision);
          } catch (error) { controller.abort(error); resolve('deny'); }
          publish();
        })();
        publish();
      }
      function aborted() { settle('deny'); }
      approvals.set(id, { id, runId: run.id, kind: request.kind ?? 'tool',
        title: String(request.title ?? '助手请求操作许可').slice(0, 300),
        details: request.details ?? request.request ?? {}, canApprove: request.canApprove !== false,
        createdAt: now(), resolve: settle });
      controller.signal.addEventListener('abort', aborted, { once: true });
      void store.updateRun(run.id, { status: 'awaiting_approval' }).then(publish);
      publish();
    });
  }

  async function execute(projectId, run, controller) {
    let text = '';
    let writes = Promise.resolve();
    let writeError;
    let workerLifecycle;
    const messageId = randomUUID();
    const project = store.getProject(projectId);
    const persistEvent = operation => {
      writes = writes.then(operation).then(publish).catch(error => {
        writeError ??= error;
        controller.abort(new Error('对话记录无法保存，已请求停止执行。'));
      });
    };
    async function finishRun(status, error, result = {}) {
      const fields = { ...(result.sessionId ? { sessionId: result.sessionId } : {}), error };
      if (workerLifecycle) {
        const exit = await verifyWorkerExit({ ...run, workerLifecycle }, { probeWorker: options.recoveryProbe });
        if (!exit.verified) {
          await store.updateRun(run.id, { ...fields, status: 'recovery_pending', recoveryFrom: 'running',
            recoveryDetectedAt: now(), reportedOutcome: { status, error }, interruptionReason: exit.reason });
          await store.appendRunEvent(run.id, { type: 'status', status: 'recovery_pending', reportedOutcome: { status, error } });
          return 'recovery_pending';
        }
        await store.appendRunEvent(run.id, { type: 'worker_exit_verified', evidence: exit.evidence });
        fields.workerExitVerifiedAt = exit.evidence.observedAt;
        fields.workerExitEvidence = exit.evidence;
      }
      await store.updateRun(run.id, { ...fields, status, endedAt: now() });
      await store.appendRunEvent(run.id, { type: 'status', status, error,
        outcomeVerified: false, note: '运行终态仅表示本轮执行结束，不证明用户目标已完成。' });
      return status;
    }
    try {
      const context = await buildContext({ project, run,
        runs: store.snapshot().runs.filter(previous => previous.projectId === projectId && !previous.superseded) });
      if (store.addCheckpoint && context.checkpoint) await store.addCheckpoint(projectId, context.checkpoint);
      if (controller.signal.aborted) {
        await store.updateRun(run.id, { status: 'cancelled', endedAt: now() }); publish(); return;
      }
      // Save the unique worker identity before spawning. After a crash, only an
      // OS probe of this exact job may release the claimed scope.
      workerLifecycle = process.platform === 'win32' && !options.adapters
        ? { kind: 'windows-job-v1', jobName: `Local\\SharedAgentWorkspace-${run.id}` } : undefined;
      await store.updateRun(run.id, { status: 'running', startedAt: now(), checkpoint: context.checkpoint,
        ...(workerLifecycle ? { workerLifecycle } : {}) });
      await store.appendRunEvent(run.id, { type: 'status', status: 'running' });
      publish();
      const cwd = run.scope ? path.resolve(project.path, run.scope) : project.path;
      const result = await adapterMap[run.agent].run({
        ...(cliMode && run.agent === 'codex' && project.nativeCodex?.status === 'registered' ? {
          nativeProjectId: project.nativeCodex.nativeProjectId || project.nativeCodex.projectId,
          chatTitle: store.getChat(projectId, run.chatId)?.title,
        } : {}),
        ...run, workerLifecycle, runId: run.id, cwd, prompt: context.prompt,
        userMessage: context.userMessage, backgroundInstructions: context.backgroundInstructions, signal: controller.signal,
        onApproval: request => requestApproval(run, controller, request),
        onEvent: event => {
          if (!event || typeof event.type !== 'string') return;
          if (event.type === 'control_ready' && event.capability === 'peer_updates') {
            persistEvent(async () => {
              const execution = executions.get(run.id);
              if (execution) execution.controlReady = true;
              await peerUpdates.flush(run.id);
            });
            return;
          }
          if (event.type === 'peer_update') {
            persistEvent(() => peerUpdates.recordDelivery(run.id, event));
            return;
          }
          if (event.type === 'tool' && ['reasoning', 'agentMessage', 'userMessage'].includes(event.item?.type)) return;
          if (['session', 'usage', 'quota', 'tool', 'error'].includes(event.type)) {
            persistEvent(() => store.appendRunEvent(run.id, event));
          }
          if (event.type === 'text_delta' || event.type === 'text') {
            text = event.type === 'text_delta' ? text + String(event.text ?? '') : String(event.text ?? '');
            const captured = text;
            persistEvent(() => store.upsertMessage(projectId, {
              id: messageId, role: 'assistant', agent: run.agent, runId: run.id, chatId: run.chatId, text: captured,
            }));
          } else if (event.type === 'session') {
            persistEvent(() => store.updateRun(run.id, { sessionId: event.sessionId }));
          } else if (event.type === 'usage') {
            persistEvent(() => store.updateRun(run.id, { usage: event.usage, usageUpdatedAt: now() }));
          } else if (event.type === 'quota') {
            onProviderUpdate({ id: run.agent, quota: event.quota, updatedAt: now(),
              quotaUpdatedAt: event.quotaUpdatedAt ?? now(), quotaCheckedAt: event.quotaCheckedAt ?? now(), quotaError: event.quotaError ?? null });
          } else if (event.type === 'tool') {
            persistEvent(() => store.updateRun(run.id, { lastTool: event, toolUpdatedAt: now() }));
          } else if (event.type === 'error') {
            persistEvent(() => store.updateRun(run.id, { error: String(event.message ?? event.error ?? '执行器错误') }));
          }
        },
      });
      await writes;
      if (writeError) throw writeError;
      const status = ['completed', 'failed', 'cancelled', 'quota_exhausted'].includes(result?.status) ? result.status : 'failed';
      const savedStatus = await finishRun(status, result?.error ?? (status === 'failed' ? '执行器没有报告成功完成。' : null), result);
      if (savedStatus === 'quota_exhausted') {
        await store.appendMessage(projectId, { role: 'system', runId: run.id, chatId: run.chatId,
          text: '当前助手报告额度不足。已有对话和文件进度保留；可以选择另一位已登录的助手继续。没有自动启动其他模型。' });
      }
    } catch (error) {
      await writes;
      await finishRun(controller.signal.aborted && !writeError ? 'cancelled' : 'failed', readableError(writeError ?? error));
    } finally {
      for (const approval of [...approvals.values()]) if (approval.runId === run.id) approval.resolve('deny');
      try {
        await peerUpdates.finishTarget(run.id);
        await peerUpdates.notifyCompleted(run.id);
      } catch {
        // Coordination failures must not rewrite this worker's independently
        // saved outcome or turn a verified exit back into an unknown lifecycle.
        await store.updateRun(run.id, { coordinationError: '协作通知未完成；请从共享运行索引查看最新进度。原任务结果不变。' }).catch(() => {});
      }
      publish();
    }
  }

  async function stopRun(id) {
    const run = store.getRun(id);
    if (!run) throw Object.assign(new Error('任务不存在。'), { statusCode: 404 });
    if (run.status === 'recovery_pending') throw Object.assign(new Error('旧任务尚待确认退出，请使用“检查退出状态”；不能直接释放目录。'), { statusCode: 409 });
    if (!ACTIVE.has(run.status)) return run;
    await store.updateRun(id, { status: 'stopping' });
    executions.get(id)?.controller.abort(new Error('用户请求停止。'));
    publish();
    return store.getRun(id);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const hosts = [`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`];
      if (!hosts.includes(req.headers.host)) return sendJson(res, 403, { error: '只接受本机窗口请求。' });
      const origin = req.headers.origin;
      if (origin && !hosts.map(host => `http://${host}`).includes(origin)) return sendJson(res, 403, { error: '拒绝跨站请求。' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { error: '拒绝跨站请求。' });
      const url = new URL(req.url, `http://127.0.0.1:${listeningPort}`);
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { application: 'shared-agent-workspace', version: 2 });
      if (req.method === 'GET' && url.pathname === '/') {
        // Cookies are scoped by host, not port: a temporary test instance must
        // not invalidate the session of the user's production workbench.
        res.setHeader('Set-Cookie', `workspace_session_${listeningPort}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(await fs.readFile(path.join(PUBLIC, 'index.html')));
      }
      if (url.pathname.startsWith('/api/')) {
        const cookie = (req.headers.cookie ?? '').split(';').map(s => s.trim());
        if (!cookie.includes(`workspace_session_${listeningPort}=${sessionToken}`)) return sendJson(res, 401, { error: '工作台服务已重启，请重新连接。' });
        if (req.method !== 'GET' && req.headers['x-workspace-request'] !== '1') return sendJson(res, 403, { error: '缺少本机请求标记。' });
        if (closed) return sendJson(res, 503, { error: '工作台正在关闭，请重新打开后再操作。' });
        if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, snapshot());
        if (req.method === 'GET' && url.pathname === '/api/catalog') return sendJson(res, 200, await (options.readComposerCatalog || readComposerCatalog)({ cwd: store.projectRoot, executable: codexExecutable }));
        if (req.method === 'GET' && url.pathname === '/api/folders') return sendJson(res, 200, await listSelectableFolders({ root: store.projectRoot, requestedPath: url.searchParams.get('path') || '', initial: url.searchParams.get('initial') === '1' }));
        if (req.method === 'POST' && url.pathname === '/api/folders') {
          const body = await readJson(req);
          return sendJson(res, 201, await createSelectableFolder({ root: store.projectRoot, parent: body.parent, name: body.name }));
        }
        if (req.method === 'POST' && url.pathname === '/api/folders/select') {
          const body = await readJson(req);
          return sendJson(res, 200, { path: await validateSelectedFolder(store.projectRoot, body.path) });
        }
        if (req.method === 'GET' && url.pathname === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          connections.add(res);
          res.write(`data: ${JSON.stringify({ type: 'state', state: snapshot() })}\n\n`);
          quotaRefresher.update();
          req.on('close', () => { connections.delete(res); quotaRefresher.update(); });
          return;
        }
        const projectRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/(settings|files|preview|catalog|attachments)$/);
        if (projectRoute) {
          const project = store.getProject(projectRoute[1]);
          if (!project) return sendJson(res, 404, { error: '项目不存在。' });
          const action = projectRoute[2];
          if (req.method === 'GET' && action === 'files') return sendJson(res, 200, { files: await listProjectFiles(project, url.searchParams.get('path') || '') });
          if (req.method === 'GET' && action === 'preview') return sendJson(res, 200, await previewProjectFile(project, url.searchParams.get('path') || ''));
          if (req.method === 'GET' && action === 'catalog') return sendJson(res, 200, await (options.readComposerCatalog || readComposerCatalog)({ cwd: project.path, executable: codexExecutable }));
          if (req.method === 'POST' && action === 'settings') {
            const body = await readJson(req);
            if (body.removed === true && body.confirm !== true) throw new Error('请确认移除项目条目。');
            const updated = await serialMutation(() => changeProject(project.id, body));
            publish();
            if (cliMode) {
              await processProjectSyncs();
              const finished = store.getProject(project.id);
              return sendJson(res, finished.projectSync?.status === 'completed' ? 200 : 502, {
                project: finished, ...(finished.projectSync?.status !== 'completed' ? { error: finished.projectSync?.error || 'CLI 同步尚未完成。' } : {}) });
            }
            void processProjectSyncs().catch(() => {});
            return sendJson(res, updated.projectSync?.status === 'pending' ? 202 : 200, { project: updated });
          }
          if (req.method === 'POST' && action === 'attachments') {
            const body = await readJson(req, 15 * 1024 * 1024);
            const saved = await serialMutation(async () => {
              const chat = store.getChat(project.id, body.chatId);
              if (!chat || chat.archived || chat.lifecycle?.status === 'pending') throw new Error('当前聊天不能添加附件。');
              return saveChatAttachment(project, chat, body);
            });
            return sendJson(res, 201, saved);
          }
          return sendJson(res, 405, { error: '不支持此操作。' });
        }
        const chatsRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/chats(?:\/([^/]+))?$/);
        if (chatsRoute && ((req.method === 'POST' && !chatsRoute[2]) || (['PATCH', 'DELETE'].includes(req.method) && chatsRoute[2]))) {
          const body = await readJson(req);
          const chat = await serialMutation(async () => {
            if (!store.getProject(chatsRoute[1])) throw Object.assign(new Error('没有找到这个项目。'), { statusCode: 404 });
            if (!chatsRoute[2]) return store.createChat(chatsRoute[1], { title: body.title });
            const current = store.getChat(chatsRoute[1], chatsRoute[2]);
            if (!current) throw Object.assign(new Error('聊天不存在。'), { statusCode: 404 });
            if (body.archived !== undefined && typeof body.archived !== 'boolean') throw Object.assign(new Error('归档状态必须为布尔值。'), { statusCode: 400 });
            const operation = req.method === 'DELETE' ? 'delete' : body.archived === undefined ? null : body.archived ? 'archive' : 'unarchive';
            if (req.method === 'DELETE' && body.confirm !== true) throw Object.assign(new Error('请确认同时永久删除工作台和已关联的官方聊天。'), { statusCode: 400 });
            if (current.lifecycle?.status === 'pending' && current.lifecycle.operation !== operation) throw Object.assign(new Error('请先重试并完成此前的聊天同步操作。'), { statusCode: 409 });
            if (operation && store.snapshot().runs.some(run => run.projectId === chatsRoute[1] && run.chatId === chatsRoute[2] && ACTIVE.has(run.status))) {
              throw Object.assign(new Error('此聊天仍有任务运行或待确认退出，请先结束任务再归档、恢复或删除。'), { statusCode: 409 });
            }
            if (operation) {
              const project = store.getProject(chatsRoute[1]);
              const sessions = store.nativeChatSessions(chatsRoute[1], chatsRoute[2]).map(s => ({ ...s, desktopTitle: current.title }));
              if (sessions.some(item => !['codex', 'claude'].includes(item.agent))) throw Object.assign(new Error('此聊天关联了尚未接入管理的助手，未执行此次同步。'), { statusCode: 409 });
              const lifecycle = { operation, status: 'pending', completed: current.lifecycle?.status === 'pending' ? current.lifecycle.completed ?? [] : [] };
              await store.setChatLifecycle(chatsRoute[1], chatsRoute[2], lifecycle);
              activeChatSyncs.add(chatsRoute[2]);
              publish();
              try {
                const result = await synchronizeChats({ operation, sessions, executable: codexExecutable,
                  beforeTargets: ({ sessions: targets }) => store.assertNativeTargetsExclusive(chatsRoute[1], chatsRoute[2], targets),
                  ...(claudeDesktopDeletion && operation === 'delete' ? { claudeDesktopDeletion } : {}),
                  ...(claudeDesktopArchive && operation !== 'delete' ? { claudeDesktopArchive } : {}),
                  ...(desktopArchive && operation !== 'delete' ? { desktopArchive, project } : {}),
                  ...(desktopDeletion && operation === 'delete' ? { beforeDelete: data => desktopDeletion.beforeDelete({ ...data, project, completed: lifecycle.completed,
                    onProgress: async record => {
                      lifecycle.completed = [...lifecycle.completed.filter(item => item.sessionId !== record.sessionId || (item.agent ?? 'codex') !== 'codex'), { ...record, agent: 'codex' }];
                      await store.setChatLifecycle(chatsRoute[1], chatsRoute[2], lifecycle);
                    } }) } : {}),
                  onProgress: async record => {
                    if (!lifecycle.completed.some(item => item.agent === record.agent && item.sessionId === record.sessionId)) lifecycle.completed.push(record);
                    await store.setChatLifecycle(chatsRoute[1], chatsRoute[2], lifecycle);
                  } });
                if (operation === 'delete') return { ...await store.deleteChat(chatsRoute[1], chatsRoute[2]), syncResult: result };
                await store.updateChat(chatsRoute[1], chatsRoute[2], { archived: body.archived });
                return await store.setChatLifecycle(chatsRoute[1], chatsRoute[2], { ...lifecycle, status: 'completed', result });
              } catch (error) {
                await store.setChatLifecycle(chatsRoute[1], chatsRoute[2], { ...lifecycle, error: readableError(error) });
                publish();
                throw Object.assign(new Error(`同步尚未全部完成：${readableError(error).replace(/[。.!！]+$/, '')}。记录已保留，请重试同一操作。`), { statusCode: 502 });
              } finally { activeChatSyncs.delete(chatsRoute[2]); publish(); }
            }
            return store.updateChat(chatsRoute[1], chatsRoute[2], {
              ...(body.title !== undefined ? { title: body.title } : {}),
              ...(body.unread !== undefined ? { unread: body.unread } : {}),
              ...(body.archived !== undefined ? { archived: body.archived } : {}),
            });
          });
          publish(); return sendJson(res, req.method === 'POST' ? 201 : 200, req.method === 'DELETE' ? chat : { chat });
        }
        if (req.method !== 'POST') return sendJson(res, 405, { error: '不支持此操作。' });
        const body = await readJson(req);
        if (url.pathname === '/api/chats') {
          const project = await serialMutation(() => store.createProject({ name: `未分组聊天-${randomUUID()}`, kind: 'scratch' }));
          publish(); return sendJson(res, 201, { project, chat: project.chats[0] });
        }
        if (url.pathname === '/api/projects') {
          if (typeof body.create !== 'boolean') throw new Error('请选择新建文件夹，或连接现有文件夹。');
          const project = await serialMutation(async () => {
            const created = await store.createProject({ name: assertString(body.name, '项目名称', 80), path: body.path, create: body.create });
            return registerCodexProject ? registerProject(created.id) : created;
          });
          if (claudeDesktopAutoOpen) await serialMutation(() => openClaudeDesktop(project.id));
          await processSidebarSyncs();
          publish(); return sendJson(res, 201, { project: store.getProject(project.id) });
        }
        const claudeDesktopRoute = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/chats\/([^/]+))?\/claude-desktop$/);
        if (claudeDesktopRoute) {
          if (activeDesktopOpens.has(claudeDesktopRoute[2] || claudeDesktopRoute[1])) throw Object.assign(new Error('Claude 桌面打开请求正在处理，请稍候。'), { statusCode: 409 });
          if (Object.keys(body).some(key => key !== 'sessionId') || (body.sessionId !== undefined && (typeof body.sessionId !== 'string' || body.sessionId.length > 100))
              || (!claudeDesktopRoute[2] && body.sessionId !== undefined)) throw new Error('Claude 桌面打开参数无效。');
          const receipt = await serialMutation(() => openClaudeDesktop(claudeDesktopRoute[1], claudeDesktopRoute[2], body.sessionId));
          return sendJson(res, receipt.status === 'request_sent' ? 200 : 502, { receipt, ...(receipt.error ? { error: receipt.error } : {}) });
        }
        const nativeProjectRoute = url.pathname.match(/^\/api\/projects\/([^/]+)\/codex-project$/);
        if (nativeProjectRoute) {
          const project = await serialMutation(async () => {
            const existing = store.getProject(nativeProjectRoute[1]);
            if (desktopProjectRegistration && existing?.nativeCodex?.status === 'registered') {
              await store.setDesktopCodexProject(existing.id, { status: 'waiting_desktop', checkedAt: now() });
              return existing;
            }
            return registerProject(nativeProjectRoute[1]);
          });
          await processSidebarSyncs();
          return sendJson(res, 200, { project: store.getProject(project.id) });
        }
        if (url.pathname === '/api/runs') {
          const [run] = await queueTasks(assertString(body.projectId, '项目 ID', 100), [body]);
          return sendJson(res, 202, { run });
        }
        if (url.pathname === '/api/parallel') {
          if (!Array.isArray(body.tasks) || body.tasks.length < 2) throw new Error('并行协作至少需要两个任务。');
          if (body.tasks.some(task => !task.scope?.trim())) throw new Error('每个并行任务都要指定独立的项目子目录。');
          if (body.chatId !== undefined && body.tasks.some(task => task.chatId !== undefined && task.chatId !== body.chatId)) throw new Error('同批并行任务的聊天归属必须一致。');
          const runs = await queueTasks(assertString(body.projectId, '项目 ID', 100), body.tasks.map(task => ({ ...task, chatId: body.chatId ?? task.chatId })));
          return sendJson(res, 202, { runs });
        }
        const stop = url.pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
        if (stop) return sendJson(res, 200, { run: await stopRun(stop[1]) });
        const recovery = url.pathname.match(/^\/api\/runs\/([^/]+)\/recover$/);
        if (recovery) {
          if (!store.getRun(recovery[1])) return sendJson(res, 404, { error: '任务不存在。' });
          const run = await serialMutation(() => recoverRun(store, recovery[1], { probeWorker: options.recoveryProbe }));
          publish(); return sendJson(res, 200, { run });
        }
        const approval = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
        if (approval) {
          if (!['allow', 'deny'].includes(body.decision)) throw new Error('许可决定必须是 allow 或 deny。');
          const item = approvals.get(approval[1]);
          if (!item) return sendJson(res, 409, { error: '这个许可请求已结束。' });
          if (body.decision === 'allow' && item.canApprove === false) {
            return sendJson(res, 409, { error: '缺少可核对的具体操作明细，不能批准。请拒绝后补充或重新发起。' });
          }
          item.resolve(body.decision); return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === '/api/providers/refresh') return sendJson(res, 200, { providers: await refreshProviders() });
        return sendJson(res, 404, { error: '未找到此操作。' });
      }
      const allowedAssets = { '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/styles.css': ['styles.css', 'text/css'],
        '/favicon.ico': ['icons/workspace-v3.ico', 'image/x-icon'],
        '/icons/workspace-v3.ico': ['icons/workspace-v3.ico', 'image/x-icon'],
        '/workspace.webmanifest': ['workspace.webmanifest', 'application/manifest+json'],
        ...Object.fromEntries([16,24,32,48,64,128,180,192,256,512].map(size =>
          [`/icons/workspace-v3-${size}.png`, [`icons/workspace-v3-${size}.png`, 'image/png']])) };
      const asset = allowedAssets[url.pathname];
      if (req.method === 'GET' && asset) {
        res.writeHead(200, { 'Content-Type': asset[1].startsWith('image/') ? asset[1] : `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return res.end(await fs.readFile(path.join(PUBLIC, asset[0])));
      }
      sendJson(res, 404, { error: '未找到页面。' });
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.statusCode ?? 400, { error: readableError(error) });
      else res.end();
    }
  });
  server.requestTimeout = 30_000;
  const heartbeat = setInterval(() => { for (const res of connections) if (!res.destroyed) res.write(': alive\n\n'); }, 20_000);
  heartbeat.unref();
  const projectSyncTimer = setInterval(() => { void processProjectSyncs().catch(() => {}); }, 3000);
  projectSyncTimer.unref();
  const sidebarSyncTimer = setInterval(() => { void processSidebarSyncs().catch(() => {}); }, 5000);
  sidebarSyncTimer.unref();

  async function listen(port = 0) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    listeningPort = server.address().port;
    return `http://127.0.0.1:${listeningPort}`;
  }
  async function close() {
    closed = true; clearInterval(heartbeat); clearInterval(projectSyncTimer); clearInterval(sidebarSyncTimer);
    const quotaDrain = quotaRefresher.close();
    // Drain mutations that already passed admission before taking execution
    // snapshots. Later queued dispatches observe closed and cannot start.
    await serial;
    for (const execution of executions.values()) execution.controller.abort(new Error('本地工作台正在关闭。'));
    for (const approval of [...approvals.values()]) approval.resolve('deny');
    for (const res of connections) res.end();
    connections.clear();
    try {
      await Promise.allSettled(Object.values(adapterMap).map(adapter => adapter.close?.()));
      await quotaDrain;
      await Promise.allSettled([...executions.values()].map(e => e.promise));
      await store.flush();
      if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    } finally { await releaseInstance(); }
  }

  return { server, store, snapshot, listen, close, refreshProviders, queueTasks, stopRun, sessionToken, dataDir, processProjectSyncs, processSidebarSyncs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createWorkspaceServer();
  const rawPort = process.env.SHARED_AGENT_PORT;
  const port = rawPort === undefined ? 43118 : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('SHARED_AGENT_PORT 无效。');
  const url = await app.listen(port);
  console.log(`本地项目工作台：${url}`);
  console.log('仅监听本机；检查连接不会启动模型任务。');
  void app.refreshProviders();
  let exiting = false;
  async function shutdown() { if (exiting) return; exiting = true; await app.close(); process.exit(0); }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
