/** Unified event schema shared by every agent adapter (Claude, Codex, ...). */

export type AgentId = 'claude' | 'codex';
export type PermissionModeId = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto';

export interface Attachment {
  path: string;
  name: string;
  kind: 'image' | 'file';
  mime?: string;
}

export interface QuestionOption { label: string; description?: string; preview?: string }
export interface Question { question: string; header: string; options: QuestionOption[]; multiSelect: boolean }

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

export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export type ServerMessage = { sessionId: string; seq: number; ts: number; event: AgentEvent };

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

export interface RewindResult { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }

export interface AgentSession {
  readonly id: string;
  readonly agent: AgentId;
  readonly cwd: string;
  start(): void;
  onEvent(listener: (e: AgentEvent) => void): () => void;
  send(text: string, attachments: Attachment[], messageId?: string): Promise<void>;
  /** Claude only: file checkpoints per user message. */
  rewindFiles?(messageId: string, dryRun: boolean): Promise<RewindResult>;
  approve(requestId: string, decision: 'allow' | 'allow_always' | 'deny', message?: string): void;
  answer(requestId: string, answers: Record<string, string>, response?: string): void;
  interrupt(): Promise<void>;
  /** Claude only: stop one subagent / background task; the CLI then emits a task_notification with status 'stopped'. */
  stopTask?(taskId: string): Promise<void>;
  setPermissionMode(mode: PermissionModeId): Promise<void>;
  setModel(model: string | null): Promise<void>;
  close(): Promise<void>;
}
