import { mkdir, readFile, readdir, realpath, rename, rm, stat, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertProjectLocation } from './project-location.mjs';

const RECOVERABLE = new Set(['running', 'queued', 'stopping', 'awaiting_approval']);
const ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const clone = value => structuredClone(value);
const canonicalKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

function validatePersistedState(state) {
  if (state?.version !== 1 || !Array.isArray(state.projects) || !Array.isArray(state.runs)) {
    throw new Error('本地记录格式不受支持；已保留原文件。');
  }
  if (state.chatSchemaVersion !== undefined && state.chatSchemaVersion !== 1) throw new Error('本地聊天记录格式不受支持；已保留原文件。');
  const projectIds = new Set();
  const chatOwners = new Map();
  for (const project of state.projects) {
    if (!UUID.test(project?.id) || projectIds.has(project.id) || typeof project.path !== 'string' || !path.isAbsolute(project.path)) {
      throw new Error('本地项目记录损坏；已保留原文件，不根据异常路径写入交接记录。');
    }
    validateProjectName(project.name);
    if (project.projectSync && (!UUID.test(project.projectSync.id) || !['rename', 'remove'].includes(project.projectSync.operation)
      || !['pending', 'failed', 'completed'].includes(project.projectSync.status)
      || canonicalKey(project.projectSync.projectPath || '') !== canonicalKey(project.path))) throw new Error('项目同步记录损坏，已保留原文件。');
    if (!Array.isArray(project.messages) || !Array.isArray(project.checkpoints)) throw new Error('本地项目历史格式损坏；已保留原文件。');
    const legacy = state.chatSchemaVersion === undefined && project.chats === undefined && project.defaultChatId === undefined;
    if (!legacy) {
      if (!Array.isArray(project.chats) || (project.chats.length ? !UUID.test(project.defaultChatId) : project.defaultChatId !== null)) throw new Error('本地聊天记录损坏；已保留原文件。');
      for (const chat of project.chats) {
        if (!UUID.test(chat?.id) || chatOwners.has(chat.id) || typeof chat.archived !== 'boolean'
          || !Number.isFinite(Date.parse(chat.createdAt)) || !Number.isFinite(Date.parse(chat.updatedAt))) throw new Error('本地聊天记录损坏；已保留原文件。');
        validateChatTitle(chat.title);
        chatOwners.set(chat.id, project.id);
      }
      if (project.chats.length && chatOwners.get(project.defaultChatId) !== project.id) throw new Error('默认聊天不属于当前项目；已保留原文件。');
    }
    const messageIds = new Set();
    for (const message of project.messages) {
      if (!message || !ROLES.has(message.role) || typeof message.text !== 'string' || typeof message.id !== 'string' ||
          !message.id || messageIds.has(message.id)) throw new Error('本地消息记录损坏；已保留原文件。');
      messageIds.add(message.id);
      if (legacy ? message.chatId !== undefined : chatOwners.get(message.chatId) !== project.id) throw new Error('消息所属聊天记录损坏；已保留原文件。');
    }
    for (const checkpoint of project.checkpoints) {
      if (legacy ? checkpoint.chatId !== undefined : chatOwners.get(checkpoint.chatId) !== project.id) throw new Error('交接所属聊天记录损坏；已保留原文件。');
    }
    projectIds.add(project.id);
  }
  const runIds = new Set();
  for (const run of state.runs) {
    if (!UUID.test(run?.id) || runIds.has(run.id) || !projectIds.has(run.projectId) || typeof run.status !== 'string') {
      throw new Error('本地运行记录损坏；已保留原文件。');
    }
    runIds.add(run.id);
    const project = state.projects.find(item => item.id === run.projectId);
    if (project.chats === undefined ? run.chatId !== undefined : chatOwners.get(run.chatId) !== run.projectId) throw new Error('运行所属聊天记录损坏；已保留原文件。');
  }
  for (const project of state.projects) {
    for (const item of [...project.messages, ...project.checkpoints]) {
      if (item.runId == null) continue;
      const run = state.runs.find(run => run.id === item.runId);
      if (!run || run.projectId !== project.id || run.chatId !== item.chatId) throw new Error('消息或交接的运行归属损坏；已保留原文件。');
    }
  }
  if (state.runEvents !== undefined) {
    if (!state.runEvents || typeof state.runEvents !== 'object' || Array.isArray(state.runEvents)) throw new Error('本地运行事件格式损坏；已保留原文件。');
    for (const [runId, events] of Object.entries(state.runEvents)) {
      if (!runIds.has(runId) || !Array.isArray(events) || events.some((record, index) =>
        !UUID.test(record?.id) || record.runId !== runId || record.seq !== index + 1 || !record.event || typeof record.event !== 'object')) {
        throw new Error('本地运行事件记录损坏；已保留原文件。');
      }
    }
  }
}

function validateChatTitle(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('聊天标题必须是 1–120 个字符，且不含控制字符或首尾空格。');
  return value;
}

function chatFor(project, chatId = project.defaultChatId) {
  const chat = project.chats.find(item => item.id === chatId);
  if (!UUID.test(chatId) || !chat) throw new Error('聊天不存在或不属于当前项目。');
  return chat;
}

function verifyRunOwner(state, project, chatId, runId) {
  if (runId == null) return;
  const run = state.runs.find(item => item.id === runId);
  if (!run || run.projectId !== project.id || run.chatId !== chatId) throw new Error('运行不属于当前项目和聊天。');
}

function newChat(project, title = '新对话', timestamp = new Date().toISOString()) {
  const id = randomUUID();
  return { id, title: validateChatTitle(title), createdAt: timestamp, updatedAt: timestamp, archived: false,
    transcriptPath: path.join(project.storagePath, 'chats', id, 'transcript.jsonl') };
}

export function validateProjectName(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 80 ||
      /[<>:"/\\|?*\x00-\x1f\x7f]/u.test(value) || /[. ]$/u.test(value) ||
      value === '.' || value === '..' || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(value)) {
    throw new Error('项目名称无效：请使用 1–80 个字符，不含路径符号、Windows 保留名称或末尾空格/句点。');
  }
  return value;
}

async function existsDirectory(folder) {
  try {
    const info = await stat(folder);
    if (!info.isDirectory()) throw new Error('项目路径必须是文件夹。');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// The state file is authoritative. Derived transcripts are rebuilt on startup.
// Each rename is atomic; fsync prevents a successful write from only living in a buffer.
async function atomicWrite(filename, content) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(filename), { recursive: true });
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    // Windows readers/antivirus can briefly omit FILE_SHARE_DELETE. Preserve
    // atomic replacement, but retry a bounded transient lock instead of failing
    // an otherwise successful chat or background project registration.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, filename); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
        await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function validateMessage(input, existing) {
  if (!input || typeof input !== 'object') throw new Error('消息不能为空。');
  const message = { ...(existing ?? {}), ...clone(input) };
  if (!ROLES.has(message.role)) throw new Error('消息角色无效。');
  if (typeof message.text !== 'string') throw new Error('消息内容必须是文本。');
  if (message.id !== undefined && (typeof message.id !== 'string' || !message.id || message.id.length > 160)) {
    throw new Error('消息 ID 无效。');
  }
  if (existing && (message.role !== existing.role || message.runId !== existing.runId || message.chatId !== existing.chatId)) {
    throw new Error('不能更改已有消息的角色、所属运行或聊天。');
  }
  return {
    ...message,
    id: existing?.id ?? message.id ?? randomUUID(),
    createdAt: existing?.createdAt ?? message.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export class Store {
  constructor(dataDir, { projectRoot } = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw new Error('必须指定本地数据目录。');
    this.dataDir = path.resolve(dataDir);
    if (projectRoot !== undefined && (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)
      || path.resolve(projectRoot) === path.parse(path.resolve(projectRoot)).root)) throw new Error('项目根目录必须是本机绝对路径，不能使用磁盘根目录。');
    this.projectRoot = path.resolve(projectRoot ?? path.join(this.dataDir, 'projects'));
    this.restrictProjectRoot = projectRoot !== undefined;
    this.statePath = path.join(this.dataDir, 'state.json');
    this._state = null;
    this._queue = Promise.resolve();
    this._initPromise = null;
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      await mkdir(this.dataDir, { recursive: true });
      let state, original;
      try {
        original = await readFile(this.statePath, 'utf8');
        state = JSON.parse(original);
        validatePersistedState(state);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = { version: 1, chatSchemaVersion: 1, projects: [], runs: [], runEvents: {} };
      }
      state.runEvents ??= {};
      const now = new Date().toISOString();
      const migrating = state.projects.some(project => project.chats === undefined);
      if (migrating) {
        const backupPath = path.join(this.dataDir, 'backups', `state.pre-chats.${Date.now()}-${randomUUID()}.json`);
        await atomicWrite(backupPath, original);
        state.chatMigration = { migratedAt: now, backupPath };
      }
      for (const project of state.projects) {
        project.messages ??= [];
        project.checkpoints ??= [];
        // Derive paths instead of trusting stored paths after an appdata move.
        project.storagePath = path.join(this.dataDir, 'project-data', project.id);
        project.transcriptPath = path.join(project.storagePath, 'transcript.jsonl');
        project.runsPath = path.join(project.storagePath, 'runs.json');
        if (project.chats === undefined) {
          const chat = newChat(project, '原有对话', project.createdAt ?? now);
          chat.updatedAt = project.updatedAt ?? now;
          project.chats = [chat]; project.defaultChatId = chat.id;
          for (const message of project.messages) message.chatId = chat.id;
          for (const checkpoint of project.checkpoints) checkpoint.chatId = chat.id;
          for (const run of state.runs.filter(item => item.projectId === project.id)) {
            run.chatId = chat.id;
            if (run.checkpoint && typeof run.checkpoint === 'object') run.checkpoint.chatId = chat.id;
          }
        }
        for (const chat of project.chats) chat.transcriptPath = path.join(project.storagePath, 'chats', chat.id, 'transcript.jsonl');
      }
      for (const run of state.runs) {
        const project = state.projects.find(item => item.id === run.projectId);
        run.eventsPath = path.join(project.storagePath, 'runs', `${run.id}.jsonl`);
        // Old runs did not retain a full event stream. An empty derived JSONL
        // must never be mistaken for proof that those old tools did not run.
        run.eventsCoverage ??= Object.hasOwn(state.runEvents, run.id) ? 'unknown-start' : 'legacy-metadata-only';
        state.runEvents[run.id] ??= [];
        run.eventCount = state.runEvents[run.id].length;
        if (RECOVERABLE.has(run.status)) {
          run.recoveryFrom = run.status;
          run.recoveryDetectedAt = now;
          run.status = 'recovery_pending';
          run.updatedAt = now;
          run.interruptionReason = '应用重启时运行尚未完成，尚未确认原工作进程已退出；保留工作范围占用，等待核实。';
        }
      }
      state.chatSchemaVersion = 1;
      validatePersistedState(state);
      await atomicWrite(this.statePath, JSON.stringify(state, null, 2) + '\n');
      this._state = state;
      for (const run of state.runs) await this._writeRunEvents(run, state);
      for (const project of state.projects) {
        await this._writeTranscript(project);
        await this._writeRunIndex(project, state);
      }
      return this;
    })();
    return this._initPromise;
  }

  _ready() {
    if (!this._state) throw new Error('请先 await store.init()。');
  }

  snapshot() {
    this._ready();
    return clone({ projects: this._state.projects, runs: this._state.runs });
  }

  getProject(id) {
    this._ready();
    const project = this._state.projects.find(item => item.id === id);
    return project ? clone(project) : undefined;
  }

  getRun(id) {
    this._ready();
    const run = this._state.runs.find(item => item.id === id);
    return run ? clone(run) : undefined;
  }

  getChat(projectId, chatId) {
    this._ready();
    const project = this._state.projects.find(item => item.id === projectId);
    const chat = project?.chats.find(item => item.id === (chatId ?? project.defaultChatId));
    return chat ? clone(chat) : undefined;
  }

  async createChat(projectId, { title = '新对话' } = {}) {
    validateChatTitle(title);
    return this._mutate(draft => {
      const project = draft.projects.find(item => item.id === projectId);
      if (!project) throw new Error('项目不存在。');
      if (project.projectSync && project.projectSync.status !== 'completed') throw new Error('项目有待完成的同步，请完成后再新建聊天。');
      const chat = newChat(project, title);
      project.chats.push(chat); project.updatedAt = chat.updatedAt;
      project.defaultChatId ??= chat.id;
      return { result: chat, projectIds: [projectId] };
    });
  }

  async setDesktopCodexProject(projectId, registration) {
    if (!registration || !['registered', 'waiting_desktop', 'waiting_trust', 'failed'].includes(registration.status)) throw new Error('桌面项目登记状态无效。');
    if (registration.status === 'registered' && (!registration.projectId || !registration.nativeProjectId)) throw new Error('桌面项目缺少身份映射。');
    return this._mutate(draft => {
      const project = draft.projects.find(p => p.id === projectId && !p.removed && p.kind !== 'scratch');
      if (!project) throw new Error('项目已移除或不存在。');
      project.desktopCodex = clone(registration);
      if (registration.nativeProjectId && registration.projectId) project.nativeCodex = { status: 'registered',
        projectId: registration.nativeProjectId, source: 'codex_app_server',
        name: registration.name || project.name, updatedAt: registration.checkedAt };
      return { result: project };
    });
  }

  async setClaudeDesktop(projectId, chatId, receipt) {
    if (!receipt || !['pending', 'request_sent', 'failed'].includes(receipt.status)) throw new Error('Claude 桌面打开状态无效。');
    const metadata = { status: receipt.status, checkedAt: new Date().toISOString() };
    for (const key of ['cwd', 'sessionId', 'source', 'error']) {
      if (receipt[key] !== undefined) {
        if (typeof receipt[key] !== 'string' || receipt[key].length > 4000) throw new Error('Claude 桌面回执无效。');
        metadata[key] = receipt[key];
      }
    }
    return this._mutate(draft => {
      const project = draft.projects.find(p => p.id === projectId && !p.removed);
      if (!project) throw new Error('项目已移除或不存在。');
      const target = chatId ? chatFor(project, chatId) : project;
      target.desktopClaude = metadata;
      return { result: metadata };
    });
  }

  async setNativeCodexProject(projectId, registration) {
    if (!registration || typeof registration !== 'object' || Array.isArray(registration)
      || Object.keys(registration).some(key => !['status', 'projectId', 'nativeProjectId', 'name', 'error', 'updatedAt', 'source'].includes(key))
      || !['registered', 'failed', 'pending'].includes(registration.status)) throw new Error('原生 Codex 项目登记元信息无效。');
    for (const [key, maximum] of [['projectId', 500], ['nativeProjectId', 500], ['name', 200], ['error', 4000]]) {
      if (Object.hasOwn(registration, key) && (typeof registration[key] !== 'string' || registration[key].length > maximum
        || (key === 'projectId' && !registration[key].trim()))) throw new Error(`原生 Codex 项目 ${key} 无效。`);
    }
    if (registration.status === 'registered' && !registration.projectId?.trim()) throw new Error('原生 Codex 项目登记成功必须包含 projectId。');
    if (registration.source !== undefined && !['codex_app_server', 'codex_desktop_deeplink'].includes(registration.source)) throw new Error('原生 Codex 项目来源无效。');
    if (registration.updatedAt !== undefined && (typeof registration.updatedAt !== 'string' || !Number.isFinite(Date.parse(registration.updatedAt)))) throw new Error('原生 Codex 项目更新时间无效。');
    const metadata = { ...clone(registration), updatedAt: registration.updatedAt ?? new Date().toISOString() };
    return this._mutate(draft => {
      const project = draft.projects.find(item => item.id === projectId);
      if (!project) throw new Error('项目不存在。');
      project.nativeCodex = metadata;
      return { result: metadata };
    });
  }

  async updateChat(projectId, chatId, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['title', 'archived', 'unread'].includes(key))) throw new Error('聊天更新内容无效。');
    if (Object.hasOwn(patch, 'unread') && typeof patch.unread !== 'boolean') throw new Error('unread 必须为布尔值。');
    if (Object.hasOwn(patch, 'title')) validateChatTitle(patch.title);
    if (Object.hasOwn(patch, 'archived') && typeof patch.archived !== 'boolean') throw new Error('archived 必须为布尔值。');
    return this._mutate(draft => {
      const project = draft.projects.find(item => item.id === projectId);
      if (!project) throw new Error('项目不存在。');
      const chat = chatFor(project, chatId);
      Object.assign(chat, clone(patch), { updatedAt: new Date().toISOString() });
      project.updatedAt = chat.updatedAt;
      return { result: chat, projectIds: [projectId] };
    });
  }

  nativeChatSessions(projectId, chatId) {
    this._ready();
    const project = this._state.projects.find(item => item.id === projectId);
    if (!project) throw new Error('项目不存在。');
    chatFor(project, chatId);
    const references = run => [run.sessionId, ...(this._state.runEvents[run.id] ?? [])
      .filter(record => record.event.type === 'session')
      .flatMap(record => [record.event.sessionId, record.event.recoveredFrom])].filter(Boolean);
    const sessions = new Map();
    for (const run of this._state.runs.filter(item => item.projectId === projectId && item.chatId === chatId)) {
      for (const sessionId of references(run)) {
        if (this._state.runs.some(other => other.agent === run.agent && other.chatId !== chatId && references(other).includes(sessionId))) {
          throw new Error('此原生会话还被另一条工作台聊天引用，已停止同步，避免影响其他聊天。');
        }
        sessions.set(`${run.agent}:${sessionId}`, { agent: run.agent, sessionId,
          cwd: path.resolve(project.path, run.scope || ''), projectPath: project.path });
      }
    }
    return [...sessions.values()];
  }

  assertNativeTargetsExclusive(projectId, chatId, sessions) {
    this._ready();
    const project = this._state.projects.find(item => item.id === projectId);
    if (!project) throw new Error('项目不存在。');
    chatFor(project, chatId);
    if (!Array.isArray(sessions) || sessions.some(item => !['codex', 'claude'].includes(item?.agent)
      || typeof item.sessionId !== 'string' || !item.sessionId)) throw new Error('待同步原生会话范围无效。');
    const targets = new Set(sessions.map(item => `${item.agent}:${item.sessionId.toLowerCase()}`));
    for (const run of this._state.runs) {
      if (run.projectId === projectId && run.chatId === chatId) continue;
      const refs = [run.sessionId, ...(this._state.runEvents[run.id] ?? [])
        .filter(record => record.event.type === 'session')
        .flatMap(record => [record.event.sessionId, record.event.recoveredFrom])].filter(Boolean);
      if (refs.some(id => targets.has(`${run.agent}:${String(id).toLowerCase()}`))) {
        throw new Error('这条聊天的原生会话或子任务还被另一条工作台聊天引用，已停止同步，避免影响其他聊天。');
      }
    }
  }

  async setChatLifecycle(projectId, chatId, lifecycle) {
    if (!['archive', 'unarchive', 'delete'].includes(lifecycle.operation) || !['pending', 'completed'].includes(lifecycle.status)) throw new Error('聊天同步状态无效。');
    return this._mutate(draft => {
      const project = draft.projects.find(item => item.id === projectId);
      if (!project) throw new Error('项目不存在。');
      const chat = chatFor(project, chatId);
      chat.lifecycle = { ...clone(lifecycle), updatedAt: new Date().toISOString() };
      return { result: chat };
    });
  }

  async deleteChat(projectId, chatId) {
    // Keep the pending chat in authoritative state until local cleanup succeeds.
    // A crash can rebuild derived files, but cannot falsely report deletion or
    // lose the native-session IDs required to retry the operation.
    return this._mutate(async draft => {
      const project = draft.projects.find(item => item.id === projectId);
      if (!project) throw new Error('项目不存在。');
      chatFor(project, chatId);
      const runs = draft.runs.filter(item => item.projectId === projectId && item.chatId === chatId);
      if (runs.some(item => ['queued', 'running', 'awaiting_approval', 'stopping', 'recovery_pending'].includes(item.status))) throw new Error('聊天仍有未结束的任务。');
      const runIds = new Set(runs.map(item => item.id));
      const checkpointIds = project.checkpoints.filter(item => item.chatId === chatId).map(item => item.id);
      const messageIds = new Set(project.messages.filter(item => item.chatId === chatId).map(item => item.id));
      const storage = path.join(this.dataDir, 'project-data', project.id);
      const dataRoot = await realpath(this.dataDir);
      const storageReal = await realpath(storage);
      const storageRelative = path.relative(dataRoot, storageReal);
      if (!storageRelative || storageRelative.startsWith('..') || path.isAbsolute(storageRelative)) throw new Error('聊天数据目录超出工作台范围，未执行清理。');
      const projectRelative = path.relative(project.path, storageReal);
      if (!projectRelative || (!projectRelative.startsWith('..') && !path.isAbsolute(projectRelative))) throw new Error('聊天记录目录与项目资料重叠，已停止清理。');
      const targets = [path.join(storage, 'chats', chatId),
        ...runs.map(run => path.join(storage, 'runs', `${run.id}.jsonl`)),
        ...checkpointIds.map(id => {
          if (!UUID.test(id)) throw new Error('交接记录编号异常，未执行清理。');
          return path.join(storage, 'checkpoints', id);
        })];
      // Validate every resolved target before the first recursive removal.
      for (const target of targets) {
        let resolved;
        try { resolved = await realpath(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const relative = path.relative(storageReal, resolved);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('聊天记录路径指向了外部目录，未执行清理。');
      }
      function removeRecords(state) {
        const savedProject = state.projects?.find(item => item.id === projectId);
        if (!savedProject) return;
        savedProject.messages = (savedProject.messages ?? []).filter(item => item.chatId !== chatId && !messageIds.has(item.id));
        savedProject.checkpoints = (savedProject.checkpoints ?? []).filter(item => item.chatId !== chatId && !checkpointIds.includes(item.id) && !runIds.has(item.runId));
        if (Array.isArray(savedProject.chats)) {
          savedProject.chats = savedProject.chats.filter(item => item.id !== chatId);
          if (savedProject.defaultChatId === chatId) savedProject.defaultChatId = savedProject.chats[0]?.id ?? null;
        }
        state.runs = (state.runs ?? []).filter(item => !runIds.has(item.id));
        for (const id of runIds) if (state.runEvents) delete state.runEvents[id];
      }
      // Scrub the workbench's own migration backups too. User-created external
      // copies and content quoted in other chats are outside this operation.
      const backupDir = path.join(this.dataDir, 'backups');
      let backups = [];
      try { backups = await readdir(backupDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const name of backups.filter(name => /^state\.pre-chats\.[\w.-]+\.json$/u.test(name))) {
        const file = path.join(backupDir, name);
        const resolved = await realpath(file);
        const relative = path.relative(dataRoot, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('备份路径超出工作台范围。');
        const backup = JSON.parse(await readFile(file, 'utf8'));
        if (backup.version !== 1 || !Array.isArray(backup.projects) || !Array.isArray(backup.runs)) throw new Error('旧备份格式无法安全清理。');
        removeRecords(backup);
        await atomicWrite(file, JSON.stringify(backup, null, 2) + '\n');
      }
      for (const target of targets) await rm(target, { recursive: true, force: true });
      removeRecords(draft);
      project.updatedAt = new Date().toISOString();
      return { result: { deleted: true, projectId, chatId }, projectIds: [projectId] };
    });
  }

  async _writeTranscript(project) {
    const header = { type: 'project', id: project.id, name: project.name, path: project.path,
      messageCount: project.messages.length, updatedAt: project.updatedAt };
    const lines = [JSON.stringify(header), ...project.messages.map(message => JSON.stringify({ type: 'message', ...message }))];
    await atomicWrite(project.transcriptPath, lines.join('\n') + '\n');
    for (const chat of project.chats) {
      const messages = project.messages.filter(message => message.chatId === chat.id);
      const chatHeader = { type: 'chat', projectId: project.id, id: chat.id, title: chat.title, archived: chat.archived,
        messageCount: messages.length, updatedAt: chat.updatedAt };
      await atomicWrite(chat.transcriptPath, [JSON.stringify(chatHeader), ...messages.map(message => JSON.stringify({ type: 'message', ...message }))].join('\n') + '\n');
    }
  }

  async _writeRunEvents(run, state) {
    const records = state.runEvents[run.id] ?? [];
    const header = { type: 'run', runId: run.id, projectId: run.projectId, chatId: run.chatId, eventCount: records.length,
      eventsCoverage: run.eventsCoverage, note: run.eventsCoverage === 'since-run-created'
        ? '仅记录已收到并提交的事件，不保证外部执行器未报告的事件。'
        : '旧完整事件日志缺失或记录起点不明；现有事件不能代表该运行的全部历史。' };
    await atomicWrite(run.eventsPath, [JSON.stringify(header), ...records.map(record => JSON.stringify({ type: 'event', ...record }))].join('\n') + '\n');
  }

  async _writeRunIndex(project, state) {
    const index = { projectId: project.id, updatedAt: new Date().toISOString(),
      note: '这是运行证据索引；completed 不等于项目成果已经验证。完整工具、审批与终态事件见 eventsPath。',
      runs: state.runs.filter(run => run.projectId === project.id) };
    await atomicWrite(project.runsPath, JSON.stringify(index, null, 2) + '\n');
  }

  async _mutate(operation) {
    await this.init();
    const pending = this._queue.then(async () => {
      const draft = clone(this._state);
      const { result, projectIds = [], runProjectIds = [], eventRunIds = [] } = await operation(draft);
      // Commit the complete event payload in the authoritative atomic state
      // before publishing derived JSONL/index views. A crash in between can leave
      // a view stale, never a half event; init rebuilds every view from state.
      await atomicWrite(this.statePath, JSON.stringify(draft, null, 2) + '\n');
      this._state = draft;
      for (const id of new Set(projectIds)) {
        const project = draft.projects.find(item => item.id === id);
        if (project) await this._writeTranscript(project);
      }
      for (const id of new Set(eventRunIds)) {
        const run = draft.runs.find(item => item.id === id);
        if (run) await this._writeRunEvents(run, draft);
      }
      for (const id of new Set([...projectIds, ...runProjectIds])) {
        const project = draft.projects.find(item => item.id === id);
        if (project) await this._writeRunIndex(project, draft);
      }
      return clone(result);
    });
    this._queue = pending.catch(() => {});
    return pending;
  }

  async createProject({ name, path: requestedPath, create = true, kind = 'project' } = {}) {
    validateProjectName(name);
    if (typeof create !== 'boolean') throw new Error('create 必须为布尔值。');
    if (requestedPath !== undefined && (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath))) {
      throw new Error('项目路径必须是本机的绝对路径。');
    }
    const target = requestedPath === undefined ? path.join(this.projectRoot, name) : path.resolve(requestedPath);
    return this._mutate(async draft => {
      if (this.restrictProjectRoot) await assertProjectLocation(this.projectRoot, target);
      const exists = await existsDirectory(target);
      if (!exists && !create) throw new Error('所选项目文件夹不存在；注册已有项目不会新建文件。');
      let actualPath = exists ? await realpath(target) : target;
      const alreadyRegistered = exists && draft.projects.find(project => canonicalKey(project.path) === canonicalKey(actualPath));
      if (alreadyRegistered) {
        if (alreadyRegistered.projectSync && alreadyRegistered.projectSync.status !== 'completed') throw new Error('这个文件夹有未完成的项目同步，请先完成同步。');
        alreadyRegistered.removed = false; if (kind === 'project') alreadyRegistered.kind = 'project'; return { result: alreadyRegistered, projectIds: [alreadyRegistered.id] };
      }
      if (create && exists && (await readdir(target)).length > 0) {
        throw new Error('目标文件夹不是空的；请使用“打开已有项目”，不会覆盖原有资料。');
      }
      if (!exists) {
        await mkdir(target, { recursive: true });
        actualPath = await realpath(target);
      }
      if (this.restrictProjectRoot) await assertProjectLocation(this.projectRoot, actualPath);
      const samePath = draft.projects.find(project => canonicalKey(project.path) === canonicalKey(actualPath));
      if (samePath) return { result: samePath };
      const now = new Date().toISOString();
      const id = randomUUID();
      const storagePath = path.join(this.dataDir, 'project-data', id);
      const project = { id, name, kind, path: actualPath, storagePath,
        transcriptPath: path.join(storagePath, 'transcript.jsonl'), runsPath: path.join(storagePath, 'runs.json'),
        messages: [], checkpoints: [], createdAt: now, updatedAt: now };
      const chat = newChat(project, '新对话', now);
      project.chats = [chat]; project.defaultChatId = chat.id;
      draft.projects.push(project);
      return { result: project, projectIds: [id] };
    });
  }

  async updateProject(projectId, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['name', 'removed'].includes(key))) throw new Error('项目更新内容无效。');
    if (patch.name !== undefined) validateProjectName(patch.name);
    return this._mutate(draft => {
      const project = draft.projects.find(item => item.id === projectId);
      if (!project) throw new Error('项目不存在。');
      if (draft.runs.some(run => run.projectId === projectId && (RECOVERABLE.has(run.status) || run.status === 'recovery_pending'))) throw new Error('项目中仍有任务，请结束后再修改。');
      if (patch.name !== undefined) project.name = patch.name;
      if (patch.removed !== undefined) { if (typeof patch.removed !== 'boolean') throw new Error('removed 必须为布尔值'); project.removed = patch.removed; }
      project.updatedAt = new Date().toISOString();
      return { result: project, projectIds: [projectId] };
    });
  }

  async setProjectSync(projectId, sync) {
    if (!sync || !UUID.test(sync.id) || !['pending', 'failed', 'completed'].includes(sync.status)
      || !['rename', 'remove'].includes(sync.operation) || typeof sync.projectPath !== 'string'
      || !path.isAbsolute(sync.projectPath)) throw new Error('项目同步记录无效。');
    if (sync.operation === 'rename') validateProjectName(sync.name);
    return this._mutate(draft => {
      const project = draft.projects.find(item => item.id === projectId);
      if (!project || canonicalKey(project.path) !== canonicalKey(sync.projectPath)) throw new Error('项目同步文件夹不匹配。');
      project.projectSync = clone(sync);
      return { result: project };
    });
  }

  async relocateProjectToCli(projectId, { previousPath, destination, registration, receipt }) {
    if (!this.restrictProjectRoot) throw new Error('迁移必须配置项目根目录。');
    await assertProjectLocation(this.projectRoot, destination);
    const canonical = await realpath(destination);
    if (!registration?.projectId || registration.source !== 'codex_app_server') throw new Error('迁移缺少已验证的 CLI 项目登记。');
    return this._mutate(draft => {
      const project = draft.projects.find(item => item.id === projectId);
      if (!project || canonicalKey(project.path) !== canonicalKey(previousPath)) throw new Error('迁移源目录已经变化。');
      if (draft.projects.some(p => p.id !== projectId && canonicalKey(p.path) === canonicalKey(canonical))) throw new Error('目标目录已被另一个项目使用。');
      if (draft.runs.some(run => run.projectId === projectId && (RECOVERABLE.has(run.status) || run.status === 'recovery_pending'))) throw new Error('项目有未结束任务，不能迁移。');
      if (project.projectSync) {
        project.retiredProjectSyncs = [...(project.retiredProjectSyncs || []), { ...project.projectSync, retiredReason: 'Switched from desktop synchronization to direct CLI integration' }];
        delete project.projectSync;
      }
      project.migrations = [...(project.migrations || []), { previousPath, destination: canonical, receipt, migratedAt: new Date().toISOString() }];
      project.path = canonical;
      project.nativeCodex = { ...clone(registration), status: 'registered', updatedAt: new Date().toISOString() };
      project.updatedAt = new Date().toISOString();
      return { result: project, projectIds: [projectId] };
    });
  }

  async completeProjectSync(projectId, jobId, receipt) {
    return this._mutate(draft => {
      const project = draft.projects.find(item => item.id === projectId);
      const job = project?.projectSync;
      if (!job || job.id !== jobId || job.status !== 'pending') throw new Error('项目同步操作已改变。');
      if (job.operation === 'rename') {
        project.name = job.name;
        project.nativeCodex = { status: 'registered', projectId: job.projectId, name: job.name, source: receipt.source,
          ...(receipt.nativeProjectId ? { nativeProjectId: receipt.nativeProjectId } : {}), updatedAt: receipt.checkedAt };
      } else { project.removed = true; delete project.nativeCodex; }
      project.projectSync = { ...job, status: 'completed', phase: 'completed', error: undefined, completedAt: receipt.checkedAt,
        ...(receipt.desktop ? { desktop: clone(receipt.desktop) } : {}) };
      project.updatedAt = receipt.checkedAt;
      return { result: project, projectIds: [projectId] };
    });
  }

  async supersedeLastTurn(projectId, chatId, messageId) {
    return this._mutate(draft => {
      const project = draft.projects.find(item => item.id === projectId);
      if (!project) throw new Error('项目不存在。');
      const chat = chatFor(project, chatId);
      if (chat.archived || chat.lifecycle?.status === 'pending') throw new Error('请先恢复聊天或完成同步。');
      const last = project.messages.filter(item => item.chatId === chatId && item.role === 'user' && !item.superseded).at(-1);
      if (!last || last.id !== messageId) throw new Error('只能编辑最后一条用户消息，请刷新后再试。');
      if (draft.runs.some(run => run.projectId === projectId && (RECOVERABLE.has(run.status) || run.status === 'recovery_pending'))) throw new Error('请等待项目任务结束再编辑。');
      const index = project.messages.indexOf(last);
      for (const item of project.messages.slice(index).filter(item => item.chatId === chatId)) item.superseded = true;
      const old = draft.runs.find(item => item.id === last.runId);
      if (old) old.superseded = true;
      chat.contextVersion = (chat.contextVersion || 0) + 1;
      return { result: chat, projectIds: [projectId], runProjectIds: [projectId] };
    });
  }

  async appendMessage(projectId, input) {
    return this._mutate(draft => {
      const project = draft.projects.find(item => item.id === projectId);
      if (!project) throw new Error('项目不存在。');
      const chat = chatFor(project, input?.chatId);
      const message = validateMessage({ ...input, chatId: chat.id });
      verifyRunOwner(draft, project, chat.id, message.runId);
      if (project.messages.some(item => item.id === message.id)) throw new Error('消息 ID 已存在，请更新原消息。');
      project.messages.push(message);
      project.updatedAt = message.updatedAt;
      chat.updatedAt = message.updatedAt;
      return { result: message, projectIds: [projectId] };
    });
  }

  async upsertMessage(projectId, input) {
    return this._mutate(draft => {
      const project = draft.projects.find(item => item.id === projectId);
      if (!project) throw new Error('项目不存在。');
      const index = input?.id ? project.messages.findIndex(item => item.id === input.id) : -1;
      const existing = index >= 0 ? project.messages[index] : undefined;
      const chat = chatFor(project, input?.chatId === undefined ? existing?.chatId : input.chatId);
      const message = validateMessage({ ...input, chatId: chat.id }, existing);
      verifyRunOwner(draft, project, chat.id, message.runId);
      if (index >= 0) project.messages[index] = message;
      else project.messages.push(message);
      project.updatedAt = message.updatedAt;
      chat.updatedAt = message.updatedAt;
      return { result: message, projectIds: [projectId] };
    });
  }

  async createRun(fields = {}) {
    return this._mutate(draft => {
      const project = draft.projects.find(item => item.id === fields.projectId);
      if (!project) throw new Error('运行所属项目不存在。');
      const now = new Date().toISOString();
      const id = randomUUID();
      const chat = chatFor(project, fields.chatId);
      const run = { ...clone(fields), id, chatId: chat.id, status: 'queued', createdAt: now, updatedAt: now,
        eventsPath: path.join(project.storagePath, 'runs', `${id}.jsonl`), eventCount: 0, eventsCoverage: 'since-run-created' };
      draft.runs.push(run);
      draft.runEvents[id] = [];
      return { result: run, runProjectIds: [run.projectId], eventRunIds: [id] };
    });
  }

  async appendRunEvent(runId, event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('运行事件必须是结构化对象。');
    // Preserve the complete provider/server JSON payload, not only its latest
    // tool or excerpt. Envelope fields cannot be overridden by event contents.
    const payload = JSON.parse(JSON.stringify(clone(event)));
    return this._mutate(draft => {
      const run = draft.runs.find(item => item.id === runId);
      if (!run) throw new Error('运行不存在。');
      const events = draft.runEvents[runId] ??= [];
      const createdAt = new Date().toISOString();
      const record = { id: randomUUID(), seq: events.length + 1, runId, createdAt, event: payload };
      events.push(record);
      if (run.eventsCoverage === 'legacy-metadata-only') run.eventsCoverage = 'partial-after-legacy';
      run.eventCount = events.length;
      run.lastEventAt = createdAt;
      run.lastEventSummary = { seq: record.seq, type: payload.type ?? payload.method ?? 'event',
        preview: JSON.stringify(payload).slice(0, 1600), truncated: JSON.stringify(payload).length > 1600 };
      run.updatedAt = createdAt;
      return { result: record, runProjectIds: [run.projectId], eventRunIds: [runId] };
    });
  }

  async updateRun(id, patch) {
    if (!patch || typeof patch !== 'object') throw new Error('运行更新内容无效。');
    return this._mutate(draft => {
      const run = draft.runs.find(item => item.id === id);
      if (!run) throw new Error('运行不存在。');
      for (const field of ['id', 'projectId', 'chatId', 'createdAt', 'eventsPath', 'eventCount', 'eventsCoverage', 'lastEventAt', 'lastEventSummary']) {
        if (Object.hasOwn(patch, field) && patch[field] !== run[field]) throw new Error(`不能更改运行的 ${field}。`);
      }
      Object.assign(run, clone(patch), { updatedAt: new Date().toISOString() });
      return { result: run, runProjectIds: [run.projectId] };
    });
  }

  async addCheckpoint(projectId, checkpoint) {
    return this._mutate(draft => {
      const project = draft.projects.find(item => item.id === projectId);
      if (!project) throw new Error('项目不存在。');
      const chat = chatFor(project, checkpoint?.chatId);
      verifyRunOwner(draft, project, chat.id, checkpoint?.runId);
      const record = { ...clone(checkpoint), chatId: chat.id, id: checkpoint?.id ?? randomUUID(), createdAt: checkpoint?.createdAt ?? new Date().toISOString() };
      const existing = project.checkpoints.findIndex(item => item.id === record.id);
      if (existing >= 0 && project.checkpoints[existing].chatId !== chat.id) throw new Error('不能移动已有交接到另一聊天。');
      if (existing >= 0 && project.checkpoints[existing].runId !== record.runId) throw new Error('不能更改已有交接所属运行。');
      if (existing >= 0) project.checkpoints[existing] = record;
      else project.checkpoints.push(record);
      project.updatedAt = new Date().toISOString();
      return { result: record };
    });
  }

  async flush() {
    await this.init();
    await this._queue;
  }
}
