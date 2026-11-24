/*
 * Temporary and leftover data the app keeps under <config> (Settings > Temp cleanup), each with its own size and
 * delete button:
 *  - tmp: drawings made with the composer's "Draw & insert" pad;
 *  - uploads: files pasted or uploaded from the composer (<config>/attachments);
 *  - toolImages: images tools returned, kept so chat cards can show them (<config>/attachments/tool-images);
 *  - chromeProfile: the Chrome profile of the old debug browser, not used since the in-app browser (2026-11).
 * Everything here is only referenced by past chat items: deleting it loses those previews and nothing else.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from './config.js';
import { ATTACH_DIR } from './attachments.js';

export const TMP_DIR = path.join(CONFIG_DIR, 'tmp');
const TOOL_IMAGES = path.join(ATTACH_DIR, 'tool-images');
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

export type TempId = 'tmp' | 'uploads' | 'toolImages' | 'chromeProfile';
export interface TempTarget {
  id: TempId;
  dir: string;
  /** Only the files directly in `dir` (uploads share their folder with tool-images). */
  topOnly?: boolean;
  /** Remove the folder itself too (data nothing uses any more). */
  removeDir?: boolean;
  /** Listed only while it exists. */
  legacy?: boolean;
}
export const TEMP_TARGETS: TempTarget[] = [
  { id: 'tmp', dir: TMP_DIR },
  { id: 'uploads', dir: ATTACH_DIR, topOnly: true },
  { id: 'toolImages', dir: TOOL_IMAGES },
  { id: 'chromeProfile', dir: path.join(CONFIG_DIR, 'chrome-profile'), removeDir: true, legacy: true },
];

/** Save one image into the tmp folder and return its absolute path. Only image types are taken. */
export async function saveTmpImage(file: File, dir = TMP_DIR): Promise<string> {
  const name = (file.name || 'image.png').replace(/[^\w.\-가-힣]+/g, '_').slice(0, 80);
  if (!IMAGE.test(name) || (file.type && !file.type.startsWith('image/'))) throw new Error('Only images can be saved to the tmp folder.');
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${randomUUID().slice(0, 8)}-${name}`);
  await fs.writeFile(dest, Buffer.from(await file.arrayBuffer()));
  return dest;
}

/** Files under a folder with their sizes (sub folders too unless `topOnly`). A missing folder has none. */
async function filesUnder(dir: string, topOnly = false, depth = 0): Promise<{ path: string; size: number }[]> {
  if (depth > 12) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: { path: string; size: number }[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!topOnly) out.push(...await filesUnder(p, false, depth + 1)); }
    else if (e.isFile()) { const st = await fs.stat(p).catch(() => null); if (st) out.push({ path: p, size: st.size }); }
  }
  return out;
}

export interface TempStat { id: TempId; dir: string; files: number; bytes: number; legacy?: boolean }

/** Size of each target; a legacy one that no longer exists is left out. */
export async function tempStats(targets = TEMP_TARGETS): Promise<TempStat[]> {
  const out: TempStat[] = [];
  for (const t of targets) {
    if (t.legacy && !(await fs.stat(t.dir).catch(() => null))) continue;
    const files = await filesUnder(t.dir, t.topOnly);
    out.push({ id: t.id, dir: t.dir, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), ...(t.legacy ? { legacy: true } : {}) });
  }
  return out;
}

/**
 * Delete one target's files. A file that cannot be removed (in use, as Windows reports for an open file, or
 * read-only) is skipped and counted, so one stuck file does not stop the rest. Unknown ids delete nothing.
 */
export async function clearTemp(id: TempId, targets = TEMP_TARGETS): Promise<{ deleted: number; bytes: number; failed: number }> {
  const t = targets.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown temp folder: ${id}`);
  let deleted = 0, bytes = 0, failed = 0;
  for (const f of await filesUnder(t.dir, t.topOnly)) {
    try { await fs.rm(f.path, { force: true, maxRetries: 2 }); deleted++; bytes += f.size; } catch { failed++; }
  }
  if (t.removeDir && !failed) await fs.rm(t.dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => { failed++; });
  return { deleted, bytes, failed };
}
