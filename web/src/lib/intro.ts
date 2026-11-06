/**
 * First-launch intro (components/intro/Intro.tsx): what the app is, the macOS permissions it needs, then the app.
 * It asks for the protected folders up front, one at a time, so their prompts do not pile up later while a
 * project under ~/Desktop is opening (each unanswered prompt holds a file call on the server).
 */

export const INTRO_DONE_KEY = 'vibe.intro.done';
/** Keys an earlier install leaves behind: the app has been used, so this is not a first launch. */
const USED_KEYS = ['vibe.mode.view.v2', 'vibe.mode.view', 'vibe.cwd', 'vibe.project'];

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** Show the intro on a first launch only, or when forced (`?intro=1`). Marks earlier installs as done. */
export function needsIntro(store: Store, force = false): boolean {
  if (force) return true;
  try {
    if (store.getItem(INTRO_DONE_KEY)) return false;
    if (USED_KEYS.some((k) => store.getItem(k) !== null)) { store.setItem(INTRO_DONE_KEY, '1'); return false; }
    return true;
  } catch { return false; }
}

export function finishIntro(store: Store): void {
  try {
    store.setItem(INTRO_DONE_KEY, '1');
    // The app opens on VIBE, where folders and favorites live.
    store.setItem('vibe.mode.view.v2', 'vibe');
  } catch { /* storage unavailable: the intro shows again next time */ }
}

export const INTRO_FOLDERS = ['desktop', 'documents', 'downloads'] as const;
export type IntroFolder = typeof INTRO_FOLDERS[number];
type State = 'granted' | 'denied' | 'limited' | 'notDetermined' | 'restricted' | 'unknown';

/** Full Disk Access covers every folder; otherwise the folder's own answer. */
export function folderReady(state: State | undefined, fullDisk: boolean): boolean {
  return fullDisk || state === 'granted';
}

/** Folders still worth a prompt: not allowed yet and not refused (macOS does not ask again after a refusal). */
export function foldersToAsk(states: Partial<Record<IntroFolder, State>>, fullDisk: boolean): IntroFolder[] {
  return INTRO_FOLDERS.filter((id) => !folderReady(states[id], fullDisk) && states[id] !== 'denied' && states[id] !== 'restricted');
}
