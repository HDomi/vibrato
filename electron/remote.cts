import { app, BrowserWindow, ipcMain, safeStorage, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RemoteClientError, RemoteConnection } from '../server/remote/client.cjs';
import { DEFAULT_REMOTE_PORT, REMOTE_METHODS } from '../server/remote/protocol.cjs';

/*
 * Remote tab: the connection to another Vibrato (server/remote/host.ts) lives here in the main process, so it
 * survives switching tabs and reloading the page; only "Disconnect" or quitting the app ends it. A lost link is
 * retried with backoff, and the sessions the page was watching are attached again from where they stopped.
 * Saved hosts go to userData/remote-hosts.json; an access code is only saved encrypted (safeStorage: Keychain on
 * macOS, DPAPI on Windows), and never when that is unavailable.
 */

interface SavedHost { id: string; name: string; address: string; port: number; fingerprint: string | null; code: string | null }
export interface HostView { id: string; name: string; address: string; port: number; fingerprint: string | null; hasCode: boolean }
type Status = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
interface State { status: Status; hostId: string | null; hostName: string | null; error: { code: string; message: string; fingerprint?: string; retryAfterMs?: number } | null; since: number | null; attempt: number }

const RETRY_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000];

let fromApp: (e: IpcMainInvokeEvent | IpcMainEvent) => boolean = () => false;
let hostsFile = '';
let conn: RemoteConnection | null = null;
let state: State = { status: 'idle', hostId: null, hostName: null, error: null, since: null, attempt: 0 };
/** Kept for reconnects while the app runs, whether or not it is saved. */
let liveCode: string | null = null;
/** The host's password (second factor): typed at every connect, kept in memory for reconnects only, never saved. */
let livePassword: string | null = null;
let retryTimer: NodeJS.Timeout | null = null;
/** Sessions the page attached to; a reconnect attaches them again after the last event seq forwarded. */
const watched = new Set<string>();
const lastSeq = new Map<string, number>();
/**
 * Pages using the remote tab: they read the state when they wire up (web/src/lib/remote.ts) and make the calls.
 * Session events go only to them, not to every window (lock covers, IDE, browser).
 */
const eventPages = new Set<WebContents>();

function usesRemote(e: IpcMainInvokeEvent | IpcMainEvent) {
  const wc = e.sender;
  if (eventPages.has(wc)) return;
  eventPages.add(wc);
  wc.once('destroyed', () => eventPages.delete(wc));
}

function readHosts(): SavedHost[] {
  try {
    const list = JSON.parse(fs.readFileSync(hostsFile, 'utf8'));
    return Array.isArray(list) ? list.filter((h) => h && typeof h.id === 'string' && typeof h.address === 'string') : [];
  } catch { return []; }
}

function writeHosts(list: SavedHost[]) {
  fs.mkdirSync(path.dirname(hostsFile), { recursive: true });
  const tmp = `${hostsFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, hostsFile);
}

const view = (h: SavedHost): HostView => ({ id: h.id, name: h.name, address: h.address, port: h.port, fingerprint: h.fingerprint, hasCode: !!h.code });

function updateHost(id: string, patch: Partial<SavedHost>) {
  writeHosts(readHosts().map((h) => (h.id === id ? { ...h, ...patch } : h)));
}

function savedCode(h: SavedHost): string | null {
  if (!h.code || !safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(h.code, 'base64')); } catch { return null; }
}

function broadcast(channel: string, payload?: unknown) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

function setState(patch: Partial<State>) {
  state = { ...state, ...patch };
  broadcast('remote:state', state);
}

function clearRetry() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

function dropConnection() {
  const c = conn;
  conn = null;
  if (c) { c.removeAllListeners(); c.on('error', () => {}); c.close(); }
}

async function open(host: SavedHost, code: string, password: string | null, reconnect: boolean): Promise<void> {
  clearRetry();
  dropConnection();
  setState({ status: reconnect ? 'reconnecting' : 'connecting', hostId: host.id, hostName: state.hostId === host.id ? state.hostName : null, error: null });
  const c = new RemoteConnection();
  conn = c;
  try {
    const r = await c.connect({ address: host.address, port: host.port, code, password: password ?? undefined, pinned: host.fingerprint });
    if (conn !== c) { c.close(); return; }
    if (!host.fingerprint) updateHost(host.id, { fingerprint: r.fingerprint });
    liveCode = code;
    livePassword = password;
    // One IPC message per batch the host sent: the page applies it and renders once.
    c.on('events', (list: { sessionId?: string; seq?: number }[]) => {
      for (const msg of list) if (msg?.sessionId && typeof msg.seq === 'number' && msg.seq > (lastSeq.get(msg.sessionId) ?? 0)) lastSeq.set(msg.sessionId, msg.seq);
      for (const wc of eventPages) if (!wc.isDestroyed()) wc.send('remote:events', list);
    });
    c.on('sessions', () => broadcast('remote:sessions'));
    c.on('close', (err: RemoteClientError | null) => {
      if (conn !== c) return;
      conn = null;
      if (err?.code === 'KICKED') {
        // Closed on purpose (idle logout, host action): forget what reconnecting would use; logging in again is a choice.
        liveCode = null; livePassword = null; watched.clear(); lastSeq.clear();
        setState({ status: 'error', error: { code: err.extra.reason === 'idle' ? 'KICKED_IDLE' : 'KICKED', message: err.message }, since: null, attempt: 0 });
      }
      else if (err) scheduleRetry(host.id, err.message);
    });
    setState({ status: 'connected', hostName: r.hostName, since: Date.now(), attempt: 0, error: null });
    // Pick up where the page was: events after the last one it got.
    for (const id of watched) void c.call('attach', { sessionId: id, after: lastSeq.get(id) ?? 0 }).catch(() => { watched.delete(id); lastSeq.delete(id); });
    broadcast('remote:sessions');
  } catch (err) {
    if (conn !== c) return;
    conn = null;
    const e = err instanceof RemoteClientError ? err : new RemoteClientError('NETWORK', (err as Error).message);
    // Network trouble while reconnecting: keep trying. A refused code or a changed certificate needs the user.
    if (reconnect && (e.code === 'NETWORK' || e.code === 'TIMEOUT' || e.code === 'CLOSED' || (e.code === 'DENIED' && (e.extra.reason === 'locked' || e.extra.reason === 'busy')))) {
      scheduleRetry(host.id, e.message);
      return;
    }
    if (e.code === 'DENIED' && e.extra.reason === 'code') { liveCode = null; livePassword = null; }
    setState({ status: 'error', error: { code: e.code === 'DENIED' ? `DENIED_${String(e.extra.reason ?? '').toUpperCase()}` : e.code, message: e.message, fingerprint: e.extra.fingerprint, retryAfterMs: e.extra.retryAfterMs }, since: null });
  }
}

function scheduleRetry(hostId: string, message: string) {
  const attempt = state.attempt + 1;
  setState({ status: 'reconnecting', attempt, error: { code: 'LOST', message }, since: null });
  clearRetry();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const host = readHosts().find((h) => h.id === hostId);
    if (!host || !liveCode || state.hostId !== hostId) { setState({ status: 'idle', hostId: null, error: null }); return; }
    void open(host, liveCode, livePassword, true);
  }, RETRY_MS[Math.min(attempt - 1, RETRY_MS.length - 1)]);
}

function disconnect() {
  clearRetry();
  dropConnection();
  watched.clear();
  lastSeq.clear();
  liveCode = null;
  livePassword = null;
  setState({ status: 'idle', hostId: null, hostName: null, error: null, since: null, attempt: 0 });
}

function cleanAddress(v: unknown): string {
  const a = typeof v === 'string' ? v.trim().replace(/^\[|\]$/g, '') : '';
  if (!a || a.length > 253 || !/^[\w.:-]+$/.test(a)) throw new Error('Enter a host name or IP address.');
  return a;
}

export function initRemote(opts: { fromApp: (e: IpcMainInvokeEvent | IpcMainEvent) => boolean }) {
  fromApp = opts.fromApp;
  hostsFile = path.join(app.getPath('userData'), 'remote-hosts.json');

  ipcMain.handle('remote:hosts', (e) => (fromApp(e) ? readHosts().map(view) : []));
  ipcMain.handle('remote:state', (e) => { if (!fromApp(e)) return null; usesRemote(e); return state; });
  ipcMain.handle('remote:save-host', (e, raw: { id?: unknown; name?: unknown; address?: unknown; port?: unknown }) => {
    if (!fromApp(e) || !raw || typeof raw !== 'object') return null;
    const address = cleanAddress(raw.address);
    const port = raw.port === undefined || raw.port === '' ? DEFAULT_REMOTE_PORT : Number(raw.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
    const name = (typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : address).slice(0, 80);
    const list = readHosts();
    const existing = typeof raw.id === 'string' ? list.find((h) => h.id === raw.id) : undefined;
    if (existing) {
      // Another address or port may be another machine: forget the pinned certificate then.
      const moved = existing.address !== address || existing.port !== port;
      Object.assign(existing, { name, address, port }, moved ? { fingerprint: null } : {});
      writeHosts(list);
      return view(existing);
    }
    const h: SavedHost = { id: crypto.randomUUID(), name, address, port, fingerprint: null, code: null };
    writeHosts([...list, h]);
    return view(h);
  });
  ipcMain.handle('remote:remove-host', (e, id: unknown) => {
    if (!fromApp(e) || typeof id !== 'string') return;
    if (state.hostId === id) disconnect();
    writeHosts(readHosts().filter((h) => h.id !== id));
  });
  ipcMain.handle('remote:forget-code', (e, id: unknown) => {
    if (!fromApp(e) || typeof id !== 'string') return;
    updateHost(id, { code: null });
  });
  // After the user compared the new fingerprint with the one the host shows: pin it and log in again.
  ipcMain.handle('remote:trust', (e, id: unknown, fingerprint: unknown) => {
    if (!fromApp(e) || typeof id !== 'string' || typeof fingerprint !== 'string' || !/^[0-9A-F:]{95}$/.test(fingerprint)) return;
    updateHost(id, { fingerprint });
  });
  ipcMain.handle('remote:connect', async (e, raw: { hostId?: unknown; code?: unknown; password?: unknown; remember?: unknown }) => {
    if (!fromApp(e) || !raw || typeof raw.hostId !== 'string') return state;
    usesRemote(e);
    const host = readHosts().find((h) => h.id === raw.hostId);
    if (!host) throw new Error('Unknown host.');
    const typed = typeof raw.code === 'string' && raw.code.trim() ? raw.code.trim().slice(0, 200) : null;
    const code = typed ?? (state.hostId === host.id ? liveCode : null) ?? savedCode(host);
    if (!code) { setState({ status: 'error', hostId: host.id, error: { code: 'NEED_CODE', message: 'Enter the access code.' } }); return state; }
    const password = typeof raw.password === 'string' && raw.password ? raw.password.slice(0, 200) : (state.hostId === host.id ? livePassword : null);
    if (state.hostId !== host.id) { watched.clear(); lastSeq.clear(); }
    await open(host, code, password, false);
    if (state.status === 'connected' && typed && raw.remember === true && safeStorage.isEncryptionAvailable()) {
      updateHost(host.id, { code: safeStorage.encryptString(typed).toString('base64') });
    }
    return state;
  });
  ipcMain.handle('remote:disconnect', (e) => { if (fromApp(e)) disconnect(); });
  ipcMain.handle('remote:call', async (e, method: unknown, params: unknown) => {
    if (!fromApp(e) || typeof method !== 'string' || !(REMOTE_METHODS as readonly string[]).includes(method)) throw new Error('Bad call.');
    usesRemote(e);
    if (!conn?.open) throw new Error('Not connected.');
    const p = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    if (method === 'attach' && typeof p.sessionId === 'string') watched.add(p.sessionId);
    if ((method === 'detach' || method === 'close') && typeof p.sessionId === 'string') { watched.delete(p.sessionId); lastSeq.delete(p.sessionId); }
    const result = await conn.call(method, p);
    if (method === 'start' && result && typeof (result as { sessionId?: unknown }).sessionId === 'string') watched.add((result as { sessionId: string }).sessionId);
    return result;
  });

  app.on('before-quit', () => { clearRetry(); dropConnection(); });
}

/** After sleep the socket may be half-open: check right away instead of waiting for the ping timeout. */
export function remoteResume() {
  if (state.status === 'connected' && conn?.open) void conn.call('info', {}, 8000).catch(() => { conn?.close(); const id = state.hostId; if (id) scheduleRetry(id, 'Connection lost after sleep.'); });
}
