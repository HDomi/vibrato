import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t, useLang } from '../lib/i18n';

export type DrawTool = 'pencil' | 'eraser' | 'rect' | 'roundRect' | 'circle' | 'triangle';
const SHAPES: DrawTool[] = ['rect', 'roundRect', 'circle', 'triangle'];
const LINE = 3;
const ERASER = 22;
const BACKGROUND = '#ffffff';

/** A shape from the drag start to the current point, in canvas pixels. */
export function shapePath(ctx: CanvasRenderingContext2D, tool: DrawTool, x0: number, y0: number, x1: number, y1: number) {
  const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  ctx.beginPath();
  if (tool === 'rect') ctx.rect(x, y, w, h);
  else if (tool === 'roundRect') {
    const r = Math.min(16, w / 4, h / 4);
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  } else if (tool === 'circle') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (tool === 'triangle') { ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); }
}

const ICON: Record<DrawTool, ReactNode> = {
  pencil: <path d="M3 13l1-4 7-7 3 3-7 7-4 1zM10 3l3 3" />,
  eraser: <path d="M6 14h8M2.5 10.5l6-6 5 5-4 4H6.5zM5.5 7.5l5 5" />,
  rect: <rect x="2.5" y="3.5" width="11" height="9" />,
  roundRect: <rect x="2.5" y="3.5" width="11" height="9" rx="3" />,
  circle: <circle cx="8" cy="8" r="5.5" />,
  triangle: <path d="M8 2.5l6 11H2z" />,
};

/**
 * "Draw & insert": a sketch pad over the whole app (pencil, eraser, four outline shapes, a colour). Insert hands the
 * drawing to the composer as a PNG attachment; X closes without inserting.
 */
export default function DrawDialog({ onClose, onInsert }: { onClose: () => void; onInsert: (file: File) => void }) {
  useLang();
  const [tool, setTool] = useState<DrawTool>('pencil');
  const [color, setColor] = useState('#111827');
  const [dirty, setDirty] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);

  // Size both canvases to the area once laid out (device pixels), keeping what is drawn when the window resizes.
  useEffect(() => {
    const el = box.current, p = paper.current, v = preview.current;
    if (!el || !p || !v) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(el.clientWidth * dpr)), h = Math.max(1, Math.round(el.clientHeight * dpr));
      if (p.width === w && p.height === h) return;
      const keep = p.width > 1 ? p.getContext('2d')!.getImageData(0, 0, p.width, p.height) : null;
      for (const c of [p, v]) { c.width = w; c.height = h; }
      const ctx = p.getContext('2d')!;
      ctx.fillStyle = BACKGROUND; ctx.fillRect(0, 0, w, h);
      if (keep) ctx.putImageData(keep, 0, 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const point = (e: React.PointerEvent) => {
    const r = paper.current!.getBoundingClientRect();
    const dpr = paper.current!.width / r.width;
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr, dpr };
  };
  const stroke = (ctx: CanvasRenderingContext2D, dpr: number, erase = false) => {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = erase ? BACKGROUND : color;
    ctx.lineWidth = (erase ? ERASER : LINE) * dpr;
  };

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* a pointer the browser does not track (synthetic) */ }
    const { x, y, dpr } = point(e);
    drag.current = { x, y, id: e.pointerId };
    if (tool === 'pencil' || tool === 'eraser') {
      const ctx = paper.current!.getContext('2d')!;
      stroke(ctx, dpr, tool === 'eraser');
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.01, y); ctx.stroke();
      setDirty(true);
    }
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const { x, y, dpr } = point(e);
    if (tool === 'pencil' || tool === 'eraser') {
      const ctx = paper.current!.getContext('2d')!;
      stroke(ctx, dpr, tool === 'eraser');
      ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(x, y); ctx.stroke();
      drag.current = { ...d, x, y };
    } else {
      const v = preview.current!, ctx = v.getContext('2d')!;
      ctx.clearRect(0, 0, v.width, v.height);
      stroke(ctx, dpr);
      shapePath(ctx, tool, d.x, d.y, x, y);
      ctx.stroke();
    }
  };
  const up = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!SHAPES.includes(tool)) return;
    const { x, y, dpr } = point(e);
    const v = preview.current!;
    v.getContext('2d')!.clearRect(0, 0, v.width, v.height);
    if (Math.abs(x - d.x) < 2 && Math.abs(y - d.y) < 2) return; // a click, not a shape
    const ctx = paper.current!.getContext('2d')!;
    stroke(ctx, dpr);
    shapePath(ctx, tool, d.x, d.y, x, y);
    ctx.stroke();
    setDirty(true);
  };

  const insert = () => {
    paper.current?.toBlob((blob) => {
      if (!blob) return;
      const d = new Date(), two = (n: number) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
      onInsert(new File([blob], `drawing-${stamp}.png`, { type: 'image/png' }));
      onClose();
    }, 'image/png');
  };

  const toolButton = (id: DrawTool) => (
    <button key={id} type="button" onClick={() => setTool(id)} title={t(`draw.${id}`)} aria-label={t(`draw.${id}`)} aria-pressed={tool === id} data-draw-tool={id}
      className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors ${tool === id ? 'bg-sky-500/25 text-sky-100' : 'text-zinc-300 hover:bg-fill-2'}`}>
      <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">{ICON[id]}</svg>
    </button>
  );

  // Portaled to <body>: the composer sits inside panels whose transforms would otherwise clip the dim to them.
  return createPortal(
    <div className="fade-in fixed inset-0 z-50 bg-black/50 flex items-center justify-center" data-draw-dialog="">
      <div role="dialog" aria-label={t('draw.title')} className="glass-pop pop-in !rounded-[18px] w-[80vw] h-[80vh] flex flex-col text-[12.5px]">
        <div className="flex items-center gap-3 pl-5 pr-3 h-12 shrink-0 border-b border-white/10">
          <div className="text-[14px] font-semibold">{t('draw.title')}</div>
          <div className="flex-1" />
          <button type="button" onClick={onClose} aria-label={t('draw.close')} title={t('draw.close')} className="w-8 h-8 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-fill-2">✕</button>
        </div>
        <div className="flex items-center gap-1 px-4 h-12 shrink-0 border-b border-white/10">
          {toolButton('pencil')}
          {toolButton('eraser')}
          <span className="mx-1.5 h-5 w-px bg-white/10" />
          {SHAPES.map(toolButton)}
          <span className="mx-1.5 h-5 w-px bg-white/10" />
          <label className="flex items-center gap-2 text-zinc-400 cursor-pointer" title={t('draw.color')}>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label={t('draw.color')} data-draw-color=""
              className="w-8 h-8 rounded-md border border-white/15 bg-transparent p-0.5 cursor-pointer" />
            <span className="font-mono text-[11px] uppercase">{color}</span>
          </label>
          <div className="flex-1" />
          <button type="button" disabled={!dirty} onClick={insert} data-draw-insert=""
            className="rounded-full bg-selected hover:bg-white text-on-selected font-medium text-xs px-4 py-1.5 transition-colors disabled:opacity-40">{t('draw.insert')}</button>
        </div>
        <div ref={box} className="relative flex-1 min-h-0 m-3 rounded-lg overflow-hidden bg-white">
          <canvas ref={paper} className="absolute inset-0 w-full h-full" />
          <canvas ref={preview} className={`absolute inset-0 w-full h-full touch-none ${tool === 'eraser' ? 'cursor-cell' : 'cursor-crosshair'}`}
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} data-draw-canvas="" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
