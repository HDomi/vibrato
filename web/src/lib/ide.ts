/**
 * The IDE runs in a window of its own (one per project root, see electron/main.cts `open-ide`).
 * In a plain browser tab it opens as a new tab instead.
 */
export function openIde(root: string, file?: string) {
  if (window.vibe?.openIde) { void window.vibe.openIde(root, file); return; }
  const q = new URLSearchParams({ ide: root, ...(file ? { file } : {}) });
  window.open(`/?${q}`, '_blank');
}

/** IDE windows send "attach this file to the chat" here; same origin, so a BroadcastChannel reaches the main window. */
export const IDE_CHANNEL = 'vibe-ide';
export type IdeMessage = { kind: 'attach'; root: string; files: { path: string; name: string }[] };
