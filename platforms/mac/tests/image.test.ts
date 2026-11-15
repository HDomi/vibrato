import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FsError } from '../server/fs';
import { convertImage, imageInfo, renderPng, writeImageBytes } from '../server/image';

const SRC = path.join(import.meta.dirname, '..', 'web', 'public', 'icon.png'); // 1024×1024 with alpha
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
// What ImageIO can write depends on the macOS version (AVIF writing is missing on macOS 15, used by CI).
const WRITABLE = new Set(execFileSync('sips', ['--formats'], { encoding: 'utf8' }).split('\n')
  .map((l) => l.trim().split(/\s+/)).filter((c) => c[2] === 'Writable').map((c) => c[1]));

async function scratch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibrato-image-'));
  const src = path.join(dir, 'pic.png');
  await fs.copyFile(SRC, src);
  return { dir, src };
}

test('imageInfo reads size and alpha', async () => {
  const { src } = await scratch();
  assert.deepEqual(await imageInfo(src), { width: 1024, height: 1024, format: 'png', hasAlpha: true });
});

test('convertImage writes the new format at the requested size, without leftovers', async () => {
  const { dir, src } = await scratch();
  const out = await convertImage({ path: src, dest: path.join(dir, 'pic.jpg'), format: 'jpeg', width: 300, height: 200, quality: 60 });
  const info = await imageInfo(out);
  assert.equal(info.format, 'jpeg');
  assert.deepEqual([info.width, info.height], [300, 200]);
  for (const format of ['heic', 'avif', 'tiff', 'gif', 'bmp', 'jp2', 'psd', 'tga']) {
    const dest = path.join(dir, `pic.${format}`);
    if (!WRITABLE.has(format)) {
      // Unsupported on this OS: a clean 422, and no file left behind.
      await assert.rejects(convertImage({ path: src, dest, format, width: 64, height: 64 }), (e: unknown) => e instanceof FsError && e.status === 422, format);
      continue;
    }
    const p = await convertImage({ path: src, dest, format, width: 64, height: 64 });
    assert.ok((await fs.stat(p)).size > 0, format);
  }
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.includes('vibrato-tmp')), []);
});

test('convertImage refuses to replace silently and rejects icon sizes ImageIO cannot write', async () => {
  const { dir, src } = await scratch();
  const dest = path.join(dir, 'pic.jpg');
  await fs.writeFile(dest, 'keep');
  await assert.rejects(convertImage({ path: src, dest, format: 'jpeg' }), (e: unknown) => e instanceof FsError && e.status === 409);
  assert.equal(await fs.readFile(dest, 'utf8'), 'keep');
  await convertImage({ path: src, dest, format: 'jpeg', overwrite: true });
  assert.equal((await imageInfo(dest)).format, 'jpeg');

  await assert.rejects(convertImage({ path: src, dest: path.join(dir, 'a.ico'), format: 'ico', width: 512, height: 512 }), (e: unknown) => e instanceof FsError && e.status === 400);
  await assert.rejects(convertImage({ path: src, dest: path.join(dir, 'a.icns'), format: 'icns', width: 64, height: 64 }), (e: unknown) => e instanceof FsError && e.status === 400);
  const icns = await convertImage({ path: src, dest: path.join(dir, 'a.icns'), format: 'icns', width: 128, height: 128 });
  assert.ok((await fs.stat(icns)).size > 0);
  await assert.rejects(convertImage({ path: src, dest: path.join(dir, 'a.webp'), format: 'webp' }), (e: unknown) => e instanceof FsError && e.status === 400);
});

test('in-place resize replaces the original', async () => {
  const { src } = await scratch();
  await convertImage({ path: src, dest: src, format: 'png', width: 100, height: 100, overwrite: true });
  assert.deepEqual([(await imageInfo(src)).width, (await imageInfo(src)).height], [100, 100]);
});

test('renderPng resizes to PNG; writeImageBytes saves client-encoded bytes', async () => {
  const { dir, src } = await scratch();
  const preview = await renderPng(src, { fit: 4096 });
  const pv = path.join(dir, 'pv.png'); await fs.writeFile(pv, preview);
  assert.equal((await imageInfo(pv)).width, 1024, 'a preview bound never enlarges');
  const png = await renderPng(src, { width: 50, height: 40 });
  assert.ok(png.subarray(0, 4).equals(PNG_MAGIC));
  const p = await writeImageBytes(path.join(dir, 'out.png'), png, false);
  assert.deepEqual([(await imageInfo(p)).width, (await imageInfo(p)).height], [50, 40]);
  await assert.rejects(writeImageBytes(p, png, false), (e: unknown) => e instanceof FsError && e.status === 409);
});
