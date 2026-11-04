import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';

/**
 * Settings > Permissions: what macOS (TCC) and the agent CLIs have granted this app, now and before.
 * - TCC.db holds every privacy decision ever made for the app, including ones for its earlier bundle id and
 *   for a plain Electron dev run. The system database (Full Disk Access, Accessibility, Screen Recording, ...)
 *   is readable only with Full Disk Access, which is also how that permission is detected. The per-user
 *   database does not exist on every macOS release (it is gone on 27), so a missing row there means nothing.
 *   Rows whose code requirement no longer matches the running bundle are reported as stale: the app is signed
 *   ad hoc, every update changes that requirement, and switching an existing entry back on in System Settings
 *   keeps the old one, so macOS does not apply them to this build.
 * - Folders are checked by listing them: silently with Full Disk Access (which covers them), otherwise only
 *   on request, since that is what raises the prompt. Photos goes through PhotoKit from a JXA child; this
 *   server's children count as the app for TCC.
 * - Agent rules: Claude `permissions` in user / project settings files (where "always allow" lands),
 *   Codex approval / sandbox defaults, trusted projects and execpolicy rules.
 */

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
export const FOLDERS: Record<FolderId, { dir: string; service: string }> = {
  desktop: { dir: 'Desktop', service: 'SystemPolicyDesktopFolder' },
  documents: { dir: 'Documents', service: 'SystemPolicyDocumentsFolder' },
  downloads: { dir: 'Downloads', service: 'SystemPolicyDownloadsFolder' },
};

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
const USER_TCC = path.join(HOME, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db');
const SYSTEM_TCC = '/Library/Application Support/com.apple.TCC/TCC.db';
/** Current, pre-rename and unbranded dev identities. */
export const KNOWN_BUNDLE_IDS = ['com.hdomi.vibrato', 'com.hdomi.mac-vibe-coder', 'com.github.Electron'];
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const codexHome = () => process.env.CODEX_HOME || path.join(HOME, '.codex');

function exec(file: string, args: string[], timeout = 15000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err?.message ?? '')) })));
}

/** TCC auth_value: 0 denied, 1 unknown, 2 allowed, 3 limited. */
export function tccState(authValue: number): PermState {
  return authValue === 2 ? 'granted' : authValue === 3 ? 'limited' : authValue === 0 ? 'denied' : 'unknown';
}

/** PHAuthorizationStatus: 0 not determined, 1 restricted, 2 denied, 3 authorized, 4 limited. */
export function photosState(status: number): PermState {
  return (['notDetermined', 'restricted', 'denied', 'granted', 'limited'] as const)[status] ?? 'unknown';
}

/** Hex of the compiled designated requirement of an app bundle, as TCC stores it in `csreq`. */
async function bundleCsreq(bundle: string): Promise<string | null> {
  const r = await exec('/usr/bin/codesign', ['-d', '-r-', bundle]);
  const m = /designated => (.+)/.exec(r.stdout + r.stderr);
  if (!m) return null;
  const out = path.join(await fs.mkdtemp(path.join(tmpdir(), 'vibrato-csreq-')), 'req');
  try {
    if (!(await exec('/usr/bin/csreq', ['-r', '=' + m[1].trim(), '-b', out])).ok) return null;
    return (await fs.readFile(out)).toString('hex').toUpperCase();
  } finally {
    await fs.rm(path.dirname(out), { recursive: true, force: true });
  }
}

async function readTcc(db: string, kind: 'user' | 'system', ids: string[], ownId: string | null, ownCsreq: string | null): Promise<TccRow[] | null> {
  const list = ids.map((x) => `'${x.replace(/'/g, "''")}'`).join(',');
  const sql = `select service, client, auth_value, indirect_object_identifier, last_modified, hex(csreq) as csreq from access where client in (${list}) or client like '%vibrato%' or client like '%mac-vibe-coder%'`;
  const r = await exec('/usr/bin/sqlite3', ['-readonly', '-json', db, sql]);
  if (!r.ok) return null;
  const rows = (r.stdout.trim() ? JSON.parse(r.stdout) : []) as { service: string; client: string; auth_value: number; indirect_object_identifier: string | null; last_modified: number | null; csreq: string | null }[];
  return rows.map((x) => ({
    service: x.service.replace(/^kTCCService/, ''),
    client: x.client,
    db: kind,
    state: tccState(Number(x.auth_value)),
    target: x.indirect_object_identifier && x.indirect_object_identifier !== 'UNUSED' ? x.indirect_object_identifier : null,
    modified: x.last_modified ? Number(x.last_modified) * 1000 : null,
    stale: !!(ownCsreq && x.client === ownId && x.csreq && x.csreq !== ownCsreq),
  }));
}

const PHOTOS_STATUS = 'ObjC.import("Photos"); String($.PHPhotoLibrary.authorizationStatusForAccessLevel(2))';
/** Waits on the run loop for the callback; the prompt stays up until the user answers or the wait runs out. */
const PHOTOS_REQUEST = `ObjC.import("Photos"); ObjC.import("Foundation");
var st = -1;
$.PHPhotoLibrary.requestAuthorizationForAccessLevelHandler(2, function (s) { st = s; });
var until = Date.now() + 120000;
while (st < 0 && Date.now() < until) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));
String(st < 0 ? $.PHPhotoLibrary.authorizationStatusForAccessLevel(2) : st);`;

async function photos(request: boolean): Promise<PermState> {
  if (process.platform !== 'darwin') return 'unknown';
  const r = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', request ? PHOTOS_REQUEST : PHOTOS_STATUS], request ? 130000 : 10000);
  const n = Number.parseInt(r.stdout.trim(), 10);
  return r.ok && Number.isFinite(n) ? photosState(n) : 'unknown';
}

/** Listing the folder is what makes macOS ask; afterwards it answers silently either way. */
async function probeFolder(id: FolderId): Promise<PermState> {
  try { await fs.readdir(path.join(HOME, FOLDERS[id].dir)); return 'granted'; } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'EPERM' || code === 'EACCES' ? 'denied' : 'unknown';
  }
}

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

const bundleOf = (p: string | undefined) => (p && path.isAbsolute(p) && p.endsWith('.app') ? p : null);

async function bundleId(bundle: string | null): Promise<string> {
  const id = bundle && process.platform === 'darwin' ? (await exec('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')])).stdout.trim() : '';
  return /^[A-Za-z0-9.-]+$/.test(id) ? id : 'com.hdomi.vibrato';
}

/** TCC services the UI may reset (stale entries of an earlier build), as `tccutil` names them. */
const RESETTABLE = new Set(['SystemPolicyAllFiles', 'Accessibility', 'ScreenCapture', 'ListenEvent', 'PostEvent', 'DeveloperTool', 'SystemPolicyAppBundles', 'Photos', 'Camera', 'Microphone', 'AppleEvents']);

/** Drop the app's decision for one service so macOS asks again and records this build's signature. */
export async function resetPermission(service: string, bundlePath?: string): Promise<void> {
  if (!RESETTABLE.has(service)) throw new PermissionsError(`Unknown service "${service}"`);
  const r = await exec('/usr/bin/tccutil', ['reset', service, await bundleId(bundleOf(bundlePath))]);
  if (!r.ok) throw new PermissionsError(r.stderr.trim() || r.stdout.trim() || 'tccutil failed');
}

/** Folder answers learned from explicit requests while Full Disk Access is off. */
const probed = new Map<string, PermState>();

export async function permissionsSnapshot(opts: SnapshotOptions = {}): Promise<PermissionsSnapshot> {
  const bundle = bundleOf(opts.bundlePath);
  const ownId = await bundleId(bundle);
  const ids = [...new Set([ownId, ...KNOWN_BUNDLE_IDS])];
  const ownCsreq = bundle && process.platform === 'darwin' ? await bundleCsreq(bundle).catch(() => null) : null;
  const [user, system] = process.platform === 'darwin'
    ? await Promise.all([readTcc(USER_TCC, 'user', ids, ownId, ownCsreq), readTcc(SYSTEM_TCC, 'system', ids, ownId, ownCsreq)])
    : [null, null];
  const fullDisk = !!(user || system);
  const tcc = fullDisk ? [...(user ?? []), ...(system ?? [])].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)) : null;
  const fromTcc = (service: string): PermState | null => {
    const row = tcc?.find((r) => r.client === ownId && r.service === service && !r.stale);
    return row ? row.state : user ? 'notDetermined' : null;
  };
  // Full Disk Access covers the folders, so listing them cannot raise a prompt and gives the real answer.
  const folders = Object.fromEntries(await Promise.all((Object.keys(FOLDERS) as FolderId[]).map(async (id) => {
    const state = fullDisk ? await probeFolder(id) : fromTcc(FOLDERS[id].service) ?? probed.get(id) ?? 'unknown';
    return [id, state];
  }))) as Record<FolderId, PermState>;
  const [photosNow, claude, codex, wakeHelper] = await Promise.all([
    photos(false),
    claudeRuleFiles(),
    codexPermissions(),
    opts.wakeHelper ? opts.wakeHelper().catch(() => false) : Promise.resolve(false),
  ]);
  return { bundleIds: ids, fullDisk, tcc, tccDbs: [...(user ? ['user' as const] : []), ...(system ? ['system' as const] : [])], folders, photos: photosNow, wakeHelper, claude, codex };
}

/** Raise the macOS prompt for a folder or Photos; answers the resulting state. */
export async function requestPermission(id: string): Promise<PermState> {
  if (id === 'photos') return photos(true);
  if (id in FOLDERS) { const s = await probeFolder(id as FolderId); probed.set(id, s); return s; }
  throw new PermissionsError(`Unknown permission "${id}"`);
}

/** System Settings panes the UI may open. */
export const SETTINGS_PANES: Record<string, string> = {
  fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  files: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  photos: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Photos',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  appManagement: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles',
  developerTools: 'x-apple.systempreferences:com.apple.preference.security?Privacy_DevTools',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  inputMonitoring: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  privacy: 'x-apple.systempreferences:com.apple.preference.security?Privacy',
  notifications: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
  loginItems: 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
};

export async function openSettingsPane(pane: string): Promise<void> {
  const url = SETTINGS_PANES[pane];
  if (!url) throw new PermissionsError(`Unknown settings pane "${pane}"`);
  const r = await exec('/usr/bin/open', [url]);
  if (!r.ok) throw new PermissionsError(r.stderr.trim() || 'Could not open System Settings');
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
