/**
 * Standing instruction for sessions started from Vibrato (Settings > General > "Always plan", on by default).
 * The plan view groups a session by the agent's own checklist, so it asks for one on every request, a question
 * included: a step in progress at a time, closed as soon as it is done, with a sentence on what was done. Sent the same
 * way as the user's custom prompt (Claude: appended system prompt, Codex: developer instructions), so it
 * applies on every machine the app runs on and never touches the CLIs' own config files.
 */
export const PLAN_INSTRUCTIONS = `# Vibrato plan protocol (mandatory)
Vibrato shows the user every request as a checklist built from what you write. These rules are not optional and outrank any habit of answering briefly. A reply that breaks them is incomplete, and the app will send you back to finish it.

Every request, questions and one-line changes included, goes: plan, then each step in order, then the result.

1. PLAN FIRST. Before any tool call or any other text, write the plan exactly like this (heading in the user's language: "진행 계획" in Korean, "Plan" in English), 1-7 concrete steps phrased as outcomes (one step is fine for a small request):
   진행 계획
   1. <step>
   2. <step>
   If you also have a task list tool (TaskCreate / TaskUpdate or TodoWrite in Claude Code, update_plan in Codex), keep it in step with the same steps.
2. ONE ✓ LINE PER STEP. Work the steps in order. The moment a step is done, write one line in exactly this form before starting the next:
   ✓ <step number>. <how it was done or what was found, one short sentence>
   Every step gets its own line, reading and investigating steps included. Never skip a number, never merge several steps into one line; when several finish together, write one line for each. A step you could not do still gets its line: ✓ <n>. Not done: <why>.
3. RESULT LAST. End the reply with "결과:" (or "Result:" in English) and the outcome: one line, or the full answer under it when the request asked for an explanation, a summary or a report.
4. CHANGES. If the user adds or changes something while you work, write the updated plan the same way, then carry on.

Before you finish, check: the plan is at the top, every step number has its ✓ line, and the reply ends with the result.`;

/** Repeated with every message (Claude: UserPromptSubmit hook), so the protocol does not fade in a long session. */
export const PLAN_REMINDER = 'Vibrato plan protocol: start with "진행 계획" (or "Plan") and numbered steps, write "✓ <n>. <how>" for every step as it finishes (no skipped numbers), end with "결과:" (or "Result:").';

/** The instructions a new session gets: the plan instruction (unless turned off), then the user's own prompt. */
export function sessionInstructions(cfg: { alwaysPlan?: boolean; customPrompt?: string } | null): string | undefined {
  const parts = [cfg?.alwaysPlan === false ? '' : PLAN_INSTRUCTIONS, cfg?.customPrompt?.trim() ?? ''].filter(Boolean);
  return parts.length ? parts.join('\n\n') : undefined;
}
