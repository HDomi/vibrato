import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePowerSource } from '../server/powerSource.js';

test('power source from pmset -g ps', () => {
  assert.equal(parsePowerSource("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t55%; discharging; 3:30 remaining present: true\n"), 'battery');
  assert.equal(parsePowerSource("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n"), 'ac');
  assert.equal(parsePowerSource("Now drawing from 'UPS Power'\n"), 'ac');
  assert.equal(parsePowerSource(''), null);
});
