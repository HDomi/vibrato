import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listRuns, removeRun, startRun, stopRun, subscribeRun, type RunLine } from '../server/runner';

const until = async (cond: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); } };

test('runner (cmd.exe): output and URL captured, stop kills the group, a restart waits for the old process', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibrato-run-'));
  try {
    const info = await startRun(dir, 'srv', 'echo   Local: http://0.0.0.0:5173/& echo oops 1>&2& ping -n 30 127.0.0.1 >nul');
    const lines: RunLine[] = [];
    let url: string | null = null; let status = 'running';
    const off = subscribeRun(info.id, -1, { line: (l) => lines.push(l), info: (i) => { url = i.url; status = i.status; }, removed: () => {} })!;
    await until(() => lines.length >= 2 && !!url);
    assert.equal(url, 'http://localhost:5173/');
    assert.deepEqual(lines.map((l) => [l.text.trim(), l.err]), [['Local: http://0.0.0.0:5173/', false], ['oops', true]]);
    assert.equal(listRuns(dir).length, 1);
    stopRun(info.id);
    await until(() => status === 'exited');
    off();
    // A late subscriber gets the backlog after its cursor.
    const late: RunLine[] = [];
    subscribeRun(info.id, 0, { line: (l) => late.push(l), info: () => {}, removed: () => {} });
    assert.deepEqual(late.map((l) => l.n), [1]);
    await removeRun(info.id);
    assert.equal(listRuns(dir).length, 0);

    // Restarting a script waits until the old process is gone (it may still hold the port).
    const a = await startRun(dir, 'dev', 'ping -n 30 127.0.0.1 >nul');
    let aExited = false;
    subscribeRun(a.id, -1, { line: () => {}, info: (i) => { if (i.status === 'exited') aExited = true; }, removed: () => {} });
    await new Promise((r) => setTimeout(r, 500));
    const b = await startRun(dir, 'dev', 'ping -n 30 127.0.0.1 >nul');
    assert.equal(aExited, true, 'old process exited before the new one started');
    assert.deepEqual(listRuns(dir).map((r) => r.id), [b.id]);
    await removeRun(b.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
