import { currentTodos, isInjected, type ChatSession } from './chatStore';

export interface SessionBrief { asks: number; files: string[]; commits: string[]; todos: string[]; last: string | null }

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** `git commit -m "msg"` / `-m 'msg'` / heredoc subjects found in a shell command. */
export function commitSubjects(command: string): string[] {
  if (!/\bgit\b[^\n]*\bcommit\b/.test(command)) return [];
  const out: string[] = [];
  for (const m of command.matchAll(/-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g)) {
    let lines = (m[1] ?? m[2] ?? '').replace(/\\"/g, '"').split('\n');
    // -m "$(cat <<'EOF' ... EOF)": the subject is the first line of the heredoc.
    if (/^\$\(cat <</.test(lines[0])) lines = lines.slice(1);
    const msg = (lines[0] ?? '').trim();
    if (msg) out.push(msg);
  }
  return out;
}

/**
 * What a resumed conversation already did, read from its transcript (no tokens spent): how many
 * requests, files edited, commits made, open checklist items, and the last answer.
 */
export function sessionBrief(s: Pick<ChatSession, 'items' | 'todos' | 'cwd'>): SessionBrief {
  const files = new Set<string>();
  const commits: string[] = [];
  let asks = 0;
  let last: string | null = null;
  const rel = (p: string) => (p.startsWith(s.cwd + '/') ? p.slice(s.cwd.length + 1) : p);
  for (const it of s.items) {
    if (it.kind === 'user' && !isInjected(it) && it.text.trim()) asks++;
    else if (it.kind === 'assistant' && !it.parent && it.text.trim()) last = it.text.trim();
    else if (it.kind === 'changes') for (const f of it.files) files.add(f.path);
    else if (it.kind === 'tool' && !it.isError) {
      const i = (it.input ?? {}) as Record<string, unknown>;
      if (EDIT_TOOLS.has(it.name) && typeof (i.file_path ?? i.notebook_path) === 'string') files.add(rel(String(i.file_path ?? i.notebook_path)));
      else if (it.name === 'FileChange' && Array.isArray(i.changes)) { for (const c of i.changes as Array<{ path?: string }>) if (c.path) files.add(rel(c.path)); }
      else if (it.name === 'Bash' && typeof i.command === 'string') commits.push(...commitSubjects(i.command));
    }
  }
  const todos = currentTodos(s as ChatSession).filter((x) => x.status !== 'completed').map((x) => x.content);
  return { asks, files: [...files], commits, todos, last };
}
