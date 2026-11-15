import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { run } from '../shell.js';

/*
 * macOS: the standalone app is a .app bundle and its release package is Vibrato-<version>-<arch>-mac.zip.
 * A staged update is the unpacked, verified bundle; electron/platform.cts swaps it in after the app quits.
 */

export const BUNDLE_ID = 'com.hdomi.vibrato';
export const UPDATE_DIR = process.env.VIBRATO_UPDATE_DIR || path.join(homedir(), 'Library', 'Caches', BUNDLE_ID, 'update');

/** The .app bundle this code runs from, or null when it runs from a source checkout. */
export function bundleOf(root: string): string | null {
  const marker = '.app/Contents/Resources/app';
  const i = root.indexOf(marker);
  return i < 0 ? null : root.slice(0, i + 4);
}

/** Why the bundle cannot replace itself, or null. Translocated or mounted copies are read-only. */
export function bundleProblem(bundle: string): string | null {
  if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return 'Move Vibrato to the Applications folder and open it from there to enable updates.';
  return null;
}

/** Whether a release asset is this target's package for `arch` (arm64 | x64). */
export function isReleasePackage(name: string, arch: string): boolean {
  return name.endsWith(`-${arch}-mac.zip`);
}

async function plist(app: string, key: string): Promise<string> {
  const r = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')], 10000);
  return r.ok ? r.stdout.trim() : '';
}

/**
 * Unpack the downloaded, hash-checked package into `stage` and verify what came out. Resolves with what the
 * pending record needs to install it, or null after reporting why not.
 */
export async function unpackRelease(zipFile: string, stage: string, version: string, onLine: (line: string, stream: 'stdout' | 'stderr') => void): Promise<Record<string, string> | null> {
  const unzip = await run('/usr/bin/ditto', ['-x', '-k', zipFile, stage], 5 * 60 * 1000);
  if (!unzip.ok) { onLine(unzip.stderr || 'unzip failed', 'stderr'); return null; }
  const appName = (await fs.readdir(stage)).find((n) => n.endsWith('.app'));
  if (!appName) { onLine('The zip holds no .app bundle.', 'stderr'); return null; }
  const app = path.join(stage, appName);
  const [id, v] = [await plist(app, 'CFBundleIdentifier'), await plist(app, 'CFBundleShortVersionString')];
  if (id !== BUNDLE_ID || v !== version) { onLine(`Unexpected bundle ${id} ${v} (want ${BUNDLE_ID} ${version}).`, 'stderr'); return null; }
  const sig = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], 120000);
  if (!sig.ok) { onLine(`Signature check failed: ${sig.stderr}`, 'stderr'); return null; }
  await run('/usr/bin/xattr', ['-cr', app], 60000);
  return { app };
}

/** The command line that updates a source checkout in place (scripts/apply-update.sh), or null where that is not offered. */
export function checkoutUpdateCommand(repoRoot: string): string | null {
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  return `/bin/zsh ${quote(path.join(repoRoot, 'scripts/apply-update.sh'))}`;
}
