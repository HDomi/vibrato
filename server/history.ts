import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { listCodexThreads } from './agents/codex.js';
import { which } from './shell.js';
import { loadConfig } from './config.js';

/** The Claude CLI saves a compacted conversation's summary as its first prompt; it is no title. */
export const isCompactSummary = (text?: string | null) => (text ?? '').trimStart().startsWith('This session is being continued from a previous conversation');

/** Listing Codex threads starts an app-server process; the Dock asks every minute, so answers are kept briefly. */
const CODEX_LIST_TTL_MS = 30_000;
const codexLists = new Map<string, { at: number; rows: ReturnType<typeof listCodexThreads> }>();

/** listCodexThreads, answered from a short cache keyed by folder (null: every folder) and limit. */
export function codexThreads(codexPath: string, dir: string | null, limit: number): ReturnType<typeof listCodexThreads> {
  const key = `${codexPath}\0${dir ?? '*'}\0${limit}`;
  const hit = codexLists.get(key);
  if (hit && Date.now() - hit.at < CODEX_LIST_TTL_MS) return hit.rows;
  const entry = { at: Date.now(), rows: listCodexThreads(codexPath, dir, limit) };
  codexLists.set(key, entry);
  // A failure is not remembered: the next call tries again.
  entry.rows.catch(() => { if (codexLists.get(key) === entry) codexLists.delete(key); });
  return entry.rows;
}

/** A Codex thread was renamed, deleted or had a turn: the next list asks the CLI again. */
export function forgetCodexThreads() { codexLists.clear(); }

/** Saved conversations of one folder (both CLIs), pinned first, then newest. */
export async function listHistory(dir: string, agent: 'claude' | 'codex' | 'all', limit: number) {
  const wantClaude = agent === 'claude' || agent === 'all';
  const wantCodex = agent === 'codex' || agent === 'all';
  const [claude, codexPath] = await Promise.all([
    wantClaude ? listSessions({ dir, limit }).catch(() => []) : Promise.resolve([]),
    wantCodex ? which('codex') : Promise.resolve(null),
  ]);
  const codex = codexPath ? await codexThreads(codexPath, dir, limit).catch(() => []) : [];
  const pinned = new Set((await loadConfig()).pinnedSessions);
  return [
    ...claude.map((s) => ({ ...s, agent: 'claude' as const, firstPrompt: isCompactSummary(s.firstPrompt) ? '' : s.firstPrompt })),
    ...codex.map((s) => ({ ...s, agent: 'codex' as const })),
  ].map((s) => ({ ...s, pinned: pinned.has(`${s.agent}:${s.sessionId}`) }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastModified - a.lastModified);
}
