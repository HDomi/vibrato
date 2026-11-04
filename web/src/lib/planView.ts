import type { TodoItem } from './agent';
import { isInjected, todosFromInput, type ChatItem } from './chatStore';

/*
 * The plan view: a session regrouped as turns -> plan steps -> what was done for each step. Nothing new is
 * asked of the agent here; the steps come from the checklist it already keeps (Claude's TodoWrite calls, and
 * Codex plan updates recorded the same way), and every item is filed under the step that was in progress
 * when it happened.
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
  const start = (user: Item<'user'> | null, id: string) => {
    turn = { id, user, before: group('before', ''), steps: [], after: group('after', ''), hasPlan: false, result: null, changes: [], verify: [], pending: [] };
    turns.push(turn);
    active = null;
    return turn;
  };
  for (const it of items) {
    if ((it.kind === 'assistant' || it.kind === 'tool') && it.parent) continue;
    if (it.kind === 'user' && !isInjected(it)) { start(it, it.id); continue; }
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
      active = t.steps.find((s) => s.status === 'in_progress') ?? null;
      continue;
    }
    if (it.kind === 'result') { t.result = it; continue; }
    if (it.kind === 'changes') { t.changes.push(it); continue; }
    if (it.kind === 'verify') { t.verify.push(it); continue; }
    if ((it.kind === 'approval' && !it.decision) || (it.kind === 'question' && !it.resolved)) t.pending.push(it);
    file(active ?? (t.hasPlan ? t.after : t.before), it);
  }
  return turns;
}

/** First sentence-ish of a note, for the one-line summary under a step. */
export function noteLine(note: string | null, max = 160): string | null {
  if (!note) return null;
  const plain = note.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`]/g, '').replace(/\s+/g, ' ').trim();
  if (!plain) return null;
  const end = plain.search(/(?<=[.!?。])\s|(?<=다\.)\s/);
  const first = end > 0 && end < max ? plain.slice(0, end) : plain;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** Whether a step group has anything worth a card. */
export const hasWork = (s: PlanStep) => s.items.length > 0;
