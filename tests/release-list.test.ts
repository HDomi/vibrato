import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

// Every target's package, so the list is the same whichever target runs the test.
const asset = (v: string) => [...['arm64', 'x64'].flatMap((a) => [`Vibrato-${v}-${a}-mac.zip`, `Vibrato-Setup-${v}-${a}.exe`]).map((name) => ({ name, browser_download_url: 'x', size: 1 })), { name: 'SHA256SUMS.txt', browser_download_url: 'x', size: 1 }];
const releases = [
  { tag_name: 'v2.2.0', name: 'v2.2.0', draft: true, assets: asset('2.2.0') },
  { tag_name: 'v2.1.1', name: 'Fixes', body: 'notes', published_at: '2026-10-27T00:00:00Z', assets: asset('2.1.1') },
  { tag_name: 'v2.1.0-rc1', prerelease: true, assets: asset('2.1.0-rc1') },
  { tag_name: 'v2.1.0', assets: [] },
  { tag_name: 'v2.0.1', assets: asset('2.0.1') },
  { tag_name: 'v2.0.0', assets: asset('2.0.0') },
  { tag_name: 'v1.0.11', assets: asset('1.0.11') },
];
const sums = (v: string) => `${'a'.repeat(64)}  Vibrato-${v}-arm64.dmg\n${'b'.repeat(64)}  Vibrato-${v}-arm64-mac.zip\n${'c'.repeat(64)}  Vibrato-${v}-x64-mac.zip\n${'d'.repeat(64)}  Vibrato-Setup-${v}-arm64.exe\n${'e'.repeat(64)}  Vibrato-Setup-${v}-x64.exe\n`;
const entry = (tag: string, title: string, html: string) => `<entry><id>${tag}</id><updated>2026-10-27T00:00:00Z</updated><link rel="alternate" type="text/html" href="https://github.com/HDomi/vibrato/releases/tag/${tag}"/><title>${title}</title><content type="html">${html}</content></entry>`;
const atom = `<?xml version="1.0"?><feed>${entry('v2.1.1', 'Fixes', '&lt;p&gt;notes &amp;amp; more&lt;/p&gt;')}${entry('v2.1.0-rc1', 'rc', '')}${entry('v2.1.0', 'gone', '')}${entry('v2.0.1', 'v2.0.1', '')}</feed>`;

/** One fake GitHub: the REST API under /, the web pages under the same origin. `mode` picks the API's behaviour. */
let mode: 'ok' | 'limited' | 'dead' = 'ok';
const asked: string[] = [];
const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  asked.push(url);
  if (url === '/releases.atom') { res.setHeader('content-type', 'application/atom+xml'); if (mode === 'dead') res.statusCode = 500; res.end(mode === 'dead' ? '' : atom); return; }
  const dl = url.match(/^\/releases\/download\/(v[^/]+)\/SHA256SUMS\.txt$/);
  if (dl) { if (dl[1] === 'v2.1.0') { res.statusCode = 404; res.end(); } else res.end(sums(dl[1].slice(1))); return; }
  if (mode !== 'ok') { res.statusCode = 403; res.setHeader('x-ratelimit-remaining', '0'); res.setHeader('x-ratelimit-reset', String(Math.floor(Date.now() / 1000) + 1380)); res.end('{"message":"API rate limit exceeded"}'); return; }
  res.setHeader('etag', '"abc"');
  if (req.headers['if-none-match'] === '"abc"') { res.statusCode = 304; res.end(); return; }
  res.setHeader('content-type', 'application/json');
  const tag = url.match(/^\/releases\/tags\/(.+)$/)?.[1];
  res.end(JSON.stringify(tag ? releases.find((r) => r.tag_name === tag) : releases));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.VIBRATO_UPDATE_FEED = origin;
process.env.VIBRATO_UPDATE_WEB = origin;
const feed = await import('../server/releaseUpdate');
test.after(() => server.close());

test('recent releases: newest installable ones, drafts, prereleases and asset-less ones skipped', async () => {
  const list = await feed.recentReleases(3);
  assert.match(asked.at(-1)!, /^\/releases\?per_page=/);
  assert.deepEqual(list.map((r) => r.version), ['2.1.1', '2.0.1', '2.0.0']);
  assert.deepEqual(list[0], { version: '2.1.1', tag: 'v2.1.1', name: 'Fixes', publishedAt: '2026-10-27T00:00:00Z', notes: 'notes' });
});

test('a second check sends the ETag and reuses the list on 304 (free of the rate limit)', async () => {
  const before = asked.length;
  assert.equal((await feed.latestRelease()).tag_name, 'v2.1.1');
  assert.equal(asked.length - before, 1);
});

test('rate limited API: the Atom feed and SHA256SUMS.txt stand in', async () => {
  mode = 'limited';
  try {
    const list = await feed.recentReleases(3);
    assert.deepEqual(list.map((r) => r.version), ['2.1.1', '2.0.1']);
    assert.equal(list[0].name, 'Fixes');
    assert.equal(list[0].notes, 'notes & more');
    assert.ok(asked.includes('/releases.atom') && asked.includes('/releases/download/v2.1.1/SHA256SUMS.txt'), asked.join(' '));
    const byTag = await feed.releaseByTag('v2.0.1');
    assert.match(feed.pickAssets(byTag, 'arm64').zip?.browser_download_url ?? '', new RegExp(`^${origin}/releases/download/v2\\.0\\.1/Vibrato-(2\\.0\\.1-arm64-mac\\.zip|Setup-2\\.0\\.1-arm64\\.exe)$`));
    assert.equal(feed.pickAssets(byTag, 'arm64').sums?.name, 'SHA256SUMS.txt');
  } finally { mode = 'ok'; }
});

test('rate limited and no web pages either: the error names the limit and when it resets', async () => {
  mode = 'dead';
  try {
    await assert.rejects(feed.recentReleases(3), (err: Error) => /rate limit reached; it resets in 23 min/.test(err.message));
  } finally { mode = 'ok'; }
});

test('update dialog lists releases with install / roll back by version order', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { RecentReleases } = await import('../web/src/components/UpdatePanel');
  const html = renderToStaticMarkup(React.createElement(RecentReleases, {
    installed: '2.0.1', disabled: false, onInstall: () => {},
    releases: [{ version: '2.1.1', tag: 'v2.1.1', name: 'v2.1.1', publishedAt: null, notes: '' }, { version: '2.0.1', tag: 'v2.0.1', name: 'v2.0.1', publishedAt: null, notes: '' }, { version: '2.0.0', tag: 'v2.0.0', name: 'v2.0.0', publishedAt: null, notes: '' }],
  }));
  const order = ['v2.1.1', 'Install', 'v2.0.1', 'Installed', 'v2.0.0', 'Roll back to this'].map((s) => html.indexOf(s));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), html);
});
