import type { TodoItem } from './agent';
import { isInjected, todosFromInput, type ChatItem } from './chatStore';
import { codePathCandidate } from './localPath';
import { doneMarks, isPlanStepTool, mergedPlan, planIn, planStepMark, resultOf, stepEntries } from './textPlan';

export { doneMarks, textPlan } from './textPlan';

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
  /** Tool calls the user turned down. */
  denied: number;
  /** Errors the agent hit (not tool failures, which are counted in `failed`). */
  errors: number;
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
  /** Every "✓ n." account of this step, in order: a step done again in later rounds has several (a., b., c.). */
  entries: PlanEntry[];
  /** Closed without being done ("✓ n. Not done: why"); `note` holds the why. */
  skipped?: boolean;
  /** First and last timed item filed under it (server ms). */
  startedAt?: number;
  endedAt?: number;
}

/** One account of a step: the plan title it had in that round, what was done, and the round's headline. */
export interface PlanEntry {
  title: string;
  note: string;
  detail: string | null;
  skipped: boolean;
  /** The message it was written in. */
  itemId?: string;
}

export interface PlanTurn {
  id: string;
  user: Item<'user'> | null;
  /** Messages the user added while the agent was still on this request: part of it, not new requests. */
  additions: string[];
  /** When the first timed item of the turn happened (server ms); absent for turns loaded from saved history. */
  startedAt?: number;
  /** Work before the first checklist (reading around, asking), or the whole turn when there is no checklist. */
  before: PlanStep;
  steps: PlanStep[];
  /** Work after the checklist, or between steps when none is in progress (wrap-up, final answer). */
  after: PlanStep;
  hasPlan: boolean;
  result: Item<'result'> | null;
  changes: Item<'changes'>[];
  /** Commits the turn made (short hashes), and whether it pushed. */
  commits: string[];
  pushed: boolean;
  /** Absolute paths of the files this turn created, in order. */
  created: string[];
  /**
   * File paths the turn named without a tool that shows it created them (a link in the reply, a shell redirect),
   * as written: absolute, "~/" or relative to the session folder. Whether they were made in this turn is checked
   * against the disk (see PlanView).
   */
  mentioned: string[];
  verify: Item<'verify'>[];
  /** Approvals and questions still waiting for the user. */
  pending: (Item<'approval'> | Item<'question'>)[];
  /** The agent's own words in this turn, in order (for the plan written as text and the result line). */
  texts: string[];
  /** Item ids of `texts`, index for index. */
  textIds: string[];
  /** The outcome: the reply's "Result:" line, else the gist of its last message (all of it when there is no plan). */
  answer: string | null;
  /** The answer is the whole last message (markdown), not a one-line summary. */
  answerFull: boolean;
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

const emptyStats = (): StepStats => ({ commands: 0, failed: 0, files: [], reads: 0, subagents: 0, toolSeconds: 0, denied: 0, errors: 0 });
const group = (key: string, content: string): PlanStep => ({ key, content, status: 'pending', items: [], stats: emptyStats(), note: null, entries: [] });

function editedFiles(it: Item<'tool'>): string[] {
  const i = (it.input ?? {}) as Record<string, unknown>;
  if (EDIT_TOOLS.has(it.name)) return typeof i.file_path === 'string' ? [i.file_path] : typeof i.notebook_path === 'string' ? [i.notebook_path] : [];
  if (it.name === 'FileChange') return ((i.changes as { path?: unknown }[] | undefined) ?? []).flatMap((c) => (typeof c.path === 'string' ? [c.path] : []));
  return [];
}

/** Files a tool call created: Claude's Write onto a new path, Codex's "add" file changes. */
function createdFiles(it: Item<'tool'>): string[] {
  if (!it.done || it.isError) return [];
  const i = (it.input ?? {}) as Record<string, unknown>;
  if (it.name === 'Write') return typeof i.file_path === 'string' && /^File created successfully/.test(it.output ?? '') ? [i.file_path] : [];
  if (it.name === 'FileChange') {
    return ((i.changes as { path?: unknown; kind?: { type?: unknown } }[] | undefined) ?? [])
      .flatMap((c) => (typeof c.path === 'string' && c.path.startsWith('/') && c.kind?.type === 'add' ? [c.path] : []));
  }
  return [];
}

const MENTION_LIMIT = 40;
/** A path-looking token with a file extension, as agents write them in prose: /abs/x.md, ~/x.png, ./out/x.csv. */
const BARE_PATH = /(?:^|[\s(:："'“])((?:~\/|\.{0,2}\/(?!\/))[^\s`'"“”()<>\[\]]*[\w-]\.[A-Za-z][\w]{0,9})(?=[\s)"'”.,:;!?]|$)/gm;
const MD_LINK = /\]\(([^)\s]+)\)/g;
const BACKTICK = /`([^`\n]+)`/g;
/** Where a shell command writes: "> f", ">> f", "-o f", "--output f", "tee f". */
const SHELL_OUT = /(?:^|[\s;&|])(?:>>?|-o|--output(?:=|\s)|tee(?:\s+-a)?)\s*(['"]?)([^\s'";&|<>]+)\1/g;

/** File paths named in the agent's words. */
export function pathsInText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MD_LINK)) if (!/^[a-z][\w+.-]*:/i.test(m[1]) || m[1].startsWith('file://')) out.push(m[1].replace(/^file:\/\//, ''));
  for (const m of text.matchAll(BACKTICK)) { const c = codePathCandidate(m[1]); if (c && /\.[A-Za-z][\w]{0,9}(?::\d+(?::\d+)?)?$/.test(c)) out.push(c.replace(/:\d+(?::\d+)?$/, '')); }
  for (const m of text.matchAll(BARE_PATH)) out.push(m[1]);
  return [...new Set(out)];
}

/** Files a shell command writes to. */
export function pathsWritten(command: string): string[] {
  return [...command.matchAll(SHELL_OUT)].map((m) => m[2]).filter((p) => p !== '/dev/null' && !p.startsWith('&') && /[\w-]\.[A-Za-z][\w]{0,9}$/.test(p));
}

/** A shell command that commits / pushes, and the "[main 854020d] subject" line git commit prints. */
const GIT_COMMIT = /\bgit\b[^\n|;&]*\bcommit\b/;
const GIT_PUSH = /\bgit\b[^\n|;&]*\bpush\b/;
const COMMIT_OUT = /^\[[^\]\n]*?\s([0-9a-f]{7,40})\]/m;

const addMentioned = (t: PlanTurn, paths: string[]) => { for (const p of paths) if (t.mentioned.length < MENTION_LIMIT && !t.mentioned.includes(p)) t.mentioned.push(p); };

const addCreated = (t: PlanTurn, paths: string[]) => { for (const p of paths) if (!t.created.includes(p)) t.created.push(p); };

function file(step: PlanStep, it: ChatItem) {
  step.items.push(it);
  const s = step.stats;
  const at = 'at' in it ? it.at : undefined;
  if (at) {
    step.startedAt ??= at;
    step.endedAt = Math.max(step.endedAt ?? 0, at + (it.kind === 'tool' ? (it.elapsed || 0) * 1000 : 0));
  }
  if (it.kind === 'assistant' && it.text.trim()) step.note = it.text.trim();
  if (it.kind === 'approval' && it.decision === 'deny') s.denied++;
  if (it.kind === 'error') s.errors++;
  if (it.kind !== 'tool') return;
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
    turn = { id, user, additions: [], before: group('before', ''), steps: [], after: group('after', ''), hasPlan: false, result: null, changes: [], verify: [], pending: [], texts: [], textIds: [], answer: null, answerFull: false, commits: [], pushed: false, created: [], mentioned: [] };
    turns.push(turn);
    active = null;
    justDone = null;
    return turn;
  };
  for (const it of items) {
    if ((it.kind === 'assistant' || it.kind === 'tool') && it.parent) continue;
    if (it.kind === 'user' && !isInjected(it)) {
      // Assigned inside start(), which the compiler does not follow.
      const cur = turn as PlanTurn | null;
      if (it.followUp && cur?.user && !cur.result) { cur.additions.push(it.text); continue; }
      const t = start(it, it.id);
      const carried = [...tasks.values()].find((x) => x.status === 'in_progress');
      if (carried) { t.hasPlan = true; active = taskStep(t, carried); }
      continue;
    }
    const t: PlanTurn = turn ?? start(null, `pre-${it.id}`);
    if ('at' in it && it.at && !t.startedAt) t.startedAt = it.at;
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
    if (it.kind === 'changes') { t.changes.push(it); addCreated(t, it.files.filter((f) => f.status === 'A').map((f) => `${it.root}/${f.path}`)); continue; }
    if (it.kind === 'tool') {
      addCreated(t, createdFiles(it));
      const cmd = (it.input as { command?: unknown } | null)?.command;
      if (it.name === 'Bash' && typeof cmd === 'string') {
        addMentioned(t, pathsWritten(cmd));
        if (it.done && !it.isError) {
          const hash = GIT_COMMIT.test(cmd) ? it.output?.match(COMMIT_OUT)?.[1] : undefined;
          if (hash && !t.commits.includes(hash.slice(0, 7))) t.commits.push(hash.slice(0, 7));
          if (GIT_PUSH.test(cmd)) t.pushed = true;
        }
      }
    }
    // A plan_step call (Vibrato's checklist tool) counts as the "✓ n." line it stands for.
    const mark = it.kind === 'tool' && isPlanStepTool(it.name) ? planStepMark(it.input) : null;
    if (mark) { t.texts.push(mark); t.textIds.push(it.id); }
    if (it.kind === 'verify') { t.verify.push(it); continue; }
    if ((it.kind === 'approval' && !it.decision) || (it.kind === 'question' && !it.resolved)) t.pending.push(it);
    if (it.kind === 'assistant' && it.text.trim()) { t.texts.push(it.text); t.textIds.push(it.id); addMentioned(t, pathsInText(it.text)); }
    if (!active && justDone && !justDone.note && it.kind === 'assistant' && it.text.trim()) justDone.note = it.text.trim();
    // Without a step in progress: before any step has started it is preparation, afterwards it is wrap-up.
    const started = t.steps.some((x) => x.status !== 'pending');
    file(active ?? (started ? t.after : t.before), it);
  }
  for (const t of turns) applyTextPlan(t);
  return turns;
}

/**
 * A plan written as text is only known once the turn's words are read, so its work was filed as a whole under
 * `before`. Spread it over the steps in order: up to the plan message it is preparation, then each item belongs
 * to the step being worked, which moves on past every "✓ n." line.
 */
function fileTextSteps(t: PlanTurn) {
  const pool = [...t.before.items, ...t.after.items];
  t.before = group('before', '');
  t.after = group('after', '');
  const planAt = pool.findIndex((it) => it.kind === 'assistant' && planIn(it.text) !== null);
  let k = 0;
  pool.forEach((it, i) => {
    if (i <= planAt) { file(t.before, it); return; }
    // A new round's plan starts over from its first step.
    if (it.kind === 'assistant' && planIn(it.text)) k = 0;
    // A message with "✓ n." lines belongs to the first step it closes (later ones may have been skipped over).
    const said = it.kind === 'assistant' ? it.text : it.kind === 'tool' && isPlanStepTool(it.name) ? planStepMark(it.input) : null;
    const done = said ? [...doneMarks([said]).keys()].filter((n) => n <= t.steps.length) : [];
    if (done.length) k = Math.max(k, Math.min(...done) - 1);
    file(k < t.steps.length ? t.steps[k] : t.after, it);
    if (done.length) k = Math.max(...done);
  });
}

/** "✓ n. Not done: why" (or 안 함 / 못 함 / 건너뜀): the step was closed without doing it. */
const NOT_DONE = /^(?:not\s+done|skipped|안\s*함|못\s*함|건너뜀)\s*[:：-]?\s*/i;

function applyTextPlan(t: PlanTurn) {
  const marks = doneMarks(t.texts);
  if (!t.hasPlan) {
    const steps = mergedPlan(t.texts);
    if (steps) {
      t.hasPlan = true;
      t.steps = steps.map((content, i) => ({ ...group(`text:${i}`, content), status: marks.has(i + 1) ? 'completed' as const : 'pending' as const }));
      fileTextSteps(t);
    }
  }
  // "✓ n." lines are the step's account, whichever way the plan came; a step done again in later rounds has several.
  const entries = stepEntries(t.texts);
  t.steps.forEach((step, i) => {
    step.entries = entries.filter((e) => e.step === i + 1).map((e) => {
      const skipped = e.note.match(NOT_DONE);
      return { title: e.title, note: skipped ? e.note.slice(skipped[0].length) : e.note, detail: e.detail, skipped: !!skipped, itemId: t.textIds[e.text] };
    });
    const last = step.entries[step.entries.length - 1];
    if (!last || !marks.has(i + 1)) return;
    step.note = last.note || null;
    step.skipped = last.skipped;
    if (step.key.startsWith('text:')) step.status = 'completed';
  });
  // The steps are worked in order, so a written plan's step that has a later one checked is done too, even when
  // its own "✓" line was skipped. Steps from the task tools carry their own status.
  const lastDone = t.steps.reduce((at, s, i) => (s.key.startsWith('text:') && s.status === 'completed' ? i : at), -1);
  t.steps.forEach((step, i) => { if (i < lastDone && step.key.startsWith('text:')) step.status = 'completed'; });
  const last = t.texts[t.texts.length - 1];
  const result = resultOf(t.texts);
  // Without a plan the reply is the work itself (a report, an answer), so it is shown in full.
  t.answerFull = result ? result.full : !t.hasPlan && !!last?.trim();
  t.answer = result ? result.text : t.answerFull ? last.trim() : noteLine(last ?? null, 240);
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
