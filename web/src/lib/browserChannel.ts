/** The browser window sends picked elements to the main window's composer over this channel (same origin). */
export const BROWSER_CHANNEL = 'vibe-browser';
export type BrowserChannelMessage = { kind: 'pick'; text: string; image?: string };
