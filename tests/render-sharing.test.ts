import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, sharePlan } from '../web/src/lib/planView';
import { itemsFromHistory, reduceEvent, type ChatItem, type ChatSession } from '../web/src/lib/chatStore';

const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, text, attachments: [] });
const say = (id: string, text: string): ChatItem => ({ kind: 'assistant', id, text, thinking: '', parent: null, streaming: false });

const session = (items: ChatItem[]): ChatSession => ({
  id: 's1', agent: 'claude', cwd: '/p', permissionMode: 'default', status: 'running', items, totalCostUsd: 0, lastSeq: 0,
});

test('events that do not touch the items keep the same items array', () => {
  const s = session([user('u1', 'hi'), say('a1', 'hello')]);
  const tasked = reduceEvent(s, { kind: 'task', task: { id: 't1', status: 'running', description: 'x', startedAt: 1 } } as never, 1);
  assert.notEqual(tasked, s);
  assert.equal(tasked.items, s.items);
  const status = reduceEvent(tasked, { kind: 'status', status: 'running' } as never, 2);
  assert.equal(status.items, s.items);
  assert.equal(reduceEvent(status, { kind: 'log', level: 'info', text: 'stderr line' } as never, 0), status);
  const grown = reduceEvent(status, { kind: 'text.delta', text: '!', parent: null } as never, 3);
  assert.notEqual(grown.items, s.items);
});

test('unchanged turns keep their objects between plan builds', () => {
  const a = [user('u1', 'first'), say('a1', 'done one'), user('u2', 'second'), say('a2', 'working')];
  const first = buildPlan(a);
  const b = [...a.slice(0, 3), say('a2', 'working on it')];
  const second = sharePlan(a, first, b, buildPlan(b));
  assert.equal(second[0], first[0]);
  assert.notEqual(second[1], first[1]);
  assert.equal(second[1].answer !== null || second[1].texts.length > 0, true);
  // A change in an early turn invalidates it and everything after it.
  const c = [user('u1', 'first'), say('a1', 'done one, edited'), ...b.slice(2)];
  const third = sharePlan(b, second, c, buildPlan(c));
  assert.notEqual(third[0], second[0]);
  assert.notEqual(third[1], second[1]);
});

test('history tool results attach to their calls', () => {
  const items = itemsFromHistory([
    { type: 'assistant', uuid: 'm1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 'x2', name: 'Read', input: {} }] } },
    { type: 'user', uuid: 'm2', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x2', content: 'file body' }, { type: 'tool_result', tool_use_id: 'x1', content: 'a\nb', is_error: true }] } },
  ]);
  const byId = new Map(items.map((it) => [it.id, it]));
  assert.equal((byId.get('x1') as Extract<ChatItem, { kind: 'tool' }>).output, 'a\nb');
  assert.equal((byId.get('x1') as Extract<ChatItem, { kind: 'tool' }>).isError, true);
  assert.equal((byId.get('x2') as Extract<ChatItem, { kind: 'tool' }>).output, 'file body');
});
