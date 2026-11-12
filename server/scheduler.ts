import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR, loadConfig, PORT, saveConfig, withConfigLock } from './config.js';
import type { SessionRegistry } from './sessions.js';
import { cleanSchedule, dueAction, earliestNext, nextOccurrence, promptText, ScheduleError, type Schedule, type ScheduleRun } from './schedule.js';
import { SchedulePower, type PowerStatus } from './schedulePower.js';

const TICK_MS = 30 * 1000;
/** Keep an awake Mac from idle-sleeping this long before a run. */
const AWAKE_LEAD_MS = 30 * 60 * 1000;
/** Wake a sleeping Mac this long before a run, so the network is back when it starts. */
const WAKE_LEAD_MS = 2 * 60 * 1000;
/** A finished run's session stays open this long (or while a window shows it), then its CLI process is freed. */
const CLOSE_AFTER_MS = 30 * 1000;
const NETWORK_WAIT_MS = 60 * 1000;
const RUNS_KEPT = 300;
const RUNS_FILE = path.join(CONFIG_DIR, 'schedule-runs.json');
const API_HOST = { claude: 'api.anthropic.com', codex: 'chatgpt.com' } as const;

export interface ScheduleSnapshot { schedules: (Schedule & { next: number | null })[]; runs: ScheduleRun[]; power: PowerStatus }

/**
 * Runs schedules from the server, so they fire whether or not a window is open. Each run is a fresh
 * headless session; a window can attach to it while it runs or resume it afterwards.
 * Timers stop while the Mac sleeps; on wake the next tick finds what came due and runs it if it is still
 * within the schedule's grace window (see dueAction).
 */
export class Scheduler {
  private runs: ScheduleRun[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  /** scheduleId -> runId of its live run; a schedule never runs twice at once. */
  private active = new Map<string, string>();
  private saving: Promise<void> = Promise.resolve();
  readonly power: SchedulePower;

  constructor(private registry: SessionRegistry, opts: { power?: SchedulePower } = {}) {
    this.power = opts.power ?? new SchedulePower(String(PORT));
  }

  async start() {
    try {
      const parsed = JSON.parse(await fs.readFile(RUNS_FILE, 'utf8'));
      if (Array.isArray(parsed)) this.runs = parsed;
    } catch { /* first start or unreadable: start a new history */ }
    // Runs that were live when the server stopped can never report back.
    for (const r of this.runs) if (r.status === 'running' || r.status === 'waiting') Object.assign(r, { status: 'failed', endedAt: r.endedAt ?? Date.now(), error: 'Interrupted: the app quit or restarted during the run' });
    this.persist();
    await this.power.helperInstalled().catch(() => false);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    await this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.power.stop();
  }

  async snapshot(): Promise<ScheduleSnapshot> {
    const now = Date.now();
    const schedules = (await loadConfig()).schedules.map((s) => ({ ...s, next: s.enabled ? safeNext(s.cron, now) : null }));
    return { schedules, runs: [...this.runs].reverse(), power: this.power.status() };
  }

  async create(body: unknown) {
    await withConfigLock(async () => {
      const cfg = await loadConfig();
      const s = cleanSchedule(body, null, Date.now(), randomUUID());
      await assertDir(s.cwd);
      cfg.schedules.push(s);
      await saveConfig(cfg);
    });
    await this.tick();
  }

  async update(id: string, body: unknown) {
    await withConfigLock(async () => {
      const cfg = await loadConfig();
      const i = cfg.schedules.findIndex((s) => s.id === id);
      if (i < 0) throw new ScheduleError('Unknown schedule');
      const s = cleanSchedule(body, cfg.schedules[i], Date.now(), id);
      if (s.cwd !== cfg.schedules[i].cwd) await assertDir(s.cwd);
      cfg.schedules[i] = s;
      await saveConfig(cfg);
    });
    await this.tick();
  }

  async remove(id: string) {
    await withConfigLock(async () => {
      const cfg = await loadConfig();
      cfg.schedules = cfg.schedules.filter((s) => s.id !== id);
      await saveConfig(cfg);
    });
    await this.tick();
  }

  /** Start a schedule now, outside its timetable (does not move its cursor). */
  async runNow(id: string) {
    const s = (await loadConfig()).schedules.find((x) => x.id === id);
    if (!s) throw new ScheduleError('Unknown schedule');
    if (this.active.has(s.id)) throw new ScheduleError('This schedule is already running');
    void this.execute(s, Date.now(), 'manual');
  }

  /** Drop finished runs from the history. */
  clearRuns() {
    this.runs = this.runs.filter((r) => r.status === 'running' || r.status === 'waiting');
    this.persist();
  }

  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const fire: { s: Schedule; at: number }[] = [];
      let schedules: Schedule[] = [];
      await withConfigLock(async () => {
        const cfg = await loadConfig();
        schedules = cfg.schedules;
        let changed = false;
        for (const s of cfg.schedules) {
          if (!s.enabled) continue;
          let due: ReturnType<typeof dueAction>;
          try { due = dueAction(s, now); } catch { continue; }
          if (!due) continue;
          s.cursor = now;
          changed = true;
          if (due.kind === 'missed') this.record(s, due.at, 'missed', 'Past its grace window when the app next checked (the Mac was asleep or the app was closed)');
          else if (this.active.has(s.id)) this.record(s, due.at, 'skipped', 'The previous run was still going');
          else fire.push({ s, at: due.at });
        }
        if (changed) await saveConfig(cfg);
      });
      for (const f of fire) void this.execute(f.s, f.at, 'schedule');
      // The schedules just read (and saved, if a cursor moved) are what power needs too.
      await this.updatePower(now, schedules);
    } catch (err) {
      console.warn(`[vibrato] schedule tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async updatePower(now: number, loaded?: Schedule[]) {
    const schedules = loaded ?? (await loadConfig()).schedules;
    const soon = earliestNext(schedules, now - 1, ['awake', 'wake']);
    this.power.holdAwake(this.active.size > 0 || (soon !== null && soon - now <= AWAKE_LEAD_MS));
    // The next run far enough ahead that waking for it still makes sense.
    const wakeFor = earliestNext(schedules, now + WAKE_LEAD_MS + TICK_MS, ['wake']);
    await this.power.syncWake(wakeFor === null ? null : wakeFor - WAKE_LEAD_MS);
  }

  private record(s: Schedule, at: number, status: 'missed' | 'skipped', error: string) {
    this.add({ id: randomUUID(), scheduleId: s.id, name: s.name, cwd: s.cwd, agent: s.agent, trigger: 'schedule', scheduledFor: at, startedAt: Date.now(), endedAt: Date.now(), status, error });
  }

  private add(run: ScheduleRun) {
    this.runs.push(run);
    // Oldest finished runs go first; live ones are never dropped.
    while (this.runs.length > RUNS_KEPT) {
      const i = this.runs.findIndex((r) => r.status !== 'running' && r.status !== 'waiting');
      if (i < 0) break;
      this.runs.splice(i, 1);
    }
    this.persist();
  }

  private patch(run: ScheduleRun, p: Partial<ScheduleRun>) {
    Object.assign(run, p);
    this.persist();
  }

  private persist() {
    const data = JSON.stringify(this.runs, null, 1);
    this.saving = this.saving.then(async () => {
      await fs.mkdir(CONFIG_DIR, { recursive: true });
      const temp = `${RUNS_FILE}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, data, { mode: 0o600 }); await fs.rename(temp, RUNS_FILE); } finally { await fs.rm(temp, { force: true }); }
    }).catch((err) => console.warn(`[vibrato] saving schedule runs failed: ${(err as Error).message}`));
  }

  private async execute(s: Schedule, scheduledFor: number, trigger: ScheduleRun['trigger']) {
    const run: ScheduleRun = { id: randomUUID(), scheduleId: s.id, name: s.name, cwd: s.cwd, agent: s.agent, trigger, scheduledFor, startedAt: Date.now(), status: 'running' };
    this.active.set(s.id, run.id);
    this.add(run);
    this.power.holdAwake(true);
    const finish = (status: 'done' | 'failed', p: Partial<ScheduleRun> = {}) => {
      if (run.status === 'done' || run.status === 'failed') return;
      this.patch(run, { ...p, status, endedAt: Date.now() });
    };
    try {
      await assertDir(s.cwd);
      await waitForNetwork(API_HOST[s.agent]);
      // A schedule that continues a conversation sends into it where it is already open; otherwise the
      // conversation is resumed in a headless session, like a fresh run.
      const live = s.resumeSessionId ? this.registry.list().find((x) => x.agent === s.agent && x.agentSessionId === s.resumeSessionId) : undefined;
      const session = (live && this.registry.get(live.id)) || await this.registry.startHeadless({ agent: s.agent, cwd: s.cwd, permissionMode: s.permissionMode, model: s.model, resume: s.resumeSessionId });
      this.patch(run, { sessionId: session.id, agentSessionId: s.resumeSessionId });
      const settled = new Promise<void>((resolve) => {
        const off = session.onEvent((e) => {
          if (e.kind === 'session.init' && e.agentSessionId && !run.agentSessionId) this.patch(run, { agentSessionId: e.agentSessionId });
          else if (e.kind === 'approval.request' || e.kind === 'question.request') this.patch(run, { status: 'waiting' });
          else if ((e.kind === 'approval.resolved' || e.kind === 'question.resolved') && run.status === 'waiting') this.patch(run, { status: 'running' });
          else if (e.kind === 'result') {
            finish(e.ok ? 'done' : 'failed', { costUsd: e.turnCostUsd, agentSessionId: e.agentSessionId ?? run.agentSessionId, error: e.ok ? undefined : e.text.slice(0, 500) || 'The run ended with an error' });
            off(); resolve();
          } else if (e.kind === 'status' && e.status === 'closed') {
            finish('failed', { error: 'The session closed before the run finished' });
            off(); resolve();
          }
        });
      });
      await this.registry.send(session.id, () => session.send(promptText(s), [], randomUUID()));
      await settled;
      const id = session.id;
      // A session a window opened stays with the window.
      if (live) return;
      const close = () => {
        if (!this.registry.get(id)) return;
        if (this.registry.watchers(id) > 0) return;
        void this.registry.close(id).catch(() => {});
      };
      setTimeout(close, CLOSE_AFTER_MS).unref();
    } catch (err) {
      finish('failed', { error: (err as Error).message });
    } finally {
      if (this.active.get(s.id) === run.id) this.active.delete(s.id);
      void this.updatePower(Date.now()).catch(() => {});
    }
  }
}

function safeNext(cron: string, now: number) {
  try { return nextOccurrence(cron, now); } catch { return null; }
}

async function assertDir(dir: string) {
  const st = await fs.stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new ScheduleError(`Folder not found: ${dir}`);
}

/** Right after a wake Wi-Fi takes a few seconds to come back; a run started before that fails at once. */
async function waitForNetwork(host: string) {
  const until = Date.now() + NETWORK_WAIT_MS;
  while (Date.now() < until) {
    try { await lookup(host); return; } catch { await new Promise((r) => setTimeout(r, 3000)); }
  }
}
