/*
 * The structured plan (Vibrato MCP tool plan_set, server/browserMcp.ts): every step has an id that stays the same
 * across revisions and, optionally, a role, so a changed plan is matched step by step instead of by position.
 * Shared by the server (validation, plan checks) and the plan view.
 */

/** A: lead (reading, asking, wrapping up), B: spec check, C: design check, D: code, E: verification. Display only. */
export type Role = 'A' | 'B' | 'C' | 'D' | 'E';
export const ROLES: readonly Role[] = ['A', 'B', 'C', 'D', 'E'];
export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

export interface PlanSetStep { id: string; role?: Role; title: string }
export interface PlanSetInput { steps: PlanSetStep[]; reason?: string }

export const MAX_PLAN_STEPS = 12;
const STEP_ID = /^s\d{1,3}$/;

export const isPlanSetTool = (name: string) => name === 'mcp__vibrato__plan_set' || name === 'mcp:vibrato/plan_set';

/** The steps of a plan_set call as sent, or null when the input is not a plan at all. Shape only; rules are validatePlanSet. */
export function planSetInput(input: unknown): PlanSetInput | null {
  const i = (input ?? {}) as { steps?: unknown; reason?: unknown };
  if (!Array.isArray(i.steps)) return null;
  const steps: PlanSetStep[] = [];
  for (const s of i.steps) {
    const o = (s ?? {}) as { id?: unknown; role?: unknown; title?: unknown };
    if (typeof o.id !== 'string' || typeof o.title !== 'string') return null;
    steps.push({ id: o.id.trim(), title: o.title.replace(/\s+/g, ' ').trim(), ...(isRole(o.role) ? { role: o.role } : {}) });
  }
  return { steps, ...(typeof i.reason === 'string' && i.reason.trim() ? { reason: i.reason.trim() } : {}) };
}

/** The plan as the "진행 계획" text it stands for, so the text-based checks (planGuard.ts) read it the same way. */
export function planSetText(steps: PlanSetStep[]): string {
  return ['진행 계획', ...steps.map((s, i) => `${i + 1}. ${s.title}`)].join('\n');
}

/**
 * What the server remembers of one turn's plan to hold later calls to the rules: ids ever used (a removed id is
 * not reused), the steps that are done (they cannot be dropped), and how many plans came (a revision needs a reason).
 */
export interface PlanLedger { steps: PlanSetStep[]; used: string[]; done: string[]; calls: number }
export const emptyLedger = (): PlanLedger => ({ steps: [], used: [], done: [], calls: 0 });

export type Checked<T> = { ok: true; ledger: PlanLedger; value: T } | { ok: false; error: string };

/**
 * plan_set against the turn so far. A step without a role is fine: a question has none, and the view reads the role
 * off the work (refusing it cost a round trip on every plain question in the 2026-11-24 experiment).
 */
export function validatePlanSet(ledger: PlanLedger, input: unknown): Checked<PlanSetInput> {
  const plan = planSetInput(input);
  if (!plan) return { ok: false, error: 'steps must be a list of { id, title, role? }.' };
  const { steps } = plan;
  if (steps.length < 1 || steps.length > MAX_PLAN_STEPS) return { ok: false, error: `A plan has 1-${MAX_PLAN_STEPS} steps; this one has ${steps.length}.` };
  const seen = new Set<string>();
  for (const s of steps) {
    if (!STEP_ID.test(s.id)) return { ok: false, error: `Step id "${s.id}" is not valid: use s1, s2, ...` };
    if (seen.has(s.id)) return { ok: false, error: `duplicate id ${s.id}: every step needs its own id.` };
    seen.add(s.id);
    if (!s.title) return { ok: false, error: `Step ${s.id} has no title.` };
  }
  const raw = ((input ?? {}) as { steps: { role?: unknown }[] }).steps;
  const bad = raw.find((s) => s.role !== undefined && s.role !== null && !isRole(s.role));
  if (bad) return { ok: false, error: `Role "${String(bad.role)}" is not one of ${ROLES.join(', ')} (A lead, B spec, C design, D code, E verify).` };
  if (ledger.calls > 0) {
    if (!plan.reason) return { ok: false, error: 'reason required: say in one sentence why the plan changes.' };
    const dropped = ledger.done.find((id) => !seen.has(id));
    if (dropped) return { ok: false, error: `${dropped} is done; keep it in the plan.` };
    const current = new Set(ledger.steps.map((s) => s.id));
    const reused = steps.find((s) => !current.has(s.id) && ledger.used.includes(s.id));
    if (reused) return { ok: false, error: `${reused.id} was removed earlier; give the new step a new id.` };
  }
  const used = [...new Set([...ledger.used, ...steps.map((s) => s.id)])];
  return { ok: true, value: plan, ledger: { steps, used, done: ledger.done, calls: ledger.calls + 1 } };
}

/** plan_step against the turn's plan: `id` must be in it; a bare step number counts in the current order. Returns the step number. */
export function validatePlanStep(ledger: PlanLedger, input: unknown): Checked<number> {
  const i = (input ?? {}) as { step?: unknown; id?: unknown };
  if (typeof i.id === 'string' && i.id) {
    const at = ledger.steps.findIndex((s) => s.id === i.id);
    if (at < 0) return { ok: false, error: `No step ${i.id} in the current plan${ledger.steps.length ? ` (${ledger.steps.map((s) => s.id).join(', ')})` : '; call plan_set first'}.` };
    return { ok: true, value: at + 1, ledger: { ...ledger, done: ledger.done.includes(i.id) ? ledger.done : [...ledger.done, i.id] } };
  }
  const step = Number(i.step);
  if (!Number.isInteger(step) || step < 1) return { ok: false, error: 'step must be the step number in your plan, from 1 (or give id).' };
  const id = ledger.steps[step - 1]?.id;
  return { ok: true, value: step, ledger: id && !ledger.done.includes(id) ? { ...ledger, done: [...ledger.done, id] } : ledger };
}

/** A plan_step call that names its step by id, given the step number it has in the plan (for the "✓ n." checks). */
export function withStepNumber(input: unknown, plan: PlanSetStep[]): unknown {
  const i = (input ?? {}) as { id?: unknown; step?: unknown };
  if (typeof i.id !== 'string' || i.step !== undefined) return input;
  const at = plan.findIndex((s) => s.id === i.id);
  return at < 0 ? input : { ...i, step: at + 1 };
}
