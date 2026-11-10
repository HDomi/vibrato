import { degrees, EncryptedPDFError, PDFDocument } from 'pdf-lib';

/**
 * PDF page editing without a DOM: the page list the PDF tool edits, and the pdf-lib step that turns
 * it into a file. Rendering (pdf.js) lives in `pdfRender.ts`, so this module also runs under node:test.
 */

/** One opened PDF. `bytes` is kept for pdf-lib; pdf.js always gets a copy (it detaches what it is given). */
export interface PdfSource {
  id: string;
  name: string;
  /** Absolute path when the file came from disk (project file or a dropped Finder file). */
  path?: string;
  bytes: Uint8Array;
  pageCount: number;
  /** Encrypted (owner or user password): pdf-lib cannot copy its pages, pdf.js can still render them. */
  locked: boolean;
}

/** A page in the output, in output order. `rotate` is added to the page's own /Rotate. */
export interface PageRef { key: string; src: string; index: number; rotate: number }

let seq = 0;
export const pageKey = () => `p${Date.now().toString(36)}${(seq++).toString(36)}`;

export function pagesOf(src: PdfSource): PageRef[] {
  return Array.from({ length: src.pageCount }, (_, index) => ({ key: pageKey(), src: src.id, index, rotate: 0 }));
}

export const normRotation = (deg: number) => ((Math.round(deg / 90) * 90) % 360 + 360) % 360;

export function removePages(pages: PageRef[], keys: ReadonlySet<string>): PageRef[] {
  return pages.filter((p) => !keys.has(p.key));
}

/** Each selected page gets a copy right after it. Returns the new list and the copies' keys. */
export function duplicatePages(pages: PageRef[], keys: ReadonlySet<string>): { pages: PageRef[]; added: string[] } {
  const added: string[] = [];
  const out = pages.flatMap((p) => {
    if (!keys.has(p.key)) return [p];
    const copy = { ...p, key: pageKey() };
    added.push(copy.key);
    return [p, copy];
  });
  return { pages: out, added };
}

export function rotatePages(pages: PageRef[], keys: ReadonlySet<string>, delta: number): PageRef[] {
  return pages.map((p) => (keys.has(p.key) ? { ...p, rotate: normRotation(p.rotate + delta) } : p));
}

/**
 * Move the selected pages, as one block in their current order, so they start at `to`
 * (an index into the list *before* the move, i.e. the gap a drop marker points at).
 */
export function movePages(pages: PageRef[], keys: ReadonlySet<string>, to: number): PageRef[] {
  const moving = pages.filter((p) => keys.has(p.key));
  if (!moving.length) return pages;
  const before = pages.slice(0, Math.max(0, Math.min(to, pages.length))).filter((p) => !keys.has(p.key)).length;
  const rest = pages.filter((p) => !keys.has(p.key));
  return [...rest.slice(0, before), ...moving, ...rest.slice(before)];
}

/** Shift the selection one step up (-1) or down (+1); a no-op at either end. */
export function nudgePages(pages: PageRef[], keys: ReadonlySet<string>, dir: -1 | 1): PageRef[] {
  const idx = pages.flatMap((p, i) => (keys.has(p.key) ? [i] : []));
  if (!idx.length) return pages;
  if (dir < 0 && idx[0] === 0) return pages;
  if (dir > 0 && idx[idx.length - 1] === pages.length - 1) return pages;
  return movePages(pages, keys, dir < 0 ? idx[0] - 1 : idx[idx.length - 1] + 2);
}

export class PdfLockedError extends Error {
  constructor(public names: string[]) {
    super(`Password-protected PDF cannot be edited: ${names.join(', ')}`);
    this.name = 'PdfLockedError';
  }
}

/** Opens bytes with pdf-lib only to learn whether they can be edited (page count comes from pdf.js). */
export async function isEncrypted(bytes: Uint8Array): Promise<boolean> {
  try {
    await PDFDocument.load(bytes, { updateMetadata: false });
    return false;
  } catch (e) {
    if (e instanceof EncryptedPDFError) return true;
    throw e;
  }
}

/**
 * Build the output PDF. Pages are copied with one `copyPages` per source, so fonts and images that
 * several pages share are written once; a duplicated page is a second, independent page object.
 */
export async function assemblePdf(sources: ReadonlyMap<string, PdfSource>, pages: readonly PageRef[], opts: { title?: string } = {}): Promise<Uint8Array> {
  if (!pages.length) throw new Error('No pages');
  const locked = [...new Set(pages.map((p) => sources.get(p.src)).filter((s): s is PdfSource => !!s?.locked).map((s) => s.name))];
  if (locked.length) throw new PdfLockedError(locked);
  const out = await PDFDocument.create();
  const order = new Map<string, number[]>();
  for (const p of pages) order.set(p.src, [...(order.get(p.src) ?? []), p.index]);
  const copied = new Map<string, ReturnType<PDFDocument['getPages']>>();
  for (const [id, indices] of order) {
    const src = sources.get(id);
    if (!src) throw new Error(`Missing source ${id}`);
    const doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
    copied.set(id, await out.copyPages(doc, indices));
  }
  const cursor = new Map<string, number>();
  for (const p of pages) {
    const n = cursor.get(p.src) ?? 0;
    cursor.set(p.src, n + 1);
    const page = out.addPage(copied.get(p.src)![n]);
    if (p.rotate) page.setRotation(degrees(normRotation(page.getRotation().angle + p.rotate)));
  }
  if (opts.title) out.setTitle(opts.title);
  out.setProducer('Vibrato');
  out.setCreator('Vibrato');
  return out.save();
}

export type ImageFormat = 'png' | 'jpeg' | 'webp';
export const IMAGE_EXT: Record<ImageFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' };
export const IMAGE_MIME: Record<ImageFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/** `report-01.png` … zero-padded to the page count so Finder sorts them in order. */
export function pageImageName(base: string, n: number, total: number, format: ImageFormat): string {
  return `${base}-${String(n).padStart(Math.max(2, String(total).length), '0')}.${IMAGE_EXT[format]}`;
}

export const baseName = (name: string) => name.replace(/\.pdf$/i, '') || 'document';

/** Canvas limits (Chromium): 32767 px per side, about 268M px in area. Stay well under both. */
export const MAX_SIDE = 16384;
export const MAX_AREA = 120_000_000;

/** The render scale for `dpi`, lowered when the page would exceed the canvas limits. */
export function exportScale(widthPt: number, heightPt: number, dpi: number): number {
  let scale = dpi / 72;
  scale = Math.min(scale, MAX_SIDE / widthPt, MAX_SIDE / heightPt);
  const area = widthPt * heightPt * scale * scale;
  if (area > MAX_AREA) scale *= Math.sqrt(MAX_AREA / area);
  return scale;
}
