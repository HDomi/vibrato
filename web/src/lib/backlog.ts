import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Backlog, type BacklogItem } from './api';
import type { ChatSession } from './chatStore';
import type { AgentId, PermissionModeId } from './agent';
import type { useSessions } from './useSessions';
import { t } from './i18n';
import { agentDefaults } from './agentDefaults';

export const EMPTY_BACKLOG: Backlog = { items: [], auto: false, agent: 'claude', mode: 'acceptEdits', worktree: false };

/** A queued item's session finished its turn: idle again with a result on screen. */
export function itemOutcome(s: ChatSession | undefined): 'running' | 'done' | 'failed' | 'stopped' {
  if (!s) return 'stopped';
  if (s.status === 'closed') return 'failed';
  if (s.status !== 'idle') return 'running';
  let restarted = false;
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it.kind === 'result') return it.ok ? 'done' : 'failed';
    if (it.kind === 'error') return 'failed';
    if (it.kind === 'system' && (it.id.startsWith('revived-') || it.id.startsWith('gone-'))) restarted = true;
    // The server restarted mid-turn: the session came back idle and that turn will never finish.
    if (it.kind === 'user') return restarted ? 'stopped' : 'running';
  }
  return 'running';
}

/** The next item to start, or null when one is still running or the queue is empty. */
export function nextItem(b: Backlog): BacklogItem | null {
  if (b.items.some((i) => i.status === 'running')) return null;
  return b.items.find((i) => i.status === 'todo') ?? null;
}

/**
 * Backlogs of every project, and the dispatcher that works through those whose queue is on: one item
 * at a time per project, each in a fresh session (in its own worktree when asked), without taking the
 * screen away from what the user is looking at.
 */
export function useBacklogs(S: ReturnType<typeof useSessions>) {
  const [backlogs, setBacklogs] = useState<Record<string, Backlog>>({});
  const ref = useRef(backlogs);
  ref.current = backlogs;
  const starting = useRef(new Set<string>());
  // Remembered sessions are re-attached right after a reload; until then a missing one is not "stopped".
  const mountedAt = useRef(Date.now());
  const [, recheck] = useState(0);
  useEffect(() => { const timer = setTimeout(() => recheck((n) => n + 1), 10000); return () => clearTimeout(timer); }, []);
  // Saves go out in order, so an older state can never land after a newer one.
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => { api.backlogAll().then((rows) => setBacklogs(Object.fromEntries(rows.map((r) => [r.cwd, r.backlog])))).catch(() => {}); }, []);

  const update = useCallback((cwd: string, fn: (b: Backlog) => Backlog) => {
    const next = fn(ref.current[cwd] ?? EMPTY_BACKLOG);
    ref.current = { ...ref.current, [cwd]: next };
    setBacklogs(ref.current);
    saving.current = saving.current.then(() => api.saveBacklog(cwd, next)).catch(() => {});
  }, []);

  const setItem = useCallback((cwd: string, id: string, patch: Partial<BacklogItem>) =>
    update(cwd, (b) => ({ ...b, items: b.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })), [update]);

  // `S` is a new object on every session update; the effect only depends on the sessions and the id map,
  // and reaches start / send through a ref.
  const sessionsApi = useRef(S);
  sessionsApi.current = S;
  const { sessions, replaced } = S;
  // Check once more when the grace period below ends, even if no session changed meanwhile.
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setGraceOver(true), 10000); return () => window.clearTimeout(timer); }, []);
  useEffect(() => {
    const S = { sessions, replaced };
    for (const [cwd, b] of Object.entries(backlogs)) {
      const running = b.items.find((i) => i.status === 'running');
      if (running) {
        if (starting.current.has(cwd)) continue;
        const id = running.sessionId ? (S.replaced[running.sessionId] ?? running.sessionId) : undefined;
        // Started but never got its session (the page reloaded during the start): it did not run.
        if (!id) { setItem(cwd, running.id, { status: 'stopped', endedAt: Date.now() }); continue; }
        if (!S.sessions[id] && Date.now() - mountedAt.current < 10000) continue;
        const outcome = itemOutcome(S.sessions[id]);
        if (outcome !== 'running') setItem(cwd, running.id, { status: outcome, endedAt: Date.now(), sessionId: id });
        continue;
      }
      if (!b.auto || starting.current.has(cwd)) continue;
      const next = nextItem(b);
      if (!next) {
        if (b.items.length) { update(cwd, (x) => ({ ...x, auto: false })); window.dispatchEvent(new CustomEvent('vibe:toast', { detail: { text: t('backlog.finished', { name: cwd.split('/').pop() ?? cwd }) } })); }
        continue;
      }
      starting.current.add(cwd);
      setItem(cwd, next.id, { status: 'running', startedAt: Date.now() });
      void (async () => {
        try {
          const mode = (b.agent === 'codex' && b.mode === 'auto' ? 'default' : b.mode) as PermissionModeId;
          const agent = b.agent as AgentId;
          const model = agentDefaults(agent).model;
          const title = next.text.split('\n')[0].slice(0, 40);
          let sessionId: string;
          if (b.worktree) {
            const wt = await api.worktreeCreate(cwd, `todo/${next.id.slice(0, 6)}`);
            sessionId = await sessionsApi.current.start(wt.path, { agent, permissionMode: mode, model, worktree: { ...wt, origin: cwd }, title });
          } else {
            sessionId = await sessionsApi.current.start(cwd, { agent, permissionMode: mode, model, title });
          }
          setItem(cwd, next.id, { sessionId });
          sessionsApi.current.send(sessionId, next.text, []);
        } catch (e) {
          setItem(cwd, next.id, { status: 'failed', endedAt: Date.now() });
          update(cwd, (x) => ({ ...x, auto: false }));
          window.dispatchEvent(new CustomEvent('vibe:toast', { detail: { text: (e as Error).message, kind: 'error' } }));
        } finally {
          starting.current.delete(cwd);
        }
      })();
    }
  }, [backlogs, sessions, replaced, graceOver, setItem, update]);

  return { backlogs, update, setItem };
}
