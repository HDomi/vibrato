import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runVerify } from '../server/verify';

test('verify runner: exit code, output tail without colour codes, cancel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibrato-verify-'));
  try {
    const ok = await runVerify(dir, 'printf "\\033[32mfine\\033[0m\\n"; pwd').done;
    assert.equal(ok.exitCode, 0);
    assert.match(ok.output, /^fine\n/);
    assert.ok(ok.output.endsWith(dir.split('/').pop()!), ok.output);

    const bad = await runVerify(dir, 'seq 1 1000; echo boom >&2; exit 3').done;
    assert.equal(bad.exitCode, 3);
    assert.ok(bad.output.endsWith('boom'));
    assert.ok(!bad.output.includes('\n1\n'), 'only the tail is kept');

    const slow = runVerify(dir, 'sleep 30');
    setTimeout(slow.cancel, 100);
    const r = await slow.done;
    assert.equal(r.cancelled, true);
    assert.ok(r.durationMs < 10000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
