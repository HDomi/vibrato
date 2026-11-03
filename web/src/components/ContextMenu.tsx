import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export interface MenuItem {
  label?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

interface State { x: number; y: number; items: MenuItem[] }
interface Ctx { open: (e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: MenuItem[]) => void; close: () => void }

const MenuCtx = createContext<Ctx>({ open: () => {}, close: () => {} });

/** Mount once near the root. Children call useContextMenu().open(event, items) from onContextMenu. */
export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const open = useCallback<Ctx['open']>((e, items) => {
    e.preventDefault(); e.stopPropagation();
    if (!items.length) return;
    setState({ x: e.clientX, y: e.clientY, items });
  }, []);
  const close = useCallback(() => setState(null), []);

  useEffect(() => {
    if (!state) return;
    const onDown = (ev: MouseEvent) => { if (!ref.current?.contains(ev.target as Node)) close(); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(); };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey); window.removeEventListener('blur', close); window.removeEventListener('resize', close); };
  }, [state, close]);

  // Keep the menu inside the viewport.
  useEffect(() => {
    const el = ref.current; if (!el || !state) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(state.x, window.innerWidth - r.width - 8);
    const y = Math.min(state.y, window.innerHeight - r.height - 8);
    el.style.left = `${Math.max(4, x)}px`; el.style.top = `${Math.max(4, y)}px`;
  }, [state]);

  const value = useMemo(() => ({ open, close }), [open, close]);
  return (
    <MenuCtx.Provider value={value}>
      {children}
      {state && (
        <div ref={ref} data-context-menu="" className="glass-pop pop-in fixed z-50 min-w-[190px] rounded-xl p-1 text-[13px] select-none" style={{ left: state.x, top: state.y }}
          onContextMenu={(e) => e.preventDefault()}>
          {state.items.map((it, i) => it.separator
            ? <div key={i} className="my-1 border-t border-white/10" />
            : (
              <button key={i} disabled={it.disabled}
                className={`w-full flex items-center gap-4 rounded-lg px-3 py-1.5 text-left disabled:opacity-40 ${it.danger ? 'text-red-300 hover:bg-red-500/15' : 'text-zinc-200 hover:bg-white/10'}`}
                onClick={() => { close(); it.onClick?.(); }}>
                <span className="flex-1">{it.label}</span>
                {it.shortcut && <span className="text-[11px] text-zinc-500">{it.shortcut}</span>}
              </button>
            ))}
        </div>
      )}
    </MenuCtx.Provider>
  );
}

export function useContextMenu() { return useContext(MenuCtx); }
