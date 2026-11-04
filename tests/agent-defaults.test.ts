import assert from 'node:assert/strict';
import test from 'node:test';
import { modesFor, parseAgentDefaults } from '../web/src/lib/agentDefaults';

test('agent defaults: saved values win, legacy last-used values seed them', () => {
  assert.deepEqual(parseAgentDefaults('claude', JSON.stringify({ model: 'opus', mode: 'plan' })), { model: 'opus', mode: 'plan' });
  assert.deepEqual(parseAgentDefaults('claude', null, { mode: 'acceptEdits', model: 'sonnet' }), { model: 'sonnet', mode: 'acceptEdits' });
  assert.deepEqual(parseAgentDefaults('claude', JSON.stringify({ model: null, mode: 'default' }), { mode: 'plan', model: 'x' }), { model: null, mode: 'default' }, 'a saved CLI default is not overridden by legacy');
  assert.deepEqual(parseAgentDefaults('claude', null), { model: null, mode: 'default' });
});

test('agent defaults: invalid or agent-unsupported values fall back', () => {
  assert.deepEqual(parseAgentDefaults('codex', JSON.stringify({ model: 'gpt-5', mode: 'auto' })), { model: 'gpt-5', mode: 'default' }, 'Codex has no auto mode');
  assert.deepEqual(parseAgentDefaults('claude', '{broken', { mode: 'weird', model: '  ' }), { model: null, mode: 'default' });
  assert.deepEqual(modesFor('codex'), ['default', 'acceptEdits', 'plan', 'bypassPermissions']);
});
