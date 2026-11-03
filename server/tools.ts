import { forgetCommandPaths, run, which } from './shell.js';

export type ToolId = 'claude' | 'codex';
export type InstallMethod = 'official' | 'brew' | 'npm';

export interface ToolStatus {
  id: ToolId;
  name: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  loggedIn: boolean | null;
  authInfo: string | null;
}

export interface Installers {
  brew: string | null;
  npm: string | null;
  node: string | null;
}

export const INSTALL_COMMANDS: Record<ToolId, Partial<Record<InstallMethod, string>>> = {
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

export const UPDATE_COMMANDS: Record<ToolId, string> = {
  claude: 'claude update',
  codex: 'codex update',
};

async function claudeStatus(): Promise<ToolStatus> {
  const p = await which('claude');
  if (!p) return { id: 'claude', name: 'Claude Code', installed: false, path: null, version: null, loggedIn: null, authInfo: null };
  const v = await run(p, ['--version']);
  const auth = await run(p, ['auth', 'status']);
  let loggedIn: boolean | null = null;
  let authInfo: string | null = null;
  try {
    const j = JSON.parse(auth.stdout);
    loggedIn = Boolean(j.loggedIn);
    authInfo = j.loggedIn ? `${j.authMethod ?? ''} ${j.email ?? ''}`.trim() : null;
  } catch { /* older CLI or not logged in */ }
  return { id: 'claude', name: 'Claude Code', installed: true, path: p, version: v.stdout.split(' ')[0] || null, loggedIn, authInfo };
}

async function codexStatus(): Promise<ToolStatus> {
  const p = await which('codex');
  if (!p) return { id: 'codex', name: 'Codex CLI', installed: false, path: null, version: null, loggedIn: null, authInfo: null };
  const v = await run(p, ['--version']);
  const auth = await run(p, ['login', 'status']);
  const text = (auth.stdout || auth.stderr).trim();
  const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
  return {
    id: 'codex', name: 'Codex CLI', installed: true, path: p,
    version: v.stdout.replace(/^codex-cli\s*/, '') || null,
    loggedIn, authInfo: loggedIn ? text : null,
  };
}

async function probeTools(): Promise<{ tools: ToolStatus[]; installers: Installers }> {
  const [claude, codex, brew, npm, node] = await Promise.all([
    claudeStatus(), codexStatus(), which('brew'), which('npm'), which('node'),
  ]);
  return { tools: [claude, codex], installers: { brew, npm, node } };
}

/**
 * Each probe starts both CLIs twice (version, auth status), so results are cached.
 * The settings panel and installs pass `force` so a change shows at once.
 */
const TOOLS_TTL_MS = 5 * 60 * 1000;
let toolsCache: { at: number; result: ReturnType<typeof probeTools> } | null = null;

export function detectTools(force = false): ReturnType<typeof probeTools> {
  if (force) forgetCommandPaths();
  if (!force && toolsCache && Date.now() - toolsCache.at < TOOLS_TTL_MS) return toolsCache.result;
  const entry = { at: Date.now(), result: probeTools() };
  entry.result.catch(() => { if (toolsCache === entry) toolsCache = null; });
  toolsCache = entry;
  return entry.result;
}
