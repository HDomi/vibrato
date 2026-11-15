import { execFile, spawn, type ChildProcess } from 'node:child_process';

export type PowerSource = 'ac' | 'battery';

/** `pmset -g ps` starts with "Now drawing from 'AC Power'" (or 'Battery Power', 'UPS Power'). Null when unknown. */
export function parsePowerSource(out: string): PowerSource | null {
  const m = /drawing from '([^']+)'/.exec(out);
  if (!m) return null;
  return /battery/i.test(m[1]) ? 'battery' : 'ac';
}

/** The Mac's current power source; null when pmset fails. */
export function readPowerSource(): Promise<PowerSource | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/pmset', ['-g', 'ps'], { timeout: 5000 }, (err, stdout) => resolve(err ? null : parsePowerSource(String(stdout))));
  });
}

/**
 * No idle system sleep while the returned process lives (the display may still sleep; a closed lid on battery
 * still sleeps). Tied to this process (-w) so it never outlives the server.
 */
export function keepAwake(): ChildProcess | null {
  return spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
}

/** Wake the display: user activity for a few seconds. */
export function wakeDisplay(): void {
  const child = spawn('/usr/bin/caffeinate', ['-u', '-t', '3'], { stdio: 'ignore' });
  child.on('error', () => { /* best effort */ });
  child.unref();
}
