import { execFile } from 'node:child_process';

/**
 * One Windows PowerShell script run to its end. Values go in as environment variables (never spliced into the script),
 * so a crafted file name cannot change what runs. Output is UTF-8.
 */
export function powershell(script: string, env: Record<string, string> = {}, timeout = 20000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const full = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', full],
      { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout).trim(), stderr: String(stderr || (err?.message ?? '')).trim() }));
  });
}
