import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG_DIR } from './config.js';
import { resolvePath } from './fs.js';
import { encodeImage } from './os/images.js';

const ICON_CACHE = path.join(CONFIG_DIR, 'icons');
const TTL_MS = 5 * 60 * 1000;

/**
 * Where projects usually keep their icon, most specific first. Directory entries ending
 * with "/" are scanned for the largest png inside (Xcode asset catalogs, icon sets).
 */
const CANDIDATES = [
  // Web / Vite / CRA / Nuxt / SvelteKit
  'public/favicon.svg', 'public/favicon.png', 'public/favicon.ico', 'public/icon.svg', 'public/icon.png',
  'public/logo.svg', 'public/logo.png', 'public/apple-touch-icon.png', 'public/android-chrome-192x192.png',
  'public/icons/icon-192.png', 'public/icons/icon-192x192.png', 'public/img/logo.png', 'public/images/logo.png',
  'static/favicon.svg', 'static/favicon.png', 'static/favicon.ico', 'static/icon.png', 'static/logo.png', 'static/logo.svg',
  // Next.js app router
  'app/icon.png', 'app/icon.svg', 'app/favicon.ico', 'src/app/icon.png', 'src/app/icon.svg', 'src/app/favicon.ico',
  // Monorepo-ish web subfolders
  'web/public/favicon.svg', 'web/public/icon.svg', 'web/public/icon.png', 'web/public/favicon.png', 'web/public/favicon.ico',
  'frontend/public/favicon.svg', 'frontend/public/favicon.png', 'frontend/public/favicon.ico', 'client/public/favicon.ico', 'client/public/favicon.png',
  // Electron / Tauri / Flutter / Godot / generic
  'build/icon.png', 'build/icon.icns', 'buildResources/icon.png', 'resources/icon.png', 'resources/icon.icns',
  'assets/icon.png', 'assets/icon.svg', 'assets/icon.icns', 'assets/logo.png', 'assets/logo.svg', 'assets/icon/icon.png', 'assets/images/logo.png',
  'src/assets/logo.svg', 'src/assets/logo.png', 'src/assets/icon.svg', 'src/assets/icon.png', 'src/assets/favicon.ico',
  'src-tauri/icons/icon.png', 'src-tauri/icons/128x128.png',
  'icon.svg', 'icon.png', 'icon.icns', 'logo.svg', 'logo.png', 'favicon.ico', 'favicon.png', 'app-icon.png', 'AppIcon.png',
  // iOS / macOS / Android (directories → largest png inside)
  'Assets.xcassets/AppIcon.appiconset/', 'ios/Runner/Assets.xcassets/AppIcon.appiconset/',
  'android/app/src/main/res/mipmap-xxxhdpi/', 'android/app/src/main/res/mipmap-xxhdpi/',
  'Sources/*/Resources/', 'icon.iconset/',
  // Built macOS app bundles inside the repo (electron-builder / swift build output)
  'build/*.app/Contents/Resources/', 'dist/*.app/Contents/Resources/', 'release/*.app/Contents/Resources/',
];

interface Cached { file: string | null; at: number }
const cache = new Map<string, Cached>();

async function exists(p: string): Promise<boolean> { try { await fs.access(p); return true; } catch { return false; } }

async function largestPng(dir: string): Promise<string | null> {
  try {
    const names = (await fs.readdir(dir)).filter((n) => /\.(png|jpe?g|icns)$/i.test(n));
    // An .icns inside a bundle is the app icon itself; prefer it over loose images.
    const icns = names.find((n) => /\.icns$/i.test(n));
    if (icns) return path.join(dir, icns);
    let best: { p: string; size: number } | null = null;
    for (const n of names) {
      const p = path.join(dir, n);
      const st = await fs.stat(p).catch(() => null);
      if (st && (!best || st.size > best.size)) best = { p, size: st.size };
    }
    return best?.p ?? null;
  } catch { return null; }
}

/** Expand a single "*" path segment against the filesystem. */
async function expand(root: string, rel: string): Promise<string[]> {
  if (!rel.includes('*')) return [path.join(root, rel)];
  const [head, tail] = rel.split('*');
  const base = path.join(root, head);
  try {
    const dirs = await fs.readdir(base, { withFileTypes: true });
    return dirs.filter((d) => d.isDirectory()).map((d) => path.join(base, d.name, tail));
  } catch { return []; }
}

async function safeIcon(root: string, file: string): Promise<string | null> {
  if (!/\.(png|jpe?g|svg|ico|webp|gif|icns)$/i.test(file)) return null;
  try {
    const [base, actual] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
    const relative = path.relative(base, actual);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return null;
    return (await fs.stat(actual)).isFile() ? actual : null;
  } catch { return null; }
}

/** Icons declared in project manifests: Godot `project.godot` (config/icon), Tauri `tauri.conf.json`, package.json "icon". */
async function manifestIcon(root: string): Promise<string | null> {
  // Godot: [application] config/icon="res://assets/icon.png"
  try {
    const godot = await fs.readFile(path.join(root, 'project.godot'), 'utf8');
    const m = godot.match(/config\/icon\s*=\s*"res:\/\/([^"]+)"/);
    if (m) { const p = path.join(root, m[1]); const safe = await safeIcon(root, p); if (safe) return safe; }
  } catch { /* not godot */ }
  // Tauri: bundle.icon[] in src-tauri/tauri.conf.json (paths relative to src-tauri)
  try {
    const conf = JSON.parse(await fs.readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    const list: string[] = conf?.bundle?.icon ?? conf?.tauri?.bundle?.icon ?? [];
    const png = list.find((x) => /\.png$/i.test(x)) ?? list[0];
    if (png) { const p = path.join(root, 'src-tauri', png); const safe = await safeIcon(root, p); if (safe) return safe; }
  } catch { /* not tauri */ }
  // package.json: "icon" (electron-builder style "build.mac.icon" / "build.icon") or top-level "icon"
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const rel: string | undefined = pkg?.icon ?? pkg?.build?.icon ?? pkg?.build?.mac?.icon;
    if (typeof rel === 'string') { const p = path.join(root, rel); const safe = await safeIcon(root, p); if (safe) return safe; }
  } catch { /* no package.json */ }
  return null;
}

/** First matching icon file for a project folder, or null. Cached per folder for a few minutes. */
export async function findProjectIcon(dir: string): Promise<string | null> {
  const root = resolvePath(dir);
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.file;
  let found: string | null = await manifestIcon(root);
  outer: for (const rel of CANDIDATES) {
    if (found) break;
    for (const p of await expand(root, rel)) {
      if (rel.endsWith('/')) { const candidate = await largestPng(p); found = candidate ? await safeIcon(root, candidate) : null; if (found) break outer; continue; }
      const safe = await safeIcon(root, p); if (safe) { found = safe; break outer; }
    }
  }
  if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
  cache.set(root, { file: found, at: Date.now() });
  return found;
}

/** Path of a browser-displayable file for the icon: .icns is converted to png (os/images.ts) and cached. */
export async function displayableIcon(file: string): Promise<string> {
  if (!/\.icns$/i.test(file)) return file;
  await fs.mkdir(ICON_CACHE, { recursive: true });
  const st = await fs.stat(file);
  const key = createHash('sha256').update(file).digest('hex');
  const out = path.join(ICON_CACHE, `${key}-${Math.floor(st.mtimeMs)}.png`);
  if (!(await exists(out))) {
    for (const old of await fs.readdir(ICON_CACHE)) if (old.startsWith(key + '-') && path.join(ICON_CACHE, old) !== out) await fs.rm(path.join(ICON_CACHE, old), { force: true });
    await encodeImage(file, out, 'png', { fit: 256 });
  }
  return out;
}

export function invalidateIcon(dir: string) { cache.delete(resolvePath(dir)); }
