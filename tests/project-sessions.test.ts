import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteProjectSessions } from '../server/projectSessions.ts';

function deps(over: Partial<Parameters<typeof deleteProjectSessions>[0]> = {}) {
  const gone: string[] = [];
  return {
    gone,
    d: {
      claude: async () => [{ sessionId: 'c1' }, { sessionId: 'c2' }, { sessionId: 'c3' }],
      codex: async () => [{ sessionId: 'x1' }],
      deleteClaude: async (id: string) => { gone.push(`claude:${id}`); },
      deleteCodex: async (id: string) => { gone.push(`codex:${id}`); },
      pinned: new Set<string>(),
      open: new Set<string>(),
      ...over,
    },
  };
}

test('every Claude and Codex session of the project is deleted', async () => {
  const { d, gone } = deps();
  assert.deepEqual(await deleteProjectSessions(d), { deleted: 4, keptPinned: 0, keptOpen: 0, failed: 0 });
  assert.deepEqual(gone, ['claude:c1', 'claude:c2', 'claude:c3', 'codex:x1']);
});

test('pinned and open sessions are kept and counted', async () => {
  const { d, gone } = deps({ pinned: new Set(['claude:c2', 'codex:x1']), open: new Set(['c3']) });
  assert.deepEqual(await deleteProjectSessions(d), { deleted: 1, keptPinned: 2, keptOpen: 1, failed: 0 });
  assert.deepEqual(gone, ['claude:c1']);
});

test('a failed delete is counted and the rest go on; a list that fails counts as empty', async () => {
  const { d, gone } = deps({ deleteClaude: async (id) => { if (id === 'c2') throw new Error('locked'); gone.push(`claude:${id}`); }, codex: async () => { throw new Error('no codex'); } });
  assert.deepEqual(await deleteProjectSessions(d), { deleted: 2, keptPinned: 0, keptOpen: 0, failed: 1 });
  assert.deepEqual(gone, ['claude:c1', 'claude:c3']);
});
