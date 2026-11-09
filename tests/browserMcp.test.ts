import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_TOOLS, browserMcpUrl, codexBrowserArgs, handleMcpBody, handleRpc, MCP_SERVER_NAME } from '../server/browserMcp.ts';

test('initialize answers with tools capability and instructions', async () => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  const res = r!.result as { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string }; instructions: string };
  assert.equal(res.protocolVersion, '2025-03-26');
  assert.ok(res.capabilities.tools);
  assert.equal(res.serverInfo.name, MCP_SERVER_NAME);
  assert.match(res.instructions, /browser_open/);
});

test('notifications get no reply; a lone notification body is 202', async () => {
  assert.equal(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await handleMcpBody({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('tools/list returns every tool with an object schema', async () => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = (r!.result as { tools: { name: string; inputSchema: { type: string } }[] }).tools;
  assert.equal(tools.length, BROWSER_TOOLS.length);
  for (const t of tools) { assert.match(t.name, /^browser_/); assert.equal(t.inputSchema.type, 'object'); }
});

test('tools/call relays name and arguments and returns the content', async () => {
  const seen: unknown[] = [];
  const r = await handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_click', arguments: { ref: 'e4' } } },
    async (tool, args) => { seen.push([tool, args]); return [{ type: 'text', text: 'Clicked e4' }]; });
  assert.deepEqual(seen, [['browser_click', { ref: 'e4' }]]);
  assert.deepEqual(r!.result, { content: [{ type: 'text', text: 'Clicked e4' }] });
});

test('a failing tool is a result with isError, not a protocol error', async () => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_open', arguments: {} } }, async () => { throw new Error('app not running'); });
  assert.deepEqual(r!.result, { content: [{ type: 'text', text: 'app not running' }], isError: true });
});

test('unknown tools and methods are JSON-RPC errors', async () => {
  const a = await handleRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rm_rf' } }, async () => []);
  assert.equal(a!.error!.code, -32602);
  const b = await handleRpc({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
  assert.equal(b!.error!.code, -32601);
});

test('without the desktop app the tools say so', async () => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'browser_tabs', arguments: {} } });
  const res = r!.result as { isError: boolean; content: { text: string }[] };
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /not running/);
});

test('batches reply to requests only', async () => {
  const out = await handleMcpBody([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 8, method: 'ping' }]) as unknown[];
  assert.deepEqual(out, [{ jsonrpc: '2.0', id: 8, result: {} }]);
});

test('session wiring points both CLIs at the loopback endpoint', () => {
  assert.equal(browserMcpUrl(11398), 'http://127.0.0.1:11398/mcp/browser');
  assert.deepEqual(codexBrowserArgs(11398), ['-c', 'mcp_servers.vibrato.url="http://127.0.0.1:11398/mcp/browser"']);
});
