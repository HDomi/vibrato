import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TaskInfo } from '../lib/agent';
import { api } from '../lib/api';
import { itemsFromHistory, type ChatItem } from '../lib/chatStore';
import { t, useLang } from '../lib/i18n';
import { shortTokens } from '../lib/taskGraph';
import { subagentOf, type Subagent } from '../lib/subagents';
import { useClock } from '../lib/clock';
import MarkdownView from './MarkdownView';

/**
 * What the chat and plan views can do with a subagent the main session started: stop it, stop waiting for it (it
 * carries on in the background), jump to its card, and read its own conversation once it has one on disk.
 * Provided once per chat panel so every place that shows a subagent offers the same actions.
 */
export interface SubagentControls {
  tasks?: Record<string, TaskInfo>;
  cwd: string;
  /** The CLI session id: subagent transcripts are stored under it. */
  agentSessionId?: string;
  stop?: (taskId: string) => void;
  background?: (toolUseId: string) => void;
  showCard?: (toolUseId: string) => void;
}

const Ctx = createContext<(SubagentControls & { open: (s: Subagent) => void }) | null>(null);
export const useSubagentControls = () => useContext(Ctx);

export function SubagentProvider({ value, children }: { value: SubagentControls; children: ReactNode }) {
  const [drawer, setDrawer] = useState<Subagent | null>(null);
  const ctx = useMemo(() => ({ ...value, open: setDrawer }), [value]);
  return (
    <Ctx.Provider value={ctx}>
      {children}
      {drawer && <SubagentDrawer sa={drawer} cwd={value.cwd} agentSessionId={value.agentSessionId} onClose={() => setDrawer(null)} />}
    </Ctx.Provider>
  );
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}

/** Stop · stop waiting · transcript · show in chat, as far as this subagent and agent allow. */
export function SubagentActions({ sa, inCard = false }: { sa: Subagent; inCard?: boolean }) {
  useLang();
  const c = useSubagentControls();
  const [busy, setBusy] = useState<'stop' | 'bg' | null>(null);
  if (!c) return null;
  const running = sa.status === 'running';
  const btn = 'rounded-md px-1.5 py-0.5 text-[11px] leading-4 transition-colors disabled:opacity-40';
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-subagent-actions="" onClick={(e) => e.stopPropagation()}>
      {running && c.stop && sa.taskId && (
        <button type="button" disabled={busy === 'stop'} className={`${btn} bg-red-500/15 text-red-200 hover:bg-red-500/25`}
          onClick={() => { if (!window.confirm(t('tasks.stopConfirm', { desc: sa.description.slice(0, 80) || sa.kind }))) return; setBusy('stop'); c.stop!(sa.taskId!); }}>
          {busy === 'stop' ? t('subagent.stopping') : t('tasks.stop')}
        </button>
      )}
      {running && !sa.background && c.background && (
        <button type="button" disabled={busy === 'bg'} title={t('subagent.backgroundHint')} className={`${btn} bg-violet-500/15 text-violet-200 hover:bg-violet-500/25`}
          onClick={() => { setBusy('bg'); c.background!(sa.toolUseId); }}>
          {t('subagent.background')}
        </button>
      )}
      {!running && sa.agentId && c.agentSessionId && (
        <button type="button" className={`${btn} bg-fill text-zinc-300 hover:bg-fill-2`} onClick={() => c.open(sa)}>{t('subagent.transcript')}</button>
      )}
      {!inCard && c.showCard && (
        <button type="button" className={`${btn} text-zinc-400 hover:text-zinc-200`} onClick={() => c.showCard!(sa.toolUseId)}>{t('tasks.showCard')}</button>
      )}
    </span>
  );
}

const STATUS_DOT: Record<Subagent['status'], string> = {
  running: 'border-2 border-violet-400/80 border-t-transparent animate-spin',
  completed: 'bg-emerald-400',
  failed: 'bg-red-400',
  stopped: 'bg-zinc-500',
};

/** Numbers of one subagent: how long, tokens, tool calls. */
function stats(sa: Subagent, now: number): string {
  const ms = sa.status === 'running' && sa.startedAt ? now - sa.startedAt : sa.endedAt && sa.startedAt ? sa.endedAt - sa.startedAt : 0;
  return [ms >= 1000 ? elapsed(ms) : '', sa.totalTokens ? t('subagent.tokens', { n: shortTokens(sa.totalTokens) }) : '', sa.toolUses ? t('subagent.tools', { n: sa.toolUses }) : ''].filter(Boolean).join(' · ');
}

/** Subagents shown before "n more done". */
const SHOWN = 4;

/** The subagents a plan step started, running and finished: what each is doing, its numbers and actions. */
export function SubagentLines({ list }: { list: Subagent[] }) {
  useLang();
  const now = useClock(list.some((s) => s.status === 'running'));
  const [all, setAll] = useState(false);
  if (!list.length) return null;
  // Running ones always show; finished ones fold past SHOWN.
  const running = list.filter((s) => s.status === 'running');
  const done = list.filter((s) => s.status !== 'running');
  const room = Math.max(0, SHOWN - running.length);
  const shownDone = all ? done : done.slice(-room);
  const hidden = done.length - shownDone.length;
  return (
    <div className="mt-1.5 space-y-1.5" data-plan-subagents="">
      {[...running, ...shownDone].map((sa) => (
        <div key={sa.toolUseId} className="min-w-0" data-subagent={sa.status}>
          <div className="flex items-center gap-2 text-[11.5px] leading-4 min-w-0">
            <span className={`w-2.5 h-2.5 shrink-0 rounded-full ${STATUS_DOT[sa.status]}`} />
            <span className="shrink-0 font-medium text-violet-200/90">{sa.kind}</span>
            {sa.background && sa.status === 'running' && <span className="shrink-0 rounded bg-violet-500/15 px-1 text-[10px] text-violet-200/80">{t('subagent.inBackground')}</span>}
            <span className="truncate text-zinc-400">{sa.description}</span>
            <span className="shrink-0 ml-auto tabular-nums text-zinc-500">{stats(sa, now)}</span>
          </div>
          {(sa.summary || sa.error || (sa.status !== 'running' && sa.result)) && (
            <div className={`ml-[18px] mt-0.5 text-[11.5px] leading-4 line-clamp-2 ${sa.error ? 'text-red-300/90' : sa.status === 'running' ? 'italic text-violet-200/70' : 'text-zinc-500'}`}>
              {sa.error ?? (sa.status === 'running' ? sa.summary : sa.result ?? sa.summary)}
            </div>
          )}
          <div className="ml-[14px] mt-0.5"><SubagentActions sa={sa} /></div>
        </div>
      ))}
      {hidden > 0 && (
        <button type="button" onClick={(e) => { e.stopPropagation(); setAll(true); }} className="ml-[18px] text-[11px] text-zinc-500 hover:text-zinc-200">{t('subagent.moreDone', { n: hidden })}</button>
      )}
    </div>
  );
}

/** Under a subagent card's title in the chat: what it is doing now, its numbers, and the actions. */
export function SubagentCardHeader({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  useLang();
  const c = useSubagentControls();
  const sa = useMemo(() => subagentOf(item, c?.tasks), [item, c?.tasks]);
  const now = useClock(sa.status === 'running');
  const line = stats(sa, now);
  if (!c) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-1.5 -mt-0.5 text-[11.5px] leading-4" data-subagent-header="">
      {sa.status === 'running' && sa.summary && <span className="italic text-violet-200/75 min-w-0 truncate">{sa.summary}</span>}
      {line && <span className="tabular-nums text-zinc-500">{line}</span>}
      <SubagentActions sa={sa} inCard />
    </div>
  );
}

/** A subagent's own conversation, read from its transcript (the CLI keeps one per subagent). */
function SubagentDrawer({ sa, cwd, agentSessionId, onClose }: { sa: Subagent; cwd: string; agentSessionId?: string; onClose: () => void }) {
  useLang();
  const [items, setItems] = useState<ChatItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!agentSessionId || !sa.agentId) { setFailed(true); return; }
    let live = true;
    api.subagentMessages(cwd, agentSessionId, sa.agentId)
      .then((m) => { if (live) setItems(itemsFromHistory(m)); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [cwd, agentSessionId, sa.agentId]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="fixed inset-y-0 right-0 z-40 w-[min(560px,92vw)] glass-pop border-l border-white/10 flex flex-col" role="dialog" aria-label={t('subagent.transcript')} data-subagent-drawer="">
      <div className="flex items-center gap-2 px-4 h-11 shrink-0 border-b border-white/10 text-[12.5px]">
        <span className="font-medium text-violet-200">{sa.kind}</span>
        <span className="truncate text-zinc-400">{sa.description}</span>
        <div className="flex-1" />
        <button type="button" className="text-zinc-500 hover:text-zinc-200 px-1" onClick={onClose} aria-label={t('tasks.close')}>✕</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2.5 text-[12.5px]">
        {failed ? <div className="text-zinc-500">{t('subagent.noTranscript')}</div>
          : !items ? <div className="text-zinc-500">{t('subagent.loading')}</div>
          : items.length === 0 ? <div className="text-zinc-500">{t('subagent.noTranscript')}</div>
          : items.map((it) => it.kind === 'assistant' ? (
            <div key={it.id} className="prose-md max-w-none text-zinc-200"><MarkdownView text={it.text} baseDir={cwd} /></div>
          ) : it.kind === 'tool' ? (
            <details key={it.id} className="rounded-md border border-white/10 bg-white/[0.03]">
              <summary className={`cursor-pointer px-2 py-1 text-[11.5px] ${it.isError ? 'text-red-300' : 'text-zinc-300'}`}>{it.name}</summary>
              <pre className="px-2 pb-2 text-[11px] text-zinc-400 whitespace-pre-wrap break-all max-h-60 overflow-auto">{JSON.stringify(it.input, null, 2)}{it.output ? `\n\n${it.output.slice(0, 8000)}` : ''}</pre>
            </details>
          ) : it.kind === 'user' ? (
            <div key={it.id} className="rounded-md bg-fill px-2.5 py-1.5 text-zinc-300 whitespace-pre-wrap line-clamp-6">{it.text}</div>
          ) : null)}
      </div>
    </div>
  );
}
