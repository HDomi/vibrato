import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenSum, turnCost } from '../server/agents/turnCost.ts';

test('tokenSum reads both the usage and the modelUsage shapes', () => {
  assert.equal(tokenSum({ input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 25421, cache_creation_input_tokens: 0 }), 25426);
  assert.equal(tokenSum({ inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 51060, cacheCreationInputTokens: 0, costUSD: 1 }), 51070);
  assert.equal(tokenSum(undefined), 0);
});

test('turnCost takes each turn its share of the running total', () => {
  // A new session: the first turn is all of it, the next the difference.
  assert.equal(turnCost(0.00038, 0, 25426, 26613), 0.00038);
  assert.ok(Math.abs(turnCost(0.00122, 0.00038, 28130, 54743)! - 0.00084) < 1e-12);
  // A relaunch that started counting again.
  assert.equal(turnCost(0.2, 5, 1000, 1000), 0.2);
  // The first turn after a resume: a restored total cannot be split, a fresh one is all this turn.
  assert.equal(turnCost(0.000514, null, 25644, 51070), undefined);
  assert.equal(turnCost(0.00026, null, 25426, 26613), 0.00026);
});
