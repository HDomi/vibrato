import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { run } from '../shell.js';

/* macOS: Finder's Trash, ditto for zip archives, and AppleScript to open a folder in another app. */

/** Move to the Trash via Finder so the user can restore it. Rejects when Finder refuses. */
export async function moveToTrash(abs: string[]): Promise<void> {
  // Paths go in as argv, never spliced into the script: a crafted file name cannot escape the string.
  const script = [
    'on run argv',
    'set targets to {}',
    'repeat with p in argv',
    'set end of targets to (POSIX file (p as text))',
    'end repeat',
    'tell application "Finder" to delete targets',
    'end run',
  ];
  await promisify(execFile)('osascript', [...script.flatMap((l) => ['-e', l]), '--', ...abs], { timeout: 20000 });
}

/**
 * `folder` as `zip`, with the folder itself as the top entry. ditto ships with macOS (the updater unpacks releases
 * with it too); `--norsrc` keeps the AppleDouble `._*` entries out of the archive.
 */
export function zipFolder(folder: string, zip: string): Promise<{ ok: boolean; stderr: string }> {
  return run('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', folder, zip], 120000);
}

/** Apps a folder can be opened in (the file manager, a terminal, an editor). */
export const OPEN_TARGETS = ['terminal', 'iterm', 'finder', 'vscode', 'cursor'] as const;
export type OpenTarget = typeof OPEN_TARGETS[number];

/**
 * The path is passed to AppleScript as argv and shell-quoted with `quoted form of`, so folder names
 * containing quotes, backslashes or $(...) cannot inject commands.
 */
export async function openFolder(abs: string, target: OpenTarget): Promise<{ ok: boolean; stderr: string }> {
  const osa = (lines: string[]) => run('osascript', [...lines.flatMap((l) => ['-e', l]), '--', abs]);
  if (target === 'finder') return run('open', [abs]);
  if (target === 'vscode') return run('open', ['-a', 'Visual Studio Code', abs]);
  if (target === 'cursor') return run('open', ['-a', 'Cursor', abs]);
  if (target === 'iterm') {
    return osa(['on run argv', 'tell application "iTerm"', 'activate', 'set w to (create window with default profile)',
      'tell current session of w to write text ("cd " & quoted form of (item 1 of argv))', 'end tell', 'end run']);
  }
  return osa(['on run argv', 'tell application "Terminal"', 'activate', 'do script ("cd " & quoted form of (item 1 of argv))', 'end tell', 'end run']);
}
