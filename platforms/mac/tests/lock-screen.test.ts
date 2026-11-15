import test from 'node:test';
import assert from 'node:assert/strict';
import { lockSummary } from '../web/src/lib/lockScreen';
import type { ChatSession } from '../web/src/lib/chatStore';

const s = (agent: 'claude' | 'codex', status: ChatSession['status'], items: ChatSession['items'] = []) => ({ agent, status, items });

test('session summary counts per agent without titles and skips closed sessions', () => {
  const list = lockSummary([
    s('claude', 'running'), s('claude', 'idle'), s('claude', 'closed'), s('codex', 'compacting'),
    s('claude', 'running', [{ kind: 'user', id: 'u', text: 'go' }, { kind: 'approval', id: 'a', requestId: 'r', toolName: 'Bash', input: {} }] as ChatSession['items']),
  ]);
  assert.deepEqual(list, [
    { agent: 'claude', total: 3, running: 2, waiting: 1 },
    { agent: 'codex', total: 1, running: 1, waiting: 0 },
  ]);
  assert.deepEqual(lockSummary([]), []);
});

test('seven-segment digits light the right segments and lay out HH:MM:SS', async () => {
  const { DIGIT_SEGMENTS, SEG, segmentLayout, segmentPolygons } = await import('../web/src/lib/lockScreen');
  assert.equal(Object.keys(DIGIT_SEGMENTS).length, 10);
  assert.equal(DIGIT_SEGMENTS['8'], 'abcdefg');
  assert.ok(!DIGIT_SEGMENTS['0'].includes('g'));
  assert.equal(DIGIT_SEGMENTS['1'], 'bc');
  const { offsets, width } = segmentLayout('16:07:30');
  assert.equal(offsets.length, 8);
  assert.equal(width, 6 * SEG.w + 2 * SEG.colonW + 7 * SEG.space);
  // every segment of a cell stays inside it
  const xs = Object.values(segmentPolygons(offsets[7])).flatMap((p) => p.split(' ').map((q) => Number(q.split(',')[0])));
  assert.ok(Math.min(...xs) >= offsets[7] && Math.max(...xs) <= offsets[7] + SEG.w);
});
