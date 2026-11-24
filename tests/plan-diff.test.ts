import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../web/src/lib/planView.ts';
import { diffPlans, matchTextPlans, similarity } from '../web/src/lib/planDiff.ts';
import type { ChatItem } from '../web/src/lib/chatStore.ts';

const user = (id: string, text: string, extra: Partial<Extract<ChatItem, { kind: 'user' }>> = {}): ChatItem => ({ kind: 'user', id, text, attachments: [], ...extra });
const say = (id: string, text: string): ChatItem => ({ kind: 'assistant', id, text, thinking: '', parent: null, streaming: false });
const tool = (id: string, name: string, input: unknown, extra: Partial<Extract<ChatItem, { kind: 'tool' }>> = {}): ChatItem =>
  ({ kind: 'tool', id, name, input, output: '', isError: false, parent: null, elapsed: 0, done: true, ...extra });
const planSet = (id: string, steps: [string, string, string][], reason?: string) =>
  tool(id, 'mcp__vibrato__plan_set', { steps: steps.map(([sid, role, title]) => ({ id: sid, title, ...(role ? { role } : {}) })), ...(reason ? { reason } : {}) });
const step = (id: string, sid: string, note = 'done', skipped = false) => tool(id, 'mcp__vibrato__plan_step', { id: sid, note, ...(skipped ? { skipped } : {}) });

const S3: [string, string, string][] = [['s1', 'B', '기획 확인'], ['s2', 'D', '수정'], ['s3', 'E', '검증']];

test('PD-1 an added step is matched by id; the others keep their rows in the new order', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), planSet('p2', [S3[0], S3[1], ['s4', 'C', '시안 확인'], S3[2]], '시안 필요')]);
  assert.deepEqual(t.steps.map((s) => s.id), ['s1', 's2', 's4', 's3']);
  assert.deepEqual(t.revisions[0].changes, [{ kind: 'added', id: 's4', title: '시안 확인', role: 'C' }]);
});

test('PD-2 a step left out before it was done is removed, with the reason', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), planSet('p2', [S3[0], S3[2]], '수정 불필요')]);
  assert.deepEqual(t.steps.map((s) => s.id), ['s1', 's3']);
  assert.deepEqual(t.removed.map((s) => [s.id, s.removed]), [['s2', { reason: '수정 불필요' }]]);
  assert.equal(t.revisions[0].changes[0].kind, 'removed');
});

test('PD-3 a renamed step keeps its row, notes and rounds', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), step('k1', 's1', '봤음'), planSet('p2', [['s1', 'B', '기획 · 정책 확인'], S3[1], S3[2]], '범위 넓힘')]);
  assert.equal(t.steps[0].content, '기획 · 정책 확인');
  assert.equal(t.steps[0].entries.length, 1);
  assert.equal(t.steps[0].status, 'completed');
  assert.deepEqual(t.revisions[0].changes, [{ kind: 'renamed', id: 's1', from: '기획 확인', to: '기획 · 정책 확인' }]);
});

test('PD-4 a role change is reported', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), planSet('p2', [['s1', 'D', '기획 확인'], S3[1], S3[2]], '직접 읽음')]);
  assert.deepEqual(t.revisions[0].changes, [{ kind: 'role', id: 's1', title: '기획 확인', from: 'B', to: 'D' }]);
  assert.equal(t.steps[0].role, 'D');
});

test('PD-5 three plans in a turn give revisions 1 and 2, each under the step in progress then', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), step('k1', 's1'), planSet('p2', [...S3, ['s4', 'E', '재검증']], 'a'), step('k2', 's2'), planSet('p3', [...S3], 'b')]);
  assert.deepEqual(t.revisions.map((r) => [r.n, r.itemId]), [[1, 'p2'], [2, 'p3']]);
  assert.ok(t.steps.find((s) => s.id === 's2')!.items.some((i) => i.id === 'p2'));
  assert.ok(t.steps.find((s) => s.id === 's3')!.items.some((i) => i.id === 'p3'));
});

test('PD-6 work filed under a step stays there across a revision', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), tool('r1', 'Read', { file_path: '/a' }), planSet('p2', [['s0', 'A', '먼저 조사'], ...S3], '조사 추가')]);
  assert.ok(t.steps.find((s) => s.id === 's1')!.items.some((i) => i.id === 'r1'));
});

test('PD-7 a new order alone is no change', () => {
  assert.deepEqual(diffPlans([{ id: 's1', title: 'a' }, { id: 's2', title: 'b' }], [{ id: 's2', title: 'b' }, { id: 's1', title: 'a' }]), []);
});

test('PD-8 a rewritten text plan keeps matching titles and marks the new one as added (guessed)', () => {
  const [t] = buildPlan([user('u', 'go'), say('a1', '진행 계획\n1. 원인 찾기\n2. 수정'), say('a2', '진행 계획\n1. 원인 찾기\n2. 테스트 추가\n3. 수정')]);
  assert.equal(t.revisions.length, 1);
  assert.equal(t.revisions[0].guessed, true);
  assert.deepEqual(t.revisions[0].changes, [{ kind: 'added', id: 't2', title: '테스트 추가' }]);
});

test('PD-9 a reworded title with enough overlap is the same step', () => {
  assert.ok(similarity('로그인 버그 수정', '로그인 토큰 만료 버그 수정') >= 0.6);
  assert.deepEqual(matchTextPlans(['원인 찾기', '로그인 버그 수정'], ['원인 찾기', '로그인 토큰 만료 버그 수정']).match, [0, 1]);
});

test('PD-10 a done step gone from the rewritten text plan stays as done', () => {
  const [t] = buildPlan([user('u', 'go'), say('a1', '진행 계획\n1. 로그 수집\n2. 수정'), say('a2', '✓ 1. 수집함'), say('a3', '진행 계획\n1. 수정\n2. 검증')]);
  assert.deepEqual(t.removed.map((s) => [s.content, s.status, s.removed]), [['로그 수집', 'completed', { reason: null, dropped: true }]]);
});

test('PD-11 the same number with an unrelated title is removed + added, not matched', () => {
  const m = matchTextPlans(['원인 찾기', '버튼 색 수정'], ['원인 찾기', 'README 정리']);
  assert.deepEqual(m.match, [0, null]);
  assert.deepEqual(m.removed, [1]);
});

test('plan_step closes the step it names and moves to the next; work files under the step in progress', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), step('k1', 's1', '요구사항 5개'), tool('e1', 'Edit', { file_path: '/a.ts' })]);
  assert.deepEqual(t.steps.map((s) => s.status), ['completed', 'in_progress', 'pending']);
  assert.equal(t.steps[0].note, '요구사항 5개');
  assert.ok(t.steps[1].items.some((i) => i.id === 'e1'));
});

test('ED-1/ED-2 an addition shows where it came, then the plan change under it', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), step('k1', 's1'), user('u2', '버튼 색도 바꿔줘', { followUp: true }), planSet('p2', [...S3, ['s4', 'D', '버튼 색']], '추가 요청')]);
  assert.deepEqual(t.additions, ['버튼 색도 바꿔줘']);
  assert.deepEqual(t.additionItems, [{ text: '버튼 색도 바꿔줘', itemId: 'u2', attachments: [] }]);
  assert.deepEqual(t.steps.find((s) => s.id === 's2')!.items.map((i) => i.id), ['u2', 'p2']);
});

test('a rejected plan_set call changes nothing', () => {
  const [t] = buildPlan([user('u', 'go'), planSet('p1', S3), tool('p2', 'mcp__vibrato__plan_set', { steps: [] }, { isError: true })]);
  assert.equal(t.steps.length, 3);
  assert.equal(t.revisions.length, 0);
});

test('pictures sent with the request and with an addition stay with each', () => {
  const pic = (p: string) => ({ path: p, name: p.split('/').pop()!, kind: 'image' as const });
  const [t] = buildPlan([user('u', '시안대로', { attachments: [pic('/a/shot1.png')] }), planSet('p1', S3), step('k1', 's1'),
    user('u2', '이것도 봐줘', { followUp: true, attachments: [pic('/a/shot2.png'), { path: '/a/spec.pdf', name: 'spec.pdf', kind: 'file' as const }] })]);
  assert.deepEqual(t.user?.attachments.map((a) => a.name), ['shot1.png']);
  assert.deepEqual(t.additionItems[0].attachments.map((a) => a.name), ['shot2.png', 'spec.pdf']);
});
