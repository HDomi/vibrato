import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { AGENT_HELPERS, cookieMatchesHost, PAGE_HOOKS, RELAY } from '../electron/browserScripts.cts';

test('cookie domains match their host and subdomains only', () => {
  assert.equal(cookieMatchesHost('.example.com', 'app.example.com'), true);
  assert.equal(cookieMatchesHost('example.com', 'example.com'), true);
  assert.equal(cookieMatchesHost('localhost', 'localhost'), true);
  assert.equal(cookieMatchesHost('.example.com', 'badexample.com'), false);
  assert.equal(cookieMatchesHost('app.example.com', 'example.com'), false);
  assert.equal(cookieMatchesHost('', 'example.com'), false);
});

test('injected scripts are valid JavaScript', () => {
  for (const src of [PAGE_HOOKS, RELAY]) assert.doesNotThrow(() => new vm.Script(src));
  // Agent helpers run inside an async function body (callAsyncJavaScript).
  assert.doesNotThrow(() => new vm.Script(`(async () => { ${AGENT_HELPERS}\nreturn 1; })`));
});
