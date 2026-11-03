import { useEffect, useRef, useState } from 'react';
import { api, type WorktreeInfo, type WorktreeStatus } from '../lib/api';
import type { AgentId } from '../lib/agent';
import { t, useLang } from '../lib/i18n';
import Icon from './Icon';
import { toast } from './Toast';

/** Chat header badge of a worktree session: branch, state, and "merge and clean up" / "discard". */
interface Partner { id: string; agent: AgentId; worktree: WorktreeInfo; running: boolean }

export default function WorktreeChip({ info, running, onFinished, commitTitle, partner, onFocusPartner, onClosePartner, othersUsing = 0 }: {
  info: WorktreeInfo; running: boolean; onFinished: () => void;
  /** Other open sessions working in this folder; merging or discarding would pull it from under them. */
  othersUsing?: number;
  /** Commit message used when leftover changes are committed before merging. */
  commitTitle: string;
  /** Comparison partner: adopting this side discards the other worktree and closes its session. */
  partner?: Partner; onFocusPartner?: (id: string) => void; onClosePartner?: (id: string) => void;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<WorktreeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean; list?: string[] } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    api.worktreeStatus(info).then(setSt).catch(() => setSt(null));
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); setOpen(false); } };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, [open, info]);

  const [dirtyBlock, setDirtyBlock] = useState(false);
  const merge = async (commit: boolean, adopt = false) => {
    if (adopt && partner && !window.confirm(t('pair.confirmAdopt', { agent: partner.agent === 'claude' ? 'Claude' : 'Codex' }))) return;
    setBusy(true); setMessage(null);
    try {
      const r = await api.worktreeMerge(info, commit ? commitTitle : undefined);
      if (r.ok) {
        if (adopt && partner) { await api.worktreeRemove(partner.worktree, true).catch(() => {}); onClosePartner?.(partner.id); }
        setOpen(false); onFinished();
        toast(r.merged ? t('worktree.merged', { branch: info.branch, base: info.baseBranch ?? '' }) : t('worktree.removedOnly'));
      } else {
        setDirtyBlock(r.reason === 'dirty');
        setMessage({ text: r.reason && r.reason !== 'git' ? t(`worktree.err.${r.reason}`, { base: info.baseBranch ?? '' }) : r.message, error: true, list: r.conflicts });
      }
    } catch (e) { setMessage({ text: (e as Error).message, error: true }); } finally { setBusy(false); }
  };
  const discard = async () => {
    if (!window.confirm(t('worktree.confirmDiscard', { branch: info.branch, n: st?.dirty.length ?? 0, ahead: st?.ahead ?? 0 }))) return;
    setBusy(true);
    try {
      const r = await api.worktreeRemove(info, true);
      if (r.ok) { setOpen(false); onFinished(); } else setMessage({ text: r.message, error: true });
    } catch (e) { setMessage({ text: (e as Error).message, error: true }); } finally { setBusy(false); }
  };

  return (
    <div ref={root} className="relative shrink-0">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 rounded-md bg-violet-400/10 hover:bg-violet-400/20 px-1.5 py-0.5 text-violet-200 max-w-40" title={info.path}>
        <Icon name="branch" size={12} /><span className="truncate font-mono text-[11px]">{info.branch}</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-30 w-[340px] glass-pop pop-in rounded-xl p-3 space-y-2.5 text-[12px] whitespace-normal">
          <div className="flex items-center gap-2">
            <Icon name="branch" size={14} className="text-violet-300" />
            <span className="font-mono text-zinc-100 truncate">{info.branch}</span>
            {info.baseBranch && <span className="text-zinc-500 shrink-0">← {info.baseBranch}</span>}
          </div>
          <div className="text-[11px] text-zinc-500 font-mono break-all">{info.path}</div>
          {st && (st.exists ? (
            <div className="flex gap-3 text-[11px]">
              <span className={st.ahead ? 'text-emerald-300' : 'text-zinc-500'}>{t('worktree.commits', { n: st.ahead })}</span>
              <span className={st.dirty.length ? 'text-amber-300' : 'text-zinc-500'}>{t('worktree.uncommitted', { n: st.dirty.length })}</span>
            </div>
          ) : <div className="text-[11px] text-amber-300">{t('worktree.missing')}</div>)}
          {partner && (
            <div className="flex items-center gap-2 rounded-md bg-violet-400/[0.07] px-2 py-1.5 text-[11px]">
              <span className="text-violet-200">{t('pair.partner', { agent: partner.agent === 'claude' ? 'Claude' : 'Codex' })}</span>
              <span className="font-mono text-zinc-500 truncate min-w-0">{partner.worktree.branch}</span>
              <div className="flex-1" />
              <button onClick={() => { setOpen(false); onFocusPartner?.(partner.id); }} className="shrink-0 rounded px-1.5 py-0.5 text-zinc-300 hover:bg-white/10">{t('pair.show')}</button>
            </div>
          )}
          {message && (
            <div className={`rounded-md px-2 py-1.5 text-[11px] leading-relaxed ${message.error ? 'bg-red-500/10 text-red-200' : 'bg-white/5 text-zinc-300'}`}>
              {message.text}
              {message.list?.length ? <div className="mt-1 font-mono text-zinc-400">{message.list.slice(0, 8).map((f) => <div key={f} className="truncate">{f}</div>)}</div> : null}
            </div>
          )}
          {info.shared ? <div className="text-[11px] text-zinc-400 leading-relaxed">{t('worktree.shared')}</div> : <>
          {othersUsing > 0 && <div className="text-[11px] text-amber-300/90">{t('worktree.inUse', { n: othersUsing })}</div>}
          <div className="flex items-center gap-2 pt-0.5">
            {partner
              ? <button disabled={busy || running || partner.running || othersUsing > 0 || !st?.exists} onClick={() => void merge(true, true)} title={t('pair.adoptHint')}
                  className="rounded-md bg-violet-500/25 hover:bg-violet-500/35 disabled:opacity-40 px-2.5 py-1 text-violet-100">{t('pair.adopt')}</button>
              : <button disabled={busy || running || othersUsing > 0 || !st?.exists} onClick={() => void merge(dirtyBlock)} title={running ? t('verify.busy') : t('worktree.mergeHint')}
                  className="rounded-md bg-violet-500/25 hover:bg-violet-500/35 disabled:opacity-40 px-2.5 py-1 text-violet-100">{dirtyBlock ? t('worktree.commitMerge') : t('worktree.merge')}</button>}
            <button onClick={() => void api.open(info.path, 'finder').catch(() => {})} className="rounded-md px-2 py-1 text-zinc-400 hover:text-white hover:bg-white/5">Finder</button>
            <div className="flex-1" />
            <button disabled={busy || running || othersUsing > 0} onClick={() => void discard()} className="rounded-md px-2 py-1 text-zinc-500 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-40">{t('worktree.discard')}</button>
          </div>
          </>}
        </div>
      )}
    </div>
  );
}
