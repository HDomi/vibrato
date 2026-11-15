import type { ViewMode } from '../components/UsageBar';

/** What the macOS app has beyond the shared page (the Windows app has its own copy of this folder). */
export const PLATFORM: {
  /** The title bar's view tabs, in order. */
  views: readonly ViewMode[];
  /** The window's buttons are drawn over the page (macOS traffic lights): title bars keep room for them. */
  windowButtons: boolean;
  /** The in-app browser window and the agent browser tools it runs. */
  inAppBrowser: boolean;
  /** Formats the server's image conversion writes (server/os/images.ts); null: every format the dialog knows. */
  imageFormats: readonly string[] | null;
} = {
  views: ['vibe', 'agent', 'tools', 'schedule', 'remote'],
  windowButtons: true,
  inAppBrowser: true,
  imageFormats: null,
};

export const hasView = (v: ViewMode) => PLATFORM.views.includes(v);
