import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';

const TERMINAL = new Set(['completed', 'succeeded', 'failed', 'interrupted', 'cancelled', 'canceled']);
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

function relativeScope(input) {
  if (typeof input !== 'string' || !input || input !== input.trim() || input.includes('\0') ||
      path.posix.isAbsolute(input) || path.win32.isAbsolute(input) || /^[a-z]:/iu.test(input)) {
    throw new Error('并行任务必须指定项目内的相对目录，不能使用空目录或绝对路径。');
  }
  const parts = input.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/u.test(part) || /[. ]$/u.test(part))) {
    throw new Error('并行目录包含无效路径段；不允许 .、..、空路径段或 Windows 特殊字符。');
  }
  return parts;
}

async function normalizeScope(root, input) {
  const parts = relativeScope(input);
  const requested = path.join(root, ...parts);
  let actual;
  try {
    actual = await realpath(requested);
    if (!(await stat(actual)).isDirectory()) throw new Error('并行范围必须是目录，不能是文件。');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`并行目录尚不存在：${input}。请先创建目录再分派任务。`);
    throw error;
  }
  const rootKey = key(root);
  const actualKey = key(actual);
  if (actualKey === rootKey || !actualKey.startsWith(rootKey + path.sep)) {
    throw new Error('并行范围必须在项目内部；拒绝整个项目或指向项目外的符号链接。');
  }
  return { scope: path.relative(root, actual).split(path.sep).join('/'), scopePath: actual, comparison: actualKey };
}

/**
 * This is a scheduling agreement, not an OS security sandbox. Agents still need
 * their native permission controls. Revalidate when dispatching, because a user
 * can replace directories/symlinks after this check. Root files and shared
 * contracts must be handled serially outside this parallel scope mechanism.
 * activeRuns should already be restricted to the current project; a supplied
 * projectPath/cwd is additionally checked here to avoid unrelated blockers.
 */
export async function validateScopes(projectPath, tasks, activeRuns = []) {
  const root = await realpath(projectPath);
  if (!(await stat(root)).isDirectory()) throw new Error('项目路径不是目录。');
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('请至少提供一个并行任务。');
  if (!Array.isArray(activeRuns)) throw new Error('活动运行列表无效。');
  const claimed = [];
  for (const run of activeRuns) {
    if (TERMINAL.has(run.status)) continue;
    const activePath = run.projectPath ?? run.cwd;
    if (activePath) {
      let actual;
      try { actual = await realpath(activePath); }
      catch { throw new Error('无法确认已有运行的项目路径，请先停止或检查该运行。'); }
      if (key(actual) !== key(root)) continue;
    }
    if (!run.scope) throw new Error('项目已有未限定目录的运行；请先结束该运行再启动并行任务。');
    const normalized = await normalizeScope(root, run.scope);
    claimed.push({ ...normalized, label: `运行 ${run.id ?? run.agent ?? ''}` });
  }
  const result = [];
  for (const [index, task] of tasks.entries()) {
    if (!task || typeof task !== 'object') throw new Error('并行任务内容无效。');
    const normalized = await normalizeScope(root, task.scope);
    const conflict = claimed.find(item => overlaps(item.comparison, normalized.comparison));
    if (conflict) throw new Error(`目录范围重叠：${normalized.scope} 与 ${conflict.scope}（${conflict.label}）。`);
    claimed.push({ ...normalized, label: `任务 ${index + 1}` });
    result.push({ ...structuredClone(task), scope: normalized.scope, scopePath: normalized.scopePath });
  }
  return result;
}
