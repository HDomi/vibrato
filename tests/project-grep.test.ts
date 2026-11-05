import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { grepFiles } from '../server/fs';
import { shortcutKey } from '../web/src/lib/keys';

test('grepFiles: plain, case-sensitive and regex search; skips binaries and node_modules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibrato-grep-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'const Foo = 1;\n  foo(Foo);\r\nbar\n');
    writeFileSync(join(root, 'src', 'b.md'), '# 한글 Foo 제목\n');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'Foo');
    writeFileSync(join(root, 'bin.dat'), Buffer.from([70, 111, 111, 0, 1, 2]));

    const plain = await grepFiles(root, 'foo');
    assert.deepEqual(plain.hits.map((h) => [h.rel, h.line, h.col, h.len]), [['src/a.ts', 1, 6, 3], ['src/a.ts', 2, 2, 3], ['src/a.ts', 2, 6, 3], ['src/b.md', 1, 5, 3]]);
    assert.equal(plain.files, 2);
    assert.equal(plain.truncated, false);

    const cased = await grepFiles(root, 'foo', { caseSensitive: true });
    assert.deepEqual(cased.hits.map((h) => [h.line, h.col]), [[2, 2]]);

    const re = await grepFiles(root, 'F\\w+\\(', { regex: true });
    assert.deepEqual(re.hits.map((h) => [h.rel, h.line, h.col, h.len]), [['src/a.ts', 2, 2, 4]]);

    const special = await grepFiles(root, 'foo(');
    assert.equal(special.hits.length, 1, 'regex characters are literal without regex');

    const capped = await grepFiles(root, 'o', { limit: 2 });
    assert.equal(capped.hits.length, 2);
    assert.equal(capped.truncated, true);

    await assert.rejects(grepFiles(root, '(', { regex: true }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shortcutKey: physical key for Korean input and ⌥, typed key otherwise', () => {
  assert.equal(shortcutKey({ key: 'p', code: 'KeyP' }), 'p');
  assert.equal(shortcutKey({ key: 'P', code: 'KeyP' }), 'p');
  assert.equal(shortcutKey({ key: 'ㅔ', code: 'KeyP' }), 'p');
  assert.equal(shortcutKey({ key: 'ㄹ', code: 'KeyF' }), 'f');
  assert.equal(shortcutKey({ key: 'ß', code: 'KeyS' }), 's');
  assert.equal(shortcutKey({ key: '1', code: 'Digit1' }), '1');
  assert.equal(shortcutKey({ key: '/', code: 'Slash' }), '/');
  // Dvorak: the "p" key types "l"; the letter typed wins.
  assert.equal(shortcutKey({ key: 'l', code: 'KeyP' }), 'l');
  assert.equal(shortcutKey({ key: 'Enter', code: 'Enter' }), 'enter');
});
