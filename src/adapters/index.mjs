import { CodexAdapter } from './codex.mjs';
import { ClaudeAdapter } from './claude.mjs';
import { resolveCli } from './process.mjs';

export function createAdapters({ onProviderUpdate, codexExecutable } = {}) {
  return {
    codex: new CodexAdapter({ onProviderUpdate, resolve: name => resolveCli(name, { explicitPath: codexExecutable }) }),
    claude: new ClaudeAdapter({ onProviderUpdate }),
  };
}
