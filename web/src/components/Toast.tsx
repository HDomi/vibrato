import { useEffect, useState } from 'react';

/** Short status line at the bottom of the window; anything can raise one with toast(text). */
export function toast(text: string, kind: 'info' | 'error' = 'info') {
  window.dispatchEvent(new CustomEvent('vibe:toast', { detail: { text, kind } }));
}

export default function Toaster() {
  const [items, setItems] = useState<{ id: number; text: string; kind: string }[]>([]);
  useEffect(() => {
    let n = 0;
    const h = (ev: Event) => {
      const d = (ev as CustomEvent<{ text: string; kind?: string }>).detail;
      if (!d?.text) return;
      const id = ++n;
      setItems((prev) => [...prev.slice(-2), { id, text: d.text, kind: d.kind ?? 'info' }]);
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), 4000);
    };
    window.addEventListener('vibe:toast', h);
    return () => window.removeEventListener('vibe:toast', h);
  }, []);
  if (!items.length) return null;
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none">
      {items.map((x) => (
        <div key={x.id} className={`pop-in rounded-full border px-4 py-2 text-[12.5px] shadow-2xl backdrop-blur-xl ${x.kind === 'error' ? 'border-red-500/30 bg-red-950/80 text-red-100' : 'border-white/12 bg-panel-toast text-zinc-100'}`}>{x.text}</div>
      ))}
    </div>
  );
}
