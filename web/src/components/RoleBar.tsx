import type { ReactNode } from 'react';
import { t, useLang } from '../lib/i18n';
import type { ChatItem } from '../lib/chatStore';
import type { PlanRevision, PlanStep, RoleChip } from '../lib/planView';
import type { Role } from '../lib/planSet';
import type { RoleState } from '../lib/roles';

const CHIP_TONE: Record<RoleState, string> = {
  unused: 'border-line bg-transparent text-zinc-600',
  planned: 'border-line bg-fill text-zinc-300',
  running: 'border-amber-300/50 bg-amber-300/10 text-amber-100',
  user: 'border-sky-400/60 bg-sky-400/15 text-sky-100 animate-pulse',
  done: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100',
  failed: 'border-red-400/40 bg-red-500/10 text-red-100',
  stopped: 'border-line bg-fill-2 text-zinc-400',
};

/**
 * One rectangle per role, always all five, filling the width with equal gaps. A role the turn does not use is
 * shown disabled. Clicking a chip highlights that role's steps and scrolls to the first; clicking again clears it.
 */
export function RoleBar({ chips, focus, onFocus, sticky }: { chips: RoleChip[]; focus: Role | null; onFocus: (r: Role | null) => void; sticky: boolean }) {
  useLang();
  return (
    <div data-plan-roles="" className={`grid grid-cols-5 gap-2 ${sticky ? 'sticky top-0 z-10 -mx-1 px-1 py-1 bg-black/40 backdrop-blur-md rounded-lg' : ''}`}>
      {chips.map((c) => {
        const off = c.state === 'unused';
        const on = focus === c.role;
        return (
          <button key={c.role} type="button" disabled={off} data-role={c.role} data-role-state={c.state}
            title={off ? undefined : t('role.focus', { role: t(`role.${c.role}`) })}
            onClick={() => onFocus(on ? null : c.role)}
            className={`min-w-0 rounded-md border px-2 py-1.5 text-left transition-colors ${CHIP_TONE[c.state]} ${off ? 'cursor-default opacity-60' : 'hover:brightness-125'} ${on ? 'ring-1 ring-white/40' : ''}`}>
            <div className="flex items-center gap-1 text-[12px] leading-4 font-medium min-w-0">
              <span className="shrink-0 tabular-nums opacity-70">{c.role}</span>
              <span className="truncate">{t(`role.${c.role}`)}</span>
              {c.rounds > 1 && <span className="ml-auto shrink-0 text-[10.5px] tabular-nums opacity-80">×{c.rounds}</span>}
            </div>
            <div className="mt-0.5 text-[10.5px] leading-[14px] truncate opacity-80">
              {t(`role.state.${c.state}`)}{c.total > 0 && !off ? ` · ${t('role.steps', { done: c.done, total: c.total })}` : ''}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** The role tag in front of a step title; dashed when the role was read off the work rather than declared. */
export function RoleTag({ step }: { step: PlanStep }) {
  useLang();
  if (!step.role) return null;
  return (
    <span title={step.roleGuessed ? t('role.guessed') : t(`role.${step.role}`)} data-role-tag={step.role}
      className={`mr-1.5 inline-block rounded-[4px] px-1 text-[10.5px] leading-4 tabular-nums align-[1px] text-zinc-300 ${step.roleGuessed ? 'border border-dashed border-zinc-500' : 'bg-fill-2'}`}>{step.role}</span>
  );
}

function RevisionLine({ rev }: { rev: PlanRevision }) {
  const groups = (['added', 'removed', 'renamed', 'role'] as const).map((k) => [k, rev.changes.filter((c) => c.kind === k)] as const).filter(([, l]) => l.length);
  return (
    <div className="flex items-start gap-1.5 text-[11.5px] leading-4 text-sky-200/85" data-plan-revision={rev.n}>
      <span className="shrink-0">↻</span>
      <span className="min-w-0">
        <span className="font-medium">{t('plan.revision', { n: rev.n })}</span>
        {rev.guessed && <span className="ml-1 opacity-60">({t('plan.revisionGuessed')})</span>}
        {rev.reason && <span className="ml-1.5 text-sky-200/60">{rev.reason}</span>}
        {groups.map(([k, l]) => (
          <span key={k} className="ml-1.5 text-zinc-400">
            {t(`plan.change.${k}`)} {l.map((c) => c.kind === 'renamed' ? c.to : c.kind === 'role' ? `${c.title} ${c.from ?? '-'}→${c.to ?? '-'}` : c.title).join(', ')}
          </span>
        ))}
      </span>
    </div>
  );
}

/** What happened inside a step besides its work, in order: messages the user added meanwhile, and plan changes. */
export function StepFlow({ step, revisions }: { step: PlanStep; revisions: PlanRevision[] }) {
  useLang();
  const lines: { key: string; node: ReactNode }[] = [];
  for (const it of step.items as ChatItem[]) {
    if (it.kind === 'user') {
      lines.push({ key: it.id, node: <div className="flex gap-1.5 text-[11.5px] leading-4 text-zinc-300"><span className="shrink-0 text-amber-200/80">{t('plan.addition')}</span><span className="line-clamp-2">{it.text.replace(/\s+/g, ' ').trim()}</span></div> });
    } else if (it.kind === 'tool') {
      const rev = revisions.find((r) => r.itemId === it.id);
      if (rev) lines.push({ key: it.id, node: <RevisionLine rev={rev} /> });
    }
  }
  if (!lines.length) return null;
  return <div className="mt-1.5 space-y-1" data-plan-flow="">{lines.map((l) => <div key={l.key}>{l.node}</div>)}</div>;
}

/** Changes to a plan written only as text (no plan_set call to sit under), and steps taken out of the plan. */
export function TurnRevisions({ revisions, removed }: { revisions: PlanRevision[]; removed: PlanStep[] }) {
  useLang();
  const loose = revisions.filter((r) => r.guessed);
  if (!loose.length && !removed.length) return null;
  return (
    <div className="px-2.5 space-y-1">
      {loose.map((r) => <RevisionLine key={`${r.itemId}-${r.n}`} rev={r} />)}
      {removed.map((s) => (
        <div key={s.key} className="flex items-start gap-2 text-[12.5px] leading-5 text-zinc-500" data-plan-removed="">
          <RoleTag step={s} />
          <span className={s.removed?.dropped ? '' : 'line-through'}>{s.content}</span>
          <span className="shrink-0 text-[11px]">{s.removed?.dropped ? t('plan.droppedDone') : t('plan.removedStep')}{s.removed?.reason ? ` · ${s.removed.reason}` : ''}</span>
        </div>
      ))}
    </div>
  );
}
