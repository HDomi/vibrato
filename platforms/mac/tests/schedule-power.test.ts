import assert from 'node:assert/strict';
import test from 'node:test';
import { HELPER_SCRIPT, parseOwnWakes, sudoersRule } from '../server/os/schedulePower';

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
