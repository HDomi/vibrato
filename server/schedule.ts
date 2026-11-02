import path from 'node:path';
import type { AgentId, PermissionModeId } from './agents/types.js';
// The parser is shared with the Tools > Cron page; it has no imports, so the server can compile it too.
import { nextRuns, parseCron } from '../web/src/lib/toolbox/cron.js';

/**
 * Scheduled agent runs: a skill and/or prompt sent to a fresh session in a project on a cron schedule.
 * Pure parts only (validation, due times); the runtime is server/scheduler.ts.
 */

/** none: run when the app gets the chance; awake: keep an awake Mac from idle-sleeping before a run; wake: also wake a sleeping Mac. */
export type PowerMode = 'none' | 'awake' | 'wake';
export type RunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'missed' | 'skipped';

export interface Schedule {
  id: string;
  name: string;
  cwd: string;
  agent: AgentId;
  /** Skill invoked as "/skill"; empty for a plain prompt. */
  skill: string;
  /** Arguments after the skill, or the whole prompt without one. */
  prompt: string;
  cron: string;
  /** CLI session (Claude session id / Codex thread id) the prompt continues; empty for a fresh session each run. */
  resumeSessionId?: string;
  /** Title of that session when it was picked, for display. */
  resumeTitle?: string;
  permissionMode: PermissionModeId;
  model?: string;
  enabled: boolean;
  /** A run found late (the Mac slept, the app was closed) still starts within this many minutes of its time. */
  graceMinutes: number;
  power: PowerMode;
  createdAt: number;
  /** Occurrences at or before this time have been handled (run, missed or skipped). */
  cursor: number;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  name: string;
  cwd: string;
  agent: AgentId;
  trigger: 'schedule' | 'manual';
  scheduledFor: number;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  /** Server session id while it is live. */
  sessionId?: string;
  /** CLI session id, for resuming the conversation after the live session is gone. */
  agentSessionId?: string;
  error?: string;
  costUsd?: number;
}

export const GRACE_DEFAULT = 720;
export const GRACE_MAX = 7 * 24 * 60;
/** Slack for the scheduler tick, so a zero grace still runs a job the next tick finds. */
export const TICK_TOLERANCE_MS = 2 * 60 * 1000;
const MODES: PermissionModeId[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'];
const POWER: PowerMode[] = ['none', 'awake', 'wake'];

export class ScheduleError extends Error {}

/** First occurrence strictly after `after` (minute resolution), or null when the expression never fires. */
export function nextOccurrence(cron: string, after: number): number | null {
  return nextRuns(parseCron(cron), 1, after)[0]?.getTime() ?? null;
}

/** Latest occurrence in (after, now]; null when there is none. */
export function latestOccurrence(cron: string, after: number, now: number): number | null {
  const s = parseCron(cron);
  let last: number | null = null;
  for (let t = after, i = 0; i < 100000; i++) {
    const n = nextRuns(s, 1, t)[0]?.getTime();
    if (n === undefined || n > now) break;
    last = t = n;
  }
  return last;
}

/**
 * What the scheduler should do for a schedule now: run its latest occurrence that is still within the
 * grace window, or record that occurrences passed unrun. Several missed occurrences collapse into one.
 */
export function dueAction(s: Pick<Schedule, 'cron' | 'cursor' | 'graceMinutes'>, now: number): { kind: 'run' | 'missed'; at: number } | null {
  const windowStart = Math.max(s.cursor, now - s.graceMinutes * 60000 - TICK_TOLERANCE_MS);
  const within = latestOccurrence(s.cron, windowStart, now);
  if (within !== null) return { kind: 'run', at: within };
  const first = nextOccurrence(s.cron, s.cursor);
  return first !== null && first <= now ? { kind: 'missed', at: first } : null;
}

/** The message the session receives. */
export function promptText(s: Pick<Schedule, 'skill' | 'prompt'>): string {
  const rest = s.prompt.trim();
  return s.skill ? `/${s.skill}${rest ? ` ${rest}` : ''}` : rest;
}

/** Earliest next occurrence after `after` among enabled schedules whose power mode is in `modes`. */
export function earliestNext(schedules: Schedule[], after: number, modes: PowerMode[]): number | null {
  let best: number | null = null;
  for (const s of schedules) {
    if (!s.enabled || !modes.includes(s.power)) continue;
    const n = (() => { try { return nextOccurrence(s.cron, after); } catch { return null; } })();
    if (n !== null && (best === null || n < best)) best = n;
  }
  return best;
}

/**
 * Validate a create/update body into a schedule. `prev` is the stored schedule on update; changing when or
 * whether it runs moves the cursor to now, so an edit never fires occurrences that already passed.
 */
export function cleanSchedule(body: unknown, prev: Schedule | null, now: number, id: string): Schedule {
  if (!body || typeof body !== 'object') throw new ScheduleError('Expected a schedule');
  const b = { ...prev, ...(body as Record<string, unknown>) } as Record<string, unknown>;
  const str = (k: string, max: number) => (typeof b[k] === 'string' ? (b[k] as string) : '').slice(0, max);
  const cwd = str('cwd', 4096).trim();
  if (!path.isAbsolute(cwd)) throw new ScheduleError('Pick a project folder');
  const agent = b.agent === 'codex' ? 'codex' : b.agent === 'claude' ? 'claude' : null;
  if (!agent) throw new ScheduleError('Unknown agent');
  const skill = str('skill', 200).trim().replace(/^\//, '');
  if (skill && !/^[\w.:-]+$/.test(skill)) throw new ScheduleError(`Invalid skill name "${skill}"`);
  const prompt = str('prompt', 20000);
  if (!skill && !prompt.trim()) throw new ScheduleError('Pick a skill or write a prompt');
  const cron = str('cron', 200).trim();
  try { parseCron(cron); } catch (e) { throw new ScheduleError((e as Error).message); }
  const resumeSessionId = str('resumeSessionId', 200).trim() || undefined;
  if (resumeSessionId && !/^[\w.-]+$/.test(resumeSessionId)) throw new ScheduleError('Invalid session id');
  const resumeTitle = resumeSessionId ? str('resumeTitle', 200).trim() || undefined : undefined;
  let permissionMode = MODES.includes(b.permissionMode as PermissionModeId) ? b.permissionMode as PermissionModeId : 'acceptEdits';
  // Auto mode is Claude's classifier; Codex has no equivalent.
  if (agent === 'codex' && permissionMode === 'auto') permissionMode = 'default';
  const grace = Number(b.graceMinutes ?? GRACE_DEFAULT);
  const graceMinutes = Number.isFinite(grace) ? Math.min(GRACE_MAX, Math.max(0, Math.round(grace))) : GRACE_DEFAULT;
  const power = POWER.includes(b.power as PowerMode) ? b.power as PowerMode : 'awake';
  const enabled = b.enabled !== false;
  const model = str('model', 200).trim() || undefined;
  const name = str('name', 80).trim() || (skill ? `/${skill}` : prompt.trim().split('\n')[0].slice(0, 40));
  const rescheduled = !prev || prev.cron !== cron || (!prev.enabled && enabled);
  return {
    id, name, cwd, agent, skill, prompt, cron, resumeSessionId, resumeTitle, permissionMode, model, enabled, graceMinutes, power,
    createdAt: prev?.createdAt ?? now,
    cursor: rescheduled ? now : prev.cursor,
  };
}
