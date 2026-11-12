import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FsError, resolvePath } from './fs.js';

/**
 * Per-turn change tracking for any agent: before a turn the working tree (tracked + untracked, minus
 * ignored files) is written to a git tree object through a throwaway index, and again after it. The
 * difference between the two trees is exactly what happened during the turn, independent of earlier
 * uncommitted work, and either tree can be used to put files back.
 */

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export interface TurnFile { path: string; status: 'A' | 'M' | 'D'; additions: number; deletions: number; binary: boolean }
export interface Snapshot { root: string; tree: string }

function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeout?: number; input?: string; signal?: AbortSignal } = {}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-C', cwd, ...args],
      { env: { ...process.env, ...opts.env }, timeout: opts.timeout ?? 30000, maxBuffer: 64 * 1024 * 1024, signal: opts.signal },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err?.message ?? '')) }));
    if (opts.input !== undefined) { child.stdin?.end(opts.input); }
  });
}

export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(resolvePath(cwd), ['rev-parse', '--show-toplevel'], { timeout: 5000 });
  return r.ok ? r.stdout.trim() : null;
}

/** Snapshots of one repository run one at a time: overlapping `git add -A` passes over a big tree only slow each other down. */
const snapshotQueue = new Map<string, Promise<unknown>>();

/**
 * Tree object of the working tree right now; null outside a git repository or when git fails.
 * Aborting `signal` kills the git process (or skips the snapshot while it still waits its turn) and gives null.
 */
export async function snapshot(cwd: string, timeout = 20000, signal?: AbortSignal): Promise<Snapshot | null> {
  const root = await repoRoot(cwd);
  if (!root || signal?.aborted) return null;
  const job = (snapshotQueue.get(root) ?? Promise.resolve()).then(() => (signal?.aborted ? null : takeSnapshot(root, timeout, signal)));
  const tail = job.catch(() => null);
  snapshotQueue.set(root, tail);
  void tail.then(() => { if (snapshotQueue.get(root) === tail) snapshotQueue.delete(root); });
  return job;
}

async function takeSnapshot(root: string, timeout: number, signal?: AbortSignal): Promise<Snapshot | null> {
  const dir = await mkdtemp(path.join(tmpdir(), 'vibrato-snap-'));
  const index = path.join(dir, 'index');
  try {
    // Starting from the real index lets `git add` skip files whose stat data did not change.
    const real = await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { signal });
    if (real.ok) await copyFile(real.stdout.trim(), index).catch(() => {});
    const env = { GIT_INDEX_FILE: index };
    const add = await git(root, ['add', '-A', '--', '.'], { env, timeout, signal });
    if (!add.ok) return null;
    const tree = await git(root, ['write-tree'], { env, signal });
    return tree.ok && SHA.test(tree.stdout.trim()) ? { root, tree: tree.stdout.trim() } : null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Files that differ between two snapshots, with line counts (binary files count as 0/0). */
export async function changedFiles(root: string, from: string, to: string): Promise<TurnFile[]> {
  if (from === to) return [];
  const [status, num] = await Promise.all([
    git(root, ['diff', '--no-renames', '--name-status', '-z', from, to]),
    git(root, ['diff', '--no-renames', '--numstat', '-z', from, to]),
  ]);
  if (!status.ok || !num.ok) return [];
  const counts = new Map<string, { a: number; d: number; bin: boolean }>();
  for (const rec of num.stdout.split('\0')) {
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (m) counts.set(m[3], { a: m[1] === '-' ? 0 : Number(m[1]), d: m[2] === '-' ? 0 : Number(m[2]), bin: m[1] === '-' });
  }
  const parts = status.stdout.split('\0').filter(Boolean);
  const out: TurnFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i][0];
    const p = parts[i + 1];
    const c = counts.get(p) ?? { a: 0, d: 0, bin: false };
    out.push({ path: p, status: code === 'A' ? 'A' : code === 'D' ? 'D' : 'M', additions: c.a, deletions: c.d, binary: c.bin });
  }
  return out;
}

function checkArgs(root: string, from: string, to: string, file?: string) {
  if (!SHA.test(from) || !SHA.test(to)) throw new FsError('BAD_REQUEST', 'Invalid snapshot id', 400);
  const abs = resolvePath(root);
  if (file !== undefined) {
    const target = path.resolve(abs, file);
    if (!file || path.isAbsolute(file) || (target !== abs && !target.startsWith(abs + path.sep))) throw new FsError('BAD_REQUEST', 'Path outside the repository', 400);
  }
  return abs;
}

/** Unified diff of one file between two snapshots; the whole turn when `file` is empty. */
export async function turnDiff(root: string, from: string, to: string, file: string): Promise<string> {
  const abs = checkArgs(root, from, to, file || undefined);
  const r = await git(abs, ['diff', '--no-color', '--no-ext-diff', '--no-renames', from, to, ...(file ? ['--', file] : [])]);
  if (!r.ok) throw new FsError('GIT', r.stderr || 'git diff failed', 500);
  return r.stdout;
}

/** Split a one-file unified diff into its header and hunks (each hunk starts with "@@"). */
export function splitHunks(diff: string): { header: string; hunks: string[] } {
  const lines = diff.split('\n');
  const first = lines.findIndex((l) => l.startsWith('@@'));
  if (first < 0) return { header: diff, hunks: [] };
  const header = lines.slice(0, first).join('\n');
  const hunks: string[] = [];
  let cur: string[] = [];
  for (const l of lines.slice(first)) {
    if (l.startsWith('@@') && cur.length) { hunks.push(cur.join('\n')); cur = []; }
    cur.push(l);
  }
  if (cur.length) hunks.push(cur.join('\n').replace(/\n$/, ''));
  return { header, hunks };
}

async function blobOf(root: string, rev: string, file: string): Promise<string | null> {
  const r = await git(root, ['rev-parse', '--verify', '--quiet', `${rev}:${file}`]);
  return r.ok ? r.stdout.trim() : null;
}

export interface RevertResult { ok: boolean; reverted: string[]; conflicts: string[]; error?: string }

/**
 * Put files back the way they were before the turn. A file that changed again after the turn is left
 * alone (listed in `conflicts`) unless `force`; a single hunk is reverse-applied with git apply, which
 * refuses on its own when the surrounding lines moved on.
 */
export async function revertTurn(root: string, from: string, to: string, opts: { files?: string[]; hunk?: { file: string; index: number }; force?: boolean }): Promise<RevertResult> {
  const abs = checkArgs(root, from, to);
  if (opts.hunk) {
    checkArgs(abs, from, to, opts.hunk.file);
    const { header, hunks } = splitHunks(await turnDiff(abs, from, to, opts.hunk.file));
    const h = hunks[opts.hunk.index];
    if (!h) return { ok: false, reverted: [], conflicts: [], error: 'Hunk not found' };
    const dir = await mkdtemp(path.join(tmpdir(), 'vibrato-hunk-'));
    try {
      const patch = path.join(dir, 'p.diff');
      await writeFile(patch, `${header}\n${h}\n`);
      const r = await git(abs, ['apply', '-R', '--recount', '--whitespace=nowarn', patch]);
      return r.ok ? { ok: true, reverted: [opts.hunk.file], conflicts: [] } : { ok: false, reverted: [], conflicts: [opts.hunk.file], error: r.stderr.trim() };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  const all = await changedFiles(abs, from, to);
  const wanted = opts.files ? all.filter((f) => opts.files!.includes(f.path)) : all;
  const now = opts.force ? null : await snapshot(abs);
  const reverted: string[] = []; const conflicts: string[] = [];
  const restore: string[] = [];
  for (const f of wanted) {
    checkArgs(abs, from, to, f.path);
    if (now) {
      const [cur, after] = await Promise.all([blobOf(abs, now.tree, f.path), blobOf(abs, to, f.path)]);
      if (cur !== after) { conflicts.push(f.path); continue; }
    }
    if (await blobOf(abs, from, f.path)) restore.push(f.path);
    else {
      // Created by the turn: removing it is the undo (its content stays in the `to` snapshot). rm unlinks a symlink itself.
      await rm(path.join(abs, f.path), { force: true });
      reverted.push(f.path);
    }
  }
  if (restore.length) {
    // git writes the old entries itself: file mode, symlinks and binary content come back exactly, and an
    // existing symlink at the path is replaced rather than written through.
    const dir = await mkdtemp(path.join(tmpdir(), 'vibrato-restore-'));
    try {
      const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
      const read = await git(abs, ['read-tree', from], { env });
      if (!read.ok) throw new FsError('GIT', read.stderr || 'git read-tree failed', 500);
      const out = await git(abs, ['checkout-index', '-f', '--', ...restore], { env });
      if (!out.ok) throw new FsError('GIT', out.stderr || 'git checkout-index failed', 500);
      reverted.push(...restore);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  return { ok: conflicts.length === 0, reverted, conflicts };
}

/** Repository-relative form of a path a tool reported (macOS reports /tmp and /var through /private). */
export function repoRelative(root: string, p: string): string | null {
  const strip = (x: string) => x.replace(/^\/private(?=\/(?:tmp|var)\/)/, '');
  const rel = path.relative(strip(root), strip(path.resolve(root, p)));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
}
