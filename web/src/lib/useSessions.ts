import { useCallback, useEffect, useRef, useState } from 'react';
import { agentClient, type AgentId, type Attachment, type PermissionModeId, type RewindResult, type ServerMessage } from './agent';
import { ACTIVITY_EVENTS, displayTitle, itemsFromHistory, reduceEvent, type ChatItem, type ChatSession } from './chatStore';
import { api, type WorktreeInfo } from './api';
import { t } from './i18n';
import { agentDefaults } from './agentDefaults';

const LS_ACTIVE = 'vibe.sessions';

/** Session currently on screen; a result there needs no notification while the window is focused. */
let onScreenSession: string | null = null;
export function setOnScreenSession(id: string | null) { onScreenSession = id; }

function sessionName(s: ChatSession) { return displayTitle(s, 24) ?? s.cwd.split('/').pop() ?? s.agent; }

/**
 * Notify when the user is not looking at this session: the window is unfocused or hidden, or
 * another session/view is on screen. Native (Electron) when available, web Notification otherwise.
 */
function notifyIfAway(s: ChatSession, e: { kind: string; text?: string; toolName?: string; ok?: boolean; requestId?: string; canAlwaysAllow?: boolean; status?: string; command?: string }) {
  if ((e.kind === 'approval.resolved' || e.kind === 'question.resolved') && e.requestId) { window.vibe?.closeNotification?.(e.requestId); return; }
  if (document.hasFocus() && document.visibilityState === 'visible' && onScreenSession === s.id) return;
  const name = sessionName(s);
  let title: string | null = null; let body = '';
  if (e.kind === 'result') { title = t(e.ok ? 'notif.sessionDone' : 'notif.sessionFailed', { name }); body = (e.text ?? '').slice(0, 120); }
  else if (e.kind === 'approval.request') { title = t('notif.approval'); body = `${name} · ${t('notif.allow', { tool: e.toolName ?? '' })}`; }
  else if (e.kind === 'question.request') { title = t('notif.question'); body = `${name} · ${t('notif.waiting')}`; }
  else if (e.kind === 'verify' && e.status === 'failed') { title = t('notif.verifyFailed', { name }); body = e.command ?? ''; }
  if (!title) return;
  if (window.vibe?.notify) {
    const approval = e.kind === 'approval.request' && e.requestId
      ? { requestId: e.requestId, canAlwaysAllow: !!e.canAlwaysAllow, labels: [t('items.allow'), t('items.alwaysAllow'), t('items.deny')] as [string, string, string] }
      : undefined;
    // Approval and question notifications wait for the user; the rest are closed by the main process after a moment.
    const requestId = e.kind === 'question.request' && e.requestId ? e.requestId : undefined;
    window.vibe.notify({ title, body, sessionId: s.id, approval, requestId });
    return;
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, silent: false });
    n.onclick = () => { window.focus(); window.dispatchEvent(new CustomEvent('vibe:notify-click', { detail: { sessionId: s.id } })); };
  } catch { /* ignore */ }
}

export function requestNotificationPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
}

interface Persisted { id: string; cwd: string; agent: AgentId; agentSessionId?: string; permissionMode?: PermissionModeId; model?: string; historyLen?: number; title?: string; pinned?: boolean; pinnedKey?: string; lastActivity?: number; worktree?: WorktreeInfo; pairKey?: string; resumed?: boolean }
interface PendingStart { cwd: string; resolve: (id: string) => void; reject: (err: Error) => void; preload: ChatItem[]; historyLen?: number; replaces?: string; title?: string; worktree?: WorktreeInfo; pairKey?: string; resumed?: boolean; /** CLI session being resumed; known before the adapter's init event, so a second resume can be matched right away. */ resume?: string }
/** Streaming deltas are applied together at most this often (ms). */
const DELTA_BATCH_MS = 32;

type EventMessage = Extract<ServerMessage, { event: unknown }>;

function applyEvent(prev: Record<string, ChatSession>, m: EventMessage): Record<string, ChatSession> {
  const s = prev[m.sessionId];
  if (!s) return prev;
  if (m.seq > 0 && m.seq <= s.lastSeq) return prev;
  const next = reduceEvent(s, m.event, m.seq, m.ts);
  if (ACTIVITY_EVENTS.has(m.event.kind) && m.ts > (next.lastActivity ?? 0)) next.lastActivity = m.ts;
  return { ...prev, [m.sessionId]: next };
}

/** A revived session that goes missing again this soon is reported lost instead of looping. */
const REVIVE_COOLDOWN_MS = 30000;

export function useSessions() {
  const [sessions, setSessionsNow] = useState<Record<string, ChatSession>>({});
  // Streaming text arrives as many tiny deltas. Apply them in one update every DELTA_BATCH_MS instead of
  // re-rendering the whole app per chunk; any other update flushes them first so the order never changes.
  const pendingDeltas = useRef<EventMessage[]>([]);
  const deltaTimer = useRef<number | null>(null);
  const flushDeltas = () => {
    if (deltaTimer.current !== null) { window.clearTimeout(deltaTimer.current); deltaTimer.current = null; }
    const batch = pendingDeltas.current;
    if (!batch.length) return;
    pendingDeltas.current = [];
    setSessionsNow((prev) => batch.reduce(applyEvent, prev));
  };
  const setSessions: typeof setSessionsNow = (update) => { flushDeltas(); setSessionsNow(update); };
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  const pendingStart = useRef(new Map<string, PendingStart>());
  /** Resumes in flight, by CLI session id, so a second click on the same conversation joins the first instead of opening twice. */
  const resuming = useRef(new Map<string, Promise<string>>());
  /** Old session id -> the id that replaced it after the server restarted. Views follow this to keep their selection. */
  const [replaced, setReplaced] = useState<Record<string, string>>({});
  const reviving = useRef(new Set<string>());
  const revivedAt = useRef(new Map<string, number>());
  /** Sessions whose buffered events are already covered by the full saved history (legacy entries). */
  const skipReplay = useRef(new Set<string>());
  const pendingRewind = useRef(new Map<string, (r: RewindResult) => void>());

  useEffect(() => {
    const off = agentClient.on((m: ServerMessage) => {
      if ('type' in m) {
        if (m.type === 'reconnected') {
          // The server lost this socket's subscriptions; re-attach every live session from where we left off.
          for (const s of Object.values(sessionsRef.current)) if (s.status !== 'closed') agentClient.send({ type: 'session.attach', sessionId: s.id, after: s.lastSeq || (skipReplay.current.has(s.id) ? Number.MAX_SAFE_INTEGER : 0) });
          return;
        }
        if (m.type === 'pong') return;
        if (m.type === 'session.rewindResult') {
          pendingRewind.current.get(m.requestId)?.(m.result);
          pendingRewind.current.delete(m.requestId);
          return;
        }
        if (m.type === 'session.attached') {
          setSessions((prev) => prev[m.sessionId]?.restoring ? { ...prev, [m.sessionId]: { ...prev[m.sessionId], restoring: undefined } } : prev);
          return;
        }
        if (m.type === 'session.startFailed') {
          const p = m.requestId ? pendingStart.current.get(m.requestId) : undefined;
          if (m.requestId) pendingStart.current.delete(m.requestId);
          p?.reject(new Error(m.message));
          return;
        }
        if (m.type === 'session.started') {
          const p = m.requestId ? pendingStart.current.get(m.requestId) : undefined;
          if (m.requestId) pendingStart.current.delete(m.requestId);
          const fresh: ChatSession = {
            id: m.sessionId, agent: m.agent ?? 'claude', cwd: m.requestCwd, permissionMode: 'default', status: 'starting',
            items: p?.preload ?? [], historyLen: p?.historyLen, title: p?.title, worktree: p?.worktree, pairKey: p?.pairKey, resumed: p?.resumed, agentSessionId: p?.resume, totalCostUsd: 0, lastSeq: 0, lastActivity: Date.now(),
          };
          const old = p?.replaces;
          setSessions((prev) => {
            const was = old ? prev[old] : undefined;
            if (!old || !was) return { ...prev, [m.sessionId]: fresh };
            // Keep the tab where it was and the conversation on screen; history replay (Claude) wins when available.
            const items = fresh.items.length ? fresh.items : was.items.filter((it) => !it.id.startsWith('gone-')).map((it) =>
              it.kind === 'assistant' ? { ...it, streaming: false } : it.kind === 'tool' ? { ...it, done: true } : it);
            const revived: ChatSession = { ...fresh, title: fresh.title ?? was.title, pinned: was.pinned, lastActivity: was.lastActivity, permissionMode: was.permissionMode, model: was.model, agentSessionId: was.agentSessionId, worktree: fresh.worktree ?? was.worktree, pairKey: fresh.pairKey ?? was.pairKey, resumed: was.resumed, items: [...items, { kind: 'system', id: `revived-${m.sessionId}`, text: t('session.revived') }] };
            return Object.fromEntries(Object.entries(prev).map(([k, v]) => k === old ? [m.sessionId, revived] : [k, v]));
          });
          if (old) {
            revivedAt.current.set(m.sessionId, Date.now());
            setReplaced((r) => ({ ...r, [old]: m.sessionId }));
          }
          p?.resolve(m.sessionId);
        } else if (m.type === 'session.missing') {
          const s = sessionsRef.current[m.sessionId];
          if (!s || reviving.current.has(s.id)) return;
          if (Date.now() - (revivedAt.current.get(s.id) ?? 0) < REVIVE_COOLDOWN_MS) { markLost(s.id); return; }
          // Another tab already carries this CLI session (live, or a revive in flight): fold this one into it.
          // Reviving both would run the same conversation twice (that is how duplicate tabs piled up).
          if (s.agentSessionId) {
            const key = `${s.agent}:${s.agentSessionId}`;
            const twin = Object.values(sessionsRef.current).find((x) => x.id !== s.id && x.agent === s.agent && x.agentSessionId === s.agentSessionId && x.status !== 'closed' && !x.restoring && !reviving.current.has(x.id));
            const inflight = resuming.current.get(key);
            if (twin || inflight) {
              setSessions((prev) => { const n = { ...prev }; delete n[s.id]; return n; });
              if (twin) setReplaced((r) => ({ ...r, [s.id]: twin.id }));
              else inflight!.then((id) => setReplaced((r) => ({ ...r, [s.id]: id }))).catch(() => {});
              return;
            }
          }
          // The server restarted (update, app relaunch): start the same conversation again instead of leaving a dead tab.
          reviving.current.add(s.id);
          startRef.current(s.cwd, { agent: s.agent, resume: s.agentSessionId, permissionMode: s.permissionMode, model: s.model, replaces: s.id, title: s.title, worktree: s.worktree, pairKey: s.pairKey })
            .catch(() => markLost(s.id))
            .finally(() => reviving.current.delete(s.id));
        }
        return;
      }
      const live = sessionsRef.current[m.sessionId];
      if (live) notifyIfAway(live, m.event);
      // The CLI writes its generated title a moment after a turn ends; pick it up so tabs match the history list.
      if (m.event.kind === 'result') { setTimeout(() => refreshTitle(m.sessionId), 3000); window.dispatchEvent(new Event('vibe:usage-refresh')); }
      if (m.event.kind === 'text.delta' || m.event.kind === 'thinking.delta') {
        pendingDeltas.current.push(m);
        deltaTimer.current ??= window.setTimeout(flushDeltas, DELTA_BATCH_MS);
        return;
      }
      setSessions((prev) => applyEvent(prev, m));
    });
    return () => { off(); if (deltaTimer.current !== null) window.clearTimeout(deltaTimer.current); };
  }, []);

  const refreshTitle = (id: string) => {
    const s = sessionsRef.current[id];
    if (!s?.agentSessionId) return;
    api.history(s.cwd, s.agent).then((rows) => {
      const h = rows.find((r) => r.sessionId === s.agentSessionId);
      const title = h?.customTitle || h?.summary;
      if (!title) return;
      setSessions((prev) => prev[id] && prev[id].title !== title ? { ...prev, [id]: { ...prev[id], title } } : prev);
    }).catch(() => { /* title is cosmetic */ });
  };

  // Re-attach sessions remembered from a previous page load (same server lifetime).
  useEffect(() => {
    let saved: Persisted[] = [];
    try { saved = JSON.parse(localStorage.getItem(LS_ACTIVE) || '[]'); } catch { /* ignore */ }
    // Earlier builds could remember one CLI session under several tabs; keep the most recent and let the rest go.
    const newest = new Map<string, Persisted>();
    for (const p of saved) {
      if (!p.agentSessionId) continue;
      const k = `${p.agent}:${p.agentSessionId}`;
      if ((newest.get(k)?.lastActivity ?? 0) <= (p.lastActivity ?? 0)) newest.set(k, p);
    }
    saved = saved.filter((p) => !p.agentSessionId || newest.get(`${p.agent}:${p.agentSessionId}`) === p);
    if (!saved.length) return;
    setSessions((prev) => {
      const next = { ...prev };
      for (const p of saved) if (!next[p.id]) next[p.id] = { id: p.id, agent: p.agent, cwd: p.cwd, agentSessionId: p.agentSessionId, historyLen: p.historyLen, title: p.title, pinned: p.pinned, pinnedKey: p.pinnedKey, lastActivity: p.lastActivity, worktree: p.worktree, pairKey: p.pairKey, resumed: p.resumed, permissionMode: p.permissionMode ?? 'default', model: p.model, status: 'idle', items: [], totalCostUsd: 0, lastSeq: 0, restoring: true };
      return next;
    });
    for (const p of saved) void reattach(p);
  }, []);

  /**
   * The server buffer only holds events since the session started, so a resumed Claude session
   * must get its earlier conversation from the saved history before the buffer is replayed.
   */
  const reattach = async (p: Persisted) => {
    let after = 0;
    if (p.agent === 'claude' && p.agentSessionId && p.historyLen !== 0) {
      try {
        const all = await api.historyMessages(p.cwd, p.agentSessionId);
        // Entries saved before historyLen existed: show the full history and skip the replay it already contains.
        const items = itemsFromHistory(p.historyLen === undefined ? all : all.slice(0, p.historyLen));
        if (p.historyLen === undefined) { after = Number.MAX_SAFE_INTEGER; skipReplay.current.add(p.id); }
        setSessions((prev) => prev[p.id] ? { ...prev, [p.id]: { ...prev[p.id], items: [...items, ...prev[p.id].items], historyLen: p.historyLen ?? all.length } } : prev);
      } catch (err) {
        // History is optional; the attach below still revives the session. Logged so a blank tab can be traced.
        console.warn(`[vibe] history for remembered session ${p.id} failed:`, (err as Error).message);
      }
    }
    await agentClient.ready;
    agentClient.send({ type: 'session.attach', sessionId: p.id, after });
  };

  useEffect(() => {
    const list: Persisted[] = Object.values(sessions).filter((s) => s.status !== 'closed').map((s) => ({ id: s.id, cwd: s.cwd, agent: s.agent, agentSessionId: s.agentSessionId, permissionMode: s.permissionMode, model: s.model, historyLen: s.historyLen, title: s.title, pinned: s.pinned, pinnedKey: s.pinnedKey, lastActivity: s.lastActivity, worktree: s.worktree, pairKey: s.pairKey, resumed: s.resumed }));
    try { localStorage.setItem(LS_ACTIVE, JSON.stringify(list)); } catch { /* ignore */ }
  }, [sessions]);

  const markLost = (id: string) => setSessions((prev) => {
    const s = prev[id];
    if (!s) return prev;
    const closed = reduceEvent(s, { kind: 'status', status: 'closed' }, 0);
    return { ...prev, [id]: { ...closed, items: [...closed.items, { kind: 'system', id: `gone-${id}`, text: t('session.lost') }] } };
  });

  const start = useCallback(async (cwd: string, opts: { resume?: string; permissionMode?: PermissionModeId; agent?: AgentId; model?: string | null; replaces?: string; title?: string; worktree?: WorktreeInfo; pairKey?: string } = {}) => {
    // Resuming a conversation that is already open (from the history list, another view, or a double click)
    // brings that tab forward; a second live process on the same CLI session would only duplicate it.
    if (!opts.resume) return startNew(cwd, opts);
    const key = `${opts.agent ?? 'claude'}:${opts.resume}`;
    if (!opts.replaces) {
      const live = Object.values(sessionsRef.current).find((s) => s.agent === (opts.agent ?? 'claude') && s.agentSessionId === opts.resume && s.status !== 'closed' && !s.restoring);
      if (live) return live.id;
      const inflight = resuming.current.get(key);
      if (inflight) return inflight;
    }
    const run = startNew(cwd, opts).finally(() => { if (resuming.current.get(key) === run) resuming.current.delete(key); });
    resuming.current.set(key, run);
    return run;
  }, []);
  /** Show a live server session this window did not start (a scheduled run). Its buffer replays from the start. */
  const adopt = useCallback((p: { id: string; cwd: string; agent: AgentId; agentSessionId?: string; title?: string }) => {
    if (sessionsRef.current[p.id]) return;
    const saved: Persisted = { ...p, historyLen: 0, lastActivity: Date.now() };
    setSessions((prev) => prev[p.id] ? prev : { ...prev, [p.id]: { id: p.id, agent: p.agent, cwd: p.cwd, agentSessionId: p.agentSessionId, historyLen: 0, title: p.title, lastActivity: saved.lastActivity, permissionMode: 'default', status: 'idle', items: [], totalCostUsd: 0, lastSeq: 0, restoring: true } });
    void reattach(saved);
  }, []);

  const startNew = async (cwd: string, opts: { resume?: string; permissionMode?: PermissionModeId; agent?: AgentId; model?: string | null; replaces?: string; title?: string; worktree?: WorktreeInfo; pairKey?: string }) => {
    let preload: ChatItem[] = [];
    let historyLen: number | undefined;
    if ((opts.agent ?? 'claude') === 'claude') {
      historyLen = 0;
      if (opts.resume) {
        try { const msgs = await api.historyMessages(cwd, opts.resume); preload = itemsFromHistory(msgs); historyLen = msgs.length; } catch { /* history is optional */ }
      }
    }
    // Anything the caller left unset follows Settings > AI behavior (null model = the CLI's own default).
    const defaults = agentDefaults(opts.agent ?? 'claude');
    const permissionMode = opts.permissionMode ?? defaults.mode;
    const model = opts.model === undefined ? defaults.model : opts.model;
    return new Promise<string>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      pendingStart.current.set(requestId, { cwd, resolve, reject, preload, historyLen, replaces: opts.replaces, title: opts.title, worktree: opts.worktree, pairKey: opts.pairKey, resumed: !!opts.resume && !opts.replaces, resume: opts.resume });
      agentClient.send({ type: 'session.start', requestId, agent: opts.agent ?? 'claude', cwd, resume: opts.resume, permissionMode, model: model ?? undefined });
    });
  };
  const startRef = useRef(start);

  const send = useCallback((sessionId: string, text: string, attachments: Attachment[]) => {
    const messageId = crypto.randomUUID();
    // Show the message immediately; the server's echo confirms it (see reducer) instead of adding a duplicate.
    setSessions((prev) => {
      const s = prev[sessionId];
      if (!s) return prev;
      return { ...prev, [sessionId]: { ...s, items: [...s.items, { kind: 'user', id: messageId, text, attachments, pending: true, followUp: s.status === 'running' || undefined }], status: s.status === 'idle' ? 'running' : s.status, turnStartedAt: s.turnStartedAt ?? Date.now(), lastActivity: Date.now() } };
    });
    agentClient.send({ type: 'session.send', sessionId, text, attachments, messageId });
  }, []);
  const approve = useCallback((sessionId: string, requestId: string, decision: 'allow' | 'allow_always' | 'deny', message?: string) => {
    agentClient.send({ type: 'session.approve', sessionId, requestId, decision, message });
  }, []);
  const answer = useCallback((sessionId: string, requestId: string, answers: Record<string, string>, response?: string) => {
    agentClient.send({ type: 'session.answer', sessionId, requestId, answers, response });
  }, []);
  const interrupt = useCallback((sessionId: string) => agentClient.send({ type: 'session.interrupt', sessionId }), []);
  /** Stop one subagent / background task; the turn keeps going. Claude sessions only. */
  const stopTask = useCallback((sessionId: string, taskId: string) => agentClient.send({ type: 'session.stopTask', sessionId, taskId }), []);
  const setMode = useCallback((sessionId: string, mode: PermissionModeId) => agentClient.send({ type: 'session.mode', sessionId, mode }), []);
  const setModel = useCallback((sessionId: string, model: string | null) => agentClient.send({ type: 'session.model', sessionId, model }), []);
  /** Preview (dryRun) or undo the file changes made since a user message. Claude sessions only. */
  const rewind = useCallback((sessionId: string, messageId: string, dryRun: boolean) => new Promise<RewindResult>((resolve) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { pendingRewind.current.delete(requestId); resolve({ canRewind: false, error: t('rewind.timeout') }); }, 30000);
    pendingRewind.current.set(requestId, (r) => {
      clearTimeout(timer);
      if (!dryRun && r.canRewind) {
        setSessions((prev) => {
          const s = prev[sessionId];
          return s ? { ...prev, [sessionId]: { ...s, items: [...s.items, { kind: 'system', id: `rewind-${requestId}`, text: t('rewind.done') }] } } : prev;
        });
      }
      resolve(r);
    });
    agentClient.send({ type: 'session.rewind', sessionId, requestId, messageId, dryRun });
  }), []);
  /** Run the project's verification command now (results arrive as `verify` events). */
  const verify = useCallback((sessionId: string) => agentClient.send({ type: 'session.verify', sessionId }), []);
  /**
   * One pin list for tabs and the history lists: the server's pinnedSessions, keyed by CLI session id.
   * A tab without that id yet keeps its pin locally and pushes it when the id arrives.
   */
  const [pins, setPins] = useState<Set<string> | null>(null);
  useEffect(() => {
    const load = () => api.historyPins().then((p) => setPins(new Set(p))).catch(() => {});
    load();
    window.addEventListener('vibe:pins-changed', load);
    return () => window.removeEventListener('vibe:pins-changed', load);
  }, []);
  const pinKey = (s: Pick<ChatSession, 'agent' | 'agentSessionId'>) => (s.agentSessionId ? `${s.agent}:${s.agentSessionId}` : null);
  const pushPin = (key: string, pinned: boolean) => {
    setPins((prev) => { const n = new Set(prev); if (pinned) n.add(key); else n.delete(key); return n; });
    const [agent, id] = key.split(/:(.*)/) as [AgentId, string];
    void api.historyPin(agent, id, pinned).catch(() => {});
  };
  const idSignature = Object.values(sessions).map((s) => s.agentSessionId ?? '').join(',');
  useEffect(() => {
    if (!pins) return;
    const toPush: string[] = [];
    setSessions((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const s of Object.values(prev)) {
        const key = pinKey(s);
        if (!key) continue;
        if (pins.has(key)) {
          if (!s.pinned || s.pinnedKey !== key) { next[s.id] = { ...s, pinned: true, pinnedKey: key }; changed = true; }
        } else if (s.pinned && s.pinnedKey !== key) {
          // Pinned as a tab before the CLI id was known: the server list learns about it now.
          toPush.push(key);
          next[s.id] = { ...s, pinnedKey: key }; changed = true;
        } else if (s.pinned) {
          // Unpinned from a history list.
          next[s.id] = { ...s, pinned: undefined }; changed = true;
        }
      }
      return changed ? next : prev;
    });
    for (const key of toPush) pushPin(key, true);
  }, [pins, idSignature]); // eslint-disable-line react-hooks/exhaustive-deps
  const setPinned = useCallback((sessionId: string, pinned: boolean) => {
    const s = sessionsRef.current[sessionId];
    if (!s) return;
    const key = pinKey(s);
    setSessions((prev) => prev[sessionId] ? { ...prev, [sessionId]: { ...prev[sessionId], pinned: pinned || undefined, pinnedKey: key ?? undefined } } : prev);
    if (key) pushPin(key, pinned);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /** Renames the CLI session (same title the history lists show) and the tab right away. */
  const rename = useCallback((sessionId: string, title: string) => {
    const s = sessionsRef.current[sessionId];
    if (!s) return;
    setSessions((prev) => prev[sessionId] ? { ...prev, [sessionId]: { ...prev[sessionId], title } } : prev);
    if (s.agentSessionId) void api.historyRename(s.agent, s.agentSessionId, title, s.cwd).then(() => window.dispatchEvent(new Event('vibe:history-changed'))).catch(() => {});
  }, []);
  const close = useCallback((sessionId: string) => {
    agentClient.send({ type: 'session.close', sessionId });
    setSessions((prev) => { const n = { ...prev }; delete n[sessionId]; return n; });
  }, []);

  return { sessions, replaced, start, adopt, send, approve, answer, interrupt, stopTask, setMode, setModel, setPinned, rename, rewind, verify, close };
}
