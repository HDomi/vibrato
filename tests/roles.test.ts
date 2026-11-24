import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceOf, roleOfTool, stepRole } from '../web/src/lib/roles.ts';
import { buildPlan, roleChips, usesRoles } from '../web/src/lib/planView.ts';
import type { ChatItem } from '../web/src/lib/chatStore.ts';

const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, text, attachments: [] });
const say = (id: string, text: string): ChatItem => ({ kind: 'assistant', id, text, thinking: '', parent: null, streaming: false });
const tool = (id: string, name: string, input: unknown, extra: Partial<Extract<ChatItem, { kind: 'tool' }>> = {}): ChatItem =>
  ({ kind: 'tool', id, name, input, output: '', isError: false, parent: null, elapsed: 0, done: true, ...extra });
const planSet = (id: string, steps: [string, string | null, string][], reason?: string) =>
  tool(id, 'mcp__vibrato__plan_set', { steps: steps.map(([sid, role, title]) => ({ id: sid, title, ...(role ? { role } : {}) })), ...(reason ? { reason } : {}) });
const step = (id: string, sid: string, note = 'done', skipped = false) => tool(id, 'mcp__vibrato__plan_step', { id: sid, note, ...(skipped ? { skipped } : {}) });
const chipsOf = (t: ReturnType<typeof buildPlan>[number], live: boolean) => Object.fromEntries(roleChips(t, live).map((c) => [c.role, c.state]));

test('RL-1 a plan_set role is declared, not guessed', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p', [['s1', 'C', '시안 확인']])]);
  assert.equal(t.steps[0].role, 'C');
  assert.ok(!t.steps[0].roleGuessed);
});

test('RL-2 a [E] tag in a written plan is declared, and is taken off the title', () => {
  const [t] = buildPlan([user('u', 'go'), say('a', '진행 계획\n1. [D] 수정\n2. [E] 실측')]);
  assert.deepEqual(t.steps.map((s) => [s.role, s.content, !!s.roleGuessed]), [['D', '수정', false], ['E', '실측', false]]);
  assert.equal(usesRoles(t), true);
});

test('RL-3/RL-4 Figma is C, Notion and other spec tools are B (MCP tools only)', () => {
  assert.equal(roleOfTool({ name: 'mcp__claude_ai_Figma__get_design_context', input: {} }), 'C');
  assert.equal(roleOfTool({ name: 'mcp:figma/get_metadata', input: {} }), 'C');
  assert.equal(roleOfTool({ name: 'mcp__claude_ai_Notion__notion-fetch', input: {} }), 'B');
  assert.equal(roleOfTool({ name: 'mcp__notion-personal__API-retrieve-a-page', input: {} }), 'B');
  assert.equal(roleOfTool({ name: 'mcp__claude_ai_Google_Docs__read', input: {} }), 'B');
  const [t] = buildPlan([user('u', 'go'), say('a', '진행 계획\n1. 시안 보기\n2. 기획 보기'),
    tool('f', 'mcp__claude_ai_Figma__get_metadata', {}), say('m1', '✓ 1. 봄'),
    tool('n', 'mcp__claude_ai_Notion__notion-fetch', {}), say('m2', '✓ 2. 봄')]);
  assert.deepEqual(t.steps.map((s) => [s.role, s.roleGuessed]), [['C', true], ['B', true]]);
  assert.equal(t.steps[0].evidence?.design, 1);
  assert.equal(t.steps[1].evidence?.spec, 1);
});

test('RL-5..7 edit is D; checks and the in-app browser are E; reading and searching are A', () => {
  assert.equal(roleOfTool({ name: 'Edit', input: { file_path: '/a' } }), 'D');
  assert.equal(roleOfTool({ name: 'Bash', input: { command: 'npm run typecheck' } }), 'E');
  assert.equal(roleOfTool({ name: 'Bash', input: { command: 'cd web && npx vitest run' } }), 'E');
  assert.equal(roleOfTool({ name: 'mcp__vibrato__browser_measure', input: {} }), 'E');
  assert.equal(roleOfTool({ name: 'Read', input: {} }), 'A');
  assert.equal(roleOfTool({ name: 'Bash', input: { command: 'rg login' } }), 'A');
  assert.equal(roleOfTool({ name: 'mcp__vibrato__plan_step', input: {} }), null);
});

test('RL-8 Figma and an edit in one undeclared step: D, with both in the evidence', () => {
  const e = evidenceOf([{ name: 'mcp__claude_ai_Figma__get_design_context', input: {} }, { name: 'Edit', input: {} }]);
  assert.deepEqual(e.roles, ['C', 'D']);
  assert.deepEqual(stepRole(null, e.roles), { role: 'D', guessed: true });
});

test('RL-9 declared B with an edit in it keeps the tag, shows D in evidence, lights both chips', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p', [['s1', 'B', '기획']]), tool('e', 'Edit', { file_path: '/a' })]);
  assert.equal(t.steps[0].role, 'B');
  assert.deepEqual(t.steps[0].evidence?.roles, ['D']);
  const c = chipsOf(t, true);
  assert.notEqual(c.B, 'unused');
  assert.notEqual(c.D, 'unused');
});

test('RL-10 an edit inside a subagent is not the main session coding', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p', [['s1', 'B', '기획']]), tool('e', 'Edit', { file_path: '/a' }, { parent: 'agent1' })]);
  assert.deepEqual(t.steps[0].evidence?.roles, []);
});

test('RL-11 a Codex file change is D', () => {
  assert.equal(roleOfTool({ name: 'FileChange', input: { changes: [] } }), 'D');
});

test('RL-12 a question answered by the lead alone, or a turn without a plan, shows no role bar', () => {
  const [q] = buildPlan([user('u', '이 함수 뭐야?'), planSet('p', [['s1', null, '함수 확인']]), tool('r', 'Read', { file_path: '/a' }), step('k', 's1')]);
  assert.equal(usesRoles(q), false);
  const [n] = buildPlan([user('u', '이 함수 뭐야?'), say('a1', '토큰을 검사합니다.')]);
  assert.equal(usesRoles(n), false);
});

test('a turn using B and D leaves C and E unused; the lead is always on', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p', [['s1', 'B', '기획'], ['s2', 'D', '수정']])]);
  const c = chipsOf(t, true);
  assert.deepEqual([c.A, c.B, c.C, c.D, c.E], ['running', 'running', 'unused', 'planned', 'unused']);
});

const S3: [string, string, string][] = [['s1', 'B', '기획 확인'], ['s2', 'D', '수정'], ['s3', 'E', '검증']];

test('PD-4 a role change moves the chip', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), planSet('p2', [['s1', 'D', '기획 확인'], S3[1], S3[2]], '직접 읽음')]);
  assert.equal(chipsOf(t, true).B, 'unused');
});

test('ED-3 verify fails, fix, verify again: rounds and the last pass wins', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), step('k1', 's1'), tool('e1', 'Edit', { file_path: '/a' }), step('k2', 's2'),
    tool('v1', 'Bash', { command: 'npm test' }, { isError: true }), step('k3', 's3', 'a 실패'),
    planSet('p2', S3, '재검증'), tool('v2', 'Bash', { command: 'npm test' }), step('k4', 's3', 'b 통과')]);
  const e = roleChips(t, false).find((c) => c.role === 'E')!;
  assert.equal(e.rounds, 2);
  assert.equal(e.state, 'done');
});

test('ED-4 a step closed as not done fails its role chip', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), step('k1', 's1', '기획 링크 없음', true)]);
  assert.equal(chipsOf(t, false).B, 'failed');
});

test('ED-5 an interrupted turn shows the step in progress as stopped', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), step('k1', 's1'), tool('e1', 'Edit', { file_path: '/a' })]);
  assert.equal(chipsOf(t, false).D, 'stopped');
});

test('ED-6 a question to the user puts the lead chip on waiting for you', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), { kind: 'question', id: 'q1', questions: [], resolved: false }]);
  assert.equal(chipsOf(t, true).A, 'user');
});

test('a failed last check marks E failed', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), step('k1', 's1'), step('k2', 's2'), tool('v1', 'Bash', { command: 'npm test' }, { isError: true }), step('k3', 's3', '실패 그대로')]);
  assert.equal(chipsOf(t, false).E, 'failed');
  assert.equal(t.steps[2].evidence?.checksFailed, 1);
});
