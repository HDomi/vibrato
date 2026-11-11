/*
 * Remote sessions client: one TLS connection to a host, the login from protocol.cts, then calls and pushed events.
 * Plain Node (no Electron) so tests can drive it against a real host; electron/remote.cts wraps it for the app.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import { agreeCaps, CAPS, deriveKey, derivePassword, loginKey, encodeFrame, EXPORTER_LABEL, FrameReader, MAX_FRAME, MIN_ITERATIONS, proof, proofMatches, PROTOCOL_VERSION, type Cap } from './protocol.cjs';

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;
const PING_EVERY_MS = 20_000;
/** No pong for this long: the link is dead even if TCP has not noticed (sleep, Wi-Fi change). */
const PONG_TIMEOUT_MS = 45_000;

export type RemoteErrorCode = 'FINGERPRINT_MISMATCH' | 'DENIED' | 'BAD_HOST' | 'TIMEOUT' | 'NETWORK' | 'CLOSED' | 'NEED_PASSWORD' | 'KICKED';

export class RemoteClientError extends Error {
  constructor(readonly code: RemoteErrorCode, message: string, readonly extra: { fingerprint?: string; reason?: string; retryAfterMs?: number } = {}) { super(message); }
}

export interface ConnectOptions {
  address: string;
  port: number;
  code: string;
  /** The host's login password, when it set one (second factor). */
  password?: string;
  /** Fingerprint saved from an earlier login; null on the first one (trust on first use). */
  pinned: string | null;
}

export interface Connected { fingerprint: string; hostName: string }

/**
 * Events: 'events' (session ServerMessages, oldest first), 'sessions' (the host's session list changed),
 * 'close' (RemoteClientError | null: null after close() was called).
 */
export class RemoteConnection extends EventEmitter {
  private socket: tls.TLSSocket | null = null;
  private calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPong = 0;
  private closedByUs = false;
  private ended = false;
  /** Logged in at some point: only then does a lost connection emit 'close'. */
  private ready = false;
  private closeEmitted = false;
  /** The host said it closes this connection on purpose, and why. */
  private kicked: 'host' | 'idle' | null = null;
  /** Features the host agreed to (protocol.cts CAPS); an older host agrees to none. */
  caps = new Set<Cap>();

  connect(opts: ConnectOptions): Promise<Connected> {
    return new Promise<Connected>((resolve, reject) => {
      let stage: 'tls' | 'challenge' | 'ok' | 'ready' = 'tls';
      let fingerprint = '';
      let hostName = '';
      let key: Buffer | null = null;
      let nonce: Buffer = Buffer.alloc(0);
      const cnonce = crypto.randomBytes(32);
      let settled = false;
      const fail = (err: RemoteClientError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ended = true;
        socket.destroy();
        reject(err);
      };
      const timer = setTimeout(() => fail(new RemoteClientError('TIMEOUT', 'The host did not answer in time.')), CONNECT_TIMEOUT_MS);
      // The certificate is self-signed: chain checks are off and the fingerprint pin below replaces them.
      // TLS itself still proves the host holds the key of the certificate it presents.
      const socket = tls.connect({ host: opts.address, port: opts.port, minVersion: 'TLSv1.3', rejectUnauthorized: false, servername: undefined });
      this.socket = socket;
      socket.setNoDelay(true);
      socket.on('error', (err) => {
        if (!settled) fail(new RemoteClientError('NETWORK', err.message));
      });
      socket.on('close', () => {
        if (!settled) { fail(new RemoteClientError('CLOSED', 'The host closed the connection.')); return; }
        this.finish(this.closedByUs ? null : this.kicked ? new RemoteClientError('KICKED', this.kicked === 'idle' ? 'Logged out after an hour without activity.' : 'The host closed this connection.', { reason: this.kicked }) : new RemoteClientError('CLOSED', 'Connection lost.'));
      });
      socket.once('secureConnect', () => {
        fingerprint = socket.getPeerX509Certificate()?.fingerprint256 ?? '';
        if (!fingerprint) { fail(new RemoteClientError('BAD_HOST', 'The host sent no certificate.')); return; }
        if (opts.pinned && opts.pinned !== fingerprint) {
          fail(new RemoteClientError('FINGERPRINT_MISMATCH', 'The host certificate changed since the last login.', { fingerprint }));
          return;
        }
        stage = 'challenge';
        this.write({ t: 'hello', v: PROTOCOL_VERSION, caps: [...CAPS] });
      });
      const reader = new FrameReader((raw) => {
        const msg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        if (stage === 'ready') { this.onMessage(msg); return; }
        if (msg.t === 'denied') {
          fail(new RemoteClientError('DENIED', `Login refused (${String(msg.reason)}).`, { reason: String(msg.reason), retryAfterMs: typeof msg.retryAfterMs === 'number' ? msg.retryAfterMs : undefined }));
          return;
        }
        if (stage === 'challenge' && msg.t === 'challenge') {
          const iter = Number(msg.iter);
          const salt = typeof msg.salt === 'string' ? Buffer.from(msg.salt, 'base64') : Buffer.alloc(0);
          nonce = typeof msg.nonce === 'string' ? Buffer.from(msg.nonce, 'base64') : Buffer.alloc(0);
          if (msg.v !== PROTOCOL_VERSION || !Number.isInteger(iter) || iter < MIN_ITERATIONS || iter > 10_000_000 || salt.length < 16 || nonce.length !== 32) {
            fail(new RemoteClientError('BAD_HOST', 'The host asked for an unsafe login.'));
            return;
          }
          hostName = typeof msg.host === 'string' ? msg.host.slice(0, 200) : '';
          this.caps = agreeCaps(msg.caps);
          stage = 'ok';
          const pw = msg.pw && typeof msg.pw === 'object' ? msg.pw as { salt?: unknown; iter?: unknown } : null;
          const pwSalt = pw && typeof pw.salt === 'string' ? Buffer.from(pw.salt, 'base64') : Buffer.alloc(0);
          const pwIter = Number(pw?.iter);
          if (pw && (!Number.isInteger(pwIter) || pwIter < MIN_ITERATIONS || pwIter > 10_000_000 || pwSalt.length < 16)) {
            fail(new RemoteClientError('BAD_HOST', 'The host asked for an unsafe login.'));
            return;
          }
          // The host wants its password too: without one there is nothing to try (and no failure is counted).
          if (pw && !opts.password) { fail(new RemoteClientError('NEED_PASSWORD', 'This host also asks for its password.')); return; }
          void Promise.all([deriveKey(opts.code, salt, iter), pw ? derivePassword(opts.password!, pwSalt, pwIter) : Promise.resolve(null)]).then(([codeKey, pwKey]) => {
            if (settled) return;
            const k = loginKey(codeKey, pwKey);
            key = k;
            const exporter = socket.exportKeyingMaterial(32, EXPORTER_LABEL, Buffer.alloc(0));
            this.write({ t: 'auth', cnonce: cnonce.toString('base64'), proof: proof(k, 'client', nonce, cnonce, exporter).toString('base64') });
          }, (err) => fail(new RemoteClientError('NETWORK', (err as Error).message)));
          return;
        }
        if (stage === 'ok' && msg.t === 'ok' && key) {
          const exporter = socket.exportKeyingMaterial(32, EXPORTER_LABEL, Buffer.alloc(0));
          if (!proofMatches(proof(key, 'host', nonce, cnonce, exporter), msg.proof)) {
            fail(new RemoteClientError('BAD_HOST', 'The host could not prove it knows the access code.'));
            return;
          }
          stage = 'ready';
          this.ready = true;
          settled = true;
          clearTimeout(timer);
          this.startPings();
          resolve({ fingerprint, hostName });
          return;
        }
        fail(new RemoteClientError('BAD_HOST', 'Unexpected message from the host.'));
      }, () => {
        // After login the stream is out of step: drop the connection (it reconnects) rather than read garbage.
        if (this.ready) socket.destroy();
        else fail(new RemoteClientError('BAD_HOST', 'Malformed data from the host.'));
      }, () => MAX_FRAME, () => this.ready && this.caps.has('deflate'));
      socket.on('data', (chunk: Buffer) => reader.push(chunk));
    });
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    if (!this.socket || this.ended) return Promise.reject(new RemoteClientError('CLOSED', 'Not connected.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new RemoteClientError('TIMEOUT', `${method} timed out.`)); }, timeoutMs);
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ t: 'call', id, method, params });
    });
  }

  /** Disconnect on purpose: tell the host first (its log and notice call that a clean logout), then close. */
  close() {
    this.closedByUs = true;
    const socket = this.socket;
    if (socket && !socket.destroyed && this.ready) {
      this.write({ t: 'bye' });
      socket.end();
      setTimeout(() => socket.destroy(), 1000).unref?.();
    } else socket?.destroy();
    this.finish(null);
  }

  get open() { return !this.ended && !!this.socket && !this.socket.destroyed; }

  private write(msg: unknown) {
    if (this.socket && !this.socket.destroyed) this.socket.write(encodeFrame(msg));
  }

  private onMessage(msg: Record<string, unknown>) {
    if (msg.t === 'pong') { this.lastPong = Date.now(); return; }
    // The host is closing us on purpose (turned off, new code or password, "disconnect all"): do not come back.
    if (msg.t === 'kicked') { this.kicked = msg.reason === 'idle' ? 'idle' : 'host'; return; }
    if (msg.t === 'events') { if (Array.isArray(msg.messages)) this.emit('events', msg.messages); return; }
    if (msg.t === 'event') { this.emit('events', [msg.message]); return; }
    if (msg.t === 'sessions') { this.emit('sessions'); return; }
    if (msg.t === 'reply' && typeof msg.id === 'number') {
      const c = this.calls.get(msg.id);
      if (!c) return;
      this.calls.delete(msg.id);
      clearTimeout(c.timer);
      if (typeof msg.error === 'string') c.reject(new Error(msg.error));
      else c.resolve(msg.result);
    }
  }

  private startPings() {
    this.lastPong = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPong > PONG_TIMEOUT_MS) { this.socket?.destroy(); return; }
      this.write({ t: 'ping' });
    }, PING_EVERY_MS);
    this.pingTimer.unref?.();
  }

  private finish(err: RemoteClientError | null) {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    for (const c of this.calls.values()) { clearTimeout(c.timer); c.reject(new RemoteClientError('CLOSED', 'Connection lost.')); }
    this.calls.clear();
    this.ended = true;
    if (!this.ready || this.closeEmitted) return;
    this.closeEmitted = true;
    this.emit('close', err);
  }
}
