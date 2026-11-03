import type { WorktreeInfo } from './api';
import type { AgentEvent, AgentId, Attachment, PermissionModeId, Question, TaskInfo, TodoItem, TurnFile, VerifyStatus } from './agent';

export type ChatItem =
  | { kind: 'user'; id: string; text: string; attachments: Attachment[]; pending?: boolean; /** Compaction summary injected by the CLI, not typed by the user. */ compact?: boolean;
      /** Other user-role turns the CLI wrote itself: background task notices, slash commands run in the terminal. */ injected?: InjectedKind }
  | { kind: 'assistant'; id: string; text: string; thinking: string; parent: string | null; streaming: boolean; /** When the block finished (server ms); absent for blocks loaded from saved history. */ at?: number }
  | { kind: 'tool'; id: string; name: string; input: unknown; output: string | null; isError: boolean; parent: string | null; elapsed: number; done: boolean; /** Images the tool returned: absolute paths, or data: URIs from saved history. */ images?: string[] }
  | { kind: 'approval'; id: string; toolName: string; input: unknown; canAlwaysAllow: boolean; decision: string | null }
  | { kind: 'question'; id: string; questions: Question[]; resolved: boolean }
  | { kind: 'result'; id: string; ok: boolean; text: string; costUsd: number; numTurns: number; durationMs: number; at?: number }
  | { kind: 'error'; id: string; message: string }
  | { kind: 'system'; id: string; text: string }
  | { kind: 'changes'; id: string; root: string; from: string; to: string; files: TurnFile[] }
  | { kind: 'verify'; id: string; status: VerifyStatus; command: string; output?: string; exitCode?: number; durationMs?: number };

const COMPACT_PREFIX = 'This session is being continued from a previous conversation';
/** Claude Code injects its compaction summary as a user turn; it must not be shown or titled as the user's words. */
export function isCompactSummary(text: string): boolean { return text.trimStart().startsWith(COMPACT_PREFIX); }

export type InjectedKind = 'task' | 'command';
/**
 * Claude Code records some turns as user messages that the user never typed: "<task-notification>" when a
 * background task or monitor ends (or was orphaned by a restart), and "<command-name>" / "<local-command-stdout>"
 * for slash commands run in the terminal CLI. Live they never reach the chat; a transcript replay must not show
 * them as the user's words. "skip" is pure bookkeeping (the caveat line before a local command).
 */
export function injectedKind(text: string): InjectedKind | 'skip' | null {
  const m = text.trimStart().match(/^<([\w-]+)>/);
  if (!m) return null;
  if (m[1] === 'task-notification') return 'task';
  if (m[1] === 'local-command-caveat') return 'skip';
  if (/^(command-name|command-message|command-args|local-command-stdout|local-command-stderr)$/.test(m[1])) return 'command';
  return null;
}

/** One line for a collapsed injected turn: the notice's summary, or the command and its output. */
export function injectedSummary(kind: InjectedKind, text: string): string {
  const tag = (name: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? '';
  const oneLine = (v: string) => v.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (kind === 'task') return oneLine(tag('summary') || tag('status'));
  const cmd = [tag('command-name'), tag('command-args')].filter(Boolean).join(' ');
  return oneLine(cmd || tag('local-command-stdout') || tag('local-command-stderr'));
}

/** A user item the user did not type (compaction summary, CLI notice): not a prompt, title, or rewind point. */
export function isInjected(it: Extract<ChatItem, { kind: 'user' }>): boolean { return !!(it.compact || it.injected); }

/** Tab / sidebar title: the first real user prompt, skipping compaction summaries. */
/** First `max` characters, with an ellipsis when something was cut. */
export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
}

export function sessionTitle(items: ChatItem[], max = 40): string | null {
  for (const it of items) {
    if (it.kind === 'user' && !isInjected(it) && it.text.trim()) return cut(it.text.trim().split('\n')[0], max);
  }
  return null;
}

/** What a tab or notification calls the session: the CLI title when known, else the first prompt. */
export function displayTitle(s: ChatSession, max = 40): string | null {
  const title = s.title?.trim();
  return title ? cut(title, max) : sessionTitle(s.items, max);
}

/**
 * Why a session needs attention while another one is on screen: it is still working, or it stopped
 * to ask the user something (approval / question). Null when idle, starting, or closed.
 */
export function backgroundState(s: ChatSession): 'running' | 'waiting' | null {
  if (s.status === 'compacting') return 'running';
  if (s.status !== 'running') return null;
  return pendingRequests(s) > 0 ? 'waiting' : 'running';
}

/** Approvals and questions of the current turn still waiting for the user (tab badge count). */
export function pendingRequests(s: ChatSession): number {
  if (s.status !== 'running') return 0;
  let n = 0;
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it.kind === 'user') break;
    if ((it.kind === 'approval' && !it.decision) || (it.kind === 'question' && !it.resolved)) n++;
  }
  return n;
}

/** TodoWrite input to checklist items; null when the input is not a todo list. */
export function todosFromInput(input: unknown): TodoItem[] | null {
  const list = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(list)) return null;
  return list.filter((x) => x && typeof x === 'object' && typeof (x as TodoItem).content === 'string').map((x) => {
    const t = x as TodoItem;
    return { content: t.content, status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending', activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined };
  });
}

/** The checklist to show: the live one, else the last TodoWrite in the loaded history. */
export function currentTodos(s: ChatSession): TodoItem[] {
  if (s.todos) return s.todos;
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it.kind === 'tool' && it.name === 'TodoWrite') return todosFromInput(it.input) ?? [];
  }
  return [];
}

/** Subagents and background tasks still working, oldest first; housekeeping tasks are left out. */
export function liveTasks(s: Pick<ChatSession, 'tasks'>): TaskInfo[] {
  return Object.values(s.tasks ?? {}).filter((t) => t.status === 'running' && !t.ambient).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

/** Whether a session belongs to the project on screen: its folder, or a worktree started from it. */
export function inProject(s: Pick<ChatSession, 'cwd' | 'worktree'>, project: string | null): boolean {
  return !!project && (s.cwd === project || s.worktree?.origin === project || s.worktree?.root === project);
}

/** Tab order: pinned first, then most recent activity. Stable for ties so tabs do not shuffle. */
export function sortSessions<T extends Pick<ChatSession, 'pinned' | 'lastActivity'>>(list: T[]): T[] {
  return list.map((s, i) => ({ s, i }))
    .sort((a, b) => Number(!!b.s.pinned) - Number(!!a.s.pinned) || (b.s.lastActivity ?? 0) - (a.s.lastActivity ?? 0) || a.i - b.i)
    .map((x) => x.s);
}

/** Events that move a tab forward; streaming deltas do not, or running tabs would jump around constantly. */
export const ACTIVITY_EVENTS = new Set(['user', 'result', 'approval.request', 'question.request']);

export interface ChatSession {
  id: string;
  agent: AgentId;
  cwd: string;
  /** Session title as the CLI keeps it (custom rename or generated summary); tabs show this over the first prompt. */
  title?: string;
  model?: string;
  permissionMode: PermissionModeId;
  agentSessionId?: string;
  /** Claude only: how many saved history messages were shown when this session started (resume). Server buffer replay covers the rest. */
  historyLen?: number;
  commands?: string[];
  /** When the current turn started (ms); undefined while idle. */
  turnStartedAt?: number;
  /** Remembered from a previous page load and not yet confirmed by the server (attach ack, replay or revive). */
  restoring?: boolean;
  /** Latest task checklist from the agent (TodoWrite / Codex plan); shown above the composer. */
  todos?: TodoItem[];
  /** Subagents and background tasks of the current CLI process, by task id (Claude). Ended ones stay for the relation graph. */
  tasks?: Record<string, TaskInfo>;
  /** Pinned tabs stay in front of the activity order. */
  pinned?: boolean;
  /** Set when the session runs in its own git worktree (cwd is the worktree folder). */
  worktree?: WorktreeInfo;
  /** Sessions started together on one prompt (Claude vs Codex comparison) share this key. */
  pairKey?: string;
  /** Opened from a previous conversation; the chat shows a briefing of what it already did. */
  resumed?: boolean;
  /** Last turn start, turn end or request (server ms); tabs sort by this, newest first. */
  lastActivity?: number;
  status: 'starting' | 'running' | 'idle' | 'compacting' | 'closed';
  items: ChatItem[];
  totalCostUsd: number;
  lastSeq: number;
}

let counter = 0;
const uid = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i;
const ATTACH_BLOCK = /\n\n(?:Attached file paths|첨부 파일 경로):\n((?:- .+(?:\n|$))+)$/;

/** Split the "Attached file paths:" block the adapters append for the model back into attachments. */
export function splitAttachments(text: string): { text: string; attachments: Attachment[] } {
  const m = text.match(ATTACH_BLOCK);
  if (!m) return { text, attachments: [] };
  const attachments: Attachment[] = m[1].split('\n').filter((l) => l.startsWith('- ')).map((l) => {
    const path = l.slice(2).trim();
    const name = path.split('/').pop() ?? path;
    return { path, name, kind: IMAGE_RE.test(name) ? 'image' as const : 'file' as const };
  });
  return { text: text.slice(0, m.index).trimEnd(), attachments };
}

/** Apply one event to a session, returning a new session object (immutable update). */
export function reduceEvent(s: ChatSession, e: AgentEvent, seq: number, ts = Date.now()): ChatSession {
  const items = s.items.slice();
  // Any live event proves the server knows this session, so it is no longer "restoring".
  const next: ChatSession = { ...s, items, lastSeq: Math.max(s.lastSeq, seq), restoring: undefined };

  const lastAssistant = (parent: string | null) => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'assistant' && it.parent === parent && it.streaming) return i;
      if (it.kind === 'user') break;
    }
    return -1;
  };

  switch (e.kind) {
    case 'session.init':
      next.agentSessionId = e.agentSessionId ?? s.agentSessionId;
      next.model = e.model ?? s.model;
      if (e.commands?.length) next.commands = e.commands;
      if (e.permissionMode) next.permissionMode = e.permissionMode as PermissionModeId;
      if (s.status === 'starting') next.status = 'idle';
      return next;
    case 'user': {
      // Live events carry clean text; replayed ones (Codex resume) may still include the appended path block.
      const split = splitAttachments(e.text);
      split.attachments = [...new Map([...split.attachments, ...e.attachments].map((a) => [a.path, a])).values()];
      // Confirm an optimistic local echo with the same text instead of appending a duplicate.
      // The echo carries the id the client chose (Claude checkpoints use it); older servers only match by text.
      const pendingIdx = items.findIndex((it) => it.kind === 'user' && it.pending && (e.messageId ? it.id === e.messageId : it.text === split.text));
      const id = e.messageId ?? uid();
      if (pendingIdx >= 0) items[pendingIdx] = { kind: 'user', id, text: split.text, attachments: split.attachments };
      else if (!e.messageId || !items.some((it) => it.id === e.messageId)) items.push({ kind: 'user', id, text: split.text, attachments: split.attachments, compact: isCompactSummary(split.text) || undefined });
      next.turnStartedAt = next.turnStartedAt ?? Date.now();
      return next;
    }
    case 'text.delta':
    case 'thinking.delta': {
      let i = lastAssistant(e.parent);
      if (i < 0) { items.push({ kind: 'assistant', id: uid(), text: '', thinking: '', parent: e.parent, streaming: true }); i = items.length - 1; }
      const a = items[i] as Extract<ChatItem, { kind: 'assistant' }>;
      items[i] = e.kind === 'text.delta' ? { ...a, text: a.text + e.text } : { ...a, thinking: a.thinking + e.text };
      return next;
    }
    case 'assistant.message': {
      const text = e.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const thinking = e.blocks.filter((b) => b.type === 'thinking').map((b) => (b as { text: string }).text).join('');
      const i = lastAssistant(e.parent);
      if (i >= 0) {
        const a = items[i] as Extract<ChatItem, { kind: 'assistant' }>;
        items[i] = { ...a, text: text || a.text, thinking: thinking || a.thinking, streaming: false, at: ts };
      } else if (text || thinking) {
        items.push({ kind: 'assistant', id: e.id, text, thinking, parent: e.parent, streaming: false, at: ts });
      }
      return next;
    }
    case 'todos':
      next.todos = e.items;
      return next;
    case 'task':
      next.tasks = { ...s.tasks, [e.task.id]: e.task };
      return next;
    case 'task.reset':
      next.tasks = undefined;
      return next;
    case 'tool.start':
      if (e.name === 'TodoWrite') { const todos = todosFromInput(e.input); if (todos) next.todos = todos; }
      items.push({ kind: 'tool', id: e.toolUseId, name: e.name, input: e.input, output: null, isError: false, parent: e.parent, elapsed: 0, done: false });
      return next;
    case 'tool.result': {
      const i = items.findIndex((it) => it.kind === 'tool' && it.id === e.toolUseId);
      if (i >= 0) items[i] = { ...(items[i] as Extract<ChatItem, { kind: 'tool' }>), output: e.content, isError: e.isError, done: true, ...(e.images?.length ? { images: e.images } : {}) };
      return next;
    }
    case 'tool.output': {
      const i = items.findIndex((it) => it.kind === 'tool' && it.id === e.toolUseId);
      if (i >= 0) { const t = items[i] as Extract<ChatItem, { kind: 'tool' }>; items[i] = { ...t, output: (t.output ?? '') + e.chunk }; }
      return next;
    }
    case 'tool.progress': {
      const i = items.findIndex((it) => it.kind === 'tool' && it.id === e.toolUseId);
      if (i >= 0) items[i] = { ...(items[i] as Extract<ChatItem, { kind: 'tool' }>), elapsed: e.elapsed };
      return next;
    }
    case 'approval.request':
      items.push({ kind: 'approval', id: e.requestId, toolName: e.toolName, input: e.input, canAlwaysAllow: e.canAlwaysAllow, decision: null });
      return next;
    case 'approval.resolved': {
      const i = items.findIndex((it) => it.kind === 'approval' && it.id === e.requestId);
      if (i >= 0) items[i] = { ...(items[i] as Extract<ChatItem, { kind: 'approval' }>), decision: e.decision };
      return next;
    }
    case 'question.request':
      items.push({ kind: 'question', id: e.requestId, questions: e.questions, resolved: false });
      return next;
    case 'question.resolved': {
      const i = items.findIndex((it) => it.kind === 'question' && it.id === e.requestId);
      if (i >= 0) items[i] = { ...(items[i] as Extract<ChatItem, { kind: 'question' }>), resolved: true };
      return next;
    }
    case 'status':
      next.status = e.status;
      if (e.status === 'running' && !next.turnStartedAt) next.turnStartedAt = Date.now();
      if (e.status === 'idle' || e.status === 'closed') next.turnStartedAt = undefined;
      if (e.status === 'closed') {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.kind === 'user' && item.pending) items[i] = { ...item, pending: false };
          if (item.kind === 'assistant' && item.streaming) items[i] = { ...item, streaming: false };
        }
        // The CLI process is gone, and its subagents with it.
        if (s.tasks && Object.values(s.tasks).some((t) => t.status === 'running')) {
          const ended = Date.now();
          next.tasks = Object.fromEntries(Object.values(s.tasks).map((t) => [t.id, t.status === 'running' ? { ...t, status: 'stopped' as const, endedAt: ended } : t]));
        }
      }
      if (e.permissionMode) next.permissionMode = e.permissionMode as PermissionModeId;
      return next;
    case 'result':
      for (let i = 0; i < items.length; i++) { const it = items[i]; if (it.kind === 'assistant' && it.streaming) items[i] = { ...it, streaming: false, at: it.at ?? ts }; }
      items.push({ kind: 'result', id: uid(), ok: e.ok, text: e.text, costUsd: e.costUsd, numTurns: e.numTurns, durationMs: e.durationMs, at: ts });
      next.totalCostUsd = e.costUsd;
      next.agentSessionId = e.agentSessionId ?? s.agentSessionId;
      next.status = 'idle';
      next.turnStartedAt = undefined;
      return next;
    case 'error':
      if ((seq === 0 && (!e.command || e.command === 'session.send')) || s.status === 'starting') {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.kind === 'user' && item.pending) items[i] = { ...item, pending: false };
          if (item.kind === 'assistant' && item.streaming) items[i] = { ...item, streaming: false };
        }
        if (next.status !== 'closed') next.status = 'idle';
        next.turnStartedAt = undefined;
      }
      items.push({ kind: 'error', id: uid(), message: e.message });
      return next;
    case 'changes':
      if (!items.some((it) => it.id === e.id)) items.push({ kind: 'changes', id: e.id, root: e.root, from: e.from, to: e.to, files: e.files });
      return next;
    case 'verify': {
      const item = { kind: 'verify' as const, id: e.id, status: e.status, command: e.command, output: e.output, exitCode: e.exitCode, durationMs: e.durationMs };
      const i = items.findIndex((it) => it.kind === 'verify' && it.id === e.id);
      if (i >= 0) items[i] = item; else items.push(item);
      return next;
    }
    case 'log':
      return s;
  }
}

/** Convert a stored Claude Code transcript into chat items for display when resuming. */
export function itemsFromHistory(messages: Array<{ type: string; uuid: string; message: unknown; parent_tool_use_id: string | null }>): ChatItem[] {
  const out: ChatItem[] = [];
  for (const m of messages) {
    const msg = m.message as { role?: string; content?: unknown } | undefined;
    const content = msg?.content;
    if (m.type === 'user') {
      const pushUser = (raw: string) => {
        const injected = injectedKind(raw);
        if (injected === 'skip') return;
        if (injected) { out.push({ kind: 'user', id: m.uuid, text: raw.trim(), attachments: [], injected }); return; }
        const s = splitAttachments(raw);
        out.push({ kind: 'user', id: m.uuid, text: s.text, attachments: s.attachments, compact: isCompactSummary(s.text) || undefined });
      };
      if (typeof content === 'string') { pushUser(content); continue; }
      if (!Array.isArray(content)) continue;
      const texts: string[] = [];
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === 'text') texts.push(String(b.text));
        else if (b.type === 'tool_result') {
          const i = out.findIndex((it) => it.kind === 'tool' && it.id === b.tool_use_id);
          const c = b.content;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x as { type?: string; text?: string }).type === 'image' ? '[image]' : (x as { text?: string }).text ?? '').join('\n') : '';
          const images = Array.isArray(c) ? (c as Array<{ type?: string; source?: { type?: string; data?: string; media_type?: string } }>)
            .filter((x) => x.type === 'image' && x.source?.type === 'base64' && x.source.data).map((x) => `data:${x.source!.media_type ?? 'image/png'};base64,${x.source!.data}`) : [];
          if (i >= 0) out[i] = { ...(out[i] as Extract<ChatItem, { kind: 'tool' }>), output: text, isError: Boolean(b.is_error), done: true, ...(images.length ? { images } : {}) };
        }
      }
      if (texts.length && !m.parent_tool_use_id) pushUser(texts.join('\n'));
    } else if (m.type === 'assistant' && Array.isArray(content)) {
      let text = ''; let thinking = '';
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === 'text') text += String(b.text);
        else if (b.type === 'thinking') thinking += String(b.thinking ?? '');
        else if (b.type === 'tool_use') out.push({ kind: 'tool', id: String(b.id), name: String(b.name), input: b.input, output: null, isError: false, parent: m.parent_tool_use_id, elapsed: 0, done: true });
      }
      if (text || thinking) out.push({ kind: 'assistant', id: m.uuid, text, thinking, parent: m.parent_tool_use_id, streaming: false });
    }
  }
  return out;
}
