import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeSession, verificationGap } from '../server/agents/claude.ts';
import { planGap } from '../server/planGuard.ts';
import { planSetText } from '../web/src/lib/planSet.ts';
import { PLAN_INSTRUCTIONS } from '../server/planInstructions.ts';
import { codexBrowserArgs } from '../server/browserMcp.ts';
import { buildPlan } from '../web/src/lib/planView.ts';
import type { ChatItem } from '../web/src/lib/chatStore.ts';

const D = { id: 's1', role: 'D' as const, title: '수정' };
const E = { id: 's2', role: 'E' as const, title: '검증' };

test('HK-1 an edit with an E step in the plan passes', () => {
  assert.equal(verificationGap([D, E], null, new Set(['D'])), null);
});

test('HK-2 an edit with no E step and no check is sent back', () => {
  assert.match(String(verificationGap([D], null, new Set(['A', 'D']))), /no verification/);
});

test('HK-3 an E step closed as not done with a reason passes both checks', () => {
  assert.equal(verificationGap([D, E], null, new Set(['D'])), null);
  assert.equal(planGap([planSetText([D, E]), '✓ 1. 고침', '✓ 2. Not done: 문서만 수정', '결과: 끝']), null);
});

test('HK-4 an edit with a check that ran passes without an E step; a written [E] tag counts too', () => {
  assert.equal(verificationGap([D], null, new Set(['D', 'E'])), null);
  assert.equal(verificationGap([], ['[D] 수정', '[E] npm test'], new Set(['D'])), null);
});

test('HK-5 a turn with no edit is not checked', () => {
  assert.equal(verificationGap([], null, new Set(['A'])), null);
});

test('HK-6 the Stop hook sends back once, and records roles from main-thread calls only', async () => {
  const s = new ClaudeSession({ cwd: '/tmp', claudePath: '/bin/false', planGuard: true }) as unknown as Record<string, (i: unknown) => Promise<Record<string, unknown>>> & { turnTexts: string[]; turnRoles: Set<string> };
  await s.planProgress({ hook_event_name: 'PostToolUse', agent_id: 'sub', tool_name: 'Edit', tool_input: {}, tool_response: '', tool_use_id: 'x' });
  assert.equal(s.turnRoles.has('D'), false, 'a subagent edit does not count');
  await s.planProgress({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: {}, tool_response: '', tool_use_id: 'y' });
  assert.equal(s.turnRoles.has('D'), true);
  s.turnTexts.push('진행 계획\n1. [D] 수정', '✓ 1. 고침', '결과: 고침');
  const first = await s.planStop({ hook_event_name: 'Stop', stop_hook_active: false });
  assert.equal(first.decision, 'block');
  assert.deepEqual(await s.planStop({ hook_event_name: 'Stop', stop_hook_active: true }), {});
});

test('the plan protocol asks for plan_set and a verification step', () => {
  assert.match(PLAN_INSTRUCTIONS, /plan_set/);
  assert.match(PLAN_INSTRUCTIONS, /5\. VERIFY/);
});

test('CX-1 Codex gets the plan tools on the same MCP URL', () => {
  assert.ok(codexBrowserArgs(11398, 'tok', { browser: false, plan: true }).some((a) => a.includes('p=1')));
});

test('CX-2 the Codex name of plan_set builds the same checklist', () => {
  const items: ChatItem[] = [{ kind: 'user', id: 'u', text: 'go', attachments: [] },
    { kind: 'tool', id: 'p', name: 'mcp:vibrato/plan_set', input: { steps: [{ id: 's1', role: 'D', title: '수정' }] }, output: '', isError: false, parent: null, elapsed: 0, done: true }];
  const [t] = buildPlan(items);
  assert.deepEqual(t.steps.map((s) => [s.id, s.role]), [['s1', 'D']]);
});
