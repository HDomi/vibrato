import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSums } from '../server/releaseUpdate';

test('shasum output is parsed by file name', () => {
  const a = 'a'.repeat(64); const b = 'B'.repeat(64);
  const sums = parseSums(`${a}  Vibrato-1.0.12-arm64.dmg\n${b} *Vibrato-1.0.12-arm64-mac.zip\nnot a line\n`);
  assert.equal(sums.get('Vibrato-1.0.12-arm64.dmg'), a);
  assert.equal(sums.get('Vibrato-1.0.12-arm64-mac.zip'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

test('the Atom feed is parsed: tag from the link, notes flattened from escaped HTML', async () => {
  const { parseAtom } = await import('../server/releaseUpdate');
  const xml = `<feed><entry><updated>2026-10-29T04:23:53Z</updated><link rel="alternate" type="text/html" href="https://github.com/HDomi/vibrato/releases/tag/v3.3.1"/><title>Vibrato v3.3.1</title><content type="html">&lt;p&gt;misc: 재릴리스 (v3.3.1)&lt;/p&gt;&lt;ul&gt;&lt;li&gt;a &amp;amp; b&lt;/li&gt;&lt;/ul&gt;</content></entry><entry><title>no link</title></entry></feed>`;
  assert.deepEqual(parseAtom(xml), [{ tag: 'v3.3.1', name: 'Vibrato v3.3.1', publishedAt: '2026-10-29T04:23:53Z', notes: 'misc: 재릴리스 (v3.3.1)\na & b' }]);
});
