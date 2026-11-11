import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { WebSocket } from 'ws';
import type { SessionRegistry } from '../sessions.js';
import type { PermissionModeId } from '../agents/types.js';
import { loadConfig, saveConfig, withConfigLock, type RemoteHostConfig } from '../config.js';
import { listHistory, isCompactSummary } from '../history.js';
import { readBuildInfo } from '../updater.js';
import { loadIdentity } from './identity.js';
import {
  addressKey, AuthLimiter, DEFAULT_REMOTE_PORT, deriveKey, encodeFrame, EXPORTER_LABEL, FrameReader, generateCode, MAX_FRAME,
  PBKDF2_ITERATIONS, PREAUTH_MAX_FRAME, proof, proofMatches, PROTOCOL_VERSION, REMOTE_METHODS, type RemoteHistoryRow, type RemoteMethod,
} from './protocol.cjs';

/*
 * Remote sessions host. A TLS listener next to the loopback HTTP server; nothing of the local API is reachable
 * through it. A client that passes the login (protocol.cts) gets exactly REMOTE_METHODS: list projects and
 * sessions, start / attach / message / approve / interrupt / close sessions. No shell, no file access.
 */

const LOGIN_TIMEOUT_MS = 10_000;
const MAX_PENDING = 32;
const MAX_CLIENTS = 4;
/** A client that stops reading (half-open link) is dropped before its queue eats memory. */
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 90_000;
const MODES: PermissionModeId[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'];

export interface RemoteHostStatus {
  configured: boolean;
  enabled: boolean;
  port: number;
  listening: boolean;
  error: string | null;
  fingerprint: string | null;
  codeCreatedAt: number | null;
  clients: { address: string; since: number }[];
  addresses: string[];
}

class RemoteError extends Error {}

export class RemoteHost {
  private server: tls.Server | null = null;
  private listeningPort = 0;
  private error: string | null = null;
  private fingerprint: string | null = null;
  private conns = new Set<Conn>();
  private limiter = new AuthLimiter();
  private pruneTimer = setInterval(() => this.limiter.prune(), 10 * 60_000);
  private applying: Promise<void> = Promise.resolve();
  private sessionsTimer: NodeJS.Timeout | null = null;

  constructor(readonly registry: SessionRegistry) {
    this.pruneTimer.unref();
    registry.onChange(() => {
      // Bursts (a turn start fires status + user) become one notice.
      if (this.sessionsTimer) return;
      this.sessionsTimer = setTimeout(() => { this.sessionsTimer = null; for (const c of this.conns) if (c.authed) c.send({ t: 'sessions' }); }, 150);
    });
  }

  /** Start, stop or restart the listener to match the saved config. Serialized. */
  apply(): Promise<void> {
    const run = this.applying.then(() => this.applyNow());
    this.applying = run.catch(() => {});
    return run;
  }

  private async applyNow() {
    const cfg = (await loadConfig()).remote;
    const want = cfg?.enabled ? cfg.port : 0;
    if (this.server && this.listeningPort === want) return;
    await this.stop();
    if (!cfg?.enabled) return;
    try {
      const id = await loadIdentity();
      this.fingerprint = id.fingerprint;
      const server = tls.createServer({ key: id.key, cert: id.cert, minVersion: 'TLSv1.3' }, (socket) => this.accept(socket));
      server.on('tlsClientError', () => { /* scanners and aborted handshakes: nothing to report */ });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        // Both stacks: '::' accepts IPv4 too (dual-stack) on macOS.
        server.listen(cfg.port, '::', () => { server.off('error', reject); resolve(); });
      });
      server.on('error', (err) => { this.error = err.message; });
      this.server = server;
      this.listeningPort = cfg.port;
      this.error = null;
      console.log(`[vibrato] remote host listening on port ${cfg.port}`);
    } catch (err) {
      this.error = (err as Error).message;
      console.warn(`[vibrato] remote host failed: ${this.error}`);
    }
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.listeningPort = 0;
    for (const c of this.conns) c.destroy();
    this.conns.clear();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  async status(): Promise<RemoteHostStatus> {
    const cfg = (await loadConfig()).remote;
    if (!this.fingerprint && cfg) this.fingerprint = (await loadIdentity().catch(() => null))?.fingerprint ?? null;
    return {
      configured: !!cfg,
      enabled: !!cfg?.enabled,
      port: cfg?.port ?? DEFAULT_REMOTE_PORT,
      listening: !!this.server,
      error: this.error,
      fingerprint: this.fingerprint,
      codeCreatedAt: cfg?.codeCreatedAt ?? null,
      clients: [...this.conns].filter((c) => c.authed).map((c) => ({ address: c.address, since: c.since })),
      addresses: localAddresses(),
    };
  }

  /** Settings: turn on/off, change the port. The first time also creates the identity and an access code. */
  async configure(patch: { enabled?: boolean; port?: number }): Promise<{ code: string | null }> {
    let code: string | null = null;
    await withConfigLock(async () => {
      const cfg = await loadConfig();
      let remote = cfg.remote;
      if (!remote) {
        code = generateCode();
        remote = await keyFor(code, { enabled: false, port: DEFAULT_REMOTE_PORT });
      }
      if (typeof patch.enabled === 'boolean') remote.enabled = patch.enabled;
      if (patch.port !== undefined) {
        if (!Number.isInteger(patch.port) || patch.port < 1024 || patch.port > 65535) throw new RemoteError('Port must be between 1024 and 65535.');
        remote.port = patch.port;
      }
      cfg.remote = remote;
      await saveConfig(cfg);
    });
    if (patch.enabled) await loadIdentity();
    await this.apply();
    return { code };
  }

  /** A new access code; every connected client is dropped and must log in with it. */
  async newCode(): Promise<string> {
    const code = generateCode();
    await withConfigLock(async () => {
      const cfg = await loadConfig();
      cfg.remote = await keyFor(code, { enabled: cfg.remote?.enabled ?? false, port: cfg.remote?.port ?? DEFAULT_REMOTE_PORT });
      await saveConfig(cfg);
    });
    for (const c of this.conns) c.destroy();
    this.conns.clear();
    return code;
  }

  disconnectAll() {
    for (const c of this.conns) c.destroy();
    this.conns.clear();
  }

  private accept(socket: tls.TLSSocket) {
    const pending = [...this.conns].filter((c) => !c.authed).length;
    if (pending >= MAX_PENDING) { socket.destroy(); return; }
    const conn = new Conn(this, socket);
    this.conns.add(conn);
    socket.on('close', () => { this.conns.delete(conn); conn.cleanup(); });
  }

  authedCount() { return [...this.conns].filter((c) => c.authed).length; }
  get limits() { return this.limiter; }
}

async function keyFor(code: string, base: { enabled: boolean; port: number }): Promise<RemoteHostConfig> {
  const salt = crypto.randomBytes(16);
  const key = await deriveKey(code, salt, PBKDF2_ITERATIONS);
  return { ...base, salt: salt.toString('base64'), iterations: PBKDF2_ITERATIONS, key: key.toString('base64'), codeCreatedAt: Date.now() };
}

function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (!a.internal && a.family === 'IPv4') out.push(a.address);
  }
  return out;
}

/** One client connection: login state machine, then calls. */
class Conn {
  authed = false;
  readonly address: string;
  readonly since = Date.now();
  private stage: 'hello' | 'auth' | 'busy' | 'ready' = 'hello';
  private nonce = crypto.randomBytes(32);
  private key: Buffer | null = null;
  private limiterKey: string;
  private limiterHeld = false;
  private loginTimer: NodeJS.Timeout;
  private reader: FrameReader;
  /** Stands in for a WebSocket subscriber in the session registry. */
  private sink: WebSocket;
  private attached = new Set<string>();

  constructor(private host: RemoteHost, private socket: tls.TLSSocket) {
    this.address = (socket.remoteAddress ?? '').replace(/^::ffff:/i, '');
    this.limiterKey = addressKey(socket.remoteAddress);
    this.loginTimer = setTimeout(() => this.destroy(), LOGIN_TIMEOUT_MS);
    this.reader = new FrameReader((m) => void this.onFrame(m), () => this.destroy(), () => (this.authed ? MAX_FRAME : PREAUTH_MAX_FRAME));
    socket.setTimeout(IDLE_TIMEOUT_MS, () => this.destroy());
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.reader.push(chunk));
    socket.on('error', () => { /* reset by peer and the like; 'close' follows */ });
    const conn = this;
    this.sink = {
      OPEN: 1,
      get readyState() { return conn.socket.destroyed ? 3 : 1; },
      send(data: string) { conn.sendRaw(Buffer.from(`{"t":"event","message":${data}}`, 'utf8')); },
    } as unknown as WebSocket;
  }

  send(msg: unknown) { this.sendRaw(Buffer.from(JSON.stringify(msg), 'utf8')); }

  private sendRaw(body: Buffer) {
    if (this.socket.destroyed) return;
    if (this.socket.writableLength > MAX_QUEUED_BYTES) { this.destroy(); return; }
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    this.socket.write(Buffer.concat([head, body]));
  }

  destroy() { this.socket.destroy(); }

  cleanup() {
    clearTimeout(this.loginTimer);
    if (this.limiterHeld) { this.host.limits.end(this.limiterKey, false); this.limiterHeld = false; }
    this.host.registry.detachAll(this.sink);
    this.attached.clear();
  }

  private async onFrame(raw: unknown) {
    if (!raw || typeof raw !== 'object') { this.destroy(); return; }
    const msg = raw as Record<string, unknown>;
    if (this.stage === 'ready') { await this.onCall(msg); return; }
    if (this.stage === 'hello' && msg.t === 'hello') { await this.onHello(msg); return; }
    if (this.stage === 'auth' && msg.t === 'auth') { await this.onAuth(msg); return; }
    this.destroy();
  }

  private async onHello(msg: Record<string, unknown>) {
    if (msg.v !== PROTOCOL_VERSION) { this.deny('version'); return; }
    const wait = this.host.limits.begin(this.limiterKey);
    if (wait) { this.deny('locked', wait.retryAfterMs); return; }
    this.limiterHeld = true;
    const cfg = (await loadConfig()).remote;
    if (!cfg?.enabled) { this.host.limits.cancel(this.limiterKey); this.limiterHeld = false; this.deny('disabled'); return; }
    this.key = Buffer.from(cfg.key, 'base64');
    this.stage = 'auth';
    this.send({ t: 'challenge', v: PROTOCOL_VERSION, salt: cfg.salt, iter: cfg.iterations, nonce: this.nonce.toString('base64'), host: os.hostname() });
  }

  private async onAuth(msg: Record<string, unknown>) {
    this.stage = 'busy';
    const cnonce = typeof msg.cnonce === 'string' ? Buffer.from(msg.cnonce, 'base64') : Buffer.alloc(0);
    if (cnonce.length !== 32 || !this.key) { this.deny('bad'); return; }
    const exporter = this.socket.exportKeyingMaterial(32, EXPORTER_LABEL, Buffer.alloc(0));
    const ok = proofMatches(proof(this.key, 'client', this.nonce, cnonce, exporter), msg.proof);
    this.host.limits.end(this.limiterKey, ok);
    this.limiterHeld = false;
    if (!ok) { this.deny('code'); return; }
    if (this.host.authedCount() >= MAX_CLIENTS) { this.deny('busy'); return; }
    clearTimeout(this.loginTimer);
    this.authed = true;
    this.stage = 'ready';
    this.send({ t: 'ok', proof: proof(this.key, 'host', this.nonce, cnonce, exporter).toString('base64') });
    console.log(`[vibrato] remote client logged in from ${this.address}`);
  }

  private deny(reason: string, retryAfterMs?: number) {
    this.send({ t: 'denied', reason, ...(retryAfterMs ? { retryAfterMs } : {}) });
    this.socket.end();
    setTimeout(() => this.destroy(), 1000).unref();
  }

  private async onCall(msg: Record<string, unknown>) {
    if (msg.t === 'ping') { this.send({ t: 'pong' }); return; }
    if (msg.t !== 'call') return;
    const id = msg.id;
    const method = msg.method as RemoteMethod;
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
    try {
      if (!(REMOTE_METHODS as readonly string[]).includes(method)) throw new RemoteError(`Unknown method: ${String(method)}`);
      const result = await this.call(method, params);
      this.send({ t: 'reply', id, result: result ?? null });
    } catch (err) {
      this.send({ t: 'reply', id, error: (err as Error).message || String(err) });
    }
  }

  private async call(method: RemoteMethod, p: Record<string, unknown>): Promise<unknown> {
    const reg = this.host.registry;
    switch (method) {
      case 'info':
        return { host: os.hostname(), version: readBuildInfo().version, home: os.homedir() };
      case 'projects': {
        const cfg = await loadConfig();
        return { favorites: cfg.favorites.map((f) => ({ path: f.path, name: f.name })), recent: cfg.recent };
      }
      case 'sessions':
        return reg.summaries();
      case 'history': {
        const cwd = await dirParam(p.cwd);
        const rows = await listHistory(cwd, 'all', 40);
        return rows.map((r): RemoteHistoryRow => {
          const x = r as { customTitle?: string; summary?: string; firstPrompt?: string };
          const title = x.customTitle || x.summary || (isCompactSummary(x.firstPrompt) ? '' : x.firstPrompt) || r.sessionId;
          return { agent: r.agent, sessionId: r.sessionId, title: String(title).slice(0, 200), lastModified: r.lastModified };
        });
      }
      case 'start': {
        const agent = p.agent === 'codex' ? 'codex' : p.agent === 'claude' ? 'claude' : null;
        if (!agent) throw new RemoteError('Unknown agent.');
        const cwd = await dirParam(p.cwd);
        const permissionMode = MODES.includes(p.permissionMode as PermissionModeId) ? p.permissionMode as PermissionModeId : 'default';
        const resume = typeof p.resume === 'string' && /^[\w.-]{1,200}$/.test(p.resume) ? p.resume : undefined;
        const session = await reg.start({ type: 'session.start', agent, cwd, permissionMode, resume }, this.sink);
        this.attached.add(session.id);
        try { session.start(); } catch (err) { await reg.close(session.id); throw err; }
        void rememberRecent(cwd);
        return { sessionId: session.id };
      }
      case 'attach': {
        const id = str(p.sessionId);
        const after = Number.isInteger(p.after) ? p.after as number : 0;
        if (!reg.get(id)) throw new RemoteError('Session is gone.');
        this.attached.add(id);
        reg.attach(id, this.sink, after);
        return { ok: true };
      }
      case 'detach': {
        const id = str(p.sessionId);
        reg.detach(id, this.sink);
        this.attached.delete(id);
        return { ok: true };
      }
      case 'send': {
        const id = str(p.sessionId);
        const text = typeof p.text === 'string' ? p.text : '';
        if (!text.trim()) throw new RemoteError('Empty message.');
        if (text.length > 100_000) throw new RemoteError('Message is too long.');
        const s = must(reg, id);
        await reg.send(id, () => s.send(text, [], crypto.randomUUID()));
        return { ok: true };
      }
      case 'approve': {
        const decision = p.decision === 'allow' || p.decision === 'allow_always' || p.decision === 'deny' ? p.decision : null;
        if (!decision) throw new RemoteError('Bad decision.');
        must(reg, str(p.sessionId)).approve(str(p.requestId), decision, typeof p.message === 'string' ? p.message.slice(0, 2000) : undefined);
        return { ok: true };
      }
      case 'answer': {
        const answers: Record<string, string> = {};
        if (p.answers && typeof p.answers === 'object') for (const [k, v] of Object.entries(p.answers)) if (typeof v === 'string') answers[k.slice(0, 2000)] = v.slice(0, 2000);
        must(reg, str(p.sessionId)).answer(str(p.requestId), answers, typeof p.response === 'string' ? p.response.slice(0, 20000) : undefined);
        return { ok: true };
      }
      case 'interrupt':
        await must(reg, str(p.sessionId)).interrupt();
        return { ok: true };
      case 'mode': {
        if (!MODES.includes(p.mode as PermissionModeId)) throw new RemoteError('Unknown mode.');
        await must(reg, str(p.sessionId)).setPermissionMode(p.mode as PermissionModeId);
        return { ok: true };
      }
      case 'close':
        await reg.close(str(p.sessionId));
        return { ok: true };
    }
  }
}

function str(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 300) throw new RemoteError('Bad parameter.');
  return v;
}

function must(reg: SessionRegistry, id: string) {
  const s = reg.get(id);
  if (!s) throw new RemoteError('Session is gone.');
  return s;
}

/** An existing folder, given as an absolute path or ~/...; the client never gets to read what is inside it. */
async function dirParam(v: unknown): Promise<string> {
  if (typeof v !== 'string' || !v || v.length > 1024) throw new RemoteError('Bad folder.');
  const abs = v === '~' ? os.homedir() : v.startsWith('~/') ? path.join(os.homedir(), v.slice(2)) : v;
  if (!path.isAbsolute(abs)) throw new RemoteError('Folder must be an absolute path.');
  const st = await fs.stat(abs).catch(() => null);
  if (!st?.isDirectory()) throw new RemoteError('Folder not found.');
  return path.resolve(abs);
}

async function rememberRecent(dir: string) {
  await withConfigLock(async () => {
    const cfg = await loadConfig();
    cfg.recent = [dir, ...cfg.recent.filter((r) => r !== dir)].slice(0, 20);
    await saveConfig(cfg);
  }).catch(() => {});
}
