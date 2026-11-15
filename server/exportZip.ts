import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FsError, resolvePath } from './fs.js';
import { zipFolder } from './os/files.js';

/**
 * Bundles an exported conversation as <name>.zip containing <name>/<name>.md and <name>/images/*.
 * Images arrive as absolute paths (copied) or data: URIs (decoded); a source that cannot be read is
 * reported in `missing` and left out rather than failing the whole export. Zipping is the platform's (os/files.ts).
 */

export interface ExportImageRef { name: string; src: string }
export interface ExportBundle { name: string; markdown: string; images: ExportImageRef[] }
export interface ExportOutcome { path: string; missing: string[] }

const SAFE_NAME = /^[^/\\\u0000-\u001f]{1,120}$/;
const SAFE_IMAGE = /^images\/[A-Za-z0-9._ -]{1,160}$/;

function dataUriBytes(src: string): Buffer {
  const comma = src.indexOf(',');
  if (comma < 0 || !/;base64,/.test(src.slice(0, comma + 1))) throw new Error('unsupported data URI');
  return Buffer.from(src.slice(comma + 1), 'base64');
}

/** Writes the bundle folder under a fresh temp dir and returns it; caller removes the temp dir. */
async function stage(bundle: ExportBundle, tmp: string): Promise<{ folder: string; missing: string[] }> {
  const folder = path.join(tmp, bundle.name);
  await fs.mkdir(path.join(folder, 'images'), { recursive: true });
  await fs.writeFile(path.join(folder, `${bundle.name}.md`), bundle.markdown, 'utf8');
  const missing: string[] = [];
  for (const im of bundle.images) {
    if (!SAFE_IMAGE.test(im.name)) { missing.push(im.name); continue; }
    const dest = path.join(folder, im.name);
    try {
      if (im.src.startsWith('data:')) await fs.writeFile(dest, dataUriBytes(im.src));
      else if (path.isAbsolute(im.src)) await fs.copyFile(im.src, dest);
      else throw new Error('not an absolute path');
    } catch {
      missing.push(im.src.startsWith('data:') ? im.name : im.src);
    }
  }
  return { folder, missing };
}

/**
 * Builds the zip at `dest` (absolute path chosen by the user). With no `dest`, returns the zip bytes
 * instead, for a browser tab that downloads rather than saves.
 */
export async function exportZip(bundle: ExportBundle, dest: string | null): Promise<ExportOutcome & { bytes?: Buffer }> {
  if (!SAFE_NAME.test(bundle.name) || bundle.name === '.' || bundle.name === '..') throw new FsError('EINVAL', 'Invalid export name', 400);
  if (typeof bundle.markdown !== 'string') throw new FsError('EINVAL', 'markdown must be a string', 400);
  const target = dest ? resolvePath(dest) : null;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vibrato-export-'));
  try {
    const { folder, missing } = await stage(bundle, tmp);
    const zip = target ?? path.join(tmp, `${bundle.name}.zip`);
    if (target) await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rm(zip, { force: true });
    const res = await zipFolder(folder, zip);
    if (!res.ok) throw new FsError('EEXPORT', res.stderr || 'zip failed', 500);
    return target ? { path: target, missing } : { path: zip, missing, bytes: await fs.readFile(zip) };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
