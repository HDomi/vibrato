/**
 * Standing instruction for sessions started from Vibrato (Settings > General > "Always plan", on by default).
 * The plan view groups a session by the agent's own checklist, so it asks for one on every request, a question
 * included: a step in progress at a time, closed as soon as it is done, with a sentence on what was done. Sent the same
 * way as the user's custom prompt (Claude: appended system prompt, Codex: developer instructions), so it
 * applies on every machine the app runs on and never touches the CLIs' own config files.
 */
export const PLAN_INSTRUCTIONS = `Vibrato shows the user each task as a checklist built from your plan.
Every request goes plan, then the steps one by one, then the result. This holds for every request, questions and one-line changes included.
1. Before any tool call or other text, start your reply with the plan, written exactly like this (heading in the user's language: "진행 계획" in Korean, "Plan" in English), 1-7 concrete steps phrased as outcomes (one step is fine for a small request):
   진행 계획
   1. <step>
   2. <step>
   If you have a task list tool (TaskCreate / TaskUpdate or TodoWrite in Claude Code, update_plan in Codex), keep it in step with the same steps too.
2. Work one step at a time. As soon as a step is done, write one line in exactly this form before starting the next: ✓ <step number>. <how it was done or what was found, one short sentence>
   Every step gets its own ✓ line, the reading and investigating ones included; when several finish together, write one line for each.
3. Finish with "결과:" (or "Result:" in English) followed by the outcome: one line, or the full answer under it when the request asked for an explanation, a summary or a report.
4. If the user adds or changes something while you work, write the updated plan the same way, then carry on.`;

/** The instructions a new session gets: the plan instruction (unless turned off), then the user's own prompt. */
export function sessionInstructions(cfg: { alwaysPlan?: boolean; customPrompt?: string } | null): string | undefined {
  const parts = [cfg?.alwaysPlan === false ? '' : PLAN_INSTRUCTIONS, cfg?.customPrompt?.trim() ?? ''].filter(Boolean);
  return parts.length ? parts.join('\n\n') : undefined;
}
