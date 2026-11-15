import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FsError, resolvePath } from './fs.js';
import { encodeImage, ICNS_SIZES, probeImage, WRITE_FORMATS } from './os/images.js';

/**
 * Image info, conversion and PNG rendering. Reading and encoding is the platform's (os/images.ts: which formats it
 * reads and writes differs per target). WebP is written by the client: it encodes with Chromium's canvas and
 * saves the bytes through `writeImageBytes`.
 */
export { ICNS_SIZES, WRITE_FORMATS } from './os/images.js';
export const ICO_MAX = 256;

export interface ImageInfo { width: number; height: number; format: string; hasAlpha: boolean }

export async function imageInfo(p: string): Promise<ImageInfo> {
  const abs = resolvePath(p);
  const info = await probeImage(abs);
  if (!info) throw new FsError('EIMAGE', `Not a readable image: ${abs}`, 422);
  return info;
}

function checkSize(format: string, w?: number, h?: number) {
  if (w !== undefined && (!Number.isInteger(w) || w < 1 || w > 30000)) throw new FsError('EINVAL', 'Invalid width', 400);
  if (h !== undefined && (!Number.isInteger(h) || h < 1 || h > 30000)) throw new FsError('EINVAL', 'Invalid height', 400);
  if (format === 'ico' && (w !== h || !w || w > ICO_MAX)) throw new FsError('EINVAL', `ICO must be square, at most ${ICO_MAX}px`, 400);
  if (format === 'icns' && (w !== h || !w || !ICNS_SIZES.includes(w))) throw new FsError('EINVAL', `ICNS must be square: ${ICNS_SIZES.join(', ')}`, 400);
}

/** Write next to `dest` first and rename over it, so a failed conversion never leaves a half file. */
async function placeAt(dest: string, overwrite: boolean, produce: (tmp: string) => Promise<void>): Promise<string> {
  const dir = path.dirname(dest);
  const st = await fs.stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new FsError('ENOENT', `Not found: ${dir}`, 404);
  if (!overwrite && await fs.access(dest).then(() => true, () => false)) throw new FsError('EEXIST', `Already exists: ${dest}`, 409);
  const tmp = path.join(dir, `.${path.basename(dest)}.${randomUUID().slice(0, 8)}.vibrato-tmp${path.extname(dest)}`);
  try {
    await produce(tmp);
    await fs.rename(tmp, dest);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  return dest;
}

export async function convertImage(o: { path: string; dest: string; format: string; width?: number; height?: number; quality?: number; overwrite?: boolean }): Promise<string> {
  if (!WRITE_FORMATS[o.format]) throw new FsError('EINVAL', `Unsupported format: ${o.format}`, 400);
  checkSize(o.format, o.width, o.height);
  const src = resolvePath(o.path);
  const dest = resolvePath(o.dest);
  return placeAt(dest, !!o.overwrite, (tmp) => encodeImage(src, tmp, o.format, o))
    .catch((err) => { if (err instanceof FsError) throw err; throw new FsError('ECONVERT', (err as Error).message, 500); });
}

/** PNG rendering of any readable image (preview of HEIC/TIFF/PSD/RAW, and the WebP encoder's input). */
export async function renderPng(p: string, opts: { width?: number; height?: number; fit?: number }): Promise<Buffer> {
  const src = resolvePath(p);
  const tmp = path.join(os.tmpdir(), `vibrato-render-${randomUUID()}.png`);
  // `fit` also enlarges; a preview bound only ever shrinks.
  if (opts.fit && !opts.width) {
    const info = await imageInfo(src);
    if (Math.max(info.width, info.height) <= opts.fit) opts = { ...opts, fit: undefined };
  }
  try {
    await encodeImage(src, tmp, 'png', opts);
    return await fs.readFile(tmp);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** Save bytes the client encoded (WebP). */
export async function writeImageBytes(destPath: string, data: Buffer, overwrite: boolean): Promise<string> {
  if (!data.length) throw new FsError('EINVAL', 'Empty image', 400);
  return placeAt(resolvePath(destPath), overwrite, (tmp) => fs.writeFile(tmp, data));
}
