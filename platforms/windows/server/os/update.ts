import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/*
 * Windows: the standalone app is installed by the release's NSIS installer (Vibrato-Setup-<version>-<arch>.exe),
 * and that installer is also the update package. A staged update is the downloaded, hash-checked installer;
 * electron/platform.cts runs it silently after the app quits.
 */

export const BUNDLE_ID = 'com.hdomi.vibrato';
export const UPDATE_DIR = process.env.VIBRATO_UPDATE_DIR || path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Vibrato', 'update');

/** The folder the app is installed in (it holds Vibrato.exe and resources\app), or null in a source checkout. */
export function bundleOf(root: string): string | null {
  const m = /^(.*)[\\/]resources[\\/]app(?:[\\/].*)?$/i.exec(root);
  return m && existsSync(path.join(m[1], 'Vibrato.exe')) ? m[1] : null;
}

/** Why the app cannot update itself, or null. A copy unpacked from the zip has no installer entry to update. */
export function bundleProblem(bundle: string): string | null {
  if (!existsSync(path.join(bundle, 'Uninstall Vibrato.exe'))) return 'This copy was unpacked from the zip. Install Vibrato with the setup program to get updates, or download the new zip.';
  return null;
}

/** Whether a release asset is this target's package for `arch` (arm64 | x64). */
export function isReleasePackage(name: string, arch: string): boolean {
  return /^Vibrato-Setup-.+\.exe$/i.test(name) && name.toLowerCase().endsWith(`-${arch}.exe`);
}

/**
 * The downloaded, hash-checked installer is the whole package: keep it in `stage` (the caller removes the download).
 * Resolves with what the pending record needs to install it, or null after reporting why not.
 */
export async function unpackRelease(file: string, stage: string, _version: string, onLine: (line: string, stream: 'stdout' | 'stderr') => void): Promise<Record<string, string> | null> {
  const installer = path.join(stage, 'Vibrato-Setup.exe');
  try {
    await fs.copyFile(file, installer);
    // An executable starts with "MZ"; anything else is not an installer.
    const head = Buffer.alloc(2);
    const fh = await fs.open(installer, 'r');
    try { await fh.read(head, 0, 2, 0); } finally { await fh.close(); }
    if (head.toString('latin1') !== 'MZ') { onLine('The download is not an installer.', 'stderr'); return null; }
    return { installer };
  } catch (err) {
    onLine((err as Error).message, 'stderr');
    return null;
  }
}

/** Updating a source checkout in place is a macOS script (scripts/apply-update.sh): not offered here. */
export function checkoutUpdateCommand(_repoRoot: string): string | null {
  return null;
}
