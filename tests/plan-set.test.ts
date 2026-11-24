import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyLedger, planSetText, validatePlanSet, validatePlanStep, withStepNumber, type PlanLedger } from '../web/src/lib/planSet.ts';
import { browserSession, handleRpc, registerBrowserSession, resetPlanLedger } from '../server/browserMcp.ts';
import { planGap } from '../server/planGuard.ts';

const three = [
  { id: 's1', role: 'C', title: 'Figma 첫 화면 수치 확인' },
  { id: 's2', role: 'D', title: 'index.html · style.css 작성' },
  { id: 's3', role: 'E', title: '렌더 결과를 시안과 대조' },
];
function ok<T>(r: { ok: true; ledger: PlanLedger; value: T } | { ok: false; error: string }) {
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r as { ok: true; ledger: PlanLedger; value: T };
}
const err = (r: { ok: boolean; error?: string }, re: RegExp) => { assert.equal(r.ok, false); assert.match(r.error!, re); };

test('PS-1 a valid first plan is accepted', () => {
  const r = ok(validatePlanSet(emptyLedger(), { steps: three }));
  assert.equal(r.value.steps.length, 3);
  assert.deepEqual(r.ledger.used, ['s1', 's2', 's3']);
});

test('PS-2 duplicate ids are refused', () => {
  err(validatePlanSet(emptyLedger(), { steps: [three[0], { ...three[1], id: 's1' }] }), /duplicate id s1/);
});

test('PS-3 an unknown role is refused, naming the allowed ones', () => {
  err(validatePlanSet(emptyLedger(), { steps: [{ id: 's1', role: 'X', title: 'x' }] }), /A, B, C, D, E/);
});

test('PS-4 a step without a role is accepted (a question has none)', () => {
  ok(validatePlanSet(emptyLedger(), { steps: [{ id: 's1', title: '함수 확인' }] }));
});

test('PS-5 zero or thirteen steps are refused, and so is a bad id', () => {
  err(validatePlanSet(emptyLedger(), { steps: [] }), /1-12 steps/);
  err(validatePlanSet(emptyLedger(), { steps: Array.from({ length: 13 }, (_, i) => ({ id: `s${i + 1}`, title: `t${i}` })) }), /1-12 steps/);
  err(validatePlanSet(emptyLedger(), { steps: [{ id: 'step-1', title: 'x' }] }), /not valid/);
});

test('PS-6 a revision without a reason is refused', () => {
  const first = ok(validatePlanSet(emptyLedger(), { steps: three }));
  err(validatePlanSet(first.ledger, { steps: three }), /reason required/);
  ok(validatePlanSet(first.ledger, { steps: three, reason: '순서 조정' }));
});

test('PS-7 a done step cannot be dropped', () => {
  const first = ok(validatePlanSet(emptyLedger(), { steps: three }));
  const stepped = ok(validatePlanStep(first.ledger, { id: 's2', note: 'done' }));
  err(validatePlanSet(stepped.ledger, { steps: [three[0], three[2]], reason: 'x' }), /s2 is done; keep it/);
});

test('PS-8 a removed id cannot be reused for a new step', () => {
  const first = ok(validatePlanSet(emptyLedger(), { steps: three }));
  const second = ok(validatePlanSet(first.ledger, { steps: [three[0], three[2]], reason: '수정 불필요' }));
  err(validatePlanSet(second.ledger, { steps: [...second.value.steps, { id: 's2', title: '다른 수정' }], reason: '추가' }), /s2 was removed earlier/);
});

test('PS-9 plan_step with an id not in the plan is refused', () => {
  const first = ok(validatePlanSet(emptyLedger(), { steps: three }));
  err(validatePlanStep(first.ledger, { id: 's9', note: 'x' }), /No step s9/);
});

test('PS-10 plan_step by number counts in the current order; by id it maps to its number', () => {
  const first = ok(validatePlanSet(emptyLedger(), { steps: three }));
  const r = ok(validatePlanStep(first.ledger, { step: 2, note: 'x' }));
  assert.equal(r.value, 2);
  assert.deepEqual(r.ledger.done, ['s2']);
  assert.deepEqual(withStepNumber({ id: 's3', note: 'x' }, three as never), { id: 's3', note: 'x', step: 3 });
});

test('PS-11 the MCP server keeps one plan per session and starts over on a new turn', async () => {
  const token = registerBrowserSession('test');
  const session = browserSession(token);
  const call = async (name: string, args: unknown) => ((await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args as Record<string, unknown> } }, undefined, session, { browser: false, plan: true }))!.result as { isError?: boolean; content: { text: string }[] });
  assert.equal((await call('plan_set', { steps: three })).isError, undefined);
  assert.equal((await call('plan_set', { steps: three })).isError, true, 'second call without reason');
  assert.match((await call('plan_step', { id: 's1', note: 'ok' })).content[0].text, /Step 1 checked/);
  resetPlanLedger(token);
  assert.equal((await call('plan_set', { steps: three })).isError, undefined, 'a new turn starts over');
  const other = browserSession(registerBrowserSession('other'));
  const r = (await handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'plan_set', arguments: { steps: three } } }, undefined, other, { browser: false, plan: true }))!.result as { isError?: boolean };
  assert.equal(r.isError, undefined, 'another session has its own plan');
});

test('PS-12 plan_set is listed with the plan group only', async () => {
  const list = async (g: { browser: boolean; plan: boolean }) =>
    ((await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, undefined, undefined, g))!.result as { tools: { name: string }[] }).tools.map((x) => x.name);
  assert.ok(!(await list({ browser: true, plan: false })).includes('plan_set'));
  assert.ok((await list({ browser: false, plan: true })).includes('plan_set'));
});

test('HK-7 a plan given only through plan_set counts as a plan for the plan check', () => {
  assert.equal(planSetText([{ id: 's1', title: 'a' }, { id: 's2', title: 'b' }]), '진행 계획\n1. a\n2. b');
  assert.equal(planGap([planSetText(three as never), '✓ 1. a', '✓ 2. b', '✓ 3. c', '결과: ok']), null);
});
