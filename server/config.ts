import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Schedule } from './schedule.js';
import type { ExtensionsConfig } from './agentExtensions.js';
import type { FormType } from '../web/src/lib/promptForm.js';

/** VIBRATO_PORT / VIBRATO_CONFIG_DIR only exist so a test copy of the app can run next to the real one. */
export const PORT = Number(process.env.VIBRATO_PORT) || 11398;
export const HOST = '127.0.0.1';
export const CONFIG_DIR = process.env.VIBRATO_CONFIG_DIR || path.join(homedir(), '.vibrato');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface Favorite {
  path: string;
  name: string;
  /** Group id, or undefined for top level. */
  group?: string;
}

export interface FavoriteGroup {
  id: string;
  name: string;
  collapsed?: boolean;
}

/** Per-project settings, keyed by absolute folder path. */
export interface ProjectSettings {
  path: string;
  /** Command run after an agent turn that changed files (typecheck, tests). */
  verify?: { command: string; auto: boolean };
  /** Queued prompts run one after another in fresh sessions (managed by the client dispatcher). */
  backlog?: Backlog;
}

export interface BacklogItem {
  id: string;
  text: string;
  status: 'todo' | 'running' | 'done' | 'failed' | 'stopped';
  sessionId?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

export interface Backlog { items: BacklogItem[]; auto: boolean; agent: 'claude' | 'codex'; mode: string; worktree: boolean }

export interface Config {
  favorites: Favorite[];
  groups: FavoriteGroup[];
  recent: string[];
  /** "agent:sessionId" keys of pinned sessions; pinned sessions cannot be deleted. */
  pinnedSessions: string[];
  projects: ProjectSettings[];
  /**
   * Standing instructions handed to every new agent session, whichever CLI runs it. Injected once at session
   * start (Claude: system prompt append, Codex: thread developer instructions), so it costs no extra tokens per turn.
   */
  customPrompt?: string;
  /** Ask every session for a step plan (plan view). Absent means on. */
  alwaysPlan?: boolean;
  /** Give new sessions the Vibrato browser MCP tools (server/browserMcp.ts). Absent means on. */
  browserTools?: boolean;
  /** Skills / prompts run on a cron schedule (server/scheduler.ts). */
  schedules: Schedule[];
  /** "Send as form" types edited in Settings; absent while the built-in ones are in use. */
  formTypes?: FormType[];
  /** Skills / plugins turned off for new sessions (Settings > Agent CLIs); everything else stays as the CLI has it. */
  extensionsOff?: ExtensionsConfig;
  /** Remote sessions host (server/remote/host.ts). Absent until set up; off by default. */
  remote?: RemoteHostConfig;
}

/** Only the PBKDF2 result of the access code is stored; the code itself is shown once when generated. */
export interface RemoteHostConfig {
  enabled: boolean;
  port: number;
  /** base64 */
  salt: string;
  iterations: number;
  /** base64 PBKDF2-SHA256(code, salt, iterations) */
  key: string;
  codeCreatedAt: number;
}

export const CUSTOM_PROMPT_MAX = 20000;

const DEFAULT: Config = { favorites: [], groups: [], recent: [], pinnedSessions: [], projects: [], schedules: [] };

export class ConfigStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {}

  /** Serialize the whole read/modify/write transaction, including concurrent HTTP requests. */
  exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }

  async load(): Promise<Config> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid configuration');
      const config = { ...structuredClone(DEFAULT), ...parsed };
      for (const key of Object.keys(DEFAULT) as (keyof Config)[]) {
        if (!Array.isArray(config[key])) throw new Error(`Invalid configuration: ${key}`);
      }
      return config;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT);
      // Preserve a damaged file instead of silently overwriting favorites and pins with defaults.
      throw err;
    }
  }

  async save(config: Config): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, this.file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
}

const store = new ConfigStore(CONFIG_FILE);
export const loadConfig = () => store.load();
export const saveConfig = (config: Config) => store.save(config);
export const withConfigLock = <T>(action: () => Promise<T>) => store.exclusive(action);
