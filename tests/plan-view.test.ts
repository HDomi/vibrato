import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, liveTasksByTurn, noteLine } from '../web/src/lib/planView';
import type { TaskInfo } from '../web/src/lib/agent';
import { reduceEvent, type ChatItem, type ChatSession } from '../web/src/lib/chatStore';

const user = (id: string, text: string): ChatItem => ({ kind: 'user', id, text, attachments: [] });
const say = (id: string, text: string): ChatItem => ({ kind: 'assistant', id, text, thinking: '', parent: null, streaming: false });
const tool = (id: string, name: string, input: unknown, extra: Partial<Extract<ChatItem, { kind: 'tool' }>> = {}): ChatItem =>
  ({ kind: 'tool', id, name, input, output: '', isError: false, parent: null, elapsed: 0, done: true, ...extra });
const todos = (id: string, list: [string, 'pending' | 'in_progress' | 'completed'][]): ChatItem =>
  tool(id, 'TodoWrite', { todos: list.map(([content, status]) => ({ content, status, activeForm: `${content}…` })) });

test('work is filed under the step in progress when it happened', () => {
  const [turn] = buildPlan([
    user('u1', 'Fix the login bug'),
    say('a1', 'Looking around first.'),
    todos('t1', [['Find the cause', 'in_progress'], ['Patch it', 'pending']]),
    tool('b1', 'Bash', { command: 'rg login' }),
    tool('r1', 'Read', { file_path: '/p/auth.ts' }),
    say('a2', 'The token check uses <= instead of <. More text here.'),
    todos('t2', [['Find the cause', 'completed'], ['Patch it', 'in_progress']]),
    tool('e1', 'Edit', { file_path: '/p/auth.ts' }),
    tool('e2', 'Edit', { file_path: '/p/auth.ts' }),
    tool('b2', 'Bash', { command: 'npm test' }, { isError: true, elapsed: 12 }),
    todos('t3', [['Find the cause', 'completed'], ['Patch it', 'completed']]),
    say('a3', 'Done: the expiry check is fixed.'),
    { kind: 'result', id: 'res', ok: true, text: '', costUsd: 0.1, numTurns: 3, durationMs: 9000 },
  ]);
  assert.equal(turn.user?.id, 'u1');
  assert.equal(turn.hasPlan, true);
  assert.deepEqual(turn.before.items.map((i) => i.id), ['a1']);
  assert.deepEqual(turn.steps.map((s) => [s.content, s.status]), [['Find the cause', 'completed'], ['Patch it', 'completed']]);
  const [find, patch] = turn.steps;
  assert.deepEqual(find.items.map((i) => i.id), ['b1', 'r1', 'a2']);
  assert.equal(find.stats.commands, 1);
  assert.equal(find.stats.reads, 1);
  assert.equal(noteLine(find.note), 'The token check uses <= instead of <.');
  assert.deepEqual(patch.items.map((i) => i.id), ['e1', 'e2', 'b2']);
  assert.deepEqual(patch.stats.files, ['/p/auth.ts']);
  assert.equal(patch.stats.failed, 1);
  assert.equal(patch.stats.toolSeconds, 12);
  assert.deepEqual(turn.after.items.map((i) => i.id), ['a3']);
  assert.equal(turn.result?.id, 'res');
});

test('a turn without a checklist keeps everything in one group; subagent activity stays under its tool', () => {
  const turns = buildPlan([
    user('u1', 'hi'),
    tool('task', 'Task', { description: 'explore' }),
    { ...tool('inner', 'Bash', { command: 'ls' }), parent: 'task' } as ChatItem,
    say('a1', 'Hello.'),
    user('u2', 'next'),
    say('a2', 'Sure.'),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].hasPlan, false);
  assert.deepEqual(turns[0].before.items.map((i) => i.id), ['task', 'a1']);
  assert.equal(turns[0].before.stats.subagents, 1);
  assert.equal(turns[0].before.stats.commands, 0);
  assert.deepEqual(turns[1].before.items.map((i) => i.id), ['a2']);
});

test('pending approvals are surfaced on the turn', () => {
  const [turn] = buildPlan([
    user('u1', 'deploy'),
    { kind: 'approval', id: 'ap', toolName: 'Bash', input: {}, canAlwaysAllow: false, decision: null },
    { kind: 'approval', id: 'ap2', toolName: 'Bash', input: {}, canAlwaysAllow: false, decision: 'allow' },
  ]);
  assert.deepEqual(turn.pending.map((p) => p.id), ['ap']);
});

test('Codex plan updates land in the timeline once per change', () => {
  let s: ChatSession = { id: 's', agent: 'codex', cwd: '/p', status: 'running', items: [user('u1', 'go')], totalCostUsd: 0, lastSeq: 0 } as ChatSession;
  const plan = [{ content: 'Step one', status: 'in_progress' as const }];
  s = reduceEvent(s, { kind: 'todos', items: plan }, 1);
  s = reduceEvent(s, { kind: 'todos', items: plan }, 2);
  s = reduceEvent(s, { kind: 'todos', items: [{ content: 'Step one', status: 'completed' as const }] }, 3);
  const recorded = s.items.filter((i) => i.kind === 'tool' && i.name === 'TodoWrite');
  assert.equal(recorded.length, 2);
  assert.deepEqual(buildPlan(s.items)[0].steps.map((x) => x.status), ['completed']);
});

test('sessions get the plan instruction unless it is turned off, then the custom prompt', async () => {
  const { sessionInstructions, PLAN_INSTRUCTIONS } = await import('../server/planInstructions');
  assert.equal(sessionInstructions(null), PLAN_INSTRUCTIONS);
  assert.equal(sessionInstructions({ customPrompt: '  Answer in Korean.  ' }), `${PLAN_INSTRUCTIONS}\n\nAnswer in Korean.`);
  assert.equal(sessionInstructions({ alwaysPlan: false, customPrompt: 'Answer in Korean.' }), 'Answer in Korean.');
  assert.equal(sessionInstructions({ alwaysPlan: false }), undefined);
});

test('TaskCreate / TaskUpdate plans: numbered tasks, carried across turns, deletions dropped', () => {
  const created = (id: string, n: number, subject: string) => tool(id, 'TaskCreate', { subject, description: '', activeForm: `${subject}…` }, { output: `Task #${n} created successfully: ${subject}` });
  const upd = (id: string, taskId: string, status: string) => tool(id, 'TaskUpdate', { taskId, status }, { output: `Updated task #${taskId} status` });
  const turns = buildPlan([
    user('u1', 'build it'),
    tool('ts', 'ToolSearch', { query: 'select:TaskCreate,TaskUpdate' }),
    created('c1', 1, 'Write files'),
    created('c2', 2, 'Run tests'),
    created('c3', 3, 'Spare step'),
    upd('s1', '1', 'in_progress'),
    tool('w1', 'Write', { file_path: '/p/a.js' }),
    upd('s2', '1', 'completed'),
    upd('s3', '2', 'in_progress'),
    upd('s4', '3', 'deleted'),
    tool('b1', 'Bash', { command: 'npm test' }),
    user('u2', 'also add a README'),
    tool('w2', 'Write', { file_path: '/p/README.md' }),
    upd('s5', '2', 'completed'),
  ]);
  assert.deepEqual(turns[0].steps.map((s) => [s.content, s.status]), [['Write files', 'completed'], ['Run tests', 'in_progress']]);
  assert.deepEqual(turns[0].steps[0].items.map((i) => i.id), ['w1']);
  assert.deepEqual(turns[0].steps[1].items.map((i) => i.id), ['b1']);
  assert.deepEqual(turns[0].before.items, []);
  // The task still in progress continues in the next turn and takes its work.
  assert.deepEqual(turns[1].steps.map((s) => [s.content, s.status]), [['Run tests', 'completed']]);
  assert.deepEqual(turns[1].steps[0].items.map((i) => i.id), ['w2']);
});

test('a plan written in the reply becomes the checklist, "✓ n." lines clear its steps, "Result:" is the answer', () => {
  const plan = '진행 계획\n1. 1부터 55까지 더하기\n2. 5로 나누기\n3. 나머지에 10 곱하기';
  const live = buildPlan([user('u1', '계획 세워봐'), say('a1', `좋아.\n\n${plan}`), say('a2', '✓ 1. 55×56÷2 = 1540')])[0];
  assert.equal(live.hasPlan, true);
  assert.deepEqual(live.steps.map((s) => [s.content, s.status, s.note]), [
    ['1부터 55까지 더하기', 'completed', '55×56÷2 = 1540'], ['5로 나누기', 'pending', null], ['나머지에 10 곱하기', 'pending', null]]);

  // The same, written the way the previous reply did: bold headings and "1. ✓" marks in one message.
  const done = buildPlan([user('u1', 'x'), say('a1', '**계획**\n1. 더하기\n2. 나누기\n3. 곱하기\n\n**실행**\n1. ✓ 합 = **1540**\n2. ✓ 몫 308, 나머지 0\n3. ✓ 0 × 10 = 0\n\n**결과: 0.** 몫이었다면 3080.')])[0];
  assert.deepEqual(done.steps.map((s) => [s.content, s.status, s.note]), [['더하기', 'completed', '합 = 1540'], ['나누기', 'completed', '몫 308, 나머지 0'], ['곱하기', 'completed', '0 × 10 = 0']]);
  assert.equal(done.answer, '0. 몫이었다면 3080.');

  assert.equal(done.answerFull, false);

  // A "결과:" heading with the answer under it: all of it, as markdown.
  const report = buildPlan([user('u1', 'x'), say('a1', '진행 계획\n1. 정리\n\n✓ 1. 정리함\n\n**결과:**\n## 백엔드\n- 하나\n- 둘')])[0];
  assert.equal(report.answer, '## 백엔드\n- 하나\n- 둘');
  assert.equal(report.answerFull, true);
  const lead = buildPlan([user('u1', 'x'), say('a1', '결과: 정리했어.\n\n- 하나\n- 둘')])[0];
  assert.equal(lead.answer, '정리했어.\n\n- 하나\n- 둘');
  assert.equal(lead.answerFull, true);

  // No plan, no "Result:" line: the reply is the answer, all of it.
  const reply = 'Hello there, nice to meet you.\n\n## Backend\n- one\n- two';
  const plain = buildPlan([user('u1', 'hi'), say('a1', reply)])[0];
  assert.equal(plain.hasPlan, false);
  assert.equal(plain.answer, reply);
  assert.equal(plain.answerFull, true);

  // A plan without a "Result:" line: the gist of the last message.
  const gist = buildPlan([user('u1', 'x'), say('a1', '진행 계획\n1. 더하기\n2. 나누기'), say('a2', 'Both steps are done now. Details follow.\n\n- a')])[0];
  assert.equal(gist.answer, 'Both steps are done now.');
  assert.equal(gist.answerFull, false);
});

test('done marks add the account to steps from the task tools', () => {
  const [turn] = buildPlan([
    user('u1', 'go'),
    tool('c1', 'TaskCreate', { subject: 'First' }, { output: 'Task #1 created successfully: First' }),
    tool('s1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    say('a1', '✓ 1. Did it with a one-liner'),
  ]);
  assert.equal(turn.steps[0].note, 'Did it with a one-liner');
});

test('created files come from new files in the turn changes and from writes onto new paths', () => {
  const [turn] = buildPlan([
    user('u1', 'Write it down'),
    tool('w1', 'Write', { file_path: '/p/REPORT.md' }, { output: 'File created successfully at: /p/REPORT.md (file state is current)' }),
    tool('w2', 'Write', { file_path: '/p/old.md' }, { output: 'The file /p/old.md has been updated successfully.' }),
    tool('w3', 'Write', { file_path: '/p/fail.md' }, { output: 'File created successfully at: /p/fail.md', isError: true }),
    tool('c1', 'FileChange', { changes: [{ path: '/p/new.ts', kind: { type: 'add' } }, { path: '/p/edit.ts', kind: { type: 'update' } }] }),
    { kind: 'changes', id: 'ch', root: '/p', from: 'a', to: 'b', files: [
      { path: 'REPORT.md', status: 'A', additions: 3, deletions: 0, binary: false },
      { path: 'src/x.ts', status: 'M', additions: 1, deletions: 1, binary: false },
      { path: 'img/out.png', status: 'A', additions: 0, deletions: 0, binary: true }] },
  ]);
  assert.deepEqual(turn.created, ['/p/REPORT.md', '/p/new.ts', '/p/img/out.png']);
});

test('a message sent while the agent works joins that request instead of stopping it', () => {
  const result: ChatItem = { kind: 'result', id: 'r1', ok: true, text: '', costUsd: 1, numTurns: 2, durationMs: 9000, at: 20_000 };
  const turns = buildPlan([
    user('u1', 'Fix the dialog'),
    say('a1', '진행 계획\n1. 찾기\n2. 고치기'),
    { kind: 'user', id: 'u2', text: '추가: the close button too', attachments: [], followUp: true },
    say('a2', '✓ 1. 찾았어\n✓ 2. 고쳤어\n\n결과: 둘 다 고침'),
    result,
    { kind: 'user', id: 'u3', text: 'next thing', attachments: [], followUp: true },
  ]);
  assert.equal(turns.length, 2, 'a follow-up after the result is a new request');
  assert.deepEqual(turns[0].additions, ['추가: the close button too']);
  assert.deepEqual(turns[0].steps.map((s) => s.status), ['completed', 'completed']);
  assert.equal(turns[0].result, result);
  assert.equal(turns[0].answer, '둘 다 고침');

  // Without the mark (saved history, or sent while idle) a message is its own request.
  const plain = buildPlan([user('u1', 'a'), say('a1', 'x'), user('u2', 'b')]);
  assert.equal(plain.length, 2);
});

test('files named in the reply or written by shell commands are candidates for created files', async () => {
  const { pathsInText, pathsWritten } = await import('../web/src/lib/planView');
  assert.deepEqual(pathsInText('문서: `REPORT.md`. 이미지는 /tmp/claude/out.png 에 저장. [보기](file:///Users/x/a.pdf), ~/Desktop/r.csv, `foo.bar()`, and/or 1.5x'),
    ['/Users/x/a.pdf', 'REPORT.md', '/tmp/claude/out.png', '~/Desktop/r.csv']);
  assert.deepEqual(pathsWritten('printf hi > out/a.txt; curl -o /tmp/x.zip https://e.com/x 2>/dev/null | tee -a log.md > /dev/null'), ['out/a.txt', '/tmp/x.zip', 'log.md']);

  const [turn] = buildPlan([
    user('u1', 'make it'),
    tool('b1', 'Bash', { command: 'printf 42 > /tmp/claude/data.txt' }),
    say('a1', 'Saved to `/tmp/claude/data.txt` and /tmp/claude/chart.png.'),
  ]);
  assert.deepEqual(turn.mentioned, ['/tmp/claude/data.txt', '/tmp/claude/chart.png']);
});

test('a checked step marks the skipped written steps before it as done', () => {
  const [turn] = buildPlan([
    user('u1', 'x'),
    say('a1', '진행 계획\n1. 파악\n2. 확인\n3. 서버\n4. 웹\n5. 검증'),
    say('a2', '✓ 4. 웹 끝'),
  ]);
  assert.deepEqual(turn.steps.map((s) => [s.status, s.note]), [
    ['completed', null], ['completed', null], ['completed', null], ['completed', '웹 끝'], ['pending', null]]);
});

test('a written plan gets its work filed per step, with stats, time, skipped steps, commits and pushes', () => {
  const bash = (id: string, command: string, output: string, at: number, extra = {}) => tool(id, 'Bash', { command }, { output, at, ...extra });
  const [turn] = buildPlan([
    user('u1', 'ship it'),
    { kind: 'assistant', id: 'a1', text: '진행 계획\n1. 확인\n2. 고치기\n3. 문서\n4. 커밋', thinking: '', parent: null, streaming: false, at: 1000 },
    tool('r1', 'Read', { file_path: '/p/a.ts' }, { at: 2000 }),
    bash('b1', 'npm test', 'fail', 3000, { isError: true }),
    { kind: 'assistant', id: 'a2', text: '✓ 1. 원인 찾음', thinking: '', parent: null, streaming: false, at: 5000 },
    tool('e1', 'Edit', { file_path: '/p/a.ts' }, { at: 6000 }),
    { kind: 'approval', id: 'ap', toolName: 'Bash', input: {}, canAlwaysAllow: false, decision: 'deny' },
    { kind: 'assistant', id: 'a3', text: '✓ 2. 고침\n✓ 3. Not done: 문서는 필요 없음', thinking: '', parent: null, streaming: false, at: 9000 },
    bash('b2', 'git add a.ts && git commit -m "fix: x"', '[main 854020d] fix: x\n 1 file changed', 10000),
    bash('b3', 'git push origin main', 'To github.com:x/y.git', 11000),
    { kind: 'assistant', id: 'a4', text: '✓ 4. 커밋 · push\n\n결과: 끝', thinking: '', parent: null, streaming: false, at: 12000 },
  ]);
  assert.deepEqual(turn.steps.map((s) => s.items.map((i) => i.id)), [['r1', 'b1', 'a2'], ['e1', 'ap', 'a3'], [], ['b2', 'b3', 'a4']]);
  assert.deepEqual(turn.steps[0].stats, { commands: 1, failed: 1, files: [], reads: 1, subagents: 0, toolSeconds: 0, denied: 0, errors: 0 });
  assert.equal(turn.steps[1].stats.denied, 1);
  assert.deepEqual([turn.steps[0].startedAt, turn.steps[0].endedAt], [2000, 5000]);
  assert.deepEqual(turn.steps.map((s) => [s.status, !!s.skipped, s.note]), [
    ['completed', false, '원인 찾음'], ['completed', false, '고침'], ['completed', true, '문서는 필요 없음'], ['completed', false, '커밋 · push']]);
  assert.deepEqual(turn.commits, ['854020d']);
  assert.equal(turn.pushed, true);
});

test('rounds that re-plan the same step stack up as a., b., c. under it, and every plan step is kept', () => {
  const notice = (id: string): ChatItem => ({ kind: 'user', id, text: '<task-notification>done</task-notification>', attachments: [], injected: 'task' as never });
  const [turn] = buildPlan([
    user('u1', 'make all the sounds'),
    say('a1', '진행 계획\n1. 상태 확인\n2. 배치 실행\n3. 보고 연결\n4. 마무리'),
    say('a2', '✓ 1. 전원 연결\n✓ 2. 배치 시작\n✓ 3. watch 연결\n✓ 4. Not done: 아직 도는 중\n\n결과: 진행 중'),
    notice('n1'),
    say('a3', '진행 계획\n1. #10 결과 보고\n\n**#10 `flood_rush`(홍수)**\n- 파일: a.ogg\n\n✓ 1. 알림 결과로 보고\n\n결과: 1개 완료'),
    notice('n2'),
    say('a4', '진행 계획\n1. #11 결과 보고\n2. 정리\n\n**#11 `tsunami_rush`(해일)**\n\n✓ 1. 알림 결과로 보고\n✓ 2. 다 끝남\n\n결과: 전부 완료됐어. #10~11 다 만들었어.'),
  ]);
  assert.deepEqual(turn.steps.map((s) => s.content), ['#11 결과 보고', '정리', '보고 연결', '마무리']);
  assert.deepEqual(turn.steps[0].entries.map((e) => [e.title, e.note, e.detail]), [
    ['상태 확인', '전원 연결', null],
    ['#10 결과 보고', '알림 결과로 보고', '#10 flood_rush(홍수)'],
    ['#11 결과 보고', '알림 결과로 보고', '#11 tsunami_rush(해일)'],
  ]);
  assert.deepEqual(turn.steps[0].entries.map((e) => e.itemId), ['a2', 'a3', 'a4']);
  assert.equal(turn.steps[3].entries[0].skipped, true);
  assert.equal(turn.answer, '전부 완료됐어. #10~11 다 만들었어.');
});

test('a ✓ line takes the title of the plan above it, not of the next round planned in the same message', async () => {
  const { stepEntries } = await import('../web/src/lib/textPlan');
  const entries = stepEntries(['진행 계획\n1. #1 보고', '**#1 a**\n✓ 1. 됨\n\n진행 계획\n1. #2 보고', '**#2 b**\n✓ 1. 됨']);
  assert.deepEqual(entries.map((e) => [e.title, e.detail, e.text]), [['#1 보고', '#1 a', 1], ['#2 보고', '#2 b', 2]]);
});

test('the result keeps every line under its marker, a bare result heading counts, and a later one-liner keeps the full one', () => {
  const answer = (texts: string[]) => { const t = buildPlan([user('u1', 'x'), ...texts.map((x, i) => say(`a${i}`, x))])[0]; return [t.answer, t.answerFull]; };
  // A single line under "결과:" used to be dropped.
  assert.deepEqual(answer(['진행 계획\n1. a\n2. b\n\n✓ 1. a\n✓ 2. b\n\n결과: 둘 다 고쳤어.\n- 검증은 Codex 만 실패']), ['둘 다 고쳤어.\n\n- 검증은 Codex 만 실패', true]);
  // "## 결과" with no colon, the outcome below it.
  assert.deepEqual(answer(['진행 계획\n1. a\n\n✓ 1. a\n\n## 결과\n- 설정 삭제\n- 검증 통과']), ['- 설정 삭제\n- 검증 통과', true]);
  assert.deepEqual(answer(['진행 계획\n1. a\n\n✓ 1. a\n\n**Result**\nAll good.']), ['All good.', true]);
  // Sent back for a missing ✓ line, the agent restates the result in a line: the full one stays under it.
  assert.deepEqual(answer(['진행 계획\n1. a\n2. b\n\n✓ 2. b\n\n결과:\n- 설정 삭제\n- 검증 통과', '✓ 1. a\n\n결과: 끝났어.']), ['끝났어.\n\n- 설정 삭제\n- 검증 통과', true]);
  // Plain prose mentioning the word is not a marker.
  assert.deepEqual(answer(['진행 계획\n1. a\n\n✓ 1. a\n\n결과 보고는 아래에.\n결과: 됐어.']), ['됐어.', false]);
});

test('a plan_step call closes its step like a "✓ n." line, and "✓ 1~3." closes a run of steps', () => {
  const plan = '진행 계획\n1. 파악\n2. 원인\n3. 고치기\n4. 검증';
  const call = (id: string, step: number, note: string, name = 'mcp__vibrato__plan_step'): ChatItem => ({ kind: 'tool', id, toolUseId: id, name, input: { step, note }, done: true, at: 1 } as ChatItem);
  const t = buildPlan([user('u1', 'x'), say('a1', plan), call('t1', 1, '봤어'), call('t2', 2, '찾았어', 'mcp:vibrato/plan_step')])[0];
  assert.deepEqual(t.steps.map((s) => [s.status, s.note]), [['completed', '봤어'], ['completed', '찾았어'], ['pending', null], ['pending', null]]);
  assert.equal(t.steps[0].items.some((it) => it.id === 't1'), true);
  const r = buildPlan([user('u1', 'x'), say('a1', plan), say('a2', '✓ 1~3. 앞 단계 끝')])[0];
  assert.deepEqual(r.steps.map((s) => s.status), ['completed', 'completed', 'completed', 'pending']);
});

test('running subagents are filed under the turn and step whose tool card started them', () => {
  const turns = buildPlan([
    user('u1', 'Investigate'),
    todos('t1', [['Spawn agents', 'in_progress'], ['Wrap up', 'pending']]),
    tool('ag1', 'Agent', { description: 'scan' }),
    tool('ag2', 'Agent', { description: 'probe' }),
    todos('t2', [['Spawn agents', 'completed'], ['Wrap up', 'in_progress']]),
    tool('bg1', 'Bash', { command: 'sleep 100', run_in_background: true }),
    { kind: 'result', id: 'res', ok: true, text: '', costUsd: 0.1, numTurns: 3, durationMs: 9000 },
  ]);
  const task = (id: string, extra: Partial<TaskInfo>): TaskInfo => ({ id, type: 'local_agent', description: id, status: 'running', startedAt: 1, ...extra });
  const tasks: Record<string, TaskInfo> = {
    a: task('a', { toolUseId: 'ag1' }),
    b: task('b', { toolUseId: 'ag2', status: 'completed' }),
    c: task('c', { toolUseId: 'nested-card', parentId: 'a' }),
    d: task('d', { toolUseId: 'bg1', type: 'local_bash' }),
    e: task('e', {}),
    f: task('f', { toolUseId: 'ag2', ambient: true }),
  };
  const got = liveTasksByTurn(turns, tasks).get(turns[0].id)!;
  assert.deepEqual(got.all.map((x) => x.id).sort(), ['a', 'c', 'd', 'e']);
  assert.deepEqual(got.byStep.get(0)?.map((x) => x.id), ['a', 'c']);
  assert.deepEqual(got.byStep.get(1)?.map((x) => x.id), ['d']);
  assert.deepEqual(got.unplaced.map((x) => x.id), ['e']);
  assert.equal(liveTasksByTurn(turns, { b: tasks.b }).size, 0);
});

test('a turn knows when its "Result:" section has started, even while it streams', () => {
  const base: ChatItem[] = [
    user('u1', 'Do it'),
    say('a1', 'Plan\n1. One\n2. Two'),
    say('a2', '✓ 1. did one\n✓ 2. did two'),
  ];
  const [before] = buildPlan(base);
  assert.equal(before.steps.every((s) => s.status === 'completed'), true);
  assert.equal(before.hasResult, false);
  const [writing] = buildPlan([...base, { ...(say('a3', 'Result: half of the') as Extract<ChatItem, { kind: 'assistant' }>), streaming: true }]);
  assert.equal(writing.hasResult, true);
  assert.match(writing.answer ?? '', /half of the/);
});
