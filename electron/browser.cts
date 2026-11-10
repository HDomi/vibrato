import { BrowserWindow, ipcMain, nativeImage, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { AGENT_HELPERS, cookieMatchesHost, DEVICES, diffBitmaps, handPath, MOBILE_UA, pageHooks, playwrightScript, RELAY, TABLET_UA, type MockRule } from './browserScripts.cjs';

/**
 * In-app browser: a window of its own (`/?browser=1`) whose page area is a native WKWebView (native/webview)
 * placed over the spot the React UI reserves for it. WKWebView rather than Chromium because Google refuses to
 * sign in inside embedded Chromium (Electron views included, checked 2026-11), while the system web view with
 * Safari's user agent signs in and keeps the session in its own persistent store.
 *
 * The same tabs are what agents drive through the Vibrato MCP tools (server/browserMcp.ts): the server relays
 * each tool call over the /browser-host socket and this file runs it, so the user watches the agent work. Each
 * agent session has its own coloured cursor (drawn on a native overlay, never in the page or its screenshots),
 * owns the tabs it opens, and gets structured errors and a post-action report modelled on vercel-labs/agent-desktop.
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
  mouse(id: number, type: 'move' | 'down' | 'drag' | 'up', x: number, y: number, clicks: number): void;
  setUserAgent(id: number, ua: string): void;
  setUploadFiles(id: number, json: string): void;
  setDialogPolicy(id: number, accept: boolean, text: string | null, once: boolean): void;
  setScripts(id: number, page: string, isolated: string): void;
  overlayAttach(parent: Buffer): void;
  overlayFrame(x: number, y: number, w: number, h: number, visible: boolean): void;
  cursorMove(json: string): Promise<string>;
  cursorEffect(json: string): void;
  highlight(json: string): void;
  boxes(json: string): void;
  setCorners(id: number, radius: number, mask: number): void;
  overlayCorners(radius: number, mask: number): void;
}

export interface SessionInfo { key: string; label: string; color: string }
export interface Device { width: number; height: number; preset?: string; mobile: boolean }
export interface ConsoleEntry { seq: number; t: number; tab: number; level: string; text: string; source?: string }
export interface NetEntry { seq: number; t: number; tab: number; via: string; method: string; url: string; status?: number; type?: string; size?: number; ms?: number; error?: string; rid?: string; mocked?: number }
export interface AgentEntry { seq: number; t: number; tool: string; summary: string; ok: boolean; ms: number; result?: string; image?: string; session?: SessionInfo; pw?: string[]; url?: string }
export interface TabState { id: number; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; progress: number; opener?: number; owner?: SessionInfo; zoom: number; device?: Device | null }
export type StorageArea = 'local' | 'session' | 'cookies';
export interface CookieItem { name: string; value: string; domain: string; path: string; expires?: number; httpOnly: boolean; secure: boolean; session: boolean; sameSite?: string }
export interface StorageOp { action: 'get' | 'set' | 'remove' | 'clear'; area: StorageArea; key?: string; value?: string; cookie?: Partial<CookieItem> }
export interface StorageResult { origin: string; items?: [string, string][]; cookies?: CookieItem[]; changed?: number }
type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
interface Ctx { session?: SessionInfo }
interface NetBody { reqBody?: string; resBody?: string; reqHeaders?: Record<string, string>; resHeaders?: Record<string, string> }
type Rect = { x: number; y: number; w: number; h: number };
/** The page area from the renderer: its rect and the corner rounding of the card or phone screen around it. */
type Frame = Rect & { r?: number; corners?: number };

/** A failure the agent can act on: a code, whether retrying is safe, and what to do next. */
class ToolError extends Error {
  constructor(public code: string, message: string, public retry: 'safe' | 'unsafe' | 'no' = 'safe', public hint?: string) { super(message); }
}
const HINTS: Record<string, string> = {
  STALE_REF: 'take a new browser_snapshot and use its refs',
  NOT_FOUND: 'check the selector, or take a browser_snapshot',
  NOT_VISIBLE: 'scroll, open the menu or dialog that holds it, or wait',
  NOT_ENABLED: 'fill in what the form needs first, or wait',
  NOT_STABLE: 'wait for the animation to finish and retry',
  OCCLUDED: 'close the overlay or popup covering it, or scroll',
  NOT_EDITABLE: 'type into an input, textarea or contenteditable',
};
/** Errors thrown inside the page start with "CODE: ". */
function fromPage(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  // WebKit prefixes exceptions from the page with their type ("Error: ").
  const msg = ((err as Error)?.message ?? String(err)).replace(/^(?:[A-Za-z]*Error: )+/, '');
  const m = /^([A-Z_]{4,}): (.*)$/s.exec(msg);
  return m ? new ToolError(m[1], m[2], 'safe', HINTS[m[1]]) : new ToolError('PAGE_ERROR', msg, 'safe');
}

// Fixed id: the persistent WebKit store (cookies, logins) survives restarts and updates.
const STORE_ID = '3B7F6A52-0E4D-4C1A-9C2B-56A1D0E7F9B3';
const LOG_MAX = 3000;
const BODIES_MAX = 400;
const DEFAULT_SESSION: SessionInfo = { key: 'agent', label: 'Agent', color: '#4299FF' };
const DATA_DIR = path.join(os.homedir(), '.vibrato', 'browser');
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

interface Deps { createWindow: () => BrowserWindow; port: number; isLocked: () => boolean }
let deps: Deps;
let win: BrowserWindow | null = null;
let windowReady: Promise<void> | null = null;
const tabs = new Map<number, TabState>();
let order: number[] = [];
let active: number | null = null;
let frame: Frame | null = null;
let seq = 0;
const consoleLog: ConsoleEntry[] = [];
const netLog: NetEntry[] = [];
const agentLog: AgentEntry[] = [];
const bodies = new Map<string, NetBody>();
const pendingReq = new Map<number, Set<string>>();
const dialogsSeen = new Map<number, string[]>();
const downloadsSeen = new Map<number, string[]>();
const waiters = new Set<{ tab: number; type: string; resolve: () => void }>();
const sessionTab = new Map<string, number>();
const cursorAt = new Map<string, { x: number; y: number }>();
const lastSnapshot = new Map<number, string[]>();
const leases = new Map<number, Promise<unknown>>();
/** A mock with its scope: the tabs it was set on (and their popups), or every tab. Only the rule goes into pages. */
type MockEntry = MockRule & { tabs: number[]; all?: boolean; by?: string };
let mocks: MockEntry[] = [];
let mockSeq = 0;
let paused = false;
const pauseWaiters = new Set<() => void>();
let showRefs = false;
let picking = false;
let refTimer: NodeJS.Timeout | null = null;

function send(channel: string, payload: unknown) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
const pushRing = <T,>(arr: T[], v: T) => { arr.push(v); if (arr.length > LOG_MAX) arr.splice(0, arr.length - LOG_MAX); };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const flags = () => ({ paused, picking, refs: showRefs, mocks });
const pageRule = ({ tabs: _t, all: _a, by: _b, ...rule }: MockEntry): MockRule => rule;
/** The mocks that apply in a tab: rules set on it or on the tab that opened it, and the all-tabs ones. */
function mocksFor(id: number): MockRule[] {
  const opener = tabs.get(id)?.opener;
  return mocks.filter((m) => m.all || m.tabs.includes(id) || (opener !== undefined && m.tabs.includes(opener))).map(pageRule);
}
function publishTabs() { send('browser:tabs', { tabs: order.map((id) => tabs.get(id)).filter(Boolean), active }); }
function publishFlags() { send('browser:flags', flags()); }
const cropRect = (r: Rect, z: number, scale: number, pad: number, size: { width: number; height: number }) => {
  const c = { x: Math.max(0, Math.round((r.x - pad) * z * scale)), y: Math.max(0, Math.round((r.y - pad) * z * scale)), width: Math.round((r.w + pad * 2) * z * scale), height: Math.round((r.h + pad * 2) * z * scale) };
  c.width = Math.max(1, Math.min(c.width, size.width - c.x)); c.height = Math.max(1, Math.min(c.height, size.height - c.y));
  return c;
};

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
    case 'navigated':
      pendingReq.get(id)?.clear();
      if (id === active) void drawRefs();
      break;
    case 'message': {
      const b = e.body as Record<string, unknown>;
      if (!b) return;
      if (b.kind === 'console') addConsole(id, String(b.level ?? 'log'), String(b.text ?? ''), (b.source as string) || undefined);
      else if (b.kind === 'netstart') { const set = pendingReq.get(id) ?? new Set(); set.add(String(b.rid)); pendingReq.set(id, set); }
      else if (b.kind === 'net') {
        if (b.rid) pendingReq.get(id)?.delete(String(b.rid));
        addNet(id, { via: String(b.via ?? ''), method: String(b.method ?? 'GET'), url: String(b.url ?? ''), status: b.status as number | undefined, type: b.type as string | undefined, size: b.size as number | undefined, ms: b.ms as number | undefined, error: b.error as string | undefined, ...(b.rid ? { rid: String(b.rid) } : {}), ...(b.mocked ? { mocked: b.mocked as number } : {}) });
      } else if (b.kind === 'netbody' && b.rid) {
        bodies.set(String(b.rid), { reqBody: b.reqBody as string, resBody: b.resBody as string, reqHeaders: b.reqHeaders as Record<string, string>, resHeaders: b.resHeaders as Record<string, string> });
        if (bodies.size > BODIES_MAX) bodies.delete(bodies.keys().next().value!);
      } else if (b.kind === 'pick-hover' && picking && b.rect) {
        const r = b.rect as Rect; const z = tab?.zoom ?? 1;
        native?.boxes(JSON.stringify({ color: '#4299FF', items: [{ x: r.x * z, y: r.y * z, w: r.w * z, h: r.h * z, label: b.label }] }));
      } else if (b.kind === 'pick' && tab) void finishPick(tab, b);
      else if (b.kind === 'pick-cancel') { picking = false; native?.boxes('{"items":[]}'); publishFlags(); }
      return;
    }
    case 'response':
      addNet(id, { via: e.mainFrame ? 'document' : 'frame', method: 'GET', url: String(e.url), status: e.status as number, type: String(e.mime ?? '') });
      return;
    case 'failed':
      if (Number(e.code) !== -999 && Number(e.code) !== 102) addConsole(id, 'error', `Load failed: ${e.error}${e.url ? ` (${e.url})` : ''}`); // -999 cancelled, 102 became a download
      break;
    case 'dialog': {
      const line = `${e.kind} ${JSON.stringify(e.message)} → ${e.accepted ? 'accepted' : 'dismissed'}${e.kind === 'prompt' && e.text != null ? ` with ${JSON.stringify(e.text)}` : ''}`;
      (dialogsSeen.get(id) ?? dialogsSeen.set(id, []).get(id)!).push(line);
      addConsole(id, 'info', `[dialog] ${line}`);
      return;
    }
    case 'download': {
      const line = `${e.state}: ${e.path}${e.error ? ` (${e.error})` : ''}`;
      if (e.state !== 'started') (downloadsSeen.get(id) ?? downloadsSeen.set(id, []).get(id)!).push(line);
      addConsole(id, e.state === 'failed' ? 'error' : 'info', `[download] ${line}`);
      break;
    }
    case 'upload':
      addConsole(id, 'info', `[upload] ${(e.files as string[]).join(', ')}`);
      break;
    case 'crashed':
      addConsole(id, 'error', 'The page crashed; reload to continue.');
      return;
    case 'popup': {
      // window.open (OAuth and the like): a tab of its own that keeps window.opener and the opener's owner.
      const opener = e.opener as number;
      const parent = tabs.get(opener);
      tabs.set(id, newTabState(id, String(e.url ?? ''), opener, parent?.owner));
      order.splice(order.indexOf(opener) + 1, 0, id);
      if (mocks.length) native?.setScripts(id, pageHooks(mocksFor(id)), RELAY);
      if (parent?.owner) sessionTab.set(parent.owner.key, id);
      activate(id);
      break;
    }
    case 'closed':
      closeTab(id);
      return;
  }
  for (const w of waiters) if (w.tab === id && w.type === e.type) { waiters.delete(w); w.resolve(); }
}

function newTabState(id: number, url: string, opener?: number, owner?: SessionInfo): TabState {
  return { id, url, title: '', loading: true, canGoBack: false, canGoForward: false, progress: 0, zoom: 1, device: null, ...(opener ? { opener } : {}), ...(owner ? { owner } : {}) };
}

function placeActive() {
  if (!native) return;
  const visible = !!frame && !!win && win.isVisible() && !win.isMinimized() && !deps.isLocked();
  for (const id of order) {
    const show = id === active && visible;
    if (show && frame) { native.setFrame(id, frame.x, frame.y, frame.w, frame.h); native.setCorners(id, frame.r ?? 0, frame.corners ?? 0); }
    native.setVisible(id, show);
  }
  if (frame) { native.overlayFrame(frame.x, frame.y, frame.w, frame.h, visible && active !== null); native.overlayCorners(frame.r ?? 0, frame.corners ?? 0); }
  else native.overlayFrame(0, 0, 1, 1, false);
}

function activate(id: number) {
  if (!tabs.has(id)) return;
  const changed = active !== id;
  active = id;
  placeActive();
  publishTabs();
  if (changed) {
    if (picking) setPicking(false);
    // Cursors point into the page that was showing; they come back from where they enter in the new one.
    for (const key of cursorAt.keys()) native?.cursorEffect(JSON.stringify({ key, kind: 'hide' }));
    cursorAt.clear();
    void drawRefs();
  }
}

function closeTab(id: number) {
  if (!tabs.has(id)) return;
  native?.destroy(id);
  tabs.delete(id);
  pendingReq.delete(id); lastSnapshot.delete(id); dialogsSeen.delete(id); downloadsSeen.delete(id);
  if (mocks.some((m) => m.tabs.includes(id))) {
    mocks = mocks.map((m) => ({ ...m, tabs: m.tabs.filter((t) => t !== id) })).filter((m) => m.all || m.tabs.length);
    publishFlags();
  }
  for (const [k, v] of sessionTab) if (v === id) sessionTab.delete(k);
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
    else if (!win.isVisible() || win.isMinimized()) { if (win.isMinimized()) win.restore(); win.showInactive(); }
    return windowReady ?? Promise.resolve();
  }
  win = deps.createWindow();
  const w = win;
  for (const ev of ['show', 'hide', 'minimize', 'restore'] as const) w.on(ev as 'show', placeActive);
  w.on('closed', () => {
    for (const id of order) native?.destroy(id);
    tabs.clear(); order = []; active = null; frame = null; sessionTab.clear(); lastSnapshot.clear();
    if (paused) { paused = false; for (const r of pauseWaiters) r(); pauseWaiters.clear(); }
    picking = false; showRefs = false; mocks = []; // mocks belong to the tabs they were set on
    if (refTimer) { clearInterval(refTimer); refTimer = null; }
    if (win === w) { win = null; windowReady = null; }
  });
  windowReady = new Promise((resolve) => w.webContents.once('did-finish-load', () => {
    if (loadNative()) native!.overlayAttach(w.getNativeWindowHandle());
    resolve();
  }));
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

function openTab(url: string, owner?: SessionInfo): number {
  const nat = loadNative();
  if (!nat || !win) throw new ToolError('UNAVAILABLE', `In-app browser unavailable: ${nativeError || 'no window'}`, 'no');
  const id = nat.create(win.getNativeWindowHandle(), { userAgent: SAFARI_UA, storeId: STORE_ID, pageScript: pageHooks(mocks.filter((m) => m.all).map(pageRule)), isolatedScript: RELAY });
  tabs.set(id, newTabState(id, url, undefined, owner));
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

/** No fetch/XHR in flight for `idle` ms (and the page not loading). */
async function networkIdle(tab: TabState, idle = 500, timeout = 10000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const busy = tab.loading || (pendingReq.get(tab.id)?.size ?? 0) > 0;
    if (busy) quietSince = Date.now();
    else if (Date.now() - quietSince >= idle) return true;
    await sleep(80);
  }
  return false;
}

// ---------- storage: localStorage, sessionStorage, cookies ----------

function pageHost(tab: TabState): string {
  try { return new URL(tab.url).hostname; } catch { return ''; }
}

async function storageOp(tab: TabState, op: StorageOp): Promise<StorageResult> {
  if (!native) throw new ToolError('UNAVAILABLE', 'browser unavailable', 'no');
  if (op.area === 'cookies') {
    const host = pageHost(tab);
    if (!host) throw new ToolError('INVALID_ARGS', 'the page has no host (about:blank?)', 'no');
    const all = () => native!.cookies(tab.id).then((j) => (JSON.parse(j) as CookieItem[]).filter((c) => cookieMatchesHost(c.domain, host)));
    if (op.action === 'set') {
      const c = op.cookie ?? {};
      const name = c.name ?? op.key;
      if (!name) throw new ToolError('INVALID_ARGS', 'cookie name is required', 'no');
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
      if (!name) throw new ToolError('INVALID_ARGS', 'cookie name is required', 'no');
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
    if (action === 'set') { if (key === null) throw new Error('INVALID_ARGS: key is required'); S.setItem(key, value ?? ''); changed = 1; }
    else if (action === 'remove') { if (key === null) throw new Error('INVALID_ARGS: key is required'); changed = S.getItem(key) === null ? 0 : 1; S.removeItem(key); }
    else if (action === 'clear') { changed = S.length; S.clear(); }
    const items = []; for (let i = 0; i < S.length; i++) { const k = S.key(i); items.push([k, S.getItem(k)]); }
    items.sort((a, b) => a[0].localeCompare(b[0]));
    return { origin: location.origin, items, changed };`;
  return await evalIn(tab, body) as StorageResult;
}

// ---------- overlay: refs, picker ----------

async function drawRefs() {
  if (!native) return;
  const tab = active ? tabs.get(active) : null;
  const refs = tab ? lastSnapshot.get(tab.id) : undefined;
  if (!showRefs || !tab || !refs?.length || picking) { if (!picking) native.boxes('{"items":[]}'); return; }
  try {
    const rects = await evalIn(tab, `return __vb.rectsFor(${JSON.stringify(refs.slice(0, 400))});`) as (Rect & { ref: string })[];
    const z = tab.zoom;
    if (showRefs && active === tab.id) native.boxes(JSON.stringify({ color: '#F5A524', items: rects.map((r) => ({ x: r.x * z, y: r.y * z, w: r.w * z, h: r.h * z, label: r.ref })) }));
  } catch { /* page busy or gone */ }
}

function setRefs(on: boolean) {
  showRefs = on;
  if (refTimer) { clearInterval(refTimer); refTimer = null; }
  if (on) refTimer = setInterval(() => void drawRefs(), 700);
  void drawRefs();
  publishFlags();
}

function setPicking(on: boolean) {
  const tab = active ? tabs.get(active) : null;
  picking = on && !!tab;
  if (tab) void evalIn(tab, `__vb.pick(${picking}); return true;`).catch(() => {});
  if (!picking) native?.boxes('{"items":[]}');
  publishFlags();
}

/** The picked element goes to the browser window, which hands it to the main window's composer. */
async function finishPick(tab: TabState, b: Record<string, unknown>) {
  picking = false;
  native?.boxes('{"items":[]}');
  publishFlags();
  let image: string | undefined;
  try {
    const img = nativeImage.createFromBuffer(await native!.snapshot(tab.id));
    image = `data:image/png;base64,${img.crop(cropRect(b.rect as Rect, tab.zoom, img.getSize().width / (frame?.w || 1), 12, img.getSize())).toPNG().toString('base64')}`;
  } catch { /* no image */ }
  const m = b.measure as Record<string, unknown> | undefined;
  const text = [
    `Picked element on ${b.url}`,
    `- locator: \`${b.locator}\``,
    `- selector: \`${b.selector}\``,
    b.role || b.name ? `- role/name: ${b.role || '-'} ${b.name ? JSON.stringify(b.name) : ''}` : '',
    b.text ? `- text: ${JSON.stringify(b.text)}` : '',
    m ? `- box: ${JSON.stringify(m.rect)} padding ${JSON.stringify(m.padding)} margin ${JSON.stringify(m.margin)}; font ${JSON.stringify(m.font)}; color ${m.color} on ${m.background}` : '',
    '```html', String(b.html ?? ''), '```',
  ].filter(Boolean).join('\n');
  send('browser:picked', { text, image, ref: b.ref, tab: tab.id });
}

// ---------- user-facing IPC (the browser window's React UI) ----------

function fromBrowserWindow(e: IpcMainEvent | IpcMainInvokeEvent) { return !!win && !win.isDestroyed() && e.sender === win.webContents; }

function applyDevice(tab: TabState, device: Device | null) {
  const wasMobile = !!tab.device?.mobile;
  tab.device = device;
  if (!!device?.mobile !== wasMobile && native) {
    const tablet = device && Math.min(device.width, device.height) >= 700;
    native.setUserAgent(tab.id, device?.mobile ? (tablet ? TABLET_UA : MOBILE_UA) : '');
    native.nav(tab.id, 'reload');
  }
  publishTabs();
}

export function initBrowser(d: Deps) {
  deps = d;
  ipcMain.handle('browser:info', (e) => {
    if (!fromBrowserWindow(e)) return null;
    loadNative();
    return { available: !!native, error: nativeError, tabs: order.map((id) => tabs.get(id)), active, console: consoleLog.slice(-500), net: netLog.slice(-500), agent: agentLog.slice(-200), flags: flags(), devices: DEVICES };
  });
  ipcMain.on('browser:frame', (e, r: unknown) => {
    if (!fromBrowserWindow(e)) return;
    const ok = r && typeof r === 'object' && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite((r as Record<string, number>)[k]));
    const f = r as Frame;
    frame = ok ? { x: f.x, y: f.y, w: f.w, h: f.h, ...(Number.isFinite(f.r) ? { r: Math.max(0, Math.min(60, f.r!)) } : {}), ...(Number.isInteger(f.corners) ? { corners: f.corners! & 15 } : {}) } : null;
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
  ipcMain.on('browser:device', (e, dev: unknown) => {
    const tab = active ? tabs.get(active) : null;
    if (!fromBrowserWindow(e) || !tab) return;
    if (dev === null) { applyDevice(tab, null); return; }
    const v = dev as Partial<Device>;
    if (!Number.isFinite(v.width) || !Number.isFinite(v.height)) return;
    applyDevice(tab, { width: Math.round(Math.min(4000, Math.max(200, v.width!))), height: Math.round(Math.min(4000, Math.max(200, v.height!))), mobile: v.mobile !== false, ...(v.preset ? { preset: String(v.preset) } : {}) });
  });
  ipcMain.on('browser:pause', (e, on: unknown) => { if (fromBrowserWindow(e)) setPaused(!!on); });
  ipcMain.on('browser:pick', (e, on: unknown) => { if (fromBrowserWindow(e)) setPicking(!!on); });
  ipcMain.on('browser:refs', (e, on: unknown) => { if (fromBrowserWindow(e)) setRefs(!!on); });
  ipcMain.handle('browser:net-detail', (e, s: unknown) => {
    if (!fromBrowserWindow(e)) return null;
    const entry = netLog.find((n) => n.seq === s);
    return entry?.rid ? bodies.get(entry.rid) ?? null : null;
  });
  ipcMain.handle('browser:mock-remove', (e, id: unknown) => { if (fromBrowserWindow(e)) setMocks(typeof id === 'number' ? mocks.filter((m) => m.id !== id) : []); return mocks; });
  ipcMain.handle('browser:export', (e, fmt: unknown) => {
    if (!fromBrowserWindow(e) || (fmt !== 'playwright' && fmt !== 'html')) return null;
    const file = exportTrace(fmt, null);
    shell.showItemInFolder(file.path);
    return file.path;
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
    if (kind === 'console') consoleLog.length = 0; else if (kind === 'net') { netLog.length = 0; bodies.clear(); } else if (kind === 'agent') agentLog.length = 0;
  });
  connectHost();
}

/** Opens the browser window (and a tab for `url`), e.g. from the Run panel. */
export async function openBrowser(url?: string) {
  await ensureWindow();
  if (url) openTab(url);
  else if (!order.length && loadNative()) openTab('about:blank');
}

function setPaused(on: boolean) {
  paused = on;
  if (!on) { for (const r of pauseWaiters) r(); pauseWaiters.clear(); }
  publishFlags();
}

async function waitUnpaused() {
  if (!paused) return;
  const ok = await Promise.race([new Promise<boolean>((r) => pauseWaiters.add(() => r(true))), sleep(10 * 60_000).then(() => false)]);
  if (!ok) throw new ToolError('PAUSED', 'the user paused agent control of the browser', 'safe', 'ask the user to resume, then retry');
}

function setMocks(next: MockEntry[]) {
  mocks = next;
  // Next loads get the rules from the injected script; pages already open get them swapped in right away.
  for (const id of order) {
    const rules = mocksFor(id);
    native?.setScripts(id, pageHooks(rules), RELAY);
    const tab = tabs.get(id);
    if (tab) void evalIn(tab, `if (window.__vbMocks) window.__vbMocks(${JSON.stringify(rules)}); return true;`, false).catch(() => {});
  }
  publishFlags();
}

// ---------- agent tools ----------

const KEYS: Record<string, [number, string]> = {
  enter: [36, '\r'], return: [36, '\r'], tab: [48, '\t'], escape: [53, '\u001b'], esc: [53, '\u001b'], backspace: [51, '\u007f'], delete: [117, ''],
  space: [49, ' '], arrowup: [126, ''], arrowdown: [125, ''], arrowleft: [123, ''], arrowright: [124, ''],
  home: [115, ''], end: [119, ''], pageup: [116, ''], pagedown: [121, ''],
};
const MODS: Record<string, number> = { shift: 1, control: 2, ctrl: 2, alt: 4, option: 4, meta: 8, cmd: 8, command: 8 };
const DOM_KEYS: Record<string, string> = { enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', space: ' ', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };

/**
 * WebKit only takes real keys and hover while its window is the key window. When the user is in another app, keys and
 * hover go in as DOM events instead (Enter in a form field also submits the form), so agents keep working in the background.
 */
const inBackground = () => !win || win.isDestroyed() || !win.isFocused();
async function domKey(tab: TabState, keyName: string, mods: number) {
  const key = DOM_KEYS[keyName.toLowerCase()] ?? keyName;
  await evalIn(tab, `
    const el = document.activeElement || document.body;
    const init = { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, shiftKey: ${!!(mods & 1)}, ctrlKey: ${!!(mods & 2)}, altKey: ${!!(mods & 4)}, metaKey: ${!!(mods & 8)} };
    const go = el.dispatchEvent(new KeyboardEvent('keydown', init));
    if (go && init.key === 'Enter' && el.form && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) el.form.requestSubmit();
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    return true;`);
}

function str(v: unknown, name: string, required = false): string | undefined {
  if (v === undefined || v === null || v === '') { if (required) throw new ToolError('INVALID_ARGS', `${name} is required`, 'no'); return undefined; }
  if (typeof v !== 'string') throw new ToolError('INVALID_ARGS', `${name} must be a string`, 'no');
  return v;
}
const target = (args: Record<string, unknown>, required = true) => str(args.ref, 'ref') ?? str(args.selector, 'selector', required);

/** The tab a call acts on: the given one, else the session's own, else the user's active tab if nobody owns it. */
function tabFor(args: Record<string, unknown>, ctx: Ctx, mutating = true): TabState {
  const me = sessionOf(ctx);
  let t: TabState | undefined;
  if (args.tab !== undefined && args.tab !== null) {
    t = tabs.get(Number(args.tab));
    if (!t) throw new ToolError('NO_TAB', `no tab ${args.tab}`, 'no', 'call browser_tabs');
  } else {
    const mine = sessionTab.get(me.key);
    t = mine !== undefined ? tabs.get(mine) : undefined;
    if (!t) { const a = active ? tabs.get(active) : undefined; if (a && (!a.owner || a.owner.key === me.key)) t = a; }
    if (!t) throw new ToolError('NO_TAB', 'this session has no tab yet', 'no', 'call browser_open first');
  }
  if (mutating && t.owner && t.owner.key !== me.key && !args.force)
    throw new ToolError('OWNED_BY_OTHER', `tab ${t.id} is being driven by ${t.owner.label}`, 'no', 'open your own tab with browser_open, or pass force: true');
  sessionTab.set(me.key, t.id);
  return t;
}

async function evalIn(tab: TabState, body: string, isolated = true): Promise<unknown> {
  if (!native) throw new ToolError('UNAVAILABLE', 'browser unavailable', 'no');
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ToolError('PAGE_TIMEOUT', 'the page did not answer within 20s (busy, or waiting on a dialog?)', 'safe')), 20000); });
  try {
    const json = await Promise.race([native.evaluate(tab.id, isolated ? `${AGENT_HELPERS}\n${body}` : body, isolated), timeout]);
    return JSON.parse(json);
  } catch (err) { throw fromPage(err); } finally { clearTimeout(timer); }
}

const describe = (tab: TabState) => `tab ${tab.id}: ${tab.title || '(untitled)'} — ${tab.url}`;

/** Serialises actions on one tab so two agents never interleave input. */
function lease<T>(tab: TabState, fn: () => Promise<T>): Promise<T> {
  const prev = leases.get(tab.id) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  leases.set(tab.id, run.catch(() => {}));
  return run;
}

/** Waits until the element passes the actionability checks (auto-wait), then returns the point to act on. */
async function actionable(tab: TabState, sel: string, kind: 'click' | 'type' | 'select' | 'hover', timeoutMs: number): Promise<{ point: { x: number; y: number }; rect: Rect }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let r: { ok: boolean; code?: string; detail?: string; terminal?: boolean; point?: { x: number; y: number }; rect?: Rect };
    try { r = await evalIn(tab, `return await __vb.check(__vb.find(${JSON.stringify(sel)}), ${JSON.stringify(kind)});`) as typeof r; }
    catch (err) {
      const te = fromPage(err);
      if (te.code !== 'NOT_FOUND' && te.code !== 'PAGE_TIMEOUT') throw te;
      r = { ok: false, code: te.code, detail: te.message };
    }
    if (r.ok) return { point: r.point!, rect: r.rect! };
    if (r.terminal) throw new ToolError(r.code!, `${sel}: ${r.detail}`, 'no', HINTS[r.code!]);
    if (Date.now() >= deadline) throw new ToolError(r.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'TIMEOUT', `${sel} was not actionable within ${timeoutMs}ms (last check: ${r.code} ${r.detail ?? ''})`, 'safe', HINTS[r.code!]);
    await sleep(120);
  }
}

let cursorSeed = 1;
function sessionOf(ctx: Ctx): SessionInfo { return ctx.session ?? DEFAULT_SESSION; }
/** Moves the session's cursor to a page point (CSS px) and resolves when it arrives (bounded). */
async function cursorTo(tab: TabState, ctx: Ctx, p: { x: number; y: number }) {
  if (!native || tab.id !== active || !frame) return;
  const s = sessionOf(ctx);
  const to = { x: p.x * tab.zoom, y: p.y * tab.zoom };
  const from = cursorAt.get(s.key) ?? { x: Math.min(frame.w - 20, to.x + 70), y: Math.min(frame.h - 20, to.y + 90) };
  const { points, ms } = handPath(from, to, (cursorSeed++ * 2654435761) ^ s.key.length);
  cursorAt.set(s.key, to);
  await Promise.race([native.cursorMove(JSON.stringify({ key: s.key, color: s.color, label: s.label, points, ms })), sleep(ms + 600)]);
}
function clickEffect(tab: TabState, ctx: Ctx, p: { x: number; y: number }, rect?: Rect) {
  if (!native || tab.id !== active) return;
  const s = sessionOf(ctx); const z = tab.zoom;
  native.cursorEffect(JSON.stringify({ key: s.key, color: s.color, kind: 'ripple', x: p.x * z, y: p.y * z }));
  if (rect) native.highlight(JSON.stringify({ x: rect.x * z, y: rect.y * z, w: rect.w * z, h: rect.h * z, color: s.color, ms: 900 }));
}

/** What changed because of an action: the target's state, navigation, new tabs, errors, dialogs, downloads. */
async function observe<T>(tab: TabState, sel: string | undefined, act: () => Promise<T>): Promise<{ value: T; report: string }> {
  const before = { url: tab.url, tabs: new Set(order), c: consoleLog.at(-1)?.seq ?? 0, n: netLog.at(-1)?.seq ?? 0, d: dialogsSeen.get(tab.id)?.length ?? 0, dl: downloadsSeen.get(tab.id)?.length ?? 0 };
  const value = await act();
  await sleep(250);
  if (tab.loading) await waitFor(tab.id, 'loaded', 10000);
  await networkIdle(tab, 300, 2500);
  const lines: string[] = [];
  if (sel && tabs.has(tab.id)) {
    try { const st = await evalIn(tab, `try { return __vb.state(__vb.find(${JSON.stringify(sel)})); } catch { return null; }`); lines.push(st ? `target: ${JSON.stringify(st)}` : 'target: gone from the page'); } catch { /* page navigating */ }
  }
  if (tab.url !== before.url) lines.push(`navigated: ${tab.url}`);
  for (const id of order) if (!before.tabs.has(id)) lines.push(`opened ${describe(tabs.get(id)!)}`);
  for (const e of consoleLog.filter((x) => x.seq > before.c && x.level === 'error' && (x.tab === tab.id || !before.tabs.has(x.tab))).slice(-3)) lines.push(`console error: ${e.text.slice(0, 300)}`);
  for (const e of netLog.filter((x) => x.seq > before.n && x.tab === tab.id && (x.error || (x.status ?? 0) >= 400)).slice(-3)) lines.push(`request failed: ${e.method} ${e.error ? e.error : e.status} ${e.url}`);
  for (const dl of (dialogsSeen.get(tab.id) ?? []).slice(before.d)) lines.push(`dialog: ${dl}`);
  for (const dl of (downloadsSeen.get(tab.id) ?? []).slice(before.dl)) lines.push(`download ${dl}`);
  lines.push(describe(tab));
  return { value, report: lines.join('\n') };
}

/** Step text for the Playwright export, recorded with the agent log entry. */
let pwSteps: string[] = [];
let lastShot: string | undefined;
const locatorOf = async (tab: TabState, sel: string) => { try { return await evalIn(tab, `return __vb.locator(__vb.find(${JSON.stringify(sel)}));`) as string; } catch { return `page.locator(${JSON.stringify(sel)})`; } };

async function shot(tab: TabState, sel?: string): Promise<Buffer> {
  if (!frame || !win?.isVisible() || win.isMinimized()) throw new ToolError('NOT_VISIBLE', 'the browser window is hidden or minimized; it must be on screen for a screenshot', 'safe', 'leave the window open (it may sit behind others)');
  activate(tab.id);
  if (!sel) return native!.snapshot(tab.id);
  const c = await actionable(tab, sel, 'hover', 3000); // scrolls it into view
  const img = nativeImage.createFromBuffer(await native!.snapshot(tab.id));
  return img.crop(cropRect(c.rect, tab.zoom, img.getSize().width / (frame.w || 1), 8, img.getSize())).toPNG();
}
const thumb = (png: Buffer) => `data:image/png;base64,${nativeImage.createFromBuffer(png).resize({ width: 480 }).toPNG().toString('base64')}`;
async function traceShot(tab: TabState) { try { if (frame && win?.isVisible() && tab.id === active) lastShot = thumb(await native!.snapshot(tab.id)); } catch { /* ignore */ } }

type Tool = (args: Record<string, unknown>, ctx: Ctx) => Promise<McpContent[]>;
const text = (t: string): McpContent[] => [{ type: 'text', text: t }];
const press = (tab: TabState, p: { x: number; y: number }, clicks = 1) => {
  const z = tab.zoom;
  native!.mouse(tab.id, 'move', p.x * z, p.y * z, 0);
  for (let i = 1; i <= clicks; i++) { native!.mouse(tab.id, 'down', p.x * z, p.y * z, i); native!.mouse(tab.id, 'up', p.x * z, p.y * z, i); }
};

const tools: Record<string, Tool> = {
  async browser_open(args, ctx) {
    await ensureWindow(args.focus === true);
    const url = str(args.url, 'url') ?? 'about:blank';
    let tab: TabState;
    const mine = sessionTab.get(sessionOf(ctx).key);
    if (args.newTab === false && mine !== undefined && tabs.has(mine)) { tab = tabs.get(mine)!; native!.load(tab.id, normalizeUrl(url)); activate(tab.id); }
    else tab = tabs.get(openTab(url, sessionOf(ctx)))!;
    sessionTab.set(sessionOf(ctx).key, tab.id);
    await waitFor(tab.id, 'loaded', 15000);
    await sleep(150); // the title arrives just after the load event
    pwSteps.push(`await page.goto(${JSON.stringify(tab.url || normalizeUrl(url))});`);
    return text(`Opened ${describe(tab)}\nNext: browser_snapshot (interactive: true for just the controls).`);
  },
  async browser_tabs(_args, ctx) {
    if (!order.length) return text('No tabs are open.');
    const mine = sessionTab.get(sessionOf(ctx).key);
    return text(order.map((id) => { const t = tabs.get(id)!; return `${id === mine ? '*' : ' '} ${describe(t)}${t.owner ? ` [${t.owner.key === sessionOf(ctx).key ? 'yours' : t.owner.label}]` : ' [user]'}${t.loading ? ' (loading)' : ''}${t.device ? ` [${t.device.width}×${t.device.height}${t.device.mobile ? ' mobile' : ''}]` : ''}`; }).join('\n'));
  },
  async browser_select_tab(args, ctx) {
    const tab = tabFor(args, ctx, false); activate(tab.id);
    return text(`Active: ${describe(tab)}`);
  },
  async browser_close_tab(args, ctx) {
    const tab = tabFor(args, ctx); closeTab(tab.id);
    return text(`Closed tab ${tab.id}`);
  },
  async browser_navigate(args, ctx) {
    const tab = tabFor(args, ctx);
    const action = str(args.action, 'action');
    const url = str(args.url, 'url');
    activate(tab.id);
    if (url) { native!.load(tab.id, normalizeUrl(url)); pwSteps.push(`await page.goto(${JSON.stringify(normalizeUrl(url))});`); }
    else if (action === 'back' || action === 'forward' || action === 'reload') { native!.nav(tab.id, action); pwSteps.push(action === 'reload' ? 'await page.reload();' : action === 'back' ? 'await page.goBack();' : 'await page.goForward();'); }
    else throw new ToolError('INVALID_ARGS', 'url or action (back | forward | reload) is required', 'no');
    await sleep(300);
    if (tab.loading) await waitFor(tab.id, 'loaded', 15000);
    return text(describe(tab));
  },
  async browser_snapshot(args, ctx) {
    const tab = tabFor(args, ctx, false);
    const root = str(args.root, 'root') ?? str(args.selector, 'selector');
    const opts = { maxDepth: Number(args.maxDepth) || undefined, interactive: !!args.interactive, compact: !!args.compact, skeleton: !!args.skeleton };
    const r = await evalIn(tab, `const root = ${root ? `__vb.find(${JSON.stringify(root)})` : 'document.body || document.documentElement'}; return __vb.snapshot(root, ${JSON.stringify(opts)});`) as { text: string; rects: { ref: string }[] };
    lastSnapshot.set(tab.id, r.rects.map((x) => x.ref));
    if (tab.id === active) void drawRefs();
    const mode = opts.skeleton ? 'skeleton' : opts.interactive ? 'interactive' : opts.compact ? 'compact' : 'full';
    return text(`${describe(tab)}\n(${mode} snapshot, ${r.rects.length} actionable refs${tab.device ? `, viewport ${tab.device.width}×${tab.device.height}` : ''})\n\n${r.text || '(empty page)'}`);
  },
  async browser_click(args, ctx) {
    const tab = tabFor(args, ctx);
    const sel = target(args)!;
    return lease(tab, async () => {
      activate(tab.id);
      const { point, rect } = await actionable(tab, sel, 'click', Number(args.timeout) || 5000);
      const loc = await locatorOf(tab, sel);
      await cursorTo(tab, ctx, point);
      const { report } = await observe(tab, sel, async () => { clickEffect(tab, ctx, point, rect); press(tab, point, args.double ? 2 : 1); });
      pwSteps.push(`await ${loc}.${args.double ? 'dblclick' : 'click'}();`);
      await traceShot(tab);
      return text(`Clicked ${sel}\n${report}`);
    });
  },
  async browser_hover(args, ctx) {
    const tab = tabFor(args, ctx);
    const sel = target(args)!;
    return lease(tab, async () => {
      activate(tab.id);
      const { point } = await actionable(tab, sel, 'hover', Number(args.timeout) || 5000);
      await cursorTo(tab, ctx, point);
      const bg = inBackground();
      if (bg) await evalIn(tab, `const el = __vb.find(${JSON.stringify(sel)}); const o = { bubbles: true, clientX: ${point.x}, clientY: ${point.y} };
        for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, { ...o, bubbles: !t.endsWith('enter') }) : new MouseEvent(t, { ...o, bubbles: !t.endsWith('enter') }));
        return true;`);
      else native!.mouse(tab.id, 'move', point.x * tab.zoom, point.y * tab.zoom, 0);
      await sleep(250);
      pwSteps.push(`await ${await locatorOf(tab, sel)}.hover();`);
      await traceShot(tab);
      return text(`Hovering ${sel}${bg ? ' (the window is in the background: hover went in as DOM events, so CSS :hover styles do not apply)' : ''}\n${describe(tab)}`);
    });
  },
  async browser_type(args, ctx) {
    const tab = tabFor(args, ctx);
    const sel = target(args)!;
    const value = typeof args.text === 'string' ? args.text : '';
    return lease(tab, async () => {
      activate(tab.id);
      const { point, rect } = await actionable(tab, sel, 'type', (Number(args.timeout) || 5000) + value.length * 30);
      const loc = await locatorOf(tab, sel);
      const isSecret = await evalIn(tab, `return __vb.secret(__vb.find(${JSON.stringify(sel)}));`) as boolean;
      await cursorTo(tab, ctx, point);
      const { report } = await observe(tab, sel, async () => {
        clickEffect(tab, ctx, point, rect);
        press(tab, point);
        await sleep(60);
        await evalIn(tab, `
          const el = __vb.find(${JSON.stringify(sel)});
          el.focus();
          if (${args.clear !== false}) { if (typeof el.select === 'function') el.select(); else document.execCommand('selectAll'); }
          if (!document.execCommand('insertText', false, ${JSON.stringify(value)})) {
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
            if (setter) { setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
            else el.textContent = ${JSON.stringify(value)};
          }
          return true;`);
        // The cursor rests where the caret ends up.
        await cursorTo(tab, ctx, { x: Math.min(rect.x + rect.w - 6, rect.x + 14 + value.length * 7), y: rect.y + rect.h / 2 });
        if (args.submit) { if (inBackground()) await domKey(tab, 'enter', 0); else { native!.focus(tab.id); native!.key(tab.id, 36, '\r', 0); } }
      });
      pwSteps.push(`await ${loc}.fill(${isSecret ? 'process.env.SECRET_VALUE ?? ""' : JSON.stringify(value)});`);
      if (args.submit) pwSteps.push(`await ${loc}.press('Enter');`);
      await traceShot(tab);
      return text(`Typed ${isSecret ? `${value.length} characters (secret field)` : JSON.stringify(value.slice(0, 200))} into ${sel}${args.submit ? ' and pressed Enter' : ''}\n${report}`);
    });
  },
  async browser_press(args, ctx) {
    const tab = tabFor(args, ctx);
    const combo = str(args.key, 'key', true)!;
    const parts = combo.split('+');
    const keyName = parts.pop()!;
    const mods = parts.reduce((m, p) => m | (MODS[p.toLowerCase()] ?? 0), 0);
    const k = KEYS[keyName.toLowerCase()] ?? (keyName.length === 1 ? [0, keyName] as [number, string] : null);
    if (!k) throw new ToolError('INVALID_ARGS', `unknown key ${keyName}`, 'no');
    return lease(tab, async () => {
      activate(tab.id);
      const bg = inBackground();
      const { report } = await observe(tab, undefined, async () => { if (bg) await domKey(tab, keyName, mods); else { native!.focus(tab.id); native!.key(tab.id, k[0], k[1], mods); } });
      pwSteps.push(`await page.keyboard.press(${JSON.stringify(combo.replace(/\b(cmd|command)\b/i, 'Meta'))});`);
      return text(`Pressed ${combo}\n${report}`);
    });
  },
  async browser_select_option(args, ctx) {
    const tab = tabFor(args, ctx);
    const sel = target(args)!;
    const values = Array.isArray(args.values) ? args.values.map(String) : [str(args.value, 'value', true)!];
    return lease(tab, async () => {
      activate(tab.id);
      const { point, rect } = await actionable(tab, sel, 'select', Number(args.timeout) || 5000);
      const loc = await locatorOf(tab, sel);
      await cursorTo(tab, ctx, point);
      const { value, report } = await observe(tab, sel, async () => {
        clickEffect(tab, ctx, point, rect);
        return await evalIn(tab, `
          const el = __vb.find(${JSON.stringify(sel)});
          const want = ${JSON.stringify(values)};
          for (const o of el.options) o.selected = want.includes(o.value) || want.includes(o.label.trim());
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
          return [...el.selectedOptions].map((o) => o.label.trim());`) as string[];
      });
      pwSteps.push(`await ${loc}.selectOption(${JSON.stringify(values.length === 1 ? values[0] : values)});`);
      return text(`Selected ${JSON.stringify(value)} in ${sel}\n${report}`);
    });
  },
  async browser_scroll(args, ctx) {
    const tab = tabFor(args, ctx);
    const sel = target(args, false);
    const to = str(args.to, 'to');
    const dy = Number(args.y ?? args.amount ?? (to ? 0 : 600)) * (args.direction === 'up' ? -1 : 1);
    const dx = Number(args.x ?? 0) * (args.direction === 'left' ? -1 : 1);
    return lease(tab, async () => {
      activate(tab.id);
      // The cursor goes over what scrolls first, so the user sees the agent scrolling instead of a still cursor.
      const over = await evalIn(tab, `
        const el = ${sel ? `__vb.find(${JSON.stringify(sel)})` : 'null'};
        const box = el && el.scrollHeight > el.clientHeight + 1 ? el.getBoundingClientRect() : null;
        const l = Math.max(0, box ? box.left : 0), r = Math.min(innerWidth, box ? box.right : innerWidth);
        const t = Math.max(0, box ? box.top : 0), b = Math.min(innerHeight, box ? box.bottom : innerHeight);
        return { x: Math.round((l + r) / 2), y: Math.round((t + b) / 2) };`).catch(() => null) as { x: number; y: number } | null;
      if (over) await cursorTo(tab, ctx, over);
      const r = await evalIn(tab, `
        const el = ${sel ? `__vb.find(${JSON.stringify(sel)})` : 'null'};
        const box = el && el.scrollHeight > el.clientHeight + 1 ? el : document.scrollingElement || document.documentElement;
        const to = ${JSON.stringify(to ?? null)};
        if (el && box !== el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
        else if (to === 'top') box.scrollTo({ top: 0, behavior: 'instant' });
        else if (to === 'bottom') box.scrollTo({ top: box.scrollHeight, behavior: 'instant' });
        else box.scrollBy({ left: ${dx}, top: ${dy}, behavior: 'instant' });
        await new Promise((r) => setTimeout(r, 120));
        return { x: Math.round(box.scrollLeft), y: Math.round(box.scrollTop), max: Math.round(box.scrollHeight - box.clientHeight) };`) as { x: number; y: number; max: number };
      await networkIdle(tab, 300, 2000);
      pwSteps.push(sel ? `await ${await locatorOf(tab, sel)}.scrollIntoViewIfNeeded();` : `await page.mouse.wheel(${dx}, ${dy});`);
      void drawRefs();
      return text(`Scrolled to y=${r.y} of ${r.max}${r.x ? `, x=${r.x}` : ''}\n${describe(tab)}`);
    });
  },
  async browser_drag(args, ctx) {
    const tab = tabFor(args, ctx);
    const from = str(args.from, 'from', true)!;
    const toSel = str(args.to, 'to');
    return lease(tab, async () => {
      activate(tab.id);
      const a = await actionable(tab, from, 'hover', Number(args.timeout) || 5000);
      const b = toSel ? (await actionable(tab, toSel, 'hover', Number(args.timeout) || 5000)).point : { x: a.point.x + Number(args.dx ?? 0), y: a.point.y + Number(args.dy ?? 0) };
      await cursorTo(tab, ctx, a.point);
      const z = tab.zoom, steps = 14, s = sessionOf(ctx);
      // WebKit starts HTML5 drag-and-drop only from a real OS drag session, so draggable sources get its DOM events.
      const html5 = await evalIn(tab, `const el = __vb.find(${JSON.stringify(from)}); return !!(el.closest('[draggable="true"]') || (el.tagName === 'IMG' && el.draggable) || (el.tagName === 'A' && el.draggable));`) as boolean;
      const { report } = await observe(tab, undefined, async () => {
        if (html5) {
          const dropped = await evalIn(tab, `
            const src = __vb.find(${JSON.stringify(from)}).closest('[draggable="true"]') || __vb.find(${JSON.stringify(from)});
            const dst = ${toSel ? `__vb.find(${JSON.stringify(toSel)})` : `document.elementFromPoint(${b.x}, ${b.y})`} || document.body;
            const dt = new DataTransfer();
            const fire = (el, type, x, y) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y }));
            fire(src, 'dragstart', ${a.point.x}, ${a.point.y});
            fire(src, 'drag', ${a.point.x}, ${a.point.y});
            fire(dst, 'dragenter', ${b.x}, ${b.y});
            const accepted = !fire(dst, 'dragover', ${b.x}, ${b.y});
            if (accepted) fire(dst, 'drop', ${b.x}, ${b.y}); else fire(dst, 'dragleave', ${b.x}, ${b.y});
            fire(src, 'dragend', ${b.x}, ${b.y});
            return accepted;`) as boolean;
          if (tab.id === active) await native!.cursorMove(JSON.stringify({ key: s.key, color: s.color, label: s.label, points: handPath({ x: a.point.x * z, y: a.point.y * z }, { x: b.x * z, y: b.y * z }, 7).points, ms: 300 })).catch(() => {});
          cursorAt.set(s.key, { x: b.x * z, y: b.y * z });
          if (!dropped) throw new ToolError('NOT_ACCEPTED', 'the drop target did not accept the drop (no dragover handler called preventDefault)', 'unsafe', 'check the target; dragstart/dragend already ran');
          return;
        }
        native!.mouse(tab.id, 'move', a.point.x * z, a.point.y * z, 0);
        native!.mouse(tab.id, 'down', a.point.x * z, a.point.y * z, 1);
        for (let i = 1; i <= steps; i++) {
          const x = a.point.x + (b.x - a.point.x) * (i / steps), y = a.point.y + (b.y - a.point.y) * (i / steps);
          native!.mouse(tab.id, 'drag', x * z, y * z, 0);
          if (tab.id === active) void native!.cursorMove(JSON.stringify({ key: s.key, color: s.color, label: s.label, points: [[x * z, y * z]], ms: 0 }));
          await sleep(16);
        }
        native!.mouse(tab.id, 'up', b.x * z, b.y * z, 1);
        cursorAt.set(s.key, { x: b.x * z, y: b.y * z });
      });
      pwSteps.push(toSel ? `await ${await locatorOf(tab, from)}.dragTo(${await locatorOf(tab, toSel)});` : `// drag ${from} by (${args.dx ?? 0}, ${args.dy ?? 0})`);
      await traceShot(tab);
      return text(`Dragged ${from} to ${toSel ?? `(${Math.round(b.x)}, ${Math.round(b.y)})`} (${html5 ? 'HTML5 drag-and-drop events' : 'mouse drag'})\n${report}`);
    });
  },
  async browser_upload(args, ctx) {
    const tab = tabFor(args, ctx);
    const sel = target(args)!;
    const files = (Array.isArray(args.files) ? args.files : [args.files]).map(String).filter((f) => f && f !== 'undefined');
    if (!files.length) throw new ToolError('INVALID_ARGS', 'files (absolute paths) are required', 'no');
    for (const f of files) if (!path.isAbsolute(f) || !fs.existsSync(f)) throw new ToolError('INVALID_ARGS', `no such file: ${f}`, 'no');
    return lease(tab, async () => {
      activate(tab.id);
      native!.setUploadFiles(tab.id, JSON.stringify(files));
      const isInput = await evalIn(tab, `const el = __vb.find(${JSON.stringify(sel)}); return el.tagName === 'INPUT' && el.type === 'file';`) as boolean;
      const got = waitFor(tab.id, 'upload', 4000);
      let how = 'clicked';
      try {
        const { point, rect } = await actionable(tab, sel, 'click', 2500);
        await cursorTo(tab, ctx, point);
        clickEffect(tab, ctx, point, rect);
        press(tab, point);
      } catch (err) {
        if (!isInput) throw err;
        how = 'opened the hidden input of';
        await evalIn(tab, `__vb.find(${JSON.stringify(sel)}).click(); return true;`);
      }
      if (!(await got)) throw new ToolError('NO_FILE_CHOOSER', 'no file chooser opened', 'safe', 'run browser_upload on the visible upload button; the files stay queued');
      await networkIdle(tab, 300, 3000);
      pwSteps.push(`await ${await locatorOf(tab, sel)}.setInputFiles(${JSON.stringify(files)});`);
      return text(`Uploaded ${files.map((f) => path.basename(f)).join(', ')} (${how} ${sel})\n${describe(tab)}`);
    });
  },
  async browser_dialog(args, ctx) {
    const tab = tabFor(args, ctx);
    const accept = args.accept !== false;
    native!.setDialogPolicy(tab.id, accept, typeof args.text === 'string' ? args.text : null, args.once !== false);
    const seen = (dialogsSeen.get(tab.id) ?? []).slice(-3);
    return text(`The ${args.once !== false ? 'next' : 'following'} confirm/prompt dialogs will be ${accept ? 'accepted' : 'dismissed'}${typeof args.text === 'string' ? ` with ${JSON.stringify(args.text)}` : ''}. Alerts are always closed.${seen.length ? `\nRecent dialogs:\n${seen.join('\n')}` : ''}`);
  },
  async browser_viewport(args, ctx) {
    const tab = tabFor(args, ctx);
    if (args.off) applyDevice(tab, null);
    else {
      const preset = str(args.preset, 'preset');
      const d = preset ? DEVICES.find((x) => x.id === preset || x.label.toLowerCase() === preset.toLowerCase()) : undefined;
      if (preset && !d) throw new ToolError('INVALID_ARGS', `unknown preset ${preset}; one of ${DEVICES.map((x) => x.id).join(', ')}`, 'no');
      let w = Number(args.width) || d?.width || tab.device?.width || 390, h = Number(args.height) || d?.height || tab.device?.height || 844;
      if (args.landscape) [w, h] = [Math.max(w, h), Math.min(w, h)];
      applyDevice(tab, { width: w, height: h, mobile: args.mobile !== false, ...(d ? { preset: d.id } : {}) });
    }
    activate(tab.id);
    await sleep(500);
    if (tab.loading) await waitFor(tab.id, 'loaded', 10000);
    const v = await evalIn(tab, 'return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };', false) as { width: number; height: number; dpr: number };
    const clipped = tab.device && (v.width < tab.device.width - 2 || v.height < tab.device.height - 2);
    if (tab.device) pwSteps.push(`await page.setViewportSize({ width: ${tab.device.width}, height: ${tab.device.height} });`);
    return text(`${tab.device ? `Viewport ${tab.device.width}×${tab.device.height}${tab.device.mobile ? ' (mobile user agent)' : ''}` : 'Desktop viewport'}; the page sees ${v.width}×${v.height}${clipped ? ' (clipped: the window is smaller than the device; ask the user to enlarge it)' : ''}\n${describe(tab)}`);
  },
  async browser_measure(args, ctx) {
    const tab = tabFor(args, ctx, false);
    const sel = target(args)!;
    const other = str(args.other, 'other');
    const m = await evalIn(tab, `return __vb.measure(__vb.find(${JSON.stringify(sel)})${other ? `, __vb.find(${JSON.stringify(other)})` : ''});`);
    return text(`${JSON.stringify(m, null, 2)}\n(padding/margin/border are [top, right, bottom, left] in CSS px; rect.y is from the top of the document)`);
  },
  async browser_screenshot(args, ctx) {
    const tab = tabFor(args, ctx, false);
    const png = await shot(tab, target(args, false));
    lastShot = thumb(png);
    return [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: describe(tab) }];
  },
  async browser_compare(args, ctx) {
    const tab = tabFor(args, ctx, false);
    const name = (str(args.name, 'name', true)!).replace(/[^\w.-]+/g, '_').slice(0, 80);
    const png = await shot(tab, target(args, false));
    const dir = path.join(DATA_DIR, 'baselines');
    const file = path.join(dir, `${name}.png`);
    fs.mkdirSync(dir, { recursive: true });
    pwSteps.push(`await expect(page).toHaveScreenshot(${JSON.stringify(`${name}.png`)});`);
    if (args.update || !fs.existsSync(file)) {
      fs.writeFileSync(file, png);
      return text(`Saved baseline "${name}" (${file}). Compare against it later with the same name.`);
    }
    const a = nativeImage.createFromBuffer(fs.readFileSync(file)), b = nativeImage.createFromBuffer(png);
    const sa = a.getSize(), sb = b.getSize();
    if (sa.width !== sb.width || sa.height !== sb.height) return text(`Size changed: baseline ${sa.width}×${sa.height}, now ${sb.width}×${sb.height}. Pass update: true to replace the baseline.`);
    const { changed, total, diff } = diffBitmaps(a.toBitmap(), b.toBitmap());
    const pct = Math.round((changed / total) * 10000) / 100;
    const diffImg = nativeImage.createFromBitmap(Buffer.from(diff), { width: sb.width, height: sb.height }).toPNG();
    lastShot = thumb(diffImg);
    return [{ type: 'text', text: `"${name}": ${pct}% of pixels differ (${changed} of ${total}).${changed ? ' Red marks the changes:' : ' Identical.'}` }, ...(changed ? [{ type: 'image' as const, data: diffImg.toString('base64'), mimeType: 'image/png' }] : [])];
  },
  async browser_eval(args, ctx) {
    const tab = tabFor(args, ctx);
    const code = str(args.expression, 'expression', true)!;
    const body = /\breturn\b/.test(code) ? code : `return (${code});`;
    const value = await evalIn(tab, body, false);
    return text(JSON.stringify(value, null, 2)?.slice(0, 50000) ?? 'undefined');
  },
  async browser_console(args, ctx) {
    const tab = args.tab !== undefined || sessionTab.has(sessionOf(ctx).key) ? tabFor(args, ctx, false).id : null;
    const level = str(args.level, 'level');
    const since = Number(args.since) || 0;
    const rows = consoleLog.filter((e) => (tab === null || e.tab === tab) && e.seq > since && (!level || level === 'all' || (level === 'error' ? e.level === 'error' : ['error', 'warn'].includes(e.level))));
    const shown = rows.slice(-(Number(args.limit) || 100));
    return text(`${shown.length} of ${rows.length} messages (pass since=${consoleLog.at(-1)?.seq ?? 0} for only newer ones)\n` + shown.map((e) => `[${e.level}] ${e.text}${e.source ? ` @ ${e.source}` : ''}`).join('\n'));
  },
  async browser_network(args, ctx) {
    const tab = args.tab !== undefined || sessionTab.has(sessionOf(ctx).key) ? tabFor(args, ctx, false).id : null;
    const filter = str(args.filter, 'filter');
    const since = Number(args.since) || 0;
    const rows = netLog.filter((e) => (tab === null || e.tab === tab) && e.seq > since && (!args.failedOnly || e.error || (e.status ?? 0) >= 400) && (!args.apiOnly || e.via === 'fetch' || e.via === 'xhr') && (!filter || e.url.includes(filter)));
    const shown = rows.slice(-(Number(args.limit) || 100));
    return text(`${shown.length} of ${rows.length} requests (pass since=${netLog.at(-1)?.seq ?? 0} for only newer ones; browser_network_detail with an id shows headers and bodies)\n` + shown.map((e) => `#${e.seq} ${e.method} ${e.error ? `ERR ${e.error}` : e.status ?? '-'} ${e.via}${e.mocked ? ' MOCKED' : ''} ${e.url}${e.ms !== undefined ? ` ${e.ms}ms` : ''}`).join('\n'));
  },
  async browser_network_detail(args) {
    const id = Number(args.id);
    const e = netLog.find((n) => n.seq === id);
    if (!e) throw new ToolError('NOT_FOUND', `no request #${args.id}`, 'no', 'use an id from browser_network');
    const b = e.rid ? bodies.get(e.rid) : undefined;
    const block = (label: string, v: unknown) => (v === undefined || v === null || v === '' ? '' : `\n${label}:\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`);
    return text(`#${e.seq} ${e.method} ${e.url}\nstatus: ${e.error ?? e.status ?? '-'}  type: ${e.type ?? '-'}  via: ${e.via}${e.ms !== undefined ? `  ${e.ms}ms` : ''}${e.mocked ? '  (mocked)' : ''}` +
      (b ? block('request headers', b.reqHeaders && Object.keys(b.reqHeaders).length ? b.reqHeaders : '') + block('request body', b.reqBody) + block('response headers', b.resHeaders) + block('response body', b.resBody) : '\n(bodies are recorded for fetch/XHR only)'));
  },
  async browser_mock(args, ctx) {
    const action = str(args.action, 'action') ?? 'add';
    if (action === 'list') return text(mocks.length ? mocks.map((m) => `#${m.id} ${m.method ?? '*'} ${m.regex ? `/${m.url}/` : m.url} → ${m.status} ${m.contentType ?? 'application/json'} (${m.body.length} chars) on ${m.all ? 'every tab' : `tab ${m.tabs.join(', ')}`}${m.by ? ` [${m.by}]` : ''}`).join('\n') : 'No mocks.');
    if (action === 'clear') { setMocks([]); return text('Removed every mock.'); }
    if (action === 'remove') { const id = Number(args.id); setMocks(mocks.filter((m) => m.id !== id)); return text(`Removed mock #${id}.`); }
    const url = str(args.url, 'url', true)!;
    if (args.regex) { try { new RegExp(url); } catch (e) { throw new ToolError('INVALID_ARGS', `bad regular expression: ${(e as Error).message}`, 'no'); } }
    // A mock applies to the tab it is set on (and its popups) unless allTabs: the user's other tabs stay untouched.
    const scopeTab = args.allTabs ? undefined : tabFor(args, ctx, false);
    const rule: MockEntry = { tabs: scopeTab ? [scopeTab.id] : [], ...(args.allTabs ? { all: true } : {}), by: sessionOf(ctx).label, id: ++mockSeq, url, ...(args.regex ? { regex: true } : {}), status: Number(args.status) || 200, body: typeof args.body === 'string' ? args.body : JSON.stringify(args.body ?? {}),
      ...(typeof args.method === 'string' ? { method: args.method.toUpperCase() } : {}), ...(typeof args.contentType === 'string' ? { contentType: args.contentType } : {}),
      ...(args.headers && typeof args.headers === 'object' ? { headers: args.headers as Record<string, string> } : {}) };
    setMocks([...mocks, rule]);
    if (args.reload === true && scopeTab) { native!.nav(scopeTab.id, 'reload'); await sleep(300); if (scopeTab.loading) await waitFor(scopeTab.id, 'loaded', 15000); }
    pwSteps.push(`await page.route(${rule.regex ? `new RegExp(${JSON.stringify(url)})` : JSON.stringify(`**${url}**`)}, (route) => route.fulfill({ status: ${rule.status}, contentType: ${JSON.stringify(rule.contentType ?? 'application/json')}, body: ${JSON.stringify(rule.body)} }));`);
    return text(`Mock #${rule.id}: ${rule.method ?? 'any method'} ${url} → ${rule.status} on ${rule.all ? 'every tab' : `tab ${scopeTab!.id} (and its popups)`}. From now on fetch and XHR requests matching it get this response${args.reload === true ? ' (the page was reloaded)' : ''}; images, scripts and styles are not mocked. Never block login or token endpoints, or sign-in loops back to the login page.`);
  },
  async browser_storage(args, ctx) {
    const action = (str(args.action, 'action') ?? 'get') as StorageOp['action'];
    const tab = tabFor(args, ctx, action !== 'get');
    const area = (str(args.area, 'area', true)) as StorageArea;
    if (!['get', 'set', 'remove', 'clear'].includes(action)) throw new ToolError('INVALID_ARGS', 'action must be get, set, remove or clear', 'no');
    if (!['local', 'session', 'cookies'].includes(area)) throw new ToolError('INVALID_ARGS', 'area must be local, session or cookies', 'no');
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
    return text([head, ...lines].join('\n'));
  },
  async browser_wait(args, ctx) {
    const tab = tabFor(args, ctx, false);
    const t = str(args.text, 'text');
    const selector = str(args.selector, 'selector');
    const gone = !!args.gone;
    const timeout = Math.min(60000, Number(args.timeout) || 10000);
    if (args.networkIdle) {
      if (!(await networkIdle(tab, Number(args.idle) || 500, timeout))) throw new ToolError('TIMEOUT', `requests still running after ${timeout}ms`, 'safe');
      pwSteps.push("await page.waitForLoadState('networkidle');");
      return text(`Network idle\n${describe(tab)}`);
    }
    if (!t && !selector) { await sleep(Math.min(30000, Number(args.ms) || 1000)); return text('Waited.'); }
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = await evalIn(tab, selector ? `return !!document.querySelector(${JSON.stringify(selector)});` : `return (document.body?.innerText || '').includes(${JSON.stringify(t)});`).catch(() => false);
      if (found !== gone) {
        pwSteps.push(selector ? `await expect(page.locator(${JSON.stringify(selector)})).${gone ? 'toBeHidden' : 'toBeVisible'}();` : `await expect(page.getByText(${JSON.stringify(t)}).first()).${gone ? 'toBeHidden' : 'toBeVisible'}();`);
        return text(`${selector ?? JSON.stringify(t)} ${gone ? 'is gone' : 'appeared'}\n${describe(tab)}`);
      }
      await sleep(250);
    }
    throw new ToolError('TIMEOUT', `timed out waiting for ${selector ?? JSON.stringify(t)}${gone ? ' to disappear' : ''}`, 'safe');
  },
  async browser_perf(args, ctx) {
    const tab = tabFor(args, ctx, false);
    const m = await evalIn(tab, `
      const nav = performance.getEntriesByType('navigation')[0];
      const paint = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
      const observe = (type) => new Promise((res) => { const out = []; try { const o = new PerformanceObserver((l) => out.push(...l.getEntries())); o.observe({ type, buffered: true }); setTimeout(() => { o.disconnect(); res(out); }, 150); } catch { res(null); } });
      const lcp = await observe('largest-contentful-paint');
      const shifts = await observe('layout-shift');
      const res = performance.getEntriesByType('resource');
      return {
        url: location.href,
        ttfb: nav ? Math.round(nav.responseStart - nav.startTime) : null,
        domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
        load: nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
        firstContentfulPaint: paint['first-contentful-paint'] ?? null,
        largestContentfulPaint: lcp && lcp.length ? Math.round(lcp[lcp.length - 1].startTime) : (lcp === null ? 'unsupported' : null),
        cumulativeLayoutShift: shifts === null ? 'unsupported' : Math.round(shifts.filter((s) => !s.hadRecentInput).reduce((a, s) => a + s.value, 0) * 1000) / 1000,
        resources: res.length, transferKB: Math.round(res.reduce((a, r) => a + (r.transferSize || 0), 0) / 1024),
        domNodes: document.getElementsByTagName('*').length,
      };`, false);
    return text(`${JSON.stringify(m, null, 2)}\n(milliseconds from navigation start; WebKit engine)`);
  },
  async browser_a11y(args, ctx) {
    const tab = tabFor(args, ctx, false);
    const loaded = await evalIn(tab, 'return typeof window.axe === "object";', false);
    if (!loaded) await evalIn(tab, `${fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')}\nreturn true;`, false);
    const root = target(args, false);
    const r = await evalIn(tab, `const res = await axe.run(${root ? JSON.stringify(root) : 'document'}, { resultTypes: ['violations'] });
      return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, count: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));`, false) as { id: string; impact: string; help: string; count: number; targets: string[] }[];
    if (!r.length) return text('No accessibility violations found (axe-core).');
    const rank = ['critical', 'serious', 'moderate', 'minor'];
    r.sort((a, b) => rank.indexOf(a.impact) - rank.indexOf(b.impact));
    return text(`${r.length} accessibility rules violated (axe-core):\n` + r.map((v) => `- [${v.impact}] ${v.id}: ${v.help} (${v.count} element${v.count === 1 ? '' : 's'}) e.g. ${v.targets.join(' | ')}`).join('\n'));
  },
  async browser_export(args, ctx) {
    const fmt = str(args.format, 'format') ?? 'playwright';
    if (fmt !== 'playwright' && fmt !== 'html') throw new ToolError('INVALID_ARGS', 'format must be playwright or html', 'no');
    const file = exportTrace(fmt, args.all ? null : ctx.session?.key ?? null);
    return text(`Saved ${file.path}${fmt === 'playwright' ? `\n\n${file.content}` : ''}`);
  },
};

/** Batch: several tool calls in one round trip. */
tools.browser_batch = async (args, ctx) => {
  const steps = Array.isArray(args.steps) ? args.steps as { tool: string; args?: Record<string, unknown> }[] : [];
  if (!steps.length) throw new ToolError('INVALID_ARGS', 'steps is required', 'no');
  const images: McpContent[] = [];
  const lines: string[] = [];
  for (const [i, s] of steps.entries()) {
    const name = s.tool?.startsWith('browser_') ? s.tool : `browser_${s.tool}`;
    if (name === 'browser_batch' || !tools[name]) { lines.push(`${i + 1}. ${s.tool} ✗ INVALID_ARGS: unknown tool`); if (args.stopOnError !== false) break; continue; }
    try {
      await waitUnpaused();
      const r = await runStep(name, s.args ?? {}, ctx);
      lines.push(`${i + 1}. ${name} ✓ ${r.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join(' ').replace(/\s+/g, ' ').slice(0, 500)}`);
      images.push(...r.filter((c) => c.type === 'image'));
    } catch (err) {
      const te = fromPage(err);
      lines.push(`${i + 1}. ${name} ✗ ${te.code}: ${te.message}`);
      if (args.stopOnError !== false) { lines.push(`stopped; ${steps.length - i - 1} step(s) not run`); break; }
    }
  }
  return [{ type: 'text', text: lines.join('\n') }, ...images];
};

async function runStep(name: string, args: Record<string, unknown>, ctx: Ctx) {
  const t0 = Date.now();
  lastShot = undefined; pwSteps = [];
  const summary = JSON.stringify(name === 'browser_type' ? { ...args, text: typeof args.text === 'string' ? `(${args.text.length} chars)` : args.text } : args).slice(0, 300);
  try {
    const out = await tools[name](args, ctx);
    const t = out.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
    const tab = tabs.get(sessionTab.get(sessionOf(ctx).key) ?? -1);
    log({ tool: name, summary, ok: true, ms: Date.now() - t0, result: t.slice(0, 2000), ...(ctx.session ? { session: ctx.session } : {}), ...(lastShot ? { image: lastShot } : {}), ...(pwSteps.length ? { pw: pwSteps } : {}), ...(tab ? { url: tab.url } : {}) });
    return out;
  } catch (err) {
    const te = fromPage(err);
    log({ tool: name, summary, ok: false, ms: Date.now() - t0, result: `${te.code}: ${te.message}`, ...(ctx.session ? { session: ctx.session } : {}) });
    throw te;
  }
}
function log(e: Omit<AgentEntry, 'seq' | 't'>) {
  const entry: AgentEntry = { seq: ++seq, t: Date.now(), ...e };
  pushRing(agentLog, entry); send('browser:agent', entry);
}

export async function runTool(name: string, args: Record<string, unknown>, ctx: Ctx = {}): Promise<McpContent[]> {
  if (!tools[name]) throw new ToolError('INVALID_ARGS', `unknown tool ${name}`, 'no');
  if (deps.isLocked()) throw new ToolError('LOCKED', 'Vibrato is locked', 'safe', 'wait for the user to unlock');
  if (!loadNative()) throw new ToolError('UNAVAILABLE', `In-app browser unavailable: ${nativeError}`, 'no');
  if (name !== 'browser_open' && !win) await ensureWindow(false);
  await waitUnpaused();
  return runStep(name, args, ctx);
}

/** Formats a failure for the agent: code, message, whether a retry is safe, and the next step. */
export function formatError(err: unknown): string {
  const te = fromPage(err);
  const hint = te.hint ?? HINTS[te.code];
  return `${te.code}: ${te.message}\nretry: ${te.retry === 'safe' ? 'safe (nothing was sent to the page)' : te.retry === 'unsafe' ? 'unsafe (the input may have landed; check the page first)' : 'no (change the call)'}${hint ? `\nnext: ${hint}` : ''}`;
}

/** Writes the agent log as a Playwright test or a standalone HTML report; `sessionKey` null = everything. */
function exportTrace(fmt: 'playwright' | 'html', sessionKey: string | null): { path: string; content: string } {
  const rows = agentLog.filter((e) => !sessionKey || e.session?.key === sessionKey);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(os.homedir(), 'Downloads');
  let content: string, file: string;
  if (fmt === 'playwright') {
    const steps = rows.filter((e) => e.ok && e.pw).flatMap((e) => e.pw!);
    content = playwrightScript(`recorded in Vibrato ${stamp}`, steps.length ? steps : ['// no recorded actions']);
    file = path.join(dir, `vibrato-${stamp}.spec.ts`);
  } else {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    content = `<!doctype html><meta charset="utf-8"><title>Vibrato browser trace ${stamp}</title><style>body{font:13px -apple-system,system-ui;background:#0f1115;color:#dde;margin:0;padding:24px}h1{font-size:16px}.s{border:1px solid #2a2e38;border-radius:12px;padding:12px 14px;margin:10px 0;background:#161922}.h{display:flex;gap:10px;align-items:center}.d{width:9px;height:9px;border-radius:50%}code,pre{font:11.5px ui-monospace,Menlo}pre{white-space:pre-wrap;color:#aab;margin:6px 0 0}.bad pre{color:#f99}img{max-width:480px;border-radius:8px;margin-top:8px;border:1px solid #2a2e38}.m{color:#778;font-size:11px}</style><h1>Vibrato browser trace — ${stamp}</h1>` +
      rows.map((e) => `<div class="s${e.ok ? '' : ' bad'}"><div class="h"><span class="d" style="background:${e.session?.color ?? '#4299FF'}"></span><b>${esc(e.tool.replace(/^browser_/, ''))}</b><span class="m">${esc(e.session?.label ?? 'Agent')} · ${new Date(e.t).toLocaleTimeString()} · ${e.ms}ms${e.url ? ` · ${esc(e.url)}` : ''}</span></div><code>${esc(e.summary)}</code>${e.result ? `<pre>${esc(e.result)}</pre>` : ''}${e.image ? `<img src="${e.image}">` : ''}</div>`).join('');
    file = path.join(dir, `vibrato-trace-${stamp}.html`);
  }
  fs.writeFileSync(file, content);
  return { path: file, content };
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
    let msg: { id: number; tool: string; args?: Record<string, unknown>; session?: SessionInfo };
    try { msg = JSON.parse(String(data)); } catch { return; }
    let reply: unknown;
    try { reply = { id: msg.id, ok: true, content: await runTool(msg.tool, msg.args ?? {}, msg.session ? { session: msg.session } : {}) }; }
    catch (err) { reply = { id: msg.id, ok: false, error: formatError(err) }; }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  });
  ws.on('close', retry);
  ws.on('error', () => { /* 'close' follows and retries */ });
}
