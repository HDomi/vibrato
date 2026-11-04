import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGap } from '../server/planGuard.ts';

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
