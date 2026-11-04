import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatItem } from '../lib/chatStore';
import { t, useLang } from '../lib/i18n';
import { buildPlan, hasWork, noteLine, type PlanStep, type PlanTurn } from '../lib/planView';
import { ApprovalItem, QuestionItem, summarizeInput } from './ChatItems';
import MarkdownView from './MarkdownView';

type Item<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>;

interface Props {
  items: ChatItem[];
  running: boolean;
  cwd: string;
  /** Show this item in the chat view. */
  onJump: (itemId: string) => void;
  onApprove: (requestId: string, decision: 'allow' | 'allow_always' | 'deny', message?: string) => void;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
  /** Scroll to this turn's card once (from a checklist in the chat view). */
  focusTurn?: string | null;
}

function StatusIcon({ status, live }: { status: PlanStep['status']; live: boolean }) {
  if (status === 'completed') {
    return <span className="w-5 h-5 shrink-0 rounded-full bg-emerald-400/90 text-[#05150e] flex items-center justify-center text-[11px] font-bold">✓</span>;
  }
  if (status === 'in_progress') {
    return <span className={`w-5 h-5 shrink-0 rounded-full border-2 ${live ? 'border-amber-300 border-t-transparent animate-spin' : 'border-amber-300/60'}`} />;
  }
  return <span className="w-5 h-5 shrink-0 rounded-full border-2 border-white/25" />;
}

function Stats({ step }: { step: PlanStep }) {
  useLang();
  const s = step.stats;
  const chips: [string, string][] = [];
  if (s.files.length) chips.push([t('plan.stat.files', { n: s.files.length }), 'text-sky-200 bg-sky-400/10']);
  if (s.commands) chips.push([t('plan.stat.commands', { n: s.commands }), 'text-zinc-200 bg-fill']);
  if (s.failed) chips.push([t('plan.stat.failed', { n: s.failed }), 'text-red-200 bg-red-500/15']);
  if (s.reads) chips.push([t('plan.stat.reads', { n: s.reads }), 'text-zinc-300 bg-fill']);
  if (s.subagents) chips.push([t('plan.stat.agents', { n: s.subagents }), 'text-violet-200 bg-violet-400/10']);
  if (s.toolSeconds >= 5) chips.push([`${Math.round(s.toolSeconds)}s`, 'text-zinc-400 bg-fill']);
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map(([label, tone]) => <span key={label} className={`rounded-full px-2 py-0.5 text-[10.5px] ${tone}`}>{label}</span>)}
    </div>
  );
}

/** One line per thing done in a step; tools open to their output. */
function Activity({ it, cwd }: { it: ChatItem; cwd: string }) {
  const [open, setOpen] = useState(false);
  if (it.kind === 'tool') {
    const summary = summarizeInput(it.name, it.input);
    return (
      <div className="rounded-xl hover:bg-fill transition-colors">
        <button className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px]" onClick={() => setOpen((v) => !v)}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${it.done ? (it.isError ? 'bg-red-400' : 'bg-emerald-400') : 'bg-amber-400 animate-pulse'}`} />
          <span className="shrink-0 font-medium text-zinc-200">{it.name}</span>
          <span className="truncate font-mono text-[11.5px] text-zinc-400 flex-1">{summary}</span>
          {it.elapsed >= 1 && <span className="shrink-0 text-[10.5px] text-zinc-500 tabular-nums">{Math.round(it.elapsed)}s</span>}
        </button>
        {open && it.output !== null && (
          <pre className={`mx-2.5 mb-2 max-h-56 overflow-auto rounded-lg bg-black/30 p-2 text-[11.5px] whitespace-pre-wrap break-all ${it.isError ? 'text-red-300' : 'text-zinc-300'}`}>{it.output.slice(0, 8000) || '—'}</pre>
        )}
      </div>
    );
  }
  if (it.kind === 'assistant') {
    if (!it.text.trim()) return null;
    return <div className="prose-md px-2.5 py-1 text-[13px] text-zinc-200"><MarkdownView text={it.text} baseDir={cwd} /></div>;
  }
  if (it.kind === 'approval') return <div className="px-2.5 py-1 text-[12px] text-amber-200">{t('plan.approval', { tool: it.toolName })} · {it.decision ?? t('plan.waiting')}</div>;
  if (it.kind === 'question') return <div className="px-2.5 py-1 text-[12px] text-amber-200">{t('plan.question')} · {it.resolved ? '✓' : t('plan.waiting')}</div>;
  if (it.kind === 'error') return <div className="px-2.5 py-1 text-[12px] text-red-300 whitespace-pre-wrap">{it.message}</div>;
  if (it.kind === 'system') return <div className="px-2.5 py-1 text-[11.5px] text-zinc-500">{it.text}</div>;
  return null;
}

function StepCard({ step, title, live, cwd, onJump, last }: { step: PlanStep; title: string; live: boolean; cwd: string; onJump: (id: string) => void; last: boolean }) {
  useLang();
  const current = step.status === 'in_progress';
  const [open, setOpen] = useState(current && live);
  // The step being worked on opens by itself; it does not close again on its own.
  useEffect(() => { if (current && live) setOpen(true); }, [current, live]);
  const note = noteLine(step.note);
  const work = step.items.filter((i) => i.kind !== 'assistant' || i.text.trim());
  return (
    <div className="relative flex gap-3">
      {/* Timeline: the icon, then a line down to the next step. */}
      <div className="flex flex-col items-center pt-0.5">
        <StatusIcon status={step.status} live={live} />
        {!last && <span className={`w-px flex-1 mt-1 ${step.status === 'completed' ? 'bg-emerald-400/40' : 'bg-white/12'}`} />}
      </div>
      <div className={`flex-1 min-w-0 mb-3 rounded-2xl border transition-colors ${current && live ? 'border-amber-300/30 bg-amber-300/[0.05]' : 'border-line bg-black/15'}`}>
        <button className="w-full text-left px-3.5 pt-2.5 pb-2 flex items-start gap-2" onClick={() => setOpen((v) => !v)} disabled={!work.length}>
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className={`text-[13.5px] leading-snug ${step.status === 'completed' ? 'text-zinc-200' : current ? 'text-white font-medium' : 'text-zinc-400'}`}>{title}</div>
            {note && <div className="text-[12px] leading-relaxed text-zinc-400">{note}</div>}
            <Stats step={step} />
          </div>
          {work.length > 0 && <span className="shrink-0 mt-0.5 text-[11px] text-zinc-500">{open ? '▾' : '▸'} {work.length}</span>}
        </button>
        {open && work.length > 0 && (
          <div className="border-t border-line px-1.5 py-1.5 space-y-0.5">
            {work.map((it) => <Activity key={it.id} it={it} cwd={cwd} />)}
            <div className="flex justify-end px-2 pt-1">
              <button className="text-[11px] text-zinc-400 hover:text-white transition-colors" onClick={() => onJump(work[0].id)}>{t('plan.jumpChat')} →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TurnCard({ turn, live, cwd, onJump, onApprove, onAnswer }: { turn: PlanTurn; live: boolean } & Pick<Props, 'cwd' | 'onJump' | 'onApprove' | 'onAnswer'>) {
  useLang();
  const done = turn.steps.filter((s) => s.status === 'completed').length;
  const total = turn.steps.length;
  const groups: { step: PlanStep; title: string }[] = [
    ...(hasWork(turn.before) ? [{ step: { ...turn.before, status: turn.hasPlan || turn.result ? 'completed' as const : 'in_progress' as const }, title: turn.hasPlan ? t('plan.before') : t('plan.work') }] : []),
    ...turn.steps.map((s) => ({ step: s, title: s.status === 'in_progress' && s.activeForm ? s.activeForm : s.content })),
    ...(hasWork(turn.after) ? [{ step: { ...turn.after, status: turn.result ? 'completed' as const : 'in_progress' as const }, title: t('plan.after') }] : []),
  ];
  const state = turn.result ? (turn.result.ok ? 'done' : 'failed') : live ? 'running' : 'stopped';
  const files = new Set(turn.changes.flatMap((c) => c.files.map((f) => f.path)));
  const verify = turn.verify[turn.verify.length - 1];
  return (
    <section data-plan-turn={turn.id} className="rounded-[20px] border border-line bg-black/10 p-4 space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {turn.user && <div className="text-[13.5px] text-zinc-100 line-clamp-3 whitespace-pre-wrap">{turn.user.text}</div>}
          {total > 0 && (
            <div className="mt-2.5 flex items-center gap-2.5">
              <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div className="h-full rounded-full bg-emerald-400/80 transition-[width] duration-500 ease-glass" style={{ width: `${(done / total) * 100}%` }} />
              </div>
              <span className="shrink-0 text-[11px] text-zinc-400 tabular-nums">{t('plan.progress', { done, total })}</span>
            </div>
          )}
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] ${state === 'done' ? 'bg-emerald-400/15 text-emerald-200' : state === 'failed' ? 'bg-red-500/15 text-red-200' : state === 'running' ? 'bg-amber-300/15 text-amber-200' : 'bg-fill-2 text-zinc-300'}`}>
          {t(`plan.state.${state}`)}
        </span>
      </div>
      {groups.length > 0 && (
        <div>
          {groups.map((g, i) => <StepCard key={g.step.key} step={g.step} title={g.title} live={live} cwd={cwd} onJump={onJump} last={i === groups.length - 1} />)}
        </div>
      )}
      {turn.pending.map((p) => p.kind === 'approval'
        ? <ApprovalItem key={p.id} item={p as Item<'approval'>} onDecide={(d, m) => onApprove(p.id, d, m)} />
        : <QuestionItem key={p.id} item={p as Item<'question'>} onAnswer={(a) => onAnswer(p.id, a)} />)}
      {(files.size > 0 || verify || turn.result) && (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-zinc-400">
          {files.size > 0 && <button className="rounded-full bg-fill px-2.5 py-1 hover:bg-fill-2 hover:text-white transition-colors" onClick={() => onJump(turn.changes[0].id)}>{t('plan.changes', { n: files.size })}</button>}
          {verify && <span className={`rounded-full px-2.5 py-1 ${verify.status === 'passed' ? 'bg-emerald-400/10 text-emerald-200' : verify.status === 'failed' ? 'bg-red-500/15 text-red-200' : 'bg-fill'}`}>{t(`verify.${verify.status}`)}</span>}
          {turn.result && <span className="ml-auto tabular-nums">{Math.round(turn.result.durationMs / 1000)}s{turn.result.costUsd ? ` · $${turn.result.costUsd.toFixed(3)}` : ''}</span>}
        </div>
      )}
    </section>
  );
}

/** The session as a checklist per turn: each plan step with what was done for it. */
function PlanView({ items, running, cwd, onJump, onApprove, onAnswer, focusTurn }: Props) {
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
        {turns.map((turn, i) => <TurnCard key={turn.id} turn={turn} live={running && i === turns.length - 1} cwd={cwd} onJump={onJump} onApprove={onApprove} onAnswer={onAnswer} />)}
      </div>
    </div>
  );
}

export default memo(PlanView);
