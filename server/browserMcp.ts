import type { WebSocket, WebSocketServer } from 'ws';

/**
 * Vibrato browser tools for agents, served as an MCP server over Streamable HTTP at /mcp/browser.
 *
 * The tools drive the in-app browser window (electron/browser.cts, a WKWebView that keeps Google and other
 * sign-ins). This server only knows the tool schemas: each call is relayed over the /browser-host socket the
 * Electron main process keeps open, and its MCP content comes back unchanged. Without the desktop app (e.g.
 * `npm run serve`) the tools answer with an error saying so.
 */

export const MCP_SERVER_NAME = 'vibrato';
const PROTOCOL = '2025-06-18';
const CALL_TIMEOUT_MS = 90_000;

const tab = { type: 'number', description: 'Tab id from browser_open / browser_tabs. Defaults to the active tab.' } as const;
const target = {
  ref: { type: 'string', description: 'Element ref from the latest browser_snapshot, e.g. "e12".' },
  selector: { type: 'string', description: 'CSS selector, used when no ref is given.' },
} as const;

export const BROWSER_TOOLS = [
  { name: 'browser_open', description: 'Open a URL in the Vibrato in-app browser (a new tab the user can watch). Use this first whenever you need to look at, test or measure a web page. Google and other sign-ins the user made there are kept.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL, e.g. http://localhost:3000/login' }, newTab: { type: 'boolean', description: 'false reuses the active tab. Default true.' }, focus: { type: 'boolean', description: 'Bring the browser window to the front. Default true.' } } } },
  { name: 'browser_tabs', description: 'List open tabs (id, title, URL); * marks the active one.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_select_tab', description: 'Make a tab the active one.', inputSchema: { type: 'object', properties: { tab }, required: ['tab'] } },
  { name: 'browser_close_tab', description: 'Close a tab.', inputSchema: { type: 'object', properties: { tab } } },
  { name: 'browser_navigate', description: 'Load a URL in a tab, or go back / forward / reload.',
    inputSchema: { type: 'object', properties: { tab, url: { type: 'string' }, action: { type: 'string', enum: ['back', 'forward', 'reload'] } } } },
  { name: 'browser_snapshot', description: 'Accessibility-style outline of the page: roles, names, values and refs (e.g. [ref=e12]) for elements you can click or type into. Take one before interacting, and again after the page changes.',
    inputSchema: { type: 'object', properties: { tab, selector: { type: 'string', description: 'Only this part of the page.' }, maxDepth: { type: 'number' } } } },
  { name: 'browser_click', description: 'Click an element with a real mouse click (scrolls it into view first).',
    inputSchema: { type: 'object', properties: { tab, ...target, double: { type: 'boolean' } } } },
  { name: 'browser_type', description: 'Type text into an input, textarea or contenteditable (replaces its content unless clear is false).',
    inputSchema: { type: 'object', properties: { tab, ...target, text: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean', description: 'Press Enter afterwards.' } }, required: ['text'] } },
  { name: 'browser_press', description: 'Press a key in the page, e.g. Enter, Escape, Tab, ArrowDown, Meta+A.',
    inputSchema: { type: 'object', properties: { tab, key: { type: 'string' } }, required: ['key'] } },
  { name: 'browser_select_option', description: 'Choose option(s) of a <select> by value or label.',
    inputSchema: { type: 'object', properties: { tab, ...target, value: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } } } },
  { name: 'browser_screenshot', description: 'Screenshot of the visible page, or of one element (ref / selector). Returns a PNG image.',
    inputSchema: { type: 'object', properties: { tab, ...target } } },
  { name: 'browser_eval', description: 'Run JavaScript in the page and return the JSON result. An expression, or a function body using `return` (await is allowed). Use it to read DOM details, computed styles, sizes or app state.',
    inputSchema: { type: 'object', properties: { tab, expression: { type: 'string' } }, required: ['expression'] } },
  { name: 'browser_console', description: 'Console messages and uncaught errors from the page.',
    inputSchema: { type: 'object', properties: { tab, level: { type: 'string', enum: ['all', 'warn', 'error'] }, since: { type: 'number', description: 'Only entries after this sequence number (given in the previous answer).' }, limit: { type: 'number' } } } },
  { name: 'browser_network', description: 'Requests the page made: documents, fetch/XHR with status and timing, and other resources.',
    inputSchema: { type: 'object', properties: { tab, failedOnly: { type: 'boolean' }, filter: { type: 'string', description: 'Substring of the URL.' }, since: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'browser_storage', description: "Read or change the page's localStorage, sessionStorage or cookies (cookies include HttpOnly ones, scoped to the page's host). get lists everything; set adds or edits one entry; remove deletes one; clear empties the area.",
    inputSchema: { type: 'object', properties: { tab, area: { type: 'string', enum: ['local', 'session', 'cookies'] }, action: { type: 'string', enum: ['get', 'set', 'remove', 'clear'], description: 'Default get.' },
      key: { type: 'string', description: 'Storage key, or cookie name.' }, value: { type: 'string' },
      domain: { type: 'string', description: 'Cookies: defaults to the existing cookie\'s domain, else the page host.' }, path: { type: 'string' },
      expires: { type: 'number', description: 'Cookies: epoch milliseconds; omit for a session cookie.' }, httpOnly: { type: 'boolean' }, secure: { type: 'boolean' }, sameSite: { type: 'string', enum: ['Lax', 'Strict', 'None'] } },
      required: ['area'] } },
  { name: 'browser_wait', description: 'Wait until text or a selector appears (or is gone), or for a number of milliseconds.',
    inputSchema: { type: 'object', properties: { tab, text: { type: 'string' }, selector: { type: 'string' }, gone: { type: 'boolean' }, timeout: { type: 'number' }, ms: { type: 'number' } } } },
] as const;

export const BROWSER_INSTRUCTIONS = [
  'Vibrato in-app browser. When the user asks you to check, test or measure a web page ("실측", "브라우저로 확인", "playwright", QA of a local dev server), use these tools instead of launching your own browser: the user watches the same window, and their sign-ins (Google included) are already there.',
  'Typical loop: browser_open → browser_snapshot → browser_click / browser_type with refs → browser_snapshot again; browser_screenshot to look at layout; browser_console and browser_network for errors; browser_storage to read or seed localStorage, sessionStorage and cookies.',
  'The page engine is WebKit (Safari). For Playwright test files that must run in Chromium, keep using Playwright itself.',
].join('\n');

// ---------- host link (the desktop app) ----------

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
let host: WebSocket | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

export function attachBrowserHost(wss: WebSocketServer) {
  wss.on('connection', (ws) => {
    // The newest app instance wins; an older socket is dropped.
    if (host && host !== ws) { try { host.close(); } catch { /* gone */ } }
    host = ws;
    ws.on('message', (raw) => {
      let msg: { id?: number; ok?: boolean; content?: unknown; error?: string };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const p = typeof msg.id === 'number' ? pending.get(msg.id) : undefined;
      if (!p) return;
      pending.delete(msg.id!);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.content); else p.reject(new Error(msg.error || 'browser tool failed'));
    });
    ws.on('close', () => {
      if (host !== ws) return;
      host = null;
      for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('The Vibrato app went away during the call')); pending.delete(id); }
    });
  });
}

export function browserHostConnected() { return !!host && host.readyState === host.OPEN; }

function callHost(tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (!browserHostConnected()) return Promise.reject(new Error('The Vibrato desktop app is not running, so its browser is not available.'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${tool} timed out`)); }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    host!.send(JSON.stringify({ id, tool, args }));
  });
}

// ---------- MCP (JSON-RPC 2.0 over Streamable HTTP, JSON responses only) ----------

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type RpcReply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const TOOL_NAMES = new Set<string>(BROWSER_TOOLS.map((t) => t.name));

/** One JSON-RPC message; null for notifications (no reply). `call` is injectable for tests. */
export async function handleRpc(msg: Rpc, call: (tool: string, args: Record<string, unknown>) => Promise<unknown> = callHost): Promise<RpcReply | null> {
  const id = msg.id ?? null;
  const ok = (result: unknown): RpcReply => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): RpcReply => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return null; // notifications/initialized and friends
  switch (msg.method) {
    case 'initialize': {
      const asked = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL;
      return ok({ protocolVersion: asked, capabilities: { tools: { listChanged: false } }, serverInfo: { name: MCP_SERVER_NAME, title: 'Vibrato browser', version: '1.0.0' }, instructions: BROWSER_INSTRUCTIONS });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: BROWSER_TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      if (!TOOL_NAMES.has(name)) return fail(-32602, `Unknown tool: ${name}`);
      const args = (msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}) as Record<string, unknown>;
      try {
        const content = await call(name, args);
        return ok({ content: Array.isArray(content) ? content : [{ type: 'text', text: String(content) }] });
      } catch (err) {
        // Tool failures are results the model can read, not protocol errors.
        return ok({ content: [{ type: 'text', text: (err as Error).message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/** Body of POST /mcp/browser: a single message or a batch. Returns the reply body, or null for 202 Accepted. */
export async function handleMcpBody(body: unknown, call?: (tool: string, args: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleRpc(m as Rpc, call)))).filter(Boolean);
    return replies.length ? replies : null;
  }
  if (!body || typeof body !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  return handleRpc(body as Rpc, call);
}

/** Session wiring: the URL agents get, and the Codex `-c` overrides for it. */
export function browserMcpUrl(port: number) { return `http://127.0.0.1:${port}/mcp/browser`; }
export function codexBrowserArgs(port: number): string[] {
  return ['-c', `mcp_servers.${MCP_SERVER_NAME}.url=${JSON.stringify(browserMcpUrl(port))}`];
}
