const n = (v: unknown) => (typeof v === 'number' ? v : 0);

/** Token count of a result's `usage` (snake_case) or of one `modelUsage` entry (camelCase). */
export function tokenSum(usage: object | null | undefined): number {
  if (!usage) return 0;
  const u = usage as Record<string, unknown>;
  return n(u.input_tokens ?? u.inputTokens) + n(u.output_tokens ?? u.outputTokens)
    + n(u.cache_read_input_tokens ?? u.cacheReadInputTokens) + n(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens);
}

/**
 * One turn's share of a result's `total_cost_usd`, which counts the whole session: it adds up across turns and,
 * when the CLI restores the session's cost on resume, across relaunches too.
 * `last` is the total after the previous turn of this session object (null when unknown: the first turn after a
 * resume). `turnTokens` comes from the result's `usage` (this turn only), `sessionTokens` from its `modelUsage`
 * (everything the total covers). Undefined when the share cannot be told.
 */
export function turnCost(total: number, last: number | null, turnTokens: number, sessionTokens: number): number | undefined {
  // A total below the last one means the relaunched CLI started counting again.
  if (last !== null) return total >= last ? total - last : total;
  // Nothing before this turn was counted (a resume that did not restore the cost): all of it is this turn.
  return sessionTokens < turnTokens * 1.5 ? total : undefined;
}
