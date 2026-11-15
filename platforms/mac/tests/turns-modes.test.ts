import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { changedFiles, revertTurn, snapshot, splitHunks, turnDiff } from '../server/turns';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'vibrato-turns-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString();
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n');
  writeFileSync(join(dir, 'a.txt'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  writeFileSync(join(dir, 'gone.txt'), 'bye\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  return { dir, git };
}

test('turn undo goes through git: symlinks are replaced, not written through; modes come back', async () => {
  const { dir, git } = repo();
  const outside = mkdtempSync(join(tmpdir(), 'vibrato-outside-'));
  try {
    const { chmodSync, statSync, symlinkSync, lstatSync } = await import('node:fs');
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho hi\n'); chmodSync(join(dir, 'run.sh'), 0o755);
    git('add', '-A'); git('commit', '-qm', 'script');
    const before = await snapshot(dir);
    writeFileSync(join(outside, 'secret'), 'keep me\n');
    rmSync(join(dir, 'a.txt')); symlinkSync(join(outside, 'secret'), join(dir, 'a.txt'));
    rmSync(join(dir, 'run.sh'));
    const after = await snapshot(dir);
    const r = await revertTurn(before!.root, before!.tree, after!.tree, {});
    assert.deepEqual(r.reverted.sort(), ['a.txt', 'run.sh']);
    assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'keep me\n', 'the symlink target is untouched');
    assert.equal(lstatSync(join(dir, 'a.txt')).isSymbolicLink(), false);
    assert.ok(readFileSync(join(dir, 'a.txt'), 'utf8').startsWith('line 1\n'));
    assert.equal(statSync(join(dir, 'run.sh')).mode & 0o111, 0o111, 'executable bit restored');
    const { repoRelative } = await import('../server/turns');
    assert.equal(repoRelative('/private/tmp/r', '/tmp/r/src/a.ts'), 'src/a.ts');
    assert.equal(repoRelative('/tmp/r', '/etc/passwd'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
