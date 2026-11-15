import { resolvePath } from '../fs.js';
import { powershell } from './powershell.js';

/**
 * Files on the Windows clipboard (the same list Explorer copies and pastes), so the file browser can paste what
 * Explorer copied and the other way round.
 */

const SEQUENCE = `Add-Type -Namespace Vibrato -Name Clip -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'`;
const READ = `${SEQUENCE}; $p=@(Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }); ConvertTo-Json -Compress @{ change=[long][Vibrato.Clip]::GetClipboardSequenceNumber(); paths=$p }`;
const WRITE = `${SEQUENCE}; $p=@(ConvertFrom-Json $env:VIBRATO_PATHS); if ($p.Count) { Set-Clipboard -LiteralPath $p }; ConvertTo-Json -Compress @{ change=[long][Vibrato.Clip]::GetClipboardSequenceNumber() }`;

function parse(out: string): { change: number; paths: string[] } {
  const j = JSON.parse(out) as { change?: unknown; paths?: unknown };
  // Windows PowerShell writes a one-element list as a bare string.
  const paths = Array.isArray(j.paths) ? j.paths : typeof j.paths === 'string' ? [j.paths] : [];
  return { change: Number(j.change) || 0, paths: paths.filter((p): p is string => typeof p === 'string') };
}

/** `change` is the clipboard sequence number: it moves whenever anything (any app) writes the clipboard. */
export async function readClipboardFiles(): Promise<{ change: number; paths: string[] }> {
  const r = await powershell(READ, {}, 8000);
  if (!r.ok) throw new Error(r.stderr || 'Could not read the clipboard');
  return parse(r.stdout);
}

export async function writeClipboardFiles(paths: string[]): Promise<{ change: number }> {
  const abs = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p).map((p) => resolvePath(p));
  const r = await powershell(WRITE, { VIBRATO_PATHS: JSON.stringify(abs) }, 8000);
  if (!r.ok) throw new Error(r.stderr || 'Could not write the clipboard');
  return { change: parse(r.stdout).change };
}
