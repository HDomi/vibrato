import { useCallback, useRef } from 'react';

/** A handler with a stable identity that always runs the latest `fn`, so memoized children skip re-rendering. Call it from events, not during render. */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args: A) => latest.current(...args), []);
}
