import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskInfo, TaskStatus } from '../lib/agent';
import { liveTasks } from '../lib/chatStore';
import { layoutTaskTree, NODE_H, NODE_W, ROOT_ID, shortTokens, taskKind, visibleTasks, type GraphLayout } from '../lib/taskGraph';
import { t, useLang } from '../lib/i18n';
import { useEvent } from '../lib/useEvent';

interface Props {
  tasks: Record<string, TaskInfo> | undefined;
  /** What the root node is called: the session title, else the agent name. */
  rootLabel: string;
  rootSub?: string;
  /** Scroll the transcript to the tool card that started a task. */
  onShowCard?: (toolUseId: string) => void;
  /** Kill one running task; the CLI reports it back as 'stopped'. Absent for agents that cannot. */
  onStopTask?: (taskId: string) => void;
}

const STATUS_BORDER: Record<TaskStatus, string> = {
  running: 'border-violet-400/60',
  completed: 'border-emerald-400/50',
  failed: 'border-red-400/60',
  stopped: 'border-zinc-500/50',
};
const STATUS_TEXT: Record<TaskStatus, string> = {
  running: 'text-violet-200',
  completed: 'text-emerald-200',
  failed: 'text-red-200',
  stopped: 'text-zinc-400',
};

function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('activity.elapsedSeconds', { seconds: s });
  if (s < 3600) return t('activity.elapsedMinutes', { minutes: Math.floor(s / 60), seconds: s % 60 });
  return t('activity.elapsedHours', { hours: Math.floor(s / 3600), minutes: Math.floor(s / 60) % 60, seconds: s % 60 });
}

/**
 * One purple "subagents running" chip in the composer's toolbar while any subagent / background
 * task of this session is working. Clicking it opens the relation graph: this session at the top,
 * every task it spawned below (nested when a subagent spawned its own); a node shows its details.
 */
export default function TaskChips({ tasks, rootLabel, rootSub, onShowCard, onStopTask }: Props) {
  useLang();
  const live = useMemo(() => liveTasks({ tasks }), [tasks]);
  const [open, setOpen] = useState<string | null>(null); // selected node id while the graph is open
  if (!live.length) return null;
  return (
    // Not positioned on purpose: the popover's containing block is the composer box, so it pops
    // out above the whole composer instead of being clipped to the chip.
    <div className="flex items-center min-w-0 shrink" data-task-chips="">
      <button type="button" onClick={() => setOpen((cur) => (cur ? null : ROOT_ID))} data-task-chip=""
        title={t('tasks.chipTitle', { n: live.length })}
        className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] min-w-0 shrink hover:bg-violet-500/25 ${open ? 'bg-violet-500/30 text-violet-100' : 'bg-violet-500/15 text-violet-200'}`}>
        <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-violet-400 animate-pulse" />
        <span className="truncate">{t('tasks.chip')}</span>
        <span className="shrink-0 text-violet-300/80 tabular-nums">{live.length}</span>
      </button>
      {open && <TaskGraphPopover tasks={tasks ?? {}} selected={open} onSelect={setOpen} onClose={() => setOpen(null)} rootLabel={rootLabel} rootSub={rootSub} onShowCard={onShowCard} onStopTask={onStopTask} />}
    </div>
  );
}

function TaskGraphPopover({ tasks, selected, onSelect, onClose, rootLabel, rootSub, onShowCard, onStopTask }: { tasks: Record<string, TaskInfo>; selected: string; onSelect: (id: string) => void; onClose: () => void; rootLabel: string; rootSub?: string; onShowCard?: (id: string) => void; onStopTask?: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const all = useMemo(() => Object.values(tasks).filter((x) => !x.ambient), [tasks]);
  // Completed tasks leave the graph (a parent stays while a child is still shown); failed / stopped stay.
  const list = useMemo(() => visibleTasks(all), [all]);
  // Progress events (token counts, last tool) arrive many times a second while subagents work; the
  // boxes only change with the tree's shape, a status or a label, so the layout is keyed on those.
  const shape = list.map((x) => `${x.id}\u0001${x.parentId ?? ''}\u0001${x.status}\u0001${x.startedAt}\u0001${x.description.split('\n')[0]}`).join('\u0002');
  const layout = useMemo(() => layoutTaskTree(list), [shape]); // eslint-disable-line react-hooks/exhaustive-deps
  const runningList = all.filter((x) => x.status === 'running');
  const running = runningList.length;
  const hidden = all.length - list.length;
  // Ids we asked to stop; shown as "stopping" until the CLI reports them stopped.
  const [stopping, setStopping] = useState<Set<string>>(() => new Set());
  const stopOne = (task: TaskInfo) => {
    if (!onStopTask || !window.confirm(t('tasks.stopConfirm', { desc: task.description.split('\n')[0].slice(0, 80) || taskKind(task) }))) return;
    setStopping((s) => new Set(s).add(task.id));
    onStopTask(task.id);
  };
  const stopAll = () => {
    if (!onStopTask || !running || !window.confirm(t('tasks.stopAllConfirm', { n: running }))) return;
    setStopping((s) => { const n = new Set(s); for (const x of runningList) n.add(x.id); return n; });
    for (const x of runningList) onStopTask(x.id);
  };
  // Close on a click outside or Escape. Registered once: `onClose` is a new closure on every parent render.
  const close = useEvent(onClose);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-task-chips]')) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [close]);

  const sel = selected === ROOT_ID ? null : tasks[selected] ?? null;

  return (
    <div ref={box} role="dialog" aria-label={t('tasks.title')}
      className="absolute bottom-full left-0 mb-1 w-[640px] max-w-full glass-pop pop-in rounded-xl !border-violet-400/25 z-20 text-[12px]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
        <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
        <span className="font-medium text-zinc-200">{t('tasks.title')}</span>
        <span className="text-zinc-500">{t('tasks.summaryLive', { running, total: all.length })}{hidden > 0 && ` · ${t('tasks.hiddenDone', { n: hidden })}`}</span>
        <div className="flex-1" />
        {onStopTask && running > 1 && (
          <button className="rounded-md px-2 py-0.5 text-[11px] bg-red-500/15 text-red-200 hover:bg-red-500/25 disabled:opacity-40" disabled={runningList.every((x) => stopping.has(x.id))} onClick={stopAll}>{t('tasks.stopAll', { n: running })}</button>
        )}
        <button className="text-zinc-500 hover:text-zinc-200 px-1" onClick={onClose} aria-label={t('tasks.close')}>✕</button>
      </div>
      {/* Own compositing layer and paint containment: scrolling moves a finished bitmap instead of
          repainting every box under the popover's backdrop blur. */}
      <div className="overflow-auto overscroll-contain max-h-[40vh] p-2 [contain:paint] [will-change:scroll-position]">
        <GraphCanvas layout={layout} selected={selected} onSelect={onSelect} rootLabel={rootLabel} rootSub={rootSub} />
      </div>
      {sel && <TaskDetail sel={sel} tasks={tasks} rootLabel={rootLabel} stopping={stopping.has(sel.id)} onStop={onStopTask ? () => stopOne(sel) : undefined}
        onShowCard={onShowCard && sel.toolUseId ? () => { onShowCard(sel.toolUseId!); onClose(); } : undefined} />}
    </div>
  );
}

/**
 * The boxes and connector lines. Memoized on the layout, so neither the popover's clock nor progress
 * events re-render the (possibly dozens of) nodes; only a new shape, status or selection does.
 */
const GraphCanvas = memo(function GraphCanvas({ layout, selected, onSelect, rootLabel, rootSub }: { layout: GraphLayout; selected: string; onSelect: (id: string) => void; rootLabel: string; rootSub?: string }) {
  const PAD = 12;
  const w = layout.width + PAD * 2;
  const h = layout.height + PAD * 2;
  const byId = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  return (
    // Node boxes are plain HTML (real CSS ellipsis for long/Korean labels, reliable in capturePage);
    // the SVG underneath draws only the connector lines.
    <div className="relative transform-gpu" style={{ width: w, height: h }}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="absolute inset-0 pointer-events-none select-none">
        <g transform={`translate(${PAD} ${PAD})`}>
          {layout.edges.map((e) => {
            const a = byId.get(e.from); const b = byId.get(e.to);
            if (!a || !b) return null;
            // Parent's right edge to child's left edge, bending halfway across the gap.
            const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            const hot = b.task?.status === 'running';
            return <path key={`${e.from}-${e.to}`} d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`} fill="none" strokeWidth={hot ? 1.5 : 1} className={hot ? 'stroke-violet-400/70' : 'stroke-zinc-600'} />;
          })}
        </g>
      </svg>
      {layout.nodes.map((n) => {
        const task = n.task;
        const isSel = n.id === selected;
        const border = task ? STATUS_BORDER[task.status] : 'border-blue-400/70';
        const bg = task ? (task.status === 'running' ? 'bg-violet-500/15' : 'bg-white/[0.03]') : 'bg-blue-500/15';
        const dot = !task ? 'bg-blue-400' : task.status === 'running' ? 'bg-violet-400 animate-pulse' : task.status === 'completed' ? 'bg-emerald-400' : task.status === 'failed' ? 'bg-red-400' : 'bg-zinc-500';
        const title = task ? taskKind(task) : rootLabel;
        const sub = task ? (task.description.split('\n')[0] || t(`tasks.${task.status}`)) : (rootSub ?? t('tasks.session'));
        return (
          <button key={n.id} type="button" onClick={() => onSelect(n.id)}
            title={task ? `${taskKind(task)} · ${task.description}\n${t(`tasks.${task.status}`)}` : `${rootLabel}${rootSub ? ` · ${rootSub}` : ''}`}
            className={`absolute flex flex-col justify-center text-left px-2.5 rounded-lg border ${bg} ${border} ${isSel ? 'ring-2 ring-violet-400/60 border-violet-400' : ''}`}
            style={{ left: n.x + PAD, top: n.y + PAD, width: NODE_W, height: NODE_H }}>
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
              <span className="truncate text-[12px] font-medium text-zinc-100">{title}</span>
            </div>
            <div className="truncate text-[10.5px] text-zinc-400 mt-0.5 w-full">{sub}</div>
          </button>
        );
      })}
    </div>
  );
});

/** The selected task's details; the only part that ticks once a second (its elapsed time). */
function TaskDetail({ sel, tasks, rootLabel, stopping, onStop, onShowCard }: { sel: TaskInfo; tasks: Record<string, TaskInfo>; rootLabel: string; stopping: boolean; onStop?: () => void; onShowCard?: () => void }) {
  const [now, setNow] = useState(Date.now());
  const live = sel.status === 'running';
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const elapsed = elapsedLabel(live ? now - sel.startedAt : (sel.endedAt ?? sel.startedAt) - sel.startedAt);
  return (
    <div className="border-t border-white/10 px-3 py-2 space-y-1">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`text-[10px] rounded px-1.5 py-0.5 bg-white/5 ${STATUS_TEXT[sel.status]}`}>{t(`tasks.${sel.status}`)}</span>
        <span className="font-medium text-zinc-200 shrink-0">{taskKind(sel)}</span>
        {sel.background && <span className="text-[10px] text-zinc-500">{t('tasks.background')}</span>}
        <span className="text-zinc-500 tabular-nums ml-auto shrink-0">{elapsed}</span>
        {onStop && live && (
          <button className="shrink-0 rounded-md px-2 py-0.5 text-[11px] bg-red-500/15 text-red-200 hover:bg-red-500/25 disabled:opacity-40 disabled:cursor-default" disabled={stopping} onClick={onStop}>
            {stopping ? t('tasks.stopping') : `■ ${t('tasks.stop')}`}
          </button>
        )}
      </div>
      <div className="text-zinc-300 whitespace-pre-wrap break-words max-h-20 overflow-auto">{sel.description}</div>
      {sel.summary && <div className="text-zinc-400 italic whitespace-pre-wrap break-words max-h-16 overflow-auto">{sel.summary}</div>}
      {sel.error && <div className="text-red-300 whitespace-pre-wrap break-words max-h-16 overflow-auto">{sel.error}</div>}
      <div className="flex items-center gap-3 text-[11px] text-zinc-500 flex-wrap">
        {sel.parentId && tasks[sel.parentId] && <span>{t('tasks.parent', { name: taskKind(tasks[sel.parentId]) })}</span>}
        {!sel.parentId && <span>{t('tasks.parent', { name: rootLabel })}</span>}
        {sel.usage && <span>{t('tasks.tokens', { n: shortTokens(sel.usage.totalTokens) })}</span>}
        {sel.usage && <span>{t('tasks.toolUses', { n: sel.usage.toolUses })}</span>}
        {sel.lastTool && live && <span>{t('tasks.lastTool', { tool: sel.lastTool })}</span>}
        <span className="font-mono text-zinc-600 truncate">{sel.id}</span>
        {onShowCard && <button className="text-violet-300 hover:text-violet-100 ml-auto" onClick={onShowCard}>{t('tasks.showCard')}</button>}
      </div>
    </div>
  );
}
