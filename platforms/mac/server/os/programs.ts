/* macOS: how the agent CLIs are installed, and the programs the server borrows from the system. */

/** Ways to install an agent CLI, as command lines for the login shell. */
export const INSTALL_COMMANDS: Record<'claude' | 'codex', Partial<Record<'official' | 'brew' | 'npm', string>>> = {
  claude: {
    official: 'curl -fsSL https://claude.ai/install.sh | bash',
    brew: 'brew install --cask claude-code',
    npm: 'npm install -g @anthropic-ai/claude-code',
  },
  codex: {
    brew: 'brew install codex',
    npm: 'npm install -g @openai/codex',
  },
};

/** Package managers the settings panel reports (an install method shows only when its manager is present). */
export const INSTALLERS = ['brew', 'npm', 'node'] as const;

/** openssl for the remote host's self-signed certificate (LibreSSL ships with macOS). */
export async function opensslPath(): Promise<string> {
  return '/usr/bin/openssl';
}
