import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.VIBRATO_CONFIG_DIR = join(mkdtempSync(join(tmpdir(), 'vibrato-wall-')), '.vibrato');

test('wallpaper: gradient stops are sorted, clamped and pinned at both ends', async () => {
  const { cleanGradient, DEFAULT_GRADIENT } = await import('../server/wallpaper');
  const g = cleanGradient({ angle: -90, stops: [{ color: '#FF0000', pos: 40.04 }, { color: '#00ff00', pos: 120 }, { color: '#0000ff', pos: 5 }] }, DEFAULT_GRADIENT);
  assert.deepEqual(g, { angle: 270, stops: [{ color: '#0000ff', pos: 0 }, { color: '#ff0000', pos: 40 }, { color: '#00ff00', pos: 100 }] });
  assert.deepEqual(cleanGradient({ angle: 10, stops: [{ color: '#fff', pos: 0 }, { color: '#000000', pos: 100 }] }, DEFAULT_GRADIENT).stops, DEFAULT_GRADIENT.stops);
  assert.deepEqual(cleanGradient('nope', DEFAULT_GRADIENT), DEFAULT_GRADIENT);
  const many = Array.from({ length: 13 }, (_, i) => ({ color: '#123456', pos: i * 8 }));
  assert.deepEqual(cleanGradient({ angle: 0, stops: many }, DEFAULT_GRADIENT).stops, DEFAULT_GRADIENT.stops);
});

test('wallpaper: gradient kind is stored and survives a reload', async () => {
  const { loadWallpaper, updateWallpaper } = await import('../server/wallpaper');
  const before = await loadWallpaper();
  assert.equal(before.kind, 'color');
  assert.equal(before.gradient.stops.length, 2);
  const stops = [{ color: '#112233', pos: 0 }, { color: '#445566', pos: 50 }, { color: '#778899', pos: 100 }];
  await updateWallpaper({ kind: 'gradient', gradient: { angle: 45, stops } });
  const after = await loadWallpaper();
  assert.equal(after.kind, 'gradient');
  assert.deepEqual(after.gradient, { angle: 45, stops });
  // A patch without a gradient keeps the stored one.
  await updateWallpaper({ dim: 20 });
  assert.deepEqual((await loadWallpaper()).gradient, { angle: 45, stops });
});

test('wallpaper: space kind is stored without an image', async () => {
  const { loadWallpaper, updateWallpaper } = await import('../server/wallpaper');
  await updateWallpaper({ kind: 'space' });
  const w = await loadWallpaper();
  assert.equal(w.kind, 'space');
  assert.equal(w.hasImage, false);
  // Unknown kinds keep the stored one.
  await updateWallpaper({ kind: 'galaxy' as never });
  assert.equal((await loadWallpaper()).kind, 'space');
});
