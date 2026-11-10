/*
 * The plan as written in the reply (Settings > "Always plan" asks for it, and it is the only plan when an agent
 * has no task-list tool): a "Plan" / "진행 계획" line followed by a numbered list, then "✓ 2. how it was done"
 * as each step finishes, and a "Result:" / "결과:" line at the end.
 */
const PLAN_HEAD = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:진행\s*계획|계획|plan)\s*(?:\*\*|__)?\s*[:：]?\s*(?:\*\*)?\s*$/i;
const PLAN_ITEM = /^\s*(\d{1,2})[.)]\s+(.+?)\s*$/;
// "✓ 2. how", and "✓ 1~3. how" for a run of steps closed in one line.
const DONE_MARK = /^\s*(?:[-*]\s+)?(?:✓|✔|✅|☑|\[x\])\s*(\d{1,2})(?:\s*[~–-]\s*(\d{1,2}))?\s*[.):]?\s*(.*)$/i;
const DONE_AFTER = /^\s*(\d{1,2})[.)]\s*(?:✓|✔|✅)\s*(.*)$/;
// "결과: …", "**결과:** …", or a heading alone ("## 결과", "**Result**") with the outcome on the lines below.
const RESULT_LINE = /^\s*(?:#{1,6}\s*)?(?:[-*]\s+)?(?:\*\*|__)?\s*(?:최종\s*)?(?:결과|results?)\s*(?:\*\*|__)?\s*(?:[:：]\s*(.*)|$)/i;
const plainLine = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
/** One line kept as markdown (links, `code` paths) minus bold markers, which a marker cut in half would leave unbalanced. */
const mdLine = (s: string) => s.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();

/** The Vibrato checklist tool (server/browserMcp.ts PLAN_TOOLS) as Claude and Codex name it. */
export const isPlanStepTool = (name: string) => name === 'mcp__vibrato__plan_step' || name === 'mcp:vibrato/plan_step';

/** A plan_step call written out as the "✓ n." line it stands for, or null when its input is not a step. */
export function planStepMark(input: unknown): string | null {
  const i = (input ?? {}) as { step?: unknown; note?: unknown; skipped?: unknown };
  const step = Number(i.step);
  if (!Number.isInteger(step) || step < 1 || step > 99) return null;
  const note = typeof i.note === 'string' ? i.note.replace(/\s+/g, ' ').trim() : '';
  return `✓ ${step}. ${i.skipped ? `Not done: ${note}` : note}`.trimEnd();
}

/** The last plan in one message: the numbered list under a plan heading (one step is a plan too). */
export function planIn(text: string): string[] | null {
  let found: string[] | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!PLAN_HEAD.test(lines[i])) continue;
    const steps: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const m = lines[j].match(PLAN_ITEM);
      if (m && !DONE_AFTER.test(lines[j])) { steps[Number(m[1]) - 1] = plainLine(m[2]); continue; }
      if (!lines[j].trim() && !steps.length) continue;
      if (!lines[j].trim() || /^\s{2,}\S/.test(lines[j])) continue; // blank lines and indented details inside the list
      break;
    }
    const list = steps.filter(Boolean);
    if (list.length) found = list;
  }
  return found;
}

/** The last plan in these messages. */
export function textPlan(texts: string[]): string[] | null {
  let found: string[] | null = null;
  for (const text of texts) found = planIn(text) ?? found;
  return found;
}

/**
 * Every plan's steps merged by number: a long task often re-plans each round (a background job reporting in,
 * "1. #12 결과 보고"), and the rounds are the same step done again. Each number takes its latest title; there
 * are as many steps as the longest plan had.
 */
export function mergedPlan(texts: string[]): string[] | null {
  const titles: string[] = [];
  let any = false;
  for (const text of texts) {
    const plan = planIn(text);
    if (!plan) continue;
    any = true;
    plan.forEach((title, i) => { titles[i] = title; });
  }
  return any ? titles.map((x) => x ?? '') : null;
}

/** One "✓ n." line: which step, the title it had in the plan of that round, the account, and the round's headline. */
export interface StepEntry {
  step: number;
  title: string;
  note: string;
  /** The first line of the message that is not plan bookkeeping, as a one-line headline of what it reported. */
  detail: string | null;
  /** Index of the message in the texts. */
  text: number;
}

/** The steps one "✓" line closes (several for "✓ 1~3."), and its account. */
function markOf(line: string): { steps: number[]; note: string } | null {
  const m = line.match(DONE_MARK);
  if (m) {
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    const steps = to > from && to - from < 20 ? Array.from({ length: to - from + 1 }, (_, k) => from + k) : [from];
    return { steps, note: plainLine(m[3]) };
  }
  const a = line.match(DONE_AFTER);
  return a ? { steps: [Number(a[1])], note: plainLine(a[2]) } : null;
}

const isBookkeeping = (line: string) => PLAN_HEAD.test(line) || PLAN_ITEM.test(line) || DONE_MARK.test(line) || DONE_AFTER.test(line) || RESULT_LINE.test(line);

/** Every "✓ n." line in order, with the plan title it closed at that time. */
export function stepEntries(texts: string[]): StepEntry[] {
  const out: StepEntry[] = [];
  let plan: string[] = [];
  texts.forEach((text, i) => {
    const lines = text.split('\n');
    const head = lines.find((l) => l.trim() && !isBookkeeping(l));
    const detail = head ? plainLine(head.replace(/^\s*(?:#{1,6}\s+|[-*]\s+|>\s*)/, '')).slice(0, 200) || null : null;
    // Line by line: a "✓" closes a step of the plan written above it, even when the next round's plan follows.
    lines.forEach((line, j) => {
      if (PLAN_HEAD.test(line)) { plan = planIn(lines.slice(j).join('\n')) ?? plan; return; }
      const m = markOf(line);
      for (const step of m?.steps ?? []) out.push({ step, title: plan[step - 1] ?? '', note: m!.note, detail, text: i });
    });
  });
  return out;
}

/** "✓ 2. how" lines: step number (1-based) -> how it was done. */
export function doneMarks(texts: string[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const m = markOf(line);
      for (const step of m?.steps ?? []) out.set(step, m!.note);
    }
  }
  return out;
}

/** The result after one marker line: its own text, and the lines under it up to the end of the message. */
function resultAt(lines: string[], j: number, m: RegExpMatchArray): { text: string; full: boolean } | null {
  const head = (m[1] ?? '').replace(/^(?:\*\*|__)\s*/, '').trim();
  const body = lines.slice(j + 1).join('\n').trim();
  // Anything under the marker is part of the outcome, even a single line: the result is shown as the reply's answer.
  if (body) return { text: head ? `${head}\n\n${body}` : body, full: true };
  return plainLine(head) ? { text: mdLine(head), full: false } : null;
}

/** The last "Result:" marker of these messages, with the index of the message it is in. */
function lastResult(texts: string[], before = texts.length): { text: string; full: boolean; at: number } | null {
  for (let i = before - 1; i >= 0; i--) {
    const lines = texts[i].split('\n');
    for (let j = lines.length - 1; j >= 0; j--) {
      const m = lines[j].match(RESULT_LINE);
      if (!m) continue;
      const r = resultAt(lines, j, m);
      if (r) return { ...r, at: i };
    }
  }
  return null;
}

/**
 * What follows the last "Result:" marker: its line, or with more lines under it, all of it (markdown). A one-line
 * result written after a full one in the same turn (a reply sent back to add a missing ✓ line often restates it
 * in a line) keeps the full one under it, so the outcome is not cut down to its headline.
 */
export function resultOf(texts: string[]): { text: string; full: boolean } | null {
  const last = lastResult(texts);
  if (!last || last.full) return last && { text: last.text, full: last.full };
  for (let before = last.at; before > 0;) {
    const earlier = lastResult(texts, before);
    if (!earlier) break;
    if (earlier.full) {
      const same = plainLine(earlier.text.split('\n')[0]) === plainLine(last.text);
      return { text: same ? earlier.text : `${last.text}\n\n${earlier.text}`, full: true };
    }
    before = earlier.at;
  }
  return { text: last.text, full: false };
}
