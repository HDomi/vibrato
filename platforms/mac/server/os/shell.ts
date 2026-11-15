import { execFile, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';

/* macOS: commands run in the user's login zsh, which is also where their PATH (Homebrew, nvm) comes from. */

const execFileP = promisify(execFile);

/** A command line as the run panel, verification and streamShell start it. */
export function shellCommand(commandLine: string): { file: string; args: string[]; options: SpawnOptions } {
  return { file: '/bin/zsh', args: ['-lc', commandLine], options: { detached: true } };
}

/** The interactive shell of a terminal tab. */
export function loginShell(): { file: string; args: string[] } {
  return { file: process.env.SHELL || '/bin/zsh', args: ['-l'] };
}

/** Signal a shellCommand child and everything it started (detached, so it leads its process group). Throws once it is gone. */
export function signalProcessTree(pid: number, sig: NodeJS.Signals) {
  process.kill(-pid, sig);
}

/** PATH from the user's login shell (Electron launched from Finder has a minimal one); null keeps the current PATH. */
export async function loginShellPath(): Promise<string | null> {
  const { stdout } = await execFileP('/bin/zsh', ['-lic', 'echo -n "$PATH"'], { timeout: 8000 });
  return stdout.trim() || null;
}

/** Absolute path of a command on the login shell's PATH, or null. */
export async function lookupCommand(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('/bin/zsh', ['-lc', `command -v ${cmd}`], { timeout: 8000 });
    const p = stdout.trim().split('\n').pop() ?? '';
    return p.startsWith('/') ? p : null;
  } catch {
    return null;
  }
}

/** How to start what lookupCommand found: here always the file itself. */
export function startable(file: string, args: string[]): { file: string; args: string[] } {
  return { file, args };
}
