/*
 * Images the app makes for the user to attach (the composer's "Draw & insert" pad) live in <config>/tmp until the
 * user clears them (Settings > Temp files). Kept apart from <config>/attachments so clearing never touches files the
 * user attached themselves.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from './config.js';

export const TMP_DIR = path.join(CONFIG_DIR, 'tmp');
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

/** Save one image into the tmp folder and return its absolute path. Only image types are taken. */
export async function saveTmpImage(file: File, dir = TMP_DIR): Promise<string> {
  const name = (file.name || 'image.png').replace(/[^\w.\-가-힣]+/g, '_').slice(0, 80);
  if (!IMAGE.test(name) || (file.type && !file.type.startsWith('image/'))) throw new Error('Only images can be saved to the tmp folder.');
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${randomUUID().slice(0, 8)}-${name}`);
  await fs.writeFile(dest, Buffer.from(await file.arrayBuffer()));
  return dest;
}

/** How many images the tmp folder holds and their total size. A missing folder is empty. */
export async function tmpStats(dir = TMP_DIR): Promise<{ dir: string; files: number; bytes: number }> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  let files = 0, bytes = 0;
  for (const n of names) {
    if (!IMAGE.test(n)) continue;
    const st = await fs.stat(path.join(dir, n)).catch(() => null);
    if (!st?.isFile()) continue;
    files++; bytes += st.size;
  }
  return { dir, files, bytes };
}

/** Delete every image in the tmp folder (other files and folders stay). */
export async function clearTmpImages(dir = TMP_DIR): Promise<{ deleted: number; bytes: number }> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  let deleted = 0, bytes = 0;
  for (const n of names) {
    if (!IMAGE.test(n)) continue;
    const p = path.join(dir, n);
    const st = await fs.stat(p).catch(() => null);
    if (!st?.isFile()) continue;
    await fs.rm(p, { force: true });
    deleted++; bytes += st.size;
  }
  return { deleted, bytes };
}
