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

test('turn snapshots see only what changed during the turn, including untracked files', async () => {
  const { dir, git } = repo();
  try {
    writeFileSync(join(dir, 'pre-existing.txt'), 'dirty before the turn\n');
    const before = await snapshot(dir);
    assert.ok(before);
    const lines = readFileSync(join(dir, 'a.txt'), 'utf8').split('\n');
    lines[1] = 'CHANGED 2'; lines[25] = 'CHANGED 26';
    writeFileSync(join(dir, 'a.txt'), lines.join('\n'));
    writeFileSync(join(dir, 'new.txt'), 'hello\n');
    writeFileSync(join(dir, 'ignored.txt'), 'nope\n');
    rmSync(join(dir, 'gone.txt'));
    const after = await snapshot(dir);
    const files = await changedFiles(before!.root, before!.tree, after!.tree);
    assert.deepEqual(files.map((f) => `${f.status} ${f.path} +${f.additions} -${f.deletions}`).sort(), ['A new.txt +1 -0', 'D gone.txt +0 -1', 'M a.txt +2 -2']);
    assert.equal(git('status', '--porcelain').includes('new.txt'), true, 'the real index is untouched');
    assert.equal(git('diff', '--cached', '--name-only'), '');

    const whole = await turnDiff(before!.root, before!.tree, after!.tree, '');
    assert.ok(whole.includes('a/a.txt') && whole.includes('b/new.txt') && whole.includes('a/gone.txt'));
    const { hunks } = splitHunks(await turnDiff(before!.root, before!.tree, after!.tree, 'a.txt'));
    assert.equal(hunks.length, 2);
    const one = await revertTurn(before!.root, before!.tree, after!.tree, { hunk: { file: 'a.txt', index: 1 } });
    assert.equal(one.ok, true);
    const text = readFileSync(join(dir, 'a.txt'), 'utf8');
    assert.ok(text.includes('CHANGED 2') && text.includes('line 26') && !text.includes('CHANGED 26'));

    // a.txt moved on since the turn: whole-file undo refuses it without force; the others go back.
    const r = await revertTurn(before!.root, before!.tree, after!.tree, {});
    assert.deepEqual(r.conflicts, ['a.txt']);
    assert.deepEqual(r.reverted.sort(), ['gone.txt', 'new.txt']);
    assert.equal(readFileSync(join(dir, 'gone.txt'), 'utf8'), 'bye\n');
    assert.equal(existsSync(join(dir, 'new.txt')), false);
    const forced = await revertTurn(before!.root, before!.tree, after!.tree, { files: ['a.txt'], force: true });
    assert.deepEqual(forced.reverted, ['a.txt']);
    assert.ok(readFileSync(join(dir, 'a.txt'), 'utf8').startsWith('line 1\nline 2\n'));
    assert.equal(readFileSync(join(dir, 'pre-existing.txt'), 'utf8'), 'dirty before the turn\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('turn snapshots: none outside git, paths and ids are validated', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'vibrato-plain-'));
  try { assert.equal(await snapshot(plain), null); } finally { rmSync(plain, { recursive: true, force: true }); }
  const { dir } = repo();
  try {
    const s = await snapshot(dir);
    await assert.rejects(turnDiff(dir, s!.tree, s!.tree, '../etc/passwd'), /outside/);
    await assert.rejects(turnDiff(dir, 'HEAD; rm -rf /', s!.tree, 'a.txt'), /Invalid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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

test('snapshots of one repository run one at a time, and an aborted one is skipped', async () => {
  const { dir } = repo();
  try {
    const abort = new AbortController();
    const first = snapshot(dir);
    const second = snapshot(dir, undefined, abort.signal);
    const third = snapshot(dir);
    abort.abort();
    const [a, b, c] = await Promise.all([first, second, third]);
    assert.ok(a && c && a.tree === c.tree, 'the others still run');
    assert.equal(b, null, 'aborted while waiting its turn');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
