import type { ChildProcess } from 'node:child_process';
import { keepAwake } from './power.js';

/**
 * Power side of scheduled runs on Windows: the machine is held awake while a run is near or running. Waking a
 * sleeping PC for a run (what the macOS wake helper does) is not offered.
 */

export interface PowerStatus { helper: boolean; awake: boolean; wakeAt: number | null; error: string | null }

export class SchedulePower {
  private child: ChildProcess | null = null;

  constructor(_tag: string) { /* the tag only names wake events, which this target does not schedule */ }

  status(): PowerStatus {
    return { helper: false, awake: !!this.child, wakeAt: null, error: null };
  }

  holdAwake(on: boolean) {
    if (on && !this.child) {
      const child = keepAwake();
      if (!child) return;
      child.on('error', (err) => { console.warn(`[vibrato] keep-awake failed: ${err.message}`); if (this.child === child) this.child = null; });
      child.on('exit', () => { if (this.child === child) this.child = null; });
      this.child = child;
    } else if (!on && this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  async helperInstalled(_refresh = false): Promise<boolean> { return false; }
  async syncWake(_target: number | null): Promise<void> { /* no wake events */ }
  async setHelper(_install: boolean, _prompt: string): Promise<'ok' | 'cancelled'> {
    throw new Error('Waking the computer for a scheduled run is not available on Windows');
  }

  stop() { this.holdAwake(false); }
}
