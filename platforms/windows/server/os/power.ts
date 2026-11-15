import { spawn, type ChildProcess } from 'node:child_process';
import { powershell } from './powershell.js';

/* Windows: the power line status from System.Windows.Forms, and SetThreadExecutionState to hold the machine awake. */

export type PowerSource = 'ac' | 'battery';

/** `PowerLineStatus`: Online, Offline or Unknown. Null when unknown. */
export function parsePowerSource(out: string): PowerSource | null {
  if (/^Offline$/im.test(out)) return 'battery';
  if (/^Online$/im.test(out)) return 'ac';
  return null;
}

/** The machine's current power source; null when it cannot be read. */
export async function readPowerSource(): Promise<PowerSource | null> {
  const r = await powershell('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus', {}, 8000);
  return r.ok ? parsePowerSource(r.stdout) : null;
}

const EXECUTION_STATE = `Add-Type -Namespace Vibrato -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'`;
const args = (script: string) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];

/**
 * No idle system sleep while the returned process lives (ES_CONTINUOUS | ES_SYSTEM_REQUIRED; the display may still
 * sleep). The helper waits for this process, so it never outlives the server.
 */
export function keepAwake(): ChildProcess | null {
  return spawn('powershell.exe', args(`${EXECUTION_STATE}; [void][Vibrato.Power]::SetThreadExecutionState(0x80000001); Wait-Process -Id ${process.pid}`), { stdio: 'ignore', windowsHide: true });
}

/** Wake the display: display and system required for a few seconds. */
export function wakeDisplay(): void {
  const child = spawn('powershell.exe', args(`${EXECUTION_STATE}; [void][Vibrato.Power]::SetThreadExecutionState(0x80000003); Start-Sleep -Seconds 3`), { stdio: 'ignore', windowsHide: true });
  child.on('error', () => { /* best effort */ });
  child.unref();
}
