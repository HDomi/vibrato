import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeFlagSettings, codexConfigArgs, sanitizeExtensions } from '../server/agentExtensions';

test('agent extensions: sanitize keeps known agents and valid, unique names', () => {
  assert.deepEqual(sanitizeExtensions(null), {});
  assert.deepEqual(sanitizeExtensions({
    claude: { skills: ['pdf', 'sweet:sweet', 'pdf', 'bad name', 3], plugins: ['sweet@sweet', 'x"y'] },
    codex: { skills: ['imagegen'], plugins: ['sites@openai'] },
    other: { skills: ['a'] },
  }), {
    claude: { skills: ['pdf', 'sweet:sweet'], plugins: ['sweet@sweet'] },
    // Codex plugins cannot be turned off per session, so they are not kept.
    codex: { skills: ['imagegen'] },
  });
  assert.deepEqual(sanitizeExtensions({ claude: { skills: [], plugins: [] } }), {});
});

test('agent extensions: Claude flag settings and Codex -c overrides', () => {
  assert.equal(claudeFlagSettings(undefined), undefined);
  assert.equal(claudeFlagSettings({ skills: [], plugins: [] }), undefined);
  assert.deepEqual(claudeFlagSettings({ skills: ['pdf', 'sweet:sweet'], plugins: ['sweet@sweet'] }), {
    skillOverrides: { pdf: 'off', 'sweet:sweet': 'off' },
    enabledPlugins: { 'sweet@sweet': false },
  });
  assert.deepEqual(claudeFlagSettings({ plugins: ['a@b'] }), { enabledPlugins: { 'a@b': false } });
  assert.deepEqual(codexConfigArgs(undefined), []);
  assert.deepEqual(codexConfigArgs({ skills: ['imagegen', 'skill-creator'] }), ['-c', 'skills.config=[{name="imagegen",enabled=false},{name="skill-creator",enabled=false}]']);
});
