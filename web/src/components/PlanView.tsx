import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { ChatItem } from '../lib/chatStore';
import { t, useLang } from '../lib/i18n';
import { buildPlan, noteLine, type PlanStep, type PlanTurn } from '../lib/planView';
import { ApprovalItem, QuestionItem } from './ChatItems';
import FileIcon from './FileIcon';
import Icon from './Icon';
import MarkdownView from './MarkdownView';

type Item<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>;

interface Props {
  items: ChatItem[];
  running: boolean;
  /** Show this item in the chat view. */
  onJump: (itemId: string) => void;
  onApprove: (requestId: string, decision: 'allow' | 'allow_always' | 'deny', message?: string) => void;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
  /** Scroll to this turn's card once (from a checklist in the chat view). */
  focusTurn?: string | null;
}

function StatusIcon({ status, live }: { status: PlanStep['status']; live: boolean }) {
  // Keyed by status so the check pops in when a step is cleared.
  if (status === 'completed') {
    return <span key="done" className="plan-check w-5 h-5 shrink-0 rounded-full bg-emerald-400/90 text-[#05150e] flex items-center justify-center text-[11px] font-bold">✓</span>;
  }
  if (status === 'in_progress') {
    return <span key="now" className={`w-5 h-5 shrink-0 rounded-full border-2 ${live ? 'border-amber-300 border-t-transparent animate-spin' : 'border-amber-300/60'}`} />;
  }
  return <span key="todo" className="w-5 h-5 shrink-0 rounded-full border-2 border-white/25" />;
}

/** One plan step: number and text, and once done, "a. how it was done" under it. */
function StepRow({ step, index, current, live, onJump }: { step: PlanStep; index: number; current: boolean; live: boolean; onJump: (id: string) => void }) {
  useLang();
  const done = step.status === 'completed';
  const title = current && step.activeForm ? step.activeForm : step.content;
  const note = done || current ? noteLine(step.note, 200) : null;
  const target = step.items[0]?.id;
  return (
    <button type="button" disabled={!target} onClick={() => target && onJump(target)} title={target ? t('plan.jumpChat') : undefined}
      className={`group w-full flex items-start gap-3 rounded-xl px-2.5 py-2 text-left transition-colors duration-200 ${current && live ? 'bg-amber-300/[0.07]' : target ? 'hover:bg-fill' : ''}`}>
      <StatusIcon status={current ? 'in_progress' : step.status} live={live} />
      <div className="flex-1 min-w-0">
        <div className={`text-[13.5px] leading-5 transition-colors duration-300 ${done ? 'text-zinc-300' : current ? 'text-white font-medium' : 'text-zinc-400'}`}>
          <span className="tabular-nums text-zinc-500 mr-1.5">{index + 1}.</span>{title}
        </div>
        {note && <div className="mt-1 flex gap-1.5 text-[12.5px] leading-relaxed text-zinc-400"><span className="shrink-0 text-zinc-500">a.</span><span className="line-clamp-2">{note}</span></div>}
      </div>
      {target && <span className="shrink-0 mt-0.5 text-[11px] text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity">{t('plan.jumpChat')} →</span>}
    </button>
  );
}

const CREATED_SHOWN = 6;

/** Files the turn created: click to preview, or download a copy. */
function CreatedFiles({ paths }: { paths: string[] }) {
  useLang();
  const [all, setAll] = useState(false);
  const shown = all ? paths : paths.slice(0, CREATED_SHOWN);
  const open = (path: string) => window.dispatchEvent(new CustomEvent('vibe:open-file', { detail: { path } }));
  return (
    <div className="rounded-xl bg-black/15 border border-line px-2 py-2">
      <div className="px-1.5 mb-1 flex items-baseline gap-2 text-[11.5px] font-medium text-zinc-400">{t('plan.created')}<span className="tabular-nums text-zinc-500">{paths.length}</span></div>
      {shown.map((p) => {
        const slash = p.lastIndexOf('/');
        const name = p.slice(slash + 1);
        return (
          <div key={p} className="group flex items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-fill transition-colors">
            <button type="button" onClick={() => open(p)} title={p} className="min-w-0 flex-1 flex items-center gap-2.5 text-left">
              <FileIcon name={name} isDir={false} className="w-4 h-4 shrink-0" />
              <span className="shrink-0 max-w-[60%] truncate text-[13px] text-zinc-100">{name}</span>
              <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">{p.slice(0, slash)}</span>
            </button>
            <button type="button" onClick={() => open(p)} className="shrink-0 flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-zinc-300 hover:text-white hover:bg-fill-2 transition-colors">
              <Icon name="file" size={11} />{t('plan.preview')}
            </button>
            <a href={api.rawUrl(p)} download={name} className="shrink-0 flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-zinc-300 hover:text-white hover:bg-fill-2 transition-colors">
              <Icon name="download" size={11} />{t('plan.download')}
            </a>
          </div>
        );
      })}
      {!all && paths.length > CREATED_SHOWN && (
        <button type="button" onClick={() => setAll(true)} className="mt-0.5 px-1.5 text-[11px] text-zinc-500 hover:text-zinc-200">{t('plan.createdMore', { n: paths.length - CREATED_SHOWN })}</button>
      )}
    </div>
  );
}

/**
 * One request as the user asked for it: title, the plan ("진행 계획") as a numbered list where each finished
 * step gains an "a." line on how it was done, then the result. No tool calls here; the chat view has those.
 */
function TurnCard({ turn, live, onJump, onApprove, onAnswer }: { turn: PlanTurn; live: boolean } & Pick<Props, 'onJump' | 'onApprove' | 'onAnswer'>) {
  useLang();
  const done = turn.steps.filter((s) => s.status === 'completed').length;
  const total = turn.steps.length;
  const state = turn.result ? (turn.result.ok ? 'done' : 'failed') : live ? 'running' : total && done < total ? 'stopped' : null;
  // The step being worked on: the one marked in progress, else (a plan written as text) the first not yet done.
  const marked = turn.steps.findIndex((s) => s.status === 'in_progress');
  const current = live ? (marked >= 0 ? marked : turn.steps.findIndex((s) => s.status !== 'completed')) : -1;
  const lines = (turn.user?.text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const files = new Set(turn.changes.flatMap((c) => c.files.map((f) => f.path)));
  const verify = turn.verify[turn.verify.length - 1];
  // The result only once the turn has ended: until then the latest message is progress, not the outcome.
  const showAnswer = turn.answer && !live;
  const latest = live && !total ? noteLine(turn.texts[turn.texts.length - 1] ?? null, 200) : null;
  return (
    <section data-plan-turn={turn.id} className="rounded-[20px] border border-line bg-black/10 p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[14.5px] leading-6 font-semibold text-zinc-100 line-clamp-2">{lines[0]}</div>
          {lines.length > 1 && <div className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-400 line-clamp-2">{lines.slice(1).join(' · ')}</div>}
        </div>
        {state && (
          <span className={`shrink-0 mt-0.5 rounded-full px-2.5 py-0.5 text-[11px] leading-4 ${state === 'done' ? 'bg-emerald-400/15 text-emerald-200' : state === 'failed' ? 'bg-red-500/15 text-red-200' : state === 'running' ? 'bg-amber-300/15 text-amber-200' : 'bg-fill-2 text-zinc-300'}`}>
            {t(`plan.state.${state}`)}
          </span>
        )}
      </div>
      {total > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2.5">
            <span className="shrink-0 text-[11.5px] font-medium text-zinc-300">{t('plan.heading')}</span>
            <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full rounded-full bg-emerald-400/80 transition-[width] duration-500 ease-glass" style={{ width: `${(done / total) * 100}%` }} />
            </div>
            <span className="shrink-0 text-[11px] text-zinc-400 tabular-nums">{done}/{total}</span>
          </div>
          <div className="-mx-1.5">{turn.steps.map((s, i) => <StepRow key={s.key} step={s} index={i} current={i === current} live={live} onJump={onJump} />)}</div>
        </div>
      ) : live ? (
        <div className="flex items-start gap-3 px-1 py-1 text-[13px] text-zinc-400">
          <span className="w-5 h-5 shrink-0 rounded-full border-2 border-amber-300 border-t-transparent animate-spin" />
          <div className="min-w-0 flex-1 leading-5">
            {t('plan.planning')}
            {latest && <div className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-500 line-clamp-2">{latest}</div>}
          </div>
        </div>
      ) : null}
      {showAnswer && (
        <div className="rounded-xl bg-black/15 border border-line px-3.5 py-2.5">
          <div className="text-[11.5px] font-medium text-zinc-400 mb-1">{t('plan.result')}</div>
          {turn.answerFull
            ? <div className="prose-md text-[13.5px] max-w-none"><MarkdownView text={turn.answer!} /></div>
            : <div className="text-[13px] leading-relaxed text-zinc-100">{turn.answer}</div>}
        </div>
      )}
      {turn.created.length > 0 && <CreatedFiles paths={turn.created} />}
      {turn.pending.map((p) => p.kind === 'approval'
        ? <ApprovalItem key={p.id} item={p as Item<'approval'>} onDecide={(d, m) => onApprove(p.id, d, m)} />
        : <QuestionItem key={p.id} item={p as Item<'question'>} onAnswer={(a) => onAnswer(p.id, a)} />)}
      {(files.size > 0 || verify || turn.result) && (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-zinc-400">
          {files.size > 0 && <button className="rounded-full bg-fill px-2.5 py-1 hover:bg-fill-2 hover:text-white transition-colors" onClick={() => onJump(turn.changes[0].id)}>{t('plan.changes', { n: files.size })}</button>}
          {verify && <span className={`rounded-full px-2.5 py-1 ${verify.status === 'passed' ? 'bg-emerald-400/10 text-emerald-200' : verify.status === 'failed' ? 'bg-red-500/15 text-red-200' : 'bg-fill'}`}>{t(`verify.${verify.status}`)}</span>}
          {turn.result && <span className="ml-auto tabular-nums">{Math.round(turn.result.durationMs / 1000)}s{turn.result.turnCostUsd ? ` · $${turn.result.turnCostUsd.toFixed(3)}` : ''}</span>}
        </div>
      )}
    </section>
  );
}

/** The session as a checklist per turn: each plan step with what was done for it. */
function PlanView({ items, running, onJump, onApprove, onAnswer, focusTurn }: Props) {
  useLang();
  const turns = useMemo(() => buildPlan(items), [items]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Follow new work while scrolled to the bottom, like the chat.
  useEffect(() => {
    const el = content.current; if (!el) return;
    const ro = new ResizeObserver(() => { if (stick.current && !focusTurn) scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [focusTurn]);
  useEffect(() => {
    if (!focusTurn) { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); return; }
    stick.current = false;
    scroller.current?.querySelector(`[data-plan-turn="${CSS.escape(focusTurn)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focusTurn]);
  return (
    <div ref={scroller} className="absolute inset-0 overflow-y-auto" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      <div ref={content} className="px-5 py-4 space-y-4 max-w-4xl mx-auto">
        {turns.length === 0 && <div className="text-center text-zinc-500 text-sm py-10">{t('plan.empty')}</div>}
        {turns.map((turn, i) => turn.user && <TurnCard key={turn.id} turn={turn} live={running && i === turns.length - 1} onJump={onJump} onApprove={onApprove} onAnswer={onAnswer} />)}
      </div>
    </div>
  );
}

export default memo(PlanView);
