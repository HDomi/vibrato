import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run, which } from '../shell.js';
import { powershell } from './powershell.js';

/* Windows: the Recycle Bin, tar.exe for zip archives, and Explorer / Windows Terminal / editors to open a folder in. */

const RECYCLE = `Add-Type -AssemblyName Microsoft.VisualBasic
foreach ($p in @(ConvertFrom-Json $env:VIBRATO_PATHS)) {
  if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin') }
  else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') }
}`;

export const SYSTEM_TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

/** Move to the Recycle Bin so the user can restore it. Rejects when Windows refuses. */
export async function moveToTrash(abs: string[]): Promise<void> {
  const r = await powershell(RECYCLE, { VIBRATO_PATHS: JSON.stringify(abs) }, 60000);
  if (!r.ok) throw new Error(r.stderr.split('\n')[0] || 'Recycle Bin refused');
}

/** `folder` as `zip`, with the folder itself as the top entry. tar.exe (bsdtar) ships with Windows 10 and later. */
export async function zipFolder(folder: string, zip: string): Promise<{ ok: boolean; stderr: string }> {
  // By full path: a GNU tar earlier on PATH (Git Bash) would write a tar file under the .zip name.
  const tar = await run(SYSTEM_TAR, ['-a', '-c', '-f', zip, '-C', path.dirname(folder), path.basename(folder)], 120000);
  if (tar.ok) return tar;
  const ps = await powershell('Compress-Archive -LiteralPath $env:VIBRATO_SRC -DestinationPath $env:VIBRATO_ZIP -Force', { VIBRATO_SRC: folder, VIBRATO_ZIP: zip }, 120000);
  return ps.ok ? ps : { ok: false, stderr: tar.stderr || ps.stderr };
}

/** Apps a folder can be opened in. 'finder' is the file manager on every target (here Explorer). */
export const OPEN_TARGETS = ['terminal', 'finder', 'vscode', 'cursor'] as const;
export type OpenTarget = typeof OPEN_TARGETS[number];

/** Start a windowed program and let it go. `args` are passed as written (quote paths yourself). */
function detached(file: string, args: string[], cwd?: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    child.once('error', (err) => resolve({ ok: false, stderr: err.message }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true, stderr: '' }); });
  });
}

/** An editor's command line launcher is a .cmd shim: it starts through cmd.exe. A Windows path cannot hold a quote. */
function viaCmd(command: string, abs: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command} "${abs}""`], { windowsHide: true, windowsVerbatimArguments: true, timeout: 15000 },
      (err, _out, stderr) => resolve({ ok: !err, stderr: String(stderr || (err?.message ?? '')).trim() }));
  });
}

export async function openFolder(abs: string, target: OpenTarget): Promise<{ ok: boolean; stderr: string }> {
  if (target === 'vscode') return viaCmd('code', abs);
  if (target === 'cursor') return viaCmd('cursor', abs);
  const isDir = await fs.stat(abs).then((s) => s.isDirectory(), () => false);
  // explorer.exe exits with 1 even when it opened the window, so only a failed start counts.
  if (target === 'finder') return detached('explorer.exe', [isDir ? `"${abs}"` : `/select,"${abs}"`]);
  const dir = isDir ? abs : path.dirname(abs);
  // A trailing backslash would escape the closing quote ("C:\" is a drive root).
  if (await which('wt')) return detached('wt.exe', ['-d', `"${dir.replace(/\\$/, '\\\\')}"`]);
  return detached('powershell.exe', ['-NoExit', '-NoLogo'], dir);
}
