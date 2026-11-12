import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { WebSocket } from 'ws';
import type { EventSink, SessionRegistry } from '../sessions.js';
import type { PermissionModeId, ServerMessage } from '../agents/types.js';
import { loadConfig, saveConfig, withConfigLock, type RemoteHostConfig } from '../config.js';
import { listHistory, isCompactSummary } from '../history.js';
import { readBuildInfo } from '../updater.js';
import { listClaudeModels } from '../agents/claude.js';
import { listCodexModels } from '../agents/codex.js';
import { which } from '../shell.js';
import { getUsage } from '../usage.js';
import { loadIdentity } from './identity.js';
import { maskWebhook, noticeMessage, sendDiscord, testMessage, validWebhook } from './notify.js';
import {
  addressKey, agreeCaps, AuthLimiter, DEFAULT_REMOTE_PORT, deriveKey, derivePassword, loginKey, PASSWORD_MAX, PASSWORD_MIN, encodeFrameAsync, EXPORTER_LABEL, FrameReader, generateCode, MAX_FRAME,
  PBKDF2_ITERATIONS, PREAUTH_MAX_FRAME, proof, proofMatches, PROTOCOL_VERSION, queueMessage, REMOTE_METHODS, slimForRemote,
  type Cap, type RemoteHistoryRow, type RemoteMethod, type RemoteModel, type WireMessage,
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
/** A logged-in client that does nothing for this long is logged out (pings and automatic refreshes do not count). */
export const INACTIVE_LOGOUT_MS = 60 * 60_000;
/** Calls that mean the person is working; list refreshes the app makes on its own do not. */
const USER_ACTIONS = new Set<RemoteMethod>(['start', 'attach', 'send', 'approve', 'answer', 'interrupt', 'mode', 'model', 'close', 'history']);
/** Session events wait this long to go out together (and stream pieces get merged): fewer frames and TLS records. */
const BATCH_MS = 15;
/** A long replay is cut into batches of this many messages so the first ones show while the rest is on the way. */
const BATCH_MAX = 400;
const MODES: PermissionModeId[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'];
/** Model ids as the CLIs name them (claude-opus-5-5, gpt-5.1-codex, sonnet[1m], ...): nothing that could become a flag. */
const MODEL_RE = /^[A-Za-z0-9][\w.:/\[\]-]{0,99}$/;
/** Listing Codex models starts a CLI process: remember the answer for a while. */
const MODELS_TTL_MS = 10 * 60_000;
const modelCache = new Map<string, { at: number; list: RemoteModel[] }>();

async function modelsFor(agent: 'claude' | 'codex'): Promise<RemoteModel[]> {
  const hit = modelCache.get(agent);
  if (hit && Date.now() - hit.at < MODELS_TTL_MS) return hit.list;
  const bin = await which(agent);
  if (!bin) return [];
  const list = agent === 'codex' ? await listCodexModels(bin) : await listClaudeModels(bin);
  modelCache.set(agent, { at: Date.now(), list });
  return list;
}

function modelParam(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !MODEL_RE.test(v)) throw new RemoteError('Bad model.');
  return v;
}

export interface RemoteHostStatus {
  configured: boolean;
  enabled: boolean;
  port: number;
  listening: boolean;
  error: string | null;
  fingerprint: string | null;
  codeCreatedAt: number | null;
  keepAwake: boolean;
  wakeOnConnect: boolean;
  /** A password (second factor) is set; when it was. */
  passwordSetAt: number | null;
  /** The Discord webhook for login notices, masked; null when none. */
  webhook: string | null;
  /** The no-idle-sleep assertion is held right now. */
  awake: boolean;
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
  /** Once a minute: log out clients idle for INACTIVE_LOGOUT_MS. */
  private idleTimer = setInterval(() => this.logoutIdle(), 60_000);
  /** Overridable in tests. */
  inactiveLogoutMs = INACTIVE_LOGOUT_MS;
  private applying: Promise<void> = Promise.resolve();
  private sessionsTimer: NodeJS.Timeout | null = null;
  /** `caffeinate -i` while listening: an idle-sleeping Mac would not answer at all. */
  private caffeinate: ChildProcess | null = null;
  /** Failed-login notices: when one last went out per address, and all of them in the last minute. */
  private failNoticeAt = new Map<string, number>();
  private failNotices: number[] = [];

  constructor(readonly registry: SessionRegistry) {
    this.pruneTimer.unref();
    this.idleTimer.unref();
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
    if (this.server && this.listeningPort === want) { this.holdAwake(cfg?.keepAwake !== false); return; }
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
      this.holdAwake(cfg.keepAwake !== false);
    } catch (err) {
      this.error = (err as Error).message;
      console.warn(`[vibrato] remote host failed: ${this.error}`);
    }
  }

  /**
   * Like legato's host: no idle system sleep while waiting for clients (the display may still sleep).
   * Tied to this process (-w) so it never outlives the server. A closed lid on battery still sleeps.
   */
  private holdAwake(on: boolean) {
    if (process.platform !== 'darwin') return;
    if (on && !this.caffeinate) {
      const child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      child.on('error', (err) => { console.warn(`[vibrato] remote keep-awake failed: ${err.message}`); if (this.caffeinate === child) this.caffeinate = null; });
      child.on('exit', () => { if (this.caffeinate === child) this.caffeinate = null; });
      this.caffeinate = child;
    } else if (!on && this.caffeinate) {
      this.caffeinate.kill();
      this.caffeinate = null;
    }
  }

  /** A client got in: wake the display (user activity for a few seconds), as legato does on connect. */
  clientLoggedIn() {
    if (process.platform !== 'darwin') return;
    void loadConfig().then((cfg) => {
      if (cfg.remote?.wakeOnConnect === false) return;
      const child = spawn('/usr/bin/caffeinate', ['-u', '-t', '3'], { stdio: 'ignore' });
      child.on('error', () => { /* best effort */ });
      child.unref();
    }).catch(() => {});
  }

  /**
   * MAC_LOGIN / MAC_LOGOUT to Discord. Successes always go out; failed logins at most once a minute per address
   * and ten a minute in all, so a flood of guesses cannot flood the channel (or Discord's rate limit).
   */
  notice(kind: 'login' | 'logout', address: string, ok: boolean) {
    const now = Date.now();
    if (kind === 'login' && !ok) {
      if (now - (this.failNoticeAt.get(address) ?? 0) < 60_000) return;
      this.failNotices = this.failNotices.filter((t) => now - t < 60_000);
      if (this.failNotices.length >= 10) return;
      this.failNoticeAt.set(address, now);
      this.failNotices.push(now);
      if (this.failNoticeAt.size > 1000) this.failNoticeAt.clear();
    }
    void loadConfig().then((cfg) => this.notify(cfg.remote?.discordWebhook, noticeMessage({ kind, address, at: now, ok }))).catch(() => {});
  }

  /** Posts a notice; replaceable in tests. */
  sendNotice: (url: string, content: string) => Promise<void> = (url, content) => sendDiscord(url, content);

  private notify(url: string | undefined, content: string) {
    if (!url) return;
    void this.sendNotice(url, content).catch((err) => console.warn(`[vibrato] remote: Discord notice failed: ${(err as Error).message}`));
  }

  /** Settings: set (or with null clear) the Discord webhook for login notices. */
  async setWebhook(url: string | null): Promise<void> {
    const clean = url?.trim() || null;
    if (clean && !validWebhook(clean)) throw new RemoteError('Paste a Discord webhook URL (https://discord.com/api/webhooks/…).');
    await withConfigLock(async () => {
      const cfg = await loadConfig();
      if (!cfg.remote) throw new RemoteError('Create an access code first.');
      if (clean) cfg.remote.discordWebhook = clean; else delete cfg.remote.discordWebhook;
      await saveConfig(cfg);
    });
  }

  /** Settings: post a test message to the saved webhook; throws with Discord's answer when it fails. */
  async testWebhook(): Promise<void> {
    const url = (await loadConfig()).remote?.discordWebhook;
    if (!url) throw new RemoteError('No webhook is set.');
    await sendDiscord(url, testMessage(os.hostname()));
  }

  logoutIdle(now = Date.now()) {
    for (const c of this.conns) if (c.authed && now - c.lastAction >= this.inactiveLogoutMs) {
      console.log(`[vibrato] remote client ${c.address} idle for ${Math.round(this.inactiveLogoutMs / 60_000)} min: logged out`);
      c.kick('idle');
    }
  }

  async stop() {
    this.holdAwake(false);
    const server = this.server;
    this.server = null;
    this.listeningPort = 0;
    for (const c of this.conns) c.kick();
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
      keepAwake: cfg?.keepAwake !== false,
      wakeOnConnect: cfg?.wakeOnConnect !== false,
      passwordSetAt: cfg?.password?.setAt ?? null,
      webhook: cfg?.discordWebhook ? maskWebhook(cfg.discordWebhook) : null,
      awake: !!this.caffeinate,
      clients: [...this.conns].filter((c) => c.authed).map((c) => ({ address: c.address, since: c.since })),
      addresses: localAddresses(),
    };
  }

  /** Settings: turn on/off, change the port. The first time also creates the identity and an access code. */
  async configure(patch: { enabled?: boolean; port?: number; keepAwake?: boolean; wakeOnConnect?: boolean }): Promise<{ code: string | null }> {
    let code: string | null = null;
    await withConfigLock(async () => {
      const cfg = await loadConfig();
      let remote = cfg.remote;
      if (!remote) {
        code = generateCode();
        remote = await keyFor(code, { enabled: false, port: DEFAULT_REMOTE_PORT });
      }
      // Two factors always: no turning on before a password is set.
      if (patch.enabled === true && !remote.password) throw new RemoteError('Set a password first.');
      if (typeof patch.enabled === 'boolean') remote.enabled = patch.enabled;
      if (typeof patch.keepAwake === 'boolean') remote.keepAwake = patch.keepAwake;
      if (typeof patch.wakeOnConnect === 'boolean') remote.wakeOnConnect = patch.wakeOnConnect;
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

  /**
   * Set (or with null remove) the login password. Connected clients are dropped: they logged in under the old rule.
   * The host must be set up (have a code) first.
   */
  async setPassword(password: string | null): Promise<void> {
    if (password === null) throw new RemoteError('The password cannot be removed; change it instead.');
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) throw new RemoteError(`Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`);
    await withConfigLock(async () => {
      const cfg = await loadConfig();
      if (!cfg.remote) throw new RemoteError('Create an access code first.');
      const salt = crypto.randomBytes(16);
      cfg.remote.password = { salt: salt.toString('base64'), iterations: PBKDF2_ITERATIONS, key: (await derivePassword(password, salt, PBKDF2_ITERATIONS)).toString('base64'), setAt: Date.now() };
      await saveConfig(cfg);
    });
    this.disconnectAll();
  }

  /** A new access code; every connected client is dropped and must log in with it. */
  async newCode(): Promise<string> {
    const code = generateCode();
    await withConfigLock(async () => {
      const cfg = await loadConfig();
      cfg.remote = { ...cfg.remote, ...(await keyFor(code, { enabled: cfg.remote?.enabled ?? false, port: cfg.remote?.port ?? DEFAULT_REMOTE_PORT })) };
      await saveConfig(cfg);
    });
    for (const c of this.conns) c.kick();
    this.conns.clear();
    return code;
  }

  disconnectAll() {
    for (const c of this.conns) c.kick();
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
  /** Features both sides support (protocol.cts CAPS), agreed in the hello. */
  private caps = new Set<Cap>();
  /** Last thing the person did (login counts): the idle logout measures from here. */
  lastAction = Date.now();
  /** The client said goodbye ({ t: 'bye' }) or this host closed it on purpose; otherwise the link dropped. */
  private closedCleanly = false;
  /** Compression starts only after the login answer went out uncompressed. */
  private compressOut = false;
  private queue: WireMessage[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  /** Frames still being compressed; anything written meanwhile waits behind them so the order on the wire holds. */
  private writing: Promise<void> | null = null;

  constructor(private host: RemoteHost, private socket: tls.TLSSocket) {
    this.address = (socket.remoteAddress ?? '').replace(/^::ffff:/i, '');
    this.limiterKey = addressKey(socket.remoteAddress);
    this.loginTimer = setTimeout(() => this.destroy(), LOGIN_TIMEOUT_MS);
    // The client never sends compressed frames.
    this.reader = new FrameReader((m) => void this.onFrame(m), () => this.destroy(), () => (this.authed ? MAX_FRAME : PREAUTH_MAX_FRAME), () => false);
    socket.setTimeout(IDLE_TIMEOUT_MS, () => this.destroy());
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.reader.push(chunk));
    socket.on('error', () => { /* reset by peer and the like; 'close' follows */ });
    const conn = this;
    const sink: EventSink & { OPEN: number; readyState: number; send(data: string): void } = {
      OPEN: 1,
      get readyState() { return conn.socket.destroyed ? 3 : 1; },
      // The registry hands events over as objects (sessions.ts sendEvent); `send` only covers anything sent as JSON.
      sendMessage(msg: ServerMessage) { conn.queueEvent(msg as unknown as WireMessage); },
      send(data: string) { try { conn.queueEvent(JSON.parse(data) as WireMessage); } catch { /* not an event */ } },
    };
    this.sink = sink as unknown as WebSocket;
  }

  /** A session event from the registry: slimmed, merged with the stream piece before it, sent with the next batch. */
  private queueEvent(msg: WireMessage) {
    if (this.socket.destroyed) return;
    // slimForRemote and queueMessage copy what they change: the registry's own message object is never touched.
    const m = slimForRemote(msg);
    if (!m) return;
    queueMessage(this.queue, m);
    if (this.queue.length >= BATCH_MAX) this.flush();
    else this.flushTimer ??= setTimeout(() => { this.flushTimer = null; this.flush(); }, BATCH_MS);
  }

  private flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.queue.length) return;
    const messages = this.queue;
    this.queue = [];
    if (this.caps.has('batch')) this.write({ t: 'events', messages });
    else for (const message of messages) this.write({ t: 'event', message });
  }

  /** Anything else goes out after the events queued before it, so a reply never overtakes its replay. */
  send(msg: unknown) {
    this.flush();
    this.write(msg);
  }

  private write(msg: unknown) {
    if (this.socket.destroyed) return;
    if (this.socket.writableLength > MAX_QUEUED_BYTES) { this.destroy(); return; }
    const framed = encodeFrameAsync(msg, this.compressOut && this.caps.has('deflate'));
    if (!this.writing && Buffer.isBuffer(framed)) { this.socket.write(framed); return; }
    const next = (this.writing ?? Promise.resolve()).then(() => framed).then((buf) => { if (!this.socket.destroyed) this.socket.write(buf); }).catch(() => {});
    this.writing = next;
    void next.then(() => { if (this.writing === next) this.writing = null; });
  }

  /** End the connection once every frame written so far is on the socket. */
  private endAfterWrites() {
    const end = () => { this.socket.end(); };
    if (this.writing) void this.writing.then(end); else end();
  }

  destroy() { this.socket.destroy(); }

  /** Closed on purpose by this host (turned off, new code, new password, disconnect all): a clean logout. */
  kick(reason: 'host' | 'idle' = 'host') {
    this.closedCleanly = true;
    // Say so first: a client that only saw the link drop would reconnect right away.
    if (this.authed) this.send({ t: 'kicked', reason });
    this.endAfterWrites();
    setTimeout(() => this.destroy(), 500).unref();
  }

  cleanup() {
    clearTimeout(this.loginTimer);
    if (this.authed) this.host.notice('logout', this.address, this.closedCleanly);
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.queue = [];
    // Leaving before sending a proof (no password at hand, user cancelled) guessed nothing: no failure counted.
    if (this.limiterHeld) { if (this.stage === 'auth') this.host.limits.cancel(this.limiterKey); else this.host.limits.end(this.limiterKey, false); this.limiterHeld = false; }
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
    if (wait) { this.host.notice('login', this.address, false); this.deny('locked', wait.retryAfterMs); return; }
    this.limiterHeld = true;
    const cfg = (await loadConfig()).remote;
    if (!cfg?.enabled) { this.host.limits.cancel(this.limiterKey); this.limiterHeld = false; this.deny('disabled'); return; }
    const pw = cfg.password;
    // A host turned on before passwords existed (v5.0.0) takes no logins until one is set.
    if (!pw) { this.host.limits.cancel(this.limiterKey); this.limiterHeld = false; this.deny('nopassword'); return; }
    // Both factors fold into one key: a wrong code and a wrong password look the same from outside.
    this.key = loginKey(Buffer.from(cfg.key, 'base64'), pw ? Buffer.from(pw.key, 'base64') : null);
    this.caps = agreeCaps(msg.caps);
    this.stage = 'auth';
    this.send({ t: 'challenge', v: PROTOCOL_VERSION, salt: cfg.salt, iter: cfg.iterations, nonce: this.nonce.toString('base64'), host: os.hostname(), caps: [...this.caps],
      ...(pw ? { pw: { salt: pw.salt, iter: pw.iterations } } : {}) });
  }

  private async onAuth(msg: Record<string, unknown>) {
    this.stage = 'busy';
    const cnonce = typeof msg.cnonce === 'string' ? Buffer.from(msg.cnonce, 'base64') : Buffer.alloc(0);
    if (cnonce.length !== 32 || !this.key) { this.deny('bad'); return; }
    const exporter = this.socket.exportKeyingMaterial(32, EXPORTER_LABEL, Buffer.alloc(0));
    const ok = proofMatches(proof(this.key, 'client', this.nonce, cnonce, exporter), msg.proof);
    const verdict = this.host.limits.end(this.limiterKey, ok);
    this.limiterHeld = false;
    if (!ok) this.host.notice('login', this.address, false);
    if (!ok) { this.deny('code'); return; }
    if (this.host.authedCount() >= MAX_CLIENTS) { this.host.notice('login', this.address, false); this.deny('busy'); return; }
    clearTimeout(this.loginTimer);
    this.authed = true;
    this.stage = 'ready';
    this.send({ t: 'ok', proof: proof(this.key, 'host', this.nonce, cnonce, exporter).toString('base64') });
    this.compressOut = true;
    console.log(`[vibrato] remote client logged in from ${this.address}${this.caps.size ? ` (${[...this.caps].join(', ')})` : ''}`);
    this.host.notice('login', this.address, true);
    this.host.clientLoggedIn();
  }

  private deny(reason: string, retryAfterMs?: number) {
    this.send({ t: 'denied', reason, ...(retryAfterMs ? { retryAfterMs } : {}) });
    this.endAfterWrites();
    setTimeout(() => this.destroy(), 1000).unref();
  }

  private async onCall(msg: Record<string, unknown>) {
    if (msg.t === 'ping') { this.send({ t: 'pong' }); return; }
    if (msg.t === 'bye') { this.closedCleanly = true; this.endAfterWrites(); return; }
    if (msg.t !== 'call') return;
    const id = msg.id;
    const method = msg.method as RemoteMethod;
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
    try {
      if (!(REMOTE_METHODS as readonly string[]).includes(method)) throw new RemoteError(`Unknown method: ${String(method)}`);
      if (USER_ACTIONS.has(method) || (method === 'usage' && params.force === true)) this.lastAction = Date.now();
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
        const model = modelParam(p.model);
        const session = await reg.start({ type: 'session.start', agent, cwd, permissionMode, resume, model }, this.sink);
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
        await reg.send(id, () => s.send(text, [], crypto.randomUUID()), { address: this.address, at: Date.now() });
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
      case 'models': {
        const agent = p.agent === 'codex' ? 'codex' : p.agent === 'claude' ? 'claude' : null;
        if (!agent) throw new RemoteError('Unknown agent.');
        return (await modelsFor(agent).catch(() => [])).map((m): RemoteModel => ({ id: m.id, name: m.name, description: m.description, isDefault: m.isDefault }));
      }
      case 'usage':
        // The host's Claude / Codex limits, as its own header shows them. force: fetch now instead of the cached copy.
        return getUsage(p.force === true);
      case 'model':
        // null: back to the CLI's default model.
        await must(reg, str(p.sessionId)).setModel(modelParam(p.model) ?? null);
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
