import { pendingRequests, type ChatSession } from './chatStore';
import type { LockSessionSummary } from './vibe';

/** Per-agent counts shown on the lock screen (no titles, no paths). Closed sessions are left out. */
export function lockSummary(sessions: Iterable<Pick<ChatSession, 'agent' | 'status' | 'items'>>): LockSessionSummary[] {
  const by = new Map<string, LockSessionSummary>();
  for (const s of sessions) {
    if (s.status === 'closed') continue;
    const row = by.get(s.agent) ?? { agent: s.agent, total: 0, running: 0, waiting: 0 };
    row.total++;
    if (s.status === 'running' || s.status === 'compacting') row.running++;
    if (pendingRequests(s as ChatSession) > 0) row.waiting++;
    by.set(s.agent, row);
  }
  return [...by.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}

/*
 * Seven-segment clock face (LCD style). Segments a–g in the usual order: a top, b upper right, c lower right,
 * d bottom, e lower left, f upper left, g middle. Unlit segments are drawn faintly, like a real display.
 */
export const DIGIT_SEGMENTS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg',
  '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};
export const SEG = { w: 56, h: 100, t: 10, gap: 1.6, colonW: 20, space: 12 };

/** Polygon points for each segment of one digit cell at x offset `ox`. Segment ends are pointed so neighbours meet in a mitre. */
export function segmentPolygons(ox: number): Record<string, string> {
  const { w, h, t, gap } = SEG;
  const half = t / 2;
  const L = ox + half; const R = ox + w - half;
  const T = half; const M = h / 2; const B = h - half;
  const hor = (y: number) => [[L + gap, y], [L + gap + half, y - half], [R - gap - half, y - half], [R - gap, y], [R - gap - half, y + half], [L + gap + half, y + half]];
  const ver = (x: number, y1: number, y2: number) => [[x, y1 + gap], [x + half, y1 + gap + half], [x + half, y2 - gap - half], [x, y2 - gap], [x - half, y2 - gap - half], [x - half, y1 + gap + half]];
  const pts = (p: number[][]) => p.map(([x, y]) => `${+x.toFixed(2)},${+y.toFixed(2)}`).join(' ');
  return { a: pts(hor(T)), b: pts(ver(R, T, M)), c: pts(ver(R, M, B)), d: pts(hor(B)), e: pts(ver(L, M, B)), f: pts(ver(L, T, M)), g: pts(hor(M)) };
}

/** x offset of every character of e.g. "16:07:30" and the total width, in segment units. */
export function segmentLayout(text: string): { offsets: number[]; width: number } {
  const offsets: number[] = [];
  let x = 0;
  for (const ch of text) { offsets.push(x); x += (ch === ':' ? SEG.colonW : SEG.w) + SEG.space; }
  return { offsets, width: Math.max(0, x - SEG.space) };
}
