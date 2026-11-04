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

test('sessions get the plan instruction unless it is turned off, then the custom prompt', async () => {
  const { sessionInstructions, PLAN_INSTRUCTIONS } = await import('../server/planInstructions');
  assert.equal(sessionInstructions(null), PLAN_INSTRUCTIONS);
  assert.equal(sessionInstructions({ customPrompt: '  Answer in Korean.  ' }), `${PLAN_INSTRUCTIONS}\n\nAnswer in Korean.`);
  assert.equal(sessionInstructions({ alwaysPlan: false, customPrompt: 'Answer in Korean.' }), 'Answer in Korean.');
  assert.equal(sessionInstructions({ alwaysPlan: false }), undefined);
});

test('TaskCreate / TaskUpdate plans: numbered tasks, carried across turns, deletions dropped', () => {
  const created = (id: string, n: number, subject: string) => tool(id, 'TaskCreate', { subject, description: '', activeForm: `${subject}…` }, { output: `Task #${n} created successfully: ${subject}` });
  const upd = (id: string, taskId: string, status: string) => tool(id, 'TaskUpdate', { taskId, status }, { output: `Updated task #${taskId} status` });
  const turns = buildPlan([
    user('u1', 'build it'),
    tool('ts', 'ToolSearch', { query: 'select:TaskCreate,TaskUpdate' }),
    created('c1', 1, 'Write files'),
    created('c2', 2, 'Run tests'),
    created('c3', 3, 'Spare step'),
    upd('s1', '1', 'in_progress'),
    tool('w1', 'Write', { file_path: '/p/a.js' }),
    upd('s2', '1', 'completed'),
    upd('s3', '2', 'in_progress'),
    upd('s4', '3', 'deleted'),
    tool('b1', 'Bash', { command: 'npm test' }),
    user('u2', 'also add a README'),
    tool('w2', 'Write', { file_path: '/p/README.md' }),
    upd('s5', '2', 'completed'),
  ]);
  assert.deepEqual(turns[0].steps.map((s) => [s.content, s.status]), [['Write files', 'completed'], ['Run tests', 'in_progress']]);
  assert.deepEqual(turns[0].steps[0].items.map((i) => i.id), ['w1']);
  assert.deepEqual(turns[0].steps[1].items.map((i) => i.id), ['b1']);
  assert.deepEqual(turns[0].before.items, []);
  // The task still in progress continues in the next turn and takes its work.
  assert.deepEqual(turns[1].steps.map((s) => [s.content, s.status]), [['Run tests', 'completed']]);
  assert.deepEqual(turns[1].steps[0].items.map((i) => i.id), ['w2']);
});

test('a plan written in the reply becomes the checklist, "✓ n." lines clear its steps, "Result:" is the answer', () => {
  const plan = '진행 계획\n1. 1부터 55까지 더하기\n2. 5로 나누기\n3. 나머지에 10 곱하기';
  const live = buildPlan([user('u1', '계획 세워봐'), say('a1', `좋아.\n\n${plan}`), say('a2', '✓ 1. 55×56÷2 = 1540')])[0];
  assert.equal(live.hasPlan, true);
  assert.deepEqual(live.steps.map((s) => [s.content, s.status, s.note]), [
    ['1부터 55까지 더하기', 'completed', '55×56÷2 = 1540'], ['5로 나누기', 'pending', null], ['나머지에 10 곱하기', 'pending', null]]);

  // The same, written the way the previous reply did: bold headings and "1. ✓" marks in one message.
  const done = buildPlan([user('u1', 'x'), say('a1', '**계획**\n1. 더하기\n2. 나누기\n3. 곱하기\n\n**실행**\n1. ✓ 합 = **1540**\n2. ✓ 몫 308, 나머지 0\n3. ✓ 0 × 10 = 0\n\n**결과: 0.** 몫이었다면 3080.')])[0];
  assert.deepEqual(done.steps.map((s) => [s.content, s.status, s.note]), [['더하기', 'completed', '합 = 1540'], ['나누기', 'completed', '몫 308, 나머지 0'], ['곱하기', 'completed', '0 × 10 = 0']]);
  assert.equal(done.answer, '0. 몫이었다면 3080.');

  // No plan, no marks: the answer is the gist of the last message.
  const plain = buildPlan([user('u1', 'hi'), say('a1', 'Hello there, nice to meet you. More.')])[0];
  assert.equal(plain.hasPlan, false);
  assert.equal(plain.answer, 'Hello there, nice to meet you.');
});

test('done marks add the account to steps from the task tools', () => {
  const [turn] = buildPlan([
    user('u1', 'go'),
    tool('c1', 'TaskCreate', { subject: 'First' }, { output: 'Task #1 created successfully: First' }),
    tool('s1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    say('a1', '✓ 1. Did it with a one-liner'),
  ]);
  assert.equal(turn.steps[0].note, 'Did it with a one-liner');
});
