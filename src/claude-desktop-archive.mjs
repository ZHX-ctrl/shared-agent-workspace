import path from 'node:path';
import os from 'node:os';
import { realpath } from 'node:fs/promises';
import { createClaudeDesktopCatalog } from './claude-desktop-catalog.mjs';
import { openClaudeDesktopId, runClaudeDesktopMenu } from './claude-desktop-deletion.mjs';
import { readClaudeActiveSessions } from './claude-chat-lifecycle.mjs';
import { resolveCli } from './adapters/process.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const fail = message => Object.assign(new Error(message), { code: 'CLAUDE_DESKTOP_ARCHIVE_PENDING' });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The caller holds the exact Claude lifecycle locks during apply. Native
 * transcripts stay in place; Desktop's own reversible operation owns visibility.
 * An absent persisted entry needs an additional exact-ID live not-found proof
 * before the caller may retain its existing local-vault behavior. */
export function createClaudeDesktopArchive({ catalog = createClaudeDesktopCatalog(), open = openClaudeDesktopId,
  menu = runClaudeDesktopMenu, delay = wait, getActiveSessions, cli,
  claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) {
  const plans = new WeakSet();
  async function idle(session) {
    let rows;
    try {
      const executable = cli || resolveCli('claude');
      if (!getActiveSessions && !executable) throw Error('missing CLI');
      rows = getActiveSessions ? await getActiveSessions() : await readClaudeActiveSessions(executable, { claudeHome });
    } catch { throw fail('无法确认 Claude 会话当前状态，未继续归档或恢复。'); }
    if (!Array.isArray(rows)) throw fail('Claude 活动会话列表无法核对。');
    for (const row of rows) {
      if (row.sessionId?.toLowerCase() === session.sessionId.toLowerCase()) {
        if (row.kind === 'interactive' && row.status === 'idle') continue;
        if (!row.pid && ['done', 'failed', 'stopped'].includes(row.state)) continue;
        throw fail('这条 Claude 聊天仍在执行任务或等待批准，请任务结束后再归档或恢复。');
      }
      if (!row.sessionId && (row.pid || row.status || row.kind === 'interactive')) {
        if (!row.cwd || !path.isAbsolute(row.cwd)) throw fail('存在身份不明的 Claude 活动会话，已停止同步。');
        const relative = path.relative(key(session.projectPath), key(row.cwd));
        if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
          throw fail('同一项目有身份不明的 Claude 活动会话，已停止同步。');
        }
      }
    }
  }
  async function prepare({ operation, sessions }) {
    if (!['archive', 'unarchive'].includes(operation) || !Array.isArray(sessions)) throw fail('Claude 桌面归档操作无效。');
    const targets = [], unregistered = [], unregisteredSessionIds = [], unique = new Map();
    for (const session of sessions) {
      if (session.agent !== 'claude' || !UUID.test(session.sessionId) || !path.isAbsolute(session.cwd || '') || !path.isAbsolute(session.projectPath || '')) throw fail('Claude 会话关联无效。');
      const cwd = await realpath(session.cwd), project = await realpath(session.projectPath), relative = path.relative(key(project), key(cwd));
      if (key(cwd) !== key(session.cwd) || key(project) !== key(session.projectPath) || relative.startsWith('..') || path.isAbsolute(relative)) throw fail('Claude 会话目录与项目不一致。');
      const prior = unique.get(session.sessionId);
      if (prior && (key(prior.cwd) !== key(session.cwd) || key(prior.projectPath) !== key(session.projectPath))) throw fail('Claude 会话关联冲突。');
      unique.set(session.sessionId, { ...session });
    }
    const ids = [...unique.keys()];
    for (const session of unique.values()) {
      const row = await catalog.assertSafeForArchive(session, { allowedSessionIds: ids });
      if (row.status === 'unknown') throw fail('Claude 桌面目录无法完整核对，未继续归档或恢复。');
      if (row.status === 'absent') { unregisteredSessionIds.push(session.sessionId); unregistered.push(Object.freeze({ ...session })); continue; }
      if (row.status !== 'present' || typeof row.isArchived !== 'boolean') throw fail('Claude 桌面归档状态无法核对。');
      await idle(session);
      targets.push(Object.freeze({ session: Object.freeze({ ...session }), row: Object.freeze({ ...row }) }));
    }
    const desktopSessionIds = targets.map(t => t.session.sessionId);
    const plan = Object.freeze({ operation, targets: Object.freeze(targets), unregistered: Object.freeze(unregistered), desktopSessionIds: Object.freeze(desktopSessionIds),
      unregisteredSessionIds: Object.freeze(unregisteredSessionIds), allowIdleSessionIds: Object.freeze([...desktopSessionIds]) });
    plans.add(plan); return plan;
  }
  async function apply(plan, { onProgress = async () => {} } = {}) {
    if (!plans.has(plan)) throw fail('Claude 桌面归档计划无效。');
    const desired = plan.operation === 'archive', changed = [], alreadyInState = [];
    const verifiedAbsent = [];
    // Disk metadata is debounced. Before any local-vault move, prove each
    // canonical imported UUID is also absent from the live official app.
    for (const session of plan.unregistered) {
      const desktopId = `local_${session.sessionId}`;
      const before = await catalog.assertSafeForArchive(session, { allowedSessionIds: plan.unregisteredSessionIds });
      if (before.status !== 'absent') throw fail('Claude 桌面会话列表发生变化，未暂存本地会话。');
      await open(desktopId);
      let proof;
      try { proof = await menu({ operation: 'verifyAbsent', desktopId }); }
      catch (error) { throw Object.assign(fail('无法确认 Claude 桌面没有对应入口，未暂存本地会话。'), { detail: error.detail || error.message }); }
      if (proof.result !== 'absent' || (await catalog.assertSafeForArchive(session, { allowedSessionIds: plan.unregisteredSessionIds })).status !== 'absent') {
        throw fail('Claude 桌面仍可能保留对应聊天，未暂存本地会话。');
      }
      verifiedAbsent.push(session.sessionId);
    }
    if (verifiedAbsent.length) await open('home');
    for (const { session, row } of plan.targets) {
      let current = await catalog.assertSafeForArchive(session, { allowedSessionIds: plan.desktopSessionIds });
      if (current.status !== 'present' || current.desktopId !== row.desktopId || current.title !== row.title
        || current.fingerprint !== row.fingerprint) throw fail('Claude 桌面聊天在核对期间变化，请重试归档或恢复。');
      await idle(session);
      await open(current.desktopId);
      current = await catalog.assertSafeForArchive(session, { allowedSessionIds: plan.desktopSessionIds });
      if (current.status !== 'present' || current.desktopId !== row.desktopId || current.title !== row.title
        || current.fingerprint !== row.fingerprint) throw fail('Claude 桌面聊天身份已变化，未操作归档菜单。');
      await idle(session);
      const wasDesired = current.isArchived === desired;
      let checked;
      try {
        checked = await menu({ operation: wasDesired ? (desired ? 'verifyArchived' : 'verifyUnarchived') : (desired ? 'archiveCurrent' : 'unarchiveCurrent'),
          desktopId: current.desktopId, title: current.title });
      } catch (error) {
        const detail = String(error.detail || error.message || '');
        const message = /FOCUS_CHANGED|CANCELLED|切换窗口|Esc/.test(detail)
          ? '切换窗口或 Esc 中止了 Claude 桌面归档同步，工作台记录已保留；可重试。'
          : 'Claude 桌面归档或恢复尚未通过核验，工作台记录已保留；可重试。';
        throw Object.assign(fail(message), { detail });
      }
      if (checked.result !== (desired ? 'archived' : 'unarchived')) throw fail('Claude 桌面尚未确认归档状态，工作台记录已保留。');
      let confirmed = false;
      for (let n = 0; n < 40; n++) {
        try { current = await catalog.assertSafeForArchive(session, { allowedSessionIds: plan.desktopSessionIds }); }
        catch (error) {
          // The official operation saves several metadata fields asynchronously.
          // Retry only this explicit read-consistency race; never invoke its
          // menu a second time or forgive ownership/schema/relationship errors.
          if (error.code !== 'CLAUDE_DESKTOP_CATALOG_CHANGED' || n === 39) throw error;
          await delay(100); continue;
        }
        if (current.status !== 'present' || current.desktopId !== row.desktopId || current.title !== row.title) throw fail('Claude 桌面归档后的会话身份无法核对。');
        if (current.isArchived === desired) { confirmed = true; break; }
        await delay(100);
      }
      if (!confirmed) throw fail('Claude 桌面归档状态尚未保存，工作台记录已保留；可重试。');
      (wasDesired ? alreadyInState : changed).push(session.sessionId);
      await onProgress({ agent: 'claude', sessionId: session.sessionId, operation: plan.operation,
        desktop: true, archiveKind: 'claude-desktop-native', checkedAt: new Date().toISOString() });
    }
    return { status: 'verified', operation: plan.operation, sessions: [...plan.desktopSessionIds],
      changed, alreadyInState, unregisteredSessionIds: [...plan.unregisteredSessionIds], verifiedAbsent,
      archiveMode: !plan.desktopSessionIds.length ? 'local-vault' : plan.unregisteredSessionIds.length ? 'mixed' : 'desktop-native', checkedAt: new Date().toISOString() };
  }
  return { prepare, apply };
}
