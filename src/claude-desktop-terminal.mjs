// Short-lived ConPTY host. Exiting this process after the official CLI exits
// releases node-pty's Windows worker handles without killing a desktop app or
// retaining a terminal worker in the long-running workbench server.
import pty from 'node-pty';
import { stripVTControlCharacters } from 'node:util';
let terminal, exited = false, started = false, output = '';
function stop() {
  if (terminal && !exited) { try { process.kill(terminal.pid); } catch {} }
  process.exit(1);
}
process.on('disconnect', stop);
process.on('message', message => {
  if (message?.type === 'stop') return stop();
  if (message?.type !== 'open' || started) return;
  started = true;
  try {
    terminal = pty.spawn(message.cli.command, [...(message.cli.args || []), ...message.args], {
      cwd: message.cwd, env: process.env, name: 'xterm-256color', cols: 4096, rows: 24,
      useConpty: true, useConptyDll: false,
    });
    terminal.onData(data => { output += data; if (output.length > 65536) stop(); });
    terminal.onExit(({ exitCode }) => {
      exited = true;
      process.send({ type: 'result', result: { code: exitCode, output: stripVTControlCharacters(output).trim() } }, () => process.exit(0));
    });
  } catch {
    process.send({ type: 'error' }, () => process.exit(1));
  }
});
