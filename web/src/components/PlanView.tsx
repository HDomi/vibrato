import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { TaskInfo } from '../lib/agent';
import type { ChatItem } from '../lib/chatStore';
import { t, useLang } from '../lib/i18n';
import { buildPlan, liveTasksByTurn, noteLine, type PlanStep, type PlanTurn, type TurnTasks } from '../lib/planView';
import { taskKind } from '../lib/taskGraph';
import { resolveLocal } from '../lib/localPath';
import { ApprovalItem, QuestionItem } from './ChatItems';
import FileIcon from './FileIcon';
import Icon from './Icon';
import MarkdownView from './MarkdownView';

type Item<K extends ChatItem['kind']> = Extract<ChatItem, { kind: K }>;

interface Props {
  items: ChatItem[];
  /** Session folder, for relative paths the agent names. */
  cwd: string;
  running: boolean;
  /** The session's subagents / background tasks; running ones show under the step that started them. */
  tasks?: Record<string, TaskInfo>;
  /** What the agent is doing right now (the chat's status line), shown under the step in progress. */
  activity: string | null;
  /** Clock for the time on the step in progress (ticks while running). */
  now: number;
  /** Show this item in the chat view. */
  onJump: (itemId: string) => void;
  onApprove: (requestId: string, decision: 'allow' | 'allow_always' | 'deny', message?: string) => void;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
  /** Scroll to this turn's card once (from a checklist in the chat view). */
  focusTurn?: string | null;
}

/** "12s", "3m 4s", "1h 2m 3s". */
function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return t(s >= 3600 ? 'activity.elapsedHours' : s >= 60 ? 'activity.elapsedMinutes' : 'activity.elapsedSeconds', { hours: Math.floor(s / 3600), minutes: Math.floor(s / 60) % 60, seconds: s % 60 });
}

function StatusIcon({ status, live, skipped }: { status: PlanStep['status']; live: boolean; skipped?: boolean }) {
  if (skipped) return <span key="skip" className="w-5 h-5 shrink-0 rounded-full border-2 border-amber-300/50 text-amber-200/90 flex items-center justify-center text-[10px] font-bold">✕</span>;
  // Keyed by status so the check pops in when a step is cleared.
  if (status === 'completed') {
    return <span key="done" className="plan-check w-5 h-5 shrink-0 rounded-full bg-emerald-400/90 text-[#05150e] flex items-center justify-center text-[11px] font-bold">✓</span>;
  }
  if (status === 'in_progress') {
    return <span key="now" className={`w-5 h-5 shrink-0 rounded-full border-2 ${live ? 'border-amber-300 border-t-transparent animate-spin' : 'border-amber-300/60'}`} />;
  }
  return <span key="todo" className="w-5 h-5 shrink-0 rounded-full border-2 border-white/25" />;
}

/** What a step took: commands, files, reads, agents, trouble (red) and time. */
function StepStatsLine({ step, now, running }: { step: PlanStep; now: number; running: boolean }) {
  const s = step.stats;
  const end = running ? Math.max(now, step.endedAt ?? 0) : step.endedAt;
  const ms = step.startedAt && end ? end - step.startedAt : 0;
  const parts: { text: string; bad?: boolean }[] = [];
  if (s.commands) parts.push({ text: t('plan.stat.commands', { n: s.commands }) });
  if (s.failed) parts.push({ text: t('plan.stat.failed', { n: s.failed }), bad: true });
  if (s.denied) parts.push({ text: t('plan.stat.denied', { n: s.denied }), bad: true });
  if (s.errors) parts.push({ text: t('plan.stat.errors', { n: s.errors }), bad: true });
  if (s.files.length) parts.push({ text: t('plan.stat.files', { n: s.files.length }) });
  if (s.reads) parts.push({ text: t('plan.stat.reads', { n: s.reads }) });
  if (s.subagents) parts.push({ text: t('plan.stat.agents', { n: s.subagents }) });
  if (ms >= 1000) parts.push({ text: duration(ms) });
  if (!parts.length) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] leading-4 tabular-nums text-zinc-500">
      {parts.some((p) => p.bad) && <span className="text-red-300/90">⚠</span>}
      {parts.map((p, i) => <span key={i} className={p.bad ? 'text-red-300/90' : undefined}>{i > 0 && <span className="mr-1.5 text-zinc-700">·</span>}{p.text}</span>)}
    </div>
  );
}

/** The chat's status line, under the step in progress. */
function ActivityLine({ text }: { text: string }) {
  return (
    <div className="mt-1.5 flex items-center gap-2 text-[11.5px] leading-4 text-amber-100/70">
      <span className="w-3 h-3 shrink-0 rounded-full border-2 border-amber-300/70 border-t-transparent animate-spin" />
      <span className="truncate">{text}</span>
    </div>
  );
}

/** a, b, …, z, aa, ab, … */
const letter = (i: number): string => (i < 26 ? String.fromCharCode(97 + i) : letter(Math.floor(i / 26) - 1) + letter(i % 26));
/** Accounts shown under a step before "earlier ones" folds the rest away. */
const ENTRIES_SHOWN = 4;

/**
 * Subagents / background tasks still running, under the step that started them: kind, what it was asked, how
 * long it has run. Violet like the composer chip. Ticks on its own, since the turn may have ended already.
 */
function TaskLines({ tasks, onJump }: { tasks: TaskInfo[]; onJump: (id: string) => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const shown = tasks.slice(0, 4);
  return (
    <div className="mt-1.5 space-y-1" data-plan-tasks="">
      {shown.map((task) => (
        <div key={task.id} role={task.toolUseId ? 'link' : undefined} title={`${taskKind(task)} · ${task.description}`}
          onClick={task.toolUseId ? (e) => { e.stopPropagation(); onJump(task.toolUseId!); } : undefined}
          className={`flex items-center gap-2 text-[11.5px] leading-4 text-violet-200/90 min-w-0 ${task.toolUseId ? 'cursor-pointer hover:text-violet-100' : ''}`}>
          <span className="w-3 h-3 shrink-0 rounded-full border-2 border-violet-400/80 border-t-transparent animate-spin" />
          <span className="shrink-0 font-medium">{taskKind(task)}</span>
          <span className="truncate text-violet-200/60">{task.description.split('\n')[0]}</span>
          <span className="shrink-0 ml-auto tabular-nums text-violet-300/60">{duration(now - task.startedAt)}</span>
        </div>
      ))}
      {tasks.length > shown.length && <div className="text-[11px] text-violet-300/60 pl-5">{t('plan.tasksMore', { n: tasks.length - shown.length })}</div>}
    </div>
  );
}

/** A step's accounts: one "a." line, or for a step done again in later rounds, a., b., c. with the round's title. */
function StepEntries({ step, note }: { step: PlanStep; note: string | null }) {
  const [all, setAll] = useState(false);
  if (step.entries.length < 2) {
    if (step.skipped) return <div className="mt-1 flex gap-1.5 text-[12.5px] leading-relaxed text-amber-200/80"><span className="shrink-0">{t('plan.skipped')}</span>{note && <span className="line-clamp-2">{note}</span>}</div>;
    return note ? <div className="mt-1 flex gap-1.5 text-[12.5px] leading-relaxed text-zinc-400"><span className="shrink-0 text-zinc-500">a.</span><span className="line-clamp-2">{note}</span></div> : null;
  }
  const hidden = all ? 0 : Math.max(0, step.entries.length - ENTRIES_SHOWN);
  return (
    <div className="mt-1 space-y-0.5">
      {hidden > 0 && (
        <button type="button" onClick={(e) => { e.stopPropagation(); setAll(true); }} className="text-[11.5px] text-zinc-500 hover:text-zinc-200">{t('plan.entriesEarlier', { n: hidden })}</button>
      )}
      {step.entries.slice(hidden).map((e, i) => (
        <div key={hidden + i} className={`flex gap-1.5 text-[12.5px] leading-relaxed ${e.skipped ? 'text-amber-200/80' : 'text-zinc-400'}`}>
          <span className="shrink-0 tabular-nums text-zinc-500">{letter(hidden + i)}.</span>
          <span className="min-w-0 line-clamp-2">
            {e.title && e.title !== step.content && <span className="text-zinc-300 mr-1.5">{e.title}</span>}
            {e.skipped && <span className="mr-1">{t('plan.skipped')}</span>}{e.note}
          </span>
        </div>
      ))}
    </div>
  );
}

/** One plan step: number and text, its accounts (a., b., …) or why it was skipped, what it took, and live, what is happening now. */
function StepRow({ step, index, current, live, activity, now, tasks, onJump }: { step: PlanStep; index: number; current: boolean; live: boolean; activity: string | null; now: number; tasks?: TaskInfo[]; onJump: (id: string) => void }) {
  useLang();
  const done = step.status === 'completed';
  const title = current && step.activeForm ? step.activeForm : step.content;
  const note = done || current ? noteLine(step.note, 200) : null;
  const target = step.items[0]?.id;
  const working = current && live;
  const jump = () => { if (target) onJump(target); };
  return (
    <div role="button" tabIndex={target ? 0 : -1} aria-disabled={!target} onClick={jump} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(); } }} title={target ? t('plan.jumpChat') : undefined}
      className={`group w-full flex items-start gap-3 rounded-xl px-2.5 py-2 text-left transition-colors duration-200 outline-none ${current && live ? 'bg-amber-300/[0.07]' : target ? 'cursor-pointer hover:bg-fill focus-visible:bg-fill' : ''}`}>
      <StatusIcon status={current ? 'in_progress' : step.status} live={live} skipped={step.skipped} />
      <div className="flex-1 min-w-0">
        <div className={`text-[13.5px] leading-5 transition-colors duration-300 ${done ? 'text-zinc-300' : current ? 'text-white font-medium' : 'text-zinc-400'}`}>
          <span className="tabular-nums text-zinc-500 mr-1.5">{index + 1}.</span>{title}
          {step.entries.length > 1 && <span className="ml-2 rounded-full bg-fill-2 px-1.5 py-px text-[10.5px] tabular-nums text-zinc-400">×{step.entries.length}</span>}
        </div>
        <StepEntries step={step} note={note} />
        {(done || current) && <StepStatsLine step={step} now={now} running={working} />}
        {working && activity && <ActivityLine text={activity} />}
        {!!tasks?.length && <TaskLines tasks={tasks} onJump={onJump} />}
      </div>
      {target && <span className="shrink-0 mt-0.5 text-[11px] text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity">{t('plan.jumpChat')} →</span>}
    </div>
  );
}

/** Rows of the progress log shown before "show all". */
const LOG_SHOWN = 12;

/**
 * Under the result, when steps were done again round after round: every round's account in order, headed by
 * what it reported ("#12 thaw_warning (해빙 예고)"), so the outcome lists the work and not just its last line.
 */
function ProgressLog({ turn, onJump }: { turn: PlanTurn; onJump: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const rows = turn.steps.flatMap((s) => s.entries.map((e) => ({ ...e, order: turn.textIds.indexOf(e.itemId ?? '') })))
    .sort((a, b) => a.order - b.order);
  // Only a repeated step makes a log worth showing; a plan done once is already read off the steps.
  if (!turn.steps.some((s) => s.entries.length > 1)) return null;
  const shown = all ? rows : rows.slice(0, LOG_SHOWN);
  return (
    <div className="mt-3 border-t border-line pt-2.5">
      <div className="mb-1 flex items-baseline gap-2 text-[11.5px] font-medium text-zinc-400">{t('plan.log')}<span className="tabular-nums text-zinc-500">{rows.length}</span></div>
      <ol className="space-y-0.5">
        {shown.map((r, i) => (
          <li key={i}>
            <button type="button" disabled={!r.itemId} onClick={() => r.itemId && onJump(r.itemId)} title={r.note}
              className="w-full flex gap-2 rounded-md px-1 py-0.5 text-left text-[12.5px] leading-relaxed hover:bg-fill transition-colors">
              <span className="shrink-0 w-7 text-right tabular-nums text-zinc-500">{i + 1}.</span>
              <span className={`min-w-0 truncate ${r.skipped ? 'text-amber-200/80' : 'text-zinc-200'}`}>{r.detail ?? (r.title ? `${r.title} · ${r.note}` : r.note)}</span>
            </button>
          </li>
        ))}
      </ol>
      {!all && rows.length > LOG_SHOWN && <button type="button" onClick={() => setAll(true)} className="mt-1 px-1 text-[11.5px] text-zinc-500 hover:text-zinc-200">{t('plan.logAll', { n: rows.length })}</button>}
    </div>
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
/** Slack around a turn's time span when telling whether a named file was made during it. */
const TURN_SLACK_MS = 10_000;
/** The same file under two names: macOS /tmp and /var are links into /private (older servers send no real path). */
const fileKey = (p: string) => p.replace(/^\/private(?=\/(?:tmp|var)\/)/, '');
const uniqueFiles = (paths: string[]) => [...new Map(paths.map((p) => [fileKey(p), p])).values()];

/**
 * The files the turn created: those its tools show (new in the turn's changes, Write onto a new path), and once
 * the turn has ended, the files it only named (agents often write into their own temp folder and link it) that
 * exist and were created while it ran. One entry per file, however it was named.
 */
function useCreatedFiles(turn: PlanTurn, cwd: string): string[] {
  const [checked, setChecked] = useState<string[] | null>(null);
  const result = turn.result;
  const key = [...turn.created, '', ...turn.mentioned].join('\n');
  useEffect(() => {
    setChecked(null);
    if (!result?.at || !(turn.created.length + turn.mentioned.length)) return;
    const from = Math.min(turn.startedAt ?? Infinity, result.at - result.durationMs) - TURN_SLACK_MS;
    const to = result.at + TURN_SLACK_MS;
    const named = turn.mentioned.map((p) => resolveLocal(p, cwd)).filter((p): p is string => !!p);
    let live = true;
    const stat = (p: string) => api.stat(p).catch(() => null);
    void Promise.all([...turn.created.map(stat), ...named.map(stat)]).then((entries) => {
      if (!live) return;
      const kept = new Map<string, string>();
      entries.forEach((e, i) => {
        if (!e || e.isDir) return;
        const made = e.birthtime ?? e.mtime;
        if (i >= turn.created.length && (made < from || made > to)) return;
        const k = fileKey(e.real ?? e.path);
        if (!kept.has(k)) kept.set(k, i < turn.created.length ? turn.created[i] : e.path);
      });
      setChecked([...kept.values()]);
    });
    return () => { live = false; };
    // turn.created / turn.mentioned are covered by the joined key; the rest only changes with the result.
  }, [result?.id, key, cwd]); // eslint-disable-line react-hooks/exhaustive-deps
  return checked ?? uniqueFiles(turn.created);
}

function TurnCard({ turn, live, tasks, cwd, activity, now, onJump, onApprove, onAnswer }: { turn: PlanTurn; live: boolean; tasks?: TurnTasks } & Pick<Props, 'cwd' | 'activity' | 'now' | 'onJump' | 'onApprove' | 'onAnswer'>) {
  useLang();
  const created = useCreatedFiles(turn, cwd);
  const done = turn.steps.filter((s) => s.status === 'completed').length;
  const total = turn.steps.length;
  // Subagents still running after the turn ended: the request is not over yet, so no "done" until they finish.
  const agents = tasks?.all.length ?? 0;
  const ended = turn.result ? (turn.result.ok ? 'done' : 'failed') : live ? (turn.pending.length ? 'waiting' : 'running') : total && done < total ? 'stopped' : null;
  // Every step checked but the turn still going: the agent is writing its result (or wrapping up before it).
  const wrapping = live && total > 0 && done === total;
  const writing = wrapping && turn.hasResult && !!turn.answer;
  const state = agents && (ended === 'done' || ended === 'stopped' || !ended) ? null : ended === 'running' && wrapping ? 'writing' : ended;
  // The step being worked on: the one marked in progress, else (a plan written as text) the first not yet done.
  const marked = turn.steps.findIndex((s) => s.status === 'in_progress');
  const current = live ? (marked >= 0 ? marked : turn.steps.findIndex((s) => s.status !== 'completed')) : -1;
  const lines = (turn.user?.text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const files = new Set(turn.changes.flatMap((c) => c.files.map((f) => f.path)));
  const verify = turn.verify[turn.verify.length - 1];
  // The result only once the turn has ended: until then the latest message is progress, not the outcome.
  // ...except the "Result:" section itself, which streams in as it is written.
  const showAnswer = turn.answer && (!live || writing);
  const latest = live && !total ? noteLine(turn.texts[turn.texts.length - 1] ?? null, 200) : null;
  return (
    <section data-plan-turn={turn.id} className="rounded-[20px] border border-line bg-black/10 p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[14.5px] leading-6 font-semibold text-zinc-100 line-clamp-2">{lines[0]}</div>
          {lines.length > 1 && <div className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-400 line-clamp-2">{lines.slice(1).join(' · ')}</div>}
          {turn.additions.map((a, i) => (
            <div key={i} className="mt-1 flex gap-1.5 text-[12.5px] leading-relaxed text-zinc-300"><span className="shrink-0 text-amber-200/80">{t('plan.addition')}</span><span className="line-clamp-2">{a.replace(/\s+/g, ' ').trim()}</span></div>
          ))}
        </div>
        {agents > 0 && (
          <span className="shrink-0 mt-0.5 flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] leading-4 bg-violet-500/15 text-violet-200" data-plan-agents="">
            <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
            {t('plan.state.agents', { n: agents })}
          </span>
        )}
        {state && (
          <span className={`shrink-0 mt-0.5 rounded-full px-2.5 py-0.5 text-[11px] leading-4 ${state === 'done' ? 'bg-emerald-400/15 text-emerald-200' : state === 'failed' ? 'bg-red-500/15 text-red-200' : state === 'running' || state === 'writing' ? 'bg-amber-300/15 text-amber-200' : state === 'waiting' ? 'bg-sky-400/15 text-sky-200 animate-pulse' : 'bg-fill-2 text-zinc-300'}`}>
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
          <div className="-mx-1.5">{turn.steps.map((s, i) => <StepRow key={s.key} step={s} index={i} current={i === current} live={live} activity={activity} now={now} tasks={tasks?.byStep.get(i)} onJump={onJump} />)}</div>
          {wrapping && !writing && (
            <div className="flex items-start gap-3 px-1 py-1 text-[13px] text-zinc-300" data-plan-wrapping="">
              <span className="w-5 h-5 shrink-0 rounded-full border-2 border-amber-300 border-t-transparent animate-spin" />
              <div className="min-w-0 flex-1 leading-5">
                {t('plan.writingResult')}
                {activity && <ActivityLine text={activity} />}
              </div>
            </div>
          )}
        </div>
      ) : live ? (
        <div className="flex items-start gap-3 px-1 py-1 text-[13px] text-zinc-400">
          <span className="w-5 h-5 shrink-0 rounded-full border-2 border-amber-300 border-t-transparent animate-spin" />
          <div className="min-w-0 flex-1 leading-5">
            {t('plan.planning')}
            {latest && <div className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-500 line-clamp-2">{latest}</div>}
            {activity && <ActivityLine text={activity} />}
          </div>
        </div>
      ) : null}
      {!!tasks?.unplaced.length && <div className="px-1"><TaskLines tasks={tasks.unplaced} onJump={onJump} /></div>}
      {showAnswer && (
        <div className="rounded-xl bg-black/15 border border-line px-3.5 py-2.5">
          {writing
            ? <div className="flex items-center gap-2 text-[11.5px] font-medium text-amber-200/90 mb-1"><span className="w-3 h-3 shrink-0 rounded-full border-2 border-amber-300/80 border-t-transparent animate-spin" />{t('plan.writingResult')}</div>
            : <div className="text-[11.5px] font-medium text-zinc-400 mb-1">{t('plan.result')}</div>}
          {turn.answerFull
            ? <div className="prose-md text-[13.5px] max-w-none"><MarkdownView text={turn.answer!} /></div>
            : <div className="text-[13px] leading-relaxed text-zinc-100">{turn.answer}</div>}
          <ProgressLog turn={turn} onJump={onJump} />
        </div>
      )}
      {created.length > 0 && <CreatedFiles paths={created} />}
      {turn.pending.map((p) => p.kind === 'approval'
        ? <ApprovalItem key={p.id} item={p as Item<'approval'>} onDecide={(d, m) => onApprove(p.id, d, m)} />
        : <QuestionItem key={p.id} item={p as Item<'question'>} onAnswer={(a) => onAnswer(p.id, a)} />)}
      {(files.size > 0 || verify || turn.result || turn.commits.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-zinc-400">
          {files.size > 0 && <button className="rounded-full bg-fill px-2.5 py-1 hover:bg-fill-2 hover:text-white transition-colors" onClick={() => onJump(turn.changes[0].id)}>{t('plan.changes', { n: files.size })}</button>}
          {turn.commits.map((h) => <button key={h} className="rounded-full bg-violet-500/15 px-2.5 py-1 text-violet-100 hover:bg-violet-500/25 transition-colors" title={t('plan.copyHash')} onClick={() => void navigator.clipboard.writeText(h)}>{t('plan.commit')} <span className="font-mono">{h}</span></button>)}
          {turn.pushed && <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-emerald-200">{t('plan.pushed')}</span>}
          {verify && <span className={`rounded-full px-2.5 py-1 ${verify.status === 'passed' ? 'bg-emerald-400/10 text-emerald-200' : verify.status === 'failed' ? 'bg-red-500/15 text-red-200' : 'bg-fill'}`}>{t(`verify.${verify.status}`)}</span>}
          {turn.result && <span className="ml-auto tabular-nums">{Math.round(turn.result.durationMs / 1000)}s{turn.result.turnCostUsd ? ` · $${turn.result.turnCostUsd.toFixed(3)}` : ''}</span>}
        </div>
      )}
    </section>
  );
}

/** The session at a glance: requests, how they ended, cost and files made. */
function SessionSummary({ turns }: { turns: PlanTurn[] }) {
  const asked = turns.filter((x) => x.user);
  if (asked.length < 2) return null;
  const done = asked.filter((x) => x.result?.ok).length;
  const failed = asked.filter((x) => x.result && !x.result.ok).length;
  const cost = asked.reduce((sum, x) => sum + (x.result?.turnCostUsd ?? 0), 0);
  const created = new Set(asked.flatMap((x) => x.created)).size;
  const commits = asked.reduce((n, x) => n + x.commits.length, 0);
  const parts = [t('plan.sum.requests', { n: asked.length }), t('plan.sum.done', { n: done })];
  if (failed) parts.push(t('plan.sum.failed', { n: failed }));
  if (commits) parts.push(t('plan.sum.commits', { n: commits }));
  if (created) parts.push(t('plan.sum.created', { n: created }));
  if (cost) parts.push(`$${cost.toFixed(2)}`);
  return <div className="px-1 text-[11.5px] tabular-nums text-zinc-500">{parts.join(' · ')}</div>;
}

/** The session as a checklist per turn: each plan step with what was done for it. */
function PlanView({ items, cwd, running, tasks, activity, now, onJump, onApprove, onAnswer, focusTurn }: Props) {
  useLang();
  const turns = useMemo(() => buildPlan(items), [items]);
  const turnTasks = useMemo(() => liveTasksByTurn(turns, tasks), [turns, tasks]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // While showing a turn picked from the chat, don't snap back to the bottom.
  const holdFocus = useRef(!!focusTurn);
  const [atBottom, setAtBottom] = useState(true);
  const scrollToBottom = () => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; };
  const jump = () => { stick.current = true; holdFocus.current = false; setAtBottom(true); scrollToBottom(); };
  // Follow new work while scrolled to the bottom, like the chat.
  useEffect(() => {
    const el = content.current; if (!el) return;
    const ro = new ResizeObserver(() => { if (stick.current && !holdFocus.current) scrollToBottom(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!focusTurn) { holdFocus.current = false; scrollToBottom(); return; }
    holdFocus.current = true;
    stick.current = false; setAtBottom(false);
    scroller.current?.querySelector(`[data-plan-turn="${CSS.escape(focusTurn)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focusTurn]);
  // A new request goes to the bottom even if the user had scrolled up.
  const asked = turns.filter((x) => x.user).length;
  const lastAsked = useRef(asked);
  useEffect(() => {
    if (asked > lastAsked.current) jump();
    lastAsked.current = asked;
  }, [asked]); // eslint-disable-line react-hooks/exhaustive-deps
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const b = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stick.current = b; setAtBottom(b);
    if (b) holdFocus.current = false;
  };
  return (
    <>
      <div ref={scroller} className="absolute inset-0 overflow-y-auto" onScroll={onScroll}>
        <div ref={content} className="px-5 py-4 space-y-4 max-w-4xl mx-auto">
          {turns.length === 0 && <div className="text-center text-zinc-500 text-sm py-10">{t('plan.empty')}</div>}
          <SessionSummary turns={turns} />
          {turns.map((turn, i) => turn.user && <TurnCard key={turn.id} turn={turn} cwd={cwd} live={running && i === turns.length - 1} tasks={turnTasks.get(turn.id)} activity={activity} now={now} onJump={onJump} onApprove={onApprove} onAnswer={onAnswer} />)}
        </div>
      </div>
      {!atBottom && (
        <button onClick={jump} className="absolute z-10 bottom-3 left-1/2 -translate-x-1/2 glass-pop pop-in !rounded-full px-3.5 py-1.5 text-xs text-zinc-200 hover:text-white">{t('chat.jumpLatest')}</button>
      )}
    </>
  );
}

export default memo(PlanView);
