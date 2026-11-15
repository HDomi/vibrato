import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { claudeShellLine } from '../web/src/lib/slashCommands';

test('slash: the terminal line passes the command as one quoted argument', () => {
  assert.equal(claudeShellLine('/plugin'), `claude '/plugin'`);
  const evil = `/plugin it's $(touch /tmp/x) \`id\``;
  const out = execFileSync('/bin/sh', ['-c', claudeShellLine(evil).replace(/^claude /, 'printf %s ')]).toString();
  assert.equal(out, evil);
});
