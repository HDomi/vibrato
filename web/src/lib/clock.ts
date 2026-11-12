import { useEffect, useState } from 'react';

/** Current time, re-read every second while `active`. Keep it in the smallest component that shows it. */
export function useClock(active: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
