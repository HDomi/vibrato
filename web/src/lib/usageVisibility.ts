/*
 * Which agents' usage chips the top bar shows (Settings > Agent CLIs > "Show status"). A display preference of this
 * window's profile, so it lives in localStorage; changes reach the bar at once through a window event.
 */
import { useEffect, useState } from 'react';

export type UsageAgent = 'claude' | 'codex';
const KEY = 'vibe.usage.hidden';
const EVENT = 'vibe:usage-visibility';

export function hiddenUsage(): UsageAgent[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is UsageAgent => x === 'claude' || x === 'codex') : [];
  } catch { return []; }
}

export function setUsageVisible(agent: UsageAgent, visible: boolean) {
  const next = hiddenUsage().filter((a) => a !== agent);
  if (!visible) next.push(agent);
  localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(EVENT));
}

/** The agents whose chips are hidden, kept current (this window's toggles and other windows' via `storage`). */
export function useHiddenUsage(): UsageAgent[] {
  const [hidden, setHidden] = useState(hiddenUsage);
  useEffect(() => {
    const update = () => setHidden(hiddenUsage());
    const fromOther = (e: StorageEvent) => { if (e.key === KEY) update(); };
    window.addEventListener(EVENT, update);
    window.addEventListener('storage', fromOther);
    return () => { window.removeEventListener(EVENT, update); window.removeEventListener('storage', fromOther); };
  }, []);
  return hidden;
}
