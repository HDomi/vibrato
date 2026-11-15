import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectScripts } from '../server/runner';

test('runner: scripts listed dev-first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibrato-run-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'x', dev: 'vite', test: 'y', predev: 'z' } }));
    const { scripts } = await projectScripts(dir);
    assert.deepEqual(scripts.map((s) => s.command), ['npm run dev', 'npm run lint', 'npm test']);

  } finally { rmSync(dir, { recursive: true, force: true }); }
});
