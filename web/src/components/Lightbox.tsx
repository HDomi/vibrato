import { useEffect, useState } from 'react';

/** Open the lightbox from anywhere: openLightbox(url, caption). */
export function openLightbox(src: string, caption?: string) {
  window.dispatchEvent(new CustomEvent('vibe:lightbox', { detail: { src, caption } }));
}

/** Full-screen image viewer with a fade/scale transition. Mounted once in App. */
export default function Lightbox() {
  const [img, setImg] = useState<{ src: string; caption?: string } | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ src: string; caption?: string }>).detail;
      setImg(d);
      requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    };
    window.addEventListener('vibe:lightbox', onOpen);
    return () => window.removeEventListener('vibe:lightbox', onOpen);
  }, []);

  const close = () => { setShown(false); setTimeout(() => setImg(null), 200); };

  useEffect(() => {
    if (!img) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [img]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!img) return null;
  // no-drag: the title bar's drag region covers the top 100px and Electron hands clicks there to the window
  // regardless of z-index, so the close button (and the backdrop up there) would start a window drag instead.
  return (
    <div className={`titlebar-nodrag fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`} onClick={close}>
      <figure className={`max-w-[92vw] max-h-[92vh] flex flex-col items-center gap-2 transition-transform duration-200 ease-out ${shown ? 'scale-100' : 'scale-90'}`} onClick={(e) => e.stopPropagation()}>
        <img src={img.src} alt={img.caption ?? ''} className="max-w-[92vw] max-h-[85vh] object-contain rounded-lg shadow-2xl" />
        {img.caption && <figcaption className="text-xs text-zinc-400 truncate max-w-[80vw]" title={img.caption}>{img.caption}</figcaption>}
      </figure>
      <button className="absolute top-4 right-5 text-zinc-300 hover:text-white text-xl" onClick={close} aria-label="close">✕</button>
    </div>
  );
}
