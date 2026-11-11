import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { listCodexThreads } from './agents/codex.js';
import { which } from './shell.js';
import { loadConfig } from './config.js';

/** The Claude CLI saves a compacted conversation's summary as its first prompt; it is no title. */
export const isCompactSummary = (text?: string | null) => (text ?? '').trimStart().startsWith('This session is being continued from a previous conversation');

/** Saved conversations of one folder (both CLIs), pinned first, then newest. */
export async function listHistory(dir: string, agent: 'claude' | 'codex' | 'all', limit: number) {
  const wantClaude = agent === 'claude' || agent === 'all';
  const wantCodex = agent === 'codex' || agent === 'all';
  const [claude, codexPath] = await Promise.all([
    wantClaude ? listSessions({ dir, limit }).catch(() => []) : Promise.resolve([]),
    wantCodex ? which('codex') : Promise.resolve(null),
  ]);
  const codex = codexPath ? await listCodexThreads(codexPath, dir, limit).catch(() => []) : [];
  const pinned = new Set((await loadConfig()).pinnedSessions);
  return [
    ...claude.map((s) => ({ ...s, agent: 'claude' as const, firstPrompt: isCompactSummary(s.firstPrompt) ? '' : s.firstPrompt })),
    ...codex.map((s) => ({ ...s, agent: 'codex' as const })),
  ].map((s) => ({ ...s, pinned: pinned.has(`${s.agent}:${s.sessionId}`) }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastModified - a.lastModified);
}
