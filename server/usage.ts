import { fetchClaudeUsage } from './claudeUsage.js';
import { readCodexRateLimits } from './agents/codex.js';
import { which } from './shell.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface UsageWindow { usedPct: number; resetsAt: number | null }
export interface ClaudeUsage { fiveHour: UsageWindow | null; weekly: UsageWindow | null; model: (UsageWindow & { name: string }) | null; plan: string | null }
export interface CodexUsage { fiveHour: UsageWindow | null; weekly: UsageWindow | null; plan: string | null }
export interface UsageSnapshot { fetchedAt: number; claude: ClaudeUsage | null; codex: CodexUsage | null; errors: string[] }

let cache: UsageSnapshot | null = null;
let inflight: Promise<UsageSnapshot> | null = null;

type Json = Record<string, unknown>;

/** Map one app-server rate-limit window (`usedPercent`, `resetsAt` in unix seconds). */
function codexWindow(o: unknown): UsageWindow | null {
  if (!o || typeof o !== 'object') return null;
  const w = o as Json;
  const pct = Number(w.usedPercent);
  if (w.usedPercent == null || !Number.isFinite(pct)) return null;
  const r = Number(w.resetsAt);
  return { usedPct: Math.round(pct), resetsAt: w.resetsAt != null && Number.isFinite(r) ? (r > 1e12 ? Math.floor(r / 1000) : Math.floor(r)) : null };
}

/** Normalize an `account/rateLimits/read` response. The top-level `rateLimits` is the main `codex` bucket. */
export function normalizeCodexRateLimits(res: unknown): CodexUsage | null {
  const d = (res ?? {}) as Json;
  const byId = (d.rateLimitsByLimitId ?? null) as Record<string, Json | undefined> | null;
  const snap = (d.rateLimits ?? byId?.codex) as Json | undefined;
  if (!snap || typeof snap !== 'object') return null;
  // Windows are matched by duration when the backend reports it; otherwise primary = 5h, secondary = weekly.
  const wins = [snap.primary, snap.secondary].filter((w): w is Json => !!w && typeof w === 'object');
  const byMins = (mins: number) => wins.find((w) => Number(w.windowDurationMins) === mins);
  const fiveHour = codexWindow(byMins(300) ?? snap.primary);
  const weekly = codexWindow(byMins(10080) ?? snap.secondary);
  if (!fiveHour && !weekly) return null;
  return { fiveHour, weekly, plan: typeof snap.planType === 'string' ? snap.planType : null };
}

/** Ask the installed codex CLI (app-server) for the account limits; Vibrato never reads Codex credentials itself. */
async function fetchCodex(): Promise<CodexUsage | null> {
  const codexPath = await which('codex');
  if (!codexPath) return null;
  return normalizeCodexRateLimits(await readCodexRateLimits(codexPath));
}

export function getUsage(force = false): Promise<UsageSnapshot> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = (async () => {
    const errors: string[] = [];
    const [claude, codex] = await Promise.all([
      fetchClaudeUsage().catch((e) => { errors.push(`claude: ${e.message}`); return cache?.claude ?? null; }),
      fetchCodex().catch((e) => { errors.push(`codex: ${e.message}`); return cache?.codex ?? null; }),
    ]);
    cache = { fetchedAt: Date.now(), claude, codex, errors };
    return cache;
  })().finally(() => { inflight = null; });
  return inflight;
}
