import type { ViewMode } from '../components/UsageBar';

/** What the Windows app has beyond the shared page (the macOS app has its own copy of this folder). */
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
  views: ['vibe', 'agent', 'tools', 'remote'],
  windowButtons: false,
  inAppBrowser: false,
  // WebP is encoded by the page itself, so it is offered on every platform.
  imageFormats: ['png', 'jpeg', 'webp', 'tiff', 'gif', 'bmp', 'ico'],
};

export const hasView = (v: ViewMode) => PLATFORM.views.includes(v);
