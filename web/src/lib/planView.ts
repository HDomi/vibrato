import type { TodoItem } from './agent';
import { isInjected, todosFromInput, type ChatItem } from './chatStore';

/*
 * The plan view: a session regrouped as turns -> plan steps -> what was done for each step. The steps come from
 * the checklist the agent keeps itself, and every item is filed under the step that was in progress when it
 * happened. Three shapes of checklist exist:
 *  - TodoWrite (older Claude Code): the whole list, re-sent on every change;
 *  - TaskCreate / TaskUpdate (current Claude Code): one task at a time, numbered, kept for the whole session;
 *  - Codex plan updates, recorded in the timeline as TodoWrite items (chatStore 'todos').
 */

type Item<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>;

export interface StepStats {
  commands: number;
  failed: number;
  /** Distinct files written or edited. */
  files: string[];
  reads: number;
  subagents: number;
  /** Seconds spent in tools that reported progress (long commands, subagents). */
  toolSeconds: number;
}

export interface PlanStep {
  /** Stable within the turn: the step text as first seen. */
  key: string;
  content: string;
  activeForm?: string;
  status: TodoItem['status'];
  /** Top-level items filed under this step, in order (subagent activity stays nested under its tool). */
  items: ChatItem[];
  stats: StepStats;
  /** The last thing the agent said while on this step: usually what it did or found. */
  note: string | null;
}

export interface PlanTurn {
  id: string;
  user: Item<'user'> | null;
  /** Work before the first checklist (reading around, asking), or the whole turn when there is no checklist. */
  before: PlanStep;
  steps: PlanStep[];
  /** Work after the checklist, or between steps when none is in progress (wrap-up, final answer). */
  after: PlanStep;
  hasPlan: boolean;
  result: Item<'result'> | null;
  changes: Item<'changes'>[];
  verify: Item<'verify'>[];
  /** Approvals and questions still waiting for the user. */
  pending: (Item<'approval'> | Item<'question'>)[];
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']);
const SUBAGENT_TOOLS = new Set(['Agent', 'Task', 'SubAgent']);
/** Checklist bookkeeping: shown as the steps themselves, not as work. */
export const PLAN_TOOL = 'TodoWrite';
export const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
/** Housekeeping calls that are not work on any step (loading deferred tools). */
const SILENT_TOOLS = new Set(['ToolSearch']);
export const isPlanTool = (name: string) => name === PLAN_TOOL || TASK_TOOLS.has(name);

/** The number TaskCreate gave a task ("Task #3 created successfully: …"). */
function createdTaskId(it: Item<'tool'>): string | null {
  return it.output?.match(/Task #(\S+?) created/)?.[1] ?? null;
}

interface TaskState { id: string; content: string; activeForm?: string; status: TodoItem['status'] }

/** Task titles by id across the session, for one-line labels of TaskUpdate calls in the chat. */
export function taskTitles(items: ChatItem[]): Map<string, string> {
  const out = new Map<string, string>();
  let auto = 0;
  for (const it of items) {
    if (it.kind !== 'tool' || it.parent) continue;
    const i = (it.input ?? {}) as Record<string, unknown>;
    if (it.name === 'TaskCreate') {
      const id = createdTaskId(it) ?? String(auto + 1);
      auto = Math.max(auto, Number(id) || auto + 1);
      out.set(id, String(i.subject ?? ''));
    } else if (it.name === 'TaskUpdate' && typeof i.taskId === 'string' && typeof i.subject === 'string') out.set(i.taskId, i.subject);
  }
  return out;
}

const emptyStats = (): StepStats => ({ commands: 0, failed: 0, files: [], reads: 0, subagents: 0, toolSeconds: 0 });
const group = (key: string, content: string): PlanStep => ({ key, content, status: 'pending', items: [], stats: emptyStats(), note: null });

function editedFiles(it: Item<'tool'>): string[] {
  const i = (it.input ?? {}) as Record<string, unknown>;
  if (EDIT_TOOLS.has(it.name)) return typeof i.file_path === 'string' ? [i.file_path] : typeof i.notebook_path === 'string' ? [i.notebook_path] : [];
  if (it.name === 'FileChange') return ((i.changes as { path?: unknown }[] | undefined) ?? []).flatMap((c) => (typeof c.path === 'string' ? [c.path] : []));
  return [];
}

function file(step: PlanStep, it: ChatItem) {
  step.items.push(it);
  if (it.kind === 'assistant' && it.text.trim()) step.note = it.text.trim();
  if (it.kind !== 'tool') return;
  const s = step.stats;
  if (it.name === 'Bash') { s.commands++; }
  if (it.isError) s.failed++;
  if (READ_TOOLS.has(it.name)) s.reads++;
  if (SUBAGENT_TOOLS.has(it.name)) s.subagents++;
  s.toolSeconds += it.elapsed || 0;
  for (const f of editedFiles(it)) if (!s.files.includes(f)) s.files.push(f);
}

/** Groups a session's items for the plan view. Nested (subagent) items are left to their parent tool. */
export function buildPlan(items: ChatItem[]): PlanTurn[] {
  const turns: PlanTurn[] = [];
  let turn: PlanTurn | null = null;
  let active: PlanStep | null = null;
  // The step closed last: what the agent says right after closing it (before the next starts) is its summary.
  let justDone: PlanStep | null = null;
  // TaskCreate / TaskUpdate: the session's task list, and the step each task has in the current turn.
  const tasks = new Map<string, TaskState>();
  let autoId = 0;
  const taskStep = (t: PlanTurn, task: TaskState): PlanStep => {
    const key = `task:${task.id}`;
    let step = t.steps.find((s) => s.key === key);
    if (!step) { step = group(key, task.content); t.steps.push(step); }
    step.content = task.content; step.activeForm = task.activeForm; step.status = task.status;
    return step;
  };
  const start = (user: Item<'user'> | null, id: string) => {
    turn = { id, user, before: group('before', ''), steps: [], after: group('after', ''), hasPlan: false, result: null, changes: [], verify: [], pending: [] };
    turns.push(turn);
    active = null;
    justDone = null;
    return turn;
  };
  for (const it of items) {
    if ((it.kind === 'assistant' || it.kind === 'tool') && it.parent) continue;
    if (it.kind === 'user' && !isInjected(it)) {
      const t = start(it, it.id);
      const carried = [...tasks.values()].find((x) => x.status === 'in_progress');
      if (carried) { t.hasPlan = true; active = taskStep(t, carried); }
      continue;
    }
    const t: PlanTurn = turn ?? start(null, `pre-${it.id}`);
    if (it.kind === 'tool' && it.name === PLAN_TOOL) {
      const todos = todosFromInput(it.input);
      if (!todos) continue;
      t.hasPlan = true;
      for (const todo of todos) {
        let step = t.steps.find((s) => s.key === todo.content);
        if (!step) { step = group(todo.content, todo.content); t.steps.push(step); }
        step.status = todo.status;
        step.activeForm = todo.activeForm;
      }
      const was = active;
      active = t.steps.find((s) => s.status === 'in_progress') ?? null;
      justDone = was && was !== active && was.status === 'completed' ? was : active ? null : justDone;
      continue;
    }
    if (it.kind === 'tool' && (it.name === 'TaskCreate' || it.name === 'TaskUpdate')) {
      const i = (it.input ?? {}) as Record<string, unknown>;
      t.hasPlan = true;
      if (it.name === 'TaskCreate') {
        const id = createdTaskId(it) ?? String(autoId + 1);
        autoId = Math.max(autoId, Number(id) || autoId + 1);
        const task: TaskState = { id, content: String(i.subject ?? i.description ?? ''), activeForm: typeof i.activeForm === 'string' ? i.activeForm : undefined, status: 'pending' };
        tasks.set(id, task);
        taskStep(t, task);
      } else {
        const id = String(i.taskId ?? '');
        const task = tasks.get(id) ?? { id, content: `#${id}`, status: 'pending' as const };
        tasks.set(id, task);
        if (typeof i.subject === 'string') task.content = i.subject;
        if (typeof i.activeForm === 'string') task.activeForm = i.activeForm;
        if (i.status === 'deleted') {
          tasks.delete(id);
          t.steps = t.steps.filter((s) => s.key !== `task:${id}` || s.items.length > 0);
          if (active?.key === `task:${id}`) active = null;
          continue;
        }
        if (i.status === 'pending' || i.status === 'in_progress' || i.status === 'completed') task.status = i.status;
        const step = taskStep(t, task);
        if (task.status === 'in_progress') { active = step; justDone = null; }
        else if (active === step) { active = null; if (task.status === 'completed') justDone = step; }
      }
      continue;
    }
    if (it.kind === 'tool' && (TASK_TOOLS.has(it.name) || SILENT_TOOLS.has(it.name))) continue;
    if (it.kind === 'result') { t.result = it; continue; }
    if (it.kind === 'changes') { t.changes.push(it); continue; }
    if (it.kind === 'verify') { t.verify.push(it); continue; }
    if ((it.kind === 'approval' && !it.decision) || (it.kind === 'question' && !it.resolved)) t.pending.push(it);
    if (!active && justDone && !justDone.note && it.kind === 'assistant' && it.text.trim()) justDone.note = it.text.trim();
    // Without a step in progress: before any step has started it is preparation, afterwards it is wrap-up.
    const started = t.steps.some((x) => x.status !== 'pending');
    file(active ?? (started ? t.after : t.before), it);
  }
  return turns;
}

/** First sentence-ish of a note, for the one-line summary under a step. */
export function noteLine(note: string | null, max = 160): string | null {
  if (!note) return null;
  // The opening paragraph only: lists and details that follow are not the summary.
  const head = note.replace(/```[\s\S]*?```/g, ' ').split(/\n\s*\n|\n\s*(?:[-*•]|\d+\.)\s/)[0];
  const plain = head.replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim();
  if (!plain) return null;
  // Sentence by sentence until it says something: "Done." alone is not a summary.
  const sentences = plain.split(/(?<=[.!?。])\s+/);
  let out = '';
  for (const sentence of sentences) {
    out = out ? `${out} ${sentence}` : sentence;
    if (out.length >= 16) break;
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** Whether a step group has anything worth a card. */
export const hasWork = (s: PlanStep) => s.items.length > 0;
