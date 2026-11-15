import type { ReactNode } from 'react';

/** Settings sections only this platform has: none. */
export const SETTINGS_TABS: { id: string; key: string; after: string; available: () => boolean; render: (p: { focus: boolean }) => ReactNode }[] = [];
