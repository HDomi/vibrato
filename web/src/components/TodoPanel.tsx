import { useState } from 'react';
import type { TodoItem } from '../lib/agent';
import { t, useLang } from '../lib/i18n';

const LS_OPEN = 'vibe.todos.open';

/** The agent's task checklist pinned above the composer, so a long run shows how far it got. */
export default function TodoPanel({ todos, running }: { todos: TodoItem[]; running: boolean }) {
  useLang();
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(LS_OPEN) !== '0'; } catch { return true; } });
  if (!todos.length) return null;
  const done = todos.filter((x) => x.status === 'completed').length;
  // A finished list stays out of the way once the turn is over.
  if (done === todos.length && !running) return null;
  const current = todos.find((x) => x.status === 'in_progress');
  const toggle = () => setOpen((v) => { try { localStorage.setItem(LS_OPEN, v ? '0' : '1'); } catch { /* ignore */ } return !v; });
  return (
    <div className="shrink-0 border-t border-line bg-black/15 text-[12px]">
      <button className="w-full h-7 flex items-center gap-2 px-4 text-left text-zinc-400 hover:text-zinc-200" onClick={toggle} aria-expanded={open}>
        <span className="text-[9px] text-zinc-600 w-2">{open ? '▾' : '▸'}</span>
        <span className="font-medium text-zinc-300">{t('todos.title')}</span>
        <span className="tabular-nums text-zinc-500">{done}/{todos.length}</span>
        <span className="h-1 w-16 rounded-full bg-white/10 overflow-hidden"><span className="block h-full bg-emerald-400/70" style={{ width: `${(done / todos.length) * 100}%` }} /></span>
        {!open && current && <span className="truncate text-amber-200/80">{current.activeForm ?? current.content}</span>}
      </button>
      {open && (
        <ul className="max-h-40 overflow-y-auto px-4 pb-2 space-y-0.5">
          {todos.map((x, i) => (
            <li key={i} className={`flex items-start gap-2 leading-5 ${x.status === 'completed' ? 'text-zinc-600 line-through' : x.status === 'in_progress' ? 'text-amber-100' : 'text-zinc-400'}`}>
              <span className={`shrink-0 w-3.5 text-center ${x.status === 'completed' ? 'text-emerald-400' : x.status === 'in_progress' ? 'text-amber-400' : 'text-zinc-600'}`}>
                {x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '◐' : '○'}
              </span>
              <span className="min-w-0 break-words">{x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
