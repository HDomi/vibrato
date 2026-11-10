import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveTasks, reduceEvent, type ChatSession } from '../web/src/lib/chatStore';
import { layoutTaskTree, NODE_H, NODE_W, ROOT_ID, shortTokens, taskKind, visibleTasks } from '../web/src/lib/taskGraph';
import type { TaskInfo } from '../web/src/lib/agent';

const base: ChatSession = { id: 's', agent: 'claude', cwd: '/p', permissionMode: 'default', status: 'running', totalCostUsd: 0, lastSeq: 0, items: [] };
const task = (id: string, extra: Partial<TaskInfo> = {}): TaskInfo => ({ id, type: 'local_agent', subagentType: 'Explore', description: `work ${id}`, status: 'running', startedAt: 1, ...extra });

test('task events upsert by id, the chips list only running non-ambient tasks, and a closed process stops them', () => {
  let s = reduceEvent(base, { kind: 'task', task: task('a') }, 1);
  s = reduceEvent(s, { kind: 'task', task: task('b', { startedAt: 0 }) }, 2);
  s = reduceEvent(s, { kind: 'task', task: task('c', { ambient: true }) }, 3);
  s = reduceEvent(s, { kind: 'task', task: task('a', { status: 'completed', endedAt: 9 }) }, 4);
  assert.deepEqual(liveTasks(s).map((t) => t.id), ['b']);
  assert.equal(s.tasks!.a.status, 'completed');
  const closed = reduceEvent(s, { kind: 'status', status: 'closed' }, 5);
  assert.equal(closed.tasks!.b.status, 'stopped');
  assert.equal(closed.tasks!.a.status, 'completed', 'ended tasks keep their outcome');
  assert.deepEqual(liveTasks(closed), []);
  assert.equal(reduceEvent(s, { kind: 'task.reset' }, 6).tasks, undefined);
});

test('the relation graph runs left to right: tasks hang off the session, nest by parent, and a parent is centred beside its children', () => {
  const list = [task('p'), task('p1', { parentId: 'p', startedAt: 2 }), task('p2', { parentId: 'p', startedAt: 3 }), task('q', { startedAt: 4 }), task('orphan', { parentId: 'gone', startedAt: 5 })];
  const g = layoutTaskTree(list);
  const at = (id: string) => g.nodes.find((n) => n.id === id)!;
  assert.deepEqual(g.edges, [{ from: ROOT_ID, to: 'p' }, { from: 'p', to: 'p1' }, { from: 'p', to: 'p2' }, { from: ROOT_ID, to: 'q' }, { from: ROOT_ID, to: 'orphan' }]);
  assert.equal(at('p1').depth, 2);
  assert.equal(at('orphan').depth, 1, 'an unknown parent falls back to the session root');
  assert.equal(at('p').y, (at('p1').y + at('p2').y) / 2, 'parent centred vertically beside its children');
  assert.ok(at('p1').x > at('p').x && at('p').x > at(ROOT_ID).x, 'depth grows to the right');
  assert.equal(at('p1').x, at('p2').x, 'siblings share a column');
  assert.ok(at('p1').y < at('p2').y && at('p2').y < at('q').y, 'leaves stack downward in start order');
  assert.equal(at(ROOT_ID).x, 0);
  assert.ok(g.width >= 3 * NODE_W && g.width < 4 * NODE_W, 'three columns wide');
  assert.ok(g.height >= 4 * NODE_H, 'four leaf rows tall');
  // A self-parented task must not recurse forever.
  assert.equal(layoutTaskTree([task('loop', { parentId: 'loop' })]).nodes.length, 2);
  assert.deepEqual(layoutTaskTree([]).nodes.map((n) => n.id), [ROOT_ID]);
});

test('task labels and token counts stay short', () => {
  assert.equal(taskKind(task('a')), 'Explore');
  assert.equal(taskKind(task('b', { subagentType: undefined, type: 'local_bash' })), 'shell');
  assert.equal(taskKind(task('c', { subagentType: undefined, type: 'local_workflow' })), 'workflow');
  assert.equal(shortTokens(950), '950');
  assert.equal(shortTokens(1234), '1.2k');
  assert.equal(shortTokens(35200), '35k');
  assert.equal(shortTokens(2_500_000), '2.5M');
});

test('the graph hides completed tasks but keeps failed ones and parents of anything still shown', () => {
  const list = [
    task('p1', { status: 'completed' }),
    task('c1', { parentId: 'p1', status: 'running' }),
    task('p2', { status: 'completed' }),
    task('c2', { parentId: 'p2', status: 'completed' }),
    task('g', { parentId: 'c2', status: 'completed' }),
    task('f', { status: 'failed' }),
    task('s', { status: 'stopped' }),
    task('p3', { status: 'completed' }),
    task('c3', { parentId: 'p3', status: 'completed' }),
    task('g3', { parentId: 'c3', status: 'failed' }),
    task('loop1', { parentId: 'loop2', status: 'completed' }),
    task('loop2', { parentId: 'loop1', status: 'completed' }),
  ];
  assert.deepEqual(visibleTasks(list).map((t) => t.id), ['p1', 'c1', 'f', 's', 'p3', 'c3', 'g3']);
});
