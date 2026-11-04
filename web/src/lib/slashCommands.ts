/**
 * Claude Code built-in commands whose terminal UI does not survive the SDK: sent as a message they only print a
 * one-line summary or "isn't available in this environment". The composer routes them here instead.
 */

/** Settings dialogs of the terminal CLI with no SDK counterpart: run them in a `claude` terminal tab. */
const TERMINAL_COMMANDS = new Set([
  'plugin', 'plugins', 'marketplace', 'hooks', 'permissions', 'allowed-tools', 'memory', 'status', 'login', 'logout',
  'theme', 'statusline', 'ide', 'terminal-setup', 'privacy-settings', 'install-github-app', 'install-slack-app', 'upgrade',
]);
/** Commands that take an argument over the SDK but open a picker in the terminal when given none. */
const TERMINAL_WHEN_BARE = new Set(['config', 'settings']);

/** The "/" list of a Claude session: the CLI's commands plus the terminal-only ones the app opens itself. */
export function withAppCommands(commands: string[] = []): string[] {
  const have = new Set(commands);
  return [...commands, ...[...TERMINAL_COMMANDS].map((c) => `/${c}`).filter((c) => !have.has(c))];
}

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const;

export type SlashRoute =
  | { kind: 'mcp' }
  | { kind: 'model'; model?: string }
  | { kind: 'effort' }
  | { kind: 'terminal'; command: string };

/** How the app handles a Claude message that is one built-in command, or null to send it as typed. */
export function routeSlash(text: string): SlashRoute | null {
  const m = /^\/([\w:-]+)(?:[ \t]+(.*))?$/.exec(text.trim());
  if (!m || text.trim().includes('\n')) return null;
  const name = m[1].toLowerCase();
  const arg = (m[2] ?? '').trim();
  if (name === 'mcp' && !arg) return { kind: 'mcp' };
  if (name === 'model') return arg ? { kind: 'model', model: arg } : { kind: 'model' };
  if (name === 'effort' && !arg) return { kind: 'effort' };
  if (TERMINAL_COMMANDS.has(name) || (TERMINAL_WHEN_BARE.has(name) && !arg)) return { kind: 'terminal', command: arg ? `/${name} ${arg}` : `/${name}` };
  return null;
}

/** Shell line that opens the terminal CLI straight into `command` (single-quoted, so the argument cannot run anything). */
export function claudeShellLine(command: string): string {
  return `claude '${command.replace(/'/g, `'\\''`)}'`;
}
