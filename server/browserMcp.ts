import { randomUUID } from 'node:crypto';
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
  ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. "e12".' },
  selector: { type: 'string', description: 'CSS selector, used when no ref is given.' },
} as const;
const force = { type: 'boolean', description: 'Act on a tab another session is driving.' } as const;

export const BROWSER_TOOLS = [
  { name: 'browser_open', description: 'Open a URL in the Vibrato in-app browser: a new tab owned by this session, which the user watches (your cursor has its own colour and label). Use it first whenever you need to look at, test or measure a web page. Google and other sign-ins the user made there are kept.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'e.g. http://localhost:3000/login' }, newTab: { type: 'boolean', description: 'false reuses your current tab. Default true.' }, focus: { type: 'boolean', description: 'Bring the browser window to the front. Default false.' } } } },
  { name: 'browser_tabs', description: 'List open tabs: id, title, URL, who drives each ([yours], another session, or [user]); * marks your current tab.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_select_tab', description: 'Make a tab your current one (and show it).', inputSchema: { type: 'object', properties: { tab }, required: ['tab'] } },
  { name: 'browser_close_tab', description: 'Close a tab.', inputSchema: { type: 'object', properties: { tab, force } } },
  { name: 'browser_navigate', description: 'Load a URL in a tab, or go back / forward / reload.',
    inputSchema: { type: 'object', properties: { tab, url: { type: 'string' }, action: { type: 'string', enum: ['back', 'forward', 'reload'] }, force } } },
  { name: 'browser_snapshot', description: 'Accessibility-style outline of the page with refs (e.g. [ref=e12]) for what you can act on. Modes: full (default), interactive (only controls, flat; cheapest), compact (drops wrappers and stray text), skeleton (landmarks and headings with counts; then pass root=<ref> to drill in). Take one before acting and again after the page changes. Password fields show [hidden].',
    inputSchema: { type: 'object', properties: { tab, interactive: { type: 'boolean' }, compact: { type: 'boolean' }, skeleton: { type: 'boolean' }, root: { type: 'string', description: 'Ref or CSS selector: outline only this part.' }, maxDepth: { type: 'number' } } } },
  { name: 'browser_click', description: 'Real mouse click on an element. Waits (up to timeout ms, default 5000) until it is visible, enabled, still and not covered, then reports what changed: the element state, navigation, new tabs, console errors, failed requests, dialogs.',
    inputSchema: { type: 'object', properties: { tab, ...target, double: { type: 'boolean' }, timeout: { type: 'number' }, force } } },
  { name: 'browser_hover', description: 'Move the mouse over an element (menus, tooltips).', inputSchema: { type: 'object', properties: { tab, ...target, timeout: { type: 'number' }, force } } },
  { name: 'browser_type', description: 'Click into an input, textarea or contenteditable and type text (replaces its content unless clear is false). Reports what changed; secret fields are never echoed.',
    inputSchema: { type: 'object', properties: { tab, ...target, text: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean', description: 'Press Enter afterwards.' }, timeout: { type: 'number' }, force }, required: ['text'] } },
  { name: 'browser_press', description: 'Press a key in the focused element, e.g. Enter, Escape, Tab, ArrowDown, Meta+A.',
    inputSchema: { type: 'object', properties: { tab, key: { type: 'string' }, force }, required: ['key'] } },
  { name: 'browser_select_option', description: 'Choose option(s) of a <select> by value or label.',
    inputSchema: { type: 'object', properties: { tab, ...target, value: { type: 'string' }, values: { type: 'array', items: { type: 'string' } }, force } } },
  { name: 'browser_scroll', description: 'Scroll the page or a scrollable element: by y (and x) pixels, direction up/down, to top/bottom, or bring an element (ref/selector) into view.',
    inputSchema: { type: 'object', properties: { tab, ...target, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, y: { type: 'number' }, x: { type: 'number' }, to: { type: 'string', enum: ['top', 'bottom'] }, force } } },
  { name: 'browser_drag', description: 'Drag from one element to another, or by dx/dy pixels. Draggable (draggable="true") sources get HTML5 drag-and-drop events; everything else a real mouse drag (sliders, sortable lists, canvases).',
    inputSchema: { type: 'object', properties: { tab, from: { type: 'string', description: 'Ref or selector to press on.' }, to: { type: 'string', description: 'Ref or selector to release on.' }, dx: { type: 'number' }, dy: { type: 'number' }, force }, required: ['from'] } },
  { name: 'browser_upload', description: 'Upload local files through a file input or the button that opens one: the file chooser gets these files instead of opening.',
    inputSchema: { type: 'object', properties: { tab, ...target, files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths.' }, force }, required: ['files'] } },
  { name: 'browser_dialog', description: 'Decide how the next confirm()/prompt() is answered (alerts are always closed). Dialogs that happen are reported by the action that caused them.',
    inputSchema: { type: 'object', properties: { tab, accept: { type: 'boolean', description: 'Default true.' }, text: { type: 'string', description: 'Answer for prompt().' }, once: { type: 'boolean', description: 'Only the next dialog (default true).' } } } },
  { name: 'browser_viewport', description: 'Emulate a device: the page area becomes that size (the user sees a phone frame) and, with mobile (default), an iPhone/iPad user agent. Presets: iphone-se, iphone-15, iphone-15-pro-max, pixel-8, galaxy-s24, ipad-mini, ipad-pro-11. off restores the desktop view.',
    inputSchema: { type: 'object', properties: { tab, preset: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' }, landscape: { type: 'boolean' }, mobile: { type: 'boolean' }, off: { type: 'boolean' } } } },
  { name: 'browser_measure', description: 'Exact measurements of an element for 실측 (comparing with a design): size and position, padding/margin/border, border radius, font family/size/weight/line height/letter spacing, colors, flex/grid gap. With other, also the distance between the two elements.',
    inputSchema: { type: 'object', properties: { tab, ...target, other: { type: 'string', description: 'A second ref or selector.' } } } },
  { name: 'browser_screenshot', description: 'Screenshot of the visible page, or of one element (ref / selector). Returns a PNG image.',
    inputSchema: { type: 'object', properties: { tab, ...target } } },
  { name: 'browser_compare', description: 'Visual regression: the first call saves a baseline screenshot under name; later calls compare against it and return the share of changed pixels plus a diff image with the changes in red. update replaces the baseline.',
    inputSchema: { type: 'object', properties: { tab, name: { type: 'string' }, ...target, update: { type: 'boolean' } }, required: ['name'] } },
  { name: 'browser_eval', description: 'Run JavaScript in the page and return the JSON result. An expression, or a function body using `return` (await is allowed). Use it to read DOM details, computed styles or app state.',
    inputSchema: { type: 'object', properties: { tab, expression: { type: 'string' }, force }, required: ['expression'] } },
  { name: 'browser_console', description: 'Console messages, uncaught errors, dialogs and downloads of your tab.',
    inputSchema: { type: 'object', properties: { tab, level: { type: 'string', enum: ['all', 'warn', 'error'] }, since: { type: 'number', description: 'Only entries after this sequence number (given in the previous answer).' }, limit: { type: 'number' } } } },
  { name: 'browser_network', description: 'Requests of your tab: documents, fetch/XHR with status and timing (#id), other resources. browser_network_detail shows headers and bodies.',
    inputSchema: { type: 'object', properties: { tab, failedOnly: { type: 'boolean' }, apiOnly: { type: 'boolean', description: 'Only fetch/XHR.' }, filter: { type: 'string', description: 'Substring of the URL.' }, since: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'browser_network_detail', description: 'Request and response headers and bodies (fetch/XHR, up to 64 KB each) of one request from browser_network.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'browser_mock', description: 'Answer fetch/XHR requests whose URL contains url (a regular expression with regex: true) with a fixed response, to test error and empty states. Applies at once, to the tab it is set on and its popups (allTabs: true for every tab), and is dropped when that tab or the browser window closes. action add (default), list, remove (id), clear. Images, scripts and styles are not mocked. Never block login or token endpoints (e.g. /auth/token): sign-in would loop back to the login page.',
    inputSchema: { type: 'object', properties: { tab, action: { type: 'string', enum: ['add', 'list', 'remove', 'clear'] }, url: { type: 'string', description: 'Part of the request URL, e.g. /api/users' }, regex: { type: 'boolean' }, allTabs: { type: 'boolean' }, method: { type: 'string' }, status: { type: 'number' }, body: { description: 'String, or JSON value.' }, contentType: { type: 'string' }, headers: { type: 'object' }, id: { type: 'number' }, reload: { type: 'boolean' } } } },
  { name: 'browser_storage', description: "Read or change the page's localStorage, sessionStorage or cookies (cookies include HttpOnly ones, scoped to the page's host). get lists everything; set adds or edits one entry; remove deletes one; clear empties the area.",
    inputSchema: { type: 'object', properties: { tab, area: { type: 'string', enum: ['local', 'session', 'cookies'] }, action: { type: 'string', enum: ['get', 'set', 'remove', 'clear'], description: 'Default get.' },
      key: { type: 'string', description: 'Storage key, or cookie name.' }, value: { type: 'string' },
      domain: { type: 'string', description: "Cookies: defaults to the existing cookie's domain, else the page host." }, path: { type: 'string' },
      expires: { type: 'number', description: 'Cookies: epoch milliseconds (WebKit caps it at about 400 days); omit for a session cookie.' }, httpOnly: { type: 'boolean' }, secure: { type: 'boolean' }, sameSite: { type: 'string', enum: ['Lax', 'Strict', 'None'] }, force },
      required: ['area'] } },
  { name: 'browser_wait', description: 'Wait until text or a selector appears (or is gone), until the network is idle, or for a number of milliseconds.',
    inputSchema: { type: 'object', properties: { tab, text: { type: 'string' }, selector: { type: 'string' }, gone: { type: 'boolean' }, networkIdle: { type: 'boolean' }, idle: { type: 'number', description: 'Quiet period for networkIdle (ms, default 500).' }, timeout: { type: 'number' }, ms: { type: 'number' } } } },
  { name: 'browser_perf', description: 'Page performance: TTFB, DOMContentLoaded, load, first and largest contentful paint, layout shift, resource count and size, DOM size.', inputSchema: { type: 'object', properties: { tab } } },
  { name: 'browser_a11y', description: 'Accessibility audit with axe-core: violated rules by impact, with example elements. Optionally only inside a selector.', inputSchema: { type: 'object', properties: { tab, selector: { type: 'string' } } } },
  { name: 'browser_export', description: "Save what this session did in the browser as a Playwright test (.spec.ts, returned inline too) or an HTML report with screenshots, in ~/Downloads. all includes every session's steps.",
    inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['playwright', 'html'] }, all: { type: 'boolean' } } } },
  { name: 'browser_batch', description: 'Run several browser tools in one call, in order: steps = [{ tool: "click", args: { ref: "e3" } }, ...] (tool names with or without the browser_ prefix). Stops at the first failure unless stopOnError is false.',
    inputSchema: { type: 'object', properties: { steps: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool'] } }, stopOnError: { type: 'boolean' } }, required: ['steps'] } },
] as const;

export const BROWSER_INSTRUCTIONS = [
  'Vibrato in-app browser. When the user asks you to check, test or measure a web page ("실측", "브라우저로 확인", "playwright", QA of a local dev server), use these tools instead of launching your own browser: the user watches the same window, and their sign-ins (Google included) are already there.',
  'Typical loop: browser_open → browser_snapshot (interactive: true) → browser_click / browser_type with refs (each reports what changed) → browser_snapshot again when the page changed. browser_batch runs several steps in one call. Large pages: snapshot skeleton first, then root=<ref>.',
  'For 실측: browser_measure (box model, fonts, colors, distances), browser_screenshot, browser_compare (visual diff), browser_viewport (phone/tablet sizes). For debugging: browser_console, browser_network (+ _detail for bodies), browser_mock, browser_storage, browser_perf, browser_a11y.',
  'Errors start with a code (STALE_REF, NOT_VISIBLE, OCCLUDED, TIMEOUT, OWNED_BY_OTHER, PAUSED, ...) and say whether a retry is safe and what to do next. browser_export turns the session into a Playwright test.',
  'The page engine is WebKit (Safari). For Playwright test files that must run in Chromium, keep using Playwright itself.',
].join('\n');

// ---------- sessions: each agent session gets a token in its MCP URL, and with it a cursor colour and label ----------

export interface BrowserSession { key: string; label: string; color: string }
const SESSION_COLORS = ['#4299FF', '#F25F5C', '#2EC4B6', '#F5A524', '#9B5DE5', '#00BBF9', '#F15BB5', '#7BD389'];
const sessionsByToken = new Map<string, BrowserSession>();
let colorIndex = 0;

/** A token for one agent session's MCP URL; the browser shows that session's cursor and tabs with this label and colour. */
export function registerBrowserSession(label: string): string {
  const key = randomUUID().replace(/-/g, '').slice(0, 12);
  sessionsByToken.set(key, { key, label: label.slice(0, 60), color: SESSION_COLORS[colorIndex++ % SESSION_COLORS.length] });
  if (sessionsByToken.size > 500) sessionsByToken.delete(sessionsByToken.keys().next().value!);
  return key;
}
export function browserSession(token: string | undefined | null): BrowserSession | undefined {
  return token ? sessionsByToken.get(token) : undefined;
}

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

function callHost(tool: string, args: Record<string, unknown>, session?: BrowserSession): Promise<unknown> {
  if (!browserHostConnected()) return Promise.reject(new Error('The Vibrato desktop app is not running, so its browser is not available.'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${tool} timed out`)); }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    host!.send(JSON.stringify({ id, tool, args, ...(session ? { session } : {}) }));
  });
}

// ---------- MCP (JSON-RPC 2.0 over Streamable HTTP, JSON responses only) ----------

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type RpcReply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const TOOL_NAMES = new Set<string>(BROWSER_TOOLS.map((t) => t.name));

/** One JSON-RPC message; null for notifications (no reply). `call` is injectable for tests. */
export async function handleRpc(msg: Rpc, call?: (tool: string, args: Record<string, unknown>) => Promise<unknown>, session?: BrowserSession): Promise<RpcReply | null> {
  const run = call ?? ((tool: string, args: Record<string, unknown>) => callHost(tool, args, session));
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
        const content = await run(name, args);
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
export async function handleMcpBody(body: unknown, call?: (tool: string, args: Record<string, unknown>) => Promise<unknown>, session?: BrowserSession): Promise<unknown> {
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map((m) => handleRpc(m as Rpc, call, session)))).filter(Boolean);
    return replies.length ? replies : null;
  }
  if (!body || typeof body !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  return handleRpc(body as Rpc, call, session);
}

/** Session wiring: the URL agents get, and the Codex `-c` overrides for it. */
export function browserMcpUrl(port: number, token?: string) { return `http://127.0.0.1:${port}/mcp/browser${token ? `?s=${token}` : ''}`; }
export function codexBrowserArgs(port: number, token?: string): string[] {
  return [
    '-c', `mcp_servers.${MCP_SERVER_NAME}.url=${JSON.stringify(browserMcpUrl(port, token))}`,
    // Like Claude (server/agents/claude.ts canUseTool): these tools only drive the in-app browser the user watches,
    // so Codex does not stop for an approval on every click.
    '-c', `mcp_servers.${MCP_SERVER_NAME}.default_tools_approval_mode="approve"`,
  ];
}
