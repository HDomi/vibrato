import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FsError, resolvePath } from './fs.js';

/**
 * Sessions in their own git worktree, so two agents on one project do not overwrite each other.
 * Worktrees live next to the repository: <parent>/<repo>-wt/<branch>. Finishing one merges its branch
 * into the branch it started from (a merge commit, never a squash) and removes the worktree.
 */

export interface WorktreeInfo { path: string; branch: string; root: string; baseBranch: string | null }

function git(cwd: string, args: string[], timeout = 60000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], { timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout).trimEnd(), stderr: String(stderr || err?.message || '').trim() })));
}

const fail = (message: string, code = 'WORKTREE', status = 409) => new FsError(code, message, status);

export function sanitizeBranch(name: string): string {
  return name.trim().replace(/[^\w./-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-./]+|[-./]+$/g, '').replace(/\/{2,}/g, '/').slice(0, 80);
}

/** Main working tree of the repository `cwd` belongs to (even when `cwd` is itself a linked worktree). */
async function mainRoot(cwd: string): Promise<string> {
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) throw fail('Not a git repository', 'NOT_GIT', 400);
  // Git prints paths with `/` on every platform: normalize to the platform's own form before comparing.
  return path.dirname(path.normalize(common.stdout));
}

export async function createWorktree(cwd: string, wanted?: string): Promise<WorktreeInfo> {
  const root = await mainRoot(resolvePath(cwd));
  const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const baseBranch = head.ok && head.stdout !== 'HEAD' ? head.stdout : null;
  if (!(await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok) throw fail('The repository has no commits yet; commit once before starting a worktree session.');
  let branch = sanitizeBranch(wanted || '') || `vibe/${new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')}`;
  // Pick a free branch name: vibe/x, vibe/x-2, ...
  for (let n = 2; (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok; n++) branch = `${branch.replace(/-\d+$/, '')}-${n}`;
  const dir = path.join(path.dirname(root), `${path.basename(root)}-wt`, branch.replace(/\//g, '-'));
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const add = await git(root, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  if (!add.ok) throw fail(add.stderr || 'git worktree add failed');
  // Remembered on the branch so the worktree list can offer the merge after the session is gone.
  if (baseBranch) await git(root, ['config', `branch.${branch}.vibeBase`, baseBranch]);
  // Dependencies are not in git; share the main checkout's node_modules so builds and checks work at once.
  const nm = path.join(root, 'node_modules');
  if (await fs.stat(nm).then((s) => s.isDirectory(), () => false)) {
    await fs.symlink(nm, path.join(dir, 'node_modules'), 'dir').catch(() => {});
    // A symlink is not matched by a "node_modules/" ignore rule; keep it out of commits and snapshots.
    const exclude = path.join(root, '.git', 'info', 'exclude');
    const cur = await fs.readFile(exclude, 'utf8').catch(() => '');
    if (!/^\/?node_modules$/m.test(cur)) await fs.mkdir(path.dirname(exclude), { recursive: true }).then(() => fs.appendFile(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}node_modules\n`)).catch(() => {});
  }
  return { path: dir, branch, root, baseBranch };
}

/** Only folders this app creates (<parent>/<repo>-wt/<name>) can be merged or removed through the API. */
export function checkWorktree(info: unknown): WorktreeInfo {
  const i = info as Partial<WorktreeInfo> | null;
  if (!i || typeof i.path !== 'string' || typeof i.root !== 'string' || typeof i.branch !== 'string') throw fail('Invalid worktree', 'BAD_REQUEST', 400);
  const root = resolvePath(i.root);
  const dir = resolvePath(i.path);
  if (path.dirname(dir) !== path.join(path.dirname(root), `${path.basename(root)}-wt`) || sanitizeBranch(i.branch) !== i.branch) throw fail('Not a worktree created by this app', 'BAD_REQUEST', 400);
  return { path: dir, root, branch: i.branch, baseBranch: typeof i.baseBranch === 'string' ? i.baseBranch : null };
}

export interface WorktreeStatus { exists: boolean; dirty: string[]; ahead: number; branch: string | null }

export async function worktreeStatus(info: WorktreeInfo): Promise<WorktreeStatus> {
  const dir = resolvePath(info.path);
  if (!(await fs.stat(dir).then(() => true, () => false))) return { exists: false, dirty: [], ahead: 0, branch: null };
  const [st, br, ahead] = await Promise.all([
    git(dir, ['status', '--porcelain=v1']),
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    info.baseBranch ? git(dir, ['rev-list', '--count', `${info.baseBranch}..HEAD`]) : Promise.resolve({ ok: false, stdout: '0', stderr: '' }),
  ]);
  return { exists: true, dirty: st.ok ? st.stdout.split('\n').filter(Boolean).map((l) => l.slice(3)) : [], ahead: Number(ahead.stdout) || 0, branch: br.ok ? br.stdout : null };
}

export interface MergeResult { ok: boolean; merged: boolean; removed: boolean; message: string; conflicts?: string[]; reason?: 'missing' | 'dirty' | 'mainDirty' | 'detached' | 'branch' | 'conflict' | 'git' }

/**
 * Merge the worktree's branch into its base branch in the main checkout, then remove the worktree and
 * the branch. Stops without touching anything when the worktree has uncommitted changes, when the
 * main checkout is on another branch, or when the merge conflicts (which is aborted).
 */
export async function mergeWorktree(info: WorktreeInfo, commitMessage?: string): Promise<MergeResult> {
  let st = await worktreeStatus(info);
  // Agents rarely commit; with a message the leftover changes are committed on the branch first.
  if (st.exists && st.dirty.length && commitMessage?.trim()) {
    const dir = resolvePath(info.path);
    const add = await git(dir, ['add', '-A']);
    const commit = add.ok ? await git(dir, ['commit', '-q', '-m', commitMessage.trim().slice(0, 500)]) : add;
    if (!commit.ok) return { ok: false, merged: false, removed: false, message: commit.stderr || 'git commit failed', reason: 'git' };
    st = await worktreeStatus(info);
  }
  if (!st.exists) return { ok: false, merged: false, removed: false, message: 'The worktree folder no longer exists.', reason: 'missing' };
  if (st.dirty.length) return { ok: false, merged: false, removed: false, message: `Uncommitted changes in the worktree (${st.dirty.length}). Commit or discard them first.`, conflicts: st.dirty.slice(0, 20), reason: 'dirty' };
  if (!info.baseBranch) return { ok: false, merged: false, removed: false, message: 'The session started from a detached HEAD; merge the branch by hand.', reason: 'detached' };
  const root = resolvePath(info.root);
  const cur = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (cur.stdout !== info.baseBranch) return { ok: false, merged: false, removed: false, message: `The main checkout is on "${cur.stdout}", not "${info.baseBranch}". Switch back first.`, reason: 'branch' };
  // A failed merge is aborted, and git cannot always restore uncommitted edits around an abort.
  const mainSt = await git(root, ['status', '--porcelain=v1', '--untracked-files=no']);
  const mainDirty = mainSt.stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
  if (mainDirty.length) return { ok: false, merged: false, removed: false, message: `The main checkout has uncommitted changes (${mainDirty.length}). Commit or stash them first.`, conflicts: mainDirty.slice(0, 20), reason: 'mainDirty' };
  let merged = false;
  if (st.ahead > 0) {
    const m = await git(root, ['merge', '--no-ff', '--no-edit', '-m', `Merge branch '${info.branch}'`, info.branch], 120000);
    if (!m.ok) {
      const conflicts = (await git(root, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
      await git(root, ['merge', '--abort']);
      return { ok: false, merged: false, removed: false, message: conflicts.length ? 'The merge conflicts; nothing was changed.' : m.stderr || 'git merge failed', conflicts, reason: conflicts.length ? 'conflict' : 'git' };
    }
    merged = true;
  }
  const removed = await removeWorktree(info, false);
  return { ok: true, merged, removed: removed.ok, message: removed.ok ? (merged ? `Merged ${info.branch} into ${info.baseBranch}.` : 'Nothing to merge; worktree removed.') : removed.message };
}

/** Remove the worktree folder and its branch. Without `force`, refuses uncommitted or unmerged work. */
export async function removeWorktree(info: WorktreeInfo, force: boolean): Promise<{ ok: boolean; message: string }> {
  const root = resolvePath(info.root);
  const dir = resolvePath(info.path);
  if (!force) {
    const st = await worktreeStatus(info);
    if (st.dirty.length) return { ok: false, message: `Uncommitted changes in the worktree (${st.dirty.length}).` };
  }
  await fs.rm(path.join(dir, 'node_modules')).catch(() => {}); // our symlink only; never the target
  const rm = await git(root, ['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
  if (!rm.ok && await fs.stat(dir).then(() => true, () => false)) return { ok: false, message: rm.stderr || 'git worktree remove failed' };
  await git(root, ['worktree', 'prune']);
  const del = await git(root, ['branch', force ? '-D' : '-d', info.branch]);
  return { ok: true, message: del.ok ? '' : `Worktree removed; branch ${info.branch} kept (${del.stderr}).` };
}

/** Worktrees this app created for the repository of `cwd` (folders under <repo>-wt/), for the start screen. */
export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  let root: string;
  try { root = await mainRoot(resolvePath(cwd)); } catch { return []; }
  const parent = path.join(path.dirname(root), `${path.basename(root)}-wt`);
  const r = await git(root, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const out: WorktreeInfo[] = [];
  for (const block of r.stdout.split('\n\n')) {
    const listed = block.match(/^worktree (.+)$/m)?.[1];
    const dir = listed && path.normalize(listed);
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (!dir || !branch || path.dirname(dir) !== parent) continue;
    const base = (await git(root, ['config', '--get', `branch.${branch}.vibeBase`])).stdout.trim() || null;
    out.push({ path: dir, branch, root, baseBranch: base });
  }
  return out;
}
