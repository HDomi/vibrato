import { useEffect, useRef, useState } from 'react';
import { api, type SavedPrompt } from '../lib/api';
import { t, useLang } from '../lib/i18n';

let cache: SavedPrompt[] | null = null;

/** "Prompts" button beside Attach: insert a saved instruction, or save the current draft as one. */
export default function PromptMenu({ draft, onInsert, disabled }: { draft: string; onInsert: (text: string) => void; disabled?: boolean }) {
  useLang();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<SavedPrompt[]>(cache ?? []);
  const [naming, setNaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    api.prompts().then((p) => { cache = p; setList(p); setError(null); }).catch((e) => setError(e.message));
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) { setOpen(false); setNaming(null); } };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setNaming(null); } };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, [open]);

  const persist = (next: SavedPrompt[]) => {
    setList(next); cache = next;
    api.savePrompts(next).then((p) => { cache = p; setList(p); setError(null); }).catch((e) => setError(e.message));
  };
  const save = () => {
    const text = draft.trim();
    if (!text) return;
    persist([...list, { id: crypto.randomUUID(), name: (naming ?? '').trim() || text.split('\n')[0].slice(0, 40), text }]);
    setNaming(null);
  };

  return (
    <div ref={box} className="relative">
      <button type="button" disabled={disabled} onClick={() => setOpen((v) => !v)} className={`text-xs px-2 hover:text-white disabled:opacity-40 ${open ? 'text-white' : 'text-zinc-400'}`} title={t('prompts.title')}>
        📝 {t('prompts.button')}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-96 max-w-[80vw] glass-pop pop-in rounded-xl py-1 text-[13px] z-30">
          {error && <div className="px-3 py-1 text-[11px] text-red-300">{error}</div>}
          {list.length === 0 && <div className="px-3 py-2 text-xs text-zinc-500">{t('prompts.empty')}</div>}
          <div className="max-h-72 overflow-y-auto">
            {list.map((p) => (
              <div key={p.id} className="group flex items-start gap-2 px-3 py-1.5 hover:bg-white/5 cursor-pointer" title={p.text}
                onClick={() => { onInsert(p.text); setOpen(false); }}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-zinc-200">{p.name}</div>
                  {p.name !== p.text && <div className="truncate text-[11px] text-zinc-500">{p.text.replace(/\s+/g, ' ')}</div>}
                </div>
                <button className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-300 text-xs px-1" title={t('prompts.delete')}
                  onClick={(e) => { e.stopPropagation(); if (window.confirm(t('prompts.confirmDelete', { name: p.name }))) persist(list.filter((x) => x.id !== p.id)); }}>✕</button>
              </div>
            ))}
          </div>
          <div className="border-t border-white/10 mt-1 pt-1 px-2">
            {naming === null ? (
              <button className="w-full text-left px-1 py-1 text-xs text-sky-300 hover:text-sky-200 disabled:text-zinc-600" disabled={!draft.trim()}
                onClick={() => setNaming(draft.trim().split('\n')[0].slice(0, 40))} title={draft.trim() ? undefined : t('prompts.saveHint')}>
                ＋ {t('prompts.saveCurrent')}
              </button>
            ) : (
              <form className="flex items-center gap-2 py-1" onSubmit={(e) => { e.preventDefault(); save(); }}>
                <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder={t('prompts.namePlaceholder')} aria-label={t('prompts.namePlaceholder')}
                  className="flex-1 min-w-0 rounded bg-black/20 border border-line px-2 py-1 text-xs outline-none" />
                <button className="text-xs text-sky-300">{t('prompts.save')}</button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
