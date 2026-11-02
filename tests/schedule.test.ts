import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanSchedule, dueAction, earliestNext, latestOccurrence, promptText, ScheduleError, type Schedule, type ScheduleRun } from '../server/schedule';
import { HELPER_SCRIPT, parseOwnWakes, sudoersRule } from '../server/schedulePower';
import { describeCron, parseCron } from '../web/src/lib/toolbox/cron';

const at = (h: number, m = 0, d = 29) => new Date(2026, 9, d, h, m).getTime();
const base = (over: Partial<Schedule> = {}): Schedule => ({
  id: 's1', name: 'n', cwd: '/tmp', agent: 'claude', skill: 'weekly-report', prompt: '', cron: '0 3 * * *', permissionMode: 'acceptEdits',
  enabled: true, graceMinutes: 720, power: 'awake', createdAt: at(0), cursor: at(0), ...over,
});

test('schedule: due on time, caught up after sleep within grace, missed beyond it', () => {
  assert.equal(dueAction(base(), at(2, 59)), null);
  assert.deepEqual(dueAction(base(), at(3, 0)), { kind: 'run', at: at(3) });
  // Woke at 09:00: six hours late, inside the 12 h grace.
  assert.deepEqual(dueAction(base(), at(9)), { kind: 'run', at: at(3) });
  // One-hour grace: 09:00 is too late; recorded once as missed.
  assert.deepEqual(dueAction(base({ graceMinutes: 60 }), at(9)), { kind: 'missed', at: at(3) });
  // Zero grace still runs what the next tick finds.
  assert.deepEqual(dueAction(base({ graceMinutes: 0 }), at(3, 1)), { kind: 'run', at: at(3) });
  // Already handled.
  assert.equal(dueAction(base({ cursor: at(3, 0) + 20000 }), at(9)), null);
  // Several passed occurrences collapse into the latest one.
  assert.deepEqual(dueAction(base({ cron: '*/15 * * * *', cursor: at(1) }), at(2, 7)), { kind: 'run', at: at(2) });
  assert.equal(latestOccurrence('0 3 * * *', at(3), at(4)), null);
});

test('schedule: prompt text, earliest next run, validation', () => {
  assert.equal(promptText({ skill: 'weekly-report', prompt: '' }), '/weekly-report');
  assert.equal(promptText({ skill: 'sweet:sweet-commit', prompt: '  --all ' }), '/sweet:sweet-commit --all');
  assert.equal(promptText({ skill: '', prompt: 'run the tests\n' }), 'run the tests');

  const list = [base({ id: 'a', cron: '0 5 * * *' }), base({ id: 'b', cron: '30 4 * * *', power: 'wake' }), base({ id: 'c', cron: '0 1 * * *', enabled: false })];
  assert.equal(earliestNext(list, at(0), ['awake', 'wake']), at(4, 30));
  assert.equal(earliestNext(list, at(0), ['wake']), at(4, 30));
  assert.equal(earliestNext(list, at(0), ['none']), null);

  const s = cleanSchedule({ cwd: '/tmp/p', agent: 'codex', skill: '/deploy', cron: '0 9 * * 1-5', permissionMode: 'auto' }, null, 1000, 'id');
  assert.equal(s.skill, 'deploy');
  assert.equal(s.permissionMode, 'default');
  assert.equal(s.name, '/deploy');
  assert.equal(s.cursor, 1000);
  assert.equal(s.power, 'awake');
  assert.throws(() => cleanSchedule({ cwd: 'rel', agent: 'claude', prompt: 'x', cron: '* * * * *' }, null, 0, 'i'), ScheduleError);
  assert.throws(() => cleanSchedule({ cwd: '/a', agent: 'claude', cron: '* * * * *' }, null, 0, 'i'), /skill or write a prompt/);
  assert.throws(() => cleanSchedule({ cwd: '/a', agent: 'claude', prompt: 'x', cron: '61 * * * *' }, null, 0, 'i'), ScheduleError);
  assert.throws(() => cleanSchedule({ cwd: '/a', agent: 'claude', skill: 'a b', cron: '* * * * *' }, null, 0, 'i'), /Invalid skill/);

  // A schedule may continue a past conversation instead of starting fresh; the title only matters with an id.
  const r = cleanSchedule({ cwd: '/a', agent: 'claude', prompt: 'go on', cron: '* * * * *', resumeSessionId: '0f2b-abc', resumeTitle: ' Fix login ' }, null, 0, 'i');
  assert.equal(r.resumeSessionId, '0f2b-abc');
  assert.equal(r.resumeTitle, 'Fix login');
  assert.equal(cleanSchedule({ cwd: '/a', agent: 'claude', prompt: 'x', cron: '* * * * *', resumeTitle: 't' }, null, 0, 'i').resumeTitle, undefined);
  assert.equal(cleanSchedule({ resumeSessionId: '' }, r, 1, 'i').resumeSessionId, undefined);
  assert.throws(() => cleanSchedule({ cwd: '/a', agent: 'claude', prompt: 'x', cron: '* * * * *', resumeSessionId: 'a b' }, null, 0, 'i'), /Invalid session id/);

  // Renaming keeps the cursor; changing the timetable or re-enabling moves it to now.
  const prev = base({ cursor: 5 });
  assert.equal(cleanSchedule({ name: 'x' }, prev, 99, 's1').cursor, 5);
  assert.equal(cleanSchedule({ cron: '0 4 * * *' }, prev, 99, 's1').cursor, 99);
  assert.equal(cleanSchedule({ enabled: true }, { ...prev, enabled: false }, 99, 's1').cursor, 99);
});

test('schedule power: own wake events parsed from pmset, sudoers rule and helper argument checks', () => {
  const out = `Scheduled power events:
 [0]  wake at 10/30/2026 02:58:00 by 'Vibrato.11398'
 [1]  wake at 10/30/2026 03:00:00 by 'Vibrato.11500'
 [2]  wake at 10/29/2026 14:59:33 by 'com.apple.alarm.user-invisible-com.apple.calaccessd.travelEngine.periodicRefreshTimer'
`;
  assert.deepEqual(parseOwnWakes(out, '11398'), [new Date(2026, 9, 30, 2, 58).getTime()]);
  assert.deepEqual(parseOwnWakes('', '11398'), []);
  assert.match(sudoersRule('im_1767'), /^im_1767 ALL=\(root\) NOPASSWD: \/Library\/PrivilegedHelperTools\/com\.hdomi\.vibrato\.wake$/m);
  assert.throws(() => sudoersRule('bad user'));
  assert.match(HELPER_SCRIPT, /case "\$2" in ''\|\*\[!0-9\]\*\) exit 64/);
  assert.match(HELPER_SCRIPT, /\[ "\$\{#2\}" -le 11 \]/);
  assert.match(HELPER_SCRIPT, /pmset schedule wake "\$when" "Vibrato\.\$3"/);
});

test('schedule watch: notifies status changes worth telling, never on the first poll', async () => {
  const { runTransitions } = await import('../web/src/lib/scheduleWatch');
  const run = (id: string, status: ScheduleRun['status']): ScheduleRun => ({ id, scheduleId: 's', name: 'n', cwd: '/p', agent: 'claude', trigger: 'schedule', scheduledFor: 0, startedAt: 0, status });
  assert.deepEqual(runTransitions(null, [run('a', 'done')]), []);
  const prev = new Map([['a', run('a', 'running')], ['b', run('b', 'done')]]);
  const out = runTransitions(prev, [run('a', 'waiting'), run('b', 'done'), run('c', 'missed'), run('d', 'running')]);
  assert.deepEqual(out.map((r) => [r.id, r.status]), [['a', 'waiting'], ['c', 'missed']]);
});

test('cron description: either day field may match, months, repeats, both languages', () => {
  const d = (e: string, lang: 'ko' | 'en') => describeCron(parseCron(e), lang);
  assert.equal(d('59 23 3 11 1', 'ko'), '11월 3일 또는 11월의 매주 월요일 23:59');
  assert.equal(d('59 23 3 11 1', 'en'), 'November 3 or every Monday in November at 23:59');
  assert.equal(d('0 9 * * 1-5', 'ko'), '매주 월~금 09:00');
  assert.equal(d('0 9 * * 1-5', 'en'), 'Every Mon–Fri at 09:00');
  assert.equal(d('0 3 1 * *', 'ko'), '매월 1일 03:00');
  assert.equal(d('0 3 1 * *', 'en'), 'Day 1 of every month at 03:00');
  assert.equal(d('30 18 * 11 *', 'ko'), '11월 매일 18:30');
  assert.equal(d('*/15 9-18 * * 1-5', 'ko'), '매주 월~금 09:00~18:59 사이 15분마다');
  assert.equal(d('*/15 9-18 * * 1-5', 'en'), 'Every 15 minutes between 09:00 and 18:59, every Mon–Fri');
  assert.equal(d('0 */6 * * *', 'ko'), '6시간마다 정각');
  assert.equal(d('0 */6 * * *', 'en'), 'Every 6 hours at :00');
  assert.equal(d('0 * * * *', 'ko'), '매시 정각');
  // "0,30" is two clock minutes, not "every 30 minutes"; "*/30" is the repeat.
  assert.equal(d('0,30 9,18 * * *', 'ko'), '매일 09:00 · 09:30 · 18:00 · 18:30');
  assert.equal(d('*/30 9,18 * * *', 'ko'), '9, 18시에 30분마다');
  assert.equal(d('* * * * *', 'en'), 'Every minute');
  assert.equal(d('0 9 * * 1,3,5', 'ko'), '매주 월, 수, 금요일 09:00');
  assert.equal(d('@yearly', 'en'), 'January 1 at 00:00');
  assert.equal(d('59 23 3 11 *', 'ko'), '11월 3일 23:59');
});
