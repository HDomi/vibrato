import { useEffect, useRef, useState } from 'react';

/**
 * `value`, updated at most once per `ms` while `active` (the latest value always lands at the end of each
 * window); the value itself once inactive. For text that grows on every streaming update but is costly to
 * render, like markdown parsed and highlighted from scratch each time.
 */
export function useThrottled<T>(value: T, ms: number, active: boolean): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    if (!active) return;
    const show = () => { last.current = Date.now(); setShown(value); };
    const wait = last.current + ms - Date.now();
    if (wait <= 0) { show(); return; }
    const timer = window.setTimeout(show, wait);
    return () => window.clearTimeout(timer);
  }, [value, ms, active]);
  return active ? shown : value;
}
