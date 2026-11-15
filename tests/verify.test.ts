import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { suggestVerifyCommands } from '../server/verify';

test('verify suggestions follow the project kind and package manager', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vibrato-verify-'));
  try {
    assert.deepEqual(await suggestVerifyCommands(dir), []);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', test: 'node --test', lint: 'eslint .' } }));
    assert.deepEqual((await suggestVerifyCommands(dir)).slice(0, 3), ['npm run typecheck && npm test', 'npm run typecheck', 'npm run lint']);
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    assert.equal((await suggestVerifyCommands(dir))[0], 'pnpm typecheck && pnpm test');
    await writeFile(join(dir, 'Cargo.toml'), '');
    assert.ok((await suggestVerifyCommands(dir)).includes('cargo check'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('run log error blocks: stack frames grouped, false positives skipped', async () => {
  const { findErrors, isErrorLine } = await import('../web/src/lib/runLog');
  const text = [
    'VITE v5 ready in 300 ms', '  ➜  Local:   http://localhost:5173/', 'Found 0 errors. Watching for file changes.',
    '[vite] Internal server error: Transform failed', '  src/App.tsx:3:7', '    at foo (x.js:1:1)', '',
    'hmr update /src/App.tsx', 'TypeError: Cannot read properties of undefined', '    at bar (y.js:2:2)',
  ];
  const lines = text.map((t, n) => ({ n, text: t, err: false }));
  const blocks = findErrors(lines);
  assert.deepEqual(blocks.map((b) => [b.start, b.lines.length]), [[3, 3], [8, 2]]);
  assert.deepEqual(findErrors(lines, 7).map((b) => b.start), [8]);
  assert.equal(isErrorLine('import ErrorBoundary from "./ErrorBoundary"'), false);
});
