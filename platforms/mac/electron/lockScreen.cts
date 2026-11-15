import { app, BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker, screen, type Display } from 'electron';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/*
 * Lock screen: a cover window on every display while agent sessions keep running underneath.
 * It is not a macOS login lock. Kiosk presentation options block Cmd+Tab, force quit, the Apple menu and
 * hiding the app; the cover sits at screen-saver level on every Space; the app's own windows are hidden.
 * Spotlight, Mission Control gestures, hot corners and a hard power-off are not blocked.
 * While locked on AC power the display is kept awake so macOS does not sleep-lock the screen.
 * Ctrl+Cmd+Q (macOS Lock Screen) still works: the system handles it, or, when kiosk mode disables the
 * Apple menu shortcut, the cover window catches it and asks loginwindow to lock.
 *
 * Failsafes, so a bug never leaves the user locked out:
 *  - Cover watchdog: the main cover's page pings every 10s. A cover that stops pinging, hangs or crashes is
 *    rebuilt; after MAX_REBUILDS rebuilds in a row without a ping the lock gives up and opens.
 *  - Server watchdog: while locked this process beats the local server every 10s. If the beats stop (this
 *    process hung, kiosk mode also disables force quit) the server kills the app and reopens it unlocked.
 *    Agent sessions live in the server, so they keep running.
 *  - Recovery code: shown once when the password is first set; typed into the cover instead of the
 *    password it unlocks once and is then used up.
 *  - The cover takes a 4-digit PIN in four boxes. A password set before PINs (any length, stored only as a
 *    hash) might not fit them, so locking is refused until a PIN is set (`pin` flag).
 *  - A cover page that cannot load at all opens the lock (did-fail-load below).
 */

export interface LockSettings { mainDisplay: string | null }
interface Stored extends LockSettings { salt?: string; hash?: string; pin?: boolean; recoverySalt?: string; recoveryHash?: string; relaunchLockedAt?: number }
export interface LockSessionSummary { agent: string; total: number; running: number; waiting: number }

const DEFAULTS: LockSettings = { mainDisplay: null };
const PIN = /^\d{4}$/;
/** Shown until the cover page has painted the wallpaper. */
const COVER_BG = '#0b0d11';
/** A correct PIN shows its green boxes this long before the covers close. */
const UNLOCK_SHOW_MS = 450;
/** A relaunch (self-update) within this window comes back locked. Older flags are ignored so a reboot never traps the user. */
const RELAUNCH_GRACE_MS = 2 * 60 * 1000;
const HEX = /^[0-9a-f]{16,128}$/;
/** 32 letters and digits without 0/O/1/I; 20 of them = 100 bits, shown as XXXXX-XXXXX-XXXXX-XXXXX. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ALIVE_TIMEOUT_MS = 35000;
const MAX_REBUILDS = 3;
const SERVER_BEAT_MS = 10000;
// loginwindow's own "lock now" entry point; same as the Lock Screen menu item. Symbol presence checked on macOS 26.
const MAC_LOCK_JXA = 'ObjC.import("Foundation");$.NSBundle.bundleWithPath("/System/Library/PrivateFrameworks/login.framework").load;ObjC.bindFunction("SACLockScreenImmediate",["int",[]]);$.SACLockScreenImmediate();';

let file = '';
let stored: Stored = { ...DEFAULTS };
let appUrl = '';
let preload = '';
let locked = false;
let unlocking = false;
let covers: { win: BrowserWindow; role: 'main' | 'sub'; display: Display }[] = [];
let hiddenWins: BrowserWindow[] = [];
let displayBlocker: number | null = null;
let macLocked = false;
let sessions: LockSessionSummary[] = [];
let failures = 0;
let retryAt = 0;
let rebuildTimer: NodeJS.Timeout | null = null;
let systemShutdown = false;
let serverUrl = '';
let relaunchBundle: string | null = null;
let lastAlive = 0;
let lastTick = 0;
let lastBeat = 0;
let rebuilds = 0;
let watchTimer: NodeJS.Timeout | null = null;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Stored>;
    const hex = (v: unknown) => (typeof v === 'string' && HEX.test(v) ? v : undefined);
    stored = { ...DEFAULTS, ...sanitize(raw), salt: hex(raw.salt), hash: hex(raw.hash), pin: raw.pin === true || undefined, recoverySalt: hex(raw.recoverySalt), recoveryHash: hex(raw.recoveryHash), relaunchLockedAt: typeof raw.relaunchLockedAt === 'number' ? raw.relaunchLockedAt : undefined };
  } catch { stored = { ...DEFAULTS }; }
}
function save() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
  } catch (err) { console.error('[lock] save failed', (err as Error).message); }
}
function sanitize(raw: Partial<LockSettings>): Partial<LockSettings> {
  const out: Partial<LockSettings> = {};
  if (raw.mainDisplay === null || (typeof raw.mainDisplay === 'string' && raw.mainDisplay.length < 200)) out.mainDisplay = raw.mainDisplay;
  return out;
}
const settings = (): LockSettings => ({ mainDisplay: stored.mainDisplay });
const hasPassword = () => !!(stored.salt && stored.hash);
/** A password the cover can take: set as a 4-digit PIN. */
const hasPin = () => hasPassword() && stored.pin === true;
const hasRecovery = () => !!(stored.recoverySalt && stored.recoveryHash);

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => err ? reject(err) : resolve(key)));
}
async function matches(secret: string, salt: string | undefined, hash: string | undefined): Promise<boolean> {
  if (!salt || !hash || typeof secret !== 'string' || secret.length > 1024) return false;
  const want = Buffer.from(hash, 'hex');
  const got = await scrypt(secret, Buffer.from(salt, 'hex'));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
const verify = (password: string) => matches(password, stored.salt, stored.hash);

/** Recovery code as typed: case, spaces and dashes do not matter. Null when it cannot be a code. */
export function normalizeRecovery(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  return s.length === 20 && [...s].every((ch) => RECOVERY_ALPHABET.includes(ch)) ? s : null;
}
/** New recovery code; only its hash is stored, the plain code is returned once for the user to write down. */
async function issueRecovery(): Promise<string> {
  const code = [...crypto.randomBytes(20)].map((b) => RECOVERY_ALPHABET[b & 31]).join('');
  const salt = crypto.randomBytes(16);
  stored.recoverySalt = salt.toString('hex');
  stored.recoveryHash = (await scrypt(code, salt)).toString('hex');
  return code.match(/.{5}/g)!.join('-');
}
/** 5 free tries, then a wait that doubles per miss (30s → 10min). Shared by unlock and password change. */
function noteFailure() {
  failures++;
  if (failures >= 5) retryAt = Date.now() + Math.min(600000, 30000 * 2 ** (failures - 5));
}
const retryIn = () => Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));

/** Stable id for a display across reboots (Electron's numeric id can change): built-in panel, or the monitor name. */
export function displayKey(d: Display): string { return d.internal ? 'internal' : `ext:${d.label || `${d.size.width}x${d.size.height}`}`; }
function mainDisplay(all: Display[]): Display {
  return all.find((d) => stored.mainDisplay && displayKey(d) === stored.mainDisplay) ?? screen.getPrimaryDisplay();
}
function layout() {
  const all = screen.getAllDisplays();
  const main = mainDisplay(all);
  return all.map((d) => ({ key: displayKey(d), label: d.label, internal: d.internal, primary: d.id === screen.getPrimaryDisplay().id, main: d.id === main.id, bounds: d.bounds }));
}

/** Option+L, the lock shortcut. Matched on the physical key so the Korean IME and the "¬" character do not matter. */
export function isLockShortcut(input: Electron.Input): boolean {
  return input.type === 'keyDown' && input.alt && !input.meta && !input.control && !input.shift && input.code === 'KeyL';
}
export const isLocked = () => locked;
/** Quit is refused while locked, except for a system shutdown/logout. */
export const blocksQuit = () => locked && !systemShutdown;

function appWindows() { return BrowserWindow.getAllWindows().filter((w) => !covers.some((c) => c.win === w)); }
function sendToApp(channel: string, ...args: unknown[]) {
  for (const w of appWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}
function sendToCovers(channel: string, payload: unknown) {
  for (const c of covers) if (!c.win.isDestroyed()) c.win.webContents.send(channel, payload);
}

/** Bring the lock settings up in the app window (menu item, or Option+L with no password yet). */
export function openLockSettings() {
  const w = appWindows().find((x) => x.isVisible()) ?? appWindows()[0];
  if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
  sendToApp('lock:open-settings');
}

export function lockNow() {
  if (locked) return;
  if (!hasPin()) { openLockSettings(); return; }
  locked = true;
  unlocking = false;
  hiddenWins = appWindows().filter((w) => w.isVisible());
  rebuilds = 0;
  lastAlive = lastTick = Date.now();
  watchTimer = setInterval(watchdog, 5000);
  beatServer(true);
  buildCovers();
  for (const w of hiddenWins) w.hide();
  focusMainCover(); // hiding the app's key window can leave no key window at all
  updateBlocker();
}

function buildCovers() {
  const all = screen.getAllDisplays();
  const main = mainDisplay(all);
  const old = covers;
  covers = [];
  // Subs first so the main cover is created last and keeps keyboard focus.
  for (const d of [...all.filter((x) => x.id !== main.id), main]) {
    const role = d.id === main.id ? 'main' as const : 'sub' as const;
    const win = new BrowserWindow({
      ...d.bounds,
      show: false,
      frame: false,
      // A borderless (non-titled) window makes kiosk mode apply its presentation options without entering
      // a native full-screen Space, so every display stays covered in place.
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      enableLargerThanScreen: true,
      hiddenInMissionControl: true,
      focusable: role === 'main',
      backgroundColor: COVER_BG,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setBounds(d.bounds);
    guardCover(win, role);
    covers.push({ win, role, display: d });
    let failedLoads = 0;
    win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3: aborted by a newer load
      // The page comes from the local server. If it stays unreachable the cover would be a blank wall
      // the password cannot be typed into, so give up and unlock rather than trap the user.
      if (++failedLoads > 20) { console.error('[lock] cover page unreachable; unlocking'); finishUnlock(); return; }
      setTimeout(() => { if (!win.isDestroyed()) void win.loadURL(`${appUrl}/?lock=${role}`).catch(() => {}); }, 1000);
    });
    win.webContents.on('render-process-gone', () => {
      if (!locked || win.isDestroyed() || !covers.some((c) => c.win === win)) return;
      if (role === 'main') recoverCover('renderer gone'); else win.reload();
    });
    // Chromium's hang monitor: the page stopped handling input. Only the main cover takes input.
    if (role === 'main') win.on('unresponsive', () => { if (locked && covers.some((c) => c.win === win)) recoverCover('unresponsive'); });
    void win.loadURL(`${appUrl}/?lock=${role}`).catch(() => {});
    if (role === 'main') {
      win.show();
      win.setKiosk(true);
      focusMainCover(win);
      win.webContents.once('did-finish-load', () => focusMainCover(win));
    } else {
      win.showInactive();
    }
  }
  for (const c of old) destroyCover(c.win);
}

function focusMainCover(win = covers.find((c) => c.role === 'main')?.win) {
  if (!locked || macLocked || !win || win.isDestroyed()) return;
  app.focus({ steal: true });
  win.focus();
}

function destroyCover(win: BrowserWindow) {
  if (win.isDestroyed()) return;
  if (win.isKiosk()) win.setKiosk(false);
  win.destroy();
}

function guardCover(win: BrowserWindow, role: 'main' | 'sub') {
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  win.on('close', (e) => { if (locked && !unlocking) e.preventDefault(); });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.control && input.meta && input.code === 'KeyQ') { e.preventDefault(); lockMac(); return; }
    // Editing keys for the password field pass; every other Cmd shortcut (quit, close, hide, reload,
    // devtools, new session…) is swallowed before the app menu sees it.
    if (input.meta && !input.control && !input.alt && ['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ'].includes(input.code)) return;
    if (input.meta || isLockShortcut(input)) e.preventDefault();
  });
  if (role === 'main') {
    // Something took focus (Spotlight, a dialog from another app): take it back so typing stays on the cover.
    win.on('blur', () => setTimeout(() => { if (!win.isDestroyed() && !win.isFocused()) focusMainCover(win); }, 150));
  }
}

/**
 * Every 5s while locked. The main cover's page pings every 10s once its password field is up; 35s of silence
 * means the page is broken (blank, stuck, never rendered). Time spent asleep or behind the macOS lock does not count.
 */
function watchdog() {
  const now = Date.now();
  if (macLocked || now - lastTick > 15000) lastAlive = now;
  lastTick = now;
  if (now - lastBeat >= SERVER_BEAT_MS) beatServer(true);
  if (locked && now - lastAlive > ALIVE_TIMEOUT_MS) recoverCover('no heartbeat');
}

/** Rebuild the covers (fresh renderer processes). Gives up and unlocks after MAX_REBUILDS failures in a row. */
function recoverCover(reason: string) {
  if (!locked) return;
  if (++rebuilds > MAX_REBUILDS) {
    console.error(`[lock] lock screen still broken after ${MAX_REBUILDS} rebuilds (${reason}); unlocking`);
    finishUnlock();
    return;
  }
  console.error(`[lock] lock screen ${reason}; rebuilding (${rebuilds}/${MAX_REBUILDS})`);
  lastAlive = Date.now();
  // Deferred: this can run inside one of the old covers' own event handlers.
  setTimeout(() => { if (locked) buildCovers(); }, 0);
}

/** Tell the server we are alive (or that the lock ended). It kills and reopens the app if the beats stop while locked. */
function beatServer(active: boolean) {
  if (!serverUrl) return;
  lastBeat = Date.now();
  const body = JSON.stringify(active ? { active, pid: process.pid, exe: app.getPath('exe'), bundle: relaunchBundle, timeoutMs: 40000 } : { active });
  try {
    const req = http.request(`${serverUrl}/api/lock-watch`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 3000 });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch { /* server down: nothing to tell */ }
}

function lockMac() {
  execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_LOCK_JXA], { timeout: 5000 }, (err) => {
    if (err) execFile('/usr/bin/pmset', ['displaysleepnow'], () => {});
  });
}

function finishUnlock() {
  if (!locked) return;
  unlocking = true;
  locked = false;
  failures = 0;
  retryAt = 0;
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  beatServer(false);
  const wins = hiddenWins;
  hiddenWins = [];
  const old = covers;
  covers = [];
  for (const c of old) destroyCover(c.win);
  unlocking = false;
  for (const w of wins) if (!w.isDestroyed()) w.show();
  wins.find((w) => !w.isDestroyed())?.focus();
  updateBlocker();
}

/** Keep the display (and so the Mac) awake while locked on AC power; on battery macOS may sleep and lock as usual. */
function updateBlocker() {
  const want = locked && !powerMonitor.isOnBatteryPower();
  if (want && displayBlocker === null) displayBlocker = powerSaveBlocker.start('prevent-display-sleep');
  else if (!want && displayBlocker !== null) { powerSaveBlocker.stop(displayBlocker); displayBlocker = null; }
}

/** Arrangement only: kiosk mode hiding the menu bar and Dock changes each display's work area, which must not count. */
function arrangement(list: Display[], mainId: number) {
  return list.map((d) => `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.width},${d.bounds.height}:${d.rotation}:${d.id === mainId ? 'm' : ''}`).sort().join('|');
}
function rebuildSoon(force = false) {
  if (!locked) return;
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    if (!locked) return;
    const all = screen.getAllDisplays();
    const now = arrangement(all, mainDisplay(all).id);
    const covered = arrangement(covers.map((c) => c.display), covers.find((c) => c.role === 'main')?.display.id ?? -1);
    if (force || now !== covered) buildCovers();
  }, 600);
}

/** Called right before a self-update relaunch so the new process comes back locked. */
export function rememberLockForRelaunch() {
  if (!locked) return;
  stored.relaunchLockedAt = Date.now();
  save();
}

type FromApp = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean;

/**
 * serverUrl: the local server that watches for a hung app while locked. relaunchBundle: the .app it reopens after
 * killing a hung app (null in development, where there is no bundle to open).
 */
export function initLockScreen(opts: { appUrl: string; preload: string; fromApp: FromApp; serverUrl?: string; relaunchBundle?: string | null }) {
  file = path.join(app.getPath('userData'), 'lock-screen.json');
  appUrl = opts.appUrl;
  preload = opts.preload;
  serverUrl = opts.serverUrl ?? '';
  relaunchBundle = opts.relaunchBundle ?? null;
  load();
  const { fromApp } = opts;
  const isCover = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => covers.some((c) => c.win.webContents === e.sender);
  const fromAppWindow = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => fromApp(e) && !isCover(e);

  ipcMain.handle('lock:get', (e) => fromAppWindow(e) ? { settings: settings(), hasPassword: hasPassword(), hasPin: hasPin(), hasRecovery: hasRecovery(), displays: layout() } : null);
  ipcMain.handle('lock:set', (e, patch: unknown) => {
    if (!fromAppWindow(e) || !patch || typeof patch !== 'object') return null;
    Object.assign(stored, sanitize(patch as Partial<LockSettings>));
    save();
    if (locked && 'mainDisplay' in (patch as object)) rebuildSoon(true);
    return settings();
  });
  ipcMain.handle('lock:password', async (e, req: unknown) => {
    if (!fromAppWindow(e) || !req || typeof req !== 'object') return { ok: false, error: 'invalid' };
    const { current, next } = req as { current?: unknown; next?: unknown };
    if (typeof next !== 'string' || (next !== '' && !PIN.test(next))) return { ok: false, error: 'pin' };
    if (hasPassword()) {
      if (retryIn() > 0) return { ok: false, error: 'wait', retryIn: retryIn() };
      if (!(await verify(typeof current === 'string' ? current : ''))) { noteFailure(); return { ok: false, error: 'wrong', retryIn: retryIn() }; }
      failures = 0;
    }
    let recoveryCode: string | undefined;
    if (next === '') { delete stored.salt; delete stored.hash; delete stored.pin; delete stored.recoverySalt; delete stored.recoveryHash; }
    else {
      const salt = crypto.randomBytes(16);
      stored.salt = salt.toString('hex');
      stored.hash = (await scrypt(next, salt)).toString('hex');
      stored.pin = true;
      // First password (or none left after one was used): hand out a recovery code. A change keeps the existing one.
      if (!hasRecovery()) recoveryCode = await issueRecovery();
    }
    save();
    return { ok: true, hasPassword: hasPassword(), hasPin: hasPin(), hasRecovery: hasRecovery(), recoveryCode };
  });
  // A new recovery code replaces the old one; needs the current password.
  ipcMain.handle('lock:recovery', async (e, current: unknown) => {
    if (!fromAppWindow(e) || !hasPassword()) return { ok: false, error: 'invalid' };
    if (retryIn() > 0) return { ok: false, error: 'wait', retryIn: retryIn() };
    if (!(await verify(typeof current === 'string' ? current : ''))) { noteFailure(); return { ok: false, error: 'wrong', retryIn: retryIn() }; }
    failures = 0;
    const recoveryCode = await issueRecovery();
    save();
    return { ok: true, recoveryCode };
  });
  ipcMain.on('lock:now', (e) => { if (fromAppWindow(e)) lockNow(); });
  // The app window reports per-agent session counts; the covers show them without titles.
  ipcMain.on('lock:sessions', (e, list: unknown) => {
    if (!fromAppWindow(e) || !Array.isArray(list)) return;
    sessions = list.filter((s): s is LockSessionSummary => !!s && typeof s === 'object' && typeof s.agent === 'string'
      && [s.total, s.running, s.waiting].every((n) => Number.isInteger(n) && n >= 0)).slice(0, 8)
      .map((s) => ({ agent: s.agent.slice(0, 20), total: s.total, running: s.running, waiting: s.waiting }));
    sendToCovers('lock:update', { sessions });
  });

  ipcMain.handle('lock:init', (e) => {
    const c = covers.find((x) => x.win.webContents === e.sender);
    if (!c || !fromApp(e)) return null;
    return { role: c.role, sessions, retryIn: retryIn() };
  });
  ipcMain.on('lock:alive', (e) => {
    const c = covers.find((x) => x.win.webContents === e.sender);
    if (c?.role === 'main' && fromApp(e)) { lastAlive = Date.now(); rebuilds = 0; }
  });
  ipcMain.handle('lock:unlock', async (e, password: unknown) => {
    if (!isCover(e) || !fromApp(e) || !locked) return { ok: false };
    if (retryIn() > 0) return { ok: false, retryIn: retryIn() };
    const input = typeof password === 'string' ? password : '';
    // Reply before the covers are destroyed, or the cover's pending invoke never settles.
    if (await verify(input)) { setTimeout(finishUnlock, UNLOCK_SHOW_MS); return { ok: true }; }
    const code = normalizeRecovery(input);
    if (code && await matches(code, stored.recoverySalt, stored.recoveryHash)) {
      // Single use: once typed on the cover it may have been seen. Settings then offer a new one.
      delete stored.recoverySalt; delete stored.recoveryHash;
      save();
      setTimeout(() => { finishUnlock(); openLockSettings(); }, UNLOCK_SHOW_MS);
      return { ok: true };
    }
    noteFailure();
    return { ok: false, retryIn: retryIn() };
  });

  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed'] as const) screen.on(ev as 'display-added', () => { rebuildSoon(); sendToApp('lock:displays'); });
  powerMonitor.on('on-ac', updateBlocker);
  powerMonitor.on('on-battery', updateBlocker);
  powerMonitor.on('lock-screen', () => { macLocked = true; });
  powerMonitor.on('unlock-screen', () => {
    macLocked = false;
    focusMainCover();
  });
  powerMonitor.on('shutdown', () => { systemShutdown = true; });

  // Came back from a self-update relaunch that happened while locked.
  const relaunchAt = stored.relaunchLockedAt;
  if (relaunchAt !== undefined) { delete stored.relaunchLockedAt; save(); }
  return { resumeLocked: !!relaunchAt && Date.now() - relaunchAt < RELAUNCH_GRACE_MS && hasPin() };
}
