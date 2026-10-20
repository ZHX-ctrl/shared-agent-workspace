import { spawn } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopIsRunning } from './native-project-sync.mjs';
import { projectPathKey } from './codex-projects.mjs';
import { openCodexThreadDeepLink } from './desktop-codex-projects.mjs';

const script = fileURLToPath(new URL('./desktop-menu.ps1', import.meta.url));
const fail = message => Object.assign(new Error(message), { code: 'DESKTOP_DELETE_PENDING' });
const title = item => item?.name || item?.title;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The desktop's own catalog is distinct from the CLI's rollout inventory. A
// missing rollout can leave a live desktop entry; never infer desktop absence
// from thread/read, a title, or a partially rendered sidebar. This adapter only
// reads the catalog used by the desktop's readEntry/readPage implementation.
// It never opens a writable database, migrates a schema, or changes its caches.
export function createDesktopThreadProbe({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  loadSqlite = () => import('node:sqlite'),
} = {}) {
  return async function probeThread({ sessionId, cwd } = {}) {
    const unknown = reason => ({ sessionId, status: 'unknown', source: 'codex-desktop-catalog', reason });
    if (!UUID.test(sessionId)) return unknown('invalid_identity');
    let db;
    try {
      const candidates = [];
      for (const name of ['codex.db', 'codex-dev.db']) {
        const filename = path.join(codexHome, 'sqlite', name);
        try {
          const stat = await lstat(filename);
          if (!stat.isFile() || stat.isSymbolicLink()) return unknown('unsafe_catalog_path');
          candidates.push({ filename, identity: `${name}:${stat.dev}:${stat.ino}` });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      // Do not choose the newest database: two app flavors may have different
      // catalogs. An ambiguous installation cannot prove the open app's state.
      if (candidates.length !== 1) return unknown('catalog_not_unique');
      const { DatabaseSync } = await loadSqlite();
      db = new DatabaseSync(candidates[0].filename, { readOnly: true });
      db.exec('PRAGMA query_only = ON; BEGIN');
      const host = db.prepare(`SELECT h.host_kind, s.initial_build_complete
        FROM local_thread_catalog_hosts h JOIN local_thread_catalog_sync_state s USING (host_id)
        WHERE h.host_id = ?`).get('local');
      if (host?.host_kind !== 'local' || host.initial_build_complete !== 1) return unknown('catalog_incomplete');
      const revision = db.prepare('SELECT catalog_revision FROM local_thread_catalog_metadata WHERE id = 1').get()?.catalog_revision;
      if (!Number.isSafeInteger(revision) || revision < 0) return unknown('catalog_schema_unknown');
      const row = db.prepare(`SELECT thread_id, display_title, cwd, missing_candidate
        FROM local_thread_catalog WHERE host_id = ? AND thread_id = ?`).get('local', sessionId);
      const evidence = { sessionId, source: 'codex-desktop-catalog', complete: true, revision,
        catalogIdentity: candidates[0].identity, checkedAt: new Date().toISOString() };
      if (!row) return { ...evidence, status: 'absent' };
      // A reconciliation candidate is not an authoritative deletion. Keep it
      // pending rather than guessing whether a renderer already removed it.
      if (row.missing_candidate !== 0 || row.thread_id !== sessionId) return unknown('catalog_pending');
      if (typeof row.cwd !== 'string' || !cwd || projectPathKey(row.cwd) !== projectPathKey(cwd)) return unknown('folder_mismatch');
      if (typeof row.display_title !== 'string' || !row.display_title.trim()) return unknown('title_missing');
      return { ...evidence, status: 'present', name: row.display_title };
    } catch { return unknown('catalog_unavailable'); }
    finally { if (db) db.close(); }
  };
}

export function runDesktopMenu(request, { spawnProcess = spawn, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const exe = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = spawnProcess(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env });
    let output = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(fail('桌面同步超时，尚未确认操作完成；工作台记录已保留。')); }, 35000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; if (output.length > 128000) { child.kill(); finish(fail('桌面响应超出核验范围。')); } });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(fail('无法启动 Windows 桌面同步组件。')));
    child.stdin.on('error', () => finish(fail('桌面同步组件未能读取请求。')));
    child.on('close', code => {
      let result; try { result = JSON.parse(output.replace(/^\uFEFF/, '').trim()); } catch { return finish(fail('无法核验桌面同步组件的响应。')); }
      if (code !== 0 || result.ok !== true) {
        const reason = String(result.error || `DESKTOP_HELPER_EXIT: ${code}`);
        const message = reason.includes('FOCUS_CHANGED') || reason.includes('CANCELLED') ? '桌面同步被切换窗口或 Esc 中止，记录已保留。'
          : reason.includes('AMBIGUOUS') || reason.includes('ID_MISMATCH') ? '无法唯一确认对应的 Codex 条目，已停止以防误删。'
          : 'Codex 桌面操作尚未通过核验，记录已保留；请保持桌面窗口可用后重试。';
        return finish(Object.assign(fail(message), { detail: reason }));
      }
      finish(null, result);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function createDesktopDeletionSync({ menu = runDesktopMenu, isRunning = desktopIsRunning,
  probeThread = createDesktopThreadProbe(), openThread = openCodexThreadDeepLink,
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  readState = async () => JSON.parse(await readFile(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), '.codex-global-state.json'), 'utf8')) } = {}) {
  async function registration(project) {
    const state = await readState();
    if (!state || !Array.isArray(state['project-order']) || !state['local-projects']) throw fail('无法核验 Codex 桌面项目登记，未执行移除。');
    const rows = Object.values(state['local-projects']).filter(p => state['project-order'].includes(p.id));
    const matches = rows.filter(p => p.rootPaths?.some(root => projectPathKey(root) === projectPathKey(project.path)));
    if (matches.length > 1) throw fail('此目录对应多个桌面项目，未执行移除。');
    const target = matches[0];
    if (!target) return null;
    if (target.rootPaths.length !== 1 || (project.desktopCodex?.projectId && project.desktopCodex.projectId !== target.id)
      || rows.filter(p => p.name === target.name).length !== 1) throw fail('桌面项目编号、目录或名称存在冲突，未执行移除。');
    return target;
  }
  return {
    async removeProject(project) {
      const target = await registration(project);
      if (!target) return { status: 'absent', checkedAt: new Date().toISOString() };
      if (!await isRunning()) return { waiting: true, status: 'waiting_desktop' };
      await menu({ operation: 'removeProject', name: target.name });
      if (await registration(project)) throw fail('Codex 桌面项目入口仍然存在，未标记同步成功。');
      return { status: 'removed', checkedAt: new Date().toISOString() };
    },
    async beforeDelete({ targets, sessions, project, completed = [], alreadyAbsent = [], verifyAbsent,
      onProgress = async () => {} }) {
      const displayed = new Set(project?.desktopCodex?.sessionIds || []);
      const nativeAbsent = new Set(alreadyAbsent);
      const hasReceipt = id => completed.some(item => item.sessionId === id && item.desktop === true
        && (!item.agent || item.agent === 'codex') && (!item.operation || item.operation === 'delete'));
      if (!targets.length && !sessions.length) return { status: 'not_applicable', sessions: [] };
      if (sessions.length && sessions.every(s => hasReceipt(s.sessionId)))
        return { status: 'verified', sessions: sessions.map(s => s.sessionId), checkedAt: new Date().toISOString() };
      const running = await isRunning();
      const rootIds = new Set(sessions.map(s => s.sessionId));
      const rows = [...targets];
      for (const session of sessions) if (!rows.some(t => t.id === session.sessionId)) rows.push({ id: session.sessionId, cwd: session.cwd, name: session.desktopTitle });
      const receipts = [];
      for (const row of rows) {
        if (hasReceipt(row.id)) { receipts.push(row.id); continue; }
        const probe = await probeThread({ sessionId: row.id, cwd: row.cwd });
        if (probe?.sessionId === row.id && probe.reason === 'folder_mismatch') {
          throw fail('Codex 桌面聊天目录与工作台关联的文件夹不一致，已停止以防误删。');
        }
        const exactProbe = probe?.sessionId === row.id && probe.complete === true
          && probe.source === 'codex-desktop-catalog';
        if (nativeAbsent.has(row.id) && exactProbe && probe.status === 'absent') {
          // Recheck both stores after the initial probe. A restored native chat
          // or a newly observed desktop entry must not be forgotten on a retry.
          if (typeof verifyAbsent !== 'function' || !await verifyAbsent(row.id)) throw fail('Codex 会话状态在核验期间发生变化，工作台记录已保留。');
          const again = await probeThread({ sessionId: row.id, cwd: row.cwd });
          if (again?.sessionId !== row.id || again.source !== 'codex-desktop-catalog'
            || again.complete !== true || again.status !== 'absent'
            || again.catalogIdentity !== probe.catalogIdentity
            || (Number.isSafeInteger(probe.revision) && (!Number.isSafeInteger(again.revision) || again.revision < probe.revision))) {
            throw fail('Codex 桌面目录状态在核验期间发生变化，工作台记录已保留。');
          }
          receipts.push(row.id);
          await onProgress({ agent: 'codex', sessionId: row.id, desktop: true, operation: 'delete',
            alreadyAbsent: true, verifiedBy: 'native-and-desktop-catalog', checkedAt: new Date().toISOString() });
          continue;
        }
        if (!running) {
          if (displayed.has(row.id) || (exactProbe && probe.status === 'present')) throw fail('请打开 Codex 桌面以完成对应入口的自动清理；不需要退出或手动删除。');
          if (nativeAbsent.has(row.id)) throw fail('本地会话已不存在，但暂时无法核验 Codex 桌面目录；工作台记录已保留，请重试。');
          continue;
        }
        if (nativeAbsent.has(row.id) && (!exactProbe || probe.status !== 'present')) {
          throw fail('本地会话已不存在，但暂时无法核验 Codex 桌面目录；工作台记录已保留，请重试。');
        }
        if (exactProbe && probe.status === 'present') {
          // A different provider may own foreground activation after mixed
          // cleanup. The official exact-UUID route lets Windows activate Codex;
          // row identity is still verified from that row's own copied link.
          await openThread(row.id); await delay(500);
          const current = await probeThread({ sessionId: row.id, cwd: row.cwd });
          if (current?.sessionId !== row.id || current.source !== 'codex-desktop-catalog'
            || current.complete !== true || current.status !== 'present' || current.name !== probe.name
            || current.catalogIdentity !== probe.catalogIdentity
            || Number.isSafeInteger(probe.revision) && (!Number.isSafeInteger(current.revision) || current.revision < probe.revision)) {
            throw fail('Codex 聊天入口在打开期间发生变化，已停止删除，请重试。');
          }
        }
        const names = (await menu({ operation: 'inspect' })).names;
        if (!Array.isArray(names)) throw fail('桌面侧边栏核验失败。');
        const name = exactProbe && probe.status === 'present' ? probe.name : title(row);
        if (!name || !names.includes(name)) {
          if (displayed.has(row.id) && rootIds.has(row.id)) throw fail('对应 Codex 聊天入口暂不可见或标题已变化，未删除会话文件。');
          continue;
        }
        await menu({ operation: 'deleteThread', name, threadId: row.id });
        const after = (await menu({ operation: 'inspect' })).names;
        if (!Array.isArray(after) || after.includes(name)) throw fail('Codex 桌面聊天仍然存在，未标记同步成功。');
        receipts.push(row.id);
        await onProgress({ agent: 'codex', sessionId: row.id, desktop: true, operation: 'delete', checkedAt: new Date().toISOString() });
      }
      return { status: receipts.length ? 'verified' : 'not_registered', sessions: receipts, checkedAt: new Date().toISOString() };
    },
  };
}
