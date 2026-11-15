import path from 'node:path';
import { run } from './shell.js';
import { resolvePath } from './fs.js';

export interface GitFile { path: string; index: string; worktree: string; staged: boolean; untracked: boolean }
export interface GitStatus { repo: boolean; root: string | null; branch: string | null; ahead: number; behind: number; files: GitFile[] }

async function git(cwd: string, args: string[], timeout = 30000) {
  return run('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], timeout);
}

export async function gitStatus(dir: string): Promise<GitStatus> {
  const cwd = resolvePath(dir);
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root.ok) return { repo: false, root: null, branch: null, ahead: 0, behind: 0, files: [] };
  const st = await git(cwd, ['status', '--porcelain=v1', '--branch', '-z']);
  if (!st.ok) throw new Error(st.stderr || 'git status failed');
  const parts = st.stdout.split('\0');
  const head = parts.shift() ?? '';
  let branch: string | null = null; let ahead = 0; let behind = 0;
  const bm = head.replace(/^## (?:No commits yet on|Initial commit on) /, '## ').match(/^## (\S+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/);
  if (bm) {
    branch = bm[1].replace(/^No commits yet on /, '');
    const info = bm[3] ?? '';
    ahead = Number(info.match(/ahead (\d+)/)?.[1] ?? 0);
    behind = Number(info.match(/behind (\d+)/)?.[1] ?? 0);
  }
  const files: GitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const index = p[0]; const worktree = p[1]; const path = p.slice(3);
    if (index === 'R' || index === 'C') i++; // skip rename source entry
    files.push({ path, index, worktree, staged: index !== ' ' && index !== '?', untracked: index === '?' });
  }
  return { repo: true, root: path.normalize(root.stdout), branch, ahead, behind, files };
}

export async function gitDiff(dir: string, path: string, staged: boolean): Promise<string> {
  const cwd = resolvePath(dir);
  const args = ['diff', '--no-ext-diff', '--no-textconv', ...(staged ? ['--cached'] : []), '--', path];
  const r = await git(cwd, args);
  if (!r.ok) throw new Error(r.stderr || 'git diff failed');
  if (r.stdout || staged) return r.stdout;
  const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', path]);
  if (tracked.ok) return '';
  // Untracked file: show the whole file as additions.
  const nt = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', path]);
  if (nt.stderr) throw new Error(nt.stderr);
  return nt.stdout || r.stderr || '';
}

export async function gitStage(dir: string, paths: string[], action: 'add' | 'reset' | 'discard'): Promise<void> {
  const cwd = resolvePath(dir);
  if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== 'string' || !p)) throw new Error('File paths required');
  if (!['add', 'reset', 'discard'].includes(action)) throw new Error('Invalid staging action');
  const r = await git(cwd, action === 'add' ? ['add', '--', ...paths] : action === 'reset' ? ['reset', '-q', '--', ...paths] : ['checkout', '--', ...paths]);
  if (!r.ok) throw new Error(r.stderr || r.stdout || 'git stage failed');
}

export async function gitCommit(dir: string, message: string): Promise<{ ok: boolean; output: string }> {
  const cwd = resolvePath(dir);
  const r = await git(cwd, ['commit', '-m', message]);
  return { ok: r.ok, output: r.ok ? r.stdout : r.stderr || r.stdout };
}

export interface GitCommit { hash: string; parents: string[]; refs: string[]; subject: string; author: string; date: string }

/** A page of the commit log. `hasMore` is derived by asking for one extra row. */
export async function gitLog(dir: string, skip = 0, limit = 30): Promise<{ commits: GitCommit[]; hasMore: boolean }> {
  const cwd = resolvePath(dir);
  const lim = Math.max(1, Math.min(200, limit));
  const r = await git(cwd, ['log', '--all', '--ignore-missing', '--topo-order', '--decorate=short', `--skip=${Math.max(0, skip)}`, `-${lim + 1}`, '--format=%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%ar', 'HEAD']);
  if (!r.ok) return { commits: [], hasMore: false };
  const rows = r.stdout.split('\n').filter(Boolean).map((l) => {
    const [hash, parents, refs, subject, author, date] = l.split('\x1f');
    return { hash, parents: parents ? parents.split(' ') : [], refs: refs ? refs.split(', ') : [], subject, author, date };
  });
  return { commits: rows.slice(0, lim), hasMore: rows.length > lim };
}

export interface GitCommitFile { path: string; status: string; oldPath?: string }

const HASH_RE = /^[0-9a-f]{4,64}$/i;

/** Files a commit changed, against its first parent (merges) or the empty tree (root commit). */
export async function gitCommitFiles(dir: string, hash: string): Promise<GitCommitFile[]> {
  const cwd = resolvePath(dir);
  if (!HASH_RE.test(hash)) throw new Error('Invalid commit hash');
  const r = await git(cwd, ['show', '--format=', '--name-status', '-z', '-M', '--diff-merges=first-parent', hash]);
  if (!r.ok) throw new Error(r.stderr || 'git show failed');
  const parts = r.stdout.split('\0').filter((p, i, a) => p || i < a.length - 1);
  const files: GitCommitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i].trim();
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') { files.push({ status: status[0], oldPath: parts[i + 1], path: parts[i + 2] }); i += 2; }
    else { files.push({ status: status[0], path: parts[i + 1] }); i += 1; }
  }
  return files.filter((f) => f.path);
}

/** Patch of one file in a commit, same base as gitCommitFiles. */
export async function gitCommitDiff(dir: string, hash: string, path: string): Promise<string> {
  const cwd = resolvePath(dir);
  if (!HASH_RE.test(hash)) throw new Error('Invalid commit hash');
  if (typeof path !== 'string' || !path) throw new Error('File path required');
  const r = await git(cwd, ['show', '--format=', '--no-ext-diff', '--no-textconv', '-M', '--diff-merges=first-parent', hash, '--', path]);
  if (!r.ok) throw new Error(r.stderr || 'git show failed');
  return r.stdout;
}

export interface GitBranch { name: string; current: boolean; remote: boolean; upstream: string | null }

export async function gitBranches(dir: string): Promise<GitBranch[]> {
  const cwd = resolvePath(dir);
  // A literal unit separator in the format string: `%xNN` is not expanded by `git branch --format`.
  const r = await git(cwd, ['for-each-ref', '--format=%(HEAD)\u001f%(refname:short)\u001f%(upstream:short)\u001f%(refname)', 'refs/heads', 'refs/remotes']);
  if (!r.ok) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [head, name, upstream, ref] = l.split('\u001f');
    return { name: name ?? '', current: head === '*', remote: (ref ?? '').startsWith('refs/remotes/'), upstream: upstream || null };
  }).filter((b) => b.name && !b.name.endsWith('/HEAD') && b.name !== 'origin');
}

export async function gitCheckout(dir: string, branch: string, create = false): Promise<{ ok: boolean; output: string }> {
  const cwd = resolvePath(dir);
  if (typeof branch !== 'string' || !branch || branch.startsWith('-')) return { ok: false, output: 'Invalid branch name' };
  const valid = await git(cwd, ['check-ref-format', '--branch', branch]);
  if (!valid.ok) return { ok: false, output: valid.stderr || 'Invalid branch name' };
  const args = create ? ['checkout', '-b', branch] : branch.startsWith('origin/') ? ['checkout', '--track', branch] : ['checkout', branch];
  const r = await git(cwd, args);
  return { ok: r.ok, output: r.ok ? (r.stdout || r.stderr) : r.stderr || r.stdout };
}

export async function gitRemoteOp(dir: string, op: 'fetch' | 'pull' | 'push'): Promise<{ ok: boolean; output: string }> {
  const cwd = resolvePath(dir);
  if (!['fetch', 'pull', 'push'].includes(op)) return { ok: false, output: 'Invalid remote operation' };
  const args = op === 'fetch' ? ['fetch', '--all', '--prune'] : op === 'pull' ? ['pull', '--ff-only'] : ['push', '-u', 'origin', 'HEAD'];
  const r = await git(cwd, args, 120000);
  return { ok: r.ok, output: [r.stdout, r.stderr].filter(Boolean).join('\n') };
}
