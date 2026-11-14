import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

// The host keeps its identity and settings in VIBRATO_CONFIG_DIR, read when config.ts loads: set it first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibrato-remote-'));
process.env.VIBRATO_CONFIG_DIR = dir;

const { AuthLimiter, addressKey, generateCode, normalizeCode, encodeFrame, encodeFrameAsync, FrameReader, agreeCaps, slimForRemote, queueMessage, REMOTE_TEXT_MAX } = await import('../server/remote/protocol.cjs');
const { RemoteConnection, RemoteClientError } = await import('../server/remote/client.cjs');
const { RemoteHost } = await import('../server/remote/host.js');
const { ReplayBuffer, SessionRegistry } = await import('../server/sessions.js');

const port = 30000 + Math.floor(Math.random() * 20000);
let registry: InstanceType<typeof SessionRegistry>;
let host: InstanceType<typeof RemoteHost>;
let code = '';
const password = 'pa55 word';

before(async () => {
  registry = new SessionRegistry();
  host = new RemoteHost(registry);
  // No caffeinate from tests: neither the keep-awake assertion nor waking the display on login.
  const r = await host.configure({ port, keepAwake: false, wakeOnConnect: false });
  code = r.code!;
  await assert.rejects(host.configure({ enabled: true }), /password first/, 'two factors: no turning on without a password');
  await assert.rejects(host.setPassword('123'), /4/);
  await host.setPassword(password);
  await host.configure({ enabled: true });
});

after(async () => {
  await host.stop();
  await registry.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

const login = (c: string, pinned: string | null = null, pw: string | undefined = password) => {
  const conn = new RemoteConnection();
  return conn.connect({ address: '127.0.0.1', port, code: c, password: pw, pinned }).then((r) => ({ conn, ...r }));
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
    // Nothing outside the session methods: no files, no shell, no deleting or renaming conversations.
    for (const m of ['fs.read', 'history.delete', 'delete', 'rename', 'pin', 'pty', 'settings']) await assert.rejects(conn.call(m, { path: '/etc/passwd', id: 'x' }), /Unknown method/);
    assert.ok(conn.caps.has('batch') && conn.caps.has('deflate'), 'both optional features agreed');
    // Models and usage are read-only lookups; a model id that could become a CLI flag is refused.
    assert.ok(Array.isArray(await conn.call('models', { agent: 'codex' })));
    await assert.rejects(conn.call('start', { agent: 'claude', cwd: os.tmpdir(), model: '--dangerously-skip-permissions' }), /Bad model/);
    await assert.rejects(conn.call('model', { sessionId: 'nope', model: 'sonnet' }), /gone/);
    await assert.rejects(conn.call('start', { agent: 'claude', cwd: 'relative/dir' }), /absolute/);
    await assert.rejects(conn.call('send', { sessionId: 'nope', text: 'hi' }), /gone/);
    assert.equal((await host.status()).clients.length, 1);
  } finally { conn.close(); }
});

test('a pinned fingerprint that does not match is refused before login', async () => {
  await assert.rejects(login(code, 'AA:BB'), (e: unknown) => e instanceof RemoteClientError && e.code === 'FINGERPRINT_MISMATCH' && !!e.extra.fingerprint);
});

test('the password is the second factor: missing is asked for, wrong is refused like a wrong code', async () => {
  await assert.rejects(login(code, null, ''), (e: unknown) => e instanceof RemoteClientError && e.code === 'NEED_PASSWORD');
  await assert.rejects(login(code, null, 'PA55 WORD'), (e: unknown) => e instanceof RemoteClientError && e.code === 'DENIED' && e.extra.reason === 'code', 'case counts in the password');
  const ok = await login(code.toLowerCase());
  ok.conn.close();
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

test('frames: compressed, split into tiny reads, read back the same', () => {
  const big = { t: 'events', messages: Array.from({ length: 300 }, (_, i) => ({ sessionId: 's', seq: i + 1, ts: 0, event: { kind: 'text.delta', text: 'hello world '.repeat(20), parent: null } })) };
  const plain = encodeFrame(big);
  const packed = encodeFrame(big, true);
  assert.ok(packed.length < plain.length / 5, `compressed ${packed.length} vs ${plain.length}`);
  const got: unknown[] = [];
  const r = new FrameReader((m: unknown) => got.push(m), (e: Error) => { throw e; }, () => 16 * 1024 * 1024, () => true);
  const stream = Buffer.concat([plain, packed, encodeFrame({ t: 'pong' }, true)]);
  for (let i = 0; i < stream.length; i += 7) r.push(stream.subarray(i, i + 7));
  assert.deepEqual(got, [big, big, { t: 'pong' }]);
  // A compressed frame where none was agreed is an error.
  let err = '';
  new FrameReader(() => {}, (e: Error) => { err = e.message; }, () => 1 << 20).push(packed);
  assert.match(err, /bad frame/);
});

test('frames: a big compressed frame is inflated off the main thread and later frames keep their order', async () => {
  const crypto = await import('node:crypto');
  const big = { t: 'events', blob: crypto.randomBytes(300_000).toString('base64') };
  const packed = await encodeFrameAsync(big, true);
  assert.deepEqual(packed, encodeFrame(big, true), 'async encoding writes the same bytes');
  assert.ok(packed.length > 64 * 1024 && (packed.readUInt32BE(0) & 0x80000000) !== 0, 'big enough to go async, and compressed');
  const got: unknown[] = [];
  let done!: () => void;
  const all = new Promise<void>((r) => { done = r; });
  const r = new FrameReader((m: unknown) => { got.push(m); if (got.length === 4) done(); }, (e: Error) => { throw e; }, () => 16 * 1024 * 1024, () => true);
  r.push(Buffer.concat([encodeFrame({ n: 1 }), packed, encodeFrame({ n: 2 }), encodeFrame({ n: 3, pad: 'x'.repeat(5000) }, true)]));
  assert.deepEqual(got, [{ n: 1 }], 'frames after the big one wait for it');
  await all;
  assert.deepEqual(got, [{ n: 1 }, big, { n: 2 }, { n: 3, pad: 'x'.repeat(5000) }]);
});

test('caps: only features both sides list', () => {
  assert.deepEqual([...agreeCaps(['deflate', 'teleport'])], ['deflate']);
  assert.deepEqual([...agreeCaps(undefined)], [], 'an older peer sends none');
});

test('events for the remote tab: stream pieces merged, tool output dropped, long inputs cut', () => {
  const m = (seq: number, event: Record<string, unknown>) => ({ sessionId: 's', seq, ts: seq, event: event as { kind: string } });
  const q: ReturnType<typeof m>[] = [];
  queueMessage(q, m(1, { kind: 'text.delta', text: 'Hel', parent: null }));
  queueMessage(q, m(2, { kind: 'text.delta', text: 'lo', parent: null }));
  queueMessage(q, m(3, { kind: 'text.delta', text: '!', parent: 'task' }));
  queueMessage(q, m(5, { kind: 'text.delta', text: '?', parent: 'task' }));
  assert.deepEqual(q.map((x) => [x.seq, (x.event as { text: string }).text]), [[2, 'Hello'], [3, '!'], [5, '?']], 'merged only when contiguous, same parent');
  assert.equal(slimForRemote(m(6, { kind: 'tool.output', toolUseId: 't', chunk: 'x' })), null);
  const r = slimForRemote(m(7, { kind: 'tool.result', toolUseId: 't', content: 'y'.repeat(REMOTE_TEXT_MAX + 50), isError: false, parent: null }))!;
  assert.ok((r.event as { content: string }).content.length < REMOTE_TEXT_MAX + 30);
  const w = slimForRemote(m(8, { kind: 'tool.start', toolUseId: 't', name: 'Write', input: { file_path: '/a', content: 'z'.repeat(50_000) }, parent: null }))!;
  assert.equal(((w.event as { input: { file_path: string } }).input).file_path, '/a');
  const a = slimForRemote(m(9, { kind: 'approval.request', requestId: 'r', toolUseId: null, toolName: 'Write', input: { content: 'z'.repeat(50_000) }, canAlwaysAllow: true }))!;
  assert.equal(((a.event as { input: { content: string } }).input).content.length, 50_000, 'approval cards keep the whole input');
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
  assert.ok(err instanceof RemoteClientError && err.code === 'KICKED', 'told it was closed on purpose, so it does not reconnect');
  const again = await login(code);
  again.conn.close();
});

test('discord notices: only discord webhook URLs, masked, no mentions, and lockouts are reported', async () => {
  const { validWebhook, maskWebhook, sendDiscord, noticeMessage } = await import('../server/remote/notify.js');
  const url = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123';
  assert.ok(validWebhook(url));
  for (const bad of ['http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', 'https://evil.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', 'https://discord.com.evil.com/api/webhooks/1/x']) assert.equal(validWebhook(bad), false, bad);
  assert.equal(maskWebhook(url), 'discord.com/api/webhooks/1234…/abcd••••');
  let sent: { url: string; body: { content: string; allowed_mentions: unknown } } | null = null;
  await sendDiscord(url, noticeMessage({ kind: 'login', address: '203.0.113.7 @everyone', at: 0, ok: true }), async (u, init) => { sent = { url: u, body: JSON.parse(init.body) }; return { ok: true, status: 204 }; });
  assert.equal(sent!.url, url);
  assert.deepEqual(sent!.body.allowed_mentions, { parse: [] });
  assert.ok(!sent!.body.content.includes('@everyone') && sent!.body.content.startsWith('MAC_LOGIN\n\nIP: 203.0.113.7'));
  await assert.rejects(sendDiscord(url, 'x', async () => ({ ok: false, status: 404 })), /404/);
  // The limiter says when a failure locked an address, so the host can report it.
  const l = new AuthLimiter();
  let verdict = { lockedMs: null as number | null, globalLockMs: null as number | null };
  for (let i = 0; i < 5; i++) { l.begin('z', 0); verdict = l.end('z', false, 0); }
  assert.equal(verdict.lockedMs, 30_000);
});

test('notices: MAC_LOGIN for successes and failures, MAC_LOGOUT clean or dropped, in the agreed format', async () => {
  const sent: string[] = [];
  host.sendNotice = async (_u, content) => { sent.push(content); };
  await host.setWebhook('https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123');
  const settle = () => new Promise((r) => setTimeout(r, 150));
  const a = await login(code);
  await settle();
  a.conn.close();                                   // says bye: a clean logout
  await settle(); await settle();
  await assert.rejects(login(code, null, 'wrong pw'));
  await assert.rejects(login(code, null, 'wrong pw')); // same address within a minute: not sent again
  const b = await login(code);
  await settle();
  (b.conn as unknown as { socket: import('node:tls').TLSSocket }).socket.destroy(); // the link drops
  await settle(); await settle();
  const form = /^MAC_(LOGIN|LOGOUT)\n\nIP: [\d.:a-f]+\n시간: \d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}\n성공여부: (성공|실패)$/;
  for (const m of sent) assert.match(m, form);
  assert.deepEqual(sent.map((m) => `${m.split('\n')[0]} ${m.split('성공여부: ')[1]}`), ['MAC_LOGIN 성공', 'MAC_LOGOUT 성공', 'MAC_LOGIN 실패', 'MAC_LOGIN 성공', 'MAC_LOGOUT 실패']);
  host.sendNotice = async () => {};
});

test('keep-awake on battery: on unless turned off, saved with the other settings', async () => {
  assert.equal((await host.status()).keepAwakeOnBattery, true, 'absent means on (as before the setting existed)');
  await host.configure({ keepAwakeOnBattery: false });
  const st = await host.status();
  assert.equal(st.keepAwakeOnBattery, false);
  assert.equal(st.keepAwake, false, 'the tests keep caffeinate off');
  assert.equal(st.awake, false);
  await host.configure({ keepAwakeOnBattery: true });
  assert.equal((await host.status()).keepAwakeOnBattery, true);
});

test('webhook setting: rejects other URLs, status shows it masked only', async () => {
  await assert.rejects(host.setWebhook('https://example.com/hook'), /Discord webhook/);
  await host.setWebhook('https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123');
  const st = await host.status();
  assert.equal(st.webhook, 'discord.com/api/webhooks/1234…/abcd••••');
  assert.ok(!JSON.stringify(st).includes('abcdefghijklmnopqrstuvwxyz'), 'the full URL never leaves the server');
  await host.setWebhook(null);
  assert.equal((await host.status()).webhook, null);
});

test('a message sent through the remote host keeps its origin in the chat (plan view chip)', async () => {
  const { reduceEvent } = await import('../web/src/lib/chatStore.js');
  const base = { id: 's', agent: 'claude' as const, cwd: '/', permissionMode: 'default' as const, status: 'idle' as const, items: [], totalCostUsd: 0, lastSeq: 0 };
  const next = reduceEvent(base, { kind: 'user', text: 'hi', attachments: [], messageId: 'm1', remote: { address: '203.0.113.7', at: 1700000000000 } }, 1);
  assert.deepEqual((next.items[0] as { remote?: unknown }).remote, { address: '203.0.113.7', at: 1700000000000 });
  const local = reduceEvent(base, { kind: 'user', text: 'hi', attachments: [], messageId: 'm2' }, 1);
  assert.equal((local.items[0] as { remote?: unknown }).remote, undefined);
});

test('an hour without remote activity logs the client out; automatic refreshes do not count', async () => {
  const { conn } = await login(code);
  const lost = new Promise<unknown>((r) => conn.once('close', r));
  const t0 = Date.now();
  await conn.call('sessions');                         // the app refreshing its list: not activity
  host.logoutIdle(t0 + 30 * 60_000);
  await conn.call('history', { cwd: os.tmpdir() });    // opening a project: activity
  const acted = Date.now();
  host.logoutIdle(acted + 59 * 60_000);                // 59 minutes after that: still in
  assert.equal((await host.status()).clients.length, 1);
  host.logoutIdle(acted + 60 * 60_000);
  const err = await lost;
  assert.ok(err instanceof RemoteClientError && err.code === 'KICKED' && err.extra.reason === 'idle');
});

test('remote list titles survive a long answer and skip turns the CLI injects', async () => {
  const reg = new SessionRegistry() as unknown as { entries: Map<string, unknown>; broadcast: (e: unknown, ev: unknown) => void; summaries: () => { title: string }[]; closeAll: () => Promise<void> };
  const entry = { session: { id: 'T1', agent: 'claude', cwd: os.tmpdir(), onEvent: () => () => {}, close: async () => {} }, buffer: new ReplayBuffer(), seq: 0, subscribers: new Set(), createdAt: Date.now(), lastActivity: Date.now(), running: false, closed: false, touched: false, sendChain: Promise.resolve(), turnPaths: new Set(), turnShell: false };
  reg.entries.set('T1', entry);
  reg.broadcast(entry, { kind: 'user', text: 'This session is being continued from a previous conversation that ran out of context.', attachments: [] });
  reg.broadcast(entry, { kind: 'user', text: '<task-notification>done</task-notification>', attachments: [] });
  assert.equal(reg.summaries()[0].title, '');
  reg.broadcast(entry, { kind: 'user', text: '\n  Refactor the auth module\nand add tests', attachments: [] });
  for (let i = 0; i < 6000; i++) reg.broadcast(entry, { kind: 'text.delta', text: 'tok ', parent: null });
  assert.equal(reg.summaries()[0].title, 'Refactor the auth module');
  await reg.closeAll();
});
