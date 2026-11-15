import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runVerify } from '../server/verify';

test('verify runner (cmd.exe): exit code, output tail, cancel', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibrato-verify-'));
  try {
    const ok = await runVerify(dir, 'echo fine& cd').done;
    assert.equal(ok.exitCode, 0);
    assert.match(ok.output, /^fine\r?\n/);
    assert.ok(ok.output.toLowerCase().endsWith(dir.split(/[\\/]/).pop()!.toLowerCase()), ok.output);

    const bad = await runVerify(dir, '(for /L %i in (1,1,1000) do @echo %i)& echo boom 1>&2& exit /b 3').done;
    assert.equal(bad.exitCode, 3);
    assert.ok(bad.output.trimEnd().endsWith('boom'));
    assert.ok(!bad.output.includes('\n1\n'), 'only the tail is kept');

    const slow = runVerify(dir, 'ping -n 30 127.0.0.1 >nul');
    setTimeout(slow.cancel, 300);
    const r = await slow.done;
    assert.equal(r.cancelled, true);
    assert.ok(r.durationMs < 10000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
