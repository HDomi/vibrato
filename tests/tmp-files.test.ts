import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearTemp, saveTmpImage, tempStats, type TempTarget } from '../server/tmpFiles.ts';

const png = (name: string, bytes = 10) => new File([new Uint8Array(bytes)], name, { type: 'image/png' });
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'vb-temp-'));

/** The real layout: uploads and tool-images share <config>/attachments; a legacy profile folder beside them. */
async function layout() {
  const root = await tmp();
  const attach = path.join(root, 'attachments');
  const targets: TempTarget[] = [
    { id: 'tmp', dir: path.join(root, 'tmp') },
    { id: 'uploads', dir: attach, topOnly: true },
    { id: 'toolImages', dir: path.join(attach, 'tool-images') },
    { id: 'chromeProfile', dir: path.join(root, 'chrome-profile'), removeDir: true, legacy: true },
  ];
  await fs.mkdir(path.join(attach, 'tool-images'), { recursive: true });
  await saveTmpImage(png('drawing.png', 100), targets[0].dir);
  await fs.writeFile(path.join(attach, 'u1-paste.png'), new Uint8Array(40));
  await fs.writeFile(path.join(attach, 'tool-images', 'shot.png'), new Uint8Array(300));
  return { root, attach, targets };
}

test('a drawing is saved into the tmp folder under its own name; only images are taken', async () => {
  const dir = await tmp();
  const p = await saveTmpImage(png('drawing-20261124-120000.png', 42), dir);
  assert.match(path.basename(p), /^[0-9a-f]{8}-drawing-20261124-120000\.png$/);
  await assert.rejects(saveTmpImage(new File(['x'], 'notes.txt', { type: 'text/plain' }), dir), /Only images/);
});

test('each folder reports its own size: uploads leave tool-images out, a missing legacy folder is not listed', async () => {
  const { targets } = await layout();
  const stats = await tempStats(targets);
  assert.deepEqual(stats.map((s) => [s.id, s.files, s.bytes]), [['tmp', 1, 100], ['uploads', 1, 40], ['toolImages', 1, 300]]);
});

test('deleting one folder leaves the others', async () => {
  const { attach, targets } = await layout();
  assert.deepEqual(await clearTemp('uploads', targets), { deleted: 1, bytes: 40, failed: 0 });
  assert.deepEqual(await fs.readdir(attach), ['tool-images']);
  assert.deepEqual((await tempStats(targets)).map((s) => [s.id, s.files]), [['tmp', 1], ['uploads', 0], ['toolImages', 1]]);
  assert.deepEqual(await clearTemp('toolImages', targets), { deleted: 1, bytes: 300, failed: 0 });
  assert.deepEqual(await clearTemp('tmp', targets), { deleted: 1, bytes: 100, failed: 0 });
});

test('a legacy folder is listed while it exists and removed as a whole', async () => {
  const { root, targets } = await layout();
  await fs.mkdir(path.join(root, 'chrome-profile', 'Default'), { recursive: true });
  await fs.writeFile(path.join(root, 'chrome-profile', 'Default', 'Cookies'), new Uint8Array(70));
  assert.deepEqual((await tempStats(targets)).find((s) => s.id === 'chromeProfile'), { id: 'chromeProfile', dir: path.join(root, 'chrome-profile'), files: 1, bytes: 70, legacy: true });
  assert.deepEqual(await clearTemp('chromeProfile', targets), { deleted: 1, bytes: 70, failed: 0 });
  assert.equal(await fs.stat(path.join(root, 'chrome-profile')).catch(() => null), null);
});

test('an unknown folder id deletes nothing', async () => {
  const { targets } = await layout();
  await assert.rejects(clearTemp('nope' as never, targets), /Unknown temp folder/);
});

test('a file that cannot be removed is skipped and counted, the rest still go', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { targets } = await layout();
  const locked = path.join(targets[2].dir, 'locked');
  await fs.mkdir(locked);
  await fs.writeFile(path.join(locked, 'x.png'), new Uint8Array(5));
  await fs.chmod(locked, 0o500); // no write: its file cannot be unlinked
  try {
    assert.deepEqual(await clearTemp('toolImages', targets), { deleted: 1, bytes: 300, failed: 1 });
  } finally { await fs.chmod(locked, 0o700); }
});
