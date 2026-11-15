import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportZip } from '../server/exportZip';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('exportZip bundles the markdown with copied and decoded images, skipping unreadable ones', { skip: process.platform !== 'darwin' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibrato-export-'));
  try {
    const src = join(dir, 'shot.png');
    writeFileSync(src, PNG);
    const dest = join(dir, 'out', 'My session.zip');
    const res = await exportZip({
      name: 'My session',
      markdown: '# hi\n\n![a](images/001-shot.png)\n',
      images: [
        { name: 'images/001-shot.png', src },
        { name: 'images/002-tool.png', src: `data:image/png;base64,${PNG.toString('base64')}` },
        { name: 'images/003-gone.png', src: join(dir, 'missing.png') },
        { name: '../escape.png', src },
      ],
    }, dest);
    assert.equal(res.path, dest);
    assert.deepEqual(res.missing, [join(dir, 'missing.png'), '../escape.png']);
    assert.ok(existsSync(dest));
    const list = execFileSync('/usr/bin/unzip', ['-Z1', dest]).toString().trim().split('\n').sort();
    assert.deepEqual(list, ['My session/', 'My session/My session.md', 'My session/images/', 'My session/images/001-shot.png', 'My session/images/002-tool.png']);
    execFileSync('/usr/bin/ditto', ['-x', '-k', dest, join(dir, 'x')]);
    assert.equal(readFileSync(join(dir, 'x', 'My session', 'My session.md'), 'utf8'), '# hi\n\n![a](images/001-shot.png)\n');
    assert.deepEqual(readFileSync(join(dir, 'x', 'My session', 'images', '002-tool.png')), PNG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exportZip returns bytes when no destination is given and rejects bad names', { skip: process.platform !== 'darwin' }, async () => {
  const res = await exportZip({ name: 'notes', markdown: '# x\n', images: [] }, null);
  assert.ok(res.bytes && res.bytes.length > 0);
  assert.equal(res.bytes!.readUInt32LE(0), 0x04034b50); // local file header signature
  await assert.rejects(exportZip({ name: 'a/b', markdown: '', images: [] }, null), /Invalid export name/);
  await assert.rejects(exportZip({ name: '..', markdown: '', images: [] }, null), /Invalid export name/);
});
