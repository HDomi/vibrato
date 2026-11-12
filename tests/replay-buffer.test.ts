import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplayBuffer } from '../server/sessions';
import { reduceEvent, type ChatSession } from '../web/src/lib/chatStore';
import type { AgentEvent, ServerMessage } from '../server/agents/types';

const blank = (): ChatSession => ({ id: 's', cwd: '/tmp', agent: 'claude', permissionMode: 'default', status: 'idle', totalCostUsd: 0, lastSeq: 0, items: [] });
const msg = (seq: number, event: AgentEvent): ServerMessage => ({ sessionId: 's', seq, ts: 0, event });
/** What the chat shows, without the ids and times the reducer makes up. */
const view = (s: ChatSession) => ({ lastSeq: s.lastSeq, status: s.status, items: s.items.map(({ id: _id, ...rest }) => ({ ...rest, at: undefined })) });

const events: AgentEvent[] = [
  { kind: 'user', text: 'hi', attachments: [] },
  { kind: 'thinking.delta', text: 'th', parent: null },
  { kind: 'thinking.delta', text: 'ink', parent: null },
  { kind: 'text.delta', text: 'Hel', parent: null },
  { kind: 'log', text: 'stderr noise' },
  { kind: 'text.delta', text: 'lo', parent: null },
  { kind: 'text.delta', text: 'sub', parent: 'task' },
  { kind: 'text.delta', text: ' wor', parent: null },
  { kind: 'text.delta', text: 'ld', parent: null },
  { kind: 'assistant.message', id: 'm1', parent: null, blocks: [{ type: 'thinking', text: 'think' }, { type: 'text', text: 'Hello world' }] },
  { kind: 'tool.start', toolUseId: 't1', name: 'Bash', input: { command: 'ls' }, parent: null },
  { kind: 'tool.output', toolUseId: 't1', chunk: 'a' },
  { kind: 'tool.output', toolUseId: 't1', chunk: 'b' },
  { kind: 'tool.output', toolUseId: 't2', chunk: 'x' },
  { kind: 'tool.output', toolUseId: 't1', chunk: 'c' },
  { kind: 'tool.result', toolUseId: 't1', content: 'abc', isError: false, parent: null },
  { kind: 'text.delta', text: 'Done.', parent: null },
  { kind: 'result', ok: true, text: 'Done.', costUsd: 0, numTurns: 1, durationMs: 1 },
];

test('replay buffer: merged stream pieces rebuild the same chat from any point a client stopped at', () => {
  const live = events.map((e, i) => msg(i + 1, e));
  const buffer = new ReplayBuffer();
  // The registry buffers everything but `log` (sessions.ts broadcast).
  for (const m of live) if (m.event.kind !== 'log') buffer.push(m);
  assert.ok(buffer.length < live.length - 4, `pieces were merged (${buffer.length} messages for ${live.length} events)`);

  const full = live.reduce((s, m) => reduceEvent(s, m.event, m.seq, 0), blank());
  for (let after = 0; after <= live.length; after++) {
    const seen = live.filter((m) => m.seq <= after).reduce((s, m) => reduceEvent(s, m.event, m.seq, 0), blank());
    const replay = [...buffer.since(after)];
    assert.ok(replay.every((m, i) => m.seq > after && (i === 0 || m.seq > replay[i - 1].seq)), `seq ascends past ${after}`);
    const caught = replay.reduce((s, m) => reduceEvent(s, m.event, m.seq, 0), seen);
    assert.deepEqual(view(caught), view(full), `re-attach after seq ${after}`);
  }
});

test('replay buffer: a long answer is one message, runs stop at the merge cap, bytes stay counted', () => {
  const long = new ReplayBuffer();
  long.push(msg(1, { kind: 'user', text: 'go', attachments: [] }));
  for (let i = 0; i < 6000; i++) long.push(msg(i + 2, { kind: 'text.delta', text: 'tok ', parent: null }));
  assert.equal(long.length, 2);
  const [, answer] = [...long];
  assert.equal(answer.seq, 6001);
  assert.equal((answer.event as { text: string }).text, 'tok '.repeat(6000));

  const capped = new ReplayBuffer({ limit: 5000, maxBytes: 1 << 20, mergeMaxBytes: 150 });
  for (let i = 0; i < 100; i++) capped.push(msg(i + 1, { kind: 'tool.output', toolUseId: 't', chunk: 'abcde' }));
  assert.ok(capped.length > 3 && capped.length < 20, `split into ${capped.length} runs`);
  assert.equal([...capped.since(0)].map((m) => (m.event as { chunk: string }).chunk).join(''), 'abcde'.repeat(100));

  const bounded = new ReplayBuffer({ limit: 100, maxBytes: 2000, mergeMaxBytes: 1 << 20 });
  for (let i = 0; i < 60; i++) bounded.push(msg(i + 1, { kind: 'status', status: i % 2 ? 'running' : 'idle' }));
  const kept = [...bounded];
  assert.ok(kept.length < 60 && kept[kept.length - 1].seq === 60, 'oldest dropped first');
  assert.equal(bounded.bytes, kept.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m)), 0));
  assert.ok(bounded.bytes <= 2000);
});
