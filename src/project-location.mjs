import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';

const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
export function withinProjectRoot(root, target) {
  const relative = path.relative(key(root), key(target));
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function existingAncestor(target) {
  let candidate = target;
  for (;;) {
    try { return { candidate, actual: await realpath(candidate) }; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

// Validate lexical and resolved paths before creating a project directory.
// In particular, E:\AI\link-to-C:\... must not write outside the chosen root.
export async function assertProjectLocation(root, target) {
  if (!withinProjectRoot(root, target)) throw new Error(`项目必须位于 ${root} 的子文件夹中，不能使用根目录本身或其他路径。`);
  const rootParent = await existingAncestor(root);
  if (key(rootParent.candidate) !== key(rootParent.actual)) throw new Error('项目根目录通过链接指向其他位置，未创建项目。');
  const nearest = await existingAncestor(target);
  if (key(nearest.candidate) !== key(root) && withinProjectRoot(root, nearest.candidate)
    && !withinProjectRoot(root, nearest.actual)) throw new Error('项目路径通过链接指向根目录之外，未创建项目。');
  await mkdir(root, { recursive: true });
  const actualRoot = await realpath(root);
  if (key(actualRoot) !== key(root)) throw new Error('项目根目录发生变化，未创建项目。');
  const check = await existingAncestor(target);
  if (key(check.actual) !== key(actualRoot) && !withinProjectRoot(actualRoot, check.actual)) throw new Error('项目实际路径超出统一项目目录，未创建项目。');
}
