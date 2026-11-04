import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { claudeShellLine, routeSlash, withAppCommands } from '../web/src/lib/slashCommands';

test('slash: built-in dialogs the SDK cannot show are routed in the app', () => {
  assert.deepEqual(routeSlash('/mcp'), { kind: 'mcp' });
  assert.deepEqual(routeSlash('  /mcp  '), { kind: 'mcp' });
  assert.deepEqual(routeSlash('/model'), { kind: 'model' });
  assert.deepEqual(routeSlash('/model sonnet'), { kind: 'model', model: 'sonnet' });
  assert.deepEqual(routeSlash('/effort'), { kind: 'effort' });
  assert.deepEqual(routeSlash('/plugin'), { kind: 'terminal', command: '/plugin' });
  assert.deepEqual(routeSlash('/Hooks'), { kind: 'terminal', command: '/hooks' });
  assert.deepEqual(routeSlash('/config'), { kind: 'terminal', command: '/config' });
});

test('slash: commands the SDK runs, and plain text, are sent as typed', () => {
  assert.equal(routeSlash('/effort high'), null);
  assert.equal(routeSlash('/config autoCompact=false'), null);
  assert.equal(routeSlash('/mcp enable notion'), null);
  assert.equal(routeSlash('/compact'), null);
  assert.equal(routeSlash('/code-review high'), null);
  assert.equal(routeSlash('/mcp\nwhy is it failing?'), null);
  assert.equal(routeSlash('mcp'), null);
  assert.equal(routeSlash('/usr/bin is missing'), null);
});

test('slash: the terminal line passes the command as one quoted argument', () => {
  assert.equal(claudeShellLine('/plugin'), `claude '/plugin'`);
  const evil = `/plugin it's $(touch /tmp/x) \`id\``;
  const out = execFileSync('/bin/sh', ['-c', claudeShellLine(evil).replace(/^claude /, 'printf %s ')]).toString();
  assert.equal(out, evil);
});

test('slash: terminal-only commands join the "/" list once', () => {
  const list = withAppCommands(['/mcp', '/plugin-authoring', '/status']);
  assert.ok(list.includes('/plugin'));
  assert.equal(list.filter((c) => c === '/status').length, 1);
  assert.deepEqual(list.slice(0, 3), ['/mcp', '/plugin-authoring', '/status']);
});
