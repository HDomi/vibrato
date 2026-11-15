import { app, shell, type BrowserWindow, type BrowserWindowConstructorOptions, type Input, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * The Windows side of the Electron shell (main.cts): a standard window frame, no lock screen and no in-app browser
 * (links open in the default browser), and updates installed by running the release's NSIS installer silently.
 */

// Toast notifications are attributed to the shortcut the installer made, which carries this id (electron-builder appId).
app.setAppUserModelId('com.hdomi.vibrato');

/** Remote-only client (no local server; just the Remote tab): VIBRATO_REMOTE_ONLY=1. */
export const REMOTE_ONLY = process.env.VIBRATO_REMOTE_ONLY === '1';
/** Shared with server/os/update.ts: where a downloaded update waits until the app restarts. */
export const UPDATE_DIR = process.env.VIBRATO_UPDATE_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Vibrato', 'update');
export const QUIT_WHEN_WINDOWS_CLOSE = true;
/** Extra preload arguments (electron/preload.cjs): no lock or browser bridge for the page. */
export const PRELOAD_FLAGS: string[] = ['--vibrato-no-lock', '--vibrato-no-browser'];
/** Leading application menus: none (the File menu comes first). */
export const MENU_LEADING: MenuItemConstructorOptions[] = [];

/** The standard frame; the menu bar shows with Alt. */
export function windowChrome(_buttons: { x: number; y: number }): BrowserWindowConstructorOptions {
  return { autoHideMenuBar: true };
}

/** A Node placed in the app folder, and the user's own from PATH. */
export const bundledNode = (root: string) => path.join(root, 'runtime', 'node', 'node.exe');
export function findSystemNode(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('where.exe', ['node'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      const exe = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l));
      resolve(!err && exe ? exe : null);
    });
  });
}

/**
 * A downloaded installer waiting (server/os/update.ts) is started silently: it waits for this app to close, replaces
 * the files in the same folder and starts the app again (--force-run). False when there is nothing to install.
 */
export function installStagedUpdate(): boolean {
  if (!app.isPackaged) return false;
  const pendingFile = path.join(UPDATE_DIR, 'pending.json');
  try {
    const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')) as { installer?: unknown };
    fs.rmSync(pendingFile, { force: true }); // one attempt per staged update, even if this one fails
    const installer = typeof pending.installer === 'string' ? path.resolve(pending.installer) : '';
    if (!installer.startsWith(UPDATE_DIR + path.sep) || !/\.exe$/i.test(installer) || !fs.existsSync(installer)) return false;
    // /D (the install folder) must come last and takes the rest of the line unquoted.
    spawn(installer, ['--updated', '/S', '--force-run', `/D=${path.dirname(process.execPath)}`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    return true;
  } catch {
    return false;
  }
}

// No lock screen on this target.
export const blocksQuit = () => false;
export const isLocked = () => false;
export const isLockShortcut = (_input: Input) => false;
export const lockNow = () => { /* nothing to lock */ };
export const rememberLockForRelaunch = () => { /* nothing to remember */ };

export interface StartDeps {
  appUrl: string; serverUrl: string; preload: string; port: number;
  fromApp: (e: IpcMainInvokeEvent | IpcMainEvent) => boolean;
  createBrowserWindow: () => BrowserWindow;
}

export function start(_deps: StartDeps): { resumeLocked: boolean } {
  return { resumeLocked: false };
}

/** No in-app browser: a page opens in the default browser (the caller only passes http/https URLs). */
export async function openBrowser(url?: string): Promise<void> {
  if (url) await shell.openExternal(url).catch(() => {});
}

export function menu(_ko: boolean): { lock: MenuItemConstructorOptions | null; browser: MenuItemConstructorOptions | null } {
  return { lock: null, browser: null };
}

/** No privacy permissions to report or ask for. */
export function permissionsInfo() { return null; }
export async function askPermission(_id: unknown): Promise<boolean> { return false; }

export function openNotificationSettings() {
  void shell.openExternal('ms-settings:notifications');
}
