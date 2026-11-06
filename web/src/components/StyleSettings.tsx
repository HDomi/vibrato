import { useRef, useState } from 'react';
import { t, useLang } from '../lib/i18n';
import WallpaperSettings from './WallpaperSettings';
import { DEFAULT_BUBBLE, DEFAULT_PANEL, previewStyle, setStyle, useStyle, type AppStyle } from '../lib/style';

/** Settings > Style: the wallpaper card, then recolor the user's chat bubble and the dark panels. Each keeps its glass look; only the hue changes. */
export default function StyleSettings() {
  useLang();
  const s = useStyle();
  const timer = useRef<number | undefined>(undefined);
  const [resets, setResets] = useState(0);
  // The picker fires on every move: preview at once, store once it settles.
  const pick = (key: keyof AppStyle, v: string) => {
    previewStyle({ [key]: v });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStyle({ [key]: v }), 300);
  };
  const reset = (key: keyof AppStyle) => { window.clearTimeout(timer.current); setStyle({ [key]: undefined }); setResets((n) => n + 1); };
  const row = (key: keyof AppStyle, label: string, fallback: string) => (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-28 text-zinc-400">{label}</span>
      {/* Remounted on reset so the uncontrolled picker moves back to the default (not on preview: that would end a drag). */}
      <input key={resets} type="color" defaultValue={s[key] ?? fallback} onChange={(e) => pick(key, e.target.value)}
        className="w-10 h-7 rounded-md bg-transparent border border-white/15 cursor-pointer" />
      <span className="font-mono text-xs text-zinc-500">{s[key] ?? t('style.default')}</span>
      {s[key] && (
        <button onClick={() => reset(key)} className="rounded-full bg-fill-2 hover:bg-fill-3 px-3 py-1 transition-colors text-xs text-zinc-200">{t('style.reset')}</button>
      )}
    </div>
  );
  // The wallpaper card sits on top: it sets the backdrop and how dark the panels are, which the colors below build on.
  return (
    <div className="space-y-4">
      <WallpaperSettings />
      <div className="rounded-2xl border border-line bg-black/15 p-5 space-y-4">
        <div className="font-medium">{t('style.colors')}</div>
        {row('bubble', t('style.bubble'), DEFAULT_BUBBLE)}
        <div className="flex justify-end">
          <div className="user-bubble max-w-[80%] rounded-[20px] rounded-br-md bg-sky-400/[0.18] border border-sky-200/15 shadow-[0_6px_20px_rgb(0_0_0/.18)] px-4 py-2.5 text-[14px]">{t('style.bubblePreview')}</div>
        </div>
        {row('panel', t('style.panel'), DEFAULT_PANEL)}
        <div className="text-xs text-zinc-500 leading-relaxed">{t('style.note')}</div>
      </div>
    </div>
  );
}
