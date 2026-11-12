import { useEffect, type RefObject } from 'react';

const SKIP = 'cv-skip';
/** How far outside the scroll viewport items stay rendered (px, above and below). */
const MARGIN = 1500;

/**
 * Long chats and plans keep every item in the DOM. Items far outside the viewport get
 * `content-visibility: hidden` so style, layout and paint skip them while scrolling and streaming.
 * Only far items are contained: near ones keep overflowing popovers and hover bars unclipped.
 * The height an item had when it left is kept as its placeholder size, so nothing jumps.
 *
 * Observes direct children of `content` that carry `attr`.
 */
export function useSkipOffscreen(scroller: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, attr: string, key?: unknown) {
  useEffect(() => {
    const root = scroller.current, box = content.current;
    if (!root || !box || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const el = e.target as HTMLElement;
        if (e.isIntersecting) { el.classList.remove(SKIP); continue; }
        if (el.classList.contains(SKIP)) continue;
        const h = e.boundingClientRect.height;
        if (!h) continue;
        // contain-intrinsic-size is the content box: take padding and border off the measured height.
        const cs = getComputedStyle(el);
        const inner = h - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
        el.style.containIntrinsicSize = `auto ${Math.max(0, inner)}px`;
        el.classList.add(SKIP);
      }
    }, { root, rootMargin: `${MARGIN}px 0px` });
    const watch = (n: Node) => { if (n instanceof HTMLElement && n.hasAttribute(attr)) io.observe(n); };
    box.childNodes.forEach(watch);
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach(watch);
        r.removedNodes.forEach((n) => { if (n instanceof HTMLElement) io.unobserve(n); });
      }
    });
    mo.observe(box, { childList: true });
    return () => {
      io.disconnect(); mo.disconnect();
      box.querySelectorAll(`.${SKIP}`).forEach((el) => el.classList.remove(SKIP));
    };
  }, [scroller, content, attr, key]);
}

/** Render a skipped item again before measuring or scrolling to something inside it. */
export function revealSkipped(node: Node | null | undefined) {
  const el = node instanceof Element ? node : node?.parentElement;
  el?.closest(`.${SKIP}`)?.classList.remove(SKIP);
}
