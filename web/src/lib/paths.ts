/**
 * File paths as the server (or a remote host) reports them. An absolute path is in its machine's own form:
 * `/Users/me/app` or `C:\Users\me\app`; the form is read off the path itself, so a Mac showing a Windows host's
 * sessions (and the other way round) splits them correctly. Paths relative to a folder always use `/`.
 */

const WINDOWS = /^[A-Za-z]:[\\/]|^\\\\/;

/** `C:\...`, `C:/...` or a UNC path. */
export const isWindowsPath = (p: string) => WINDOWS.test(p);
export const isAbsPath = (p: string) => p.startsWith('/') || WINDOWS.test(p);

/** Index of the last separator, -1 without one. */
export function lastSep(p: string): number {
  return WINDOWS.test(p) ? Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) : p.lastIndexOf('/');
}

/** Everything after the last separator ('' when the path ends with one). */
export function lastSegment(p: string): string {
  return p.slice(lastSep(p) + 1);
}

/** The last non-empty segment: the name of a file or folder, also with a trailing separator. */
export function baseName(p: string): string | undefined {
  return segments(p).pop();
}

/** Non-empty segments: `/a/b` gives a, b; `C:\a\b` gives C:, a, b. */
export function segments(p: string): string[] {
  return (WINDOWS.test(p) ? p.split(/[\\/]/) : p.split('/')).filter(Boolean);
}

/** The path that segments [0..i] of `p` stand for (breadcrumbs). */
export function pathOfSegments(p: string, i: number): string {
  const parts = segments(p).slice(0, i + 1);
  if (!WINDOWS.test(p)) return '/' + parts.join('/');
  // A bare drive ("C:") means the drive's current folder; its root needs the separator.
  return parts.length === 1 && /^[A-Za-z]:$/.test(parts[0]) ? parts[0] + '\\' : (p.startsWith('\\\\') ? '\\\\' : '') + parts.join('\\');
}

/** The containing folder; a root is its own parent. */
export function parentDir(p: string): string {
  if (!WINDOWS.test(p)) return p.slice(0, p.lastIndexOf('/')) || '/';
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = lastSep(trimmed);
  if (i < 0) return trimmed + '\\';
  const dir = trimmed.slice(0, i);
  return /^[A-Za-z]:$/.test(dir) ? dir + '\\' : dir;
}

/** `rel` (always `/`-separated) below `dir`. */
export function joinPath(dir: string, rel: string): string {
  if (!WINDOWS.test(dir)) return `${dir}/${rel}`;
  return dir.replace(/[\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\');
}

/** Whether `p` lies below `dir` (not `dir` itself). */
export function isInside(p: string, dir: string): boolean {
  if (!WINDOWS.test(dir)) return p.startsWith(dir + '/');
  const d = dir.replace(/[\\/]+$/, '').toLowerCase();
  const q = p.toLowerCase();
  return q.startsWith(d + '\\') || q.startsWith(d + '/');
}

/** `p` relative to `dir` with `/` separators when it lies below it, else `p` unchanged. */
export function relativeTo(p: string, dir: string): string {
  if (!isInside(p, dir)) return p;
  if (!WINDOWS.test(dir)) return p.slice(dir.length + 1);
  return p.slice(dir.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/');
}
