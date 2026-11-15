import type { ChatSession } from '../lib/chatStore';

/** What the app window does for this platform's own features: nothing here. */
export function usePlatformApp(_opts: { sessions: Record<string, ChatSession>; openSettings: (tab: string) => void }) {
  /* no lock screen to report sessions to */
}
