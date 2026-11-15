/** Local file references in Markdown: link targets and inline code that names a file. */

import { isWindowsPath } from './paths';

const EXTERNAL_RE = /^(https?:|mailto:|tel:|data:|blob:)/i;

/** Absolute path of a local link target, relative ones against `baseDir`; null for URLs and anchors. */
export function resolveLocal(href: string, baseDir?: string | null): string | null {
  // "file.ts:12:3" points at a line; only the file is opened.
  href = href.replace(/:\d+(?::\d+)?$/, '');
  if (!href || EXTERNAL_RE.test(href) || href.startsWith('#')) return null;
  // A document on a Windows machine: its links are Windows paths (`C:\a\b`, `sub\c.md`, file:///C:/a).
  if (baseDir && isWindowsPath(baseDir)) return resolveWindows(href, baseDir);
  if (/^[a-z][\w+.-]*:/i.test(href) && !href.startsWith('file://')) return null;
  let p = href.startsWith('file://') ? href.slice(7) : href;
  try { p = decodeURIComponent(p); } catch { /* keep as is */ }
  p = p.split('#')[0].split('?')[0];
  if (p.startsWith('~/')) return p;
  if (p.startsWith('/')) return p;
  if (!baseDir) return null;
  const parts = (baseDir + '/' + p).split('/');
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return '/' + out.join('/');
}

function resolveWindows(href: string, baseDir: string): string | null {
  let p = /^file:\/\//i.test(href) ? href.slice(7).replace(/^\/(?=[A-Za-z]:)/, '') : href;
  if (!isWindowsPath(p) && /^[a-z][\w+.-]*:/i.test(p)) return null;
  try { p = decodeURIComponent(p); } catch { /* keep as is */ }
  p = p.split('#')[0].split('?')[0];
  if (p.startsWith('~/') || p.startsWith('~\\')) return p;
  const out: string[] = [];
  // A path from the drive's root keeps the document's drive.
  const from = isWindowsPath(p) ? p : /^[\\/]/.test(p) ? baseDir.slice(0, 2) + p : baseDir + '\\' + p;
  for (const seg of from.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length > 1) out.pop(); } else out.push(seg);
  }
  return (from.startsWith('\\\\') ? '\\\\' : '') + out.join('\\');
}

/**
 * Inline code that looks like a file path ("server/git.ts", "./a.md:12", "~/x/y.json"): one token, no spaces or
 * call syntax, with a folder separator or a file extension. Whether it exists is checked before it becomes a link.
 */
export function codePathCandidate(text: string): string | null {
  const s = text.trim();
  if (!s || s.length > 300 || /[\s()<>{}[\]"'`,;|*$]/.test(s) || /^[a-z][\w+.-]*:\/\//i.test(s)) return null;
  const bare = s.replace(/:\d+(?::\d+)?$/, '');
  if (!/[\w-]/.test(bare)) return null;
  const hasDir = bare.includes('/');
  const hasExt = /^[^/]*[\w-]\.[A-Za-z][\w]{0,9}$/.test(bare.split('/').pop() ?? '');
  if (!hasDir && !hasExt) return null;
  // "a/b" alone is too often prose ("and/or", "read/write"); a slash path needs a dot, a leading ./ ~/ /, or depth.
  if (hasDir && !hasExt && !/^(\.{1,2}\/|~\/|\/)/.test(bare) && bare.split('/').filter(Boolean).length < 3) return null;
  return s;
}
