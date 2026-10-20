import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcClient } from './adapters/rpc.mjs';
import { resolveCli, subscriptionEnv } from './adapters/process.mjs';
import { CODEX_SERVER_ARGS } from './adapters/codex.mjs';

const runtimePath = fileURLToPath(new URL('../data/runtime.json', import.meta.url));

function error(message, code) { return Object.assign(new Error(message), { code }); }

function configuredExecutable() {
  let raw;
  try { raw = readFileSync(runtimePath, 'utf8'); }
  catch (cause) { if (cause.code === 'ENOENT') return undefined; throw error('无法读取 Codex 运行时配置。', 'RUNTIME_CONFIG_UNREADABLE'); }
  try { return JSON.parse(raw).codexExecutable; }
  catch { throw error('Codex 运行时配置不是有效 JSON。', 'RUNTIME_CONFIG_INVALID'); }
}

// Identity only. Keep the canonical, correctly-cased path for the actual RPC.
export function projectPathKey(value, platform = process.platform) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (platform === 'win32') {
    if (!path.win32.isAbsolute(value)) return null;
    let normalized = path.win32.normalize(value).replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
    const root = path.win32.parse(normalized).root;
    while (normalized.length > root.length && normalized.endsWith('\\')) normalized = normalized.slice(0, -1);
    return normalized.toLowerCase();
  }
  if (!path.posix.isAbsolute(value)) return null;
  return path.posix.normalize(value).replace(/\/$/, '') || '/';
}

function canonicalDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw error('项目必须使用已存在的本机文件夹绝对路径。', 'PROJECT_PATH_INVALID');
  }
  let resolved;
  try { resolved = realpathSync(value); }
  catch { throw error('项目文件夹不存在或无法访问。', 'PROJECT_PATH_UNAVAILABLE'); }
  if (!statSync(resolved).isDirectory()) throw error('项目路径必须是文件夹。', 'PROJECT_PATH_INVALID');
  return resolved;
}

function projectMatches(project, canonicalPath, key, platform, canonicalize) {
  return Array.isArray(project?.roots) && project.roots.some(root => {
    if (projectPathKey(root?.path, platform) === key) return true;
    // Existing aliases/junctions should resolve to the same registration too.
    try { return projectPathKey(canonicalize(root?.path), platform) === key; }
    catch { return root?.path === canonicalPath; }
  });
}

async function findProject(rpc, canonicalPath, key, platform, canonicalize) {
  let cursor;
  const cursors = new Set();
  for (let page = 0; page < 100; page++) {
    const response = await rpc.request('project/list', { limit: 100, sortKey: 'position', ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(response?.data)) throw error('Codex 项目列表响应格式不受支持；没有创建项目。', 'PROJECT_PROTOCOL_INVALID');
    for (const project of response.data) {
      if (typeof project?.id !== 'string' || !Array.isArray(project.roots)) {
        throw error('Codex 项目列表含有无法识别的记录；没有创建项目。', 'PROJECT_PROTOCOL_INVALID');
      }
      if (projectMatches(project, canonicalPath, key, platform, canonicalize)) return project;
    }
    if (response.nextCursor == null) return null;
    if (typeof response.nextCursor !== 'string' || !response.nextCursor || cursors.has(response.nextCursor)) {
      throw error('Codex 项目列表分页异常；没有创建项目。', 'PROJECT_PAGINATION_INVALID');
    }
    cursor = response.nextCursor; cursors.add(cursor);
  }
  throw error('Codex 项目列表超出检查范围；没有创建项目。', 'PROJECT_LIST_LIMIT');
}

// Injectable transport makes registration testable without touching the official
// app database. Only metadata/auth RPC calls are made; no
// thread/start, turn/start, command execution, or model request is involved.
export function createCodexProjectRegistrar({ Rpc = JsonRpcClient, resolve = resolveCli,
  canonicalize = canonicalDirectory, platform = process.platform,
  getExecutable = configuredExecutable } = {}) {
  const inFlight = new Map();

  async function run({ projectPath, name, executable, create }) {
    const canonicalPath = canonicalize(projectPath);
    const key = projectPathKey(canonicalPath, platform);
    if (!key) throw error('项目文件夹路径无效。', 'PROJECT_PATH_INVALID');
    const projectName = typeof name === 'string' && name.trim() ? name.trim() : path.basename(canonicalPath);
    const cli = resolve('codex', { explicitPath: executable ?? getExecutable() });
    if (!cli) throw error('未找到官方 Codex CLI。', 'CODEX_NOT_INSTALLED');
    const rpc = new Rpc(cli, CODEX_SERVER_ARGS, { cwd: canonicalPath, env: subscriptionEnv('codex') });
    rpc.on('request', message => rpc.reject(message.id, 'Project registration does not approve agent actions'));
    try {
      await rpc.request('initialize', { clientInfo: { name: 'shared_agent_workspace_projects', title: 'Shared Agent Workspace', version: '0.1.0' },
        capabilities: { experimentalApi: true } });
      rpc.notify('initialized');
      const auth = await rpc.request('account/read', { refreshToken: false });
      if (auth?.account?.type !== 'chatgpt') throw error('请先在官方 Codex 中登录 ChatGPT 订阅。', 'SUBSCRIPTION_REQUIRED');
      const existing = await findProject(rpc, canonicalPath, key, platform, canonicalize);
      if (!existing && !create) return { status: 'not_registered', projectId: null, projectPath: canonicalPath,
        source: 'codex_app_server', desktopVisibility: 'not_verified', checkedAt: new Date().toISOString() };

      let project = existing;
      if (!project) {
        // Same path gets the same key across processes/retries, including when a
        // response is lost after the official server commits the creation.
        const baseKey = 'shared-agent-workspace-project-v1-' + createHash('sha256').update(key).digest('hex');
        for (let generation = 0; generation < 256; generation++) {
          const idempotencyKey = generation ? `${baseKey}-generation-${generation}` : baseKey;
          try {
            const response = await rpc.request('project/create', { idempotencyKey, name: projectName,
              roots: [{ path: canonicalPath }], metadata: { 'shared-agent-workspace.origin': 'local-workbench' } });
            project = response?.project; break;
          } catch (cause) {
            // A deleted registration burns its creation key. Advance only for
            // the server's exact tombstone response, never for a timeout or
            // unknown outcome; generations remain stable across restarts.
            if (cause.message !== `idempotency key refers to deleted project: ${idempotencyKey}`) throw cause;
            project = await findProject(rpc, canonicalPath, key, platform, canonicalize);
            if (project) break;
          }
        }
      }
      if (typeof project?.id !== 'string' || !projectMatches(project, canonicalPath, key, platform, canonicalize)) {
        throw error('Codex 返回的项目与本机文件夹不一致，登记状态需要重新检查。', 'PROJECT_VERIFY_FAILED');
      }
      const verified = (await rpc.request('project/read', { projectId: project.id }))?.project;
      if (verified?.id !== project.id || !projectMatches(verified, canonicalPath, key, platform, canonicalize)) {
        throw error('Codex 项目登记读回验证失败。', 'PROJECT_VERIFY_FAILED');
      }
      return { status: existing ? 'already_registered' : 'registered', projectId: verified.id,
        projectPath: canonicalPath, name: verified.name, roots: verified.roots.map(root => ({ path: root.path })),
        source: 'codex_app_server', desktopVisibility: 'not_verified', checkedAt: new Date().toISOString() };
    } finally { await rpc.close(); }
  }

  return {
    ensureCodexProject(options) {
      let canonicalPath;
      try { canonicalPath = canonicalize(options?.projectPath); } catch (cause) { return Promise.reject(cause); }
      const key = projectPathKey(canonicalPath, platform);
      if (inFlight.has(key)) return inFlight.get(key);
      const task = run({ ...options, projectPath: canonicalPath, create: true }).finally(() => {
        if (inFlight.get(key) === task) inFlight.delete(key);
      });
      inFlight.set(key, task);
      return task;
    },
    inspectCodexProject(options) { return run({ ...options, create: false }); },
  };
}

const registrar = createCodexProjectRegistrar();
export const ensureCodexProject = options => registrar.ensureCodexProject(options);
export const inspectCodexProject = options => registrar.inspectCodexProject(options);
