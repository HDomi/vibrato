import { doneMarks, resultOf, textPlan } from '../web/src/lib/textPlan.js';

/**
 * What a finished reply is missing from the plan protocol (see planInstructions.ts), as feedback for the agent,
 * or null when it is complete. `texts` are the agent's own messages of the turn, in order.
 */
export function planGap(texts: string[]): string | null {
  const steps = textPlan(texts);
  const marks = doneMarks(texts);
  const result = resultOf(texts);
  if (!steps) {
    return 'Your reply has no plan. Following the Vibrato plan protocol, now write "진행 계획" (or "Plan") with the steps you actually took as a numbered list, a "✓ <n>. <how>" line for each, and end with "결과:" (or "Result:") followed by the complete outcome. Do not redo the work.';
  }
  const missing = steps.map((_, i) => i + 1).filter((n) => !marks.has(n));
  if (!missing.length && result) return null;
  const parts: string[] = [];
  if (missing.length) parts.push(`step${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ha${missing.length > 1 ? 've' : 's'} no "✓ <n>. <how>" line`);
  if (!result) parts.push('there is no "결과:" (or "Result:") line');
  const todo = [
    missing.length ? `the missing ✓ line${missing.length > 1 ? 's' : ''} (one per step, "✓ <n>. Not done: <why>" for a step you did not do)` : '',
    // The result shown to the user is only what follows the marker: a pointer back to earlier text shows nothing.
    !result ? 'then "결과:" (or "Result:") with the complete outcome, everything the user needs from every step, not a pointer to what you wrote above' : '',
  ].filter(Boolean).join(', ');
  return `Your reply is incomplete under the Vibrato plan protocol: ${parts.join(' and ')}. Write ${todo} now.${result ? ' Keep your result as it is.' : ''} Do not redo the work.`;
}

/** Tool calls without a new ✓ line before the agent is reminded to close the step it is on, and between reminders. */
export const NUDGE_FIRST = 6;
export const NUDGE_EVERY = 10;
/** Tool calls before a reply that has not written its plan yet is reminded to. */
export const NUDGE_NO_PLAN = 2;

/**
 * Tracks one turn's progress through the plan as tools run, so a step that is over gets its ✓ line then and not
 * in a batch at the end (the plan view only moves on a ✓ line; without it the checklist sits on step 1 until the
 * reply ends). `tool()` is called after each main-thread tool call with the agent's messages so far.
 */
export class PlanProgress {
  private calls = 0;
  private marks = -1;
  private nudges = 0;

  reset() { this.calls = 0; this.marks = -1; this.nudges = 0; }

  /** A reminder for the agent, or null. */
  tool(texts: string[]): string | null {
    const steps = textPlan(texts);
    const marks = doneMarks(texts);
    if (marks.size !== this.marks) { this.marks = marks.size; this.calls = 0; }
    this.calls++;
    if (!steps) {
      if (this.calls !== NUDGE_NO_PLAN || this.nudges) return null;
      this.nudges++;
      return 'Vibrato plan check: you have not written your plan yet. Before the next tool call, write "진행 계획" (or "Plan") and the numbered steps, so the user can follow along.';
    }
    const last = Math.max(0, ...marks.keys());
    const current = last + 1;
    if (current > steps.length) return null;
    const due = this.calls === NUDGE_FIRST || (this.calls > NUDGE_FIRST && (this.calls - NUDGE_FIRST) % NUDGE_EVERY === 0);
    if (!due) return null;
    this.nudges++;
    return `Vibrato plan check: ${this.calls} tool calls since your last ✓ line, so the user's checklist still shows step ${current} ("${steps[current - 1]}") in progress. If step ${current} (or any later step) is already done, write its "✓ ${current}. <how>" line now, before the next tool call, one line per finished step. If it is still in progress, carry on.`;
  }
}
