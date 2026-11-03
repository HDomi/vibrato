import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import UsageBar, { UsageChip, untilReset } from '../web/src/components/UsageBar';
import { normalizeClaudeUsage, queryClaudeUsage, type UsageQuery } from '../server/claudeUsage';

test('usage buttons distinguish zero usage, exhausted quota and unavailable data', () => {
  const zero = renderToStaticMarkup(<UsageChip agent="claude" label="5h" win={{ usedPct: 0, resetsAt: null }} loading={false} />);
  assert.match(zero, /100%/); assert.match(zero, /0% used/);
  const exhausted = renderToStaticMarkup(<UsageChip agent="claude" label="5h" win={{ usedPct: 100, resetsAt: null }} loading={false} />);
  assert.match(exhausted, /5h: 0%</);
  const missing = renderToStaticMarkup(<UsageChip agent="codex" label="5h" win={null} error="HTTP 429" loading={false} />);
  assert.match(missing, /5h/); assert.match(missing, /—/); assert.match(missing, /HTTP 429/);
  assert.doesNotMatch(missing, /100%/);
  const initial = renderToStaticMarkup(<UsageBar mode="vibe" onMode={() => {}} />);
  assert.match(initial, /data-agent="claude"/); assert.match(initial, /data-agent="codex"/);
});

test('Claude current meter rows take precedence over legacy fields and retain model usage', () => {
  const usage = normalizeClaudeUsage({ subscription_type: 'team', rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 10 }, seven_day: { utilization: 20 },
    limits: [
      { kind: 'session', group: 'session', percent: 100, resets_at: '2026-10-19T08:49:59Z' },
      { kind: 'weekly_all', group: 'weekly', percent: 73, resets_at: '2026-10-20T18:59:59Z' },
      { kind: 'weekly_scoped', group: 'weekly', percent: 61, scope: { model: { display_name: 'Fable' } } },
    ],
  } });
  assert.equal(usage?.plan, 'team');
  assert.equal(usage?.fiveHour?.usedPct, 100);
  assert.equal(usage?.fiveHour?.resetsAt, Date.parse('2026-10-19T08:49:59Z') / 1000);
  assert.equal(usage?.weekly?.usedPct, 73);
  assert.equal(usage?.model?.usedPct, 61);
  assert.equal(usage?.model?.name, 'Fable');
});

test('Claude structured usage accepts zero, legacy windows and model_scoped while retaining unknowns', () => {
  const usage = normalizeClaudeUsage({ subscription_type: 'max', rate_limits: {
    five_hour: { utilization: 0, resets_at: 1792400000 },
    seven_day: { utilization: null },
    model_scoped: [{ display_name: 'Opus', utilization: 42, resets_at: null }],
  } });
  assert.equal(usage?.fiveHour?.usedPct, 0);
  assert.equal(usage?.fiveHour?.resetsAt, 1792400000);
  assert.equal(usage?.weekly, null);
  assert.equal(usage?.model?.usedPct, 42);
  assert.equal(normalizeClaudeUsage({ rate_limits_available: false, rate_limits: null }), null);
  for (const value of [null, {}, { rate_limits: null }, { rate_limits: { five_hour: { utilization: null } } }, { rate_limits: { five_hour: { utilization: 'invalid' } } }]) {
    assert.throws(() => normalizeClaudeUsage(value));
  }
});

for (const outcome of ['success', 'error', 'timeout', 'unsupported']) {
  test(`Claude usage control request closes its process on ${outcome}`, async () => {
    let closed = false, controller: AbortController | undefined, finished = false;
    const result = queryClaudeUsage((abort) => {
      controller = abort;
      const q: UsageQuery = {
        async *[Symbol.asyncIterator]() {
          if (!abort.signal.aborted) await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }));
          finished = true;
        },
        close: () => { closed = true; },
      };
      if (outcome !== 'unsupported') q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async (options) => {
        assert.deepEqual(options, { skipBehaviors: true });
        if (outcome === 'error') throw new Error('Usage unavailable');
        if (outcome === 'timeout') return new Promise(() => {});
        return { rate_limits: { five_hour: { utilization: 0 } } };
      };
      return q;
    }, 10);
    if (outcome === 'success') assert.equal((await result)?.fiveHour?.usedPct, 0);
    else await assert.rejects(result, outcome === 'timeout' ? /timed out/ : outcome === 'unsupported' ? /Update Claude Code/ : /Usage unavailable/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, true);
    assert.equal(controller?.signal.aborted, true);
    if (outcome !== 'unsupported') assert.equal(finished, true);
  });
}

test('battery reset countdown shows days, hours and minutes, dropping leading zeros', () => {
  const now = Date.UTC(2026, 9, 20, 0, 0, 0);
  const at = (mins: number) => (now + mins * 60000) / 1000;
  assert.equal(untilReset(at(2 * 1440 + 3 * 60 + 15), now), '2d 3h 15m');
  assert.equal(untilReset(at(1440), now), '1d 0h 0m');
  assert.equal(untilReset(at(185), now), '3h 5m');
  assert.equal(untilReset(at(7), now), '7m');
  assert.equal(untilReset((now + 20000) / 1000, now), '1m');
  assert.equal(untilReset(at(0), now), null);
});
