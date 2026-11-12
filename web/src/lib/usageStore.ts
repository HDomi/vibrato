import { useEffect, useState } from 'react';
import { api, type UsageSnapshot, type UsageWindow } from './api';

/**
 * One shared usage poller for the header batteries and the chat's limit warnings, plus a burn-rate
 * forecast built from the samples seen over the last hour.
 */

export interface Sample { t: number; used: number; reset: number | null }
type Key = 'claude.fiveHour' | 'claude.weekly' | 'codex.fiveHour' | 'codex.weekly';

const LS_SAMPLES = 'vibe.usage.samples';
const KEEP_MS = 6 * 60 * 60 * 1000;
const WINDOW_MS = 75 * 60 * 1000;
const MIN_SPAN_MS = 4 * 60 * 1000;

/**
 * Minutes until the window is used up at the recent rate, or null when it will not run out before it
 * resets (or there is too little data). Only samples from the current window (same reset time) count.
 */
export function minutesToEmpty(samples: Sample[], win: UsageWindow | null, now = Date.now()): number | null {
  if (!win || win.usedPct >= 100) return win && win.usedPct >= 100 ? 0 : null;
  const recent = samples.filter((s) => now - s.t <= WINDOW_MS && s.reset === win.resetsAt);
  if (recent.length < 2) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const span = last.t - first.t;
  const used = last.used - first.used;
  if (span < MIN_SPAN_MS || used <= 0) return null;
  const perMin = used / (span / 60000);
  const minutes = (100 - win.usedPct) / perMin;
  if (win.resetsAt && now + minutes * 60000 >= win.resetsAt * 1000) return null;
  return Math.max(0, Math.round(minutes));
}

let snapshot: UsageSnapshot | null = null;
let loading = false;
let error: string | undefined;
let samples: Record<string, Sample[]> = (() => { try { return JSON.parse(localStorage.getItem(LS_SAMPLES) || '{}'); } catch { return {}; } })();
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
let lastLoad = 0;

function record(data: UsageSnapshot) {
  const now = Date.now();
  const add = (key: Key, w: UsageWindow | null | undefined) => {
    if (!w) return;
    const list = (samples[key] ?? []).filter((s) => now - s.t <= KEEP_MS);
    const prev = list[list.length - 1];
    // A fresh window (reset moved) starts a new series.
    if (prev && prev.reset !== w.resetsAt) list.length = 0;
    if (!prev || prev.used !== w.usedPct || now - prev.t > 10 * 60 * 1000) list.push({ t: now, used: w.usedPct, reset: w.resetsAt });
    samples[key] = list.slice(-60);
  };
  add('claude.fiveHour', data.claude?.fiveHour); add('claude.weekly', data.claude?.weekly);
  add('codex.fiveHour', data.codex?.fiveHour); add('codex.weekly', data.codex?.weekly);
  try { localStorage.setItem(LS_SAMPLES, JSON.stringify(samples)); } catch { /* ignore */ }
}

export function loadUsage(force = false) {
  if (loading) return;
  loading = true; lastLoad = Date.now(); emit();
  api.usage(force).then((d) => { snapshot = d; error = undefined; record(d); })
    .catch((e) => { error = (e as Error).message; })
    .finally(() => { loading = false; emit(); });
}

let started = false;
function start() {
  if (started) return;
  started = true;
  loadUsage();
  // Skipped while hidden: the visibilitychange handler below catches up as soon as the window is back.
  setInterval(() => { if (!document.hidden) loadUsage(); }, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadUsage(); });
  // A finished turn is when usage moves; refresh then, at most every 90 seconds.
  window.addEventListener('vibe:usage-refresh', () => { if (Date.now() - lastLoad > 90000) loadUsage(); });
}

export function useUsage() {
  const [, force] = useState(0);
  useEffect(() => {
    start();
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return { usage: snapshot, loading, error, forecast: (key: Key, win: UsageWindow | null) => minutesToEmpty(samples[key] ?? [], win) };
}
