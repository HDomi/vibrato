import { useEffect, useState } from 'react';
import type { ChatItem } from '../lib/chatStore';
import type { TurnFile } from '../lib/agent';
import { api } from '../lib/api';
import { t, useLang } from '../lib/i18n';
import Icon from './Icon';

type ChangesItem = Extract<ChatItem, { kind: 'changes' }>;

const STATUS_STYLE: Record<TurnFile['status'], string> = { A: 'text-emerald-300 bg-emerald-400/10', M: 'text-amber-200 bg-amber-400/10', D: 'text-red-300 bg-red-400/10' };
const SHOWN = 8;

/** Split a one-file unified diff into hunks; the header lines before the first "@@" are dropped. */
function hunksOf(diff: string): string[][] {
  const out: string[][] = [];
  for (const l of diff.split('\n')) {
    if (l.startsWith('@@')) out.push([l]);
    else if (out.length) out[out.length - 1].push(l);
  }
  if (out.length) { const last = out[out.length - 1]; while (last.length > 1 && last[last.length - 1] === '') last.pop(); }
  return out;
}

function FileDiff({ item, file, onReverted }: { item: ChangesItem; file: TurnFile; onReverted: (whole: boolean) => void }) {
  useLang();
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    api.turnDiff(item.root, item.from, item.to, file.path).then((d) => alive && setDiff(d)).catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [item.root, item.from, item.to, file.path]);
  if (error) return <div className="px-3 py-2 text-[11px] text-red-300">{error}</div>;
  if (diff === null) return <div className="px-3 py-2 text-[11px] text-zinc-500">{t('common.loading')}</div>;
  if (file.binary) return <div className="px-3 py-2 text-[11px] text-zinc-500">{t('changes.binary')}</div>;
  const hunks = hunksOf(diff);
  const revertHunk = async (index: number) => {
    setBusy(index);
    try {
      const r = await api.turnRevert({ root: item.root, from: item.from, to: item.to, hunk: { file: file.path, index } });
      if (r.ok) { const next = new Set(done).add(index); setDone(next); if (next.size === hunks.length) onReverted(true); }
      else window.alert(t('changes.hunkFailed', { reason: r.error ?? '' }));
    } catch (e) { window.alert((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <div className="border-t border-white/5 bg-black/30">
      {hunks.map((h, n) => (
        <div key={n} className={done.has(n) ? 'opacity-40' : ''}>
          <div className="group/hunk flex items-center gap-2 px-3 h-6 text-[10.5px] font-mono text-sky-300/80 bg-sky-400/[0.04]">
            <span className="truncate">{h[0]}</span>
            <div className="flex-1" />
            {done.has(n)
              ? <span className="text-zinc-500 font-sans">{t('changes.reverted')}</span>
              : <button disabled={busy !== null} onClick={() => void revertHunk(n)} className="font-sans opacity-0 group-hover/hunk:opacity-100 flex items-center gap-1 rounded px-1.5 text-zinc-300 hover:text-white hover:bg-white/10 disabled:opacity-40">
                  <Icon name="undo" size={10} />{t('changes.revertHunk')}
                </button>}
          </div>
          <pre className="text-[11.5px] font-mono leading-[1.55] overflow-x-auto">
            {h.slice(1).map((l, i) => (
              <div key={i} className={`px-3 ${l.startsWith('+') ? 'bg-emerald-500/10 text-emerald-200' : l.startsWith('-') ? 'bg-red-500/10 text-red-200' : l.startsWith('\\') ? 'text-zinc-600' : 'text-zinc-400'}`}>{l || ' '}</div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}

/** "What this turn changed": files with +/- counts, inline diffs, and undo per hunk, file or the whole turn. */
export function TurnChangesItem({ item, onReview, reviewer }: { item: ChangesItem; onReview?: () => void; reviewer?: string }) {
  useLang();
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(item.files.length <= SHOWN);
  const [reverted, setReverted] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const adds = item.files.reduce((n, f) => n + f.additions, 0);
  const dels = item.files.reduce((n, f) => n + f.deletions, 0);
  const shown = all ? item.files : item.files.slice(0, SHOWN);
  const left = item.files.filter((f) => !reverted.has(f.path));

  const revert = async (files?: string[]) => {
    const targets = files ?? left.map((f) => f.path);
    if (!targets.length) return;
    if (!files && !window.confirm(t('changes.confirmAll', { n: targets.length }))) return;
    setBusy(true);
    try {
      let r = await api.turnRevert({ root: item.root, from: item.from, to: item.to, files: targets });
      if (r.conflicts.length && window.confirm(t('changes.confirmConflict', { n: r.conflicts.length, files: r.conflicts.slice(0, 8).join('\n') }))) {
        const forced = await api.turnRevert({ root: item.root, from: item.from, to: item.to, files: r.conflicts, force: true });
        r = { ...forced, reverted: [...r.reverted, ...forced.reverted] };
      }
      if (r.reverted.length) setReverted((prev) => new Set([...prev, ...r.reverted]));
    } catch (e) { window.alert((e as Error).message); } finally { setBusy(false); }
  };
  const openFile = (p: string) => window.dispatchEvent(new CustomEvent('vibe:open-file', { detail: { path: `${item.root}/${p}` } }));

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] text-[12px] overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-white/5">
        <Icon name="diff" size={13} className="text-zinc-400 shrink-0" />
        <span className="text-zinc-200 font-medium whitespace-nowrap">{t('changes.title', { n: item.files.length })}</span>
        <span className="text-emerald-300/90 tabular-nums">+{adds}</span>
        <span className="text-red-300/90 tabular-nums">−{dels}</span>
        <div className="flex-1" />
        {onReview && <button onClick={onReview} className="flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] text-zinc-400 hover:text-sky-200 hover:bg-white/5" title={t('review.cardHint', { agent: reviewer ?? '' })}>
          <Icon name="sparkle" size={11} />{t('review.card', { agent: reviewer ?? '' })}
        </button>}
        {left.length > 0
          ? <button disabled={busy} onClick={() => void revert()} className="flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] text-zinc-400 hover:text-amber-200 hover:bg-white/5 disabled:opacity-40" title={t('changes.revertAllHint')}>
              <Icon name="undo" size={11} />{t('changes.revertAll')}
            </button>
          : !left.length && <span className="text-[11px] text-zinc-500">{t('changes.allReverted')}</span>}
      </div>
      {shown.map((f) => {
        const isOpen = open === f.path;
        const gone = reverted.has(f.path);
        const slash = f.path.lastIndexOf('/');
        return (
          <div key={f.path} className="border-b border-white/5 last:border-b-0">
            <div className={`group/file flex items-center gap-2 px-3 h-7 cursor-pointer hover:bg-white/[0.03] ${gone ? 'opacity-45' : ''}`} onClick={() => setOpen(isOpen ? null : f.path)}>
              <span className="text-zinc-600 text-[10px] w-2">{isOpen ? '▾' : '▸'}</span>
              <span className={`shrink-0 w-4 h-4 rounded text-[10px] font-semibold leading-4 text-center ${STATUS_STYLE[f.status]}`}>{f.status}</span>
              <span className={`min-w-0 truncate font-mono text-[11.5px] ${gone ? 'line-through' : ''}`} title={f.path}>
                {slash >= 0 && <span className="text-zinc-500">{f.path.slice(0, slash + 1)}</span>}<span className="text-zinc-200">{f.path.slice(slash + 1)}</span>
              </span>
              <span className="shrink-0 tabular-nums text-[11px]">
                {f.binary ? <span className="text-zinc-500">bin</span> : <><span className="text-emerald-300/80">+{f.additions}</span> <span className="text-red-300/80">−{f.deletions}</span></>}
              </span>
              <div className="flex-1" />
              {gone ? <span className="text-[10.5px] text-zinc-500">{t('changes.reverted')}</span> : (
                <span className="flex items-center gap-0.5 opacity-0 group-hover/file:opacity-100">
                  {f.status !== 'D' && <button onClick={(e) => { e.stopPropagation(); openFile(f.path); }} className="w-6 h-6 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors" title={t('changes.open')}><Icon name="file" size={12} /></button>}
                  <button disabled={busy} onClick={(e) => { e.stopPropagation(); void revert([f.path]); }} className="w-6 h-6 flex items-center justify-center rounded-full text-zinc-400 hover:text-amber-200 hover:bg-white/10 disabled:opacity-40 transition-colors" title={t('changes.revertFile')}><Icon name="undo" size={12} /></button>
                </span>
              )}
            </div>
            {isOpen && <FileDiff item={item} file={f} onReverted={() => setReverted((prev) => new Set(prev).add(f.path))} />}
          </div>
        );
      })}
      {!all && <button onClick={() => setAll(true)} className="w-full h-7 text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03]">{t('changes.more', { n: item.files.length - SHOWN })}</button>}
    </div>
  );
}
