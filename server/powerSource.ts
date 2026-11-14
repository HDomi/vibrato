import { execFile } from 'node:child_process';

export type PowerSource = 'ac' | 'battery';

/** `pmset -g ps` starts with "Now drawing from 'AC Power'" (or 'Battery Power', 'UPS Power'). Null when unknown. */
export function parsePowerSource(out: string): PowerSource | null {
  const m = /drawing from '([^']+)'/.exec(out);
  if (!m) return null;
  return /battery/i.test(m[1]) ? 'battery' : 'ac';
}

/** The Mac's current power source; null off macOS or when pmset fails. */
export function readPowerSource(): Promise<PowerSource | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('/usr/bin/pmset', ['-g', 'ps'], { timeout: 5000 }, (err, stdout) => resolve(err ? null : parsePowerSource(String(stdout))));
  });
}
