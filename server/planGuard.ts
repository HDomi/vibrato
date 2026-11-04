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
    return 'Your reply has no plan. Following the Vibrato plan protocol, now write "진행 계획" (or "Plan") with the steps you actually took as a numbered list, a "✓ <n>. <how>" line for each, and end with "결과:" (or "Result:"). Do not redo the work.';
  }
  const missing = steps.map((_, i) => i + 1).filter((n) => !marks.has(n));
  if (!missing.length && result) return null;
  const parts: string[] = [];
  if (missing.length) parts.push(`step${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ha${missing.length > 1 ? 've' : 's'} no "✓ <n>. <how>" line`);
  if (!result) parts.push('there is no "결과:" (or "Result:") line');
  return `Your reply is incomplete under the Vibrato plan protocol: ${parts.join(' and ')}. Write ${missing.length ? `the missing ✓ line${missing.length > 1 ? 's' : ''} (one per step, "✓ <n>. Not done: <why>" for a step you did not do)` : ''}${missing.length && !result ? ', then ' : ''}${!result ? 'the result line' : ''} now. Do not redo the work.`;
}
