import { useEffect, useRef } from 'react';
import type { ChatSession } from '../lib/chatStore';
import { lockSummary } from '../lib/lockScreen';

/** What the app window does for this platform's own features. `openSettings` shows Settings at one of its tabs. */
export function usePlatformApp({ sessions, openSettings }: { sessions: Record<string, ChatSession>; openSettings: (tab: string) => void }) {
  // Lock screen: per-agent session counts for the cover windows (no titles), and the menu's "Lock Screen Settings…".
  const lastLockSummary = useRef('');
  useEffect(() => {
    if (!window.vibe?.lock) return;
    const list = lockSummary(Object.values(sessions));
    const key = JSON.stringify(list);
    if (key !== lastLockSummary.current) { lastLockSummary.current = key; window.vibe.lock.reportSessions(list); }
  }, [sessions]);
  useEffect(() => window.vibe?.lock?.onOpenSettings(() => openSettings('lock')), []);
}
