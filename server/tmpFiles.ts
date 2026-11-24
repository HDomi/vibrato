/*
 * Temporary files the app keeps under <config> (Settings > Temp cleanup):
 *  - tmp: images the app makes for the user to attach (the composer's "Draw & insert" pad);
 *  - attachments: files uploaded from the composer (paste, browser mode) and images tools returned (tool-images).
 * Both are only referenced by past chat items, so clearing them loses those previews and nothing else.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from './config.js';
import { ATTACH_DIR } from './attachments.js';

export const TMP_DIR = path.join(CONFIG_DIR, 'tmp');
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

export interface TempTarget { id: 'tmp' | 'attachments'; dir: string }
export const TEMP_TARGETS: TempTarget[] = [{ id: 'tmp', dir: TMP_DIR }, { id: 'attachments', dir: ATTACH_DIR }];

/** Save one image into the tmp folder and return its absolute path. Only image types are taken. */
export async function saveTmpImage(file: File, dir = TMP_DIR): Promise<string> {
  const name = (file.name || 'image.png').replace(/[^\w.\-가-힣]+/g, '_').slice(0, 80);
  if (!IMAGE.test(name) || (file.type && !file.type.startsWith('image/'))) throw new Error('Only images can be saved to the tmp folder.');
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${randomUUID().slice(0, 8)}-${name}`);
  await fs.writeFile(dest, Buffer.from(await file.arrayBuffer()));
  return dest;
}

/** Every file under a folder (sub folders included), with its size. A missing folder has none. */
async function filesUnder(dir: string, depth = 0): Promise<{ path: string; size: number }[]> {
  if (depth > 4) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: { path: string; size: number }[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await filesUnder(p, depth + 1));
    else if (e.isFile()) { const st = await fs.stat(p).catch(() => null); if (st) out.push({ path: p, size: st.size }); }
  }
  return out;
}

export interface TempStat { id: TempTarget['id']; dir: string; files: number; bytes: number }

/** How many files each temp folder holds and their total size. */
export async function tempStats(targets = TEMP_TARGETS): Promise<TempStat[]> {
  return Promise.all(targets.map(async (t) => {
    const files = await filesUnder(t.dir);
    return { id: t.id, dir: t.dir, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
  }));
}

/**
 * Delete every file in the temp folders (the folders themselves stay). A file that cannot be removed (in use, as
 * Windows reports for an open file, or read-only) is skipped and counted, so one stuck file does not stop the rest.
 */
export async function clearTemp(targets = TEMP_TARGETS): Promise<{ deleted: number; bytes: number; failed: number }> {
  let deleted = 0, bytes = 0, failed = 0;
  for (const t of targets) {
    for (const f of await filesUnder(t.dir)) {
      try { await fs.rm(f.path, { force: true, maxRetries: 2 }); deleted++; bytes += f.size; } catch { failed++; }
    }
  }
  return { deleted, bytes, failed };
}
