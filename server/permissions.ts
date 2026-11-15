import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { privacySnapshot } from './os/privacy.js';

/**
 * Settings > Permissions: what the operating system and the agent CLIs have granted this app.
 * - The operating system's side is the platform's (os/privacy.ts): on macOS the privacy decisions in TCC.
 * - Agent rules: Claude `permissions` in user / project settings files (where "always allow" lands),
 *   Codex approval / sandbox defaults, trusted projects and execpolicy rules.
 */

export { openSettingsPane, requestPermission, resetPermission } from './os/privacy.js';

export type PermState = 'granted' | 'denied' | 'limited' | 'notDetermined' | 'restricted' | 'unknown';

export interface TccRow {
  service: string;
  client: string;
  db: 'user' | 'system';
  state: PermState;
  /** Apple Events target, for Automation rows. */
  target: string | null;
  modified: number | null;
  /** Granted to an older signature of this bundle; macOS will ask again. */
  stale: boolean;
}

export type FolderId = 'desktop' | 'documents' | 'downloads';
export interface ClaudeRuleFile {
  file: string;
  scope: 'user' | 'project';
  /** Project folder for project files. */
  project: string | null;
  allow: string[];
  ask: string[];
  deny: string[];
  defaultMode: string | null;
  additionalDirectories: string[];
}

export interface CodexRule { file: string; line: number; text: string; pattern: string[]; decision: string }
export interface CodexPermissions {
  file: string;
  approvalPolicy: string | null;
  sandboxMode: string | null;
  trusted: { path: string; level: string }[];
  rules: CodexRule[];
}

/** The operating system's part of the snapshot (os/privacy.ts). */
export type PrivacySnapshot = Pick<PermissionsSnapshot, 'bundleIds' | 'fullDisk' | 'tcc' | 'tccDbs' | 'folders' | 'photos'>;

export interface PermissionsSnapshot {
  /** The running app's bundle id first, then earlier / dev identities. */
  bundleIds: string[];
  fullDisk: boolean;
  /** Every TCC row for the app's identities; null without Full Disk Access. */
  tcc: TccRow[] | null;
  /** Databases that could be read; a missing row only means "never asked" in a database listed here. */
  tccDbs: ('user' | 'system')[];
  folders: Record<FolderId, PermState>;
  photos: PermState;
  wakeHelper: boolean;
  claude: ClaudeRuleFile[];
  codex: CodexPermissions | null;
}

const HOME = homedir();
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const codexHome = () => process.env.CODEX_HOME || path.join(HOME, '.codex');
async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try { const j = JSON.parse(await fs.readFile(file, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}

const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function claudeRulesOf(json: Record<string, unknown> | null): Omit<ClaudeRuleFile, 'file' | 'scope' | 'project'> | null {
  const p = json?.permissions;
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const r = { allow: strings(o.allow), ask: strings(o.ask), deny: strings(o.deny), defaultMode: typeof o.defaultMode === 'string' ? o.defaultMode : null, additionalDirectories: strings(o.additionalDirectories) };
  return r.allow.length || r.ask.length || r.deny.length || r.defaultMode || r.additionalDirectories.length ? r : null;
}

/** Folders the app or Claude has worked in: recent / favorite / configured projects, schedules and Claude's own project list. */
async function knownProjects(): Promise<string[]> {
  const cfg = await loadConfig();
  const dirs = new Set<string>([...cfg.recent, ...cfg.favorites.map((f) => f.path), ...cfg.projects.map((p) => p.path), ...cfg.schedules.map((s) => s.cwd)]);
  const claudeJson = await readJson(process.env.CLAUDE_CONFIG_DIR ? path.join(claudeHome(), '.claude.json') : path.join(HOME, '.claude.json'));
  if (claudeJson?.projects && typeof claudeJson.projects === 'object') for (const p of Object.keys(claudeJson.projects)) dirs.add(p);
  dirs.delete(HOME);
  return [...dirs].filter((d) => path.isAbsolute(d));
}

async function claudeRuleFiles(): Promise<ClaudeRuleFile[]> {
  const files: { file: string; scope: 'user' | 'project'; project: string | null }[] = [
    { file: path.join(claudeHome(), 'settings.json'), scope: 'user', project: null },
    { file: path.join(claudeHome(), 'settings.local.json'), scope: 'user', project: null },
  ];
  for (const dir of await knownProjects()) for (const name of ['settings.json', 'settings.local.json']) files.push({ file: path.join(dir, '.claude', name), scope: 'project', project: dir });
  const out = await Promise.all(files.map(async (f) => { const r = claudeRulesOf(await readJson(f.file)); return r ? { ...f, ...r } : null; }));
  return out.filter((x): x is ClaudeRuleFile => !!x);
}

/** Top-level approval / sandbox keys and `[projects."<path>"] trust_level` from Codex's config.toml. */
export function parseCodexConfig(toml: string): Pick<CodexPermissions, 'approvalPolicy' | 'sandboxMode' | 'trusted'> {
  let section: string | null = null;
  let approvalPolicy: string | null = null;
  let sandboxMode: string | null = null;
  const trusted: { path: string; level: string }[] = [];
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    const sec = /^\[(.+)\]\s*(#.*)?$/.exec(line);
    if (sec) { section = sec[1].trim(); continue; }
    const kv = /^([A-Za-z_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (!kv) continue;
    if (section === null && kv[1] === 'approval_policy') approvalPolicy = kv[2];
    else if (section === null && kv[1] === 'sandbox_mode') sandboxMode = kv[2];
    else if (kv[1] === 'trust_level' && section) {
      const p = /^projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')$/.exec(section);
      if (p) trusted.push({ path: p[1] !== undefined ? p[1].replace(/\\(.)/g, '$1') : p[2], level: kv[2] });
    }
  }
  return { approvalPolicy, sandboxMode, trusted };
}

/** `prefix_rule(pattern=[...], decision="allow")` lines of a Codex execpolicy file. */
export function parseCodexRules(text: string, file: string): CodexRule[] {
  const out: CodexRule[] = [];
  text.split('\n').forEach((raw, i) => {
    const m = /^\s*prefix_rule\(\s*pattern\s*=\s*(\[.*?\])\s*,\s*decision\s*=\s*"([^"]+)"/.exec(raw);
    if (!m) return;
    let pattern: string[] = [];
    try { pattern = strings(JSON.parse(m[1])); } catch { pattern = [m[1]]; }
    out.push({ file, line: i + 1, text: raw, pattern, decision: m[2] });
  });
  return out;
}

async function codexPermissions(): Promise<CodexPermissions | null> {
  const file = path.join(codexHome(), 'config.toml');
  const toml = await fs.readFile(file, 'utf8').catch(() => null);
  const rulesDir = path.join(codexHome(), 'rules');
  const names = (await fs.readdir(rulesDir).catch(() => [] as string[])).filter((n) => n.endsWith('.rules')).sort();
  const rules = (await Promise.all(names.map(async (n) => parseCodexRules(await fs.readFile(path.join(rulesDir, n), 'utf8').catch(() => ''), path.join(rulesDir, n))))).flat();
  if (toml === null && !rules.length) return null;
  return { file, ...parseCodexConfig(toml ?? ''), rules };
}

export interface SnapshotOptions {
  /** Bundle of the running app (from Electron): its id picks the current TCC rows, its signature finds stale ones. */
  bundlePath?: string;
  wakeHelper?: () => Promise<boolean>;
}

export async function permissionsSnapshot(opts: SnapshotOptions = {}): Promise<PermissionsSnapshot> {
  const [privacy, claude, codex, wakeHelper] = await Promise.all([
    privacySnapshot({ bundlePath: opts.bundlePath }),
    claudeRuleFiles(),
    codexPermissions(),
    opts.wakeHelper ? opts.wakeHelper().catch(() => false) : Promise.resolve(false),
  ]);
  return { ...privacy, wakeHelper, claude, codex };
}

export class PermissionsError extends Error {}

export type ClaudeList = 'allow' | 'ask' | 'deny' | 'additionalDirectories';

/** Remove one entry from a settings file's `permissions`; the rest of the file is kept as is. */
export function withoutClaudeRule(json: Record<string, unknown>, list: ClaudeList, rule: string): Record<string, unknown> {
  const p = json.permissions;
  if (!p || typeof p !== 'object' || !Array.isArray((p as Record<string, unknown>)[list])) return json;
  const arr = (p as Record<string, unknown>)[list] as unknown[];
  return { ...json, permissions: { ...(p as Record<string, unknown>), [list]: arr.filter((x) => x !== rule) } };
}

export async function removeClaudeRule(file: string, list: ClaudeList, rule: string): Promise<void> {
  // Only files this module reports, so the endpoint cannot be pointed at arbitrary JSON.
  if (!(await claudeRuleFiles()).some((f) => f.file === file)) throw new PermissionsError('Not a known Claude settings file');
  if (!['allow', 'ask', 'deny', 'additionalDirectories'].includes(list)) throw new PermissionsError(`Unknown list "${list}"`);
  const json = await readJson(file);
  if (!json) throw new PermissionsError('Settings file is not valid JSON');
  await fs.writeFile(file, JSON.stringify(withoutClaudeRule(json, list, rule), null, 2) + '\n');
}

export async function removeCodexRule(file: string, text: string): Promise<void> {
  if (path.dirname(file) !== path.join(codexHome(), 'rules') || !file.endsWith('.rules')) throw new PermissionsError('Not a Codex rules file');
  const lines = (await fs.readFile(file, 'utf8')).split('\n');
  const i = lines.indexOf(text);
  if (i < 0) throw new PermissionsError('Rule not found (the file changed)');
  lines.splice(i, 1);
  await fs.writeFile(file, lines.join('\n'));
}
