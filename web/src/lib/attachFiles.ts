import { api } from './api';
import type { Attachment } from './agent';
import { lastSegment } from './paths';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i;

export function toAttachment(path: string, name?: string): Attachment {
  const n = name ?? lastSegment(path) ?? path;
  return { path, name: n, kind: IMAGE_RE.test(n) ? 'image' : 'file' };
}

/** Add without duplicating a path already attached. */
export function mergeAttachments(a: Attachment[], b: Attachment[]): Attachment[] {
  return [...a, ...b].filter((x, i, arr) => arr.findIndex((y) => y.path === x.path) === i);
}

/** Electron: real paths, nothing copied. Browser: uploaded to the attachments folder. */
export async function resolveFiles(files: File[]): Promise<{ attachments: Attachment[]; error: string | null }> {
  const direct: Attachment[] = [];
  const toUpload: File[] = [];
  for (const f of files) {
    const p = window.vibe?.getPathForFile?.(f);
    if (p) direct.push(toAttachment(p, f.name)); else toUpload.push(f);
  }
  if (!toUpload.length) return { attachments: direct, error: null };
  try { return { attachments: [...direct, ...(await api.attach(toUpload))], error: null }; } catch (e) { return { attachments: direct, error: (e as Error).message }; }
}
