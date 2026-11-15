import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, saveConfig, withConfigLock, type Backlog, type BacklogItem, type ProjectSettings } from './config.js';
import { resolvePath } from './fs.js';
import { shellCommand, signalProcessTree } from './shell.js';

/** Keep the end of the output: that is where test runners and compilers summarize failures. */
const MAX_LINES = 400;
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 15 * 60 * 1000;

export interface VerifySettings { command: string; auto: boolean }

export async function projectSettings(cwd: string): Promise<ProjectSettings> {
  const abs = resolvePath(cwd);
  return (await loadConfig()).projects.find((p) => p.path === abs) ?? { path: abs };
}

export function updateProjectSettings(cwd: string, patch: (p: ProjectSettings) => ProjectSettings): Promise<ProjectSettings> {
  const abs = resolvePath(cwd);
  return withConfigLock(async () => {
    const cfg = await loadConfig();
    const current = cfg.projects.find((p) => p.path === abs) ?? { path: abs };
    const next = { ...patch(current), path: abs };
    cfg.projects = [...cfg.projects.filter((p) => p.path !== abs), next];
    await saveConfig(cfg);
    return next;
  });
}

/**
 * The verification command for a session folder. A worktree session has no settings of its own; it
 * uses those of the repository it was made from (compared by real path: /tmp vs /private/tmp).
 */
export async function verifySettings(cwd: string): Promise<VerifySettings | null> {
  const v = (await projectSettings(cwd)).verify;
  if (v?.command.trim()) return v;
  const main = await new Promise<string | null>((resolve) => execFile('git', ['-C', resolvePath(cwd), 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 5000 }, (err, out) => resolve(err ? null : path.dirname(String(out).trim()))));
  if (!main) return null;
  const real = (p: string) => fs.realpath(p).catch(() => p);
  const target = await real(main);
  if (target === await real(resolvePath(cwd))) return null;
  for (const p of (await loadConfig()).projects) {
    if (p.verify?.command.trim() && await real(p.path) === target) return p.verify;
  }
  return null;
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

/** Commands that usually check a project of this kind, best first. */
export async function suggestVerifyCommands(cwd: string): Promise<string[]> {
  const dir = resolvePath(cwd);
  const out: string[] = [];
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const pm = await exists(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : await exists(path.join(dir, 'yarn.lock')) ? 'yarn' : await exists(path.join(dir, 'bun.lockb')) || await exists(path.join(dir, 'bun.lock')) ? 'bun' : 'npm';
    const runScript = (name: string) => (pm === 'npm' ? (name === 'test' ? 'npm test' : `npm run ${name}`) : `${pm} ${name}`);
    const checks = ['typecheck', 'type-check', 'tsc', 'check', 'lint'].filter((n) => scripts[n]);
    const hasTest = !!scripts.test && !/no test specified/.test(scripts.test);
    if (checks[0] && hasTest) out.push(`${runScript(checks[0])} && ${runScript('test')}`);
    for (const n of checks) out.push(runScript(n));
    if (hasTest) out.push(runScript('test'));
    if (!checks.length && await exists(path.join(dir, 'tsconfig.json'))) out.push('npx tsc --noEmit');
  } catch { /* not a Node project */ }
  if (await exists(path.join(dir, 'Cargo.toml'))) out.push('cargo check', 'cargo test');
  if (await exists(path.join(dir, 'go.mod'))) out.push('go build ./... && go vet ./...', 'go test ./...');
  if (await exists(path.join(dir, 'pyproject.toml')) || await exists(path.join(dir, 'pytest.ini'))) out.push('pytest -q');
  if (await exists(path.join(dir, 'Package.swift'))) out.push('swift build');
  if (await exists(path.join(dir, 'Makefile'))) out.push('make test');
  return [...new Set(out)].slice(0, 6);
}

export interface VerifyOutcome { exitCode: number; output: string; durationMs: number; cancelled: boolean }

/** Runs `command` in a login shell inside `cwd`. `cancel()` stops the whole process group. */
export function runVerify(cwd: string, command: string): { done: Promise<VerifyOutcome>; cancel: () => void } {
  const started = Date.now();
  const lines: string[] = [];
  let bytes = 0;
  let partial = '';
  let cancelled = false;
  const push = (chunk: string) => {
    const parts = (partial + chunk).split(/\r\n|\r|\n/);
    partial = parts.pop() ?? '';
    for (const raw of parts) {
      // Drop terminal colour codes: the card shows plain text.
      const l = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
      lines.push(l); bytes += l.length + 1;
      while (lines.length > MAX_LINES || bytes > MAX_BYTES) bytes -= (lines.shift()?.length ?? 0) + 1;
    }
  };
  const sh = shellCommand(command);
  const child = spawn(sh.file, sh.args, { cwd: resolvePath(cwd), env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }, ...sh.options, stdio: 'pipe' });
  const killGroup = (sig: NodeJS.Signals) => { try { if (child.pid) signalProcessTree(child.pid, sig); } catch { /* exited */ } };
  const timer = setTimeout(() => {
    push('\nVerification exceeded 15 minutes; stopped.\n');
    killGroup('SIGTERM');
    setTimeout(() => killGroup('SIGKILL'), 5000).unref();
  }, TIMEOUT_MS);
  child.stdout.on('data', (d: Buffer) => push(d.toString()));
  child.stderr.on('data', (d: Buffer) => push(d.toString()));
  const done = new Promise<VerifyOutcome>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (partial) push('\n');
      resolve({ exitCode: code, output: lines.join('\n').trimEnd(), durationMs: Date.now() - started, cancelled });
    };
    child.on('error', (err) => { push(`${err.message}\n`); finish(127); });
    child.on('close', (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
  return { done, cancel: () => { cancelled = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 3000).unref(); } };
}

const STATUSES = new Set(['todo', 'running', 'done', 'failed', 'stopped']);

/** Validate a backlog sent by the client; unknown fields are dropped and sizes are capped. */
export function cleanBacklog(input: unknown): Backlog {
  const b = (input ?? {}) as Partial<Backlog>;
  const items: BacklogItem[] = (Array.isArray(b.items) ? b.items : []).slice(0, 200).flatMap((raw) => {
    const i = raw as Partial<BacklogItem>;
    if (!i || typeof i.id !== 'string' || typeof i.text !== 'string' || !i.text.trim()) return [];
    return [{
      id: i.id.slice(0, 64), text: i.text.slice(0, 20000), status: STATUSES.has(String(i.status)) ? i.status as BacklogItem['status'] : 'todo',
      ...(typeof i.sessionId === 'string' ? { sessionId: i.sessionId.slice(0, 128) } : {}),
      createdAt: Number(i.createdAt) || Date.now(),
      ...(Number(i.startedAt) ? { startedAt: Number(i.startedAt) } : {}),
      ...(Number(i.endedAt) ? { endedAt: Number(i.endedAt) } : {}),
    }];
  });
  return { items, auto: !!b.auto, agent: b.agent === 'codex' ? 'codex' : 'claude', mode: typeof b.mode === 'string' ? b.mode.slice(0, 32) : 'acceptEdits', worktree: !!b.worktree };
}

export async function allBacklogs(): Promise<{ cwd: string; backlog: Backlog }[]> {
  return (await loadConfig()).projects.filter((p) => p.backlog && p.backlog.items.length).map((p) => ({ cwd: p.path, backlog: p.backlog! }));
}
