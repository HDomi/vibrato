import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'vibrato-perm-'));
process.env.CODEX_HOME = join(home, '.codex');
process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
process.env.VIBRATO_CONFIG_DIR = join(home, '.vibrato');

test('permissions: TCC and PhotoKit states', async () => {
  const { tccState, photosState } = await import('../server/permissions');
  assert.equal(tccState(2), 'granted');
  assert.equal(tccState(3), 'limited');
  assert.equal(tccState(0), 'denied');
  assert.equal(tccState(1), 'unknown');
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(photosState), ['notDetermined', 'restricted', 'denied', 'granted', 'limited', 'unknown']);
});

test('permissions: Codex config and execpolicy rules', async () => {
  const { parseCodexConfig, parseCodexRules } = await import('../server/permissions');
  const cfg = parseCodexConfig([
    'model = "gpt-5"',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    '[projects."/Users/me/a \\"b\\""]',
    'trust_level = "trusted"',
    "[projects.'/Users/me/c']",
    'trust_level = "untrusted"',
    '[profiles.x]',
    'approval_policy = "never"',
  ].join('\n'));
  assert.equal(cfg.approvalPolicy, 'on-request');
  assert.equal(cfg.sandboxMode, 'workspace-write');
  assert.deepEqual(cfg.trusted, [{ path: '/Users/me/a "b"', level: 'trusted' }, { path: '/Users/me/c', level: 'untrusted' }]);

  const rules = parseCodexRules('# comment\nprefix_rule(pattern=["git", "push"], decision="allow")\n\nprefix_rule(pattern=["rm"], decision="forbidden")\n', '/r/default.rules');
  assert.deepEqual(rules.map((r) => [r.line, r.pattern, r.decision]), [[2, ['git', 'push'], 'allow'], [4, ['rm'], 'forbidden']]);
});

test('permissions: Claude rules are read and removed without touching the rest of the file', async () => {
  const { claudeRulesOf, permissionsSnapshot, removeClaudeRule, removeCodexRule } = await import('../server/permissions');
  assert.equal(claudeRulesOf({ model: 'x' }), null);
  assert.equal(claudeRulesOf({ permissions: { allow: [] } }), null);

  mkdirSync(join(home, '.claude'), { recursive: true });
  const file = join(home, '.claude', 'settings.json');
  writeFileSync(file, JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls:*)', 'Read'], deny: ['Bash(rm:*)'], defaultMode: 'acceptEdits' } }));
  mkdirSync(join(home, '.codex', 'rules'), { recursive: true });
  const rulesFile = join(home, '.codex', 'rules', 'default.rules');
  writeFileSync(rulesFile, 'prefix_rule(pattern=["ls"], decision="allow")\nprefix_rule(pattern=["git", "status"], decision="allow")\n');

  const snap = await permissionsSnapshot();
  const f = snap.claude.find((x) => x.file === file);
  assert.ok(f);
  assert.deepEqual([f.scope, f.allow, f.deny, f.defaultMode], ['user', ['Bash(ls:*)', 'Read'], ['Bash(rm:*)'], 'acceptEdits']);
  assert.equal(snap.codex?.rules.length, 2);

  await removeClaudeRule(file, 'allow', 'Read');
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after, { model: 'opus', permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'], defaultMode: 'acceptEdits' } });
  await assert.rejects(removeClaudeRule(join(home, 'other.json'), 'allow', 'Read'), /Not a known Claude settings file/);

  await removeCodexRule(rulesFile, 'prefix_rule(pattern=["ls"], decision="allow")');
  assert.equal(readFileSync(rulesFile, 'utf8'), 'prefix_rule(pattern=["git", "status"], decision="allow")\n');
  await assert.rejects(removeCodexRule(join(home, 'x.rules'), 'a'), /Not a Codex rules file/);
});

test('permissions: reset only takes known TCC services', async () => {
  const { resetPermission } = await import('../server/permissions');
  await assert.rejects(resetPermission('All; rm -rf /'), /Unknown service/);
  await assert.rejects(resetPermission('Calendar'), /Unknown service/);
});
