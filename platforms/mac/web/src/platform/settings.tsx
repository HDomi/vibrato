import type { ReactNode } from 'react';
import LockSettings from '../components/LockSettings';

/** Settings sections only this platform has. `after`: the shared section it follows in the list. */
export const SETTINGS_TABS: { id: string; key: string; after: string; available: () => boolean; render: (p: { focus: boolean }) => ReactNode }[] = [
  // Not in a plain browser tab: the lock screen is the Electron app's.
  { id: 'lock', key: 'settings.tab.lock', after: 'formTypes', available: () => !!window.vibe?.lock, render: ({ focus }) => <LockSettings focus={focus} /> },
];
