import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { AGENT_HELPERS, cookieMatchesHost, diffBitmaps, handPath, pageHooks, playwrightScript, RELAY } from '../electron/browserScripts.cts';

test('cookie domains match their host and subdomains only', () => {
  assert.equal(cookieMatchesHost('.example.com', 'app.example.com'), true);
  assert.equal(cookieMatchesHost('example.com', 'example.com'), true);
  assert.equal(cookieMatchesHost('localhost', 'localhost'), true);
  assert.equal(cookieMatchesHost('.example.com', 'badexample.com'), false);
  assert.equal(cookieMatchesHost('app.example.com', 'example.com'), false);
  assert.equal(cookieMatchesHost('', 'example.com'), false);
});

test('injected scripts are valid JavaScript', () => {
  for (const src of [pageHooks(), pageHooks([{ id: 1, url: '/api/users', status: 500, body: '{"error":"x"}' }, { id: 2, url: 'users/\\d+$', regex: true, status: 404, body: '' }]), RELAY]) assert.doesNotThrow(() => new vm.Script(src));
  // Agent helpers run inside an async function body (callAsyncJavaScript).
  assert.doesNotThrow(() => new vm.Script(`(async () => { ${AGENT_HELPERS}\nreturn 1; })`));
});

test('hand path starts near the origin, overshoots slightly and ends on the target', () => {
  const { points, ms } = handPath({ x: 0, y: 0 }, { x: 300, y: 200 }, 42);
  assert.ok(ms >= 90 && ms <= 320);
  assert.deepEqual(points.at(-1), [300, 200]);
  const maxX = Math.max(...points.map((p) => p[0]));
  assert.ok(maxX > 300 && maxX < 320, `overshoot ${maxX}`);
  assert.deepEqual(handPath({ x: 5, y: 5 }, { x: 5.5, y: 5 }, 1), { points: [[5.5, 5]], ms: 0 });
});

test('bitmap diff counts changed pixels', () => {
  const a = new Uint8Array([0, 0, 0, 255, 10, 10, 10, 255]);
  const b = new Uint8Array([0, 0, 0, 255, 200, 10, 10, 255]);
  const r = diffBitmaps(a, b);
  assert.equal(r.total, 2);
  assert.equal(r.changed, 1);
  assert.deepEqual([...r.diff.slice(4, 8)], [40, 40, 255, 255]);
});

test('playwright export wraps the steps in a test', () => {
  const src = playwrightScript('t', ['await page.goto("http://x");']);
  assert.match(src, /import \{ test, expect \} from '@playwright\/test'/);
  assert.match(src, /  await page\.goto\("http:\/\/x"\);/);
});
