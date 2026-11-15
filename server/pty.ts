import type { WebSocket, WebSocketServer } from 'ws';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolvePath } from './fs.js';
import { loginShell } from './shell.js';

type PtyModule = typeof import('node-pty');
let ptyMod: PtyModule | null = null;
async function loadPty(): Promise<PtyModule> {
  if (!ptyMod) ptyMod = await import('node-pty');
  return ptyMod;
}

type ClientMsg = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number } | { type: 'close' };

/** A shell whose client dropped (sleep/wake, reload) stays alive this long for the same tab to reattach. */
export const DETACH_GRACE_MS = 10 * 60 * 1000;
/** Output produced while detached is kept (newest wins) and replayed on reattach. */
const REPLAY_BYTES = 256 * 1024;
/** Close code telling the client the process itself ended, so it must not reconnect. */
export const CLOSE_EXITED = 4000;

interface Shell {
  id: string;
  term: import('node-pty').IPty;
  ws: WebSocket | null;
  pending: string[];
  pendingBytes: number;
  grace: NodeJS.Timeout | null;
  initialTimer: NodeJS.Timeout | null;
}

const shells = new Map<string, Shell>();
let shutdownGeneration = 0;
/** Kill every shell we spawned (server shutdown). */
export function killAllPtys() {
  shutdownGeneration++;
  for (const s of shells.values()) { if (s.grace) clearTimeout(s.grace); if (s.initialTimer) clearTimeout(s.initialTimer); try { s.term.kill(); } catch { /* ignore */ } }
  shells.clear();
}
/** Shells currently waiting for their tab to come back (tests, diagnostics). */
export function detachedPtys() { return [...shells.values()].filter((s) => s.ws === null).map((s) => s.id); }

function endShell(s: Shell) {
  shells.delete(s.id);
  if (s.grace) clearTimeout(s.grace);
  if (s.initialTimer) clearTimeout(s.initialTimer);
  try { s.term.kill(); } catch { /* already gone */ }
}

function bind(s: Shell, ws: WebSocket) {
  s.ws = ws;
  if (s.grace) { clearTimeout(s.grace); s.grace = null; }
  const onMessage = (raw: unknown) => {
    // A throw here would crash the whole server, so every malformed frame is ignored.
    try {
      let m: ClientMsg | null = null;
      try { m = JSON.parse(String(raw)); } catch { /* raw keystrokes */ }
      if (!m || typeof m !== 'object') { s.term.write(String(raw)); return; }
      if (m.type === 'input' && typeof m.data === 'string') s.term.write(m.data);
      else if (m.type === 'resize') {
        const c = Number(m.cols), r = Number(m.rows);
        if (Number.isFinite(c) && Number.isFinite(r)) s.term.resize(Math.min(1000, Math.max(2, Math.floor(c))), Math.min(500, Math.max(1, Math.floor(r))));
      } else if (m.type === 'close') endShell(s); // the user closed the tab: no grace period
    } catch (err) {
      console.error('[pty] bad message', (err as Error).message);
    }
  };
  ws.on('message', onMessage);
  ws.once('close', () => {
    ws.off('message', onMessage);
    if (s.ws !== ws || !shells.has(s.id)) return;
    // Connection lost, tab still exists on the client: keep the process and buffer its output.
    s.ws = null;
    s.grace = setTimeout(() => { if (s.ws === null) endShell(s); }, DETACH_GRACE_MS);
  });
}

/**
 * Each WebSocket connection on /pty drives one shell. Query: cwd, cols, rows, cmd (optional initial command),
 * id (tab id: a reconnect with the same id within the grace period reattaches to the running shell).
 */
export function attachPty(wss: WebSocketServer) {
  wss.on('connection', async (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cwd = resolvePath(url.searchParams.get('cwd') ?? homedir());
    const dimension = (value: string | null, fallback: number, max: number) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(2, Math.floor(n))) : fallback; };
    const cols = dimension(url.searchParams.get('cols'), 80, 1000);
    const rows = dimension(url.searchParams.get('rows'), 24, 500);
    const initial = url.searchParams.get('cmd');
    const requested = url.searchParams.get('id');
    const id = requested && /^[\w-]{1,64}$/.test(requested) ? requested : randomUUID();
    const existing = shells.get(id);
    if (existing && existing.ws === null) {
      // Reattach: catch the tab up on what the shell printed while nobody was listening.
      try { existing.term.resize(cols, rows); } catch { /* shell exited meanwhile */ }
      const replay = existing.pending.join(''); existing.pending = []; existing.pendingBytes = 0;
      if (replay && ws.readyState === ws.OPEN) ws.send(replay);
      bind(existing, ws);
      return;
    }
    if (existing) { try { existing.ws?.close(); } catch { /* ignore */ } endShell(existing); } // same tab id twice: the newest connection wins
    const shell = loginShell();
    // Track a close that happens while node-pty is still loading, so the shell is not orphaned.
    let closedEarly = false;
    const onEarlyClose = () => { closedEarly = true; };
    ws.once('close', onEarlyClose);
    const generation = shutdownGeneration;
    const earlyMessages: string[] = [];
    const onEarlyMessage = (raw: unknown) => { if (earlyMessages.length < 32) earlyMessages.push(String(raw)); };
    ws.on('message', onEarlyMessage);
    let term: import('node-pty').IPty;
    try {
      const pty = await loadPty();
      if (closedEarly || generation !== shutdownGeneration) { ws.close(); return; }
      term = pty.spawn(shell.file, shell.args, {
        name: 'xterm-256color', cols, rows, cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'ko_KR.UTF-8' } as Record<string, string>,
      });
    } catch (err) {
      if (ws.readyState === ws.OPEN) ws.send(`\r\n[pty failed to start] ${(err as Error).message}\r\n`);
      ws.close();
      return;
    }
    ws.off('close', onEarlyClose);
    ws.off('message', onEarlyMessage);
    if (closedEarly || ws.readyState !== ws.OPEN) { try { term.kill(); } catch { /* ignore */ } return; }
    const s: Shell = { id, term, ws, pending: [], pendingBytes: 0, grace: null, initialTimer: null };
    shells.set(id, s);
    term.onData((d) => {
      if (s.ws && s.ws.readyState === s.ws.OPEN) { s.ws.send(d); return; }
      s.pending.push(d); s.pendingBytes += Buffer.byteLength(d);
      while (s.pending.length > 1 && s.pendingBytes > REPLAY_BYTES) s.pendingBytes -= Buffer.byteLength(s.pending.shift()!);
    });
    term.onExit(({ exitCode }) => {
      const sock = s.ws;
      shells.delete(id);
      if (s.grace) clearTimeout(s.grace);
      if (sock && sock.readyState === sock.OPEN) { sock.send(`\r\n[process exited ${exitCode}]\r\n`); sock.close(CLOSE_EXITED, 'exited'); }
    });
    s.initialTimer = initial ? setTimeout(() => { s.initialTimer = null; if (shells.has(id)) { try { term.write(initial + '\r'); } catch { /* shell exited */ } } }, 300) : null;
    bind(s, ws);
    for (const message of earlyMessages) ws.emit('message', message);
  });
}
