import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError, formatSize, type Entry } from '../lib/api';
import { t, useLang } from '../lib/i18n';

interface Format { id: string; label: string; ext: string; group: 'common' | 'other' | 'icon' | 'texture'; lossy?: boolean; alpha?: boolean }

/** Everything macOS ImageIO can write (server, `sips`), plus WebP, which Chromium's canvas encodes. */
export const IMAGE_FORMATS: Format[] = [
  { id: 'png', label: 'PNG', ext: '.png', group: 'common', alpha: true },
  { id: 'jpeg', label: 'JPEG', ext: '.jpg', group: 'common', lossy: true },
  { id: 'webp', label: 'WebP', ext: '.webp', group: 'common', lossy: true, alpha: true },
  { id: 'avif', label: 'AVIF', ext: '.avif', group: 'common', lossy: true, alpha: true },
  { id: 'heic', label: 'HEIC', ext: '.heic', group: 'common', lossy: true, alpha: true },
  { id: 'gif', label: 'GIF', ext: '.gif', group: 'common', alpha: true },
  { id: 'tiff', label: 'TIFF', ext: '.tiff', group: 'other', alpha: true },
  { id: 'bmp', label: 'BMP', ext: '.bmp', group: 'other' },
  { id: 'jp2', label: 'JPEG 2000', ext: '.jp2', group: 'other', lossy: true, alpha: true },
  { id: 'psd', label: 'Photoshop (PSD)', ext: '.psd', group: 'other', alpha: true },
  { id: 'pdf', label: 'PDF', ext: '.pdf', group: 'other', alpha: true },
  { id: 'tga', label: 'TGA', ext: '.tga', group: 'other', alpha: true },
  { id: 'exr', label: 'OpenEXR', ext: '.exr', group: 'other', alpha: true },
  { id: 'pbm', label: 'PBM', ext: '.pbm', group: 'other' },
  { id: 'ico', label: 'ICO', ext: '.ico', group: 'icon', alpha: true },
  { id: 'icns', label: 'ICNS', ext: '.icns', group: 'icon', alpha: true },
  { id: 'astc', label: 'ASTC', ext: '.astc', group: 'texture', alpha: true },
  { id: 'ktx', label: 'KTX', ext: '.ktx', group: 'texture', alpha: true },
  { id: 'pvr', label: 'PVR', ext: '.pvr', group: 'texture', alpha: true },
];
// The only sizes ImageIO writes for icon containers (checked against sips on macOS 26).
const ICON_SIZES: Record<string, number[]> = { ico: [16, 24, 32, 48, 64, 128, 256], icns: [16, 32, 48, 128, 256, 512] };
const EXT_ALIASES: Record<string, string> = { '.jpeg': 'jpeg', '.jpg': 'jpeg', '.jfif': 'jpeg', '.tif': 'tiff', '.j2k': 'jp2' };

function formatOfExt(ext: string): Format | undefined {
  const e = ext.toLowerCase();
  const id = EXT_ALIASES[e];
  return IMAGE_FORMATS.find((f) => (id ? f.id === id : f.ext === e));
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** WebP: ImageIO renders (and resizes) to PNG, Chromium encodes. */
async function encodeWebp(path: string, width: number, height: number, quality: number): Promise<string> {
  const res = await fetch(api.imagePngUrl(path, { width, height }));
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', quality / 100));
  if (!blob || blob.type !== 'image/webp') throw new Error('WebP encoding is not available');
  return blobToBase64(blob);
}

interface Props { entry: Entry; onClose: () => void; onSaved: (path: string) => void }

export default function ImageConvertDialog({ entry, onClose, onSaved }: Props) {
  useLang();
  const [info, setInfo] = useState<{ width: number; height: number; hasAlpha: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const current = formatOfExt(entry.ext);
  const [format, setFormat] = useState(current?.id ?? 'png');
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [keepRatio, setKeepRatio] = useState(true);
  const [quality, setQuality] = useState(85);
  const [busy, setBusy] = useState(false);
  // Save As without the native sheet (browser, or an app whose main process predates it): a path field.
  const [asPath, setAsPath] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.imageInfo(entry.path).then((i) => { if (!alive) return; setInfo(i); setWidth(i.width); setHeight(i.height); }).catch((e) => alive && setErr((e as Error).message));
    return () => { alive = false; };
  }, [entry.path]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [busy, onClose]);

  const fmt = IMAGE_FORMATS.find((f) => f.id === format)!;
  const iconSizes = ICON_SIZES[format];
  // Icon containers take one square size from a fixed list; snap to the nearest one.
  useEffect(() => {
    if (!iconSizes || !info) return;
    const want = Math.min(width || info.width, height || info.height);
    const snap = [...iconSizes].reverse().find((s) => s <= want) ?? iconSizes[0];
    setWidth(snap); setHeight(snap);
  }, [format, info]); // eslint-disable-line react-hooks/exhaustive-deps

  const ratio = info ? info.width / info.height : 1;
  const setW = (v: number) => { setWidth(v); if (keepRatio && v > 0) setHeight(Math.max(1, Math.round(v / ratio))); };
  const setH = (v: number) => { setHeight(v); if (keepRatio && v > 0) setWidth(Math.max(1, Math.round(v * ratio))); };
  const scale = (pct: number) => { if (info) { setWidth(Math.max(1, Math.round(info.width * pct / 100))); setHeight(Math.max(1, Math.round(info.height * pct / 100))); } };

  // Same folder, same name, new extension; converting to the file's own format overwrites it in place.
  const dir = entry.path.slice(0, entry.path.lastIndexOf('/'));
  const base = entry.ext ? entry.name.slice(0, -entry.ext.length) : entry.name;
  const dest = current?.id === format ? entry.path : `${dir}/${base}${fmt.ext}`;
  const inPlace = dest === entry.path;
  const valid = width >= 1 && height >= 1 && width <= 30000 && height <= 30000 && Number.isInteger(width) && Number.isInteger(height);
  const unchanged = inPlace && !!info && width === info.width && height === info.height && !fmt.lossy;

  const write = async (target: string, overwrite: boolean) => {
    if (format === 'webp') return api.imageWrite(target, await encodeWebp(entry.path, width, height, quality), overwrite);
    return api.imageConvert({ path: entry.path, dest: target, format, width, height, quality: fmt.lossy ? quality : undefined, overwrite });
  };
  const run = async (target: string, overwrite: boolean) => {
    setBusy(true); setErr(null);
    try {
      let r;
      try { r = await write(target, overwrite); }
      catch (e) {
        if (!(e instanceof ApiError && e.status === 409) || !window.confirm(t('image.confirmOverwrite', { path: target }))) throw e;
        r = await write(target, true);
      }
      onSaved(r.path);
      onClose();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    if (inPlace && !window.confirm(t('image.confirmReplaceOriginal', { name: entry.name }))) return;
    void run(dest, inPlace);
  };
  const saveAs = async () => {
    const suggested = inPlace ? `${dir}/${base} copy${fmt.ext}` : dest;
    let target: string | null;
    if (window.vibe?.saveDialog) {
      target = await window.vibe.saveDialog({ defaultPath: suggested, ext: fmt.ext, label: fmt.label });
      if (target) void run(target, true); // the native sheet already asked about replacing
      return;
    }
    setAsPath(suggested);
  };

  const groups = useMemo(() => (['common', 'other', 'icon', 'texture'] as const).map((g) => [g, IMAGE_FORMATS.filter((f) => f.group === g)] as const), []);
  const input = 'w-24 bg-black/30 border border-white/10 rounded px-2 py-1 text-[13px] outline-none focus:border-blue-400/60 tabular-nums';

  // Portaled to <body>: opened from the preview modal, whose glass-pop card (backdrop-filter, transform) would otherwise
  // be the containing block for this fixed overlay and clip the dim to the card.
  return createPortal(
    <div className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-label={t('image.title')} className="glass-pop pop-in w-[440px] max-w-[92vw] !rounded-[22px] text-sm">
        <div className="px-5 pt-4 pb-3 border-b border-white/10">
          <div className="font-medium">{t('image.title')}</div>
          <div className="mt-1 text-[12px] text-zinc-500 truncate" title={entry.path}>
            {entry.name} · {info ? `${info.width} × ${info.height}` : '…'} · {formatSize(entry.size)}
          </div>
        </div>

        <div className="px-5 py-4 space-y-4">
          <label className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-zinc-400 text-[12px]">{t('image.format')}</span>
            <select value={format} onChange={(e) => setFormat(e.target.value)} className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1 text-[13px] outline-none">
              {groups.map(([g, list]) => (
                <optgroup key={g} label={t(`image.group.${g}`)}>
                  {list.map((f) => <option key={f.id} value={f.id}>{f.label} ({f.ext}){current?.id === f.id ? ` · ${t('image.currentFormat')}` : ''}</option>)}
                </optgroup>
              ))}
            </select>
          </label>

          <div className="flex items-start gap-3">
            <span className="w-16 shrink-0 text-zinc-400 text-[12px] pt-1.5">{t('image.size')}</span>
            {iconSizes ? (
              <div className="flex-1">
                <select value={width} onChange={(e) => { setWidth(Number(e.target.value)); setHeight(Number(e.target.value)); }} className="bg-black/30 border border-white/10 rounded px-2 py-1 text-[13px] outline-none">
                  {iconSizes.map((s) => <option key={s} value={s}>{s} × {s}</option>)}
                </select>
                <div className="mt-1.5 text-[11px] text-zinc-500">{t('image.iconHint')}{info && info.width !== info.height ? ` ${t('image.iconStretch')}` : ''}</div>
              </div>
            ) : (
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <input type="number" min={1} max={30000} value={width || ''} onChange={(e) => setW(Math.round(Number(e.target.value)))} aria-label={t('image.width')} className={input} />
                  <span className="text-zinc-600">×</span>
                  <input type="number" min={1} max={30000} value={height || ''} onChange={(e) => setH(Math.round(Number(e.target.value)))} aria-label={t('image.height')} className={input} />
                  <span className="text-[11px] text-zinc-600">px</span>
                </div>
                <div className="flex items-center gap-3 text-[12px]">
                  <label className="flex items-center gap-1.5 text-zinc-300 cursor-pointer">
                    <input type="checkbox" checked={keepRatio} onChange={(e) => { setKeepRatio(e.target.checked); if (e.target.checked) setW(width); }} />
                    {t('image.keepRatio')}
                  </label>
                  <div className="flex-1" />
                  {[100, 75, 50, 25].map((p) => <button key={p} onClick={() => scale(p)} className="px-1.5 py-0.5 rounded text-zinc-400 hover:text-white hover:bg-white/10 tabular-nums">{p}%</button>)}
                </div>
              </div>
            )}
          </div>

          {fmt.lossy && (
            <label className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-zinc-400 text-[12px]">{t('image.quality')}</span>
              <input type="range" min={1} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} className="flex-1" />
              <span className="w-8 text-right tabular-nums text-[12px] text-zinc-300">{quality}</span>
            </label>
          )}

          {info?.hasAlpha && !fmt.alpha && <div className="text-[11px] text-amber-300/90">{t('image.noAlpha')}</div>}
          <div className="text-[11px] text-zinc-500 break-all">
            {t('image.saveTo')} <span className="text-zinc-300">{dest}</span>{inPlace ? ` · ${t('image.replacesOriginal')}` : ''}
          </div>
          {asPath !== null && (
            <div className="flex items-center gap-2">
              <input autoFocus value={asPath} onChange={(e) => setAsPath(e.target.value)} aria-label={t('image.saveAsPrompt')}
                onKeyDown={(e) => { if (e.key === 'Enter' && asPath.trim()) void run(asPath.trim(), false); if (e.key === 'Escape') { e.stopPropagation(); setAsPath(null); } }}
                className="flex-1 min-w-0 bg-black/30 border border-blue-400/50 rounded px-2 py-1 text-[12px] outline-none" />
              <button disabled={busy || !asPath.trim() || !valid} onClick={() => void run(asPath.trim(), false)} className="px-2.5 py-1 rounded-md bg-blue-600 text-white text-[12px] hover:bg-blue-500 disabled:opacity-40">{t('image.save')}</button>
            </div>
          )}
          {err && <div className="text-[12px] text-red-300 whitespace-pre-wrap">{err}</div>}
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex items-center gap-2">
          {busy && <span className="text-[12px] text-zinc-500">{t('image.saving')}</span>}
          <div className="flex-1" />
          <button disabled={busy} onClick={onClose} className="px-3 py-1.5 rounded-md text-zinc-300 hover:bg-white/10 disabled:opacity-40">{t('image.cancel')}</button>
          <button disabled={busy || !info || !valid} onClick={() => void saveAs()} className="px-3 py-1.5 rounded-md border border-white/15 text-zinc-200 hover:bg-white/10 disabled:opacity-40">{t('image.saveAs')}</button>
          <button disabled={busy || !info || !valid || unchanged} onClick={save} className="px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40">{t('image.save')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
