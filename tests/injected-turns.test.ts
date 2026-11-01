import assert from 'node:assert/strict';
import test from 'node:test';
import { injectedKind, injectedSummary, isInjected, itemsFromHistory, sessionTitle, type ChatItem } from '../web/src/lib/chatStore';

const TASK = '<task-notification>\n<task-id>b5mlp8dma</task-id>\n<summary>Monitor event: "items 10-13"</summary>\n<event>[Monitor expired after 25m]</event>\n</task-notification>';
const ORPHAN = '<task-notification>\n<task-id>bgduysrbq</task-id>\n<status>stopped</status>\n<summary>4 background shell command tasks didn\'t finish before the previous session ended.</summary>\n</task-notification>';

test('injected turns: classified by their leading tag', () => {
  assert.equal(injectedKind(TASK), 'task');
  assert.equal(injectedKind('  ' + ORPHAN), 'task');
  assert.equal(injectedKind('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'), 'command');
  assert.equal(injectedKind('<local-command-stdout>Set model to opus</local-command-stdout>'), 'command');
  assert.equal(injectedKind('<local-command-caveat>The command below was run directly</local-command-caveat>'), 'skip');
  // The user's own words, even when they start with a tag (pastes, IDE context).
  assert.equal(injectedKind('fix the bug'), null);
  assert.equal(injectedKind('<pasted_content id="a">x</pasted_content>'), null);
  assert.equal(injectedKind('<ide_selection>The user selected</ide_selection> why?'), null);

  assert.equal(injectedSummary('task', TASK), 'Monitor event: "items 10-13"');
  assert.equal(injectedSummary('command', '<command-name>/model</command-name>\n<command-args>opus</command-args>'), '/model opus');
  assert.equal(injectedSummary('command', '<local-command-stdout>Set model\nto opus</local-command-stdout>'), 'Set model to opus');
});

test('injected turns: replayed history keeps them out of the user\'s prompts', () => {
  const msg = (uuid: string, content: unknown) => ({ type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null });
  const items = itemsFromHistory([
    msg('1', 'first real prompt'),
    { type: 'assistant', uuid: '2', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, parent_tool_use_id: null },
    msg('3', TASK),
    msg('4', [{ type: 'text', text: ORPHAN }]),
    msg('5', '<local-command-caveat>bookkeeping</local-command-caveat>'),
    msg('6', '<command-name>/model</command-name>\n<command-args>opus</command-args>'),
  ]);
  const users = items.filter((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user');
  assert.deepEqual(users.map((u) => [u.id, u.injected ?? null]), [['1', null], ['3', 'task'], ['4', 'task'], ['6', 'command']]);
  assert.deepEqual(users.map(isInjected), [false, true, true, true]);
  assert.equal(sessionTitle([...items].reverse()), 'first real prompt');
});
