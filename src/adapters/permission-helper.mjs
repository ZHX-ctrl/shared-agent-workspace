// A per-run MCP stdio server invoked by official Claude Code. No model/API calls.
import { makeLineReader } from './process.mjs';

const TOOL = 'approve';
const respond = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
makeLineReader(process.stdin, line => {
  void (async () => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (request.id === undefined) return;
    const { id, method, params = {} } = request;
    if (method === 'initialize') {
      respond({ id, result: { protocolVersion: params.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'saw-permissions', version: '0.1.0' } } });
    } else if (method === 'ping') respond({ id, result: {} });
    else if (method === 'tools/list') {
      respond({ id, result: { tools: [{ name: TOOL, description: 'Ask the local user to approve one Claude Code action.',
        inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object', additionalProperties: true }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } }] } });
    } else if (method === 'tools/call' && params.name === TOOL) {
      let decision = { behavior: 'deny', message: 'Local approval host unavailable.' };
      try {
        const url = new URL(process.env.SAW_PERMISSION_URL || '');
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/permission') throw new Error('Invalid host');
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SAW_PERMISSION_TOKEN || ''}` }, body: JSON.stringify(params.arguments || {}), signal: AbortSignal.timeout(600000) });
        if (response.ok) decision = await response.json();
        if (!['allow', 'deny'].includes(decision.behavior)) throw new Error('Invalid decision');
      } catch { decision = { behavior: 'deny', message: 'Local approval host unavailable.' }; }
      respond({ id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
    } else respond({ id, error: { code: -32601, message: 'Unsupported method' } });
  })();
}, () => process.exit(1));
