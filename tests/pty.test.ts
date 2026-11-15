import assert from 'node:assert/strict';
import test from 'node:test';
import { workInProgress } from '../web/src/lib/power';

test('the Mac stays awake only for a running agent turn or a busy shell', () => {
  assert.equal(workInProgress([{ status: 'idle' }, { status: 'closed' }], false), false);
  assert.equal(workInProgress([{ status: 'idle' }, { status: 'running' }], false), true);
  assert.equal(workInProgress([{ status: 'compacting' }], false), true);
  assert.equal(workInProgress([], true), true);
  assert.equal(workInProgress([], false), false);
});
