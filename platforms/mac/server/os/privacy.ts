import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { PermissionsError, type FolderId, type PermState, type PrivacySnapshot, type TccRow } from '../permissions.js';

/**
 * The macOS side of Settings > Permissions: what TCC has granted this app, now and before.
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
 */


export const FOLDERS: Record<FolderId, { dir: string; service: string }> = {
  desktop: { dir: 'Desktop', service: 'SystemPolicyDesktopFolder' },
  documents: { dir: 'Documents', service: 'SystemPolicyDocumentsFolder' },
  downloads: { dir: 'Downloads', service: 'SystemPolicyDownloadsFolder' },
};

const HOME = homedir();
const USER_TCC = path.join(HOME, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db');
const SYSTEM_TCC = '/Library/Application Support/com.apple.TCC/TCC.db';
/** Current, pre-rename and unbranded dev identities. */
export const KNOWN_BUNDLE_IDS = ['com.hdomi.vibrato', 'com.hdomi.mac-vibe-coder', 'com.github.Electron'];

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

/** What macOS has granted the app: TCC rows (with Full Disk Access), the protected folders and Photos. */
export async function privacySnapshot(opts: { bundlePath?: string } = {}): Promise<PrivacySnapshot> {
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
  return { bundleIds: ids, fullDisk, tcc, tccDbs: [...(user ? ['user' as const] : []), ...(system ? ['system' as const] : [])], folders, photos: await photos(false) };
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
