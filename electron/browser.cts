import { BrowserWindow, ipcMain, nativeImage, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';
import { AGENT_HELPERS, cookieMatchesHost, PAGE_HOOKS, RELAY } from './browserScripts.cjs';

/**
 * In-app browser: a window of its own (`/?browser=1`) whose page area is a native WKWebView (native/webview)
 * placed over the spot the React UI reserves for it. WKWebView rather than Chromium because Google refuses to
 * sign in inside embedded Chromium (Electron views included, checked 2026-11), while the system web view with
 * Safari's user agent signs in and keeps the session in its own persistent store.
 *
 * The same tabs are what agents drive through the Vibrato MCP tools (server/browserMcp.ts): the server relays
 * each tool call over the /browser-host socket and this file runs it, so the user watches the agent work.
 */

interface Native {
  setEventHandler(fn: (json: string) => void): void;
  create(parent: Buffer, opts: { userAgent?: string; storeId?: string; pageScript?: string; isolatedScript?: string }): number;
  destroy(id: number): void;
  setFrame(id: number, x: number, y: number, w: number, h: number): void;
  setVisible(id: number, visible: boolean): void;
  load(id: number, url: string): void;
  nav(id: number, action: 'back' | 'forward' | 'reload' | 'stop'): void;
  focus(id: number): void;
  setZoom(id: number, factor: number): void;
  evaluate(id: number, body: string, isolated: boolean): Promise<string>;
  snapshot(id: number): Promise<Buffer>;
  click(id: number, x: number, y: number): void;
  key(id: number, keyCode: number, chars: string, modifiers: number): void;
  cookies(id: number): Promise<string>;
  setCookie(id: number, json: string): Promise<string>;
  deleteCookies(id: number, name: string, domain: string, path: string): Promise<string>;
}

export interface ConsoleEntry { seq: number; t: number; tab: number; level: string; text: string; source?: string }
export interface NetEntry { seq: number; t: number; tab: number; via: string; method: string; url: string; status?: number; type?: string; size?: number; ms?: number; error?: string }
export interface AgentEntry { seq: number; t: number; tool: string; summary: string; ok: boolean; ms: number; result?: string; image?: string }
export interface TabState { id: number; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; progress: number; opener?: number; agent?: boolean; zoom: number }
export type StorageArea = 'local' | 'session' | 'cookies';
export interface CookieItem { name: string; value: string; domain: string; path: string; expires?: number; httpOnly: boolean; secure: boolean; session: boolean; sameSite?: string }
export interface StorageOp { action: 'get' | 'set' | 'remove' | 'clear'; area: StorageArea; key?: string; value?: string; cookie?: Partial<CookieItem> }
export interface StorageResult { origin: string; items?: [string, string][]; cookies?: CookieItem[]; changed?: number }
type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

// Fixed id: the persistent WebKit store (cookies, logins) survives restarts and updates.
const STORE_ID = '3B7F6A52-0E4D-4C1A-9C2B-56A1D0E7F9B3';
const LOG_MAX = 3000;
const SAFARI_UA = (() => {
  let v = '18.0';
  try { v = execFileSync('/usr/bin/defaults', ['read', '/Applications/Safari.app/Contents/Info', 'CFBundleShortVersionString'], { encoding: 'utf8', timeout: 2000 }).trim() || v; } catch { /* keep default */ }
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v} Safari/605.1.15`;
})();

let native: Native | null = null;
let nativeError = '';
function loadNative(): Native | null {
  if (native || nativeError) return native;
  try {
    native = require(path.join(__dirname, '..', 'native', 'vibrato_webview.node')) as Native;
    native.setEventHandler(onNativeEvent);
  } catch (err) {
    nativeError = (err as Error).message;
    console.warn(`[vibrato] in-app browser unavailable: ${nativeError}`);
  }
  return native;
}

interface Deps {
  createWindow: () => BrowserWindow;
  /** Server port for the /browser-host socket. */
  port: number;
  isLocked: () => boolean;
}
let deps: Deps;
let win: BrowserWindow | null = null;
let windowReady: Promise<void> | null = null;
const tabs = new Map<number, TabState>();
let order: number[] = [];
let active: number | null = null;
let frame: { x: number; y: number; w: number; h: number } | null = null;
let seq = 0;
const consoleLog: ConsoleEntry[] = [];
const netLog: NetEntry[] = [];
const agentLog: AgentEntry[] = [];
const waiters = new Set<{ tab: number; type: string; resolve: () => void }>();

function send(channel: string, payload: unknown) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
const pushRing = <T,>(arr: T[], v: T) => { arr.push(v); if (arr.length > LOG_MAX) arr.splice(0, arr.length - LOG_MAX); };

function publishTabs() { send('browser:tabs', { tabs: order.map((id) => tabs.get(id)).filter(Boolean), active }); }

function addConsole(tab: number, level: string, text: string, source?: string) {
  const e: ConsoleEntry = { seq: ++seq, t: Date.now(), tab, level, text, ...(source ? { source } : {}) };
  pushRing(consoleLog, e); send('browser:console', e);
}
function addNet(tab: number, n: Omit<NetEntry, 'seq' | 't' | 'tab'>) {
  const e: NetEntry = { seq: ++seq, t: Date.now(), tab, ...n };
  pushRing(netLog, e); send('browser:net', e);
}

function onNativeEvent(json: string) {
  let e: Record<string, unknown>;
  try { e = JSON.parse(json); } catch { return; }
  const id = e.id as number;
  const tab = tabs.get(id);
  switch (e.type) {
    case 'state':
      if (!tab) return;
      Object.assign(tab, { url: e.url, title: e.title, loading: e.loading, canGoBack: e.canGoBack, canGoForward: e.canGoForward, progress: e.progress });
      publishTabs();
      return;
    case 'message': {
      const b = e.body as Record<string, unknown>;
      if (b?.kind === 'console') addConsole(id, String(b.level ?? 'log'), String(b.text ?? ''), (b.source as string) || undefined);
      else if (b?.kind === 'net') addNet(id, { via: String(b.via ?? ''), method: String(b.method ?? 'GET'), url: String(b.url ?? ''), status: b.status as number | undefined, type: b.type as string | undefined, size: b.size as number | undefined, ms: b.ms as number | undefined, error: b.error as string | undefined });
      return;
    }
    case 'response':
      addNet(id, { via: e.mainFrame ? 'document' : 'frame', method: 'GET', url: String(e.url), status: e.status as number, type: String(e.mime ?? '') });
      return;
    case 'failed':
      if (Number(e.code) !== -999) addConsole(id, 'error', `Load failed: ${e.error}${e.url ? ` (${e.url})` : ''}`); // -999: cancelled by a newer load
      break;
    case 'dialog':
      addConsole(id, 'info', `[${e.kind}] ${e.message}`);
      return;
    case 'crashed':
      addConsole(id, 'error', 'The page crashed; reload to continue.');
      return;
    case 'popup': {
      // window.open (OAuth and the like): a tab of its own that keeps window.opener.
      const opener = e.opener as number;
      tabs.set(id, newTabState(id, String(e.url ?? ''), opener, tabs.get(opener)?.agent));
      order.splice(order.indexOf(opener) + 1, 0, id);
      activate(id);
      return;
    }
    case 'closed':
      closeTab(id);
      return;
  }
  for (const w of waiters) if (w.tab === id && w.type === e.type) { waiters.delete(w); w.resolve(); }
}

function newTabState(id: number, url: string, opener?: number, agent?: boolean): TabState {
  return { id, url, title: '', loading: true, canGoBack: false, canGoForward: false, progress: 0, zoom: 1, ...(opener ? { opener } : {}), ...(agent ? { agent } : {}) };
}

function placeActive() {
  if (!native) return;
  for (const id of order) {
    const show = id === active && !!frame && !!win && win.isVisible() && !deps.isLocked();
    if (show && frame) native.setFrame(id, frame.x, frame.y, frame.w, frame.h);
    native.setVisible(id, show);
  }
}

function activate(id: number) {
  if (!tabs.has(id)) return;
  active = id;
  placeActive();
  publishTabs();
}

function closeTab(id: number) {
  if (!tabs.has(id)) return;
  native?.destroy(id);
  tabs.delete(id);
  const i = order.indexOf(id);
  order = order.filter((x) => x !== id);
  if (active === id) active = order[Math.min(i, order.length - 1)] ?? null;
  placeActive();
  publishTabs();
}

/** The browser window, created on first use; resolves once its page has loaded. */
function ensureWindow(focus = true): Promise<void> {
  if (win && !win.isDestroyed()) {
    if (focus) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    return windowReady ?? Promise.resolve();
  }
  win = deps.createWindow();
  const w = win;
  w.on('show', placeActive);
  w.on('hide', placeActive);
  w.on('minimize', placeActive);
  w.on('restore', placeActive);
  w.on('closed', () => {
    for (const id of order) native?.destroy(id);
    tabs.clear(); order = []; active = null; frame = null;
    if (win === w) { win = null; windowReady = null; }
  });
  windowReady = new Promise((resolve) => w.webContents.once('did-finish-load', () => resolve()));
  return windowReady;
}

function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return 'about:blank';
  if (/^(https?|about|file):/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(s) || /^[\w.-]+:\d+(\/|$)/.test(s)) return `http://${s}`;
  if (/^[^\s]+\.[a-z]{2,}(\/|$)/i.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

function openTab(url: string, agent = false): number {
  const nat = loadNative();
  if (!nat || !win) throw new Error(`In-app browser unavailable: ${nativeError || 'no window'}`);
  const id = nat.create(win.getNativeWindowHandle(), { userAgent: SAFARI_UA, storeId: STORE_ID, pageScript: PAGE_HOOKS, isolatedScript: RELAY });
  tabs.set(id, newTabState(id, url, undefined, agent));
  order.push(id);
  nat.load(id, normalizeUrl(url));
  activate(id);
  return id;
}

function waitFor(tab: number, type: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const w = { tab, type, resolve: () => { clearTimeout(timer); resolve(true); } };
    const timer = setTimeout(() => { waiters.delete(w); resolve(false); }, ms);
    waiters.add(w);
  });
}

// ---------- storage: localStorage, sessionStorage, cookies ----------

function pageHost(tab: TabState): string {
  try { return new URL(tab.url).hostname; } catch { return ''; }
}

async function storageOp(tab: TabState, op: StorageOp): Promise<StorageResult> {
  if (!native) throw new Error('browser unavailable');
  if (op.area === 'cookies') {
    const host = pageHost(tab);
    if (!host) throw new Error('the page has no host (about:blank?)');
    const all = () => native!.cookies(tab.id).then((j) => (JSON.parse(j) as CookieItem[]).filter((c) => cookieMatchesHost(c.domain, host)));
    if (op.action === 'set') {
      const c = op.cookie ?? {};
      const name = c.name ?? op.key;
      if (!name) throw new Error('cookie name is required');
      // Editing keeps the existing cookie's scope unless a new one is given.
      const prev = (await all()).find((x) => x.name === name && (!c.domain || x.domain === c.domain) && (!c.path || x.path === c.path));
      const next = { name, value: c.value ?? op.value ?? prev?.value ?? '', domain: c.domain ?? prev?.domain ?? host, path: c.path ?? prev?.path ?? '/',
        ...(c.expires !== undefined ? { expires: c.expires } : prev?.expires ? { expires: prev.expires } : {}),
        secure: c.secure ?? prev?.secure ?? false, httpOnly: c.httpOnly ?? prev?.httpOnly ?? false, sameSite: c.sameSite ?? prev?.sameSite ?? '' };
      if (prev && (prev.domain !== next.domain || prev.path !== next.path)) await native.deleteCookies(tab.id, prev.name, prev.domain, prev.path);
      await native.setCookie(tab.id, JSON.stringify(next));
      return { origin: host, cookies: await all(), changed: 1 };
    }
    if (op.action === 'remove') {
      const name = op.cookie?.name ?? op.key;
      if (!name) throw new Error('cookie name is required');
      const hits = (await all()).filter((x) => x.name === name && (!op.cookie?.domain || x.domain === op.cookie.domain) && (!op.cookie?.path || x.path === op.cookie.path));
      for (const x of hits) await native.deleteCookies(tab.id, x.name, x.domain, x.path);
      return { origin: host, cookies: await all(), changed: hits.length };
    }
    if (op.action === 'clear') {
      const list = await all();
      for (const x of list) await native.deleteCookies(tab.id, x.name, x.domain, x.path);
      return { origin: host, cookies: [], changed: list.length };
    }
    return { origin: host, cookies: await all() };
  }
  const area = op.area === 'session' ? 'sessionStorage' : 'localStorage';
  const body = `
    const S = ${area};
    const action = ${JSON.stringify(op.action)}, key = ${JSON.stringify(op.key ?? null)}, value = ${JSON.stringify(op.value ?? null)};
    let changed = 0;
    if (action === 'set') { if (key === null) throw new Error('key is required'); S.setItem(key, value ?? ''); changed = 1; }
    else if (action === 'remove') { if (key === null) throw new Error('key is required'); changed = S.getItem(key) === null ? 0 : 1; S.removeItem(key); }
    else if (action === 'clear') { changed = S.length; S.clear(); }
    const items = []; for (let i = 0; i < S.length; i++) { const k = S.key(i); items.push([k, S.getItem(k)]); }
    items.sort((a, b) => a[0].localeCompare(b[0]));
    return { origin: location.origin, items, changed };`;
  return await evalIn(tab, body) as StorageResult;
}

// ---------- user-facing IPC (the browser window's React UI) ----------

function fromBrowserWindow(e: IpcMainEvent | IpcMainInvokeEvent) { return !!win && !win.isDestroyed() && e.sender === win.webContents; }

export function initBrowser(d: Deps) {
  deps = d;
  ipcMain.handle('browser:info', (e) => {
    if (!fromBrowserWindow(e)) return null;
    loadNative();
    return { available: !!native, error: nativeError, tabs: order.map((id) => tabs.get(id)), active, console: consoleLog.slice(-500), net: netLog.slice(-500), agent: agentLog.slice(-200) };
  });
  ipcMain.on('browser:frame', (e, r: unknown) => {
    if (!fromBrowserWindow(e)) return;
    const ok = r && typeof r === 'object' && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite((r as Record<string, number>)[k]));
    frame = ok ? { ...(r as { x: number; y: number; w: number; h: number }) } : null;
    if (frame && (frame.w < 1 || frame.h < 1)) frame = null;
    placeActive();
  });
  ipcMain.handle('browser:open', (e, url: unknown) => { if (fromBrowserWindow(e) && typeof url === 'string') return openTab(url); });
  ipcMain.on('browser:activate', (e, id: unknown) => { if (fromBrowserWindow(e) && typeof id === 'number') activate(id); });
  ipcMain.on('browser:close', (e, id: unknown) => { if (fromBrowserWindow(e) && typeof id === 'number') closeTab(id); });
  ipcMain.on('browser:navigate', (e, url: unknown) => { if (fromBrowserWindow(e) && typeof url === 'string' && active) native?.load(active, normalizeUrl(url)); });
  ipcMain.on('browser:nav', (e, action: unknown) => {
    if (!fromBrowserWindow(e) || !active || !native) return;
    if (action === 'back' || action === 'forward' || action === 'reload' || action === 'stop') native.nav(active, action);
    else if (action === 'focus') native.focus(active);
  });
  ipcMain.on('browser:zoom', (e, factor: unknown) => {
    const tab = active ? tabs.get(active) : null;
    if (!fromBrowserWindow(e) || !tab || typeof factor !== 'number' || !native) return;
    tab.zoom = Math.min(3, Math.max(0.3, factor));
    native.setZoom(tab.id, tab.zoom);
    publishTabs();
  });
  ipcMain.handle('browser:storage', async (e, op: unknown) => {
    const tab = active ? tabs.get(active) : null;
    if (!fromBrowserWindow(e) || !tab || !op || typeof op !== 'object') return null;
    const o = op as StorageOp;
    if (!['get', 'set', 'remove', 'clear'].includes(o.action) || !['local', 'session', 'cookies'].includes(o.area)) return null;
    return storageOp(tab, o);
  });
  ipcMain.on('browser:clear', (e, kind: unknown) => {
    if (!fromBrowserWindow(e)) return;
    if (kind === 'console') consoleLog.length = 0; else if (kind === 'net') netLog.length = 0; else if (kind === 'agent') agentLog.length = 0;
  });
  connectHost();
}

/** Opens the browser window (and a tab for `url`), e.g. from the Run panel. */
export async function openBrowser(url?: string) {
  await ensureWindow();
  if (url) openTab(url);
  else if (!order.length && loadNative()) openTab('about:blank');
}

// ---------- agent tools (relayed by the server) ----------

const KEYS: Record<string, [number, string]> = {
  enter: [36, '\r'], return: [36, '\r'], tab: [48, '\t'], escape: [53, '\u001b'], esc: [53, '\u001b'], backspace: [51, '\u007f'], delete: [117, ''],
  space: [49, ' '], arrowup: [126, ''], arrowdown: [125, ''], arrowleft: [123, ''], arrowright: [124, ''],
  home: [115, ''], end: [119, ''], pageup: [116, ''], pagedown: [121, ''],
};
const MODS: Record<string, number> = { shift: 1, control: 2, ctrl: 2, alt: 4, option: 4, meta: 8, cmd: 8, command: 8 };

function str(v: unknown, name: string, required = false): string | undefined {
  if (v === undefined || v === null || v === '') { if (required) throw new Error(`${name} is required`); return undefined; }
  if (typeof v !== 'string') throw new Error(`${name} must be a string`);
  return v;
}

function tabFor(args: Record<string, unknown>): TabState {
  const want = args.tab;
  if (want !== undefined && want !== null) {
    const t = tabs.get(Number(want));
    if (!t) throw new Error(`no tab ${want}; call browser_tabs`);
    return t;
  }
  const t = active ? tabs.get(active) : undefined;
  if (!t) throw new Error('no tab is open; call browser_open first');
  return t;
}

async function evalIn(tab: TabState, body: string, isolated = true): Promise<unknown> {
  if (!native) throw new Error('browser unavailable');
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the page did not answer within 20s (busy, or waiting on a dialog?)')), 20000); });
  try {
    const json = await Promise.race([native.evaluate(tab.id, isolated ? `${AGENT_HELPERS}\n${body}` : body, isolated), timeout]);
    return JSON.parse(json);
  } finally { clearTimeout(timer); }
}

const describe = (tab: TabState) => `tab ${tab.id}: ${tab.title || '(untitled)'} — ${tab.url}`;

async function settle(tab: TabState, ms = 400) {
  await new Promise((r) => setTimeout(r, ms));
  if (tab.loading) await waitFor(tab.id, 'loaded', 10000);
}

const tools: Record<string, (args: Record<string, unknown>) => Promise<McpContent[]>> = {
  async browser_open(args) {
    await ensureWindow(args.focus !== false);
    const url = str(args.url, 'url') ?? 'about:blank';
    let tab: TabState;
    if (args.newTab === false && active) { tab = tabs.get(active)!; native!.load(tab.id, normalizeUrl(url)); }
    else tab = tabs.get(openTab(url, true))!;
    await waitFor(tab.id, 'loaded', 15000);
    await new Promise((r) => setTimeout(r, 150)); // the title arrives just after the load event
    return [{ type: 'text', text: `Opened ${describe(tab)}\nUse browser_snapshot to see the page and get element refs.` }];
  },
  async browser_tabs() {
    if (!order.length) return [{ type: 'text', text: 'No tabs are open.' }];
    return [{ type: 'text', text: order.map((id) => { const t = tabs.get(id)!; return `${id === active ? '*' : ' '} ${describe(t)}${t.loading ? ' (loading)' : ''}`; }).join('\n') }];
  },
  async browser_select_tab(args) {
    const tab = tabFor(args); activate(tab.id);
    return [{ type: 'text', text: `Active: ${describe(tab)}` }];
  },
  async browser_close_tab(args) {
    const tab = tabFor(args); closeTab(tab.id);
    return [{ type: 'text', text: `Closed tab ${tab.id}` }];
  },
  async browser_navigate(args) {
    const tab = tabFor(args);
    const action = str(args.action, 'action');
    const url = str(args.url, 'url');
    if (url) native!.load(tab.id, normalizeUrl(url));
    else if (action === 'back' || action === 'forward' || action === 'reload') native!.nav(tab.id, action);
    else throw new Error('url or action (back | forward | reload) is required');
    await settle(tab, 300);
    return [{ type: 'text', text: describe(tab) }];
  },
  async browser_snapshot(args) {
    const tab = tabFor(args);
    const selector = str(args.selector, 'selector');
    const depth = Number(args.maxDepth) || 40;
    const tree = await evalIn(tab, `const root = ${selector ? `__vb.find(${JSON.stringify(selector)})` : 'document.body || document.documentElement'}; return __vb.snapshot(root, ${depth});`) as string;
    return [{ type: 'text', text: `${describe(tab)}\n\n${tree || '(empty page)'}` }];
  },
  async browser_click(args) {
    const tab = tabFor(args);
    const target = str(args.ref, 'ref') ?? str(args.selector, 'selector', true)!;
    const c = await evalIn(tab, `return await __vb.center(__vb.find(${JSON.stringify(target)}));`) as { x: number; y: number; covered: string | null };
    activate(tab.id);
    native!.click(tab.id, c.x * tab.zoom, c.y * tab.zoom);
    if (args.double) { await new Promise((r) => setTimeout(r, 60)); native!.click(tab.id, c.x * tab.zoom, c.y * tab.zoom); }
    await settle(tab);
    return [{ type: 'text', text: `Clicked ${target}${c.covered ? ` (warning: the point was covered by ${c.covered})` : ''}\n${describe(tab)}` }];
  },
  async browser_type(args) {
    const tab = tabFor(args);
    const target = str(args.ref, 'ref') ?? str(args.selector, 'selector', true)!;
    const text = typeof args.text === 'string' ? args.text : '';
    const result = await evalIn(tab, `
      const el = __vb.find(${JSON.stringify(target)});
      el.focus();
      if (${args.clear !== false}) { if (typeof el.select === 'function') el.select(); else document.execCommand('selectAll'); }
      const before = 'value' in el ? el.value : el.textContent;
      if (!document.execCommand('insertText', false, ${JSON.stringify(text)})) {
        const proto = Object.getPrototypeOf(el); const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) { setter.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
        else el.textContent = ${JSON.stringify(text)};
      }
      return { value: 'value' in el ? el.value : el.textContent, changed: ('value' in el ? el.value : el.textContent) !== before };`) as { value: string };
    if (args.submit) { native!.focus(tab.id); native!.key(tab.id, 36, '\r', 0); await settle(tab); }
    return [{ type: 'text', text: `Typed into ${target}; value is now ${JSON.stringify(String(result.value ?? '').slice(0, 200))}${args.submit ? ' and pressed Enter' : ''}\n${describe(tab)}` }];
  },
  async browser_press(args) {
    const tab = tabFor(args);
    const combo = str(args.key, 'key', true)!;
    const parts = combo.split('+');
    const keyName = parts.pop()!;
    const mods = parts.reduce((m, p) => m | (MODS[p.toLowerCase()] ?? 0), 0);
    const k = KEYS[keyName.toLowerCase()] ?? (keyName.length === 1 ? [0, keyName] as [number, string] : null);
    if (!k) throw new Error(`unknown key ${keyName}`);
    activate(tab.id);
    native!.focus(tab.id);
    native!.key(tab.id, k[0], k[1], mods);
    await settle(tab, 250);
    return [{ type: 'text', text: `Pressed ${combo}\n${describe(tab)}` }];
  },
  async browser_select_option(args) {
    const tab = tabFor(args);
    const target = str(args.ref, 'ref') ?? str(args.selector, 'selector', true)!;
    const values = Array.isArray(args.values) ? args.values.map(String) : [str(args.value, 'value', true)!];
    const picked = await evalIn(tab, `
      const el = __vb.find(${JSON.stringify(target)});
      if (el.tagName !== 'SELECT') throw new Error('not a <select>; click the option instead');
      const want = ${JSON.stringify(values)};
      for (const o of el.options) o.selected = want.includes(o.value) || want.includes(o.label.trim());
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      return [...el.selectedOptions].map((o) => o.label.trim());`) as string[];
    return [{ type: 'text', text: `Selected ${JSON.stringify(picked)} in ${target}` }];
  },
  async browser_screenshot(args) {
    const tab = tabFor(args);
    activate(tab.id);
    if (!frame || !win?.isVisible()) throw new Error('the browser window is hidden; it must be on screen for a screenshot');
    let png = await native!.snapshot(tab.id);
    const target = str(args.ref, 'ref') ?? str(args.selector, 'selector');
    if (target) {
      const c = await evalIn(tab, `return await __vb.center(__vb.find(${JSON.stringify(target)}));`) as { x: number; y: number; w: number; h: number };
      png = await native!.snapshot(tab.id); // after scrollIntoView
      const img = nativeImage.createFromBuffer(png);
      const scale = img.getSize().width / (frame.w || 1);
      const pad = 8;
      const r = { x: Math.max(0, Math.round((c.x - c.w / 2 - pad) * tab.zoom * scale)), y: Math.max(0, Math.round((c.y - c.h / 2 - pad) * tab.zoom * scale)), width: Math.round((c.w + pad * 2) * tab.zoom * scale), height: Math.round((c.h + pad * 2) * tab.zoom * scale) };
      const size = img.getSize();
      r.width = Math.min(r.width, size.width - r.x); r.height = Math.min(r.height, size.height - r.y);
      png = img.crop(r).toPNG();
    }
    lastShot = `data:image/png;base64,${nativeImage.createFromBuffer(png).resize({ width: 480 }).toPNG().toString('base64')}`;
    return [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: describe(tab) }];
  },
  async browser_eval(args) {
    const tab = tabFor(args);
    const code = str(args.expression, 'expression', true)!;
    const body = /\breturn\b/.test(code) ? code : `return (${code});`;
    const value = await evalIn(tab, body, false);
    return [{ type: 'text', text: JSON.stringify(value, null, 2)?.slice(0, 50000) ?? 'undefined' }];
  },
  async browser_console(args) {
    const tab = args.tab !== undefined ? tabFor(args).id : null;
    const level = str(args.level, 'level');
    const since = Number(args.since) || 0;
    const rows = consoleLog.filter((e) => (tab === null || e.tab === tab) && e.seq > since && (!level || (level === 'error' ? e.level === 'error' : level === 'warn' ? ['error', 'warn'].includes(e.level) : true)));
    const limit = Number(args.limit) || 100;
    const shown = rows.slice(-limit);
    const last = consoleLog.at(-1)?.seq ?? 0;
    return [{ type: 'text', text: `${shown.length} of ${rows.length} messages (pass since=${last} to see only newer ones)\n` + shown.map((e) => `[${e.level}] (tab ${e.tab}) ${e.text}${e.source ? ` @ ${e.source}` : ''}`).join('\n') }];
  },
  async browser_network(args) {
    const tab = args.tab !== undefined ? tabFor(args).id : null;
    const filter = str(args.filter, 'filter');
    const since = Number(args.since) || 0;
    const rows = netLog.filter((e) => (tab === null || e.tab === tab) && e.seq > since && (!args.failedOnly || e.error || (e.status ?? 0) >= 400) && (!filter || e.url.includes(filter)));
    const limit = Number(args.limit) || 100;
    const shown = rows.slice(-limit);
    const last = netLog.at(-1)?.seq ?? 0;
    return [{ type: 'text', text: `${shown.length} of ${rows.length} requests (pass since=${last} to see only newer ones; resource entries without a status are images/scripts/styles whose status WebKit does not expose)\n` + shown.map((e) => `${e.method} ${e.error ? `ERR ${e.error}` : e.status ?? '-'} ${e.via} ${e.url}${e.ms !== undefined ? ` ${e.ms}ms` : ''}`).join('\n') }];
  },
  async browser_storage(args) {
    const tab = tabFor(args);
    const action = (str(args.action, 'action') ?? 'get') as StorageOp['action'];
    const area = (str(args.area, 'area', true)) as StorageArea;
    if (!['get', 'set', 'remove', 'clear'].includes(action)) throw new Error('action must be get, set, remove or clear');
    if (!['local', 'session', 'cookies'].includes(area)) throw new Error('area must be local, session or cookies');
    const cookie: Partial<CookieItem> | undefined = area === 'cookies' ? {
      ...(typeof args.key === 'string' ? { name: args.key } : {}), ...(typeof args.value === 'string' ? { value: args.value } : {}),
      ...(typeof args.domain === 'string' ? { domain: args.domain } : {}), ...(typeof args.path === 'string' ? { path: args.path } : {}),
      ...(typeof args.expires === 'number' ? { expires: args.expires } : {}), ...(typeof args.httpOnly === 'boolean' ? { httpOnly: args.httpOnly } : {}),
      ...(typeof args.secure === 'boolean' ? { secure: args.secure } : {}), ...(typeof args.sameSite === 'string' ? { sameSite: args.sameSite } : {}),
    } : undefined;
    const r = await storageOp(tab, { action, area, key: str(args.key, 'key'), value: typeof args.value === 'string' ? args.value : undefined, cookie });
    send('browser:storage-changed', { tab: tab.id });
    const clipv = (v: string) => (v.length > 500 ? `${v.slice(0, 500)}… (${v.length} chars)` : v);
    const lines = area === 'cookies'
      ? (r.cookies ?? []).map((c) => `${c.name}=${clipv(c.value)}  domain=${c.domain} path=${c.path}${c.expires ? ` expires=${new Date(c.expires).toISOString()}` : ' session'}${c.httpOnly ? ' HttpOnly' : ''}${c.secure ? ' Secure' : ''}${c.sameSite ? ` SameSite=${c.sameSite}` : ''}`)
      : (r.items ?? []).map(([k, v]) => `${k} = ${clipv(v)}`);
    const head = `${area === 'cookies' ? 'Cookies for' : `${area}Storage of`} ${r.origin}${action !== 'get' ? ` (${action}: ${r.changed ?? 0} changed)` : ''}: ${lines.length} entr${lines.length === 1 ? 'y' : 'ies'}`;
    return [{ type: 'text', text: [head, ...lines].join('\n') }];
  },
  async browser_wait(args) {
    const tab = tabFor(args);
    const text = str(args.text, 'text');
    const selector = str(args.selector, 'selector');
    const gone = !!args.gone;
    if (!text && !selector) { await new Promise((r) => setTimeout(r, Math.min(30000, Number(args.ms) || 1000))); return [{ type: 'text', text: 'Waited.' }]; }
    const deadline = Date.now() + Math.min(60000, Number(args.timeout) || 10000);
    while (Date.now() < deadline) {
      const found = await evalIn(tab, selector ? `return !!document.querySelector(${JSON.stringify(selector)});` : `return (document.body?.innerText || '').includes(${JSON.stringify(text)});`).catch(() => false);
      if (found !== gone) return [{ type: 'text', text: `${selector ?? JSON.stringify(text)} ${gone ? 'is gone' : 'appeared'}\n${describe(tab)}` }];
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timed out waiting for ${selector ?? JSON.stringify(text)}${gone ? ' to disappear' : ''}`);
  },
};
let lastShot: string | undefined;

export async function runTool(name: string, args: Record<string, unknown>): Promise<McpContent[]> {
  const fn = tools[name];
  if (!fn) throw new Error(`unknown tool ${name}`);
  if (deps.isLocked()) throw new Error('Vibrato is locked');
  if (!loadNative()) throw new Error(`In-app browser unavailable: ${nativeError}`);
  if (name !== 'browser_open' && !win) await ensureWindow(false);
  const t0 = Date.now();
  lastShot = undefined;
  const summary = JSON.stringify(args).slice(0, 300);
  try {
    const out = await fn(args);
    const text = out.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
    const e: AgentEntry = { seq: ++seq, t: Date.now(), tool: name, summary, ok: true, ms: Date.now() - t0, result: text.slice(0, 2000), ...(lastShot ? { image: lastShot } : {}) };
    pushRing(agentLog, e); send('browser:agent', e);
    return out;
  } catch (err) {
    const e: AgentEntry = { seq: ++seq, t: Date.now(), tool: name, summary, ok: false, ms: Date.now() - t0, result: (err as Error).message };
    pushRing(agentLog, e); send('browser:agent', e);
    throw err;
  }
}

// ---------- server link ----------

/**
 * Keeps a socket to the server's /browser-host endpoint and runs the tool calls it relays. Reconnects on its
 * own, so a restarted or adopted server picks the app back up.
 */
function connectHost() {
  const retry = () => setTimeout(connectHost, 2000);
  const ws = new WebSocket(`ws://127.0.0.1:${deps.port}/browser-host`);
  ws.on('message', async (data) => {
    let msg: { id: number; tool: string; args?: Record<string, unknown> };
    try { msg = JSON.parse(String(data)); } catch { return; }
    let reply: unknown;
    try { reply = { id: msg.id, ok: true, content: await runTool(msg.tool, msg.args ?? {}) }; }
    catch (err) { reply = { id: msg.id, ok: false, error: (err as Error).message }; }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  });
  ws.on('close', retry);
  ws.on('error', () => { /* 'close' follows and retries */ });
}
