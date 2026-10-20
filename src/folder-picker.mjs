import { realpath, stat, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { withinProjectRoot } from './project-location.mjs';

const invalid = message => Object.assign(new Error(message), { statusCode: 400 });
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

async function checkedFolder(root, selected, allowRoot = false) {
  if (typeof selected !== 'string' || selected.length > 4096 || selected.includes('\0') || !path.isAbsolute(selected)
    || !(withinProjectRoot(root, selected) || (allowRoot && key(root) === key(selected)))) {
    throw invalid(`请选择 ${root} 内的项目子文件夹。`);
  }
  try {
    const actualRoot = await realpath(root), actual = await realpath(selected);
    if (key(root) !== key(actualRoot)) throw invalid('项目根目录指向了其他位置，请检查路径。');
    if (!(withinProjectRoot(actualRoot, actual) || (allowRoot && key(actualRoot) === key(actual))) || !(await stat(actual)).isDirectory()) {
      throw invalid(`所选文件夹的实际位置必须在 ${root} 内。`);
    }
    return actual;
  } catch (error) {
    if (error.code === 'ENOENT') throw invalid('这个文件夹已不存在，请返回上一级重新选择。');
    if (['EACCES', 'EPERM'].includes(error.code)) throw invalid('无法读取这个文件夹，请选择有访问权限的目录。');
    throw error;
  }
}

export const validateSelectedFolder = (root, selected) => checkedFolder(root, selected);

export async function listSelectableFolders({ root, requestedPath = '', initial = false }) {
  let current;
  try { current = await checkedFolder(root, requestedPath || root, true); }
  catch (error) { if (!initial || !requestedPath) throw error; current = await checkedFolder(root, root, true); }
  const entries = await readdir(current, { withFileTypes: true });
  const atRoot = key(root) === key(current);
  return {
    root, path: current, parent: atRoot ? null : path.dirname(current), canSelect: !atRoot,
    // Do not offer directory junctions as navigation shortcuts to other roots.
    folders: entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
      .map(entry => ({ name: entry.name, path: path.join(current, entry.name) })),
  };
}

export async function createSelectableFolder({ root, parent, name }) {
  if (typeof name !== 'string' || !name || name !== name.trim() || name.length > 120 || /[\\/<>:"|?*\x00-\x1f]/.test(name)
    || /[. ]$/.test(name) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) throw invalid('文件夹名称无效，请勿使用路径、特殊字符或末尾空格。');
  const current = await checkedFolder(root, parent, true);
  const target = path.join(current, name);
  if (!withinProjectRoot(root, target)) throw invalid('不能在统一项目目录之外创建文件夹。');
  try { await mkdir(target); }
  catch (error) { if (error.code === 'EEXIST') throw invalid('已存在同名文件夹或文件，请换一个名称。'); throw error; }
  return { path: await validateSelectedFolder(root, target) };
}
