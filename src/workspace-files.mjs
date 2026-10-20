import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function projectEntry(project, relative = '') {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes('\0')) throw new Error('请选择项目内的文件。');
  const root = await fs.realpath(project.path);
  const target = await fs.realpath(path.resolve(root, relative));
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('不能访问项目外的文件。');
  return { target, relative: rel.split(path.sep).join('/'), stat: await fs.stat(target) };
}
export async function listProjectFiles(project, relative) {
  const entry = await projectEntry(project, relative);
  if (!entry.stat.isDirectory()) throw new Error('所选路径不是文件夹。');
  const list = await fs.readdir(entry.target, { withFileTypes: true });
  return list.filter(item => !item.isSymbolicLink() && !['.git', 'node_modules'].includes(item.name))
    .sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'))
    .slice(0, 500).map(item => ({ name: item.name, directory: item.isDirectory(), path: [entry.relative, item.name].filter(Boolean).join('/') }));
}
export async function previewProjectFile(project, relative) {
  const entry = await projectEntry(project, relative);
  if (!entry.stat.isFile() || entry.stat.size > 2 * 1024 * 1024) throw new Error('预览支持 2 MB 以内的文件。');
  const bytes = await fs.readFile(entry.target);
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(entry.target).toLowerCase()];
  if (mime) return { kind: 'image', path: entry.relative, data: `data:${mime};base64,${bytes.toString('base64')}` };
  if (bytes.includes(0)) throw new Error('此文件是二进制格式，暂不支持在工作台内预览。');
  return { kind: 'text', path: entry.relative, text: bytes.toString('utf8') };
}
export async function saveChatAttachment(project, chat, { name, base64 }) {
  if (typeof name !== 'string' || !name || name.length > 240 || /[\\/<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) throw new Error('附件名称无效。');
  if (typeof base64 !== 'string' || base64.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('每个附件最多 10 MB。');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > 10 * 1024 * 1024) throw new Error('每个附件最多 10 MB。');
  const folder = path.join(project.storagePath, 'chats', chat.id, 'attachments', randomUUID());
  await fs.mkdir(folder, { recursive: true });
  const filename = path.join(folder, name);
  await fs.writeFile(filename, bytes, { flag: 'wx' });
  return { name, path: filename, size: bytes.length };
}
