import { useEffect, useState } from 'react';
import { api, type Gradient, type Wallpaper } from './api';

/**
 * App wallpaper: a solid color, a linear gradient or an image. Glass surfaces show a pre-blurred copy of the image pinned to
 * the viewport (see .glass in index.css), so the blur is computed once here instead of every frame by
 * backdrop-filter. Both images are made in this renderer with a canvas and stored by the server.
 */

const LS_KEY = 'vibe.wallpaper';
/** The stored original is capped so a huge photo does not cost hundreds of MB of GPU memory. */
const MAX_SIDE = 3200;
/** The blurred copy is stored at this fraction of the original; a blurred image upscales without visible loss. */
const BLUR_SCALE = 0.25;

let current: Wallpaper | null = null;
const listeners = new Set<(w: Wallpaper) => void>();

export const DEFAULT_GRADIENT: Gradient = { angle: 135, stops: [{ color: '#1e2a4a', pos: 0 }, { color: '#0b0d12', pos: 100 }] };

/** CSS for a gradient; stops may be out of order while a handle is dragged past another. */
export function gradientCss(g: Gradient, angle = g.angle): string {
  const stops = [...g.stops].sort((a, b) => a.pos - b.pos).map((s) => `${s.color} ${s.pos}%`).join(', ');
  return `linear-gradient(${angle}deg, ${stops})`;
}

/**
 * Points the backdrop at a gradient without storing it (live preview while editing). A gradient is already
 * smooth, so the glass copy is the same gradient: both are pinned to the viewport and line up.
 */
export function previewGradient(g: Gradient) {
  const root = document.documentElement.style;
  const css = gradientCss(g);
  root.setProperty('--wall-color', g.stops[g.stops.length - 1]?.color ?? '#0b0d12');
  root.setProperty('--wall-image', css);
  root.setProperty('--wall-blur', css);
}

/** Sets the CSS variables the app background and glass surfaces read. */
export function applyWallpaper(w: Wallpaper) {
  current = w;
  const root = document.documentElement.style;
  if (w.kind === 'gradient' && w.gradient) {
    previewGradient(w.gradient);
  } else {
    const image = w.kind === 'image' && w.hasImage;
    root.setProperty('--wall-color', w.color);
    root.setProperty('--wall-image', image ? `url("${api.wallpaperUrl('original', w.version)}")` : 'none');
    root.setProperty('--wall-blur', image ? `url("${api.wallpaperUrl('blur', w.version)}")` : 'none');
  }
  root.setProperty('--glass-tint', `rgb(var(--panel-rgb, 0 0 0) / ${w.dim / 100})`);
  try { localStorage.setItem(LS_KEY, JSON.stringify(w)); } catch { /* ignore */ }
  for (const l of listeners) l(w);
}

/** Applies the last known wallpaper at once (no flash of the default), then the server's copy. */
export function initWallpaper() {
  try {
    const cached = localStorage.getItem(LS_KEY);
    if (cached) applyWallpaper(JSON.parse(cached) as Wallpaper);
  } catch { /* ignore */ }
  api.wallpaper().then(applyWallpaper).catch(() => {});
}

export function useWallpaper(): Wallpaper | null {
  const [w, setW] = useState(current);
  useEffect(() => {
    listeners.add(setW);
    return () => { listeners.delete(setW); };
  }, []);
  return w;
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function toJpeg(c: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the image'))), 'image/jpeg', quality));
}

/**
 * Blurs `src` (already at the output size) with its edge pixels stretched outward first, so the border does
 * not darken by blending with transparent pixels outside the canvas.
 */
function blurred(src: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const { width: w, height: h } = src;
  const out = canvas(w, h);
  const o = out.getContext('2d')!;
  if (radius <= 0) { o.drawImage(src, 0, 0); return out; }
  const m = Math.ceil(radius * 3);
  const pad = canvas(w + 2 * m, h + 2 * m);
  const p = pad.getContext('2d')!;
  p.drawImage(src, m, m);
  p.drawImage(src, 0, 0, 1, h, 0, m, m, h); // left edge
  p.drawImage(src, w - 1, 0, 1, h, m + w, m, m, h); // right edge
  p.drawImage(pad, 0, m, w + 2 * m, 1, 0, 0, w + 2 * m, m); // top edge (corners included)
  p.drawImage(pad, 0, m + h - 1, w + 2 * m, 1, 0, m + h, w + 2 * m, m); // bottom edge
  o.filter = `blur(${radius}px)`;
  o.drawImage(pad, -m, -m);
  return out;
}

async function decode(file: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = canvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c;
}

function blurCopy(original: HTMLCanvasElement, radius: number): Promise<Blob> {
  const small = canvas(Math.max(1, Math.round(original.width * BLUR_SCALE)), Math.max(1, Math.round(original.height * BLUR_SCALE)));
  const s = small.getContext('2d')!;
  s.imageSmoothingQuality = 'high';
  s.drawImage(original, 0, 0, small.width, small.height);
  return toJpeg(blurred(small, radius * BLUR_SCALE), 0.85);
}

/** A new wallpaper image: stores the (downscaled) original and its blurred copy. */
export async function setWallpaperImage(file: Blob, radius: number): Promise<Wallpaper> {
  const original = await decode(file);
  const [orig, blur] = await Promise.all([toJpeg(original, 0.9), blurCopy(original, radius)]);
  const w = await api.uploadWallpaper({ original: orig, blur }, radius);
  applyWallpaper(w);
  return w;
}

/** Remakes only the blurred copy from the stored original (blur slider). */
export async function setWallpaperBlur(w: Wallpaper, radius: number): Promise<Wallpaper> {
  const res = await fetch(api.wallpaperUrl('original', w.version));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const original = await decode(await res.blob());
  const next = await api.uploadWallpaper({ blur: await blurCopy(original, radius) }, radius);
  applyWallpaper(next);
  return next;
}

export async function updateWallpaper(patch: Partial<Pick<Wallpaper, 'kind' | 'color' | 'gradient' | 'blur' | 'dim'>>): Promise<Wallpaper> {
  const w = await api.setWallpaper(patch);
  applyWallpaper(w);
  return w;
}
