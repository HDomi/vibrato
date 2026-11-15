import assert from 'node:assert/strict';
import test from 'node:test';

test('permissions: TCC and PhotoKit states', async () => {
  const { tccState, photosState } = await import('../server/os/privacy');
  assert.equal(tccState(2), 'granted');
  assert.equal(tccState(3), 'limited');
  assert.equal(tccState(0), 'denied');
  assert.equal(tccState(1), 'unknown');
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(photosState), ['notDetermined', 'restricted', 'denied', 'granted', 'limited', 'unknown']);
});

test('permissions: reset only takes known TCC services', async () => {
  const { resetPermission } = await import('../server/os/privacy');
  await assert.rejects(resetPermission('All; rm -rf /'), /Unknown service/);
  await assert.rejects(resetPermission('Calendar'), /Unknown service/);
});
