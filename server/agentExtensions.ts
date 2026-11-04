import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { listCodexExtensions } from './agents/codex.js';

/**
 * Skills and plugins ("mods") the agent CLIs have installed, and the ones the user turned off for Vibrato
 * (Settings > Agent CLIs). Turning one off never edits the CLIs' own config: each new session gets it as an
 * override (Claude: flag settings `skillOverrides` / `enabledPlugins`, Codex: `-c skills.config=...`).
 */

export type ExtAgent = 'claude' | 'codex';
export interface ExtSkill { name: string; description: string; source: 'user' | 'plugin' | 'claude.ai' | 'system' | 'admin' | 'project' | 'other'; plugin?: string; /** False when the CLI's own config turns it off. */ enabled: boolean }
export interface ExtPlugin { id: string; name: string; description: string; /** On in the CLI's own config. */ enabled: boolean; /** Vibrato can turn it off per session. */ toggle: boolean }
export interface AgentExtensions { skills: ExtSkill[]; plugins: ExtPlugin[]; error?: string }

/** What Vibrato turns off in new sessions, per agent. Absent lists mean everything stays as the CLI has it. */
export interface ExtensionsOff { skills?: string[]; plugins?: string[] }
export type ExtensionsConfig = Partial<Record<ExtAgent, ExtensionsOff>>;

const HOME = process.env.VIBRATO_AGENT_HOME || homedir();
const NAME_RE = /^[\w.:@-]{1,200}$/;

/** Keeps known agents and well-formed, de-duplicated names only. */
export function sanitizeExtensions(input: unknown): ExtensionsConfig {
  const out: ExtensionsConfig = {};
  if (!input || typeof input !== 'object') return out;
  for (const agent of ['claude', 'codex'] as const) {
    const v = (input as Record<string, unknown>)[agent] as Record<string, unknown> | undefined;
    if (!v || typeof v !== 'object') continue;
    const list = (k: string) => [...new Set((Array.isArray(v[k]) ? v[k] as unknown[] : []).filter((s): s is string => typeof s === 'string' && NAME_RE.test(s)))].sort();
    const skills = list('skills');
    const plugins = agent === 'claude' ? list('plugins') : [];
    if (skills.length || plugins.length) out[agent] = { ...(skills.length ? { skills } : {}), ...(plugins.length ? { plugins } : {}) };
  }
  return out;
}

/** Flag settings for a Claude session; undefined when nothing is turned off. */
export function claudeFlagSettings(off: ExtensionsOff | undefined): { skillOverrides?: Record<string, 'off'>; enabledPlugins?: Record<string, false> } | undefined {
  const skills = off?.skills ?? [];
  const plugins = off?.plugins ?? [];
  if (!skills.length && !plugins.length) return undefined;
  return {
    ...(skills.length ? { skillOverrides: Object.fromEntries(skills.map((s) => [s, 'off' as const])) } : {}),
    ...(plugins.length ? { enabledPlugins: Object.fromEntries(plugins.map((p) => [p, false as const])) } : {}),
  };
}

/** `codex app-server` arguments that turn skills off for that process only. */
export function codexConfigArgs(off: ExtensionsOff | undefined): string[] {
  const skills = (off?.skills ?? []).filter((s) => NAME_RE.test(s));
  if (!skills.length) return [];
  return ['-c', `skills.config=[${skills.map((s) => `{name=${JSON.stringify(s)},enabled=false}`).join(',')}]`];
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

/** Installed Claude plugins with their enabled state from user settings and the manifest description. */
async function claudePlugins(): Promise<ExtPlugin[]> {
  const claudeHome = path.join(HOME, '.claude');
  const [installed, settings] = await Promise.all([readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json')), readJson(path.join(claudeHome, 'settings.json'))]);
  const enabled = (settings?.enabledPlugins ?? {}) as Record<string, unknown>;
  const plugins = (installed?.plugins ?? {}) as Record<string, Array<{ installPath?: unknown }>>;
  return Promise.all(Object.entries(plugins).map(async ([id, installs]) => {
    const dir = Array.isArray(installs) ? installs.find((i) => typeof i?.installPath === 'string')?.installPath as string | undefined : undefined;
    const manifest = dir ? await readJson(path.join(dir, '.claude-plugin', 'plugin.json')) : null;
    return { id, name: id.split('@')[0], description: typeof manifest?.description === 'string' ? manifest.description : '', enabled: enabled[id] === true, toggle: true };
  }));
}

async function dirNames(dir: string): Promise<Set<string>> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return new Set(entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name));
}

/** Skill names of the claude.ai-synced skill folders (~/.claude/skills/synced/<org>/manifest.json). */
async function syncedSkillNames(): Promise<Set<string>> {
  const root = path.join(HOME, '.claude', 'skills', 'synced');
  const names = new Set<string>();
  for (const org of await dirNames(root)) {
    const manifest = await readJson(path.join(root, org, 'manifest.json'));
    for (const s of (manifest?.skills as Array<{ name?: unknown }> | undefined) ?? []) if (typeof s?.name === 'string') names.add(s.name);
  }
  return names;
}

/**
 * Claude skills as the CLI resolves them (its own command list, so the names are the ones `skillOverrides` keys on).
 * Built-in commands and bundled skills are left out: the list is for what the user installed.
 */
async function claudeExtensions(claudePath: string): Promise<AgentExtensions> {
  const plugins = await claudePlugins();
  const q = query({ prompt: (async function* () { /* never yields */ })(), options: { pathToClaudeCodeExecutable: claudePath, cwd: tmpdir(), env: process.env as Record<string, string>, persistSession: false } });
  try {
    const cmds = await Promise.race([q.supportedCommands(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000))]);
    const [userDirs, synced] = await Promise.all([dirNames(path.join(HOME, '.claude', 'skills')), syncedSkillNames()]);
    const pluginNames = new Set(plugins.map((p) => p.name));
    const skills = cmds.filter((c) => !c.builtin).map((c): ExtSkill => {
      const prefix = c.name.includes(':') ? c.name.split(':')[0] : '';
      const base = prefix ? c.name.slice(prefix.length + 1) : c.name;
      const source: ExtSkill['source'] = pluginNames.has(prefix) ? 'plugin' : userDirs.has(c.name) ? 'user' : synced.has(base) ? 'claude.ai' : 'other';
      return { name: c.name, description: c.description, source, ...(source === 'plugin' ? { plugin: plugins.find((p) => p.name === prefix)?.id } : {}), enabled: true };
    });
    return { skills, plugins };
  } finally {
    try { q.close(); } catch { /* already closed */ }
  }
}

const cache = new Map<ExtAgent, { at: number; value: AgentExtensions }>();

/** Cached for 10 minutes, since listing spawns the CLI; `force` re-reads (Settings "Re-detect"). */
export async function listExtensions(agent: ExtAgent, cliPath: string | null, force = false): Promise<AgentExtensions> {
  if (!cliPath) return { skills: [], plugins: [] };
  const hit = cache.get(agent);
  if (!force && hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  try {
    const value = agent === 'claude' ? await claudeExtensions(cliPath) : await listCodexExtensions(cliPath);
    value.skills.sort((a, b) => a.name.localeCompare(b.name));
    value.plugins.sort((a, b) => a.id.localeCompare(b.id));
    cache.set(agent, { at: Date.now(), value });
    return value;
  } catch (err) {
    return { skills: [], plugins: [], error: (err as Error).message };
  }
}
