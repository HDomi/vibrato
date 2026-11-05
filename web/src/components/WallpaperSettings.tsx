import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { t, useLang } from '../lib/i18n';
import type { Gradient } from '../lib/api';
import { DEFAULT_GRADIENT, previewGradient, setWallpaperBlur, setWallpaperImage, updateWallpaper, useWallpaper } from '../lib/wallpaper';
import GradientEditor from './GradientEditor';

/** Settings > Wallpaper: a solid color, a gradient or an image, the blur of its glass copy and how dark panels are. */
export default function WallpaperSettings() {
  useLang();
  const w = useWallpaper();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blur, setBlur] = useState(w?.blur ?? 40);
  const [dim, setDim] = useState(w?.dim ?? 45);
  const file = useRef<HTMLInputElement>(null);
  const colorTimer = useRef<number | undefined>(undefined);
  const gradTimer = useRef<number | undefined>(undefined);
  const gradient = w?.gradient ?? DEFAULT_GRADIENT;
  const [angle, setAngle] = useState(gradient.angle);
  // The latest edited gradient, so an angle change keeps unsaved stops and the other way round.
  const gradDraft = useRef<Gradient>(gradient);
  useEffect(() => { if (w) { setBlur(w.blur); setDim(w.dim); } }, [w?.blur, w?.dim]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setAngle(gradient.angle); gradDraft.current = { ...gradDraft.current, angle: gradient.angle }; }, [gradient.angle]);
  useEffect(() => { gradDraft.current = { ...gradDraft.current, stops: gradient.stops }; }, [gradient.stops]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(t('wall.failed', { reason: (e as Error).message })); } finally { setBusy(false); }
  };
  // Darkness is a CSS variable: preview while dragging, store on release. Blur needs a new image, so only on release.
  const previewDim = (v: number) => { setDim(v); document.documentElement.style.setProperty('--glass-tint', `rgb(0 0 0 / ${v / 100})`); };
  const commitDim = () => { if (w && dim !== w.dim) void run(() => updateWallpaper({ dim })); };
  // The picker fires on every move: preview at once, store once it settles.
  const pickColor = (v: string) => {
    document.documentElement.style.setProperty('--wall-color', v);
    window.clearTimeout(colorTimer.current);
    colorTimer.current = window.setTimeout(() => void run(() => updateWallpaper({ color: v })), 350);
  };
  // Gradient edits preview at once; stops are stored once they settle, the angle on release.
  const editGradient = (g: Gradient, commit: boolean) => {
    gradDraft.current = { ...g, angle };
    previewGradient(gradDraft.current);
    window.clearTimeout(gradTimer.current);
    if (commit) gradTimer.current = window.setTimeout(() => void run(() => updateWallpaper({ gradient: gradDraft.current })), 350);
  };
  const previewAngle = (v: number) => { setAngle(v); gradDraft.current = { ...gradDraft.current, angle: v }; previewGradient(gradDraft.current); };
  const commitAngle = () => { if (w && angle !== w.gradient?.angle) void run(() => updateWallpaper({ gradient: gradDraft.current })); };
  const commitBlur = () => { if (w && blur !== w.blur) void run(() => (w.hasImage ? setWallpaperBlur(w, blur) : updateWallpaper({ blur }))); };

  if (!w) return null;
  const kind = w.kind;
  return (
    <div className="rounded-2xl border border-line bg-black/15 p-5 space-y-4">
      <div className="font-medium">{t('wall.title')}</div>
      <div className="flex items-center gap-1 rounded-full bg-white/5 p-1 w-fit text-xs">
        {(['color', 'gradient', 'image'] as const).map((k) => (
          <button key={k} disabled={busy}
            onClick={() => { if (k === kind) return; if (k === 'image' && !w.hasImage) file.current?.click(); else void run(() => updateWallpaper({ kind: k })); }}
            className={`rounded-full px-3 py-1 transition-colors ${kind === k ? 'bg-selected text-on-selected' : 'text-zinc-400 hover:text-zinc-200'}`}>
            {t(k === 'color' ? 'wall.color' : k === 'gradient' ? 'wall.gradient' : 'wall.image')}
          </button>
        ))}
      </div>

      {kind === 'color' ? (
        <label className="flex items-center gap-3 text-sm">
          <span className="w-28 text-zinc-400">{t('wall.color')}</span>
          <input type="color" defaultValue={w.color} onChange={(e) => pickColor(e.target.value)}
            className="w-10 h-7 rounded-md bg-transparent border border-white/15 cursor-pointer" />
          <span className="font-mono text-xs text-zinc-500">{w.color}</span>
        </label>
      ) : kind === 'gradient' ? (
        <div className="space-y-3">
          <GradientEditor value={{ ...gradient, angle }} onChange={editGradient} />
          <div className="text-xs text-zinc-500">{t('wall.gradientHint')}</div>
          <label className="flex items-center gap-3 text-sm">
            <span className="w-28 text-zinc-400">{t('wall.angle')}</span>
            <input type="range" min={0} max={359} value={angle} onChange={(e) => previewAngle(Number(e.target.value))}
              onPointerUp={commitAngle} onKeyUp={commitAngle} className="flex-1 accent-white" />
            <span className="w-10 text-right text-xs text-zinc-500 tabular-nums">{angle}°</span>
          </label>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <div className="w-40 h-24 rounded-xl border border-white/15 bg-cover bg-center shrink-0"
            style={{ backgroundImage: `url("${api.wallpaperUrl('original', w.version)}")` }} />
          <button disabled={busy} onClick={() => file.current?.click()} className="rounded-full bg-fill-2 hover:bg-fill-3 px-3.5 py-1.5 transition-colors text-xs text-zinc-200 disabled:opacity-40">{t('wall.change')}</button>
        </div>
      )}
      {kind === 'color' && w.hasImage === false && (
        <button disabled={busy} onClick={() => file.current?.click()} className="rounded-full bg-fill-2 hover:bg-fill-3 px-3.5 py-1.5 transition-colors text-xs text-zinc-200 disabled:opacity-40">{t('wall.pick')}</button>
      )}
      <input ref={file} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run(() => setWallpaperImage(f, blur)); }} />

      {kind === 'image' && (
        <label className="flex items-center gap-3 text-sm">
          <span className="w-28 text-zinc-400">{t('wall.blur')}</span>
          <input type="range" min={0} max={120} value={blur} disabled={busy} onChange={(e) => setBlur(Number(e.target.value))}
            onPointerUp={commitBlur} onKeyUp={commitBlur} className="flex-1 accent-white" />
          <span className="w-10 text-right text-xs text-zinc-500 tabular-nums">{blur}px</span>
        </label>
      )}
      <label className="flex items-center gap-3 text-sm">
        <span className="w-28 text-zinc-400">{t('wall.dim')}</span>
        <input type="range" min={0} max={90} value={dim} disabled={busy} onChange={(e) => previewDim(Number(e.target.value))}
          onPointerUp={commitDim} onKeyUp={commitDim} className="flex-1 accent-white" />
        <span className="w-10 text-right text-xs text-zinc-500 tabular-nums">{dim}%</span>
      </label>
      {busy && <div className="text-xs text-zinc-500">{t('wall.processing')}</div>}
      {error && <div role="alert" className="text-xs text-red-300">{error}</div>}
      <div className="text-xs text-zinc-500 leading-relaxed">{t('wall.note')}</div>
    </div>
  );
}
