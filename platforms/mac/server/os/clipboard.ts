import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePath } from '../fs.js';

/**
 * Files on the macOS general pasteboard, so the file browser can paste what Finder copied
 * and Finder can paste what the file browser copied. Runs JXA through osascript, which works
 * the same whether the UI is the Electron window or a plain browser tab.
 */

const READ = `
ObjC.import('AppKit');
function run() {
  const pb = $.NSPasteboard.generalPasteboard;
  const items = pb.pasteboardItems;
  const paths = [];
  for (let i = 0; i < items.count; i++) {
    const s = items.objectAtIndex(i).stringForType('public.file-url');
    if (!s.isNil()) { const p = $.NSURL.URLWithString(s).path; if (!p.isNil()) paths.push(p.js); }
  }
  return JSON.stringify({ change: Number(pb.changeCount), paths });
}`;

// One pasteboard item per file (that is how Finder writes a multi-file copy), plus the path as
// plain text so pasting into an editor or terminal still gives the path. Reading the items back
// before exiting matters: without it osascript can quit before the pasteboard server has taken
// every item, and a two-file copy sometimes arrives as one file.
const WRITE = `
ObjC.import('AppKit');
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard;
  const items = $.NSMutableArray.array;
  for (const p of argv) {
    const item = $.NSPasteboardItem.alloc.init;
    item.setStringForType($.NSURL.fileURLWithPath(p).absoluteString, 'public.file-url');
    item.setStringForType(p, 'public.utf8-plain-text');
    items.addObject(item);
  }
  pb.clearContents;
  pb.writeObjects(items);
  const back = pb.pasteboardItems;
  for (let i = 0; i < back.count; i++) back.objectAtIndex(i).stringForType('public.file-url');
  return JSON.stringify({ change: Number(pb.changeCount) });
}`;

const osa = (script: string, args: string[] = []) =>
  promisify(execFile)('osascript', ['-l', 'JavaScript', '-e', script, ...args], { timeout: 5000 }).then((r) => JSON.parse(r.stdout));

/** `change` is NSPasteboard.changeCount: it moves whenever anything (any app) writes the pasteboard. */
export async function readClipboardFiles(): Promise<{ change: number; paths: string[] }> {
  return osa(READ);
}

export async function writeClipboardFiles(paths: string[]): Promise<{ change: number }> {
  const abs = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p).map((p) => resolvePath(p));
  return osa(WRITE, abs);
}
