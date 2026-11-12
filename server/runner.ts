import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePath } from './fs.js';

/**
 * Project scripts (dev servers, watchers, builds) run by the Run panel. The server owns the processes,
 * so they survive a page reload; each keeps its recent output for late subscribers and is stopped as a
 * whole process group (npm → node → esbuild ...).
 */

const KEEP_LINES = 3000;
/** Old lines are dropped this many at a time, not one per new line (a chatty process would shift the whole array each line). */
const TRIM_LINES = 500;
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|(?:\d{1,3}\.){3}\d{1,3}|[\w-]+\.local)(?::\d{2,5})?(?:\/[^\s'"`)\]]*)?/i;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

export interface RunScript { name: string; command: string }
export interface RunInfo {
  id: string; cwd: string; name: string; command: string;
  status: 'running' | 'exited'; exitCode: number | null; startedAt: number; endedAt?: number;
  /** First local URL the process printed (dev server address). */
  url: string | null;
}
export interface RunLine { n: number; text: string; err: boolean }

interface Proc { info: RunInfo; child: ChildProcess; lines: RunLine[]; next: number; events: EventEmitter }

const procs = new Map<string, Proc>();

/** Scripts from package.json, run through the project's package manager. */
export async function projectScripts(cwd: string): Promise<{ manager: string; scripts: RunScript[] }> {
  const dir = resolvePath(cwd);
  const has = (f: string) => fs.access(path.join(dir, f)).then(() => true, () => false);
  const manager = await has('pnpm-lock.yaml') ? 'pnpm' : await has('yarn.lock') ? 'yarn' : (await has('bun.lockb') || await has('bun.lock')) ? 'bun' : 'npm';
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const names = Object.keys(pkg.scripts ?? {}).filter((n) => !/^(pre|post)/.test(n) || !(pkg.scripts ?? {})[n.replace(/^(pre|post)/, '')]);
    // Long-running ones first: that is what this panel is mostly for.
    const rank = (n: string) => (/^(dev|start|serve|watch|preview)(:|$)/.test(n) ? 0 : /^(build|test|lint|typecheck)(:|$)/.test(n) ? 1 : 2);
    names.sort((a, b) => rank(a) - rank(b));
    return { manager, scripts: names.map((n) => ({ name: n, command: manager === 'npm' ? (n === 'start' || n === 'test' ? `npm ${n}` : `npm run ${n}`) : `${manager} ${n}` })) };
  } catch {
    return { manager, scripts: [] };
  }
}

export function listRuns(cwd?: string): RunInfo[] {
  const abs = cwd ? resolvePath(cwd) : null;
  return [...procs.values()].map((p) => p.info).filter((i) => !abs || i.cwd === abs).sort((a, b) => a.startedAt - b.startedAt);
}

export async function startRun(cwd: string, name: string, command: string): Promise<RunInfo> {
  const dir = resolvePath(cwd);
  // One instance per script: starting it again replaces the old process, once it has let go of its port.
  await Promise.all([...procs.values()].filter((p) => p.info.cwd === dir && p.info.name === name).map((p) => removeRun(p.info.id)));
  const id = `run-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const child = spawn('/bin/zsh', ['-lc', command], { cwd: dir, detached: true, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none' } });
  const proc: Proc = { info: { id, cwd: dir, name, command, status: 'running', exitCode: null, startedAt: Date.now(), url: null }, child, lines: [], next: 0, events: new EventEmitter() };
  proc.events.setMaxListeners(50);
  procs.set(id, proc);
  const pump = (stream: NodeJS.ReadableStream | null, err: boolean) => {
    let partial = '';
    stream?.on('data', (d: Buffer) => {
      const parts = (partial + d.toString()).split(/\r\n|\n|\r(?!\n)/);
      partial = parts.pop() ?? '';
      if (partial.length > 8192) { parts.push(partial); partial = ''; }
      for (const raw of parts) push(proc, raw, err);
    });
    stream?.on('end', () => { if (partial) push(proc, partial, err); });
  };
  pump(child.stdout, false);
  pump(child.stderr, true);
  child.on('error', (e) => push(proc, e.message, true));
  child.on('close', (code, signal) => {
    proc.info = { ...proc.info, status: 'exited', exitCode: code ?? (signal ? 130 : 1), endedAt: Date.now() };
    // Nothing more arrives: a finished run keeps exactly its last KEEP_LINES.
    if (proc.lines.length > KEEP_LINES) proc.lines.splice(0, proc.lines.length - KEEP_LINES);
    proc.events.emit('info', proc.info);
  });
  return proc.info;
}

function push(p: Proc, raw: string, err: boolean) {
  const text = raw.replace(ANSI, '');
  const line = { n: p.next++, text, err };
  p.lines.push(line);
  if (p.lines.length > KEEP_LINES + TRIM_LINES) p.lines.splice(0, p.lines.length - KEEP_LINES);
  if (!p.info.url) {
    const m = text.match(URL_RE);
    if (m) { p.info = { ...p.info, url: m[0].replace('0.0.0.0', 'localhost').replace(/[.,;:]+$/, '') }; p.events.emit('info', p.info); }
  }
  p.events.emit('line', line);
}

function killGroup(p: Proc, sig: NodeJS.Signals) {
  try { if (p.child.pid) process.kill(-p.child.pid, sig); } catch { /* exited */ }
}

export function stopRun(id: string): boolean {
  const p = procs.get(id);
  if (!p) return false;
  if (p.info.status === 'running') {
    killGroup(p, 'SIGINT');
    setTimeout(() => { if (p.info.status === 'running') killGroup(p, 'SIGTERM'); }, 2000).unref();
    setTimeout(() => { if (p.info.status === 'running') killGroup(p, 'SIGKILL'); }, 5000).unref();
  }
  return true;
}

/** Stop (if needed) and forget a run; resolves when its process has exited (SIGKILL after 5s). */
export function removeRun(id: string): Promise<void> {
  const p = procs.get(id);
  if (!p) return Promise.resolve();
  const exited = p.info.status !== 'running' ? Promise.resolve() : new Promise<void>((resolve) => {
    p.child.once('close', () => resolve());
    setTimeout(resolve, 6000).unref();
  });
  stopRun(id);
  procs.delete(id);
  p.events.emit('removed');
  return exited;
}

/** Server shutdown: TERM every group now, KILL whatever is left shortly after (detached groups outlive us otherwise). */
export function stopAllRuns() {
  const live = [...procs.values()].filter((p) => p.info.status === 'running');
  for (const p of live) killGroup(p, 'SIGTERM');
  if (live.length) setTimeout(() => { for (const p of live) if (p.info.status === 'running') killGroup(p, 'SIGKILL'); }, 1500);
}

/** Backlog after line `after`, then live lines and status changes until `onClose`. */
export function subscribeRun(id: string, after: number, on: { line: (l: RunLine) => void; info: (i: RunInfo) => void; removed: () => void }): (() => void) | null {
  const p = procs.get(id);
  if (!p) return null;
  on.info(p.info);
  // The array may hold up to TRIM_LINES extra old lines; subscribers see the same last KEEP_LINES as before.
  for (let i = Math.max(0, p.lines.length - KEEP_LINES); i < p.lines.length; i++) if (p.lines[i].n > after) on.line(p.lines[i]);
  p.events.on('line', on.line);
  p.events.on('info', on.info);
  p.events.on('removed', on.removed);
  return () => { p.events.off('line', on.line); p.events.off('info', on.info); p.events.off('removed', on.removed); };
}
