/** Shared types mirrored from server/agents/types.ts (kept in sync by hand). */
export type AgentId = 'claude' | 'codex';
export type PermissionModeId = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto';
export interface Attachment { path: string; name: string; kind: 'image' | 'file'; mime?: string }
export interface QuestionOption { label: string; description?: string; preview?: string }
export interface Question { question: string; header: string; options: QuestionOption[]; multiSelect: boolean }
export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export type AgentEvent =
  | { kind: 'session.init'; sessionId: string; agent: AgentId; cwd: string; model?: string; permissionMode?: string; agentSessionId?: string; tools?: string[]; commands?: string[] }
  | { kind: 'user'; text: string; attachments: Attachment[]; /** Client-chosen id; Claude keys file checkpoints by it. */ messageId?: string }
  | { kind: 'text.delta'; text: string; parent: string | null }
  | { kind: 'thinking.delta'; text: string; parent: string | null }
  | { kind: 'assistant.message'; id: string; parent: string | null; blocks: AssistantBlock[] }
  | { kind: 'tool.start'; toolUseId: string; name: string; input: unknown; parent: string | null }
  | { kind: 'tool.result'; toolUseId: string; content: string; isError: boolean; parent: string | null; /** Images the tool returned or produced, as absolute file paths. */ images?: string[] }
  | { kind: 'tool.output'; toolUseId: string; chunk: string }
  | { kind: 'tool.progress'; toolUseId: string; name: string; elapsed: number }
  | { kind: 'approval.request'; requestId: string; toolUseId: string | null; toolName: string; input: unknown; canAlwaysAllow: boolean }
  | { kind: 'approval.resolved'; requestId: string; decision: 'allow' | 'allow_always' | 'deny' | 'cancelled' }
  | { kind: 'question.request'; requestId: string; questions: Question[] }
  | { kind: 'question.resolved'; requestId: string }
  | { kind: 'status'; status: 'running' | 'idle' | 'compacting' | 'closed'; permissionMode?: string }
  /** `costUsd` is the session's running total (Claude); `turnCostUsd` this turn's share, when it can be told. */
  | { kind: 'result'; ok: boolean; text: string; costUsd: number; turnCostUsd?: number; numTurns: number; durationMs: number; agentSessionId?: string }
  | { kind: 'error'; message: string; command?: string }
  /** The agent's own task checklist (Codex plan updates; Claude's TodoWrite is read from the tool call). */
  | { kind: 'todos'; items: TodoItem[] }
  /** Upsert of one subagent / background task (Claude). Replace the entry with the same id. */
  | { kind: 'task'; task: TaskInfo }
  /** The CLI process (re)started: every remembered task belongs to a process that is gone. */
  | { kind: 'task.reset' }
  /** Project verification run after a turn (see server/verify.ts). Upsert by id. */
  | { kind: 'verify'; id: string; status: VerifyStatus; command: string; output?: string; exitCode?: number; durationMs?: number }
  /** Files the turn changed (git snapshot before vs after, see server/turns.ts). */
  | { kind: 'changes'; id: string; root: string; from: string; to: string; files: TurnFile[] }
  | { kind: 'log'; text: string };

export interface TurnFile { path: string; status: 'A' | 'M' | 'D'; additions: number; deletions: number; binary: boolean }

export type VerifyStatus = 'running' | 'passed' | 'failed' | 'cancelled';

export interface TodoItem { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

export type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** A subagent, background shell, monitor or workflow the session spawned; the chips above the composer and the relation graph are built from these. */
export interface TaskInfo {
  id: string;
  /** CLI task type: local_agent, local_bash, monitor, local_workflow, ... */
  type: string;
  /** Agent type name of a local_agent task (general-purpose, Explore, ...). */
  subagentType?: string;
  description: string;
  /** Task that spawned this one; absent when the main thread did. */
  parentId?: string;
  /** The tool_use block that started the task; its card in the transcript. */
  toolUseId?: string;
  status: TaskStatus;
  background?: boolean;
  /** Housekeeping tasks the CLI asks hosts to keep out of activity indicators. */
  ambient?: boolean;
  startedAt: number;
  endedAt?: number;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
  lastTool?: string;
  summary?: string;
  error?: string;
}

export interface RewindResult { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }

export type ServerMessage =
  | { sessionId: string; seq: number; ts: number; event: AgentEvent }
  | { type: 'session.started'; sessionId: string; requestCwd: string; requestId?: string; agent: AgentId }
  | { type: 'session.startFailed'; requestId?: string; requestCwd: string; message: string }
  | { type: 'session.missing'; sessionId: string }
  /** The server still has this session; buffered events (if any) follow. */
  | { type: 'session.attached'; sessionId: string }
  | { type: 'session.rewindResult'; sessionId: string; requestId: string; result: RewindResult }
  | { type: 'pong' }
  /** Synthetic, client-side: the socket reconnected after a drop; subscriptions must be re-established. */
  | { type: 'reconnected' };

export type ClientCommand =
  | { type: 'session.start'; requestId?: string; agent: AgentId; cwd: string; resume?: string; permissionMode?: PermissionModeId; model?: string }
  | { type: 'ping' }
  | { type: 'session.attach'; sessionId: string; after?: number }
  | { type: 'session.send'; sessionId: string; text: string; attachments?: Attachment[]; messageId?: string }
  /** Restore files the agent changed to how they were before user message `messageId` (Claude only). */
  | { type: 'session.rewind'; sessionId: string; requestId: string; messageId: string; dryRun?: boolean }
  | { type: 'session.approve'; sessionId: string; requestId: string; decision: 'allow' | 'allow_always' | 'deny'; message?: string }
  | { type: 'session.answer'; sessionId: string; requestId: string; answers: Record<string, string>; response?: string }
  | { type: 'session.interrupt'; sessionId: string }
  /** Stop one subagent / background task without interrupting the turn (Claude only). */
  | { type: 'session.stopTask'; sessionId: string; taskId: string }
  | { type: 'session.mode'; sessionId: string; mode: PermissionModeId }
  | { type: 'session.model'; sessionId: string; model: string | null }
  | { type: 'session.close'; sessionId: string }
  /** Run the project's verification command now, whether or not the last turn changed files. */
  | { type: 'session.verify'; sessionId: string };

type Listener = (m: ServerMessage) => void;

/** Reconnecting WebSocket client for the agent protocol. */
export class AgentClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private queue: string[] = [];
  private retry = 0;
  private closed = false;
  private opens = 0;
  private lastSeen = Date.now();
  private heartbeat: number | null = null;
  readonly ready: Promise<void>;
  private resolveReady!: () => void;

  constructor() {
    this.ready = new Promise((r) => { this.resolveReady = r; });
    this.connect();
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.lastSeen = Date.now();
      const reconnected = this.opens++ > 0;
      this.resolveReady();
      // Tell subscribers first so they can re-attach before any queued command needs the subscription.
      if (reconnected) for (const l of this.listeners) l({ type: 'reconnected' });
      for (const q of this.queue.splice(0)) ws.send(q);
      this.startHeartbeat(ws);
    };
    ws.onmessage = (ev) => {
      this.lastSeen = Date.now();
      let m: ServerMessage;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if ('type' in m && m.type === 'pong') return;
      for (const l of this.listeners) l(m);
    };
    ws.onclose = () => {
      this.stopHeartbeat();
      if (this.closed) return;
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => { if (!this.closed) this.connect(); }, delay);
    };
    ws.onerror = () => ws.close();
  }

  /** Detect half-open sockets (sleep/wake, server restart) that never fire onclose: ping every 15s, drop after 40s of silence. */
  private startHeartbeat(ws: WebSocket) {
    this.stopHeartbeat();
    this.heartbeat = window.setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastSeen > 40000) { ws.close(); return; }
      ws.send(JSON.stringify({ type: 'ping' }));
    }, 15000);
  }
  private stopHeartbeat() { if (this.heartbeat !== null) { window.clearInterval(this.heartbeat); this.heartbeat = null; } }

  send(cmd: ClientCommand) {
    const s = JSON.stringify(cmd);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push(s);
  }

  /** Drop the current socket and reconnect right away (after the Mac wakes a half-open socket would otherwise sit for up to 40s). */
  reconnectNow() {
    if (this.closed) return;
    this.retry = 0;
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) this.ws.close();
    else this.connect();
  }
  on(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  close() { this.closed = true; this.stopHeartbeat(); this.queue = []; this.ws?.close(); }
}

export const agentClient = new AgentClient();
