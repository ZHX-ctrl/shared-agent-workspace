import { lstat, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createDesktopThreadProbe, runDesktopMenu } from './desktop-deletion.mjs';
import { desktopIsRunning } from './native-project-sync.mjs';
import { openCodexThreadDeepLink } from './desktop-codex-projects.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exec = promisify(execFile);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const fail = message => Object.assign(new Error(message), { code: 'DESKTOP_ARCHIVE_PENDING' });

// The desktop catalog contains only active sidebar entries. A missing catalog
// row is NOT proof of an archive. Read the official native metadata separately;
// only the exact identity, cwd, title and archive flag are selected, never text,
// account information, or credentials. Both databases remain read-only.
export function createDesktopArchiveProbe({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  probeThread = createDesktopThreadProbe({ codexHome }),
  loadSqlite = () => import('node:sqlite'),
} = {}) {
  return async session => {
    const unknown = reason => ({ sessionId: session.sessionId, status: 'unknown', reason });
    if (!UUID.test(session.sessionId)) return unknown('invalid_identity');
    let db;
    try {
      const desktop = await probeThread(session);
      if (desktop.sessionId !== session.sessionId || desktop.complete !== true || !['present', 'absent'].includes(desktop.status)) return unknown(desktop.reason || 'desktop_unknown');
      const files = (await readdir(codexHome)).filter(name => /^state_\d+\.sqlite$/.test(name));
      if (files.length !== 1) return unknown('native_catalog_not_unique');
      const filename = path.join(codexHome, files[0]);
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) return unknown('unsafe_native_catalog');
      const { DatabaseSync } = await loadSqlite();
      db = new DatabaseSync(filename, { readOnly: true });
      db.exec('PRAGMA query_only = ON; BEGIN');
      const row = db.prepare('SELECT id, cwd, name, title, archived FROM threads WHERE id = ?').get(session.sessionId);
      if (!row || row.id !== session.sessionId || ![0, 1].includes(row.archived)) return unknown('native_identity_missing');
      if (typeof row.cwd !== 'string' || key(await realpath(row.cwd)) !== key(await realpath(session.cwd))) return unknown('folder_mismatch');
      const name = desktop.status === 'present' ? desktop.name : (row.name?.trim() || row.title?.trim());
      if (!name || typeof name !== 'string') return unknown('title_missing');
      db.close(); db = null;
      const desktopFile = desktop.catalogIdentity?.split(':')[0];
      if (!['codex.db', 'codex-dev.db'].includes(desktopFile)) return unknown('desktop_identity_unknown');
      db = new DatabaseSync(path.join(codexHome, 'sqlite', desktopFile), { readOnly: true });
      db.exec('PRAGMA query_only = ON; BEGIN');
      const automationCount = db.prepare('SELECT COUNT(*) AS count FROM automations WHERE target_thread_id = ?').get(session.sessionId)?.count;
      if (!Number.isSafeInteger(automationCount)) return unknown('automation_scope_unknown');
      return { sessionId: session.sessionId, status: desktop.status, name, cwd: row.cwd,
        complete: true, source: 'codex-desktop-and-native-catalogs', isArchived: row.archived === 1,
        hasAutomation: automationCount > 0,
        catalogIdentity: desktop.catalogIdentity, revision: desktop.revision,
        archiveIdentity: `${files[0]}:${info.dev}:${info.ino}`, checkedAt: new Date().toISOString() };
    } catch { return unknown('archive_catalog_unavailable'); }
    finally { db?.close(); }
  };
}

export async function openCodexSettingsPage({ run = exec, env = process.env } = {}) {
  const systemRoot = env.SystemRoot || 'C:\\Windows';
  if (!path.win32.isAbsolute(systemRoot)) throw fail('Windows 系统目录无效。');
  const executable = path.win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "Start-Process -FilePath 'codex://settings/general-settings' -WindowStyle Hidden -ErrorAction Stop"],
  { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 16384, env });
}

export function createDesktopArchiveSync({ menu = runDesktopMenu, isRunning = desktopIsRunning,
  probeThread = createDesktopArchiveProbe(), openThread = openCodexThreadDeepLink,
  openNeutral = openCodexSettingsPage, delay = sleep, maxChecks = 20 } = {}) {
  const plans = new WeakSet();
  let applying = false;
  const valid = (probe, session) => probe?.complete === true && probe.sessionId === session.sessionId
    && probe.source === 'codex-desktop-and-native-catalogs' && ['present', 'absent'].includes(probe.status)
    && typeof probe.isArchived === 'boolean' && typeof probe.name === 'string' && probe.name.trim();
  const desired = (probe, operation) => probe.isArchived === (operation === 'archive')
    && probe.status === (operation === 'archive' ? 'absent' : 'present');
  const consistent = (before, after) => before.catalogIdentity === after.catalogIdentity
    && before.archiveIdentity === after.archiveIdentity && Number.isSafeInteger(after.revision)
    && after.revision >= before.revision;

  return {
    async prepare({ operation, sessions, targets = [], project }) {
      if (!['archive', 'unarchive'].includes(operation) || !Array.isArray(sessions)) throw fail('Codex 桌面归档操作无效。');
      const items = [], safety = [], seen = new Set();
      const rootIds = new Set(sessions.map(session => session.sessionId));
      const children = targets.filter(target => !rootIds.has(target.id)).map(target => ({
        agent: 'codex', sessionId: target.id, cwd: target.cwd,
        projectPath: sessions.find(session => session.sessionId === target.rootId)?.projectPath || project?.path,
      }));
      for (const supplied of [...sessions, ...children]) {
        if (supplied.agent && supplied.agent !== 'codex') throw fail('Codex 桌面归档会话关联无效。');
        if (!UUID.test(supplied.sessionId) || !path.isAbsolute(supplied.cwd || '') || seen.has(supplied.sessionId)) throw fail('Codex 桌面归档会话身份无效或重复。');
        seen.add(supplied.sessionId);
        const cwd = await realpath(supplied.cwd), projectPath = await realpath(supplied.projectPath || project?.path || '');
        const relative = path.relative(key(projectPath), key(cwd));
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw fail('对应 Codex 聊天不属于该项目，已停止同步。');
        // Managed worktrees can trigger the official app's cleanup behavior.
        if (/(?:^|[\\/])(?:\.codex|\.worktrees|worktrees)[\\/]/i.test(cwd)) throw fail('此聊天使用工作树，自动归档可能清理工作区，已保留聊天和资料。');
        try { const git = await lstat(path.join(cwd, '.git')); if (git.isFile() || git.isSymbolicLink()) throw fail('此聊天可能使用工作树或关联仓库，已停止自动归档以保护项目资料。'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const session = Object.freeze({ ...supplied, cwd, projectPath });
        const probe = await probeThread(session);
        if (!valid(probe, session)) throw fail('暂时无法核验 Codex 桌面聊天的归档状态，记录已保留。');
        if (operation === 'archive' && probe.hasAutomation !== false) throw fail('此聊天或子任务关联了定时任务，自动归档可能移除该任务，已停止同步。');
        const item = Object.freeze({ session, probe: Object.freeze({ ...probe }) });
        safety.push(item); if (rootIds.has(session.sessionId)) items.push(item);
      }
      if (items.length && !await isRunning()) throw fail('请打开 Codex 桌面以同步归档状态；不需要退出或手动操作聊天。');
      const plan = Object.freeze({ operation, items: Object.freeze(items), safety: Object.freeze(safety) }); plans.add(plan); return plan;
    },
    async apply(plan, { onProgress = async () => {} } = {}) {
      if (!plans.has(plan)) throw fail('Codex 桌面归档计划无效，请重新核验。');
      if (applying) throw fail('另一个 Codex 桌面归档操作正在进行，请稍后重试。');
      applying = true;
      const sessions = [], alreadyInState = [], verificationMethods = [], warnings = [];
      try {
        // Preflight every target before the first irreversible desktop action.
        for (const item of plan.safety) {
          const current = await probeThread(item.session);
          if (!valid(current, item.session) || !consistent(item.probe, current)) throw fail('Codex 归档记录在核验期间发生变化，请重试。');
          if (plan.operation === 'archive' && current.hasAutomation !== false) throw fail('对应聊天或子任务新增了定时任务，已停止归档。');
        }
        for (const item of plan.items) {
          if (!await isRunning()) throw fail('Codex 桌面暂不可用，工作台保留记录供重试。');
          const current = await probeThread(item.session);
          if (!valid(current, item.session) || !consistent(item.probe, current)) throw fail('Codex 聊天身份发生变化，已停止同步。');
          if (plan.operation === 'archive' && current.hasAutomation !== false) throw fail('对应聊天新增了定时任务，已停止归档。');
          const wasDone = desired(current, plan.operation);
          const readOnlyArchive = plan.operation === 'archive' && wasDone;
          // Restore through the desktop's own action before the outer native
          // fallback. Its handler calls thread/unarchive, hydrates the thread,
          // then broadcasts the cache invalidation. Pre-restoring through a
          // separate CLI can make that action fail before it clears the cached
          // archived state. The controlled route proof below handles archived
          // placeholders without changing the native state first.
          // The official local-thread route detects archived IDs and opens the
          // archived preview (or its dedicated Unarchive-and-open screen).
          // Opening an exact UUID avoids the separate settings archive list,
          // whose older row layout has neither a preview link nor a UUID label.
          // An already archived exact UUID is proven by two independent saved
          // catalogs; no UI mutation or title-only archived-row lookup is needed.
          let transitionProof;
          if (plan.operation === 'unarchive' && current.status !== 'present') {
            // A same-UUID navigation can retain the old archived route. Leave
            // through an official settings route first; this changes no setting
            // and creates no new conversation, then enter only the verified ID.
            await openNeutral(); await delay(500);
            const neutral = await menu({ operation: 'verifyArchiveNeutral' });
            const proof = neutral?.proof;
            if (neutral?.result !== 'neutral' || !Number.isSafeInteger(proof?.pid) || proof.pid <= 0
                || !Number.isSafeInteger(proof.hwnd) || proof.hwnd <= 0 || !Number.isSafeInteger(proof.lastInputTick)
                || proof.lastInputTick < 0 || proof.lastInputTick > 0xffffffff || !Number.isSafeInteger(proof.checkedAt)
                || Date.now() - proof.checkedAt < 0 || Date.now() - proof.checkedAt > 15000) throw fail('Codex 中立页面尚未通过核验，已停止恢复。');
            transitionProof = Object.freeze({ ...proof });
          }
          if (!readOnlyArchive) await openThread(item.session.sessionId);
          await delay(500);
          const check = await probeThread(item.session);
          if (!valid(check, item.session) || !consistent(current, check) || check.name !== current.name
            || check.isArchived !== current.isArchived
            || readOnlyArchive && (check.revision !== current.revision || !desired(check, 'archive'))) throw fail('Codex 聊天在核验期间发生变化，请重试。');
          if (plan.operation === 'archive' && check.hasAutomation !== false) throw fail('对应聊天新增了定时任务，已停止归档。');
          let result;
          const menuOperation = plan.operation === 'unarchive' && check.status === 'absent' ? 'unarchiveThread'
            : wasDone || plan.operation === 'unarchive' ? 'verifyThreadArchive' : 'archiveThread';
          try { result = readOnlyArchive ? { result: 'archived' } : await menu({ operation: menuOperation,
            name: check.name, threadId: item.session.sessionId, archived: plan.operation === 'archive',
            ...(transitionProof ? { transitionProof } : {}) }); }
          catch (error) {
            const verb = plan.operation === 'archive' ? '归档' : '恢复';
            const detail = String(error?.detail || error?.message || 'DESKTOP_MENU_FAILED');
            const message = /FOCUS_CHANGED|CANCELLED|INPUT_CHANGED|TRANSITION_PROOF_EXPIRED_OR_CHANGED/.test(detail) ? `Codex 桌面${verb}因键鼠操作、切换窗口或等待超时而中止，记录已保留，可重试。`
              : /UNSAFE_SIDE_EFFECT/.test(detail) ? '对应聊天仍在运行或关联定时任务，已停止归档以保留工作和任务。'
              : /AMBIGUOUS|ID_MISMATCH/.test(detail) ? `无法唯一确认对应的 Codex 聊天，已停止${verb}，其他聊天未改动。`
              : `Codex 桌面${verb}尚未通过核验，工作台已保留记录供重试。`;
            throw Object.assign(fail(message), { detail });
          }
          if (result?.result !== (plan.operation === 'archive' ? 'archived' : 'unarchived')) throw fail('Codex 桌面未返回对应归档操作的确认，工作台记录已保留。');
          let verified;
          for (let attempt = 0; attempt < maxChecks; attempt++) {
            const after = await probeThread(item.session);
            if (!valid(after, item.session) || !consistent(check, after)) throw fail('Codex 桌面归档后的身份核验未通过，记录已保留。');
            if (desired(after, plan.operation)) { verified = after; break; }
            await delay(250);
          }
          if (!verified) throw fail('Codex 桌面与本地归档状态尚未一致，请重试同步。');
          if (result.clipboardRestoreStatus === 'failed') warnings.push({ code: 'CLIPBOARD_RESTORE_FAILED',
            message: '聊天同步已完成，但同步前的剪贴板内容未能自动还原。', sessionId: item.session.sessionId,
            detail: result.clipboardRestoreError || 'DESKTOP_CLIPBOARD_RESTORE_FAILED' });
          sessions.push(item.session.sessionId); if (wasDone) alreadyInState.push(item.session.sessionId);
          const verifiedBy = readOnlyArchive ? 'native-and-desktop-catalogs'
            : result.identityMethod === 'neutral-route-transition-and-final-copied-deeplink' ? 'official-route-transition-final-uuid-and-catalogs' : 'official-menu-and-native-catalog';
          verificationMethods.push(verifiedBy);
          await onProgress({ agent: 'codex', sessionId: item.session.sessionId, desktop: true,
            operation: plan.operation, alreadyInState: wasDone, verifiedBy, checkedAt: new Date().toISOString() });
        }
        return { status: 'verified', operation: plan.operation, sessions, alreadyInState,
          ...(warnings.length ? { clipboardRestoreStatus: 'failed', warnings } : {}),
          verifiedBy: new Set(verificationMethods).size === 1 ? verificationMethods[0] : 'verified-per-session',
          checkedAt: new Date().toISOString() };
      } finally { applying = false; }
    },
  };
}
import { execFile } from 'node:child_process';
