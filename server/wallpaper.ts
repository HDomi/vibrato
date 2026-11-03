import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

/**
 * The app wallpaper lives in the config folder, outside the app bundle, so it survives updates.
 * The renderer makes both images (the original, downscaled, and a pre-blurred copy for glass surfaces)
 * and uploads them; the server only stores and serves them.
 */
export const WALL_DIR = path.join(CONFIG_DIR, 'wallpaper');
const META_FILE = path.join(WALL_DIR, 'wallpaper.json');
const FILES = { original: 'wall.jpg', blur: 'wall-blur.jpg' } as const;
export type WallFile = keyof typeof FILES;
export const WALL_MAX_BYTES = 24 * 1024 * 1024;

export interface Wallpaper {
  kind: 'color' | 'image';
  color: string;
  /** Blur radius in CSS px at full size (the stored copy is smaller and blurred proportionally). */
  blur: number;
  /** Darkening over glass surfaces, 0-90 (%). */
  dim: number;
  /** Bumped on every image upload; the renderer puts it in the image URLs to bypass the cache. */
  version: number;
  hasImage: boolean;
}

export const DEFAULT_WALLPAPER: Wallpaper = { kind: 'color', color: '#0b0d12', blur: 40, dim: 45, version: 0, hasImage: false };

export class WallpaperError extends Error {}

const clampInt = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

function clean(raw: Partial<Wallpaper>, base: Wallpaper): Wallpaper {
  return {
    kind: raw.kind === 'image' || raw.kind === 'color' ? raw.kind : base.kind,
    color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color.toLowerCase() : base.color,
    blur: clampInt(raw.blur, 0, 120, base.blur),
    dim: clampInt(raw.dim, 0, 90, base.dim),
    version: clampInt(raw.version, 0, Number.MAX_SAFE_INTEGER, base.version),
    hasImage: typeof raw.hasImage === 'boolean' ? raw.hasImage : base.hasImage,
  };
}

export async function loadWallpaper(): Promise<Wallpaper> {
  try {
    const w = clean(JSON.parse(await fs.readFile(META_FILE, 'utf8')) as Partial<Wallpaper>, DEFAULT_WALLPAPER);
    // A meta file that outlived its images (folder cleaned by hand) falls back to the color.
    if (w.hasImage && !(await exists(wallpaperPath('original')))) return { ...w, kind: 'color', hasImage: false };
    return w;
  } catch {
    return { ...DEFAULT_WALLPAPER };
  }
}

async function writeMeta(w: Wallpaper) {
  await fs.mkdir(WALL_DIR, { recursive: true });
  const tmp = `${META_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(w, null, 2));
  await fs.rename(tmp, META_FILE);
}

/** Color, blur, dim and kind. Choosing "image" without an uploaded image is refused. */
export async function updateWallpaper(patch: Partial<Wallpaper>): Promise<Wallpaper> {
  const cur = await loadWallpaper();
  const next = clean({ ...patch, version: cur.version, hasImage: cur.hasImage }, cur);
  if (next.kind === 'image' && !next.hasImage) throw new WallpaperError('no wallpaper image uploaded');
  await writeMeta(next);
  return next;
}

/** Stores the uploaded pair. `original` may be omitted when only the blur changed (re-blurred copy). */
export async function saveWallpaperImages(files: { original?: File; blur: File }, blur: number): Promise<Wallpaper> {
  const cur = await loadWallpaper();
  if (!files.original && !cur.hasImage) throw new WallpaperError('original image required');
  for (const f of [files.original, files.blur]) {
    if (!f) continue;
    if (f.type !== 'image/jpeg') throw new WallpaperError('wallpaper images must be JPEG');
    if (f.size > WALL_MAX_BYTES) throw new WallpaperError('wallpaper image too large');
  }
  await fs.mkdir(WALL_DIR, { recursive: true });
  if (files.original) await writeAtomic(wallpaperPath('original'), files.original);
  await writeAtomic(wallpaperPath('blur'), files.blur);
  const next = clean({ ...cur, kind: 'image', blur, hasImage: true, version: Math.max(Date.now(), cur.version + 1) }, cur);
  await writeMeta(next);
  return next;
}

export function wallpaperPath(which: WallFile): string {
  return path.join(WALL_DIR, FILES[which]);
}

async function writeAtomic(target: string, file: File) {
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, Buffer.from(await file.arrayBuffer()));
  await fs.rename(tmp, target);
}

async function exists(p: string) {
  try { await fs.access(p); return true; } catch { return false; }
}
