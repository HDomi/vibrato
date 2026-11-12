import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Search across every past conversation the CLIs saved (Claude: ~/.claude/projects/<dir>/<id>.jsonl, Codex:
 * ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and archived_sessions). Only the user's and the agent's own words
 * are kept, in memory: on the development Mac that is 21 MB of text out of 1.4 GB of transcripts (the rest is
 * tool output), read in about 2.5 s once and then only where a file grew. Transcripts are append-only, so a grown
 * file is read from where the last pass stopped.
 */

export interface SearchHit {
  agent: 'claude' | 'codex';
  sessionId: string;
  cwd: string | null;
  title: string;
  /** The matching passage, about 160 characters around the first match. */
  snippet: string;
  lastModified: number;
}

interface Transcript {
  agent: 'claude' | 'codex';
  sessionId: string;
  cwd: string | null;
  title: string;
  /** The user's and the agent's messages, in order. */
  texts: string[];
  /** Bytes read so far (the next pass starts here) and the file's mtime then. */
  read: number;
  mtime: number;
}

const HOME = os.homedir();
const claudeRoot = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'projects');
const codexRoots = () => {
  const home = process.env.CODEX_HOME || path.join(HOME, '.codex');
  return [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
};
const COMPACT_PREFIX = 'This session is being continued from a previous conversation';

const cache = new Map<string, Transcript>();
let refreshing: Promise<void> | null = null;
/** When the last refresh finished; searches typed in quick succession reuse it instead of listing every file again. */
let refreshedAt = 0;
const FRESH_MS = 5000;

/** Plain text of a message's content (string or blocks); tool calls and results are nobody's words. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && ['text', 'input_text', 'output_text'].includes(String((b as { type?: unknown }).type)) ? String((b as { text?: unknown }).text ?? '') : '')).join('\n');
}

/** Injected context the user never typed (environment blocks, CLI notices, compaction summaries). */
const injected = (text: string) => /^\s*</.test(text) || text.trimStart().startsWith(COMPACT_PREFIX);

/** Reads a transcript from `t.read` on: messages, and the id, folder and first prompt while unknown. */
async function readMore(file: string, t: Transcript) {
  const claude = t.agent === 'claude';
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8', start: t.read }), crlfDelay: Infinity });
  let consumed = t.read;
  let complete = t.read;
  for await (const line of rl) {
    consumed += Buffer.byteLength(line) + 1;
    // The bulk of a transcript is tool results (Claude) or non-message records (Codex): skip without parsing.
    if (claude ? line.includes('"tool_use_id"') && t.cwd : !line.includes('"type":"message"') && !line.includes('session_meta')) { complete = consumed; continue; }
    let raw: Record<string, unknown>;
    // A line that does not parse is left out of `complete`: if it was the last one (still being written), the next
    // pass starts there again; if later lines parse, it was simply a bad line and is passed over.
    try { raw = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    complete = consumed;
    let role: unknown; let text = '';
    if (claude) {
      if (typeof raw.cwd === 'string' && !t.cwd) t.cwd = raw.cwd;
      if ((raw.type === 'user' || raw.type === 'assistant') && !raw.isSidechain && !raw.isMeta) { role = raw.type; text = textOf((raw.message as { content?: unknown } | undefined)?.content); }
    } else {
      const p = (raw.payload ?? {}) as Record<string, unknown>;
      if (raw.type === 'session_meta') {
        if (typeof p.cwd === 'string' && !t.cwd) t.cwd = p.cwd;
        if (typeof p.id === 'string' && !t.sessionId) t.sessionId = p.id;
      } else if (raw.type === 'response_item' && p.type === 'message') { role = p.role; text = textOf(p.content); }
    }
    text = text.trim();
    if ((role !== 'user' && role !== 'assistant') || !text || (role === 'user' && injected(text))) continue;
    if (!t.title && role === 'user') t.title = text.split('\n')[0].slice(0, 80);
    t.texts.push(text);
  }
  rl.close();
  t.read = complete;
}

async function listTranscripts(): Promise<{ file: string; agent: 'claude' | 'codex' }[]> {
  const out: { file: string; agent: 'claude' | 'codex' }[] = [];
  // Claude: one level of project folders (deeper ones hold subagent transcripts, which cannot be resumed).
  for (const dir of await fs.readdir(claudeRoot(), { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    const base = path.join(claudeRoot(), dir.name);
    for (const f of await fs.readdir(base).catch(() => [] as string[])) if (f.endsWith('.jsonl')) out.push({ file: path.join(base, f), agent: 'claude' });
  }
  const walk = async (d: string, depth: number): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ file: p, agent: 'codex' });
    }
  };
  for (const root of codexRoots()) await walk(root, 0);
  return out;
}

/** Brings the cache up to date: new files read in full, grown ones from where they were left, gone ones dropped. */
function refresh(): Promise<void> {
  refreshing ??= (async () => {
    const files = await listTranscripts();
    const seen = new Set(files.map((f) => f.file));
    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
    const work = files.map(({ file, agent }) => async () => {
      const st = await fs.stat(file).catch(() => null);
      if (!st) return;
      let t = cache.get(file);
      // Rewritten (shorter than what was read, e.g. history edited by the CLI): start over.
      if (t && st.size < t.read) { cache.delete(file); t = undefined; }
      if (t && st.size === t.read && st.mtimeMs === t.mtime) return;
      if (!t) { t = { agent, sessionId: agent === 'claude' ? path.basename(file, '.jsonl') : '', cwd: null, title: '', texts: [], read: 0, mtime: 0 }; cache.set(file, t); }
      await readMore(file, t).catch(() => {});
      t.mtime = st.mtimeMs;
    });
    for (let i = 0; i < work.length; i += 16) await Promise.all(work.slice(i, i + 16).map((w) => w()));
    refreshedAt = Date.now();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** Reads every transcript once in the background so the first search does not wait for it. */
export function warmHistorySearch(delayMs = 15000) {
  setTimeout(() => { void refresh().catch(() => {}); }, delayMs).unref();
}

function snippetAround(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return flat.slice(0, 160);
  const from = Math.max(0, at - 60);
  const to = Math.min(flat.length, at + query.length + 100);
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`;
}

/** `freshMs`: a refresh finished this recently is good enough (0 always looks at the files again). */
export async function searchHistory(query: string, limit = 30, freshMs = FRESH_MS): Promise<SearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  if (refreshing || Date.now() - refreshedAt >= freshMs) await refresh();
  const lower = q.toLowerCase();
  const hits: SearchHit[] = [];
  for (const t of cache.values()) {
    if (!t.sessionId) continue;
    const text = t.texts.find((x) => x.toLowerCase().includes(lower));
    if (text) hits.push({ agent: t.agent, sessionId: t.sessionId, cwd: t.cwd, title: t.title || text.slice(0, 60), snippet: snippetAround(text, q), lastModified: t.mtime });
  }
  return hits.sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
}
