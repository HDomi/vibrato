import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearTmpImages, saveTmpImage, tmpStats } from '../server/tmpFiles.ts';

const png = (name: string, bytes = 10) => new File([new Uint8Array(bytes)], name, { type: 'image/png' });

test('a drawing is saved into the tmp folder under its own name', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-tmp-'));
  const p = await saveTmpImage(png('drawing-20261124-120000.png', 42), dir);
  assert.equal(path.dirname(p), dir);
  assert.match(path.basename(p), /^[0-9a-f]{8}-drawing-20261124-120000\.png$/);
  assert.equal((await fs.stat(p)).size, 42);
});

test('only images are taken', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-tmp-'));
  await assert.rejects(saveTmpImage(new File(['x'], 'notes.txt', { type: 'text/plain' }), dir), /Only images/);
  await assert.rejects(saveTmpImage(new File(['x'], 'fake.png', { type: 'text/plain' }), dir), /Only images/);
});

test('stats count images only; a missing folder is empty', async () => {
  assert.deepEqual(await tmpStats('/nonexistent/vb-tmp'), { dir: '/nonexistent/vb-tmp', files: 0, bytes: 0 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-tmp-'));
  await saveTmpImage(png('a.png', 100), dir);
  await saveTmpImage(png('b.jpg', 50), dir);
  await fs.writeFile(path.join(dir, 'keep.txt'), 'x');
  assert.deepEqual(await tmpStats(dir), { dir, files: 2, bytes: 150 });
});

test('clearing deletes every image and leaves other files and folders', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-tmp-'));
  await saveTmpImage(png('a.png', 100), dir);
  await saveTmpImage(png('b.webp', 30), dir);
  await fs.writeFile(path.join(dir, 'keep.txt'), 'x');
  await fs.mkdir(path.join(dir, 'sub.png'));
  assert.deepEqual(await clearTmpImages(dir), { deleted: 2, bytes: 130 });
  assert.deepEqual((await fs.readdir(dir)).sort(), ['keep.txt', 'sub.png']);
  assert.deepEqual(await clearTmpImages(dir), { deleted: 0, bytes: 0 });
});
