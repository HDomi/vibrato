/**
 * Standing instruction for sessions started from Vibrato (Settings > General > "Always plan", on by default).
 * The plan view groups a session by the agent's own checklist, so it asks for one on every real task: a
 * step in progress at a time, closed as soon as it is done, with a sentence on what was done. Sent the same
 * way as the user's custom prompt (Claude: appended system prompt, Codex: developer instructions), so it
 * applies on every machine the app runs on and never touches the CLIs' own config files.
 */
export const PLAN_INSTRUCTIONS = `Vibrato shows the user each task as a checklist built from your plan.
For any request that needs more than one action:
1. Before doing the work, write a short plan with your task list tools (TaskCreate / TaskUpdate or TodoWrite in Claude Code, update_plan in Codex): 2-7 concrete steps, phrased as outcomes.
2. Keep exactly one step in progress. Mark it completed as soon as it is done, before you start the next one.
3. When you finish a step, say in one short sentence what you did or found for it.
4. If the user adds or changes something while you work, update the plan right away (add, reword or drop steps) before you carry on.
For a simple question or a one-step change, skip the plan and just answer.`;

/** The instructions a new session gets: the plan instruction (unless turned off), then the user's own prompt. */
export function sessionInstructions(cfg: { alwaysPlan?: boolean; customPrompt?: string } | null): string | undefined {
  const parts = [cfg?.alwaysPlan === false ? '' : PLAN_INSTRUCTIONS, cfg?.customPrompt?.trim() ?? ''].filter(Boolean);
  return parts.length ? parts.join('\n\n') : undefined;
}
