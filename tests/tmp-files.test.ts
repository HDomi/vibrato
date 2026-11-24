import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearTemp, saveTmpImage, tempStats, type TempTarget } from '../server/tmpFiles.ts';

const png = (name: string, bytes = 10) => new File([new Uint8Array(bytes)], name, { type: 'image/png' });
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'vb-temp-'));

async function targets(): Promise<TempTarget[]> {
  return [{ id: 'tmp', dir: await tmp() }, { id: 'attachments', dir: await tmp() }];
}

test('a drawing is saved into the tmp folder under its own name', async () => {
  const dir = await tmp();
  const p = await saveTmpImage(png('drawing-20261124-120000.png', 42), dir);
  assert.equal(path.dirname(p), dir);
  assert.match(path.basename(p), /^[0-9a-f]{8}-drawing-20261124-120000\.png$/);
  assert.equal((await fs.stat(p)).size, 42);
});

test('only images are taken into tmp', async () => {
  const dir = await tmp();
  await assert.rejects(saveTmpImage(new File(['x'], 'notes.txt', { type: 'text/plain' }), dir), /Only images/);
  await assert.rejects(saveTmpImage(new File(['x'], 'fake.png', { type: 'text/plain' }), dir), /Only images/);
});

test('stats cover tmp and attachments, sub folders (tool-images) included; a missing folder is empty', async () => {
  const [t, a] = await targets();
  await saveTmpImage(png('a.png', 100), t.dir);
  await fs.writeFile(path.join(a.dir, 'u-notes.txt'), 'hello');
  await fs.mkdir(path.join(a.dir, 'tool-images'));
  await fs.writeFile(path.join(a.dir, 'tool-images', 'shot.png'), new Uint8Array(30));
  assert.deepEqual(await tempStats([t, a, { id: 'tmp', dir: '/nonexistent/vb' }]), [
    { id: 'tmp', dir: t.dir, files: 1, bytes: 100 },
    { id: 'attachments', dir: a.dir, files: 2, bytes: 35 },
    { id: 'tmp', dir: '/nonexistent/vb', files: 0, bytes: 0 },
  ]);
});

test('cleaning empties both folders and keeps the folders themselves', async () => {
  const [t, a] = await targets();
  await saveTmpImage(png('a.png', 100), t.dir);
  await fs.writeFile(path.join(a.dir, 'u-file.pdf'), new Uint8Array(20));
  await fs.mkdir(path.join(a.dir, 'tool-images'));
  await fs.writeFile(path.join(a.dir, 'tool-images', 'shot.png'), new Uint8Array(30));
  assert.deepEqual(await clearTemp([t, a]), { deleted: 3, bytes: 150, failed: 0 });
  assert.deepEqual(await fs.readdir(t.dir), []);
  assert.deepEqual(await fs.readdir(a.dir), ['tool-images']);
  assert.deepEqual(await clearTemp([t, a]), { deleted: 0, bytes: 0, failed: 0 });
});

test('a file that cannot be removed is skipped and counted, the rest still go', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const [t, a] = await targets();
  const locked = path.join(a.dir, 'locked');
  await fs.mkdir(locked);
  await fs.writeFile(path.join(locked, 'x.png'), new Uint8Array(5));
  await fs.chmod(locked, 0o500); // no write: its file cannot be unlinked
  await saveTmpImage(png('a.png', 10), t.dir);
  try {
    assert.deepEqual(await clearTemp([t, a]), { deleted: 1, bytes: 10, failed: 1 });
  } finally { await fs.chmod(locked, 0o700); }
});
