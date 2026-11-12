import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { reduceEvent, type ChatSession } from './chatStore';
import type { AgentEvent, AgentId, PermissionModeId } from './agent';

/*
 * Remote tab state. The connection itself lives in the Electron main process (electron/remote.cts) and outlives
 * this page; here are the saved hosts, the connection state, and the chats of the sessions being watched, built
 * with the same reducer as local sessions (chatStore.reduceEvent).
 */

export interface RemoteHostView { id: string; name: string; address: string; port: number; fingerprint: string | null; hasCode: boolean }
export type RemoteStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
export interface RemoteState {
  status: RemoteStatus;
  hostId: string | null;
  hostName: string | null;
  error: { code: string; message: string; fingerprint?: string; retryAfterMs?: number } | null;
  since: number | null;
  attempt: number;
}
export interface RemoteSessionSummary {
  id: string; agent: AgentId; cwd: string; title: string; createdAt: number; lastActivity: number; running: boolean; waiting: number; permissionMode?: string;
}
export interface RemoteHistoryRow { agent: AgentId; sessionId: string; title: string; lastModified: number }
export interface RemoteProjects { favorites: { path: string; name: string }[]; recent: string[] }
export interface RemoteInfo { host: string; version: string; home: string }

export interface RemoteBridge {
  hosts: () => Promise<RemoteHostView[]>;
  saveHost: (h: { id?: string; name: string; address: string; port: number | string }) => Promise<RemoteHostView>;
  removeHost: (id: string) => Promise<void>;
  forgetCode: (id: string) => Promise<void>;
  trust: (id: string, fingerprint: string) => Promise<void>;
  connect: (req: { hostId: string; code?: string; password?: string; remember?: boolean }) => Promise<RemoteState>;
  disconnect: () => Promise<void>;
  state: () => Promise<RemoteState | null>;
  call: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  onState: (cb: (s: RemoteState) => void) => () => void;
  /** Session events, a batch at a time (oldest first). */
  onEvents: (cb: (list: { sessionId: string; seq: number; ts: number; event: AgentEvent }[]) => void) => () => void;
  onSessions: (cb: () => void) => () => void;
}

export const remoteBridge = (): RemoteBridge | null => (window.vibe as { remote?: RemoteBridge } | undefined)?.remote ?? null;
export const remoteOnly = () => !!(window.vibe as { remoteOnly?: boolean } | undefined)?.remoteOnly;

const IDLE: RemoteState = { status: 'idle', hostId: null, hostName: null, error: null, since: null, attempt: 0 };

// ---- connection state ----

let state: RemoteState = IDLE;
const stateListeners = new Set<() => void>();
let wired = false;

function wire() {
  if (wired) return;
  const b = remoteBridge();
  if (!b) return;
  wired = true;
  b.onState((s) => {
    const was = state;
    state = s;
    for (const l of stateListeners) l();
    // Another host, or a fresh connection after "Disconnect": nothing of the old chats applies.
    if (s.hostId !== was.hostId) resetChats();
  });
  b.onEvents((list) => {
    const changed = new Set<string>();
    for (const m of list) if (applyMessage(m)) changed.add(m.sessionId);
    for (const id of changed) bump(id);
  });
  void b.state().then((s) => { if (s) { state = s; for (const l of stateListeners) l(); } });
}

export function useRemoteState(): RemoteState {
  wire();
  return useSyncExternalStore((cb) => { stateListeners.add(cb); return () => { stateListeners.delete(cb); }; }, () => state);
}

// ---- watched session chats ----

const chats = new Map<string, ChatSession>();
/** Listeners per session: a chat re-renders only for its own session's events. */
const chatListeners = new Map<string, Set<() => void>>();

/** Tell the watchers of one session (or of all, without an id) that its chat changed. */
function bump(id?: string) {
  if (id) { chatListeners.get(id)?.forEach((l) => l()); return; }
  for (const set of chatListeners.values()) set.forEach((l) => l());
}

function resetChats() { chats.clear(); bump(); }

function blankChat(s: Pick<RemoteSessionSummary, 'id' | 'agent' | 'cwd'> & { permissionMode?: string }): ChatSession {
  return { id: s.id, agent: s.agent, cwd: s.cwd, permissionMode: (s.permissionMode as PermissionModeId) ?? 'default', status: 'starting', items: [], totalCostUsd: 0, lastSeq: 0 };
}

/** Apply one event to its chat; true when something changed (the caller renders once per batch). */
function applyMessage(m: { sessionId: string; seq: number; ts: number; event: AgentEvent }): boolean {
  const c = m && chats.get(m.sessionId);
  if (!c || !m.event) return false;
  // Replays after a reconnect overlap what is already here; seq 0 (errors) is never a duplicate.
  if (m.seq > 0 && m.seq <= c.lastSeq) return false;
  chats.set(m.sessionId, reduceEvent(c, m.event, m.seq, m.ts));
  return true;
}

/**
 * The chat of session `id`. While `live` is false (the view is hidden) updates are not followed; the latest
 * chat shows as soon as it is true again.
 */
export function useRemoteChat(id: string | null, live = true): ChatSession | null {
  const subscribe = useCallback((cb: () => void) => {
    if (!id || !live) return () => {};
    let set = chatListeners.get(id);
    if (!set) chatListeners.set(id, set = new Set());
    set.add(cb);
    return () => { set.delete(cb); if (!set.size && chatListeners.get(id) === set) chatListeners.delete(id); };
  }, [id, live]);
  return useSyncExternalStore(subscribe, () => (id ? chats.get(id) ?? null : null));
}

/** Start watching a session: an empty chat filled by the host's replay of everything so far. */
export async function watchSession(s: Pick<RemoteSessionSummary, 'id' | 'agent' | 'cwd'> & { permissionMode?: string }) {
  const b = remoteBridge();
  if (!b) return;
  if (!chats.has(s.id)) { chats.set(s.id, blankChat(s)); bump(s.id); }
  await b.call('attach', { sessionId: s.id, after: chats.get(s.id)!.lastSeq });
}

/**
 * Stop watching a session: the host stops streaming its events and the cached chat is dropped (watching it
 * again replays it from the start). Errors are ignored: a lost connection or a closed session has nothing to detach.
 */
export function unwatchSession(id: string) {
  chats.delete(id);
  bump(id);
  void remoteBridge()?.call('detach', { sessionId: id }).catch(() => {});
}

export async function startSession(opts: { agent: AgentId; cwd: string; permissionMode: PermissionModeId; resume?: string; model?: string }): Promise<string> {
  const b = remoteBridge()!;
  const { sessionId } = await b.call<{ sessionId: string }>('start', opts);
  // Events sent before this reply had no chat to land in: replay from the start (duplicates are skipped by seq).
  await watchSession({ id: sessionId, agent: opts.agent, cwd: opts.cwd, permissionMode: opts.permissionMode });
  return sessionId;
}

export async function closeSession(id: string) {
  await remoteBridge()?.call('close', { sessionId: id });
  chats.delete(id);
  bump(id);
}

export interface RemoteModel { id: string; name: string; description?: string; isDefault?: boolean }

/**
 * What was being typed for one session (or the new-session form, scope "new:<folder>"), per host. Kept in
 * localStorage so it survives switching sessions, reconnects and restarts, like the local composer's drafts.
 */
export function useRemoteDraft(scope: string): [string, (v: string) => void] {
  const key = `vibe.remote.draft.${state.hostId ?? 'none'}.${scope}`;
  const [text, setText] = useState(() => { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } });
  useEffect(() => { try { setText(localStorage.getItem(key) ?? ''); } catch { setText(''); } }, [key]);
  const set = (v: string) => {
    setText(v);
    try { if (v) localStorage.setItem(key, v); else localStorage.removeItem(key); } catch { /* storage full or off: keep it in memory only */ }
  };
  return [text, set];
}

/** Model lists of the connected host, per agent; dropped when the connection changes. */
const modelLists = new Map<AgentId, Promise<RemoteModel[] | null>>();
let modelsFor: string | null = null;

/**
 * The host's models for `agent`, or null while loading and when the host is too old to list them
 * (the pickers are then hidden and the CLI's default model is used).
 */
export function useRemoteModels(agent: AgentId | null | undefined, hostKey: string | null): RemoteModel[] | null {
  const [list, setList] = useState<RemoteModel[] | null>(null);
  useEffect(() => {
    const b = remoteBridge();
    if (!b || !agent || !hostKey) { setList(null); return; }
    if (modelsFor !== hostKey) { modelLists.clear(); modelsFor = hostKey; }
    let p = modelLists.get(agent);
    if (!p) {
      p = b.call<RemoteModel[]>('models', { agent }).then((l) => (Array.isArray(l) ? l : []), () => null);
      modelLists.set(agent, p);
    }
    let alive = true;
    void p.then((l) => { if (alive) setList(l); });
    return () => { alive = false; };
  }, [agent, hostKey]);
  return list;
}

/** Sessions, projects and history of the connected host; refetched when the host says its list changed. */
export function useRemoteSessions(connected: boolean) {
  const [sessions, setSessions] = useState<RemoteSessionSummary[]>([]);
  useEffect(() => {
    const b = remoteBridge();
    if (!b || !connected) { setSessions([]); return; }
    let alive = true;
    const load = () => void b.call<RemoteSessionSummary[]>('sessions').then((s) => { if (alive) setSessions(s); }).catch(() => {});
    load();
    const off = b.onSessions(load);
    return () => { alive = false; off(); };
  }, [connected]);
  return sessions;
}

// ---- this Mac as a host (local server routes, full app only) ----

export interface HostStatus {
  configured: boolean; enabled: boolean; port: number; listening: boolean; error: string | null; fingerprint: string | null;
  codeCreatedAt: number | null; passwordSetAt: number | null; webhook: string | null; keepAwake: boolean; wakeOnConnect: boolean; awake: boolean; clients: { address: string; since: number }[]; addresses: string[];
}

async function hostCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  // The local server takes POST / PUT only with a JSON body (server/app.ts request guard), even an empty one.
  const send = method !== 'GET';
  const res = await fetch(path, { method, headers: send ? { 'Content-Type': 'application/json' } : undefined, body: send ? JSON.stringify(body ?? {}) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const hostApi = {
  status: () => hostCall<HostStatus>('GET', '/api/remote/host'),
  configure: (patch: { enabled?: boolean; port?: number; keepAwake?: boolean; wakeOnConnect?: boolean }) => hostCall<HostStatus & { code: string | null }>('PUT', '/api/remote/host', patch),
  setWebhook: (url: string | null) => hostCall<HostStatus>('PUT', '/api/remote/host/webhook', { url }),
  testWebhook: () => hostCall<{ ok: true }>('POST', '/api/remote/host/webhook/test'),
  setPassword: (password: string) => hostCall<HostStatus>('PUT', '/api/remote/host/password', { password }),
  newCode: () => hostCall<HostStatus & { code: string }>('POST', '/api/remote/host/code'),
  disconnectAll: () => hostCall<HostStatus>('POST', '/api/remote/host/disconnect'),
};
