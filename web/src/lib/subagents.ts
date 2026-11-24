/*
 * Subagents the main session started, as one record each: the Agent tool call (what was asked, its result), the
 * live task the CLI reports while it runs (status, progress summary, tokens), and what its final answer says about
 * itself (agent id, usage). A session loaded from history has only the tool calls, so the rest is read off the result.
 */
import type { TaskInfo, TaskStatus } from './agent';
import type { ChatItem } from './chatStore';

type Tool = Extract<ChatItem, { kind: 'tool' }>;

export const SUBAGENT_CALLS = new Set(['Agent', 'Task', 'SubAgent']);

/** What an Agent tool result says about the run: "agentId: …" and the usage block, in either format the CLI writes. */
export function parseAgentResult(output: string | null | undefined): { agentId?: string; totalTokens?: number; toolUses?: number; durationMs?: number } {
  const text = output ?? '';
  const num = (re: RegExp) => { const m = text.match(re); return m ? Number(m[1]) : undefined; };
  const agentId = text.match(/agentId:\s*([\w-]{6,})/)?.[1];
  const totalTokens = num(/(?:total_tokens|subagent_tokens)\D{0,3}(\d+)/);
  const toolUses = num(/tool_uses\D{0,3}(\d+)/);
  const durationMs = num(/duration_ms\D{0,3}(\d+)/);
  return { ...(agentId ? { agentId } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}), ...(toolUses !== undefined ? { toolUses } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
}

export interface Subagent {
  toolUseId: string;
  /** subagent_type (Explore, general-purpose, …) or the Codex tool. */
  kind: string;
  description: string;
  status: TaskStatus;
  background: boolean;
  /** Task id to stop it (live sessions only). */
  taskId?: string;
  /** Id of its transcript (getSubagentMessages), once known. */
  agentId?: string;
  startedAt?: number;
  endedAt?: number;
  totalTokens?: number;
  toolUses?: number;
  lastTool?: string;
  summary?: string;
  error?: string;
  /** First line of its final answer. */
  result?: string;
}

const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find((l) => l && !/^agentId:|^<usage>|^\[/.test(l));

/** One subagent call, merged with its live task (matched by tool call id) when there is one. */
export function subagentOf(it: Tool, tasks: Record<string, TaskInfo> | undefined): Subagent {
  const input = (it.input ?? {}) as { subagent_type?: unknown; description?: unknown; prompt?: unknown; tool?: unknown };
  const task = tasks ? Object.values(tasks).find((x) => x.toolUseId === it.id) : undefined;
  const parsed = it.done ? parseAgentResult(it.output) : {};
  const description = typeof input.description === 'string' && input.description.trim() ? input.description.trim()
    : typeof input.prompt === 'string' ? input.prompt.trim().split('\n')[0].slice(0, 160) : '';
  const status: TaskStatus = task?.status ?? (it.done ? (it.isError ? 'failed' : 'completed') : 'running');
  return {
    toolUseId: it.id,
    kind: String(input.subagent_type ?? task?.subagentType ?? input.tool ?? it.name),
    description: task?.description?.split('\n')[0] || description,
    status,
    background: !!task?.background,
    ...(task ? { taskId: task.id } : {}),
    ...(parsed.agentId ? { agentId: parsed.agentId } : {}),
    ...(task?.startedAt ?? it.at ? { startedAt: task?.startedAt ?? it.at } : {}),
    ...(task?.endedAt ? { endedAt: task.endedAt } : {}),
    ...(task?.usage?.totalTokens ?? parsed.totalTokens ? { totalTokens: task?.usage?.totalTokens ?? parsed.totalTokens } : {}),
    ...(task?.usage?.toolUses ?? parsed.toolUses ? { toolUses: task?.usage?.toolUses ?? parsed.toolUses } : {}),
    ...(task?.lastTool ? { lastTool: task.lastTool } : {}),
    ...(task?.summary ? { summary: task.summary } : {}),
    ...(task?.error ? { error: task.error } : {}),
    ...(it.done && it.output ? { result: firstLine(it.output) } : {}),
  };
}

/** The subagents started by these items (main session calls only), in order. */
export function subagentsIn(items: ChatItem[], tasks: Record<string, TaskInfo> | undefined): Subagent[] {
  return items.filter((it): it is Tool => it.kind === 'tool' && !it.parent && SUBAGENT_CALLS.has(it.name)).map((it) => subagentOf(it, tasks));
}

/**
 * Finished subagents of a session loaded from history, as tasks: the CLI's task list only covers its current process,
 * so without this the relation graph and the plan view would know nothing of them.
 */
export function tasksFromHistory(items: ChatItem[]): Record<string, TaskInfo> {
  const out: Record<string, TaskInfo> = {};
  for (const it of items) {
    if (it.kind !== 'tool' || it.parent || !SUBAGENT_CALLS.has(it.name) || !it.done) continue;
    const s = subagentOf(it, undefined);
    const id = s.agentId ?? `history-${it.id}`;
    out[id] = {
      id, type: 'local_agent', subagentType: s.kind, description: s.description, toolUseId: it.id, status: s.status, startedAt: it.at ?? 0, restored: true,
      ...(s.totalTokens !== undefined || s.toolUses !== undefined ? { usage: { totalTokens: s.totalTokens ?? 0, toolUses: s.toolUses ?? 0, durationMs: parseAgentResult(it.output).durationMs ?? 0 } } : {}),
      ...(s.result ? { summary: s.result } : {}),
    };
  }
  return out;
}
