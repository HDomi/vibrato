import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NUDGE_EVERY, NUDGE_FIRST, PlanProgress, planGap } from '../server/planGuard.ts';

const plan = '진행 계획\n1. 파악\n2. 확인\n3. 고치기';

test('a complete reply passes the plan check', () => {
  assert.equal(planGap([plan, '✓ 1. 봤어', '✓ 2. 원인 찾음\n✓ 3. 고침\n\n결과: 고쳤어']), null);
});

test('missing ✓ lines and result are named', () => {
  const gap = planGap([plan, '✓ 3. 고침']);
  assert.match(gap!, /steps 1, 2 have no/);
  assert.match(gap!, /no "결과:"/);
  assert.match(planGap([plan, '✓ 1. a\n✓ 2. b\n✓ 3. c'])!, /no "결과:"/);
  assert.match(planGap([plan, '✓ 1. a\n✓ 3. c\n결과: x'])!, /step 2 has no/);
});

test('a reply without a plan is asked for one', () => {
  assert.match(planGap(['그냥 답이야.'])!, /no plan/);
});

test('asking for a missing result asks for all of it, not a pointer back', () => {
  assert.match(planGap([plan, '✓ 1. a\n✓ 2. b\n✓ 3. c'])!, /complete outcome/);
  assert.match(planGap([plan, '✓ 1. a\n✓ 3. c\n결과: x'])!, /Keep your result/);
});

test('a run of tool calls with no new ✓ line is reminded to close the step it is on', () => {
  const p = new PlanProgress();
  const texts = [plan];
  const nudges: (string | null)[] = [];
  for (let i = 0; i < NUDGE_FIRST; i++) nudges.push(p.tool(texts));
  assert.deepEqual(nudges.slice(0, -1), Array(NUDGE_FIRST - 1).fill(null));
  assert.match(nudges.at(-1)!, /step 1 \("파악"\)/);
  assert.match(nudges.at(-1)!, /✓ 1\.|plan_step/);
  // A ✓ line starts the count over, and the reminder names the next step.
  texts.push('✓ 1. 봤어');
  for (let i = 0; i < NUDGE_FIRST - 1; i++) assert.equal(p.tool(texts), null);
  assert.match(p.tool(texts)!, /step 2 \("확인"\)/);
  // Then again every NUDGE_EVERY calls, not on each one.
  for (let i = 0; i < NUDGE_EVERY - 1; i++) assert.equal(p.tool(texts), null);
  assert.match(p.tool(texts)!, /step 2/);
  // Every step closed: nothing to remind.
  texts.push('✓ 2. b\n✓ 3. c');
  for (let i = 0; i < 30; i++) assert.equal(p.tool(texts), null);
});

test('a reply with tools but no plan is reminded once to write it', () => {
  const p = new PlanProgress();
  assert.equal(p.tool([]), null);
  assert.match(p.tool([])!, /not written your plan/);
  for (let i = 0; i < 20; i++) assert.equal(p.tool([]), null);
  p.reset();
  p.tool(['그냥 말']);
  assert.match(p.tool(['그냥 말'])!, /not written your plan/);
});
