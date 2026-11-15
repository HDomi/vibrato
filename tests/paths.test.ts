import assert from 'node:assert/strict';
import test from 'node:test';
import { baseName, isAbsPath, isInside, isWindowsPath, joinPath, lastSegment, lastSep, parentDir, pathOfSegments, relativeTo, segments } from '../web/src/lib/paths';
import { resolveLocal } from '../web/src/lib/localPath';

test('POSIX paths behave exactly like the plain "/" string operations they replaced', () => {
  for (const p of ['/Users/me/app', '/Users/me/app/', '/', '/a', 'rel/a.ts', 'name', '', '/Users/me/with\\backslash/x']) {
    assert.equal(lastSegment(p), p.split('/').pop());
    assert.equal(lastSep(p), p.lastIndexOf('/'));
    assert.deepEqual(segments(p), p.split('/').filter(Boolean));
    assert.equal(baseName(p), p.split('/').filter(Boolean).pop());
    assert.equal(parentDir(p), p.slice(0, p.lastIndexOf('/')) || '/');
    assert.equal(isAbsPath(p), p.startsWith('/'));
    assert.equal(isWindowsPath(p), false);
  }
  assert.equal(joinPath('/a/b', 'c/d.ts'), '/a/b/c/d.ts');
  assert.equal(isInside('/a/b/c', '/a/b'), true);
  assert.equal(isInside('/a/bc', '/a/b'), false);
  assert.equal(isInside('/a/b', '/a/b'), false);
  assert.equal(relativeTo('/a/b/c/d.ts', '/a/b'), 'c/d.ts');
  assert.equal(relativeTo('/x/y', '/a/b'), '/x/y');
  assert.equal(pathOfSegments('/Users/me/app', 0), '/Users');
  assert.equal(pathOfSegments('/Users/me/app', 2), '/Users/me/app');
});

test('Windows paths: both separators, drive roots, case-insensitive containment', () => {
  const p = 'C:\\Users\\me\\app';
  assert.equal(isWindowsPath(p), true);
  assert.equal(isAbsPath(p), true);
  assert.equal(isAbsPath('\\\\server\\share\\x'), true);
  assert.equal(lastSegment(p), 'app');
  assert.equal(lastSegment('C:/Users/me/app'), 'app');
  assert.equal(baseName('C:\\Users\\me\\app\\'), 'app');
  assert.deepEqual(segments(p), ['C:', 'Users', 'me', 'app']);
  assert.equal(parentDir(p), 'C:\\Users\\me');
  assert.equal(parentDir('C:\\Users'), 'C:\\');
  assert.equal(parentDir('C:\\'), 'C:\\');
  assert.equal(pathOfSegments(p, 0), 'C:\\');
  assert.equal(pathOfSegments(p, 2), 'C:\\Users\\me');
  assert.equal(joinPath(p, 'src/a.ts'), 'C:\\Users\\me\\app\\src\\a.ts');
  assert.equal(joinPath('C:\\', 'a.ts'), 'C:\\a.ts');
  assert.equal(isInside('c:\\users\\ME\\app\\src\\a.ts', p), true);
  assert.equal(isInside('C:\\Users\\me\\apple', p), false);
  assert.equal(relativeTo('C:\\Users\\me\\app\\src\\a.ts', p), 'src/a.ts');
  assert.equal(relativeTo('D:\\x', p), 'D:\\x');
});

test('links in a document on a Windows machine resolve as Windows paths; elsewhere "C:" stays a URL scheme', () => {
  const dir = 'C:\\proj\\docs';
  assert.equal(resolveLocal('guide.md', dir), 'C:\\proj\\docs\\guide.md');
  assert.equal(resolveLocal('../src/a.ts:12', dir), 'C:\\proj\\src\\a.ts');
  assert.equal(resolveLocal('sub\\b.md#top', dir), 'C:\\proj\\docs\\sub\\b.md');
  assert.equal(resolveLocal('D:\\other\\c.md', dir), 'D:\\other\\c.md');
  assert.equal(resolveLocal('file:///C:/proj/a%20b.md', dir), 'C:\\proj\\a b.md');
  assert.equal(resolveLocal('\\root.md', dir), 'C:\\root.md');
  assert.equal(resolveLocal('../../../up.md', dir), 'C:\\up.md');
  assert.equal(resolveLocal('https://example.com', dir), null);
  assert.equal(resolveLocal('C:\\proj\\a.md', '/Users/me'), null);
  assert.equal(resolveLocal('a.md', '/Users/me'), '/Users/me/a.md');
});
