import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClaudeDesktopCatalog } from './claude-desktop-catalog.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = message => Object.assign(new Error(message), { code: 'CLAUDE_DESKTOP_DELETE_PENDING' });
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// The installed app handles /epitaxy/<id> as navigation only; unlike
// `claude --desktop --resume`, this never imports or recreates a deleted session.
export async function openClaudeDesktopId(desktopId, { spawnProcess = spawn, env = process.env } = {}) {
  if (desktopId !== 'home' && (typeof desktopId !== 'string' || !desktopId.startsWith('local_') || !UUID.test(desktopId.slice(6)))) throw fail('Claude 桌面会话编号无效。');
  const uri = desktopId === 'home' ? 'claude://claude.ai/epitaxy' : `claude://claude.ai/epitaxy/${desktopId}`;
  await new Promise((resolve, reject) => {
    const child = spawnProcess(path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32/rundll32.exe'),
      ['url.dll,FileProtocolHandler', uri], { windowsHide: true, shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(fail('Claude 桌面导航超时，未执行删除。')); }, 8000);
    child.on('error', () => { clearTimeout(timer); reject(fail('无法打开对应的 Claude 桌面入口。')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(fail('Claude 桌面导航未成功，未执行删除。')); });
  });
}

export function runClaudeDesktopMenu(request, { spawnProcess = spawn, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./claude-desktop-menu.ps1', import.meta.url))],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env });
    let output = '', settled = false, stderrBytes = 0;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(fail('Claude 桌面清理超时，工作台记录已保留；可重试。')); }, 30000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; if (output.length > 64000) { child.kill(); finish(fail('Claude 桌面返回结果无法核验。')); } });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
    child.on('error', () => finish(fail('无法启动 Claude 桌面同步组件。')));
    child.stdin.on('error', () => finish(fail('Claude 桌面同步组件没有接收请求。')));
    child.on('close', code => {
      let result; try { result = JSON.parse(output.replace(/^\uFEFF/, '').trim()); } catch { return finish(fail('Claude 桌面同步组件没有返回可核验结果。')); }
      if (code !== 0 || result.ok !== true) {
        const safeError = String(result.error || 'CLAUDE_HELPER_FAILED').match(/^CLAUDE_[A-Z_]+(?::[a-zA-Z0-9_:-]+)?$/)?.[0] || 'CLAUDE_HELPER_FAILED';
        const stage = /^[a-z-]{1,60}$/.test(result.stage || '') ? result.stage : 'unknown-stage';
        const detail = `${safeError}:${stage}:exit-${code}`;
        const message = /FOCUS_CHANGED|CANCELLED/.test(detail) ? '切换窗口或 Esc 中止了 Claude 桌面同步，工作台记录已保留。'
          : /AMBIGUOUS|MISMATCH/.test(detail) ? '无法唯一确认对应的 Claude 桌面聊天，已停止以防误删。'
          : 'Claude 桌面操作尚未通过核验，工作台记录已保留；请稍后重试。';
        return finish(Object.assign(fail(message), { detail, diagnostic: { exitCode: code, stderrBytes,
          ok: result.ok === true, stage, error: safeError,
          exceptionType: /^[A-Za-z0-9_.]{1,120}$/.test(result.exceptionType || '') ? result.exceptionType : undefined } }));
      }
      finish(null, result);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function createClaudeDesktopDeletion({ catalog = createClaudeDesktopCatalog(), open = openClaudeDesktopId,
  menu = runClaudeDesktopMenu, delay = wait } = {}) {
  const plans = new WeakSet();
  async function prepare({ sessions }) {
    const targets = [], ids = sessions.map(s => s.sessionId);
    for (const session of sessions) {
      if (session.agent !== 'claude' || !UUID.test(session.sessionId) || !path.isAbsolute(session.cwd || '') || !path.isAbsolute(session.projectPath || '')) throw fail('Claude 会话关联无效。');
      const cwd = await realpath(session.cwd), project = await realpath(session.projectPath), relative = path.relative(key(project), key(cwd));
      if (key(cwd) !== key(session.cwd) || key(project) !== key(session.projectPath) || relative.startsWith('..') || path.isAbsolute(relative)) throw fail('Claude 会话目录与项目不一致。');
      const row = await catalog.assertSafeForDelete(session, { allowedSessionIds: ids });
      targets.push({ session: { ...session }, row });
    }
    const plan = { targets, allowIdleSessionIds: targets.filter(t => t.row.status === 'present').map(t => t.session.sessionId) };
    plans.add(plan); return plan;
  }
  async function apply(plan, { onProgress = async () => {} } = {}) {
    if (!plans.has(plan)) throw fail('Claude 桌面删除计划无效。');
    const ids = plan.targets.map(t => t.session.sessionId), alreadyAbsent = [], deleted = [];
    for (const target of plan.targets) {
      const { session } = target;
      let current = await catalog.assertSafeForDelete(session, { allowedSessionIds: ids });
      if (current.status === 'present') {
        if (target.row.status !== 'present' || current.desktopId !== target.row.desktopId || current.fingerprint !== target.row.fingerprint) throw fail('Claude 桌面聊天在核对期间发生变化，未继续删除。');
        await open(current.desktopId);
        // Recheck ownership after navigation, before the official menu acts.
        current = await catalog.assertSafeForDelete(session, { allowedSessionIds: ids });
        if (current.status !== 'present' || current.desktopId !== target.row.desktopId || current.title !== target.row.title
          || current.fingerprint !== target.row.fingerprint) throw fail('Claude 桌面聊天身份已变化，未继续删除。');
        await menu({ operation: 'deleteCurrent', desktopId: current.desktopId, title: current.title });
        deleted.push(session.sessionId);
        for (let n = 0; n < 30; n++) {
          current = await catalog.probe(session);
          if (current.status === 'absent') break;
          if (current.status === 'unknown') throw fail('Claude 桌面删除结果暂时无法核对，工作台记录已保留。');
          await delay(100);
        }
        if (current.status !== 'absent') throw fail('Claude 桌面仍保留该会话，工作台记录已保留。');
      } else if (current.status === 'absent') {
        // Metadata writes are debounced, so file absence alone cannot prove a
        // live desktop entry is absent. Navigate without importing and require
        // the official not-found view for this exact UUID as well.
        const desktopId = `local_${session.sessionId}`;
        await open(desktopId);
        const checked = await menu({ operation: 'verifyAbsent', desktopId });
        if (checked.result !== 'absent') throw fail('Claude 桌面未确认这条聊天已不存在，工作台记录已保留。');
        if ((await catalog.probe(session)).status !== 'absent') throw fail('Claude 桌面会话列表正在变化，工作台记录已保留。');
        alreadyAbsent.push(session.sessionId);
        // Do not leave the temporary not-found verification view on screen.
        await open('home');
      } else throw fail('无法确认 Claude 桌面对应入口。');
      await onProgress({ agent: 'claude', sessionId: session.sessionId, desktop: true, operation: 'delete', checkedAt: new Date().toISOString() });
    }
    return { status: 'verified', sessions: ids, alreadyAbsent, deleted, checkedAt: new Date().toISOString() };
  }
  return { prepare, apply };
}
