import fs from 'node:fs/promises';
import { FsError } from '../fs.js';
import { run } from '../shell.js';

/**
 * Image conversion through macOS `sips` (ImageIO): reads everything Preview.app opens — PNG, JPEG,
 * HEIC, AVIF, WebP, SVG, TIFF, PSD, camera RAW, … — and writes the formats below. WebP is the one
 * common format ImageIO cannot write; the client encodes it with Chromium's canvas and saves the
 * bytes through `writeImageBytes`.
 */
export const WRITE_FORMATS: Record<string, { lossy?: boolean }> = {
  png: {}, jpeg: { lossy: true }, heic: { lossy: true }, avif: { lossy: true }, tiff: {}, gif: {}, bmp: {},
  ico: {}, icns: {}, jp2: { lossy: true }, tga: {}, psd: {}, pdf: {}, exr: {}, pbm: {}, astc: {}, ktx: {}, pvr: {},
};
/** Sizes ImageIO accepts for icon containers (it writes nothing for anything else). */
export const ICNS_SIZES = [16, 32, 48, 128, 256, 512];

export interface ImageProbe { width: number; height: number; format: string; hasAlpha: boolean }

/** Size and format of an image file, or null when it is not a readable image. */
export async function probeImage(abs: string): Promise<ImageProbe | null> {
  const r = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', '-g', 'hasAlpha', abs], 20000);
  const get = (k: string) => r.stdout.match(new RegExp(`${k}: (.+)`))?.[1]?.trim();
  const width = Number(get('pixelWidth')); const height = Number(get('pixelHeight'));
  if (!r.ok || !width || !height) return null;
  return { width, height, format: get('format') ?? '', hasAlpha: get('hasAlpha') === 'yes' };
}

/** Write `src` as `format` to `out`: exact `width` x `height`, or scaled so its longer side is `fit`. */
export async function encodeImage(src: string, out: string, format: string, opts: { width?: number; height?: number; quality?: number; fit?: number }) {
  const args = ['-s', 'format', format];
  if (opts.quality !== undefined && WRITE_FORMATS[format]?.lossy) args.push('-s', 'formatOptions', String(Math.round(Math.min(100, Math.max(1, opts.quality)))));
  if (opts.width && opts.height) args.push('-z', String(opts.height), String(opts.width));
  else if (opts.fit) args.push('-Z', String(opts.fit));
  const r = await run('sips', [...args, src, '--out', out], 120000);
  // sips exits 0 and writes nothing when ImageIO refuses a size/format combination.
  const size = await fs.stat(out).then((s) => s.size).catch(() => 0);
  if (!size) {
    await fs.rm(out, { force: true });
    throw new FsError('ECONVERT', `Could not convert to ${format}${r.stderr ? `: ${r.stderr.split('\n').pop()}` : ''}`, 422);
  }
}
