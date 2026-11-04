import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { mimeOf, previewKind, type PreviewKind } from './mime.js';

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
  /** When the file was created (stat only). */
  birthtime?: number;
  /** The path with symlinks resolved (stat only): /tmp/x is /private/tmp/x on macOS. */
  real?: string;
  ext: string;
  hidden: boolean;
  kind: PreviewKind;
}

export class FsError extends Error {
  constructor(public code: string, message: string, public status = 500) {
    super(message);
  }
}

function wrap(err: unknown, p: string): never {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'ENOENT') throw new FsError('ENOENT', `Not found: ${p}`, 404);
  if (e.code === 'EEXIST') throw new FsError('EEXIST', `Already exists: ${p}`, 409);
  if (e.code === 'EACCES' || e.code === 'EPERM') {
    throw new FsError('EACCES', `Permission denied: ${p}. Allow folder access for this app in macOS Privacy & Security settings.`, 403);
  }
  if (e.code === 'ENOTDIR') throw new FsError('ENOTDIR', `Not a directory: ${p}`, 400);
  throw new FsError(e.code ?? 'UNKNOWN', e.message ?? String(err), 500);
}

export function resolvePath(input: string | undefined): string {
  if (!input || input === '~') return homedir();
  if (input.startsWith('~/')) return path.join(homedir(), input.slice(2));
  return path.resolve(input);
}

export async function listDir(dir: string): Promise<{ path: string; parent: string | null; entries: Entry[] }> {
  const abs = resolvePath(dir);
  try {
    const dirents = await fs.readdir(abs, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (d): Promise<Entry | null> => {
        const full = path.join(abs, d.name);
        try {
          const st = await fs.stat(full);
          const isDir = st.isDirectory();
          const ext = isDir ? '' : path.extname(d.name);
          return {
            name: d.name,
            path: full,
            isDir,
            size: st.size,
            mtime: st.mtimeMs,
            ext,
            hidden: d.name.startsWith('.'),
            kind: isDir ? 'binary' : previewKind(ext, d.name),
          };
        } catch {
          return null;
        }
      }),
    );
    const list = entries.filter((e): e is Entry => e !== null);
    list.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.isDir ? -1 : 1));
    const parent = path.dirname(abs);
    return { path: abs, parent: parent === abs ? null : parent, entries: list };
  } catch (err) {
    wrap(err, abs);
  }
}

export async function statPath(p: string): Promise<Entry> {
  const abs = resolvePath(p);
  try {
    const st = await fs.stat(abs);
    const name = path.basename(abs);
    const isDir = st.isDirectory();
    const ext = isDir ? '' : path.extname(name);
    const real = await fs.realpath(abs).catch(() => abs);
    return {
      name, path: abs, isDir, size: st.size, mtime: st.mtimeMs, birthtime: st.birthtimeMs, real, ext,
      hidden: name.startsWith('.'),
      kind: isDir ? 'binary' : previewKind(ext, name),
    };
  } catch (err) {
    wrap(err, abs);
  }
}

const TEXT_LIMIT = 2 * 1024 * 1024;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface TextFile {
  content: string;
  truncated: boolean;
  size: number;
  mtime: number;
  /** NUL bytes in the first 8 KB: shown as binary, never edited. */
  binary: boolean;
  /** Bytes that are not valid UTF-8 were replaced with U+FFFD; saving would corrupt them. */
  lossy: boolean;
  /** A UTF-8 byte-order mark was stripped from `content`; writeText puts it back. */
  bom: boolean;
}

export async function readText(p: string): Promise<TextFile> {
  const abs = resolvePath(p);
  try {
    const st = await fs.stat(abs);
    if (st.isDirectory()) throw new FsError('EISDIR', `Is a directory: ${abs}`, 400);
    // FIFOs, sockets and devices would block a libuv thread or stream forever.
    if (!st.isFile()) throw new FsError('ENOTFILE', `Not a regular file: ${abs}`, 400);
    const fh = await fs.open(abs, 'r');
    try {
      const len = Math.min(st.size, TEXT_LIMIT);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, 0);
      let data = buf.subarray(0, bytesRead);
      const truncated = st.size > TEXT_LIMIT;
      const binary = data.subarray(0, 8192).includes(0);
      const bom = data.subarray(0, 3).equals(BOM);
      if (bom) data = data.subarray(3);
      let content: string; let lossy = false;
      // A cut at TEXT_LIMIT can split a multi-byte character; only a whole file must decode cleanly.
      try { content = truncated ? data.toString('utf8') : utf8.decode(data); } catch { content = data.toString('utf8'); lossy = true; }
      return { content: binary ? '' : content, truncated, size: st.size, mtime: st.mtimeMs, binary, lossy, bom };
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (err instanceof FsError) throw err;
    wrap(err, abs);
  }
}

/**
 * Save an editor buffer. `baseMtime` is the mtime the editor loaded; when the file changed on disk
 * since (an agent, git, another editor), this refuses with 409 unless `force` is set, so a stale
 * buffer never silently overwrites newer work. Writes in place: symlinks, hard links, permissions
 * and extended attributes stay as they were.
 */
export async function writeText(p: string, content: string, opts: { baseMtime?: number | null; bom?: boolean; force?: boolean } = {}): Promise<{ mtime: number; size: number }> {
  const abs = resolvePath(p);
  if (typeof content !== 'string') throw new FsError('EINVAL', 'content must be a string', 400);
  try {
    let exists = true;
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) throw new FsError('ENOTFILE', `Not a regular file: ${abs}`, 400);
      if (!opts.force && opts.baseMtime != null && Math.abs(st.mtimeMs - opts.baseMtime) > 1) {
        throw new FsError('ECONFLICT', `Changed on disk since it was opened: ${abs}`, 409);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      exists = false;
    }
    // A deleted file is only recreated on purpose (force), never by a save racing an agent's delete.
    if (!exists && !opts.force && opts.baseMtime != null) throw new FsError('ECONFLICT', `Deleted on disk since it was opened: ${abs}`, 409);
    const body = Buffer.from(content, 'utf8');
    await fs.writeFile(abs, opts.bom ? Buffer.concat([BOM, body]) : body);
    const st = await fs.stat(abs);
    return { mtime: st.mtimeMs, size: st.size };
  } catch (err) {
    if (err instanceof FsError) throw err;
    wrap(err, abs);
  }
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream | null;
}

export async function rawFile(p: string, rangeHeader: string | undefined): Promise<RawResponse> {
  const abs = resolvePath(p);
  let size: number;
  try {
    const st = await fs.stat(abs);
    if (st.isDirectory()) throw new FsError('EISDIR', `Is a directory: ${abs}`, 400);
    if (!st.isFile()) throw new FsError('ENOTFILE', `Not a regular file: ${abs}`, 400);
    size = st.size;
  } catch (err) {
    if (err instanceof FsError) throw err;
    wrap(err, abs);
  }
  const mime = mimeOf(path.extname(abs));
  const base: Record<string, string> = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  // Served from the app's own origin: an .html/.svg opened as a document must not run script with
  // access to the API. PDFs are exempt because Chromium refuses to render them in sandboxed frames.
  if (mime !== 'application/pdf') base['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

  const m = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (m) {
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (!m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    if (start >= size || start > end) {
      return { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` }, body: null };
    }
    const stream = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream;
    return {
      status: 206,
      headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
      body: stream,
    };
  }
  const stream = Readable.toWeb(createReadStream(abs)) as ReadableStream;
  return { status: 200, headers: { ...base, 'Content-Length': String(size) }, body: stream };
}

export async function homeInfo(): Promise<{ home: string; volumes: string[]; shortcuts: { name: string; path: string }[] }> {
  const home = homedir();
  let volumes: string[] = [];
  try {
    volumes = (await fs.readdir('/Volumes')).map((v) => path.join('/Volumes', v));
  } catch { /* ignore */ }
  const shortcuts = ['Desktop', 'Documents', 'Downloads', 'Dev']
    .map((n) => ({ name: n, path: path.join(home, n) }));
  const existing: { name: string; path: string }[] = [];
  for (const s of shortcuts) {
    try { await fs.access(s.path); existing.push(s); } catch { /* skip */ }
  }
  return { home, volumes, shortcuts: existing };
}

/** Recursive file search for quick-open; skips heavy folders. Case-insensitive substring / subsequence match on the relative path. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'target', '.venv', 'venv', '__pycache__', '.cache', 'Library', '.Trash', 'DerivedData', 'Pods']);
export async function searchFiles(root: string, query: string, limit = 200): Promise<{ path: string; rel: string; isDir: boolean }[]> {
  const base = resolvePath(root);
  const q = query.toLowerCase().replace(/\s+/g, '');
  const out: { path: string; rel: string; isDir: boolean; score: number }[] = [];
  const subseq = (hay: string) => { let i = 0; for (const ch of hay) { if (ch === q[i]) i++; if (i === q.length) return true; } return q.length === 0; };
  let visited = 0;
  async function walk(dir: string, depth: number) {
    if (out.length >= limit * 4 || depth > 8 || visited > 20000) return;
    let dirents;
    try { dirents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      visited++;
      if (d.name.startsWith('.') && d.name !== '.claude') continue;
      const full = path.join(dir, d.name);
      const rel = path.relative(base, full);
      const lower = rel.toLowerCase();
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        if (q && subseq(lower)) out.push({ path: full, rel, isDir: true, score: lower.includes(q) ? 2 : 1 });
        await walk(full, depth + 1);
      } else if (!q || subseq(lower)) {
        const name = d.name.toLowerCase();
        out.push({ path: full, rel, isDir: false, score: name.startsWith(q) ? 5 : name.includes(q) ? 4 : lower.includes(q) ? 3 : 1 });
      }
    }
  }
  await walk(base, 0);
  return out.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length).slice(0, limit).map(({ path: p, rel, isDir }) => ({ path: p, rel, isDir }));
}

/** `.env`, `.env.local`, `.env.example`, `app.env` … under a project, a few levels deep (monorepo packages). */
export async function findEnvFiles(root: string, maxDepth = 4): Promise<{ path: string; rel: string; size: number }[]> {
  const base = resolvePath(root);
  const out: { path: string; rel: string; size: number }[] = [];
  async function walk(dir: string, depth: number) {
    if (depth > maxDepth || out.length >= 200) return;
    let dirents;
    try { dirents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name) && !d.name.startsWith('.')) await walk(full, depth + 1);
      } else if (d.isFile() && /^\.env(\..+)?$|\.env$/i.test(d.name)) {
        const st = await fs.stat(full).catch(() => null);
        if (st && st.size <= 1024 * 1024) out.push({ path: full, rel: path.relative(base, full), size: st.size });
      }
    }
  }
  await walk(base, 0);
  return out.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel));
}

/* ── Mutations used by the file browser ───────────────────────────── */

async function uniqueDest(dest: string): Promise<string> {
  let candidate = dest;
  for (let i = 2; i < 1000; i++) {
    try { await fs.access(candidate); } catch { return candidate; }
    const ext = path.extname(dest);
    const base = ext ? dest.slice(0, -ext.length) : dest;
    candidate = `${base} ${i}${ext}`;
  }
  throw new FsError('EEXIST', `Too many copies: ${dest}`, 409);
}

export async function mkdir(dir: string, name: string): Promise<string> {
  if (typeof name !== 'string' || name.includes('/') || !name.trim() || name === '.' || name === '..') throw new FsError('EINVAL', 'Invalid name', 400);
  const abs = path.join(resolvePath(dir), name);
  try { await fs.mkdir(abs); return abs; } catch (err) { wrap(err, abs); }
}

export async function createFile(dir: string, name: string): Promise<string> {
  if (typeof name !== 'string' || name.includes('/') || !name.trim() || name === '.' || name === '..') throw new FsError('EINVAL', 'Invalid name', 400);
  const abs = path.join(resolvePath(dir), name);
  try { await fs.writeFile(abs, '', { flag: 'wx' }); return abs; } catch (err) { wrap(err, abs); }
}

export async function rename(p: string, newName: string): Promise<string> {
  const abs = resolvePath(p);
  if (typeof newName !== 'string' || newName.includes('/') || !newName.trim() || newName === '.' || newName === '..') throw new FsError('EINVAL', 'Invalid name', 400);
  const dest = path.join(path.dirname(abs), newName);
  try { await fs.access(dest); throw new FsError('EEXIST', `Already exists: ${dest}`, 409); } catch (err) { if (err instanceof FsError) throw err; }
  try { await fs.rename(abs, dest); return dest; } catch (err) { wrap(err, abs); }
}

/** Copy (or move) entries into a directory; names are de-duplicated like Finder. */
export async function transfer(paths: string[], destDir: string, move: boolean): Promise<string[]> {
  const dir = resolvePath(destDir);
  const out: string[] = [];
  for (const p of paths) {
    const src = resolvePath(p);
    if (move && path.dirname(src) === dir) { out.push(src); continue; }
    const dest = await uniqueDest(path.join(dir, path.basename(src)));
    if (src === dest) continue;
    try {
      if (move) {
        try { await fs.rename(src, dest); } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
          await fs.cp(src, dest, { recursive: true, errorOnExist: true, force: false });
          await fs.rm(src, { recursive: true });
        }
      } else {
        await fs.cp(src, dest, { recursive: true });
      }
      out.push(dest);
    } catch (err) { wrap(err, src); }
  }
  return out;
}

export async function duplicate(p: string): Promise<string> {
  const src = resolvePath(p);
  const ext = path.extname(src);
  const base = ext ? src.slice(0, -ext.length) : src;
  const dest = await uniqueDest(`${base} copy${ext}`);
  try { await fs.cp(src, dest, { recursive: true }); return dest; } catch (err) { wrap(err, src); }
}

/** Move to the macOS Trash via Finder so the user can restore it. */
export async function trash(paths: string[]): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const abs = paths.map((p) => resolvePath(p));
  if (!abs.length) return;
  // Paths go in as argv, never spliced into the script: a crafted file name cannot escape the string.
  const script = [
    'on run argv',
    'set targets to {}',
    'repeat with p in argv',
    'set end of targets to (POSIX file (p as text))',
    'end repeat',
    'tell application "Finder" to delete targets',
    'end run',
  ];
  try {
    await promisify(execFile)('osascript', [...script.flatMap((l) => ['-e', l]), '--', ...abs], { timeout: 20000 });
  } catch (err) {
    throw new FsError('ETRASH', `Could not move to Trash: ${(err as Error).message}`, 500);
  }
}
