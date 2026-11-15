import { app, shell, systemPreferences, type BrowserWindow, type BrowserWindowConstructorOptions, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blocksQuit, initLockScreen, isLocked, isLockShortcut, lockNow, openLockSettings, rememberLockForRelaunch } from './lockScreen.cjs';
import { initBrowser, openBrowser as openBrowserWindow } from './browser.cjs';

/*
 * The macOS side of the Electron shell (main.cts): window chrome, the lock screen, the in-app browser (a native
 * WKWebView), privacy permissions, and installing a staged update by swapping the .app bundle.
 */

/** Remote-only client (no local server; just the Remote tab). On a Mac only for testing: VIBRATO_REMOTE_ONLY=1. */
export const REMOTE_ONLY = process.env.VIBRATO_REMOTE_ONLY === '1';
/** Shared with server/os/update.ts: where a downloaded update waits until the app restarts. */
export const UPDATE_DIR = process.env.VIBRATO_UPDATE_DIR || path.join(os.homedir(), 'Library', 'Caches', 'com.hdomi.vibrato', 'update');
/** macOS apps stay open without windows. */
export const QUIT_WHEN_WINDOWS_CLOSE = false;
/** Extra preload arguments (electron/preload.cjs): bridges this target does not have. */
export const PRELOAD_FLAGS: string[] = [];
/** Leading application menus. */
export const MENU_LEADING: MenuItemConstructorOptions[] = [{ role: 'appMenu' }];

/** The .app this code runs from (standalone build), or null for a source checkout / the install.sh launcher. */
const APP_BUNDLE = (() => { const i = __dirname.indexOf('.app/Contents/Resources/app/'); return i < 0 ? null : __dirname.slice(0, i + 4); })();

/** Window frame: hidden title bar with the traffic lights at `buttons`. */
export function windowChrome(buttons: { x: number; y: number }): BrowserWindowConstructorOptions {
  return { titleBarStyle: 'hiddenInset', trafficLightPosition: buttons };
}

function loginShellLookup(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    // -i so ~/.zshrc (where nvm lives) is sourced; -l for Homebrew paths from ~/.zprofile.
    execFile('/bin/zsh', ['-lic', `command -v ${cmd}`], { timeout: 8000 }, (err, stdout) => {
      const p = stdout?.trim().split('\n').pop() ?? '';
      resolve(!err && p.startsWith('/') ? p : null);
    });
  });
}

/** A Node the installer downloaded into the app folder, and the user's own from their login shell. */
export const bundledNode = (root: string) => path.join(root, 'runtime', 'node', 'bin', 'node');
export const findSystemNode = () => loginShellLookup('node');

const SWAP_SCRIPT = `#!/bin/zsh
# Written by Vibrato (electron/platform.cts). Installs a staged update once the app has quit.
PID="$1"; APP="$2"; NEW="$3"; shift 3
for i in {1..300}; do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
echo "$(date '+%F %T') install $NEW -> $APP"
OLD="\${NEW:h}/previous.app"
rm -rf "$OLD"
if mv "$APP" "$OLD"; then
  if mv "$NEW" "$APP"; then
    xattr -cr "$APP" 2>/dev/null
    rm -rf "$OLD"
    echo "installed"
  else
    echo "could not move the new app into place; keeping the old one"
    mv "$OLD" "$APP"
  fi
else
  echo "could not move the old app aside; keeping it"
fi
open "$@" "$APP"
`;

/**
 * A standalone app with a downloaded release waiting swaps its bundle: a detached helper waits for this process to
 * exit, moves the new .app into place (rolling back on failure) and opens it. False when there is nothing to install.
 */
export function installStagedUpdate(): boolean {
  if (!APP_BUNDLE) return false;
  const pendingFile = path.join(UPDATE_DIR, 'pending.json');
  try {
    const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')) as { app?: unknown };
    fs.rmSync(pendingFile, { force: true }); // one attempt per staged update, even if this one fails
    const staged = typeof pending.app === 'string' ? path.resolve(pending.app) : '';
    if (!staged.startsWith(UPDATE_DIR + path.sep) || !staged.endsWith('.app') || !fs.existsSync(path.join(staged, 'Contents', 'Info.plist'))) return false;
    const script = path.join(UPDATE_DIR, 'install-update.sh');
    fs.writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 });
    // Test copies keep their isolation across the restart (open --env).
    const keep = ['VIBRATO_PORT', 'VIBRATO_USER_DATA', 'VIBRATO_CONFIG_DIR', 'VIBRATO_UPDATE_FEED', 'VIBRATO_UPDATE_DIR'].filter((k) => process.env[k]).flatMap((k) => ['--env', `${k}=${process.env[k]}`]);
    const log = fs.openSync(path.join(UPDATE_DIR, 'install.log'), 'a');
    spawn('/bin/zsh', [script, String(process.pid), APP_BUNDLE, staged, ...keep], { detached: true, stdio: ['ignore', log, log] }).unref();
    return true;
  } catch {
    return false;
  }
}

export { blocksQuit, isLocked, isLockShortcut, lockNow, rememberLockForRelaunch };

export interface StartDeps {
  appUrl: string; serverUrl: string; preload: string; port: number;
  fromApp: (e: IpcMainInvokeEvent | IpcMainEvent) => boolean;
  createBrowserWindow: () => BrowserWindow;
}

/** Lock screen and in-app browser. `resumeLocked`: the app was locked when it restarted (update, watchdog). */
export function start(deps: StartDeps): { resumeLocked: boolean } {
  // The installed app is a bundle the server can reopen if it has to kill a hung, locked app.
  const exe = app.getPath('exe');
  const bundle = app.isPackaged && exe.includes('.app/Contents/MacOS/') ? exe.slice(0, exe.indexOf('.app/Contents/MacOS/') + 4) : null;
  const lock = initLockScreen({ appUrl: deps.appUrl, preload: deps.preload, fromApp: deps.fromApp, serverUrl: deps.serverUrl, relaunchBundle: bundle });
  initBrowser({ createWindow: deps.createBrowserWindow, port: deps.port, isLocked });
  return { resumeLocked: lock.resumeLocked };
}

/** The in-app browser window; `url` opens in a new tab. */
export function openBrowser(url?: string): Promise<void> {
  return openBrowserWindow(url);
}

/** Menu entries of this target: the Lock Screen menu and the browser item of the Window menu. */
export function menu(ko: boolean): { lock: MenuItemConstructorOptions | null; browser: MenuItemConstructorOptions | null } {
  return {
    lock: {
      label: ko ? '잠금화면' : 'Lock Screen',
      submenu: [
        // registerAccelerator false: Option+L is caught in before-input-event (works inside text fields).
        { label: ko ? '지금 잠그기' : 'Lock Now', accelerator: 'Alt+L', registerAccelerator: false, click: () => lockNow() },
        { type: 'separator' },
        { label: ko ? '잠금화면 설정…' : 'Lock Screen Settings…', click: () => openLockSettings() },
      ],
    },
    browser: { label: ko ? 'Vibrato 브라우저' : 'Vibrato Browser', accelerator: 'Shift+CmdOrCtrl+B', click: () => { if (!isLocked()) void openBrowser(); } },
  };
}

// Settings > Permissions: the privacy states only the app process can read, plus which bundle it runs as
// (the server checks TCC rows against that bundle's current signature).
const appBundle = () => { const m = /^(.*?\.app)\/Contents\//.exec(process.execPath); return m ? m[1] : null; };
export function permissionsInfo() {
  const media = (k: 'screen' | 'camera' | 'microphone') => { try { return systemPreferences.getMediaAccessStatus(k); } catch { return 'unknown'; } };
  return {
    bundlePath: appBundle(),
    screen: media('screen'), camera: media('camera'), microphone: media('microphone'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    loginItem: app.getLoginItemSettings().openAtLogin,
  };
}
export async function askPermission(id: unknown): Promise<boolean> {
  if (id === 'accessibility') return systemPreferences.isTrustedAccessibilityClient(true);
  if (id === 'camera' || id === 'microphone') return systemPreferences.askForMediaAccess(id);
  return false;
}

// macOS remembers the first style it registered for the app, so the "alert" default in Info.plist only helps fresh
// installs; existing users switch to alerts in System Settings, which this opens straight at the app's page.
export function openNotificationSettings() {
  void shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.hdomi.vibrato');
}
