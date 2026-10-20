import os from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, realpath, readdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DESKTOP_ID = /^local_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const authority = 'claude-desktop-persisted-metadata';
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const samePath = (a, b) => {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return typeof a === 'string' && typeof b === 'string' && path.isAbsolute(a) && path.isAbsolute(b) && normalize(a) === normalize(b);
};
const within = (root, value) => {
  if (typeof root !== 'string' || typeof value !== 'string' || !path.isAbsolute(root) || !path.isAbsolute(value)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const uuid = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined;
const desktopId = value => typeof value === 'string' && DESKTOP_ID.test(value) ? value.toLowerCase() : undefined;
const nativeId = value => uuid(value) ?? (desktopId(value)?.slice(6));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// This is a read-only inventory, not a substitute for the running app's state.
// It never reads credential files, CLI transcripts, or app databases.
export function defaultClaudeDesktopUserDataRoots(home = os.homedir()) {
  return [
    path.join(home, 'AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude'),
    path.join(home, 'AppData', 'Roaming', 'Claude'),
  ];
}

async function safePath(target, { kind = 'directory', optional = false } = {}) {
  if (!path.isAbsolute(target)) fail('CLAUDE_DESKTOP_CATALOG_PATH', 'Claude 桌面记录目录必须是绝对路径。');
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      fail('CLAUDE_DESKTOP_CATALOG_UNREADABLE', '无法完整读取 Claude 桌面会话目录，尚不能确认聊天已删除。');
    }
    if (stat.isSymbolicLink()) fail('CLAUDE_DESKTOP_CATALOG_LINK', 'Claude 桌面记录路径包含链接，已停止以防误删。');
    if (current !== absolute && !stat.isDirectory()) fail('CLAUDE_DESKTOP_CATALOG_PATH', 'Claude 桌面记录路径无效。');
    if (current === absolute && (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
      fail('CLAUDE_DESKTOP_CATALOG_PATH', 'Claude 桌面记录的文件类型无效。');
    }
    if (current === absolute && kind === 'file' && stat.nlink !== 1) {
      fail('CLAUDE_DESKTOP_CATALOG_LINK', 'Claude 桌面记录有多个文件链接，已停止以防误删。');
    }
  }
  const actual = await realpath(absolute);
  if (!samePath(absolute, actual)) fail('CLAUDE_DESKTOP_CATALOG_LINK', 'Claude 桌面记录的真实路径不一致，已停止同步。');
  return absolute;
}

function relationOf(record) {
  const from = record.spawnedFrom;
  if (from !== undefined && (!from || typeof from !== 'object' || Array.isArray(from) || !desktopId(from.sessionId))) {
    fail('CLAUDE_DESKTOP_CATALOG_SHAPE', 'Claude 桌面的会话关联记录无法核对，已停止同步。');
  }
  const fork = record.forkedFromSessionId;
  if (fork !== undefined && !desktopId(fork)) fail('CLAUDE_DESKTOP_CATALOG_SHAPE', 'Claude 桌面的分叉会话记录无法核对，已停止同步。');
  const spawnedFrom = from ? {
    sessionId: desktopId(from.sessionId), sideSession: from.sideSession === true,
    sharedCheckout: from.sharedCheckout === true, sharedFolder: from.sharedFolder === true,
    userFork: from.userFork === true,
  } : undefined;
  const lineageDetached = record.lineageDetached === true;
  return { spawnedFrom, forkedFromSessionId: desktopId(fork), lineageDetached,
    parentIds: lineageDetached ? [] : [...new Set([spawnedFrom?.sessionId, desktopId(fork)].filter(Boolean))] };
}

function projectRecord(record, filename) {
  const id = desktopId(record?.sessionId);
  if (!id || filename.toLowerCase() !== `${id}.json`) fail('CLAUDE_DESKTOP_CATALOG_SHAPE', 'Claude 桌面会话编号与记录文件不一致。');
  if (!nonempty(record.cwd) || !path.isAbsolute(record.cwd)) fail('CLAUDE_DESKTOP_CATALOG_SHAPE', 'Claude 桌面的工作文件夹记录无法核对。');
  // The official desktop deletion also owns transcripts saved before /clear.
  const scalarIds = ['cliSessionId', 'unarchivedCliSessionId', 'historyOnlyCliSessionId', 'preClearCliSessionId'];
  for (const field of scalarIds) if (record[field] !== undefined && !uuid(record[field])) {
    fail('CLAUDE_DESKTOP_CATALOG_SHAPE', 'Claude 桌面的本地会话编号无法核对。');
  }
  const aliases = [];
  for (const field of ['priorCliSessionIds']) {
    if (record[field] !== undefined && (!Array.isArray(record[field]) || record[field].some(id => !uuid(id)))) {
      fail('CLAUDE_DESKTOP_CATALOG_SHAPE', 'Claude 桌面的历史会话编号无法核对。');
    }
    aliases.push(...(record[field] ?? []).map(uuid));
  }
  const ownIds = [...new Set([...scalarIds.map(field => uuid(record[field])), ...aliases].filter(Boolean))];
  const hasWorktree = ['worktreePath', 'worktreeName', 'worktreeLazy', 'keptWorktreeLeftover']
    .some(field => record[field] !== undefined && record[field] !== null && record[field] !== false && record[field] !== '')
    || (nonempty(record.branch) && nonempty(record.sourceBranch))
    || (record.folderWorktrees !== undefined && (!Array.isArray(record.folderWorktrees) || record.folderWorktrees.length > 0));
  return {
    desktopId: id, nativeIds: ownIds, cliSessionId: uuid(record.cliSessionId),
    unarchivedCliSessionId: uuid(record.unarchivedCliSessionId), cwd: record.cwd,
    originCwd: nonempty(record.originCwd) ? record.originCwd : record.cwd,
    title: typeof record.title === 'string' ? record.title.slice(0, 1000) : '',
    isArchived: record.isArchived === true, importedFrom: typeof record.importedFrom === 'string' ? record.importedFrom : undefined,
    hasRemoteBridge: !!(record.bridgeSessionId || record.bridgeSessionIds?.length || record.remoteControlSpawn || record.movedToCloud),
    hasStagedTranscript: nonempty(record.stagedTranscriptPath), hasWorktree,
    remote: !!(record.sshConfig || record.wslConfig || record.remoteTarget || record.backend?.remoteTarget
      || (record.backend?.kind && record.backend.kind !== 'local')),
    ...relationOf(record),
  };
}

async function readRecord(file, maxBytes) {
  await safePath(file, { kind: 'file' });
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) fail('CLAUDE_DESKTOP_CATALOG_SHAPE', 'Claude 桌面会话记录无法安全核对。');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    await safePath(file, { kind: 'file' });
    const current = await lstat(file);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      fail('CLAUDE_DESKTOP_CATALOG_CHANGED', 'Claude 桌面会话记录正在变化，请稍后重试。');
    }
    let record;
    try { record = JSON.parse(bytes.toString('utf8')); } catch { fail('CLAUDE_DESKTOP_CATALOG_SHAPE', 'Claude 桌面会话记录暂时无法读取。'); }
    // Discard all non-identity/safety metadata immediately; never expose it.
    return { row: projectRecord(record, path.basename(file)), hash: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}

export function createClaudeDesktopCatalog({ userDataRoots, roots, maxRecords = 3000, maxMetadataBytes = 4 * 1024 * 1024 } = {}) {
  userDataRoots ??= roots ?? defaultClaudeDesktopUserDataRoots();
  async function inventory() {
    const rows = [], roots = new Set(), watched = [];
    let scopes = 0;
    async function list(dir) {
      await safePath(dir);
      const entries = await readdir(dir, { withFileTypes: true });
      watched.push([dir, entries.map(e => `${e.name}:${e.isDirectory() ? 'd' : e.isFile() ? 'f' : 'other'}`).sort().join('\n')]);
      return entries;
    }
    for (const candidate of userDataRoots) {
      const root = await safePath(path.join(candidate, 'claude-code-sessions'), { optional: true });
      if (!root) continue;
      const key = process.platform === 'win32' ? root.toLowerCase() : root;
      if (roots.has(key)) continue; roots.add(key);
      for (const account of await list(root)) {
        if (!account.isDirectory() || !UUID.test(account.name)) {
          if (account.isSymbolicLink() || account.isDirectory()) fail('CLAUDE_DESKTOP_CATALOG_SHAPE', 'Claude 桌面会话目录结构无法完整核对。');
          continue;
        }
        for (const org of await list(path.join(root, account.name))) {
          if (!org.isDirectory() || !UUID.test(org.name)) {
            if (org.isSymbolicLink() || org.isDirectory()) fail('CLAUDE_DESKTOP_CATALOG_SHAPE', 'Claude 桌面会话目录结构无法完整核对。');
            continue;
          }
          const scope = path.join(root, account.name, org.name); scopes++;
          for (const file of await list(scope)) {
            if (!/^local_.*\.json$/i.test(file.name)) continue;
            if (!DESKTOP_ID.test(file.name.slice(0, -5)) || !file.isFile()) fail('CLAUDE_DESKTOP_CATALOG_SHAPE', 'Claude 桌面会话文件结构无法完整核对。');
            if (rows.length >= maxRecords) fail('CLAUDE_DESKTOP_CATALOG_LIMIT', 'Claude 桌面会话目录超过安全核对范围。');
            const filePath = path.join(scope, file.name);
            rows.push({ ...(await readRecord(filePath, maxMetadataBytes)), scope, filePath });
          }
        }
      }
    }
    if (!roots.size || !scopes) fail('CLAUDE_DESKTOP_CATALOG_UNKNOWN', '尚未找到完整的 Claude 桌面会话目录，不能把它当作已删除。');
    // Detect new/removed records during enumeration, including an empty scope.
    for (const [dir, before] of watched) {
      await safePath(dir);
      const after = (await readdir(dir, { withFileTypes: true })).map(e => `${e.name}:${e.isDirectory() ? 'd' : e.isFile() ? 'f' : 'other'}`).sort().join('\n');
      if (before !== after) fail('CLAUDE_DESKTOP_CATALOG_CHANGED', 'Claude 桌面会话列表正在变化，请稍后重试。');
    }
    for (const record of rows) {
      if ((await readRecord(record.filePath, maxMetadataBytes)).hash !== record.hash) {
        fail('CLAUDE_DESKTOP_CATALOG_CHANGED', 'Claude 桌面会话关联正在变化，请稍后重试。');
      }
    }
    return rows;
  }

  async function probe(value) {
    const sessionId = uuid(typeof value === 'string' ? value : value?.sessionId);
    if (!sessionId) fail('CLAUDE_DESKTOP_CATALOG_ID', 'Claude 会话编号无效，未执行删除。');
    try {
      const records = await inventory();
      const matches = records.filter(({ row }) => row.desktopId === `local_${sessionId}` || row.nativeIds.includes(sessionId));
      if (matches.length > 1) fail('CLAUDE_DESKTOP_CATALOG_AMBIGUOUS', '同一 Claude 会话关联了多个桌面入口，已停止以防误删。');
      const base = { sessionId, authority, runtimeVerified: false };
      if (!matches.length) return { ...base, status: 'absent' };
      const target = matches[0], related = new Map();
      const reached = new Set([target.row.desktopId]);
      let changed;
      do {
        changed = false;
        for (const other of records) {
          if (other === target) continue;
          const linked = other.row.parentIds.some(id => reached.has(id))
            || [...reached].some(id => records.find(r => r.row.desktopId === id)?.row.parentIds.includes(other.row.desktopId));
          if (linked && !reached.has(other.row.desktopId)) { reached.add(other.row.desktopId); related.set(other.row.desktopId, other.row); changed = true; }
        }
      } while (changed);
      // Only related identities/safety flags leave the scanner, never their titles.
      const relatedSessions = [...related.values()].map(({ desktopId, nativeIds, hasWorktree, remote }) => ({ desktopId, nativeIds, hasWorktree, remote }));
      return { ...base, status: 'present', ...target.row, relatedSessions,
        fingerprint: createHash('sha256').update(target.hash + records.filter(r => reached.has(r.row.desktopId)).map(r => r.hash).sort().join('')).digest('hex') };
    } catch (error) {
      if (error.code === 'CLAUDE_DESKTOP_CATALOG_AMBIGUOUS') throw error;
      return { sessionId, authority, runtimeVerified: false, status: 'unknown', reason: error.code || 'CLAUDE_DESKTOP_CATALOG_UNREADABLE',
        message: error.code?.startsWith('CLAUDE_DESKTOP_CATALOG_') ? error.message : '无法完整核对 Claude 桌面记录，请稍后重试。' };
    }
  }

  async function assertSafeForDelete(session, { allowedSessionIds = [] } = {}) {
    const result = await probe(session);
    if (result.status === 'unknown') fail(result.reason, result.message);
    if (result.status === 'absent') return result;
    const expected = session.cwd || session.projectPath;
    if (!samePath(result.cwd, expected)
      || !samePath(result.originCwd, expected) && !samePath(result.originCwd, session.projectPath)
      || (session.projectPath && !within(session.projectPath, expected))) {
      fail('CLAUDE_DESKTOP_CATALOG_CWD', 'Claude 桌面聊天的文件夹与工作台不一致，已停止以防误删。');
    }
    if (result.hasWorktree || result.remote) fail('CLAUDE_DESKTOP_CATALOG_WORKTREE', '这条 Claude 聊天关联了工作区或远程环境；为保留项目资料，未自动删除。');
    const allowed = new Set([result.sessionId, ...allowedSessionIds.map(nativeId).filter(Boolean)]);
    if (result.nativeIds.some(id => !allowed.has(id))) fail('CLAUDE_DESKTOP_CATALOG_ALIASES', '这条 Claude 桌面入口还关联了其他本地会话，已停止以防误删。');
    // The official desktop action may archive or reparent related sessions.
    // Even an explicitly listed sibling is not safe to modify as a side effect.
    if (result.relatedSessions.length > 0 || result.parentIds.length > 0) {
      fail('CLAUDE_DESKTOP_CATALOG_RELATED', '这条 Claude 桌面聊天关联了其他聊天，已停止以防影响它们。');
    }
    return result;
  }
  async function assertSafeForArchive(session, options = {}) {
    // Archiving can cascade through the same family and worktree paths as
    // deletion. Keep those ownership guards and reject remote bridge effects.
    let result;
    try { result = await assertSafeForDelete(session, options); }
    catch (error) {
      error.message = error.message.replace(/误删/g, '影响其他记录').replace(/未自动删除/g, '未自动归档或恢复');
      throw error;
    }
    if (result.status === 'present' && result.hasRemoteBridge) {
      fail('CLAUDE_DESKTOP_CATALOG_BRIDGE', '这条 Claude 聊天还关联远程会话，未自动归档或恢复。');
    }
    return result;
  }
  return { probe, assertSafeForDelete, assertSafeForArchive };
}
