import { useEffect, useState } from 'react';

/**
 * Settings > Style: the color of the user's chat bubble and of the dark glass panels (cards, title bar buttons,
 * menus). Only the hue changes: each surface keeps its own alpha, sheen, blurred wallpaper, ring and shadow, so a
 * custom color looks like the default glass tinted another way. Unset values fall back to the stylesheet defaults
 * (index.css reads `var(--panel-rgb, <default>)`), so the default look is exactly the original one.
 */

export interface AppStyle { bubble?: string; panel?: string }

const LS_KEY = 'vibe.style';
/** What the color pickers show for the defaults (Tailwind sky-400 bubble, black panels). */
export const DEFAULT_BUBBLE = '#00bcff';
export const DEFAULT_PANEL = '#000000';

let current: AppStyle = {};
const listeners = new Set<(s: AppStyle) => void>();

function rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `c` moved toward white by `t` (0..1), as space-separated channels for `rgb(<channels> / a)`. */
function lighten([r, g, b]: [number, number, number], t: number): string {
  return [r, g, b].map((v) => Math.round(v + (255 - v) * t)).join(' ');
}

/** Sets the CSS variables the bubble and the panels read; an unset value removes them (stylesheet default). */
export function applyStyle(s: AppStyle) {
  current = s;
  const root = document.documentElement;
  const panel = s.panel ? rgb(s.panel) : null;
  if (panel) {
    root.style.setProperty('--panel-rgb', panel.join(' '));
    // Title bar buttons lighten on hover, as the default dark gray does.
    root.style.setProperty('--panel-hover-rgb', lighten(panel, 0.15));
  } else {
    root.style.removeProperty('--panel-rgb');
    root.style.removeProperty('--panel-hover-rgb');
  }
  const bubble = s.bubble ? rgb(s.bubble) : null;
  if (bubble) {
    root.style.setProperty('--bubble-rgb', bubble.join(' '));
    root.style.setProperty('--bubble-border-rgb', lighten(bubble, 0.6));
    root.dataset.bubble = '';
  } else {
    root.style.removeProperty('--bubble-rgb');
    root.style.removeProperty('--bubble-border-rgb');
    delete root.dataset.bubble;
  }
  for (const l of listeners) l(s);
}

function read(): AppStyle {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as AppStyle;
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/** Applies the stored style, and follows changes made in another window (IDE, lock screen). */
export function initStyle() {
  applyStyle(read());
  window.addEventListener('storage', (e) => { if (e.key === LS_KEY) applyStyle(read()); });
}

/** Previews without storing (while a color picker moves). */
export function previewStyle(patch: AppStyle) { applyStyle({ ...current, ...patch }); }

/** Stores and applies; `undefined` for a key resets it to the default. */
export function setStyle(patch: Partial<Record<keyof AppStyle, string | undefined>>) {
  const next: AppStyle = { ...current, ...patch };
  for (const k of Object.keys(next) as (keyof AppStyle)[]) if (!next[k]) delete next[k];
  try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  applyStyle(next);
}

export function useStyle(): AppStyle {
  const [s, setS] = useState(current);
  useEffect(() => {
    listeners.add(setS);
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}
