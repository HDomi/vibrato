import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

/* Windows: how the agent CLIs are installed, and the programs the server borrows from the system. */

/** Ways to install an agent CLI, as command lines for cmd.exe. */
export const INSTALL_COMMANDS: Record<'claude' | 'codex', Partial<Record<'official' | 'brew' | 'npm', string>>> = {
  claude: {
    official: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"',
    npm: 'npm install -g @anthropic-ai/claude-code',
  },
  codex: {
    npm: 'npm install -g @openai/codex',
  },
};

/** Package managers the settings panel reports (an install method shows only when its manager is present). */
export const INSTALLERS = ['npm', 'node'] as const;

const where = (cmd: string) => new Promise<string | null>((resolve) => {
  execFile('where.exe', [cmd], { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null));
});

/**
 * openssl for the remote host's self-signed certificate. Windows ships none: one on PATH, else the copy inside
 * Git for Windows.
 */
export async function opensslPath(): Promise<string> {
  const onPath = await where('openssl');
  if (onPath) return onPath;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter((r): r is string => !!r);
  for (const root of roots) {
    for (const rel of [['Git', 'usr', 'bin', 'openssl.exe'], ['Git', 'mingw64', 'bin', 'openssl.exe']]) {
      const exe = path.join(root, ...rel);
      if (await access(exe).then(() => true, () => false)) return exe;
    }
  }
  throw new Error('openssl was not found. Install Git for Windows (it includes openssl) to host remote sessions.');
}
