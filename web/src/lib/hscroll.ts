import { useCallback, useRef } from 'react';

/**
 * Lets a mouse wheel scroll a horizontal strip (tab rows). A plain wheel only sends deltaY, which an
 * `overflow-x` element ignores, so with its scrollbar hidden a mouse had no way to reach the tabs past the edge.
 * Trackpad swipes (mostly deltaX) are left to the browser. Returns a callback ref, so the strip may mount later.
 */
export function useWheelScrollX<T extends HTMLElement>() {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((el: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const step = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? e.deltaY * el.clientWidth : e.deltaY;
      const next = Math.min(max, Math.max(0, el.scrollLeft + step));
      if (next === el.scrollLeft) return;
      e.preventDefault();
      el.scrollLeft = next;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    cleanup.current = () => el.removeEventListener('wheel', onWheel);
  }, []);
}
