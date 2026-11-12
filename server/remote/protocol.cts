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
 *   With a host password (second factor) the challenge also carries pw: { salt, iter } and
 *   key   = HMAC-SHA256(key, "vibrato-remote/password" ‖ PBKDF2-SHA256(password, pw.salt, pw.iter))
 *   proof = HMAC-SHA256(key, label ‖ nonce ‖ cnonce ‖ TLS exporter)   label: "client" / "host"
 * The TLS exporter binds both proofs to this TLS session, so a man in the middle cannot relay them to another one.
 * The host's proof shows the client it talks to a host that knows the code; only then is the fingerprint pinned.
 * After login: { t: 'call', id, method, params } → { t: 'reply', id, result } | { t: 'reply', id, error },
 * host pushes { t: 'event', message } (session events) and { t: 'sessions' } (list changed); { t: 'ping' } ↔ { t: 'pong' }.
 *
 * Optional features, used only when both sides list them (hello.caps → challenge.caps), so older apps still connect:
 *   batch    the host sends { t: 'events', messages } (a few ms of events at once) instead of one frame each
 *   deflate  after login the host may send a frame body deflate-raw compressed; the length's top bit marks it
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_REMOTE_PORT = 11399;
export const PBKDF2_ITERATIONS = 200_000;
/** A client refuses hosts asking for fewer: a fake host could otherwise make offline guessing of the code cheap. */
export const MIN_ITERATIONS = 100_000;
export const EXPORTER_LABEL = 'EXPORTER-vibrato-remote-v1';
/** Frame size limits: before login a peer gets almost nothing; after it, session replays can be large. */
export const PREAUTH_MAX_FRAME = 4 * 1024;
export const MAX_FRAME = 16 * 1024 * 1024;
/** What a compressed frame may expand to: bigger than any session replay, small enough to bound a bad frame. */
export const MAX_INFLATED = 64 * 1024 * 1024;
export const CAPS = ['batch', 'deflate'] as const;
export type Cap = typeof CAPS[number];
/** Frames shorter than this are not worth compressing. */
export const COMPRESS_MIN = 1024;
/** Bodies at least this big are (de)compressed on zlib's thread pool instead of blocking the event loop (a replay can be MBs). */
export const ASYNC_ZLIB_MIN = 64 * 1024;
const COMPRESSED_BIT = 0x80000000;

/** The features both sides support, from the list the peer sent. */
export function agreeCaps(theirs: unknown): Set<Cap> {
  return new Set(Array.isArray(theirs) ? CAPS.filter((c) => theirs.includes(c)) : []);
}

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

/** Password as typed (Unicode-normalized only: unlike the code, case and spaces count). */
export function derivePassword(password: string, salt: Buffer, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.pbkdf2(password.normalize('NFC'), salt, iterations, 32, 'sha256', (err, key) => (err ? reject(err) : resolve(key))));
}

/** The login key: the code's key alone, or bound to the password's key when the host set one. */
export function loginKey(codeKey: Buffer, passwordKey: Buffer | null): Buffer {
  return passwordKey ? crypto.createHmac('sha256', codeKey).update('vibrato-remote/password\0').update(passwordKey).digest() : codeKey;
}

export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 128;

export function proof(key: Buffer, label: 'client' | 'host', nonce: Buffer, cnonce: Buffer, exporter: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(`vibrato-remote/${label}\0`).update(nonce).update(cnonce).update(exporter).digest();
}

export function proofMatches(expected: Buffer, got: unknown): boolean {
  if (typeof got !== 'string') return false;
  const buf = Buffer.from(got, 'base64');
  return buf.length === expected.length && crypto.timingSafeEqual(buf, expected);
}

function frame(body: Buffer, compressed: boolean): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE((body.length | (compressed ? COMPRESSED_BIT : 0)) >>> 0, 0);
  return Buffer.concat([head, body]);
}

/** Level 1 for big replays (fast, still ~5x on JSON); the default level for the usual small batches. */
const deflateLevel = (size: number) => (size > 256 * 1024 ? 1 : 6);

export function encodeFrame(msg: unknown, compress = false): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (compress && body.length >= COMPRESS_MIN) {
    const packed = zlib.deflateRawSync(body, { level: deflateLevel(body.length) });
    if (packed.length < body.length) return frame(packed, true);
  }
  return frame(body, false);
}

/**
 * encodeFrame with a big body compressed off the main thread: the same bytes, as a promise. Small frames come back
 * at once (a Buffer), so a caller that is not waiting on an earlier frame can write them straight away.
 */
export function encodeFrameAsync(msg: unknown, compress = false): Buffer | Promise<Buffer> {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (!compress || body.length < ASYNC_ZLIB_MIN) {
    if (compress && body.length >= COMPRESS_MIN) {
      const packed = zlib.deflateRawSync(body, { level: deflateLevel(body.length) });
      if (packed.length < body.length) return frame(packed, true);
    }
    return frame(body, false);
  }
  return new Promise((resolve) => zlib.deflateRaw(body, { level: deflateLevel(body.length) }, (err, packed) => {
    resolve(!err && packed.length < body.length ? frame(packed, true) : frame(body, false));
  }));
}

/**
 * Splits a byte stream into JSON frames. `limit()` is read per frame so it can grow after login;
 * `compressed()` says whether compressed frames are allowed yet (never before login).
 * Chunks are kept in a list and joined once a whole frame is there: a big frame arriving in many small reads
 * is copied once, not once per read. A big compressed frame is inflated off the main thread; frames after it wait
 * so `onFrame` still sees them in order.
 */
export class FrameReader {
  private chunks: Buffer[] = [];
  private size = 0;
  /** Frames that arrived while a big one is being inflated; null when none is. */
  private waiting: { body: Buffer; compressed: boolean }[] | null = null;
  /** Bumped by reset(), so an inflate that finishes after a bad frame is dropped. */
  private generation = 0;
  constructor(private onFrame: (msg: unknown) => void, private onError: (err: Error) => void, private limit: () => number, private compressed: () => boolean = () => false) {}

  push(chunk: Buffer) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size >= 4) {
      const head = this.peek(4);
      const raw = head.readUInt32BE(0);
      const isCompressed = (raw & COMPRESSED_BIT) !== 0;
      const len = raw & ~COMPRESSED_BIT;
      if (len > this.limit() || (isCompressed && !this.compressed())) { this.reset(); this.onError(new Error('bad frame header')); return; }
      if (this.size < 4 + len) return;
      if (!this.deliver(this.take(4 + len).subarray(4), isCompressed)) return;
    }
  }

  /** Decode and hand on one frame body, in arrival order. False after a bad frame (reset, onError called). */
  private deliver(body: Buffer, compressed: boolean): boolean {
    if (this.waiting) { this.waiting.push({ body, compressed }); return true; }
    if (compressed && body.length >= ASYNC_ZLIB_MIN) {
      this.waiting = [];
      const generation = this.generation;
      zlib.inflateRaw(body, { maxOutputLength: MAX_INFLATED }, (err, raw) => {
        if (generation !== this.generation) return;
        const rest = this.waiting ?? [];
        this.waiting = null;
        if (err || !this.emit(raw)) { if (err) this.fail(); return; }
        for (let i = 0; i < rest.length; i++) {
          // Another big frame among them: the rest waits for that one in turn.
          if (this.waiting) { (this.waiting as { body: Buffer; compressed: boolean }[]).push(...rest.slice(i)); return; }
          if (!this.deliver(rest[i].body, rest[i].compressed)) return;
        }
      });
      return true;
    }
    let raw = body;
    if (compressed) {
      try { raw = zlib.inflateRawSync(body, { maxOutputLength: MAX_INFLATED }); } catch { return this.fail(); }
    }
    return this.emit(raw);
  }

  private emit(raw: Buffer): boolean {
    let msg: unknown;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return this.fail(); }
    this.onFrame(msg);
    return true;
  }

  private fail(): false {
    this.reset();
    this.onError(new Error('bad frame'));
    return false;
  }

  private reset() { this.chunks = []; this.size = 0; this.waiting = null; this.generation++; }

  /** The first `n` bytes, joining only as many chunks as needed. */
  private peek(n: number): Buffer {
    if (this.chunks[0].length >= n) return this.chunks[0];
    const joined = Buffer.concat(this.chunks);
    this.chunks = [joined];
    return joined;
  }

  private take(n: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    return out;
  }
}

// ---- making session events cheaper to send ----

/** Session event as the registry sends it (server/agents/types.ts ServerMessage). */
export interface WireMessage { sessionId: string; seq: number; ts: number; event: { kind: string; [k: string]: unknown } }

/** Long strings the remote tab never shows in full (tool inputs and outputs) are cut to this. */
export const REMOTE_TEXT_MAX = 4000;
/** Approval cards show the tool input (a whole file for Write): keep much more there. */
export const REMOTE_APPROVAL_MAX = 100_000;

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s;
}

function cutDeep(v: unknown, max: number, depth = 0): unknown {
  if (typeof v === 'string') return cut(v, max);
  if (!v || typeof v !== 'object' || depth > 6) return v;
  if (Array.isArray(v)) return v.map((x) => cutDeep(x, max, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = cutDeep(x, max, depth + 1);
  return out;
}

/**
 * The remote tab shows a tool as one line and never its output, so streamed tool output is dropped and long
 * tool inputs / results are cut. Returns null for an event not worth sending. Sequence gaps are fine: the
 * client only skips what it already has.
 */
export function slimForRemote(m: WireMessage): WireMessage | null {
  const e = m.event;
  switch (e.kind) {
    case 'tool.output':
    case 'tool.progress':
      return null;
    case 'tool.result':
      return typeof e.content === 'string' && e.content.length > REMOTE_TEXT_MAX ? { ...m, event: { ...e, content: cut(e.content, REMOTE_TEXT_MAX) } } : m;
    case 'tool.start':
      return { ...m, event: { ...e, input: cutDeep(e.input, REMOTE_TEXT_MAX) } };
    case 'assistant.message':
      return Array.isArray(e.blocks)
        ? { ...m, event: { ...e, blocks: e.blocks.map((b: { type?: string; input?: unknown }) => (b?.type === 'tool_use' ? { ...b, input: cutDeep(b.input, REMOTE_TEXT_MAX) } : b)) } }
        : m;
    case 'approval.request':
      return { ...m, event: { ...e, input: cutDeep(e.input, REMOTE_APPROVAL_MAX) } };
    default:
      return m;
  }
}

/**
 * Queue `m`, merging a streamed text or thinking piece into the previous one when it directly follows it
 * (same session, kind and parent, next seq). Token streams turn into a few messages per batch.
 */
export function queueMessage(queue: WireMessage[], m: WireMessage) {
  const last = queue[queue.length - 1];
  const e = m.event;
  if (last && (e.kind === 'text.delta' || e.kind === 'thinking.delta') && last.sessionId === m.sessionId && last.event.kind === e.kind
    && last.event.parent === e.parent && m.seq === last.seq + 1 && typeof last.event.text === 'string' && typeof e.text === 'string') {
    queue[queue.length - 1] = { ...m, event: { ...e, text: last.event.text + e.text } };
    return;
  }
  queue.push(m);
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

  /** Record the login's outcome. Says whether this failure just locked the address (for how long) or everyone. */
  end(key: string, ok: boolean, now = Date.now()): { lockedMs: number | null; globalLockMs: number | null } {
    const none = { lockedMs: null, globalLockMs: null };
    const s = this.perAddr.get(key);
    if (!s) return none;
    s.busy = false;
    if (ok) { this.perAddr.delete(key); return none; }
    s.fails++;
    s.last = now;
    let lockedMs: number | null = null;
    if (s.fails >= this.opts.freeFails) {
      lockedMs = Math.min(this.opts.maxLockMs, this.opts.baseLockMs * 2 ** (s.fails - this.opts.freeFails));
      s.lockedUntil = now + lockedMs;
    }
    this.recent = this.recent.filter((t) => now - t < this.opts.globalWindowMs);
    this.recent.push(now);
    let globalLockMs: number | null = null;
    if (this.recent.length > this.opts.globalFails) { this.globalUntil = now + this.opts.globalLockMs; this.recent = []; globalLockMs = this.opts.globalLockMs; }
    return { lockedMs, globalLockMs };
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
export const REMOTE_METHODS = ['info', 'projects', 'sessions', 'history', 'start', 'attach', 'detach', 'send', 'approve', 'answer', 'interrupt', 'mode', 'close', 'models', 'model', 'usage'] as const;
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

export interface RemoteModel { id: string; name: string; description?: string; isDefault?: boolean }

export interface RemoteHistoryRow { agent: 'claude' | 'codex'; sessionId: string; title: string; lastModified: number }
