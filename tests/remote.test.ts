import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

// The host keeps its identity and settings in VIBRATO_CONFIG_DIR, read when config.ts loads: set it first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibrato-remote-'));
process.env.VIBRATO_CONFIG_DIR = dir;

const { AuthLimiter, addressKey, generateCode, normalizeCode, encodeFrame } = await import('../server/remote/protocol.cjs');
const { RemoteConnection, RemoteClientError } = await import('../server/remote/client.cjs');
const { RemoteHost } = await import('../server/remote/host.js');
const { SessionRegistry } = await import('../server/sessions.js');

const port = 30000 + Math.floor(Math.random() * 20000);
let registry: InstanceType<typeof SessionRegistry>;
let host: InstanceType<typeof RemoteHost>;
let code = '';

before(async () => {
  registry = new SessionRegistry();
  host = new RemoteHost(registry);
  const r = await host.configure({ enabled: true, port });
  code = r.code!;
});

after(async () => {
  await host.stop();
  await registry.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

const login = (c: string, pinned: string | null = null) => {
  const conn = new RemoteConnection();
  return conn.connect({ address: '127.0.0.1', port, code: c, pinned }).then((r) => ({ conn, ...r }));
};

test('access codes: 20 characters in groups, typed loosely', () => {
  const c = generateCode();
  assert.match(c, /^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/);
  assert.equal(normalizeCode(' abcde-fghjk '), 'ABCDEFGHJK');
});

test('address keys: IPv4 as is, IPv6 by /64', () => {
  assert.equal(addressKey('::ffff:10.0.0.5'), '10.0.0.5');
  assert.equal(addressKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:db8:1:2::9'), '2001:db8:1:2::/64');
  assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
});

test('limiter: five failures lock, then doubling; success clears', () => {
  const l = new AuthLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i++) { assert.equal(l.begin('a', t0), null); l.end('a', false, t0); }
  assert.equal(l.begin('a', t0), null);
  l.end('a', false, t0);
  assert.deepEqual(l.begin('a', t0 + 1000), { retryAfterMs: 29_000 });
  assert.equal(l.begin('a', t0 + 30_000), null);
  l.end('a', false, t0 + 30_000);
  assert.deepEqual(l.begin('a', t0 + 30_000), { retryAfterMs: 60_000 });
  assert.equal(l.begin('b', t0), null, 'other addresses are not affected');
  assert.deepEqual(l.begin('b', t0), { retryAfterMs: 1000 }, 'one login at a time per address');
  l.end('b', true, t0);
  assert.equal(l.begin('b', t0), null);
});

test('limiter: many failures across addresses refuse everyone for a while', () => {
  const l = new AuthLimiter();
  for (let i = 0; i < 21; i++) { assert.equal(l.begin(`x${i}`, 5000), null); l.end(`x${i}`, false, 5000); }
  assert.ok(l.begin('fresh', 5000));
  assert.equal(l.begin('fresh', 5000 + 30_000), null);
});

test('the host certificate names its curve (Electron\'s BoringSSL rejects explicit parameters)', async () => {
  const { loadIdentity, namedCurve } = await import('../server/remote/identity.js');
  assert.equal(namedCurve((await loadIdentity()).cert), true);
});

test('login with the code, calls work, fingerprint is the host certificate', async () => {
  const { conn, fingerprint, hostName } = await login(code);
  try {
    assert.equal(fingerprint, (await host.status()).fingerprint);
    assert.equal(hostName, os.hostname());
    assert.deepEqual(await conn.call('sessions'), []);
    const info = await conn.call<{ host: string; home: string }>('info');
    assert.equal(info.home, os.homedir());
    await assert.rejects(conn.call('fs.read', { path: '/etc/passwd' }), /Unknown method/);
    await assert.rejects(conn.call('start', { agent: 'claude', cwd: 'relative/dir' }), /absolute/);
    await assert.rejects(conn.call('send', { sessionId: 'nope', text: 'hi' }), /gone/);
    assert.equal((await host.status()).clients.length, 1);
  } finally { conn.close(); }
});

test('a pinned fingerprint that does not match is refused before login', async () => {
  await assert.rejects(login(code, 'AA:BB'), (e: unknown) => e instanceof RemoteClientError && e.code === 'FINGERPRINT_MISMATCH' && !!e.extra.fingerprint);
});

test('wrong codes are refused and lock the address after five', async () => {
  for (let i = 0; i < 5; i++) {
    await assert.rejects(login('WRONG-CODE-XXXXX-YYYYY'), (e: unknown) => e instanceof RemoteClientError && e.code === 'DENIED' && e.extra.reason === 'code');
  }
  // Locked: even the right code is refused now.
  await assert.rejects(login(code), (e: unknown) => e instanceof RemoteClientError && e.code === 'DENIED' && e.extra.reason === 'locked' && (e.extra.retryAfterMs ?? 0) > 0);
});

test('a big frame before login drops the connection', async () => {
  const sock = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
  await new Promise<void>((r) => sock.once('secureConnect', () => r()));
  const closed = new Promise<void>((r) => sock.once('close', () => r()));
  sock.on('error', () => {});
  sock.write(encodeFrame({ t: 'hello', v: 1, pad: 'x'.repeat(10_000) }));
  await closed;
});

test('a new code drops connected clients', async () => {
  // The previous test locked 127.0.0.1; a fresh host has a fresh limiter.
  await host.stop();
  host = new RemoteHost(registry);
  await host.apply();
  const { conn } = await login(code);
  const lost = new Promise<unknown>((r) => conn.once('close', r));
  code = await host.newCode();
  const err = await lost;
  assert.ok(err instanceof RemoteClientError && err.code === 'CLOSED');
  const again = await login(code);
  again.conn.close();
});
