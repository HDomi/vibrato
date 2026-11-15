import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('installed launcher safely represents quotes, backslashes and shell metacharacters', () => {
  const { launcherSource } = require('../scripts/create-app.cjs');
  const root = "/tmp/project ' \\ $(touch unwanted)";
  let loaded = '';
  new Function('require', launcherSource(root))((path: string) => { loaded = path; });
  assert.equal(loaded, join(root, 'dist/electron/main.cjs'));
});

for (const scenario of ['success', 'build-failure', 'checkout-conflict']) {
  test(`staged update ${scenario} preserves a consistent installation and cleans staging`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibe-update-'));
    const remote = join(dir, 'remote');
    const checkout = join(dir, "checkout ' $(touch UNWANTED)");
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      await mkdir(join(remote, 'scripts'), { recursive: true });
      await copyFile(resolve('scripts/apply-update.sh'), join(remote, 'scripts/apply-update.sh'));
      await writeFile(join(remote, '.gitignore'), 'node_modules/\ndist/\nweb/dist/\nruntime/\n');
      await writeFile(join(remote, 'payload.txt'), 'old source');
      await writeFile(join(remote, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
      git(remote, 'init', '-b', 'main'); git(remote, 'add', '.'); git(remote, 'commit', '-m', 'old');
      execFileSync('git', ['clone', '--quiet', remote, checkout]);
      for (const artifact of ['node_modules', 'dist', 'web/dist']) {
        await mkdir(join(checkout, artifact), { recursive: true });
        await writeFile(join(checkout, artifact, 'marker'), 'old build');
      }
      await writeFile(join(remote, 'payload.txt'), 'new source');
      git(remote, 'add', '.'); git(remote, 'commit', '-m', 'new');
      const before = git(checkout, 'rev-parse', 'HEAD');
      const expected = git(remote, 'rev-parse', 'HEAD');
      const bin = join(checkout, 'runtime/node/bin'); await mkdir(bin, { recursive: true });
      await writeFile(join(bin, 'npm'), '#!/bin/sh\nif [ "$1" = ci ]; then mkdir -p node_modules; echo "new build" > node_modules/marker; fi\nif [ "$1" = run ]; then\n  if [ "$VIBRATO_TEST_FAIL" = 1 ]; then exit 9; fi\n  mkdir -p dist web/dist; printf "new build" > dist/marker; printf "new build" > web/dist/marker\nfi\n', { mode: 0o755 });
      if (scenario === 'checkout-conflict') await writeFile(join(checkout, 'payload.txt'), 'local work');
      const env = { ...process.env, VIBRATO_TEST_FAIL: scenario === 'build-failure' ? '1' : '0' };
      delete env.VIBRATO_ELECTRON_EXEC_PATH; delete env.VIBRATO_ELECTRON_VERSION;
      const result = spawnSync('/bin/zsh', [join(checkout, 'scripts/apply-update.sh')], { env, encoding: 'utf8', timeout: 15000 });
      const success = scenario === 'success';
      assert.equal(result.status === 0, success, result.stdout + result.stderr);
      assert.equal(git(checkout, 'rev-parse', 'HEAD'), success ? expected : before);
      assert.equal(await readFile(join(checkout, 'payload.txt'), 'utf8'), success ? 'new source' : scenario === 'checkout-conflict' ? 'local work' : 'old source');
      for (const artifact of ['node_modules', 'dist', 'web/dist']) assert.equal((await readFile(join(checkout, artifact, 'marker'), 'utf8')).trim(), success ? 'new build' : 'old build');
      assert.deepEqual((await readdir(join(checkout, 'runtime'))).filter((name) => name.startsWith('update.')), []);
      assert.equal((await readdir(checkout)).includes('UNWANTED'), false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
