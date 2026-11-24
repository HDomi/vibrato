/*
 * How a revised plan relates to the one before it. With plan_set the step ids say it exactly; a plan written only as
 * text has no ids, so its steps are matched by role tag and title (and marked as a guess in the view).
 */
import { isRole, type PlanSetStep, type Role } from './planSet.js';

export type PlanChange =
  | { kind: 'added'; id: string; title: string; role?: Role }
  | { kind: 'removed'; id: string; title: string; role?: Role }
  | { kind: 'renamed'; id: string; from: string; to: string }
  | { kind: 'role'; id: string; title: string; from?: Role; to?: Role };

/** Changes from `prev` to `next`, matched by id. A different order alone is not a change. */
export function diffPlans(prev: PlanSetStep[], next: PlanSetStep[]): PlanChange[] {
  const before = new Map(prev.map((s) => [s.id, s]));
  const after = new Set(next.map((s) => s.id));
  const out: PlanChange[] = [];
  for (const s of next) {
    const p = before.get(s.id);
    if (!p) { out.push({ kind: 'added', id: s.id, title: s.title, ...(s.role ? { role: s.role } : {}) }); continue; }
    if (p.title !== s.title) out.push({ kind: 'renamed', id: s.id, from: p.title, to: s.title });
    if (p.role !== s.role) out.push({ kind: 'role', id: s.id, title: s.title, ...(p.role ? { from: p.role } : {}), ...(s.role ? { to: s.role } : {}) });
  }
  for (const p of prev) if (!after.has(p.id)) out.push({ kind: 'removed', id: p.id, title: p.title, ...(p.role ? { role: p.role } : {}) });
  return out;
}

const ROLE_TAG = /^\s*\[([A-Ea-e])\]\s*/;

/** "[C] 시안 확인" → role C and the title without the tag. */
export function roleTag(title: string): { role: Role | null; title: string } {
  const m = title.match(ROLE_TAG);
  const role = m ? m[1].toUpperCase() : null;
  return { role: isRole(role) ? role : null, title: m ? title.slice(m[0].length).trim() : title.trim() };
}

// Korean particles at the end of a word, so "버그를" and "버그" count as the same word.
const PARTICLE = /(?:은|는|이|가|을|를|의|에|에서|으로|로|와|과|도|만)$/;
function words(title: string): string[] {
  return roleTag(title).title.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter(Boolean).map((w) => (w.length > 2 ? w.replace(PARTICLE, '') : w));
}
const normal = (title: string) => words(title).join(' ');

/** Word overlap of two step titles, 0-1. */
export function similarity(a: string, b: string): number {
  const x = new Set(words(a));
  const y = new Set(words(b));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

export const SAME_STEP = 0.6;

/**
 * Matches the steps of a rewritten text plan to the previous one: same role tag and title first, then the most
 * similar pairs (one to one, at least SAME_STEP). `match[i]` is the previous index of new step i, or null (added).
 */
export function matchTextPlans(prev: string[], next: string[]): { match: (number | null)[]; removed: number[] } {
  const match: (number | null)[] = next.map(() => null);
  const taken = new Set<number>();
  const key = (t: string) => `${roleTag(t).role ?? ''}|${normal(t)}`;
  next.forEach((t, i) => {
    const j = prev.findIndex((p, k) => !taken.has(k) && key(p) === key(t));
    if (j >= 0) { match[i] = j; taken.add(j); }
  });
  const pairs: [number, number, number][] = [];
  next.forEach((t, i) => {
    if (match[i] !== null) return;
    prev.forEach((p, j) => { if (!taken.has(j)) { const s = similarity(p, t); if (s >= SAME_STEP) pairs.push([s, i, j]); } });
  });
  pairs.sort((a, b) => b[0] - a[0]);
  for (const [, i, j] of pairs) if (match[i] === null && !taken.has(j)) { match[i] = j; taken.add(j); }
  return { match, removed: prev.map((_, j) => j).filter((j) => !taken.has(j)) };
}
