import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLockWatch, deps, lockBeat, lockWatchState } from '../server/lockWatch';

const EXE = '/Applications/Vibrato.app/Contents/MacOS/Vibrato';
const BUNDLE = '/Applications/Vibrato.app';

function fake(exe: string | null = EXE) {
  const calls = { killed: [] as number[], reopened: [] as string[] };
  let clock = 1_000_000;
  deps.now = () => clock;
  deps.exeOf = async () => exe;
  deps.kill = (pid) => { calls.killed.push(pid); };
  deps.reopen = (b) => { calls.reopened.push(b); };
  deps.log = () => {};
  const advance = async (ms: number) => { for (let t = 0; t < ms; t += 5000) { clock += 5000; await checkLockWatch(); } };
  return { calls, advance };
}

test('a hung app is killed only after the timeout, then reopened', async (t) => {
  t.after(() => lockBeat({ active: false }));
  const { calls, advance } = fake();
  assert.deepEqual(lockBeat({ active: true, pid: 4242, exe: EXE, bundle: BUNDLE, timeoutMs: 40000 }), { ok: true });
  await advance(35000);
  assert.deepEqual(calls.killed, []);
  await advance(10000);
  assert.deepEqual(calls.killed, [4242]);
  assert.equal(lockWatchState(), null);
  await new Promise((r) => setTimeout(r, 1600));
  assert.deepEqual(calls.reopened, [BUNDLE]);
});

test('regular beats and an unlock keep the app alive', async (t) => {
  t.after(() => lockBeat({ active: false }));
  const { calls, advance } = fake();
  for (let i = 0; i < 10; i++) { lockBeat({ active: true, pid: 4242, exe: EXE, bundle: BUNDLE }); await advance(10000); }
  assert.deepEqual(calls.killed, []);
  lockBeat({ active: false });
  await advance(120000);
  assert.deepEqual(calls.killed, []);
});

test('a reused pid running another program is left alone', async (t) => {
  t.after(() => lockBeat({ active: false }));
  const { calls, advance } = fake('/usr/bin/some-other-tool');
  lockBeat({ active: true, pid: 4242, exe: EXE, bundle: BUNDLE });
  await advance(60000);
  assert.deepEqual(calls.killed, []);
});

test('time spent asleep does not count as a hang', async (t) => {
  t.after(() => lockBeat({ active: false }));
  const { calls } = fake();
  lockBeat({ active: true, pid: 4242, exe: EXE, bundle: BUNDLE });
  deps.now = (() => { const base = deps.now(); return () => base + 3600_000; })(); // woke up an hour later
  await checkLockWatch();
  assert.deepEqual(calls.killed, []);
  assert.ok(lockWatchState());
});

test('beats are validated; a bundle is only reopened when the executable lives inside it', async (t) => {
  t.after(() => lockBeat({ active: false }));
  const { calls, advance } = fake('/usr/local/bin/electron');
  assert.equal(lockBeat({ active: true, pid: 1, exe: EXE }).ok, false);
  assert.equal(lockBeat({ active: true, pid: 4242, exe: 'relative/path' }).ok, false);
  assert.equal(lockBeat({ active: true, pid: 4242, exe: '/usr/local/bin/electron', bundle: '/Applications/Terminal.app' }).ok, true);
  await advance(60000);
  assert.deepEqual(calls.killed, [4242]);
  await new Promise((r) => setTimeout(r, 1600));
  assert.deepEqual(calls.reopened, []);
});
