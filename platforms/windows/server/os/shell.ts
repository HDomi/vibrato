import { execFile, type SpawnOptions } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

/*
 * Windows: command lines run through cmd.exe and terminal tabs open PowerShell. A CLI that npm installed is a
 * .cmd shim, which Node cannot start without a shell, so lookupCommand resolves it to what the shim runs
 * (an .exe, or a script that startable() hands to this Node).
 */

const execFileP = promisify(execFile);
const COMSPEC = process.env.ComSpec || 'cmd.exe';
const SCRIPT = /\.(c|m)?js$/i;
const exists = (p: string) => access(p).then(() => true, () => false);

/** cmd.exe /s /c "<line>": /s keeps the line exactly as written between the outer quotes. */
export function shellCommand(commandLine: string): { file: string; args: string[]; options: SpawnOptions } {
  // Not detached: on Windows that opens a console window of its own; signalProcessTree ends the tree instead.
  // Verbatim: Node would otherwise escape the quotes in a way cmd.exe does not understand.
  return { file: COMSPEC, args: ['/d', '/s', '/c', `"${commandLine}"`], options: { detached: false, windowsHide: true, windowsVerbatimArguments: true } };
}

export function loginShell(): { file: string; args: string[] } {
  return { file: 'powershell.exe', args: ['-NoLogo'] };
}

/** Windows cannot signal another process: any signal ends the process and its children (taskkill /T /F). */
export function signalProcessTree(pid: number, _sig: NodeJS.Signals) {
  execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => { /* already gone */ });
}

/** The PATH the app was started with is already the user's; there is no login shell to ask. */
export async function loginShellPath(): Promise<string | null> {
  return null;
}

/**
 * What an npm shim (<name>.cmd) runs: its last quoted "%dp0%\..." (older shims: "%~dp0\...") that is a script
 * or an executable.
 */
export function shimTarget(text: string, shim: string): string | null {
  const targets = [...text.matchAll(/"%~?dp0%?\\([^"%]+)"/gi)].map((m) => m[1]).filter((t) => SCRIPT.test(t) || /\.exe$/i.test(t));
  const last = targets.pop();
  return last ? path.win32.resolve(path.win32.dirname(shim), last) : null;
}

/** The Codex npm package's script only launches a bundled codex.exe; the app-server pipe wants that binary itself. */
async function codexBinary(script: string): Promise<string | null> {
  const pkg = path.resolve(path.dirname(script), '..');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const roots = [pkg, path.join(pkg, 'node_modules', '@openai', `codex-win32-${arch}`), path.resolve(pkg, '..', `codex-win32-${arch}`)];
  for (const root of roots) {
    for (const exe of [path.join(root, 'vendor', triple, 'codex', 'codex.exe'), path.join(root, 'vendor', triple, 'codex.exe')]) {
      if (await exists(exe)) return exe;
    }
  }
  return null;
}

export async function lookupCommand(cmd: string): Promise<string | null> {
  if (!/^[\w.-]+$/.test(cmd)) return null;
  let found: string[];
  try {
    const { stdout } = await execFileP('where.exe', [cmd], { timeout: 8000, windowsHide: true });
    found = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
  const exe = found.find((p) => /\.exe$/i.test(p));
  if (exe) return exe;
  const shim = found.find((p) => /\.cmd$/i.test(p));
  if (!shim) return null;
  const target = shimTarget(await readFile(shim, 'utf8').catch(() => ''), shim);
  if (!target || !(await exists(target))) return null;
  // Falls back to the script: startable() runs it with Node, which works for everything but a stdio pipe protocol.
  return cmd === 'codex' && SCRIPT.test(target) ? (await codexBinary(target)) ?? target : target;
}

/** A script lookupCommand resolved runs with this Node; an executable runs as it is. */
export function startable(file: string, args: string[]): { file: string; args: string[] } {
  return SCRIPT.test(file) ? { file: process.execPath, args: [file, ...args] } : { file, args };
}
