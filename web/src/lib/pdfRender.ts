import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { exportScale, IMAGE_MIME, normRotation, type ImageFormat } from './pdfDoc';

/**
 * pdf.js for the PDF tool. The runtime assets (CMaps, standard fonts, wasm decoders, ICC profiles)
 * are served from `/pdfjs/` by the `pdfjs-assets` plugin in vite.config.ts. Without `cMapUrl`, CID
 * fonts (every Korean/Japanese/Chinese PDF) render with their glyphs silently missing.
 *
 * The legacy build, main and worker: pdf.js 6.5 calls `Map.prototype.getOrInsertComputed`, which
 * Electron 39's Chromium does not have yet ("getOrInsertComputed is not a function" on every
 * render). The legacy build carries the core-js polyfills.
 */
GlobalWorkerOptions.workerSrc = workerSrc;

const assets = (dir: string) => new URL(`/pdfjs/${dir}/`, location.href).href;

export class PdfPasswordError extends Error {
  constructor(name: string) { super(`${name} is password protected`); this.name = 'PdfPasswordError'; }
}

export interface OpenedPdf { doc: PDFDocumentProxy; close: () => Promise<void> }

export async function openPdf(bytes: Uint8Array, name: string): Promise<OpenedPdf> {
  const task: PDFDocumentLoadingTask = getDocument({
    // pdf.js transfers (detaches) the buffer it is given; the caller keeps the original for pdf-lib.
    data: bytes.slice(),
    cMapUrl: assets('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assets('standard_fonts'),
    wasmUrl: assets('wasm'),
    iccUrl: assets('iccs'),
  });
  // Without a handler pdf.js waits forever for a password nobody will type.
  task.onPassword = () => { void task.destroy(); };
  const close = async () => { if (!task.destroyed) await task.destroy(); };
  try {
    return { doc: await task.promise, close };
  } catch (e) {
    await close().catch(() => {});
    if ((e as { name?: string })?.name === 'PasswordException' || task.destroyed) throw new PdfPasswordError(name);
    throw new Error(`${name}: ${(e as Error)?.message ?? 'could not be read'}`);
  }
}

function toBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image encoding failed'))), mime, quality));
}

/** Rendering is serialized: pages are large bitmaps, and several at once spike memory on big documents. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.catch(() => {});
  return run;
}

/** A page fitted into `box` px (longest side), as an object URL the caller revokes. */
export function renderThumb(doc: PDFDocumentProxy, index: number, rotate: number, box: number): Promise<{ url: string; width: number; height: number }> {
  return serial(async () => {
    const page = await doc.getPage(index + 1);
    const rotation = normRotation(page.rotate + rotate);
    const base = page.getViewport({ scale: 1, rotation });
    const viewport = page.getViewport({ scale: (box * Math.min(2, devicePixelRatio || 1)) / Math.max(base.width, base.height), rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvas, viewport }).promise;
    page.cleanup();
    const blob = await toBlob(canvas, 'image/jpeg', 0.8);
    canvas.width = canvas.height = 0;
    return { url: URL.createObjectURL(blob), width: base.width, height: base.height };
  });
}

export interface PageImageOptions { format: ImageFormat; dpi: number; quality: number; transparent: boolean }

/** One page as an encoded image at `dpi` (capped to what a canvas can hold). */
export function renderPageImage(doc: PDFDocumentProxy, index: number, rotate: number, o: PageImageOptions): Promise<Blob> {
  return serial(async () => {
    const page = await doc.getPage(index + 1);
    const rotation = normRotation(page.rotate + rotate);
    const base = page.getViewport({ scale: 1, rotation });
    const viewport = page.getViewport({ scale: exportScale(base.width, base.height, o.dpi), rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    // JPEG has no alpha: transparent areas would turn black, so it always gets white paper.
    const clear = o.transparent && o.format !== 'jpeg';
    await page.render({ canvas, viewport, background: clear ? 'rgba(0,0,0,0)' : '#ffffff' }).promise;
    page.cleanup();
    try {
      const blob = await toBlob(canvas, IMAGE_MIME[o.format], o.format === 'png' ? undefined : o.quality / 100);
      if (blob.type !== IMAGE_MIME[o.format]) throw new Error(`${o.format.toUpperCase()} encoding is not available`);
      return blob;
    } finally {
      canvas.width = canvas.height = 0;
    }
  });
}
