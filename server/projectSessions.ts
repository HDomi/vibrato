/*
 * "Delete all sessions" of a favorite project (the dock's context menu): every saved Claude and Codex session whose
 * folder is the project is deleted for good. Pinned sessions are kept (pinning exists to protect them, and a single
 * delete refuses them too), and so are sessions open in the app right now (their CLI is still writing them).
 */
export interface SessionRow { sessionId: string }

export interface ProjectSessionDeps {
  claude: () => Promise<SessionRow[]>;
  codex: () => Promise<SessionRow[]>;
  deleteClaude: (id: string) => Promise<void>;
  deleteCodex: (id: string) => Promise<void>;
  /** "agent:sessionId" keys of pinned sessions (config.pinnedSessions). */
  pinned: Set<string>;
  /** CLI session ids open in the app now. */
  open: Set<string>;
}

export interface ProjectSessionResult { deleted: number; keptPinned: number; keptOpen: number; failed: number }

export async function deleteProjectSessions(d: ProjectSessionDeps): Promise<ProjectSessionResult> {
  const r: ProjectSessionResult = { deleted: 0, keptPinned: 0, keptOpen: 0, failed: 0 };
  const [claude, codex] = await Promise.all([d.claude().catch(() => []), d.codex().catch(() => [])]);
  const jobs: { agent: 'claude' | 'codex'; id: string }[] = [...claude.map((s) => ({ agent: 'claude' as const, id: s.sessionId })), ...codex.map((s) => ({ agent: 'codex' as const, id: s.sessionId }))];
  for (const { agent, id } of jobs) {
    if (d.pinned.has(`${agent}:${id}`)) { r.keptPinned++; continue; }
    if (d.open.has(id)) { r.keptOpen++; continue; }
    try { await (agent === 'claude' ? d.deleteClaude(id) : d.deleteCodex(id)); r.deleted++; } catch { r.failed++; }
  }
  return r;
}
