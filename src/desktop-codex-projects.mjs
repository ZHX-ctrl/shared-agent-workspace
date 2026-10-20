import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { projectPathKey } from './codex-projects.mjs';

const execFileAsync = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const failure = (message, code) => Object.assign(new Error(message), { code });
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function canonicalDirectory(value) {
  if (!nonempty(value) || !path.isAbsolute(value)) throw failure('项目必须使用本机文件夹的绝对路径。', 'PROJECT_PATH_INVALID');
  let result;
  try { result = realpathSync(value); }
  catch { throw failure('项目文件夹不存在或无法访问。', 'PROJECT_PATH_UNAVAILABLE'); }
  if (!statSync(result).isDirectory()) throw failure('项目路径必须是文件夹。', 'PROJECT_PATH_INVALID');
  return result;
}

export function codexProjectDeepLink(absolutePath) {
  if (!projectPathKey(absolutePath, 'win32')) throw failure('Codex 深链需要 Windows 绝对路径。', 'PROJECT_PATH_INVALID');
  return `codex://new?path=${encodeURIComponent(absolutePath)}`;
}

// URI data travels in a dedicated environment variable, never interpolated into
// PowerShell code. execFile does not run a shell shim; no prompt is supplied and
// the official application opens an empty composer, without inference.
export async function openCodexProjectDeepLink(uri, { run = execFileAsync, env = process.env } = {}) {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'codex:' || parsed.hostname !== 'new' || parsed.pathname !== ''
      || parsed.hash || parsed.username || parsed.password || parsed.port
      || [...parsed.searchParams.keys()].length !== 1 || !parsed.searchParams.has('path')
      || !projectPathKey(parsed.searchParams.get('path'), 'win32')) {
    throw failure('拒绝打开无效的 Codex 项目链接。', 'PROJECT_LINK_INVALID');
  }
  return launchCodexUri(uri, { run, env });
}

export async function openCodexThreadDeepLink(threadId, options = {}) {
  if (typeof threadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId)) throw failure('Codex 聊天编号无效。', 'THREAD_ID_INVALID');
  return launchCodexUri(`codex://threads/${threadId}`, options);
}

async function launchCodexUri(uri, { run = execFileAsync, env = process.env } = {}) {
  const systemRoot = env.SystemRoot || 'C:\\Windows';
  if (!path.win32.isAbsolute(systemRoot)) throw failure('Windows 系统目录无效。', 'SYSTEM_PATH_INVALID');
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Start-Process -FilePath $env:SHARED_AGENT_CODEX_PROJECT_URI -WindowStyle Hidden -ErrorAction Stop'],
  { windowsHide: true, shell: false, timeout: 5000, maxBuffer: 16384,
    env: { ...env, SHARED_AGENT_CODEX_PROJECT_URI: uri } });
}

function findRegistration(state, canonicalPath, codexHome, canonicalize) {
  if (!state || typeof state !== 'object' || !Array.isArray(state['project-order'])) return null;
  const key = projectPathKey(canonicalPath, 'win32');
  const localProjects = state['local-projects'];
  if (!localProjects || typeof localProjects !== 'object' || Array.isArray(localProjects)) return null;
  const mapping = state['app-server-project-id-by-legacy-project-id-by-host'];
  const hostKey = projectPathKey(codexHome, 'win32');
  const hostMappings = mapping && typeof mapping === 'object' ? Object.entries(mapping)
    .filter(([host]) => host.startsWith('local:') && projectPathKey(host.slice(6), 'win32') === hostKey)
    .map(([, projects]) => projects) : [];
  for (const [legacyId, project] of Object.entries(localProjects)) {
    if (!project || project.id !== legacyId || !nonempty(legacyId) || !Array.isArray(project.rootPaths)
        || !state['project-order'].includes(legacyId)) continue;
    const matches = project.rootPaths.some(root => {
      if (projectPathKey(root, 'win32') === key) return true;
      try { return projectPathKey(canonicalize(root), 'win32') === key; } catch { return false; }
    });
    if (!matches) continue;
    const nativeIds = [...new Set(hostMappings.map(ids => ids?.[legacyId]).filter(nonempty))];
    // A directory entry without ordering or an unambiguous native mapping is
    // incomplete; do not report success during an in-progress desktop write.
    if (nativeIds.length !== 1) continue;
    return { projectId: legacyId, nativeProjectId: nativeIds[0],
      name: nonempty(project.name) ? project.name : path.win32.basename(canonicalPath),
      roots: project.rootPaths.filter(nonempty).map(root => ({ path: root })) };
  }
  return null;
}

export function createDesktopCodexProjectRegistrar({
  platform = process.platform, env = process.env,
  codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  canonicalize = canonicalDirectory,
  readState = async filename => JSON.parse(await readFile(filename, 'utf8')),
  openLink = openCodexProjectDeepLink,
  now = Date.now, sleep = delay, timeoutMs = 12000, pollIntervalMs = 500,
} = {}) {
  const inFlight = new Map();
  // Keep successful launches after a timeout: retrying verification must not
  // open another blank composer. Cleared after registration becomes complete.
  const launched = new Map();
  const statePath = path.join(codexHome, '.codex-global-state.json');

  async function snapshot(canonicalPath) {
    let state;
    try { state = await readState(statePath); }
    catch (cause) {
      // Atomic replacement/partial reads can be transient. Other filesystem
      // failures are surfaced instead of pretending an unreadable cache is empty.
      if (cause instanceof SyntaxError || ['ENOENT', 'EBUSY', 'EPERM'].includes(cause?.code)) return null;
      throw failure('无法读取官方 Codex 项目登记状态。', 'DESKTOP_STATE_UNREADABLE');
    }
    return findRegistration(state, canonicalPath, codexHome, canonicalize);
  }

  async function ensure(canonicalPath, key, allowLaunch = true) {
    const existing = await snapshot(canonicalPath);
    const result = (registration, status) => ({ ...registration, status,
      projectPath: canonicalPath, source: 'codex_desktop', desktopVisibility: 'cache_verified',
      checkedAt: new Date(now()).toISOString() });
    if (existing) { launched.delete(key); return result(existing, 'already_registered'); }
    if (!allowLaunch && !launched.has(key)) throw failure('等待 Codex 桌面端完成项目登记或文件夹信任确认。', 'DESKTOP_REGISTRATION_PENDING');
    if (!launched.has(key)) {
      const launch = Promise.resolve().then(() => openLink(codexProjectDeepLink(canonicalPath)));
      launched.set(key, launch);
      launch.catch(() => { if (launched.get(key) === launch) launched.delete(key); });
    }
    try { await launched.get(key); }
    catch { throw failure('无法打开官方 Codex 项目入口，请确认已安装 Codex 桌面应用。', 'DESKTOP_OPEN_FAILED'); }
    const deadline = now() + timeoutMs;
    for (;;) {
      const registration = await snapshot(canonicalPath);
      if (registration) { launched.delete(key); return result(registration, 'registered'); }
      const remaining = deadline - now();
      if (remaining <= 0) throw failure('已打开官方 Codex，但尚未确认项目出现在项目列表。若应用要求文件夹访问授权，请在官方窗口完成后重试核验。', 'DESKTOP_REGISTRATION_PENDING');
      await sleep(Math.min(pollIntervalMs, remaining));
    }
  }

  return {
    ensureDesktopCodexProject(options) {
      if (platform !== 'win32') return Promise.reject(failure('当前官方 Codex 桌面项目登记仅实现 Windows。', 'DESKTOP_PLATFORM_UNSUPPORTED'));
      let canonicalPath;
      try {
        if (!projectPathKey(codexHome, 'win32')) throw failure('Codex 数据目录必须是 Windows 绝对路径。', 'CODEX_HOME_INVALID');
        canonicalPath = canonicalize(options?.projectPath);
        if (!projectPathKey(canonicalPath, 'win32')) throw failure('项目路径无效。', 'PROJECT_PATH_INVALID');
      } catch (cause) { return Promise.reject(cause); }
      const key = projectPathKey(canonicalPath, 'win32');
      if (inFlight.has(key)) return inFlight.get(key);
      const task = ensure(canonicalPath, key, options?.allowLaunch !== false).finally(() => { if (inFlight.get(key) === task) inFlight.delete(key); });
      inFlight.set(key, task); return task;
    },
    async readDesktopCodexProject({ projectPath }) {
      const canonicalPath = canonicalize(projectPath);
      return snapshot(canonicalPath);
    },
  };
}

const registrar = createDesktopCodexProjectRegistrar();
export const ensureDesktopCodexProject = options => registrar.ensureDesktopCodexProject(options);
