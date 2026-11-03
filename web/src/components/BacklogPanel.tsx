import { useState } from 'react';
import type { Backlog, BacklogItem } from '../lib/api';
import type { PermissionModeId } from '../lib/agent';
import { t, useLang } from '../lib/i18n';
import Icon from './Icon';

const STATUS_DOT: Record<BacklogItem['status'], string> = {
  todo: 'border border-zinc-500', running: 'bg-amber-400 animate-pulse', done: 'bg-emerald-400', failed: 'bg-red-400', stopped: 'bg-zinc-500',
};
const MODES: { id: PermissionModeId; key: string }[] = [
  { id: 'default', key: 'chat.mode.default' }, { id: 'acceptEdits', key: 'chat.mode.acceptEdits' },
  { id: 'bypassPermissions', key: 'chat.mode.bypass' }, { id: 'auto', key: 'chat.mode.auto' },
];

/** Queue of prompts for this project, run one by one in fresh sessions while the queue is on. */
export default function BacklogPanel({ backlog, onChange, onFocusSession, compact }: {
  backlog: Backlog;
  onChange: (fn: (b: Backlog) => Backlog) => void;
  onFocusSession: (id: string) => void;
  /** Start screen: a lighter frame without the popover chrome. */
  compact?: boolean;
}) {
  useLang();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const todo = backlog.items.filter((i) => i.status === 'todo').length;
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    onChange((b) => ({ ...b, items: [...b.items, { id: crypto.randomUUID(), text, status: 'todo', createdAt: Date.now() }] }));
    setDraft('');
  };
  const move = (id: string, dir: -1 | 1) => onChange((b) => {
    const items = b.items.slice();
    const i = items.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= items.length) return b;
    [items[i], items[j]] = [items[j], items[i]];
    return { ...b, items };
  });
  const patch = (id: string, p: Partial<BacklogItem>) => onChange((b) => ({ ...b, items: b.items.map((x) => (x.id === id ? { ...x, ...p } : x)) }));
  const remove = (id: string) => onChange((b) => ({ ...b, items: b.items.filter((x) => x.id !== id) }));
  const clearDone = () => onChange((b) => ({ ...b, items: b.items.filter((x) => x.status === 'todo' || x.status === 'running') }));
  const finished = backlog.items.some((i) => i.status !== 'todo' && i.status !== 'running');
  const approvals = backlog.mode === 'default';

  return (
    <div className={`text-[12px] ${compact ? '' : 'w-[440px]'}`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon name="list" size={14} className="text-zinc-400" />
        <span className="font-medium text-zinc-200">{t('backlog.title')}</span>
        <span className="text-zinc-500">{t('backlog.count', { n: todo })}</span>
        <div className="flex-1" />
        {finished && <button onClick={clearDone} className="text-[11px] text-zinc-500 hover:text-zinc-200">{t('backlog.clearDone')}</button>}
        <button disabled={!todo && !backlog.auto} onClick={() => onChange((b) => ({ ...b, auto: !b.auto }))}
          className={`flex items-center gap-1 rounded-full px-2 py-1 text-[11px] disabled:opacity-40 ${backlog.auto ? 'bg-amber-400/15 text-amber-200 hover:bg-amber-400/25' : 'bg-emerald-400/15 text-emerald-200 hover:bg-emerald-400/25'}`}>
          <Icon name={backlog.auto ? 'stop' : 'play'} size={10} filled />{backlog.auto ? t('backlog.pause') : t('backlog.run')}
        </button>
      </div>
      <div className="flex items-center gap-1.5 mb-2 flex-wrap text-[11px]">
        <div className="inline-flex rounded-md bg-white/5 p-0.5">
          {(['claude', 'codex'] as const).map((a) => (
            <button key={a} onClick={() => onChange((b) => ({ ...b, agent: a }))} className={`px-2 py-0.5 rounded ${backlog.agent === a ? 'bg-white/15 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>{a === 'claude' ? 'Claude' : 'Codex'}</button>
          ))}
        </div>
        <select value={backlog.mode} onChange={(e) => onChange((b) => ({ ...b, mode: e.target.value }))} className="bg-black/20 border border-line rounded-md px-1.5 py-0.5 outline-none">
          {MODES.filter((m) => m.id !== 'auto' || backlog.agent === 'claude').map((m) => <option key={m.id} value={m.id}>{t(m.key)}</option>)}
        </select>
        <label className="flex items-center gap-1 cursor-pointer text-zinc-400"><input type="checkbox" checked={backlog.worktree} onChange={(e) => onChange((b) => ({ ...b, worktree: e.target.checked }))} />{t('backlog.worktree')}</label>
      </div>
      {approvals && todo > 0 && <div className="mb-2 text-[11px] text-amber-300/80">{t('backlog.approvalWarn')}</div>}
      <div className="space-y-1 max-h-72 overflow-y-auto">
        {backlog.items.map((it, n) => (
          <div key={it.id} className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-white/[0.04]">
            <span className={`mt-1.5 w-2 h-2 shrink-0 rounded-full ${STATUS_DOT[it.status]}`} title={t(`backlog.status.${it.status}`)} />
            {editing === it.id ? (
              <textarea autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} rows={2}
                onBlur={() => { if (editText.trim()) patch(it.id, { text: editText.trim() }); setEditing(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } if (e.key === 'Escape') setEditing(null); }}
                className="flex-1 min-w-0 rounded bg-black/40 border border-white/10 px-2 py-1 outline-none resize-none" />
            ) : (
              <div onDoubleClick={() => { if (it.status === 'todo') { setEditing(it.id); setEditText(it.text); } }}
                onClick={() => { if (it.sessionId) onFocusSession(it.sessionId); }}
                className={`flex-1 min-w-0 whitespace-pre-wrap break-words leading-relaxed ${it.status === 'done' ? 'text-zinc-500 line-through' : it.status === 'todo' ? 'text-zinc-200' : 'text-zinc-300'} ${it.sessionId ? 'cursor-pointer hover:text-white' : ''}`}
                title={it.sessionId ? t('backlog.open') : it.status === 'todo' ? t('backlog.editHint') : undefined}>
                {it.text.length > 220 ? `${it.text.slice(0, 220)}…` : it.text}
              </div>
            )}
            <div className="shrink-0 flex items-center opacity-0 group-hover:opacity-100">
              {it.status === 'todo' && <>
                <button disabled={n === 0} onClick={() => move(it.id, -1)} className="w-5 h-5 flex items-center justify-center rounded-full text-zinc-500 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors">↑</button>
                <button disabled={n === backlog.items.length - 1} onClick={() => move(it.id, 1)} className="w-5 h-5 flex items-center justify-center rounded-full text-zinc-500 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors">↓</button>
              </>}
              {(it.status === 'failed' || it.status === 'stopped') && <button onClick={() => patch(it.id, { status: 'todo', sessionId: undefined })} className="w-5 h-5 flex items-center justify-center rounded-full text-zinc-500 hover:text-white hover:bg-white/10 transition-colors" title={t('backlog.retry')}><Icon name="reload" size={10} /></button>}
              {it.status !== 'running' && <button onClick={() => remove(it.id)} className="w-5 h-5 flex items-center justify-center rounded-full text-zinc-500 hover:text-red-300 hover:bg-white/10 transition-colors" title={t('backlog.remove')}><Icon name="close" size={10} /></button>}
            </div>
          </div>
        ))}
        {!backlog.items.length && <div className="px-2 py-2 text-[11px] text-zinc-600 leading-relaxed">{t('backlog.empty')}</div>}
      </div>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder={t('backlog.placeholder')}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }}
        className="mt-2 w-full rounded-md bg-black/40 border border-white/10 focus:border-sky-400/40 px-2.5 py-1.5 outline-none resize-none text-[12.5px]" />
    </div>
  );
}
