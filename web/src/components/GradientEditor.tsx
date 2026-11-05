import { useEffect, useRef, useState } from 'react';
import type { Gradient } from '../lib/api';
import { t } from '../lib/i18n';
import { gradientCss } from '../lib/wallpaper';

/** Matches GRADIENT_MAX_STOPS in server/wallpaper.ts. */
const MAX_STOPS = 12;
/** A handle pulled this far (px) above or below the track is removed on release. */
const REMOVE_DIST = 36;

interface Stop { id: number; color: string; pos: number }
interface Drag { id: number; pointer: number; startX: number; moved: boolean; created: boolean; fixed: boolean; removing: boolean }

let nextId = 1;
const withIds = (g: Gradient): Stop[] => g.stops.map((s) => ({ id: nextId++, color: s.color, pos: s.pos }));
const sorted = (stops: Stop[]) => [...stops].sort((a, b) => a.pos - b.pos);
const key = (stops: { color: string; pos: number }[]) => sorted(stops as Stop[]).map((s) => `${s.color}@${s.pos}`).join(',');
const round = (pos: number) => Math.round(Math.min(100, Math.max(0, pos)) * 10) / 10;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The color the gradient already shows at `pos`, so a new stop does not change the look until edited. */
function colorAt(stops: Stop[], pos: number): string {
  const s = sorted(stops);
  const hi = s.findIndex((x) => x.pos >= pos);
  if (hi <= 0) return s[Math.max(0, hi)].color;
  const a = s[hi - 1], b = s[hi];
  const f = b.pos === a.pos ? 0 : (pos - a.pos) / (b.pos - a.pos);
  const [ar, ag, ab] = hexToRgb(a.color), [br, bg, bb] = hexToRgb(b.color);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * f).toString(16).padStart(2, '0');
  return `#${mix(ar, br)}${mix(ag, bg)}${mix(ab, bb)}`;
}

/**
 * Gradient stops on a bar. The end handles are pinned to 0% and 100%; a click on the empty strip above the
 * bar adds a stop there (and keeps dragging it). A click on any handle opens the color picker, a drag moves
 * a middle handle, and pulling one away from the strip (or Delete while focused) removes it.
 * `onChange(g, commit)`: commit is false for live previews mid-drag, true once a change should be stored.
 */
export default function GradientEditor({ value, onChange }: { value: Gradient; onChange: (g: Gradient, commit: boolean) => void }) {
  const [stops, setStops] = useState<Stop[]>(() => withIds(value));
  const [selected, setSelected] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const pickId = useRef<number | null>(null);
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  const lastEdit = useRef(0);

  // Follow the stored gradient (another window, a rejected save) but not a reply that lags behind fresh edits.
  useEffect(() => {
    if (drag || Date.now() - lastEdit.current < 1500 || key(value.stops) === key(stopsRef.current)) return;
    setStops(withIds(value));
  }, [value.stops]); // eslint-disable-line react-hooks/exhaustive-deps

  const emit = (next: Stop[], commit: boolean) => {
    lastEdit.current = Date.now();
    setStops(next);
    onChange({ angle: value.angle, stops: sorted(next).map(({ color, pos }) => ({ color, pos })) }, commit);
  };

  const posAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return round(((clientX - r.left) / r.width) * 100);
  };
  const isEnd = (id: number) => {
    const s = sorted(stopsRef.current);
    return s[0].id === id || s[s.length - 1].id === id;
  };

  const openPicker = (id: number) => {
    const s = stopsRef.current.find((x) => x.id === id);
    const input = picker.current;
    if (!s || !input) return;
    pickId.current = id;
    input.value = s.color;
    input.style.left = `${s.pos}%`;
    try { input.showPicker(); } catch { input.click(); }
  };
  const pickColor = (color: string) => {
    const id = pickId.current;
    if (id == null) return;
    emit(stopsRef.current.map((s) => (s.id === id ? { ...s, color } : s)), true);
  };

  const remove = (id: number) => {
    if (isEnd(id) || stopsRef.current.length <= 2) return;
    setSelected(null);
    emit(stopsRef.current.filter((s) => s.id !== id), true);
  };

  const begin = (e: React.PointerEvent, id: number, created: boolean) => {
    track.current!.setPointerCapture(e.pointerId);
    setSelected(id);
    setDrag({ id, pointer: e.pointerId, startX: e.clientX, moved: false, created, fixed: !created && isEnd(id), removing: false });
  };

  const onTrackDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.target !== track.current || stops.length >= MAX_STOPS) return;
    const pos = posAt(e.clientX);
    if (pos <= 0 || pos >= 100) return;
    const stop = { id: nextId++, color: colorAt(stops, pos), pos };
    emit([...stops, stop], false);
    begin(e, stop.id, true);
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointer || drag.fixed) return;
    const moved = drag.moved || Math.abs(e.clientX - drag.startX) > 3;
    const r = track.current!.getBoundingClientRect();
    const removing = !drag.created && (e.clientY < r.top - REMOVE_DIST || e.clientY > r.bottom + REMOVE_DIST);
    if (moved !== drag.moved || removing !== drag.removing) setDrag({ ...drag, moved, removing });
    if (!moved) return;
    // Middle stops stay strictly inside so the pinned ends keep their place.
    const pos = Math.min(99.9, Math.max(0.1, posAt(e.clientX)));
    emit(stopsRef.current.map((s) => (s.id === drag.id ? { ...s, pos } : s)), false);
  };

  const onUp = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    setDrag(null);
    if (drag.removing) remove(drag.id);
    else if (drag.moved || drag.created) emit(sorted(stopsRef.current), true);
    else openPicker(drag.id);
  };

  const onKey = (e: React.KeyboardEvent, id: number) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(id); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(id); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !isEnd(id)) {
      e.preventDefault();
      const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1);
      emit(stops.map((s) => (s.id === id ? { ...s, pos: Math.min(99.9, Math.max(0.1, round(s.pos + step))) } : s)), true);
    }
  };

  return (
    <div className="relative px-2 select-none">
      <div ref={track} onPointerDown={onTrackDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        className={`relative h-7 ${stops.length < MAX_STOPS ? 'cursor-copy' : ''}`}>
        {stops.map((s) => {
          const end = isEnd(s.id);
          const active = selected === s.id;
          const gone = drag?.id === s.id && drag.removing;
          return (
            <button key={s.id} type="button" aria-label={t('wall.stop', { pos: Math.round(s.pos) })}
              onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); begin(e, s.id, false); }}
              onKeyDown={(e) => onKey(e, s.id)} onFocus={() => setSelected(s.id)}
              style={{ left: `${s.pos}%`, zIndex: active ? 2 : 1 }}
              className={`absolute bottom-0 -translate-x-1/2 flex flex-col items-center outline-none transition-opacity ${gone ? 'opacity-30' : ''} ${end ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'}`}>
              <span className={`block w-4 h-4 rounded-[5px] border-2 ${active ? 'border-white shadow-[0_0_0_2px_rgb(0_0_0/.5)]' : 'border-white/70'}`}
                style={{ backgroundColor: s.color }} />
              <span className={`block w-0 h-0 border-x-[4px] border-x-transparent border-t-[5px] ${active ? 'border-t-white' : 'border-t-white/70'}`} />
            </button>
          );
        })}
      </div>
      <div className="h-7 rounded-md border border-white/15" style={{ backgroundImage: gradientCss({ angle: 90, stops }) }} />
      <input ref={picker} type="color" tabIndex={-1} aria-hidden onChange={(e) => pickColor(e.target.value)}
        className="absolute top-0 w-0 h-0 opacity-0 pointer-events-none" />
    </div>
  );
}
