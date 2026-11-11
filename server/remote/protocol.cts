/*
 * Remote sessions protocol, shared by the host (server/remote/host.ts, ESM) and the client (electron/remote.cts, CJS).
 *
 * Transport: TLS 1.3 straight over TCP, self-signed host certificate. The client pins its SHA-256 fingerprint on the
 * first successful login (TOFU) and refuses a different one afterwards.
 * Framing: 4-byte big-endian length + UTF-8 JSON.
 * Login (the access code never crosses the wire):
 *   C: { t: 'hello', v }                      H: { t: 'challenge', v, salt, iter, nonce, host }
 *   C: { t: 'auth', cnonce, proof }           H: { t: 'ok', proof } | { t: 'denied', reason, retryAfterMs? }
 *   key   = PBKDF2-SHA256(code, salt, iter)
 *   proof = HMAC-SHA256(key, label ‖ nonce ‖ cnonce ‖ TLS exporter)   label: "client" / "host"
 * The TLS exporter binds both proofs to this TLS session, so a man in the middle cannot relay them to another one.
 * The host's proof shows the client it talks to a host that knows the code; only then is the fingerprint pinned.
 * After login: { t: 'call', id, method, params } → { t: 'reply', id, result } | { t: 'reply', id, error },
 * host pushes { t: 'event', message } (session events) and { t: 'sessions' } (list changed); { t: 'ping' } ↔ { t: 'pong' }.
 */
import crypto from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_REMOTE_PORT = 11399;
export const PBKDF2_ITERATIONS = 200_000;
/** A client refuses hosts asking for fewer: a fake host could otherwise make offline guessing of the code cheap. */
export const MIN_ITERATIONS = 100_000;
export const EXPORTER_LABEL = 'EXPORTER-vibrato-remote-v1';
/** Frame size limits: before login a peer gets almost nothing; after it, session replays can be large. */
export const PREAUTH_MAX_FRAME = 4 * 1024;
export const MAX_FRAME = 16 * 1024 * 1024;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

/** A fresh access code: 20 characters from a 32-letter alphabet (100 bits), shown in groups of 5. */
export function generateCode(): string {
  const bytes = crypto.randomBytes(20);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b & 31]).join('');
  return chars.match(/.{5}/g)!.join('-');
}

/** What the user typed, as hashed: case, spaces and dashes do not matter. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]+/g, '');
}

export function deriveKey(code: string, salt: Buffer, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.pbkdf2(normalizeCode(code), salt, iterations, 32, 'sha256', (err, key) => (err ? reject(err) : resolve(key))));
}

export function proof(key: Buffer, label: 'client' | 'host', nonce: Buffer, cnonce: Buffer, exporter: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(`vibrato-remote/${label}\0`).update(nonce).update(cnonce).update(exporter).digest();
}

export function proofMatches(expected: Buffer, got: unknown): boolean {
  if (typeof got !== 'string') return false;
  const buf = Buffer.from(got, 'base64');
  return buf.length === expected.length && crypto.timingSafeEqual(buf, expected);
}

export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Splits a byte stream into JSON frames. `limit()` is read per frame so it can grow after login. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private onFrame: (msg: unknown) => void, private onError: (err: Error) => void, private limit: () => number) {}

  push(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > this.limit()) { this.buf = Buffer.alloc(0); this.onError(new Error('frame too large')); return; }
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let msg: unknown;
      try { msg = JSON.parse(body.toString('utf8')); } catch { this.onError(new Error('bad frame')); return; }
      this.onFrame(msg);
    }
  }
}

/** IPv4 address as is; IPv6 by its /64 (one home network). IPv4-mapped IPv6 counts as IPv4. */
export function addressKey(address: string | undefined): string {
  const a = (address ?? '').replace(/^::ffff:/i, '');
  if (!a.includes(':')) return a;
  const parts = a.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  const full = parts.length > 1 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return `${full.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Guessing limits for the login. Per address: 5 failures lock it for 30 s, each further failure doubles the lock
 * (up to an hour); while locked even the right code is refused. One login at a time per address. Across all
 * addresses, more than 20 failures in a minute refuse everyone for 30 s.
 */
export class AuthLimiter {
  private perAddr = new Map<string, { fails: number; lockedUntil: number; busy: boolean; last: number }>();
  private recent: number[] = [];
  private globalUntil = 0;

  constructor(private opts = { freeFails: 5, baseLockMs: 30_000, maxLockMs: 3_600_000, globalFails: 20, globalWindowMs: 60_000, globalLockMs: 30_000 }) {}

  /** Null when `key` may try now (and marks it busy), else how long to wait. */
  begin(key: string, now = Date.now()): { retryAfterMs: number } | null {
    if (now < this.globalUntil) return { retryAfterMs: this.globalUntil - now };
    const s = this.perAddr.get(key) ?? { fails: 0, lockedUntil: 0, busy: false, last: now };
    if (now < s.lockedUntil) return { retryAfterMs: s.lockedUntil - now };
    if (s.busy) return { retryAfterMs: 1000 };
    s.busy = true;
    this.perAddr.set(key, s);
    return null;
  }

  end(key: string, ok: boolean, now = Date.now()) {
    const s = this.perAddr.get(key);
    if (!s) return;
    s.busy = false;
    if (ok) { this.perAddr.delete(key); return; }
    s.fails++;
    s.last = now;
    if (s.fails >= this.opts.freeFails) s.lockedUntil = now + Math.min(this.opts.maxLockMs, this.opts.baseLockMs * 2 ** (s.fails - this.opts.freeFails));
    this.recent = this.recent.filter((t) => now - t < this.opts.globalWindowMs);
    this.recent.push(now);
    if (this.recent.length > this.opts.globalFails) { this.globalUntil = now + this.opts.globalLockMs; this.recent = []; }
  }

  /** The login ended without a verdict on the code (host turned off): free the address, count nothing. */
  cancel(key: string) {
    const s = this.perAddr.get(key);
    if (s) s.busy = false;
  }

  /** Forget addresses with no failure for an hour that are neither locked nor mid-login (call now and then). */
  prune(now = Date.now()) {
    for (const [k, s] of this.perAddr) if (!s.busy && now >= s.lockedUntil && now - s.last > this.opts.maxLockMs) this.perAddr.delete(k);
  }
}

/** Methods a logged-in client may call. Anything else is refused by the host. */
export const REMOTE_METHODS = ['info', 'projects', 'sessions', 'history', 'start', 'attach', 'detach', 'send', 'approve', 'answer', 'interrupt', 'mode', 'close'] as const;
export type RemoteMethod = typeof REMOTE_METHODS[number];

export interface RemoteSessionSummary {
  id: string;
  agent: 'claude' | 'codex';
  cwd: string;
  title: string;
  createdAt: number;
  lastActivity: number;
  running: boolean;
  /** Approvals and questions waiting for an answer. */
  waiting: number;
  permissionMode?: string;
}

export interface RemoteHistoryRow { agent: 'claude' | 'codex'; sessionId: string; title: string; lastModified: number }
