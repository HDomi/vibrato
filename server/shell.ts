import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { loginShellPath, lookupCommand, shellCommand, signalProcessTree, startable } from './os/shell.js';

// How commands reach the user's shell is the platform's business (os/shell.ts); the cache, run and streaming are shared.
export { loginShell, shellCommand, signalProcessTree, startable } from './os/shell.js';

const execFileP = promisify(execFile);

/** Take PATH from the user's login shell where the platform has one. */
export async function syncLoginShellPath(): Promise<string> {
  try {
    const p = await loginShellPath();
    if (p) process.env.PATH = p;
  } catch {
    /* keep current PATH */
  }
  return process.env.PATH ?? '';
}

/**
 * Lookups are cached for a few minutes: the sidebar, usage bar and tool checks call this every minute,
 * and each miss spawns a login shell. A cached path that no longer exists is looked up again.
 */
const WHICH_TTL_MS = 5 * 60 * 1000;
const whichCache = new Map<string, { at: number; path: Promise<string | null> }>();

export async function which(cmd: string): Promise<string | null> {
  const hit = whichCache.get(cmd);
  if (hit && Date.now() - hit.at < WHICH_TTL_MS) {
    const p = await hit.path;
    if (!p || await access(p).then(() => true, () => false)) return p;
  }
  const path = lookupCommand(cmd);
  whichCache.set(cmd, { at: Date.now(), path });
  return path;
}

/** Drop cached lookups, e.g. after an install or update put a CLI somewhere new. */
export function forgetCommandPaths() { whichCache.clear(); }

export async function run(cmd: string, args: string[], timeout = 15000): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  try {
    const start = startable(cmd, args);
    const { stdout, stderr } = await execFileP(start.file, start.args, { timeout, maxBuffer: 32 * 1024 * 1024, env: process.env, windowsHide: true });
    return { stdout: stdout.trim(), stderr: stderr.trim(), ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { stdout: (e.stdout ?? '').trim(), stderr: (e.stderr ?? e.message).trim(), ok: false };
  }
}

/** Run a shell command line in a login shell, streaming output lines. */
export function streamShell(commandLine: string, onLine: (line: string, stream: 'stdout' | 'stderr') => void, timeoutMs = 30 * 60 * 1000): Promise<number> {
  return new Promise((resolve) => {
    const sh = shellCommand(commandLine);
    const child = spawn(sh.file, sh.args, { env: process.env, ...sh.options, stdio: 'pipe' });
    let timedOut = false;
    let forceStop: ReturnType<typeof setTimeout> | undefined;
    const stop = setTimeout(() => {
      timedOut = true;
      onLine('Command exceeded its time limit; stopping the process group.', 'stderr');
      try { if (child.pid) signalProcessTree(child.pid, 'SIGTERM'); } catch { /* already exited */ }
      forceStop = setTimeout(() => { try { if (child.pid) signalProcessTree(child.pid, 'SIGKILL'); } catch { /* already exited */ } }, 5000);
    }, timeoutMs);
    const pump = (src: NodeJS.ReadableStream, stream: 'stdout' | 'stderr') => {
      let buf = '';
      src.on('data', (d: Buffer) => {
        buf += d.toString();
      const lines = buf.split(/\r\n|\r|\n/);
        buf = lines.pop() ?? '';
        for (const l of lines) onLine(l, stream);
      if (buf.length > 65536) { onLine(buf, stream); buf = ''; }
      });
      src.on('end', () => { if (buf) onLine(buf, stream); });
    };
    pump(child.stdout, 'stdout');
    pump(child.stderr, 'stderr');
    child.on('error', (err) => { clearTimeout(stop); onLine(err.message, 'stderr'); resolve(1); });
    child.on('close', (code) => { clearTimeout(stop); if (forceStop) clearTimeout(forceStop); resolve(timedOut ? 124 : code ?? 1); });
    child.on('error', (err) => { onLine(String(err), 'stderr'); resolve(1); });
  });
}
