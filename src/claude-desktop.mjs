import path from 'node:path';
import os from 'node:os';
import { realpath, stat } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveCli, captureCli, subscriptionEnv } from './adapters/process.mjs';
import { readClaudeActiveSessions } from './claude-chat-lifecycle.mjs';
import { withinProjectRoot } from './project-location.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const fail = message => { throw Object.assign(new Error(message), { statusCode: 409 }); };

// --desktop explicitly refuses redirected output. A real Windows ConPTY is
// required; it runs only the official short-lived launcher, never a shell or
// a model prompt. Loading is lazy so CLI chat still works without this add-on.
export async function captureDesktopCli(cli, args, { cwd, env, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, done = false, result, failure;
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    try {
      child = fork(fileURLToPath(new URL('./claude-desktop-terminal.mjs', import.meta.url)), [], {
        cwd, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
      });
    } catch { finish(new Error('无法启动 Claude 桌面连接所需的本机终端，CLI 聊天仍可使用。')); return; }
    timer = setTimeout(() => {
      failure = new Error('Claude 桌面打开请求超时；请先查看桌面是否已打开，再决定是否重试。');
      if (child.connected) child.send({ type: 'stop' }, () => {});
      setTimeout(() => child.kill(), 1000).unref();
    }, timeout);
    child.on('message', message => {
      if (message?.type === 'result') result = message.result;
      if (message?.type === 'error') failure = new Error('Claude 桌面终端启动失败，CLI 聊天仍可使用。');
    });
    child.on('error', () => finish(new Error('无法启动 Claude 桌面连接终端。')));
    child.on('close', code => finish(failure || (code !== 0 || !result ? new Error('Claude 桌面终端未返回完整结果。') : null), result));
    child.send({ type: 'open', cli, args, cwd }, error => { if (error) { failure = new Error('Claude 桌面终端请求发送失败。'); child.kill(); } });
  });
}

export function createClaudeDesktop({ projectRoot, platform = process.platform, arch = process.arch,
  resolve = resolveCli, capture = captureCli, launch = captureDesktopCli, env = process.env,
  activeSessions = readClaudeActiveSessions, sdk } = {}) {
  let sdkPromise;
  const safeEnv = () => { const result = subscriptionEnv('claude', env); delete result.CLAUDECODE; return result; };
  const executable = () => { const cli = resolve('claude'); if (!cli) fail('尚未找到 Claude Code CLI，请先安装并登录订阅。'); return cli; };

  async function validateFolder(projectPath, cwd = projectPath) {
    if (!path.isAbsolute(projectPath || '') || !path.isAbsolute(cwd || '')) fail('Claude 桌面需要有效的本机项目路径。');
    const project = await realpath(projectPath), actual = await realpath(cwd);
    if (key(project) !== key(projectPath) || key(actual) !== key(cwd)) fail('项目路径已变成链接或联接，请重新核对文件夹后再打开。');
    if (!(await stat(actual)).isDirectory()) fail('项目文件夹已不存在，未打开 Claude 桌面。');
    if (projectRoot) {
      const root = await realpath(projectRoot);
      if (key(root) !== key(projectRoot) || !withinProjectRoot(root, project)) fail(`项目必须位于 ${projectRoot} 的子文件夹中。`);
    }
    if (key(project) !== key(actual) && !withinProjectRoot(project, actual)) fail('Claude 会话目录不属于这个项目。');
    return actual;
  }

  async function assertAvailable({ projectPath, cwd, sessionId }) {
    if (!UUID.test(sessionId || '')) fail('这条聊天没有有效的 Claude 会话编号。');
    const actual = await validateFolder(projectPath, cwd);
    const cli = executable();
    const rows = await activeSessions(cli, {
      claudeHome: env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), env: safeEnv(),
    });
    if (!Array.isArray(rows)) fail('无法核对 Claude 的活动会话，请稍后重试。');
    for (const row of rows) {
      const live = row.pid || row.status || ['working', 'blocked'].includes(row.state);
      if (row.sessionId?.toLowerCase() === sessionId.toLowerCase()
          && (live || !['done', 'failed', 'stopped'].includes(row.state))) {
        fail('这条 Claude 聊天仍在桌面或终端中打开。请先结束该聊天的运行会话，再到另一侧继续；不需要退出整个软件。');
      }
      if (!row.sessionId && (live || row.kind === 'interactive')
          && (!row.cwd || key(row.cwd) === key(projectPath) || withinProjectRoot(projectPath, row.cwd))) {
        fail('同一项目中有尚未确认身份的 Claude 会话，请先结束该会话后再继续。');
      }
    }
    return actual;
  }

  async function open({ projectPath, cwd = projectPath, sessionId } = {}) {
    if (!(platform === 'win32' && arch === 'x64')) fail('当前桌面连接只在 Windows x64 上完成了适配，CLI 聊天仍可使用。');
    const actual = await validateFolder(projectPath, cwd), cli = executable(), cleanEnv = safeEnv();
    const version = await capture(cli, ['--version'], { cwd: actual, env: cleanEnv });
    const parts = version.stdout?.match(/^(\d+)\.(\d+)\.(\d+)\b/);
    if (version.code !== 0 || !parts || (Number(parts[1]) < 2)
        || (Number(parts[1]) === 2 && (Number(parts[2]) < 1 || Number(parts[2]) === 1 && Number(parts[3]) < 285))) {
      fail('在桌面打开需要 Claude Code 2.1.285 或更新版本，请更新官方 CLI。');
    }
    // --desktop rejects --settings; inspect the actual inherited local login
    // instead of forcing settings for this check and assuming Desktop uses them.
    const auth = await capture(cli, ['auth', 'status'], { cwd: actual, env: cleanEnv });
    let account;
    try { account = JSON.parse(auth.stdout); } catch { fail('无法确认 Claude 订阅登录，请先通过官方 CLI 登录。'); }
    if (auth.code !== 0 || !account.loggedIn || account.authMethod !== 'claude.ai') fail('桌面连接需要 Claude 订阅登录，未使用 API 凭据。');
    if (sessionId !== undefined) {
      await assertAvailable({ projectPath, cwd: actual, sessionId });
      const api = sdk ?? await (sdkPromise ||= import('@anthropic-ai/claude-agent-sdk'));
      const info = await api.getSessionInfo(sessionId, { dir: actual });
      if (!info || info.sessionId?.toLowerCase() !== sessionId.toLowerCase()
          || !info.cwd || key(await realpath(info.cwd)) !== key(actual)) {
        fail('没有在这个项目文件夹中找到对应 Claude 聊天，未打开其他会话。');
      }
    }
    const result = await launch(cli, ['--desktop', ...(sessionId ? ['--resume', sessionId] : [])], { cwd: actual, env: cleanEnv });
    const output = stripVTControlCharacters(result.output || '').replace(/\r/g, '');
    const expected = sessionId ? `Opening session ${sessionId} in Claude Desktop` : `Opening ${actual} in Claude Desktop`;
    if (result.code !== 0 || !output.includes(expected)) {
      if (/download|not installed/i.test(output)) fail('尚未找到 Claude 桌面应用；工作台 CLI 聊天不受影响。安装并登录桌面应用后可重试。');
      if (/running|already open|active session/i.test(output)) fail('Claude 官方工具提示该会话仍在使用，请结束该会话后再继续。');
      fail('Claude 官方工具没有确认桌面打开请求。CLI 聊天仍可使用，请在项目信息中重试。');
    }
    // A launcher acknowledgement is not proof of a rendered/trusted desktop UI.
    return { status: 'request_sent', cwd: actual, ...(sessionId ? { sessionId } : {}),
      source: 'claude_cli_desktop', checkedAt: new Date().toISOString() };
  }
  return { open, assertAvailable };
}
