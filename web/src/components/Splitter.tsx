import { useCallback, useEffect, useRef, useState } from 'react';

/** Persisted pane width with a drag handle. `side` is which pane the handle resizes. */
export function usePaneWidth(key: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    try { const v = Number(localStorage.getItem(key)); return v >= min && v <= max ? v : initial; } catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(key, String(width)); } catch { /* ignore */ } }, [key, width]);
  const clamp = useCallback((w: number) => Math.min(max, Math.max(min, w)), [min, max]);
  return { width, setWidth: (w: number) => setWidth(clamp(w)) };
}

interface Props {
  /** Called with the pointer's horizontal delta from drag start. */
  onDrag: (dx: number) => void;
  onStart?: () => void;
  onEnd?: () => void;
  /** Sits in the 16px gap between two glass cards: invisible until hovered or dragged. */
  gap?: boolean;
}

export default function Splitter({ onDrag, onStart, onEnd, gap }: Props) {
  const startX = useRef(0);
  const [active, setActive] = useState(false);
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    startX.current = e.clientX;
    setActive(true);
    onStart?.();
    const move = (ev: PointerEvent) => onDrag(ev.clientX - startX.current);
    const up = () => { setActive(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; document.body.style.userSelect = ''; onEnd?.(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  if (gap) {
    return (
      <div onPointerDown={onDown} className="relative w-4 shrink-0 cursor-col-resize group" role="separator" aria-orientation="vertical">
        <div className={`absolute inset-y-10 left-1/2 w-[3px] -ml-[1.5px] rounded-full transition-colors duration-200 ${active ? 'bg-white/50' : 'group-hover:bg-white/25'}`} />
      </div>
    );
  }
  return (
    <div onPointerDown={onDown} className={`relative w-px shrink-0 bg-white/10 cursor-col-resize group ${active ? 'bg-blue-400' : ''}`}>
      <div className="absolute inset-y-0 -left-1 -right-1" />
      <div className={`absolute inset-y-0 left-0 w-px ${active ? 'bg-blue-400' : 'group-hover:bg-blue-400/60'}`} />
    </div>
  );
}

/** Gap handle that resizes the pane on its left (a list beside a main area). */
export function SideSplitter({ pane }: { pane: ReturnType<typeof usePaneWidth> }) {
  const start = useRef(0);
  return <Splitter gap onStart={() => { start.current = pane.width; }} onDrag={(dx) => pane.setWidth(start.current + dx)} />;
}
