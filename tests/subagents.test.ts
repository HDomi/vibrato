import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ClaudeSession } from '../server/agents/claude.ts';
import { CodexSession, codexSubagentTask } from '../server/agents/codex.ts';
import { parseAgentResult, subagentsIn, tasksFromHistory } from '../web/src/lib/subagents.ts';
import { reduceEvent, type ChatItem, type ChatSession } from '../web/src/lib/chatStore.ts';
import { buildPlan } from '../web/src/lib/planView.ts';
import type { AgentEvent, TaskInfo } from '../server/agents/types.ts';

const tool = (id: string, name: string, input: unknown, extra: Partial<Extract<ChatItem, { kind: 'tool' }>> = {}): ChatItem =>
  ({ kind: 'tool', id, name, input, output: '', isError: false, parent: null, elapsed: 0, done: true, ...extra });

function claude() {
  const s = new ClaudeSession({ cwd: '/tmp', claudePath: '/bin/false' });
  const events: AgentEvent[] = [];
  s.onEvent((e) => events.push(e));
  return { s: s as unknown as { handleTask: (m: unknown) => void; q: unknown; backgroundTask: (id: string) => Promise<void>; stopTask: (id: string) => Promise<void> }, events, tasks: () => events.filter((e) => e.kind === 'task').map((e) => (e as { task: TaskInfo }).task) };
}
const sys = (subtype: string, extra: Record<string, unknown>) => ({ type: 'system', subtype, session_id: 's', uuid: 'u', ...extra });

test('SA-1 started, progress with a summary, then the notification update one task in order', () => {
  const { s, tasks } = claude();
  s.handleTask(sys('task_started', { task_id: 'a1', task_type: 'local_agent', subagent_type: 'Explore', description: '토큰 검사 위치 찾기', tool_use_id: 'call-1' }));
  s.handleTask(sys('task_progress', { task_id: 'a1', description: '토큰 검사 위치 찾기', usage: { total_tokens: 1800, tool_uses: 3, duration_ms: 9000 }, last_tool_name: 'Grep', summary: 'auth 미들웨어 확인 중' }));
  s.handleTask(sys('task_notification', { task_id: 'a1', status: 'completed', output_file: '', summary: '찾음', usage: { total_tokens: 2500, tool_uses: 5, duration_ms: 12000 } }));
  const [a, b, c] = tasks();
  assert.equal(a.status, 'running');
  assert.equal(a.toolUseId, 'call-1');
  assert.deepEqual([b.summary, b.usage?.totalTokens, b.lastTool], ['auth 미들웨어 확인 중', 1800, 'Grep']);
  assert.equal(c.status, 'completed');
  assert.ok(c.endedAt);
});

test('SA-2 a background task missing from background_tasks_changed is completed', () => {
  const { s, tasks } = claude();
  s.handleTask(sys('task_started', { task_id: 'b1', task_type: 'local_agent', description: 'x', is_backgrounded: true }));
  s.handleTask(sys('background_tasks_changed', { tasks: [] }));
  assert.equal(tasks().pop()?.status, 'completed');
});

test('SA-3/SA-4/SA-5 stop and stop-waiting reach the CLI; an unknown tool call is an error', async () => {
  const { s } = claude();
  const calls: string[] = [];
  s.q = { stopTask: async (id: string) => { calls.push(`stop ${id}`); }, backgroundTasks: async (id: string) => { calls.push(`bg ${id}`); return id === 'call-1'; } };
  await s.stopTask('a1');
  await s.backgroundTask('call-1');
  await assert.rejects(s.backgroundTask('nope'), /not running in the foreground/);
  assert.deepEqual(calls, ['stop a1', 'bg call-1', 'bg nope']);
});

test('SA-6 Codex sessions cannot move a task to the background (the button is hidden)', () => {
  assert.equal((CodexSession.prototype as unknown as { backgroundTask?: unknown }).backgroundTask, undefined);
});

test('SA-7 progress summaries are asked for', () => {
  assert.match(fs.readFileSync(new URL('../server/agents/claude.ts', import.meta.url), 'utf8'), /agentProgressSummaries: true/);
});

test('subagent results: agent id and usage in either format', () => {
  assert.deepEqual(parseAgentResult('찾았습니다.\nagentId: a4adc1e6bcd0db8fa (for resuming)\n<usage>total_tokens: 97151\ntool_uses: 22\nduration_ms: 87291</usage>'), { agentId: 'a4adc1e6bcd0db8fa', totalTokens: 97151, toolUses: 22, durationMs: 87291 });
  assert.deepEqual(parseAgentResult('<usage><subagent_tokens>500</subagent_tokens><tool_uses>2</tool_uses></usage>'), { totalTokens: 500, toolUses: 2 });
  assert.deepEqual(parseAgentResult(null), {});
});

test('SA-9/SA-10/SA-11 a step lists its subagents: live state from the task, finished ones from their result', () => {
  const items: ChatItem[] = [
    tool('c1', 'Agent', { subagent_type: 'Explore', description: '위치 찾기' }, { done: false, output: null }),
    tool('c2', 'Agent', { subagent_type: 'general-purpose', description: '원인 정리' }, { output: '테스트가 시간대를 안 맞춤\nagentId: abc12345\n<usage>total_tokens: 3200\ntool_uses: 4</usage>' }),
    tool('k1', 'Read', { file_path: '/a' }, { parent: 'c1' }),
  ];
  const tasks: Record<string, TaskInfo> = { t1: { id: 't1', type: 'local_agent', subagentType: 'Explore', description: '위치 찾기', toolUseId: 'c1', status: 'running', background: true, startedAt: 1, summary: 'auth 확인 중', usage: { totalTokens: 900, toolUses: 2, durationMs: 1 } } };
  const list = subagentsIn(items, tasks);
  assert.deepEqual(list.map((x) => [x.kind, x.status, x.taskId, x.background, x.summary, x.totalTokens]), [
    ['Explore', 'running', 't1', true, 'auth 확인 중', 900],
    ['general-purpose', 'completed', undefined, false, undefined, 3200],
  ]);
  assert.equal(list[1].agentId, 'abc12345');
  assert.equal(list[1].result, '테스트가 시간대를 안 맞춤');
});

test('SA-13 history rebuilds finished subagents as tasks, and a CLI restart keeps them', () => {
  const items: ChatItem[] = [tool('c2', 'Agent', { subagent_type: 'Explore', description: '위치 찾기' }, { output: '끝\nagentId: abc12345\n<usage>total_tokens: 3200\ntool_uses: 4\nduration_ms: 5000</usage>' })];
  const tasks = tasksFromHistory(items);
  assert.deepEqual(Object.values(tasks).map((x) => [x.id, x.subagentType, x.status, x.usage?.totalTokens, x.restored]), [['abc12345', 'Explore', 'completed', 3200, true]]);
  let s = { id: 'x', agent: 'claude', cwd: '/', permissionMode: 'default', items, lastSeq: 0, tasks } as unknown as ChatSession;
  s = reduceEvent(s, { kind: 'task', task: { id: 'live', type: 'local_agent', description: 'y', status: 'running', startedAt: 1 } } as never, 1);
  s = reduceEvent(s, { kind: 'task.reset' } as never, 2);
  assert.deepEqual(Object.keys(s.tasks ?? {}), ['abc12345']);
});

test('SA-14 a step counts subagent tokens; subagent tool calls stay out of its role evidence', () => {
  const [t] = buildPlan([{ kind: 'user', id: 'u', text: 'go', attachments: [] }, tool('p', 'mcp__vibrato__plan_set', { steps: [{ id: 's1', title: '조사' }] }),
    tool('c1', 'Agent', { subagent_type: 'Explore', description: 'x' }, { output: 'ok\n<usage>total_tokens: 1200</usage>' }), tool('e', 'Edit', { file_path: '/a' }, { parent: 'c1' })]);
  assert.deepEqual(t.steps[0].evidence?.roles, ['A']);
  assert.equal(subagentsIn(t.steps[0].items, undefined)[0].totalTokens, 1200);
});

test('SA-15/SA-16 a Codex collab agent call becomes a running then completed task; its answer is kept to 20000 characters', () => {
  const s = new CodexSession({ cwd: '/tmp', codexPath: '/bin/false' } as never);
  const events: AgentEvent[] = [];
  s.onEvent((e) => events.push(e));
  const any = s as unknown as { itemStarted: (i: unknown) => void; itemCompleted: (i: unknown) => void };
  const item = { id: 'it1', type: 'collabAgentToolCall', tool: 'spawn_agent', prompt: '테스트 실패 원인 찾기\n자세히', status: 'completed', contentItems: ['x'.repeat(10000)] };
  any.itemStarted(item);
  any.itemCompleted(item);
  const tasks = events.filter((e) => e.kind === 'task').map((e) => (e as { task: TaskInfo }).task);
  assert.deepEqual(tasks.map((x) => [x.id, x.status, x.subagentType, x.description]), [['it1', 'running', 'spawn_agent', '테스트 실패 원인 찾기'], ['it1', 'completed', 'spawn_agent', '테스트 실패 원인 찾기']]);
  assert.equal(tasks[1].startedAt, tasks[0].startedAt);
  const result = events.find((e) => e.kind === 'tool.result') as { content: string };
  assert.ok(result.content.length > 4000);
  assert.equal(codexSubagentTask({ id: 'z' }, 'failed', 1, 2).endedAt, 2);
});
