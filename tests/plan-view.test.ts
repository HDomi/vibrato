import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, noteLine } from '../web/src/lib/planView';
import { reduceEvent, type ChatItem, type ChatSession } from '../web/src/lib/chatStore';

const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, text, attachments: [] });
const say = (id: string, text: string): ChatItem => ({ kind: 'assistant', id, text, thinking: '', parent: null, streaming: false });
const tool = (id: string, name: string, input: unknown, extra: Partial<Extract<ChatItem, { kind: 'tool' }>> = {}): ChatItem =>
  ({ kind: 'tool', id, name, input, output: '', isError: false, parent: null, elapsed: 0, done: true, ...extra });
const todos = (id: string, list: [string, 'pending' | 'in_progress' | 'completed'][]): ChatItem =>
  tool(id, 'TodoWrite', { todos: list.map(([content, status]) => ({ content, status, activeForm: `${content}…` })) });

test('work is filed under the step in progress when it happened', () => {
  const [turn] = buildPlan([
    user('u1', 'Fix the login bug'),
    say('a1', 'Looking around first.'),
    todos('t1', [['Find the cause', 'in_progress'], ['Patch it', 'pending']]),
    tool('b1', 'Bash', { command: 'rg login' }),
    tool('r1', 'Read', { file_path: '/p/auth.ts' }),
    say('a2', 'The token check uses <= instead of <. More text here.'),
    todos('t2', [['Find the cause', 'completed'], ['Patch it', 'in_progress']]),
    tool('e1', 'Edit', { file_path: '/p/auth.ts' }),
    tool('e2', 'Edit', { file_path: '/p/auth.ts' }),
    tool('b2', 'Bash', { command: 'npm test' }, { isError: true, elapsed: 12 }),
    todos('t3', [['Find the cause', 'completed'], ['Patch it', 'completed']]),
    say('a3', 'Done: the expiry check is fixed.'),
    { kind: 'result', id: 'res', ok: true, text: '', costUsd: 0.1, numTurns: 3, durationMs: 9000 },
  ]);
  assert.equal(turn.user?.id, 'u1');
  assert.equal(turn.hasPlan, true);
  assert.deepEqual(turn.before.items.map((i) => i.id), ['a1']);
  assert.deepEqual(turn.steps.map((s) => [s.content, s.status]), [['Find the cause', 'completed'], ['Patch it', 'completed']]);
  const [find, patch] = turn.steps;
  assert.deepEqual(find.items.map((i) => i.id), ['b1', 'r1', 'a2']);
  assert.equal(find.stats.commands, 1);
  assert.equal(find.stats.reads, 1);
  assert.equal(noteLine(find.note), 'The token check uses <= instead of <.');
  assert.deepEqual(patch.items.map((i) => i.id), ['e1', 'e2', 'b2']);
  assert.deepEqual(patch.stats.files, ['/p/auth.ts']);
  assert.equal(patch.stats.failed, 1);
  assert.equal(patch.stats.toolSeconds, 12);
  assert.deepEqual(turn.after.items.map((i) => i.id), ['a3']);
  assert.equal(turn.result?.id, 'res');
});

test('a turn without a checklist keeps everything in one group; subagent activity stays under its tool', () => {
  const turns = buildPlan([
    user('u1', 'hi'),
    tool('task', 'Task', { description: 'explore' }),
    { ...tool('inner', 'Bash', { command: 'ls' }), parent: 'task' } as ChatItem,
    say('a1', 'Hello.'),
    user('u2', 'next'),
    say('a2', 'Sure.'),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].hasPlan, false);
  assert.deepEqual(turns[0].before.items.map((i) => i.id), ['task', 'a1']);
  assert.equal(turns[0].before.stats.subagents, 1);
  assert.equal(turns[0].before.stats.commands, 0);
  assert.deepEqual(turns[1].before.items.map((i) => i.id), ['a2']);
});

test('pending approvals are surfaced on the turn', () => {
  const [turn] = buildPlan([
    user('u1', 'deploy'),
    { kind: 'approval', id: 'ap', toolName: 'Bash', input: {}, canAlwaysAllow: false, decision: null },
    { kind: 'approval', id: 'ap2', toolName: 'Bash', input: {}, canAlwaysAllow: false, decision: 'allow' },
  ]);
  assert.deepEqual(turn.pending.map((p) => p.id), ['ap']);
});

test('Codex plan updates land in the timeline once per change', () => {
  let s: ChatSession = { id: 's', agent: 'codex', cwd: '/p', status: 'running', items: [user('u1', 'go')], totalCostUsd: 0, lastSeq: 0 } as ChatSession;
  const plan = [{ content: 'Step one', status: 'in_progress' as const }];
  s = reduceEvent(s, { kind: 'todos', items: plan }, 1);
  s = reduceEvent(s, { kind: 'todos', items: plan }, 2);
  s = reduceEvent(s, { kind: 'todos', items: [{ content: 'Step one', status: 'completed' as const }] }, 3);
  const recorded = s.items.filter((i) => i.kind === 'tool' && i.name === 'TodoWrite');
  assert.equal(recorded.length, 2);
  assert.deepEqual(buildPlan(s.items)[0].steps.map((x) => x.status), ['completed']);
});
