import { useEffect, useRef } from 'react';
import { api, type ScheduleRun } from './api';
import { t } from './i18n';

const POLL_MS = 20000;
/** While the window is hidden (minimized, other Space) runs are still watched, just less often. */
const HIDDEN_POLL_MS = 60000;
const NOTIFY: Partial<Record<ScheduleRun['status'], string>> = { done: 'sched.notify.done', failed: 'sched.notify.failed', waiting: 'sched.notify.waiting', missed: 'sched.notify.missed' };

/** Run status changes worth telling the user about, between two polls. The first poll only sets the baseline. */
export function runTransitions(prev: Map<string, ScheduleRun> | null, runs: ScheduleRun[]): ScheduleRun[] {
  if (!prev) return [];
  return runs.filter((r) => NOTIFY[r.status] && prev.get(r.id)?.status !== r.status);
}

/**
 * Watches scheduled runs from any view and notifies when one finishes, fails, waits for approval or is
 * missed. Clicking the notification opens the run (App resolves "schedule:<runId>"). Returns the latest
 * runs by id.
 */
export function useScheduleWatch() {
  const runs = useRef(new Map<string, ScheduleRun>());
  useEffect(() => {
    let prev: Map<string, ScheduleRun> | null = null;
    let stopped = false;
    const poll = async () => {
      try {
        const snap = await api.schedules();
        if (stopped) return;
        for (const r of runTransitions(prev, snap.runs)) {
          const title = t(NOTIFY[r.status]!);
          const body = `${r.name} · ${r.cwd.split('/').pop()}${r.error && r.status !== 'done' ? ` — ${r.error}` : ''}`;
          if (window.vibe?.notify) window.vibe.notify({ title, body, sessionId: `schedule:${r.id}` });
          window.dispatchEvent(new CustomEvent('vibe:toast', { detail: { text: `${title} · ${r.name}`, kind: r.status === 'failed' ? 'error' : undefined } }));
        }
        prev = new Map(snap.runs.map((r) => [r.id, r]));
        runs.current = prev;
      } catch { /* server restarting; next poll */ }
    };
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void poll(); schedule(); }, document.hidden ? HIDDEN_POLL_MS : POLL_MS);
    };
    void poll();
    schedule();
    // Coming back (restored windows get focus too) polls at once and restarts the shorter interval.
    const resume = () => { void poll(); schedule(); };
    window.addEventListener('focus', resume);
    return () => { stopped = true; window.clearTimeout(timer); window.removeEventListener('focus', resume); };
  }, []);
  return runs;
}
