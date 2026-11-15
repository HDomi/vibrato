import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import zlib from 'node:zlib';
import { listListeners } from './os/net.js';

/** One request from the Tools > HTTP panel. The renderer cannot call other origins itself (CSP connect-src 'self'). */
export interface ProxyRequest {
  method: string;
  url: string;
  headers?: [string, string][];
  body?: string;
  /** Binary body; wins over `body`. */
  bodyBase64?: string;
  timeoutMs?: number;
  followRedirects?: boolean;
  insecure?: boolean;
}

export interface ProxyResponse {
  ok: true;
  status: number;
  statusText: string;
  httpVersion: string;
  url: string;
  headers: [string, string][];
  /** UTF-8 text when it decodes cleanly, otherwise base64. */
  body: string;
  encoding: 'utf8' | 'base64';
  /** Bytes after decompression, and on the wire. */
  size: number;
  wireSize: number;
  truncated: boolean;
  timing: { ttfb: number; total: number };
  redirects: { status: number; url: string }[];
}

export interface ProxyFailure { ok: false; error: string; code?: string; timing: { total: number } }

const MAX_BODY = 20 * 1024 * 1024;
const TEXT_TYPE = /^(text\/|application\/(json|.*\+json|xml|.*\+xml|javascript|x-www-form-urlencoded|graphql|yaml|x-yaml|toml|x-ndjson))/i;

function decodeBody(buf: Buffer, contentType: string): { body: string; encoding: 'utf8' | 'base64' } {
  if (!buf.length) return { body: '', encoding: 'utf8' };
  if (TEXT_TYPE.test(contentType) || !/^(image|audio|video|font)\/|octet-stream|zip|pdf|protobuf/i.test(contentType)) {
    try { return { body: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf8' }; } catch { /* binary */ }
  }
  return { body: buf.toString('base64'), encoding: 'base64' };
}

function decompress(buf: Buffer, enc: string): Buffer {
  const e = enc.trim().toLowerCase();
  try {
    if (e === 'gzip' || e === 'x-gzip') return zlib.gunzipSync(buf);
    if (e === 'deflate') { try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); } }
    if (e === 'br') return zlib.brotliDecompressSync(buf);
    if (e === 'zstd' && 'zstdDecompressSync' in zlib) return (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync(buf);
  } catch { /* leave as is */ }
  return buf;
}

interface Hop { status: number; statusText: string; httpVersion: string; headers: [string, string][]; raw: Buffer; truncated: boolean; ttfb: number }

function once(url: URL, method: string, headers: [string, string][], body: Buffer | undefined, insecure: boolean, deadline: number, started: number): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const outHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of headers) {
      const key = k.trim();
      if (!key) continue;
      const prev = outHeaders[key];
      outHeaders[key] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    const has = (n: string) => Object.keys(outHeaders).some((k) => k.toLowerCase() === n);
    if (!has('user-agent')) outHeaders['User-Agent'] = 'vibrato';
    if (!has('accept')) outHeaders.Accept = '*/*';
    if (!has('accept-encoding')) outHeaders['Accept-Encoding'] = 'gzip, deflate, br';
    if (body && !has('content-length')) outHeaders['Content-Length'] = String(body.length);
    let ttfb = 0;
    const req = lib.request(url, { method, headers: outHeaders, rejectUnauthorized: !insecure, timeout: Math.max(1, deadline - Date.now()) }, (res) => {
      ttfb = Date.now() - started;
      const chunks: Buffer[] = [];
      let size = 0, truncated = false;
      res.on('data', (c: Buffer) => {
        if (truncated) return;
        size += c.length;
        if (size > MAX_BODY) { truncated = true; chunks.push(c.subarray(0, c.length - (size - MAX_BODY))); res.destroy(); return; }
        chunks.push(c);
      });
      const done = () => {
        const raw = res.rawHeaders;
        const pairs: [string, string][] = [];
        for (let i = 0; i < raw.length; i += 2) pairs.push([raw[i], raw[i + 1]]);
        resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', httpVersion: res.httpVersion, headers: pairs, raw: Buffer.concat(chunks), truncated, ttfb });
      };
      res.on('end', done);
      res.on('close', () => { if (truncated) done(); });
      res.on('error', (e) => { if (!truncated) reject(e); });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body && method !== 'GET' && method !== 'HEAD') req.write(body);
    req.end();
  });
}

export async function proxyHttp(r: ProxyRequest): Promise<ProxyResponse | ProxyFailure> {
  const started = Date.now();
  try {
    let url: URL;
    try { url = new URL(r.url.trim()); } catch { throw Object.assign(new Error('Invalid URL'), { code: 'EINVAL' }); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Object.assign(new Error('Only http and https URLs'), { code: 'EINVAL' });
    let method = (r.method || 'GET').toUpperCase();
    if (!/^[A-Z]+$/.test(method)) throw Object.assign(new Error('Invalid method'), { code: 'EINVAL' });
    let headers = r.headers ?? [];
    let body: Buffer | undefined = r.bodyBase64 ? Buffer.from(r.bodyBase64, 'base64') : r.body !== undefined && r.body !== '' ? Buffer.from(r.body, 'utf8') : undefined;
    const deadline = started + Math.min(Math.max(r.timeoutMs ?? 30000, 1000), 300000);
    const redirects: { status: number; url: string }[] = [];
    for (;;) {
      const hop = await once(url, method, headers, body, !!r.insecure, deadline, started);
      const loc = hop.headers.find(([k]) => k.toLowerCase() === 'location')?.[1];
      if (r.followRedirects && loc && [301, 302, 303, 307, 308].includes(hop.status) && redirects.length < 10) {
        redirects.push({ status: hop.status, url: url.toString() });
        const next = new URL(loc, url);
        // Same rules as browsers: 303 always, 301/302 for POST, become a body-less GET.
        if (hop.status === 303 || ((hop.status === 301 || hop.status === 302) && method === 'POST')) {
          method = method === 'HEAD' ? 'HEAD' : 'GET'; body = undefined;
          headers = headers.filter(([k]) => !/^content-(type|length)$/i.test(k));
        }
        if (next.origin !== url.origin) headers = headers.filter(([k]) => !/^(authorization|cookie)$/i.test(k));
        url = next;
        continue;
      }
      const ct = hop.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
      const ce = hop.headers.find(([k]) => k.toLowerCase() === 'content-encoding')?.[1] ?? '';
      const plain = hop.truncated ? hop.raw : decompress(hop.raw, ce);
      return {
        ok: true, status: hop.status, statusText: hop.statusText, httpVersion: hop.httpVersion, url: url.toString(), headers: hop.headers,
        ...decodeBody(plain, ct), size: plain.length, wireSize: hop.raw.length, truncated: hop.truncated,
        timing: { ttfb: hop.ttfb, total: Date.now() - started }, redirects,
      };
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { ok: false, error: e.message || String(err), code: e.code, timing: { total: Date.now() - started } };
  }
}

export interface NetInterface { name: string; address: string; family: 'IPv4' | 'IPv6'; internal: boolean; mac: string; cidr: string | null }

export function netInfo(): { hostname: string; interfaces: NetInterface[]; lan: string | null } {
  const out: NetInterface[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) out.push({ name, address: a.address, family: a.family === 'IPv6' || (a.family as unknown) === 6 ? 'IPv6' : 'IPv4', internal: a.internal, mac: a.mac, cidr: a.cidr });
  }
  // Wi-Fi/Ethernet first (en*), then anything else that is not loopback, link-local or a VPN tunnel.
  const v4 = out.filter((i) => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
  const lan = (v4.find((i) => /^en\d/.test(i.name)) ?? v4.find((i) => !/^(utun|bridge|vmnet|vboxnet|docker)/.test(i.name)) ?? v4[0])?.address ?? null;
  return { hostname: os.hostname(), interfaces: out, lan };
}

export interface ListeningPort { pid: number; command: string; user: string; address: string; port: number; cwd: string | null; self: boolean }

/** Listening TCP ports (os/net.ts); `self` marks this server and the app that launched it. */
export async function listeningPorts(): Promise<ListeningPort[]> {
  return (await listListeners()).map((p) => ({ ...p, self: p.pid === process.pid || p.pid === process.ppid }));
}

/** Stops a process that holds a port. Refuses this server and the app that launched it. */
export function killProcess(pid: number, force: boolean): void {
  if (!Number.isInteger(pid) || pid <= 1) throw Object.assign(new Error('Invalid pid'), { status: 400 });
  if (pid === process.pid || pid === process.ppid) throw Object.assign(new Error('That is Vibrato itself'), { status: 400 });
  process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
}
