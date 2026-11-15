import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isReleasePackage, unpackRelease, UPDATE_DIR } from './os/update.js';

/*
 * Updates for the standalone app (built by electron-builder, see electron-builder.yml).
 * The release workflow attaches each target's package and SHA256SUMS.txt to every version tag's GitHub release.
 * Applying an update downloads this target's package, checks its hash, lets the platform unpack and verify it
 * (os/update.ts) and records it as pending; the Electron main process installs it after the app quits and reopens
 * it (electron/platform.cts). Nothing touches the installed app until then.
 */

export { BUNDLE_ID, UPDATE_DIR, bundleOf, bundleProblem } from './os/update.js';
/** GitHub REST base for the releases. Overridable for local end-to-end tests against a fake feed. */
export const FEED = process.env.VIBRATO_UPDATE_FEED || 'https://api.github.com/repos/HDomi/vibrato';
/** The repository's web pages (Atom feed, asset downloads). Not subject to the API rate limit. */
export const WEB = process.env.VIBRATO_UPDATE_WEB || 'https://github.com/HDomi/vibrato';
export const PENDING_FILE = 'pending.json';

export interface ReleaseAsset { name: string; browser_download_url: string; size: number }
export interface Release { tag_name: string; name?: string | null; body?: string | null; draft?: boolean; prerelease?: boolean; published_at?: string | null; assets: ReleaseAsset[] }

/** One installable release as the update dialog lists it. */
export interface ReleaseSummary { version: string; tag: string; name: string; publishedAt: string | null; notes: string }

/** This target's package for the machine's architecture (`zip`) and the checksum list, as published by the release workflow. */
export function pickAssets(release: Release, arch: string = process.arch): { zip: ReleaseAsset | null; sums: ReleaseAsset | null } {
  const a = arch === 'arm64' ? 'arm64' : 'x64';
  return {
    zip: release.assets.find((x) => isReleasePackage(x.name, a)) ?? null,
    sums: release.assets.find((x) => x.name === 'SHA256SUMS.txt') ?? null,
  };
}

/** `shasum -a 256` output ("<hex>  <name>", optional "*" before binary names) to name -> hash. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) out.set(path.basename(m[2].trim()), m[1].toLowerCase());
  }
  return out;
}

const UA = 'vibrato-updater';
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': UA };

export interface FeedError extends Error { status: number; rateLimited: boolean }

/**
 * Unauthenticated API calls share 60 requests per hour per public IP (an office NAT burns through that quickly).
 * Two measures keep the updater working: conditional requests, since a 304 does not count against the limit,
 * and the web pages (Atom feed + release assets) as the source of truth while the limit is exhausted.
 */
const etags = new Map<string, { etag: string; body: unknown }>();

function feedError(url: string, res: Response): FeedError {
  const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
  const resetAt = Number(res.headers.get('x-ratelimit-reset')) * 1000;
  const wait = resetAt ? Math.max(1, Math.ceil((resetAt - Date.now()) / 60000)) : 0;
  const message = rateLimited ? `GitHub API rate limit reached${wait ? `; it resets in ${wait} min` : ''}` : `${url.replace(FEED, 'GitHub')}: HTTP ${res.status}`;
  return Object.assign(new Error(message), { status: res.status, rateLimited });
}

async function getJson<T>(url: string): Promise<T> {
  const hit = etags.get(url);
  const res = await fetch(url, { headers: hit ? { ...headers, 'If-None-Match': hit.etag } : headers, signal: AbortSignal.timeout(15000) });
  if (res.status === 304 && hit) return hit.body as T;
  if (!res.ok) throw feedError(url, res);
  const body = await res.json() as T;
  const etag = res.headers.get('etag');
  if (etag) etags.set(url, { etag, body });
  return body;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw Object.assign(new Error(`${url.replace(WEB, 'GitHub')}: HTTP ${res.status}`), { status: res.status, rateLimited: false });
  return await res.text();
}

const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos|#39);/gi, (_, e: string) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()] ?? '';
});

/** Entries of the repository's releases.atom, newest first. The notes are the HTML body flattened to text. */
export function parseAtom(xml: string): { tag: string; name: string; publishedAt: string | null; notes: string }[] {
  const out: { tag: string; name: string; publishedAt: string | null; notes: string }[] = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const tag = entry.match(/\/releases\/tag\/([^"<]+)"/)?.[1];
    if (!tag) continue;
    const title = decodeEntities(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').trim();
    const html = decodeEntities(entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? '');
    const notes = decodeEntities(html.replace(/<\/(p|li|h\d|div|br)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
    out.push({ tag: decodeURIComponent(tag), name: title || tag, publishedAt: entry.match(/<updated>([^<]+)<\/updated>/)?.[1] ?? null, notes });
  }
  return out;
}

/** A release rebuilt from its web assets: SHA256SUMS.txt lists every file the workflow attached. Sizes are unknown. */
async function releaseFromWeb(tag: string, meta: Partial<Release> = {}): Promise<Release> {
  const base = `${WEB}/releases/download/${encodeURIComponent(tag)}`;
  const names = [...parseSums(await getText(`${base}/SHA256SUMS.txt`)).keys(), 'SHA256SUMS.txt'];
  return { tag_name: tag, name: meta.name ?? tag, body: meta.body ?? '', published_at: meta.published_at ?? null, assets: names.map((name) => ({ name, browser_download_url: `${base}/${name}`, size: 0 })) };
}

/** The Atom feed does not mark prereleases; only plain vX.Y.Z tags count. Releases without a checksum list are dropped. */
async function releasesFromWeb(limit: number): Promise<Release[]> {
  const entries = parseAtom(await getText(`${WEB}/releases.atom`)).filter((e) => /^v\d+\.\d+\.\d+$/.test(e.tag)).slice(0, limit);
  if (!entries.length) throw new Error('releases.atom lists no release');
  const all = await Promise.all(entries.map((e) => releaseFromWeb(e.tag, { name: e.name, body: e.notes, published_at: e.publishedAt }).catch(() => null)));
  return all.filter((r): r is Release => r !== null);
}

/** Runs `api`; while the API is rate limited, `web` answers instead. Any other failure (or both failing) is reported as the API's. */
async function viaApiOrWeb<T>(api: () => Promise<T>, web: () => Promise<T>): Promise<T> {
  try { return await api(); } catch (err) {
    if (!(err as FeedError).rateLimited) throw err;
    try { return await web(); } catch { throw err; }
  }
}

const installable = (r: Release) => !r.draft && !r.prerelease && !!pickAssets(r).zip && !!pickAssets(r).sums;

/** The newest published releases that carry a zip for this machine, newest first. One API call for the whole update check. */
export async function installableReleases(limit = 3): Promise<Release[]> {
  const list = await viaApiOrWeb(() => getJson<Release[]>(`${FEED}/releases?per_page=15`), () => releasesFromWeb(limit + 2));
  return list.filter(installable).slice(0, limit);
}

export async function latestRelease(): Promise<Release> {
  const [release] = await installableReleases(1);
  if (!release) throw Object.assign(new Error('No release has been published yet.'), { status: 404, rateLimited: false });
  return release;
}

export const releaseByTag = (tag: string) => viaApiOrWeb(() => getJson<Release>(`${FEED}/releases/tags/${encodeURIComponent(tag)}`), () => releaseFromWeb(tag));

export const summarize = (r: Release): ReleaseSummary => ({
  version: r.tag_name.replace(/^v/, ''), tag: r.tag_name, name: r.name || r.tag_name, publishedAt: r.published_at ?? null, notes: (r.body ?? '').trim().slice(0, 1500),
});

export async function recentReleases(limit = 3): Promise<ReleaseSummary[]> {
  return (await installableReleases(limit)).map(summarize);
}

/** Commit subjects between two tags, newest first (empty when GitHub cannot compare them, or the API is rate limited). */
export async function releaseCommits(fromTag: string, toTag: string): Promise<{ hash: string; subject: string }[]> {
  try {
    const cmp = await getJson<{ commits?: { sha: string; commit: { message: string } }[] }>(`${FEED}/compare/${encodeURIComponent(fromTag)}...${encodeURIComponent(toTag)}`);
    return (cmp.commits ?? []).slice(-20).reverse().map((c) => ({ hash: c.sha.slice(0, 7), subject: c.commit.message.split('\n')[0] }));
  } catch { return []; }
}

async function download(url: string, file: string, onProgress: (pct: number) => void): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0; let shown = -1;
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  body.on('data', (chunk: Buffer) => {
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 10) * 10 : -1;
    if (pct > shown) { shown = pct; onProgress(pct); }
  });
  await pipeline(body, createWriteStream(file));
}

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/**
 * Download, verify and unpack `release` into UPDATE_DIR, then record it as pending. Resolves with 0 on success.
 * The running app is not touched; the install happens after it quits.
 */
export async function stageRelease(release: Release, onLine: (line: string, stream: 'stdout' | 'stderr') => void): Promise<number> {
  const version = release.tag_name.replace(/^v/, '');
  const { zip, sums } = pickAssets(release);
  if (!zip || !sums) { onLine(`Release ${release.tag_name} has no ${process.arch} zip or SHA256SUMS.txt.`, 'stderr'); return 1; }
  await fs.mkdir(UPDATE_DIR, { recursive: true });
  const stage = path.join(UPDATE_DIR, 'staged');
  const zipFile = path.join(UPDATE_DIR, zip.name);
  await fs.rm(stage, { recursive: true, force: true });
  await fs.rm(path.join(UPDATE_DIR, PENDING_FILE), { force: true });
  try {
    onLine(`▸ download ${zip.name}${zip.size ? ` (${(zip.size / 1048576).toFixed(0)} MB)` : ''}`, 'stdout');
    await download(zip.browser_download_url, zipFile, (pct) => { if (pct >= 0) onLine(`  ${pct}%`, 'stdout'); });
    onLine('▸ verify SHA-256', 'stdout');
    const sumsFile = path.join(UPDATE_DIR, 'SHA256SUMS.txt');
    await download(sums.browser_download_url, sumsFile, () => {});
    const want = parseSums(await fs.readFile(sumsFile, 'utf8')).get(zip.name);
    const got = await sha256(zipFile);
    if (!want || want !== got) { onLine(`Checksum mismatch for ${zip.name}.`, 'stderr'); return 1; }
    onLine('▸ unpack', 'stdout');
    await fs.mkdir(stage, { recursive: true });
    const unpacked = await unpackRelease(zipFile, stage, version, onLine);
    if (!unpacked) return 1;
    await fs.writeFile(path.join(UPDATE_DIR, PENDING_FILE), JSON.stringify({ ...unpacked, version, stagedAt: new Date().toISOString() }));
    onLine(`▸ v${version} ready; restarting to install`, 'stdout');
    return 0;
  } finally {
    await fs.rm(zipFile, { force: true }).catch(() => {});
  }
}
