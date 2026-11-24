import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapePath } from '../web/src/components/DrawDialog.tsx';

/** A 2D context that records the path calls. */
function recorder() {
  const calls: string[] = [];
  const rec = (name: string) => (...a: number[]) => { calls.push(`${name}(${a.map((n) => Math.round(n)).join(',')})`); };
  const ctx = { beginPath: rec('beginPath'), rect: rec('rect'), moveTo: rec('moveTo'), lineTo: rec('lineTo'), arcTo: rec('arcTo'), closePath: rec('closePath'), ellipse: rec('ellipse') };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

test('a rectangle spans the drag, whichever way it went', () => {
  const { ctx, calls } = recorder();
  shapePath(ctx, 'rect', 100, 80, 20, 10);
  assert.deepEqual(calls, ['beginPath()', 'rect(20,10,80,70)']);
});

test('a rounded rectangle keeps its corners within a quarter of each side', () => {
  const { ctx, calls } = recorder();
  shapePath(ctx, 'roundRect', 0, 0, 40, 200);
  assert.equal(calls[1], 'moveTo(10,0)');
  assert.equal(calls.filter((c) => c.startsWith('arcTo')).length, 4);
  assert.ok(calls.every((c) => !c.startsWith('arcTo') || c.endsWith(',10)')));
});

test('a circle is the ellipse inside the drag box; a triangle points up', () => {
  const a = recorder();
  shapePath(a.ctx, 'circle', 0, 0, 100, 50);
  assert.equal(a.calls[1], 'ellipse(50,25,50,25,0,0,6)');
  const b = recorder();
  shapePath(b.ctx, 'triangle', 0, 0, 100, 60);
  assert.deepEqual(b.calls.slice(1), ['moveTo(50,0)', 'lineTo(100,60)', 'lineTo(0,60)', 'closePath()']);
});
