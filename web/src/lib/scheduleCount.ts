import { useSyncExternalStore } from 'react';
import { api, type Schedule } from './api';

/*
 * Number of enabled schedules on this Mac, for the title bar badge. Loaded once; after that the Scheduler view
 * reports every snapshot it gets (only that view creates or deletes schedules), so there is no polling here.
 */
let count = 0;
let loaded = false;
const listeners = new Set<() => void>();

export function setScheduleCount(schedules: Schedule[]) {
  loaded = true;
  // Only enabled ones: a schedule that is turned off never runs.
  const n = schedules.filter((s) => s.enabled).length;
  if (n === count) return;
  count = n;
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!loaded) {
    loaded = true;
    api.schedules().then((s) => setScheduleCount(s.schedules)).catch(() => { loaded = false; });
  }
  return () => { listeners.delete(cb); };
}

export function useScheduleCount(): number {
  return useSyncExternalStore(subscribe, () => count, () => count);
}
