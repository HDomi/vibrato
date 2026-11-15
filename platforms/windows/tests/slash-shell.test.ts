import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { claudeShellLine } from '../web/src/lib/slashCommands';

test('slash: the terminal line passes the command as one quoted PowerShell argument', () => {
  assert.equal(claudeShellLine('/plugin'), `claude '/plugin'`);
  assert.equal(claudeShellLine(`/plugin it's`), `claude '/plugin it''s'`);
});

test('slash: PowerShell reads the quoted argument back unchanged and runs nothing in it', { skip: process.platform !== 'win32' }, () => {
  const evil = "/plugin it's $(New-Item x) `id` $env:PATH; exit 3";
  const line = claudeShellLine(evil).replace(/^claude /, 'Write-Output ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', line]).toString().trim();
  assert.equal(out, evil);
});
