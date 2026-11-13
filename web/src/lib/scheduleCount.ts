import { useSyncExternalStore } from 'react';
import { api } from './api';

/*
 * Number of schedules set up on this Mac, for the title bar badge. Loaded once; after that the Scheduler view
 * reports every snapshot it gets (only that view creates or deletes schedules), so there is no polling here.
 */
let count = 0;
let loaded = false;
const listeners = new Set<() => void>();

export function setScheduleCount(n: number) {
  loaded = true;
  if (n === count) return;
  count = n;
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!loaded) {
    loaded = true;
    api.schedules().then((s) => setScheduleCount(s.schedules.length)).catch(() => { loaded = false; });
  }
  return () => { listeners.delete(cb); };
}

export function useScheduleCount(): number {
  return useSyncExternalStore(subscribe, () => count, () => count);
}
