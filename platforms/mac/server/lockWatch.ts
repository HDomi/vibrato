import { execFile, spawn } from 'node:child_process';

/*
 * Failsafe for the app's lock screen (electron/lockScreen.cts). While locked, the Electron main process
 * POSTs a beat every 10s. If it hangs, the lock screen cannot be dismissed and kiosk mode has disabled
 * Force Quit, so the only way out would be a hard power-off that also kills the agent sessions. Those
 * sessions live here, in the server, which survives the app: so when the beats stop, the server kills the
 * app and reopens it (unlocked; the new app attaches to this server and its sessions).
 */

export interface LockBeat { active: boolean; pid?: number; exe?: string; bundle?: string | null; timeoutMs?: number }
interface Watch { pid: number; exe: string; bundle: string | null; timeoutMs: number; lastBeat: number }

const CHECK_MS = 5000;
let watch: Watch | null = null;
let timer: NodeJS.Timeout | null = null;
let lastTick = 0;

/** Injected in tests. */
export const deps = {
  now: () => Date.now(),
  /** Executable path of a running pid, or null. */
  exeOf: (pid: number) => new Promise<string | null>((resolve) => execFile('/bin/ps', ['-o', 'comm=', '-p', String(pid)], (err, out) => resolve(err ? null : out.trim() || null))),
  kill: (pid: number) => process.kill(pid, 'SIGKILL'),
  reopen: (bundle: string) => { spawn('/usr/bin/open', [bundle], { detached: true, stdio: 'ignore' }).unref(); },
  log: (msg: string) => console.error(msg),
};

function stop() {
  watch = null;
  if (timer) { clearInterval(timer); timer = null; }
}

/** Validates a beat. Only an absolute executable inside the given .app bundle may be reopened. */
export function lockBeat(b: LockBeat): { ok: boolean } {
  if (!b || typeof b !== 'object') return { ok: false };
  if (b.active !== true) { stop(); return { ok: true }; }
  const { pid, exe } = b;
  if (!Number.isInteger(pid) || (pid as number) <= 1 || typeof exe !== 'string' || !exe.startsWith('/')) return { ok: false };
  const bundle = typeof b.bundle === 'string' && b.bundle.endsWith('.app') && exe.startsWith(`${b.bundle}/Contents/MacOS/`) ? b.bundle : null;
  const timeoutMs = Math.min(300000, Math.max(20000, Number(b.timeoutMs) || 40000));
  watch = { pid: pid as number, exe, bundle, timeoutMs, lastBeat: deps.now() };
  if (!timer) { lastTick = deps.now(); timer = setInterval(() => void checkLockWatch(), CHECK_MS); timer.unref?.(); }
  return { ok: true };
}

/** One watchdog tick (exported for tests). */
export async function checkLockWatch(): Promise<void> {
  const now = deps.now();
  // A late tick means the Mac was asleep: the app was frozen too, so start counting again.
  if (now - lastTick > CHECK_MS * 3 && watch) watch.lastBeat = now;
  lastTick = now;
  const w = watch;
  if (!w || now - w.lastBeat < w.timeoutMs) return;
  stop();
  // Only kill the process that sent the beats (a reused pid runs another executable).
  if ((await deps.exeOf(w.pid)) !== w.exe) return;
  deps.log(`[lock-watch] app (pid ${w.pid}) stopped responding while locked; restarting it`);
  try { deps.kill(w.pid); } catch { return; }
  if (w.bundle) setTimeout(() => deps.reopen(w.bundle!), 1500);
}

export const lockWatchState = () => (watch ? { pid: watch.pid, lastBeat: watch.lastBeat } : null);
