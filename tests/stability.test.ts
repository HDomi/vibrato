import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir as makeDir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConfigStore } from '../server/config';
import { rejectReason } from '../server/guard';
import { createApp } from '../server/app';
import { gitCheckout, gitDiff, gitStage, gitStatus } from '../server/git';
import { mkdir, rawFile, readText, transfer } from '../server/fs';
import { attachWebSocket, ReplayBuffer, SessionRegistry } from '../server/sessions';
import { findProjectIcon } from '../server/icons';
import { reduceEvent, type ChatSession } from '../web/src/lib/chatStore';

async function temporary<T>(run: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-stability-'));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('HTTP guard rejects cross-site requests, opaque origins and DNS rebinding', async () => {
  const app = createApp();
  const valid = { host: '127.0.0.1:11398' };
  assert.equal(rejectReason(valid, 11398), null);
  for (const headers of [
    { ...valid, origin: 'https://evil.example' }, { ...valid, origin: 'null' },
    { ...valid, origin: 'http://127.0.0.1:9999' }, { ...valid, secFetchSite: 'cross-site' },
    { host: 'evil.example:11398', origin: 'http://evil.example:11398' },
  ]) assert.ok(rejectReason(headers, 11398));
  for (const path of ['/api/health', '/api/fs/raw?path=/etc/passwd', '/api/update/apply?force=1', '/api/tools/install?tool=claude']) {
    const res = await app.request(`http://127.0.0.1:11398${path}`, { headers: { ...valid, origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  }
  assert.equal((await app.request('http://127.0.0.1:11398/api/health', { headers: valid })).status, 200);
  assert.equal((await app.request('http://127.0.0.1:11398/api/open', { method: 'POST', headers: { ...valid, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
});

test('config writes serialize complete transactions and preserve damaged files', () => temporary(async (dir) => {
  const file = join(dir, 'config.json');
  const store = new ConfigStore(file);
  const first = await store.load(); first.recent.push('not saved');
  assert.deepEqual((await store.load()).recent, []);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.exclusive(async () => {
    const config = await store.load(); config.recent.push(String(i)); await store.save(config);
  })));
  assert.equal((await store.load()).recent.length, 20);
  await writeFile(file, '{damaged');
  await assert.rejects(store.load());
  assert.equal(await readFile(file, 'utf8'), '{damaged');
}));

test('Git protects clean tracked diffs, empty reset, option-like branches and fsmonitor hooks', () => temporary(async (dir) => {
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  assert.equal((await gitStatus(dir)).branch, 'main');
  await writeFile(join(dir, 'file.txt'), 'original\n'); git('add', '.'); git('commit', '-m', 'initial');
  git('config', 'core.fsmonitor', `touch ${join(dir, 'HOOK_EXECUTED')}`);
  await gitStatus(dir);
  await assert.rejects(readFile(join(dir, 'HOOK_EXECUTED')));
  assert.equal(await gitDiff(dir, 'file.txt', false), '');
  await writeFile(join(dir, 'file.txt'), 'staged\n'); git('add', 'file.txt');
  assert.equal(await gitDiff(dir, 'file.txt', false), '');
  await assert.rejects(gitStage(dir, [], 'reset'));
  assert.ok((await gitStatus(dir)).files.some((file) => file.staged));
  assert.equal((await gitCheckout(dir, '--force')).ok, false);
  await writeFile(join(dir, 'new.txt'), 'new file\n');
  assert.match(await gitDiff(dir, 'new.txt', false), /\+new file/);
}));

test('filesystem rejects non-files and path traversal, preserves same-folder moves and clamps ranges', () => temporary(async (dir) => {
  const file = join(dir, 'sample.txt'); await writeFile(file, 'hello');
  assert.deepEqual(await transfer([file], dir, true), [file]);
  assert.equal(await readFile(file, 'utf8'), 'hello');
  await assert.rejects(mkdir(dir, '../outside'));
  await assert.rejects(readText('/dev/zero'));
  await assert.rejects(rawFile('/dev/zero', undefined));
  const response = await rawFile(file, 'bytes=0-999');
  assert.equal(response.status, 206);
  assert.equal(await new Response(response.body).text(), 'hello');
  assert.equal(response.headers['Content-Range'], 'bytes 0-4/5');
  const html = join(dir, 'page.html'); await writeFile(html, '<script>alert(1)</script>');
  const raw = await rawFile(html, undefined);
  assert.match(raw.headers['Content-Security-Policy'], /sandbox/);
  await raw.body?.cancel();
}));

test('icon manifests and symlinks cannot expose files outside the project', () => temporary(async (dir) => {
  const project = join(dir, 'project'); await makeDir(project);
  await writeFile(join(dir, 'outside.svg'), '<svg/>');
  await writeFile(join(project, 'package.json'), JSON.stringify({ icon: '../outside.svg' }));
  await symlink(join(dir, 'outside.svg'), join(project, 'icon.svg'));
  assert.equal(await findProjectIcon(project), null);
}));

test('WebSocket malformed frames are harmless and failed starts carry request IDs', async () => {
  const wss = new EventEmitter();
  const ws = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, send: (data: string) => sent.push(JSON.parse(data)) });
  const sent: any[] = [];
  const registry = { start: async () => { throw new Error('CLI not found'); }, detachAll: () => {} };
  attachWebSocket(wss as any, registry as any);
  wss.emit('connection', ws);
  for (const message of ['null', '1', 'true', '"text"', '{bad']) ws.emit('message', message);
  ws.emit('message', JSON.stringify({ type: 'session.start', requestId: 'request-1', cwd: '/test', agent: 'claude' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [{ type: 'session.startFailed', requestId: 'request-1', requestCwd: '/test', message: 'CLI not found' }]);
});

test('attach acknowledges a known session before replay and reports unknown ones missing', async () => {
  const wss = new EventEmitter();
  const sent: any[] = [];
  const ws = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, send: (data: string) => sent.push(JSON.parse(data)) });
  const registry = new SessionRegistry();
  const buffer = new ReplayBuffer();
  buffer.push({ sessionId: 'live', seq: 1, ts: 0, event: { kind: 'status', status: 'idle' } });
  const entry = { session: { id: 'live', agent: 'claude', cwd: '/tmp' }, buffer, seq: 1, subscribers: new Set(), closed: false };
  (registry as any).entries.set('live', entry);
  attachWebSocket(wss as any, registry as any);
  wss.emit('connection', ws);
  ws.emit('message', JSON.stringify({ type: 'session.attach', sessionId: 'live', after: 0 }));
  ws.emit('message', JSON.stringify({ type: 'session.attach', sessionId: 'gone', after: 0 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.map((m) => m.type ?? m.event.kind), ['session.attached', 'status', 'session.missing']);
  (registry as any).entries.clear();
  await registry.closeAll();
});

test('a remembered session stops restoring on its first live event', () => {
  const s: ChatSession = { id: 's', cwd: '/tmp', agent: 'claude', permissionMode: 'default', status: 'idle', totalCostUsd: 0, lastSeq: 0, items: [], restoring: true };
  assert.equal(reduceEvent(s, { kind: 'session.init', sessionId: 's', agent: 'claude', cwd: '/tmp' }, 1).restoring, undefined);
});

test('dead registry sessions no longer block updates', async () => {
  const registry = new SessionRegistry();
  const entry = { session: { id: 'closed', agent: 'claude', cwd: '/tmp' }, buffer: new ReplayBuffer(), seq: 0, subscribers: new Set(), closed: false };
  (registry as any).entries.set('closed', entry);
  (registry as any).broadcast(entry, { kind: 'status', status: 'closed' });
  assert.deepEqual(registry.list(), []);
  (registry as any).entries.clear();
  await registry.closeAll();
});

test('shutdown does not tell clients their sessions are closed', async () => {
  const registry = new SessionRegistry();
  const sent: any[] = [];
  const ws = { readyState: 1, OPEN: 1, send: (data: string) => sent.push(JSON.parse(data)) };
  const entry = { session: { id: 'live', agent: 'claude', cwd: '/tmp' }, buffer: new ReplayBuffer(), seq: 0, subscribers: new Set([ws]), closed: false };
  (registry as any).entries.set('live', entry);
  (registry as any).closing = true;
  (registry as any).broadcast(entry, { kind: 'status', status: 'closed' });
  assert.deepEqual(sent, []);
  (registry as any).closing = false;
  (registry as any).broadcast(entry, { kind: 'status', status: 'closed' });
  assert.equal(sent.length, 1);
  (registry as any).entries.clear();
  await registry.closeAll();
});

test('session.started is sent before synchronous adapter initialization events', async () => {
  const wss = new EventEmitter();
  const sent: any[] = [];
  const ws = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, send: (data: string) => sent.push(JSON.parse(data)) });
  const session = { id: 'new', start: () => ws.send(JSON.stringify({ event: { kind: 'session.init' } })) };
  attachWebSocket(wss as any, { start: async () => session, detachAll: () => {} } as any);
  wss.emit('connection', ws);
  ws.emit('message', JSON.stringify({ type: 'session.start', requestId: 'new-request', cwd: '/test', agent: 'claude' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].type, 'session.started');
  assert.equal(sent[0].requestId, 'new-request');
  assert.equal(sent[1].event.kind, 'session.init');
});

test('command errors clear pending UI and mixed image/file replay keeps every attachment', () => {
  const session: ChatSession = { id: 's', cwd: '/tmp', agent: 'codex', permissionMode: 'default', status: 'running', totalCostUsd: 0, lastSeq: 5, turnStartedAt: 1, items: [{ kind: 'user', id: 'pending', text: 'hello', attachments: [], pending: true }] };
  const failed = reduceEvent(session, { kind: 'error', message: 'Unknown session' }, 0);
  assert.equal(failed.lastSeq, 5); assert.equal(failed.status, 'idle'); assert.equal(failed.turnStartedAt, undefined);
  assert.equal((failed.items[0] as any).pending, false);
  assert.equal(reduceEvent(session, { kind: 'error', command: 'session.mode', message: 'Invalid mode' }, 0).status, 'running');
  const replayed = reduceEvent({ ...session, items: [] }, { kind: 'user', text: 'hello\n\nAttached file paths:\n- /tmp/image.png\n- /tmp/report.pdf', attachments: [{ path: '/tmp/image.png', name: 'image.png', kind: 'image' }] }, 6);
  assert.equal((replayed.items[0] as any).text, 'hello');
  assert.equal((replayed.items[0] as any).attachments.length, 2);
});

import { gitCommitDiff, gitCommitFiles } from '../server/git';

test('commit file list covers root, rename and merge commits against the first parent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-git-show-'));
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    g('init', '-q', '-b', 'main');
    await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
    g('add', '.'); g('commit', '-q', '-m', 'root');
    const root = g('rev-parse', 'HEAD');
    assert.deepEqual(await gitCommitFiles(dir, root), [{ status: 'A', path: 'a.txt' }]);
    assert.match(await gitCommitDiff(dir, root, 'a.txt'), /\+one/);

    g('mv', 'a.txt', 'b.txt'); g('commit', '-q', '-m', 'rename');
    assert.deepEqual(await gitCommitFiles(dir, g('rev-parse', 'HEAD')), [{ status: 'R', oldPath: 'a.txt', path: 'b.txt' }]);

    g('checkout', '-q', '-b', 'side');
    await writeFile(join(dir, 'side.txt'), 'side\n'); g('add', '.'); g('commit', '-q', '-m', 'side');
    g('checkout', '-q', 'main');
    await writeFile(join(dir, 'main.txt'), 'main\n'); g('add', '.'); g('commit', '-q', '-m', 'main');
    g('merge', '-q', '--no-ff', '-m', 'merge', 'side');
    assert.deepEqual(await gitCommitFiles(dir, g('rev-parse', 'HEAD')), [{ status: 'A', path: 'side.txt' }]);

    await assert.rejects(gitCommitFiles(dir, '--output=/tmp/x'), /Invalid commit hash/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewind is answered per request and refused for agents without checkpoints', async () => {
  const wss = new EventEmitter();
  const sent: any[] = [];
  const ws = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, send: (data: string) => sent.push(JSON.parse(data)) });
  const calls: any[] = [];
  const claude = { rewindFiles: async (id: string, dry: boolean) => { calls.push([id, dry]); return { canRewind: true, filesChanged: ['/p/a.txt'] }; } };
  const codex = {};
  const registry = { get: (id: string) => (id === 'c' ? claude : id === 'x' ? codex : undefined), detachAll: () => {} };
  attachWebSocket(wss as any, registry as any);
  wss.emit('connection', ws);
  ws.emit('message', JSON.stringify({ type: 'session.rewind', sessionId: 'c', requestId: 'r1', messageId: 'm', dryRun: true }));
  ws.emit('message', JSON.stringify({ type: 'session.rewind', sessionId: 'x', requestId: 'r2', messageId: 'm' }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, [['m', true]]);
  assert.deepEqual(sent.find((m) => m.requestId === 'r1').result.filesChanged, ['/p/a.txt']);
  assert.equal(sent.find((m) => m.requestId === 'r2').result.canRewind, false);
});

test('the server echo of a sent message keeps the id the client chose', () => {
  const s: ChatSession = { id: 's', cwd: '/tmp', agent: 'claude', permissionMode: 'default', status: 'running', totalCostUsd: 0, lastSeq: 0, items: [{ kind: 'user', id: 'aaaaaaaa-0000-4000-8000-000000000001', text: 'same', attachments: [], pending: true }, { kind: 'user', id: 'b', text: 'same', attachments: [] }] };
  const next = reduceEvent(s, { kind: 'user', text: 'same', attachments: [], messageId: 'aaaaaaaa-0000-4000-8000-000000000001' }, 1);
  assert.equal(next.items.length, 2);
  assert.equal((next.items[0] as any).pending, undefined);
  assert.equal(next.items[0].id, 'aaaaaaaa-0000-4000-8000-000000000001');
});

test('turn changes list only what the session edited, unless it ran shell commands', () => temporary(async (dir) => {
  const { snapshot } = await import('../server/turns');
  const { execFileSync } = await import('node:child_process');
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  await writeFile(join(dir, 'mine.txt'), 'a\n'); await writeFile(join(dir, 'other.txt'), 'a\n');
  git('add', '.'); git('commit', '-qm', 'init');
  const turn = async (shell: boolean) => {
    const registry = new SessionRegistry();
    const sent: any[] = [];
    const entry: any = { session: { id: 's', agent: 'claude', cwd: dir }, buffer: new ReplayBuffer(), seq: 0, subscribers: new Set([{ readyState: 1, OPEN: 1, send: (m: string) => sent.push(JSON.parse(m)) }]), closed: false, touched: false, turnPaths: new Set(), turnShell: false };
    (registry as any).entries.set('s', entry);
    entry.turnBase = await snapshot(dir);
    (registry as any).broadcast(entry, { kind: 'tool.start', toolUseId: 't1', name: shell ? 'Bash' : 'Edit', input: shell ? { command: 'x' } : { file_path: join(dir, 'mine.txt') }, parent: null });
    await writeFile(join(dir, 'mine.txt'), `${Date.now()}\n`);
    // Another session in the same folder writes meanwhile.
    await writeFile(join(dir, 'other.txt'), `${Date.now()}\n`);
    await (registry as any).finishTurn(entry);
    (registry as any).entries.clear();
    await registry.closeAll();
    return sent.filter((m) => m.event?.kind === 'changes').flatMap((m) => m.event.files.map((f: any) => f.path)).sort();
  };
  assert.deepEqual(await turn(false), ['mine.txt']);
  assert.deepEqual(await turn(true), ['mine.txt', 'other.txt']);
}));
