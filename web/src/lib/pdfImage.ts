import { api } from './api';
import { baseName, imagePdf, jpegOrientation, sniff, type ImagePageSize } from './pdfDoc';

/**
 * An image file as a one-page PDF. PNG and upright JPEG are embedded byte for byte; everything else
 * (WebP, GIF, AVIF, SVG, BMP, a JPEG with an EXIF rotation) is drawn on a canvas first, which
 * applies the rotation. HEIC/TIFF, which Chromium cannot decode, are rendered by macOS (`sips`)
 * through the server when the file has a path on disk.
 */
export async function imageToPdf(f: { name: string; bytes: Uint8Array; path?: string }, size: ImagePageSize): Promise<Uint8Array> {
  const kind = sniff(f.bytes);
  const title = baseName(f.name);
  if (kind === 'png') return imagePdf(f.bytes, 'png', size, title);
  if (kind === 'jpeg' && jpegOrientation(f.bytes) === 1) return imagePdf(f.bytes, 'jpeg', size, title);
  const img = await decode(f);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d')!.drawImage(img.source, 0, 0, img.width, img.height);
  img.release();
  // Photos stay JPEG (a PNG of a photo is several times larger); the rest keep their transparency.
  const asJpeg = kind === 'jpeg';
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, asJpeg ? 'image/jpeg' : 'image/png', 0.92));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error(`${f.name}: image encoding failed`);
  return imagePdf(new Uint8Array(await blob.arrayBuffer()), asJpeg ? 'jpeg' : 'png', size, title);
}

interface Decoded { source: CanvasImageSource; width: number; height: number; release: () => void }

const MIME: Record<string, string> = { svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg' };

async function decode(f: { name: string; bytes: Uint8Array; path?: string }): Promise<Decoded> {
  const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
  try {
    return await viaImg(new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: MIME[ext] ?? '' }));
  } catch {
    if (!f.path) throw new Error(`${f.name}: this image format cannot be read here`);
    const res = await fetch(api.imagePngUrl(f.path));
    if (!res.ok) throw new Error(`${f.name}: ${(await res.json().catch(() => ({})) as { error?: string }).error ?? res.statusText}`);
    return viaImg(await res.blob());
  }
}

/** `<img>` rather than createImageBitmap: it also takes SVG, and applies EXIF orientation. */
function viaImg(blob: Blob): Promise<Decoded> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // An SVG without width/height reports 0 × 0; give it a usable size.
      const width = img.naturalWidth || 1024, height = img.naturalHeight || 1024;
      resolve({ source: img, width, height, release: () => URL.revokeObjectURL(url) });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}
