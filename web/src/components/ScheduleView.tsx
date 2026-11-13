import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, type AgentContext, type RecentSession, type Schedule, type ScheduleInput, type ScheduleRun, type ScheduleRunStatus, type ScheduleSnapshot, type SchedulePower } from '../lib/api';
import { CRON_PRESETS, describeCron as describe, nextRuns, parseCron } from '../lib/toolbox/cron';
import { relativeTime } from '../lib/toolbox/time';
import { getLang, t, useLang } from '../lib/i18n';
import { pollWhileActive } from '../lib/poll';
import { setScheduleCount } from '../lib/scheduleCount';
import { ViewActiveContext } from '../lib/viewActive';
import AgentIcon from './AgentIcon';
import Icon from './Icon';
import Splitter, { SideSplitter, usePaneWidth } from './Splitter';

const STATUS_DOT: Record<ScheduleRunStatus, string> = {
  running: 'bg-amber-400 animate-pulse', waiting: 'bg-sky-400 animate-pulse', done: 'bg-emerald-400', failed: 'bg-red-400', missed: 'bg-zinc-500', skipped: 'bg-zinc-600',
};
const MODES = [
  { id: 'default', key: 'chat.mode.default' }, { id: 'acceptEdits', key: 'chat.mode.acceptEdits' },
  { id: 'bypassPermissions', key: 'chat.mode.bypass' }, { id: 'auto', key: 'chat.mode.auto' },
];
const GRACE = [0, 30, 60, 180, 720, 1440];
const POWER: SchedulePower[] = ['none', 'awake', 'wake'];
const input = 'w-full bg-black/20 rounded-md px-2.5 py-1.5 outline-none border border-white/5 focus:border-white/20';

type Draft = Required<Pick<ScheduleInput, 'name' | 'cwd' | 'agent' | 'skill' | 'prompt' | 'cron' | 'permissionMode' | 'enabled' | 'graceMinutes' | 'power'>> & Pick<ScheduleInput, 'resumeSessionId' | 'resumeTitle'>;

const blank = (cwd: string): Draft => ({ name: '', cwd, agent: 'claude', skill: '', prompt: '', cron: '0 9 * * 1-5', permissionMode: 'acceptEdits', enabled: true, graceMinutes: 720, power: 'awake' });
const fromSchedule = (s: Schedule): Draft => ({ name: s.name, cwd: s.cwd, agent: s.agent, skill: s.skill, prompt: s.prompt, cron: s.cron, permissionMode: s.permissionMode, enabled: s.enabled, graceMinutes: s.graceMinutes, power: s.power, resumeSessionId: s.resumeSessionId, resumeTitle: s.resumeTitle });

function describeCron(expr: string): string {
  try { return describe(parseCron(expr), getLang() === 'ko' ? 'ko' : 'en'); } catch { return ''; }
}
// Dates outside this year carry the year: a yearly schedule's next runs are the same day in different years.
const when = (ms: number) => {
  const d = new Date(ms);
  return d.toLocaleString(getLang() === 'ko' ? 'ko-KR' : 'en-US', { ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
};
const rel = (ms: number) => relativeTime(ms, Date.now(), getLang());
const lateBy = (ms: number) => { const m = Math.round(ms / 60000); return m < 60 ? t('sched.grace.min', { n: m }) : t('sched.grace.hour', { n: Math.round(m / 6) / 10 }); };

/**
 * Skills (or prompts) run on a cron schedule by the server, in a fresh session each time, and what
 * happens when the Mac is asleep at that moment (see server/scheduler.ts and schedulePower.ts).
 */
export default function ScheduleView({ defaultCwd, projects, onOpenRun }: {
  defaultCwd: string | null;
  /** Favorites and recent folders, offered as projects. */
  projects: string[];
  onOpenRun: (run: ScheduleRun) => void;
}) {
  useLang();
  const [snap, setSnap] = useState<ScheduleSnapshot | null>(null);
  // The title bar badge counts the schedules (lib/scheduleCount.ts).
  useEffect(() => { if (snap) setScheduleCount(snap.schedules); }, [snap]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(() => blank(defaultCwd ?? ''));
  const [busy, setBusy] = useState(false);
  const [ctx, setCtx] = useState<AgentContext | null>(null);
  const [skillFilter, setSkillFilter] = useState('');
  const [, tick] = useState(0);
  // "@" in the prompt: the token containing the caret starts with "@" and has no whitespace; it picks a past session.
  const [caret, setCaret] = useState(0);
  const [sessions, setSessions] = useState<RecentSession[] | null>(null);
  const [sessionIdx, setSessionIdx] = useState(0);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const mention = useMemo(() => {
    const m = draft.prompt.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/);
    return m ? { query: m[1], start: caret - m[1].length - 1 } : null;
  }, [draft.prompt, caret]);
  useEffect(() => {
    if (!mention || sessions) return;
    let live = true;
    api.historyAll(300).then((rows) => { if (live) setSessions(rows); }).catch(() => { if (live) setSessions([]); });
    return () => { live = false; };
  }, [mention, sessions]);
  const sessionHits = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return (sessions ?? []).filter((r) => r.agent === draft.agent && (!q || r.title.toLowerCase().includes(q)))
      // The project's own sessions first.
      .sort((a, b) => Number(b.cwd === draft.cwd) - Number(a.cwd === draft.cwd)).slice(0, 12);
  }, [mention, sessions, draft.agent, draft.cwd]);
  useEffect(() => { setSessionIdx(0); }, [mention?.query]);
  const pickSession = (r: RecentSession) => {
    if (!mention) return;
    const prompt = (draft.prompt.slice(0, mention.start) + draft.prompt.slice(caret)).replace(/^\s+/, '');
    setDraft((d) => ({ ...d, prompt, resumeSessionId: r.sessionId, resumeTitle: r.title, cwd: r.cwd ?? d.cwd }));
    setCaret(mention.start);
    requestAnimationFrame(() => { const el = promptRef.current; if (el) { el.focus(); el.setSelectionRange(mention.start, mention.start); } });
  };
  const onPromptKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mention) return;
    if (e.key === 'ArrowDown' && sessionHits.length) { e.preventDefault(); setSessionIdx((i) => (i + 1) % sessionHits.length); }
    else if (e.key === 'ArrowUp' && sessionHits.length) { e.preventDefault(); setSessionIdx((i) => (i - 1 + sessionHits.length) % sessionHits.length); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && sessionHits[sessionIdx]) { e.preventDefault(); pickSession(sessionHits[sessionIdx]); }
    else if (e.key === 'Escape') { e.preventDefault(); setCaret(0); }
  };

  const load = () => api.schedules().then((s) => { setSnap(s); setError(null); }).catch((e) => setError((e as Error).message));
  // Poll only while this view is on screen and the window is in front; refresh once when it comes back.
  const viewActive = useContext(ViewActiveContext);
  useEffect(() => {
    if (!viewActive) return;
    void load(); tick((n) => n + 1);
    return pollWhileActive(() => { void load(); tick((n) => n + 1); }, 5000);
  }, [viewActive]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = snap?.schedules.find((s) => s.id === selected) ?? null;
  // Pick the first schedule (or a new one) once the list arrives.
  useEffect(() => {
    if (!snap || selected !== null) return;
    if (snap.schedules[0]) { setSelected(snap.schedules[0].id); setDraft(fromSchedule(snap.schedules[0])); } else setSelected('new');
  }, [snap, selected]);
  useEffect(() => {
    setCtx(null);
    if (!draft.cwd) return;
    let live = true;
    api.agentContext(draft.cwd).then((c) => { if (live) setCtx(c); }).catch(() => {});
    return () => { live = false; };
  }, [draft.cwd]);

  const select = (s: Schedule | null) => { setSelected(s ? s.id : 'new'); setDraft(s ? fromSchedule(s) : blank(defaultCwd ?? '')); setSkillFilter(''); setError(null); };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const act = async (fn: () => Promise<ScheduleSnapshot>) => {
    setBusy(true);
    try { setSnap(await fn()); setError(null); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };
  const save = async () => {
    if (selected === 'new' || !current) {
      const before = new Set(snap?.schedules.map((s) => s.id));
      setBusy(true);
      try {
        const next = await api.scheduleCreate(draft);
        setSnap(next); setError(null);
        const made = next.schedules.find((s) => !before.has(s.id));
        if (made) select(made);
      } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    } else await act(() => api.scheduleUpdate(current.id, draft));
  };
  const remove = async () => {
    if (!current || !window.confirm(t('sched.confirmDelete', { name: current.name }))) return;
    if (await act(() => api.scheduleDelete(current.id))) select(null);
  };
  const helper = async (install: boolean) => {
    setBusy(true);
    try {
      const r = await api.scheduleWakeHelper(install, t(install ? 'sched.helperPrompt' : 'sched.helperRemovePrompt'));
      setSnap(r);
      setError(r.result === 'cancelled' ? t('sched.helperCancelled') : null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const skills = (ctx?.skills ?? []).filter((s) => s.agent === draft.agent);
  const shown = skills.filter((s) => !skillFilter || `${s.name} ${s.description}`.toLowerCase().includes(skillFilter.toLowerCase()));
  const cronInfo = useMemo(() => {
    try { const s = parseCron(draft.cron); return { ok: true as const, text: describeCron(draft.cron), next: nextRuns(s, 3) }; } catch (e) { return { ok: false as const, text: (e as Error).message, next: [] }; }
  }, [draft.cron]);
  const dirty = !current || JSON.stringify(fromSchedule(current)) !== JSON.stringify(draft);
  const runs = (snap?.runs ?? []).filter((r) => !current || r.scheduleId === current.id);
  const lastRun = (id: string) => snap?.runs.find((r) => r.scheduleId === id);
  const power = snap?.power;
  const projectOptions = [...new Set([...(draft.cwd ? [draft.cwd] : []), ...projects])];
  const list = usePaneWidth('vibe.w.scheduleList', 320, 240, 640);
  const side = usePaneWidth('vibe.w.scheduleSide', 460, 320, 900);
  const sideStart = useRef(0);

  return (
    <div className="flex-1 min-w-0 flex min-h-0 px-[42px] pb-4 text-[12.5px]">
      <aside style={{ width: list.width }} className="glass shrink-0 flex flex-col min-h-0 overflow-hidden">
        <div className="h-12 shrink-0 flex items-center gap-2 px-4 border-b border-line">
          <span className="text-[14px] font-semibold">{t('sched.title')}</span>
          <div className="flex-1" />
          <button className="h-7 flex items-center gap-1 rounded-full bg-fill-2 hover:bg-fill-3 px-3 text-zinc-100 transition-colors" onClick={() => select(null)}><Icon name="plus" size={12} />{t('sched.new')}</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
          {snap && !snap.schedules.length && <div className="px-2 py-3 text-zinc-500">{t('sched.empty')}</div>}
          {snap?.schedules.map((s) => {
            const last = lastRun(s.id);
            return (
              <button key={s.id} onClick={() => select(s)} className={`w-full text-left rounded-xl px-3 py-2 border transition-colors duration-150 ${selected === s.id ? 'border-white/15 bg-fill-3' : 'border-transparent hover:bg-fill'}`}>
                <div className="flex items-center gap-2">
                  <AgentIcon agent={s.agent} size={13} />
                  <span className={`truncate font-medium ${s.enabled ? 'text-zinc-100' : 'text-zinc-500 line-through'}`}>{s.name}</span>
                  <div className="flex-1" />
                  {last && <span className={`w-2 h-2 shrink-0 rounded-full ${STATUS_DOT[last.status]}`} title={t(`sched.status.${last.status}`)} />}
                </div>
                <div className="mt-0.5 text-[11px] text-zinc-500 truncate">{describeCron(s.cron) || s.cron} · {s.cwd.split('/').pop()}{s.resumeSessionId ? ` · ↻ ${s.resumeTitle || s.resumeSessionId}` : ''}</div>
                <div className="text-[11px] text-zinc-500">{s.next ? t('sched.nextAt', { when: when(s.next), rel: rel(s.next) }) : t('sched.off')}{s.power === 'wake' ? ' · ⏰' : ''}</div>
              </button>
            );
          })}
        </div>
        {power && (
          <div className="shrink-0 border-t border-white/10 px-4 py-2.5 text-[11px] text-zinc-500 space-y-0.5">
            <div>{power.awake ? t('sched.power.holding') : t('sched.power.idle')}</div>
            {power.wakeAt && <div>{t('sched.power.wakeAt', { when: when(power.wakeAt) })}</div>}
            {power.error === 'helper-missing' ? <div className="text-amber-300">{t('sched.power.helperMissing')}</div> : power.error && <div className="text-red-300">{power.error}</div>}
          </div>
        )}
      </aside>

      <SideSplitter pane={list} />
      <main className="glass flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
        {/* Header: name, on/off and the actions. */}
        <div className="h-14 shrink-0 flex items-center gap-2 px-5 border-b border-line">
          <input className="min-w-0 flex-1 bg-transparent rounded-md px-2 py-1.5 -ml-2 text-[15px] font-semibold outline-none hover:bg-fill focus:bg-black/20 transition-colors" placeholder={t('sched.namePlaceholder')} value={draft.name} onChange={(e) => set('name', e.target.value)} />
          <label className="shrink-0 flex items-center gap-1.5 text-zinc-300 cursor-pointer mr-1"><input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />{t('sched.enabled')}</label>
          {current && <button disabled={busy} onClick={() => void remove()} className="shrink-0 rounded-full px-3 py-1.5 text-red-300 hover:bg-red-500/10 disabled:opacity-40">{t('sched.delete')}</button>}
          {current && <button disabled={busy} onClick={() => void act(() => api.scheduleRunNow(current.id))} className="shrink-0 flex items-center gap-1 rounded-full bg-emerald-400/15 hover:bg-emerald-400/25 px-3 py-1.5 text-emerald-200 disabled:opacity-40"><Icon name="play" size={10} filled />{t('sched.runNow')}</button>}
          <button disabled={busy || !dirty || !draft.cwd || !cronInfo.ok} onClick={() => void save()} className="shrink-0 rounded-full bg-sky-500/80 hover:bg-sky-500 px-3.5 py-1.5 text-white disabled:opacity-40">{current ? t('sched.save') : t('sched.create')}</button>
        </div>
        {error && <div className="shrink-0 mx-5 mt-3 rounded-full bg-red-500/10 border border-red-500/20 px-3 py-2 text-red-200">{error}</div>}

        <div className="flex-1 min-h-0 flex">
          {/* Left (wider): what runs. */}
          <div className="flex-1 min-w-[320px] overflow-y-auto px-6 py-5 flex flex-col gap-5">
            <Field label={t('sched.project')}>
              <div className="flex gap-2">
                <select className={input} value={draft.cwd} onChange={(e) => set('cwd', e.target.value)}>
                  {!draft.cwd && <option value="">{t('sched.pickProject')}</option>}
                  {projectOptions.map((p) => <option key={p} value={p}>{p.split('/').pop()} — {p}</option>)}
                </select>
                {window.vibe?.pickFolder && <button className="shrink-0 rounded-md px-2.5 bg-white/5 hover:bg-white/10" onClick={() => void window.vibe!.pickFolder().then((p) => { if (p) set('cwd', p); })}>{t('sched.browse')}</button>}
              </div>
            </Field>

            <Field label={t('sched.agent')}>
              <div className="flex items-center gap-2">
                <div className="inline-flex rounded-md bg-white/5 p-0.5">
                  {(['claude', 'codex'] as const).map((a) => (
                    <button key={a} onClick={() => setDraft((d) => ({ ...d, agent: a, skill: '', permissionMode: a === 'codex' && d.permissionMode === 'auto' ? 'default' : d.permissionMode }))}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded ${draft.agent === a ? 'bg-white/15 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}><AgentIcon agent={a} size={12} />{a === 'claude' ? 'Claude' : 'Codex'}</button>
                  ))}
                </div>
                <select className="bg-black/20 border border-line rounded-md px-2 py-1 outline-none" value={draft.permissionMode} onChange={(e) => set('permissionMode', e.target.value)}>
                  {MODES.filter((m) => m.id !== 'auto' || draft.agent === 'claude').map((m) => <option key={m.id} value={m.id}>{t(m.key)}</option>)}
                </select>
              </div>
              {draft.permissionMode === 'default' && <div className="mt-1.5 text-[11px] text-amber-300/80">{t('sched.approvalWarn')}</div>}
            </Field>

            <Field label={t('sched.skill')} hint={t('sched.skillHint', { n: skills.length })}>
              <div className="rounded-lg border border-white/10">
                <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-white/10">
                  <Icon name="search" size={12} className="text-zinc-500" />
                  <input className="flex-1 bg-transparent outline-none" placeholder={t('sched.skillFilter')} value={skillFilter} onChange={(e) => setSkillFilter(e.target.value)} />
                  {draft.skill && <span className="rounded-full bg-violet-500/20 px-1.5 py-0.5 font-mono text-[11px] text-violet-100">/{draft.skill}</span>}
                </div>
                <div className="max-h-56 overflow-y-auto p-1">
                  <SkillRow active={!draft.skill} onClick={() => set('skill', '')} name={t('sched.noSkill')} description={t('sched.noSkillHint')} plain />
                  {!ctx && draft.cwd && <div className="px-2.5 py-1.5 text-zinc-500">{t('common.loading')}</div>}
                  {shown.map((s) => (
                    <SkillRow key={s.path} active={draft.skill === s.name} onClick={() => set('skill', s.name)} name={`/${s.name}`} description={s.description} badge={t(`context.scope.${s.scope}`)} />
                  ))}
                </div>
              </div>
            </Field>

            <Field label={draft.skill ? t('sched.args') : t('sched.prompt')} hint={draft.resumeSessionId ? t('sched.resumeHint') : undefined} className="flex-1 min-h-[200px] flex flex-col">
              {draft.resumeSessionId && (
                <div className="shrink-0 mb-1.5 flex items-center gap-2 rounded-md border border-violet-400/20 bg-violet-500/10 px-2.5 py-1.5">
                  <Icon name="reload" size={12} className="shrink-0 text-violet-200" />
                  <span className="shrink-0 text-[11px] text-violet-200/80">{t('sched.resume')}</span>
                  <span className="min-w-0 truncate text-violet-100" title={draft.resumeSessionId}>{draft.resumeTitle || draft.resumeSessionId}</span>
                  <div className="flex-1" />
                  <button className="shrink-0 text-[11px] text-zinc-400 hover:text-zinc-100" onClick={() => setDraft((d) => ({ ...d, resumeSessionId: undefined, resumeTitle: undefined }))}>{t('sched.resumeClear')}</button>
                </div>
              )}
              {/* Fills the rest of the column; the session picker opens above it so the scroll area never clips it. */}
              <div className="relative flex-1 min-h-0 flex flex-col">
                <textarea ref={promptRef} className={`${input} flex-1 min-h-[120px] resize-none font-mono text-[12px]`} value={draft.prompt}
                  onChange={(e) => { set('prompt', e.target.value); setCaret(e.target.selectionStart); }}
                  onSelect={(e) => setCaret(e.currentTarget.selectionStart)} onKeyDown={onPromptKey} onBlur={() => setCaret(0)}
                  placeholder={draft.skill ? t('sched.argsPlaceholder', { skill: draft.skill }) : t('sched.promptPlaceholder')} />
                {mention && (
                  <div className="absolute bottom-full left-0 mb-1 w-[520px] max-w-full glass-pop pop-in rounded-xl py-1 z-10">
                    {sessions === null && <div className="px-3 py-1.5 text-zinc-500">{t('common.loading')}</div>}
                    {sessions !== null && !sessionHits.length && <div className="px-3 py-1.5 text-zinc-500">{t('sched.resumeNone')}</div>}
                    {sessionHits.map((r, i) => (
                      <div key={`${r.agent}:${r.sessionId}`} onMouseEnter={() => setSessionIdx(i)} onMouseDown={(e) => { e.preventDefault(); pickSession(r); }}
                        className={`px-3 py-1 flex items-center gap-2 cursor-pointer ${i === sessionIdx ? 'bg-blue-500/20 text-white' : 'text-zinc-300'}`}>
                        <span className="min-w-0 flex-1 truncate">{r.title}</span>
                        {r.cwd && <span className="shrink-0 text-[11px] text-zinc-500">{r.cwd.split('/').pop()}</span>}
                        <span className="shrink-0 text-[11px] text-zinc-600">{rel(r.lastModified)}</span>
                      </div>
                    ))}
                    <div className="px-3 pt-1 text-[10px] text-zinc-600">{t('sched.resumeMentionHint')}</div>
                  </div>
                )}
              </div>
            </Field>
          </div>

          {/* Right: when and how it runs, then its run history (scrolls on its own). */}
          <Splitter onStart={() => { sideStart.current = side.width; }} onDrag={(dx) => side.setWidth(sideStart.current - dx)} />
          <div style={{ width: side.width }} className="shrink-0 flex flex-col min-h-0">
            <div className="min-h-0 overflow-y-auto px-5 py-5 space-y-5">
              <Field label={t('sched.when')}>
                <input className={`${input} font-mono`} value={draft.cron} onChange={(e) => set('cron', e.target.value)} spellCheck={false} />
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {CRON_PRESETS.filter((p) => p.key !== 'every5').map((p) => <button key={p.expr} title={p.expr} onClick={() => set('cron', p.expr)} className="rounded-full bg-fill hover:bg-fill-2 transition-colors px-2 py-0.5 text-[11px] text-zinc-300">{t(`tb.cron.preset.${p.key}`)}</button>)}
                </div>
                <div className={`mt-1.5 text-[11.5px] ${cronInfo.ok ? 'text-zinc-300' : 'text-red-300'}`}>{cronInfo.text}</div>
                {cronInfo.next.length > 0 && <div className="text-[11px] text-zinc-500">{t('sched.upcoming')} {cronInfo.next.map((d) => when(d.getTime())).join(' · ')}</div>}
              </Field>

              <Field label={t('sched.sleep')}>
                <div className="space-y-1.5">
                  {POWER.map((p) => (
                    <label key={p} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer ${draft.power === p ? 'border-white/20 bg-white/[0.05]' : 'border-white/5 hover:border-white/10'}`}>
                      <input type="radio" className="mt-0.5" checked={draft.power === p} onChange={() => set('power', p)} />
                      <div className="min-w-0 flex-1">
                        <div className="text-zinc-100">{t(`sched.power.${p}`)}</div>
                        <div className="text-[11px] text-zinc-500">{t(`sched.power.${p}.hint`)}</div>
                        {p === 'wake' && (
                          <div className="mt-1.5 flex items-center gap-2 text-[11px]">
                            {power?.helper
                              ? <><span className="text-emerald-300">{t('sched.helperInstalled')}</span><button disabled={busy} className="text-zinc-500 hover:text-zinc-200 disabled:opacity-40" onClick={(e) => { e.preventDefault(); void helper(false); }}>{t('sched.helperRemove')}</button></>
                              : <button disabled={busy} className="rounded-full bg-violet-500/20 hover:bg-violet-500/30 px-2 py-0.5 text-violet-100 disabled:opacity-40" onClick={(e) => { e.preventDefault(); void helper(true); }}>{t('sched.helperInstall')}</button>}
                          </div>
                        )}
                      </div>
                    </label>
                  ))}
                  <div className="text-[11px] text-zinc-500 leading-relaxed">{t('sched.lidNote')}</div>
                </div>
              </Field>

              <Field label={t('sched.grace')} hint={t('sched.graceHint')}>
                <select className="bg-black/20 border border-line rounded-md px-2 py-1 outline-none" value={draft.graceMinutes} onChange={(e) => set('graceMinutes', Number(e.target.value))}>
                  {[...new Set([...GRACE, draft.graceMinutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m === 0 ? t('sched.grace.onTime') : m < 60 ? t('sched.grace.min', { n: m }) : t('sched.grace.hour', { n: Math.round(m / 6) / 10 })}</option>)}
                </select>
              </Field>
            </div>
            <div className="flex-1 min-h-[220px] flex flex-col border-t border-line">
              <div className="shrink-0 flex items-center gap-2 px-5 h-10">
                <span className="font-medium text-zinc-200">{current ? t('sched.runs') : t('sched.allRuns')}</span>
                <div className="flex-1" />
                {snap?.runs.some((r) => r.status !== 'running' && r.status !== 'waiting') && <button className="text-[11px] text-zinc-500 hover:text-zinc-200" onClick={() => void act(() => api.scheduleClearRuns())}>{t('sched.clearRuns')}</button>}
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 space-y-1">
                {!runs.length && <div className="px-2 text-zinc-500">{t('sched.noRuns')}</div>}
                {runs.slice(0, 50).map((r) => (
                  <div key={r.id} className="flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-white/[0.03]">
                    <span className={`mt-1.5 w-2 h-2 shrink-0 rounded-full ${STATUS_DOT[r.status]}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <span className="text-zinc-200">{t(`sched.status.${r.status}`)}</span>
                        {!current && <span className="truncate text-zinc-400">{r.name}</span>}
                        {r.trigger === 'manual' && <span className="rounded bg-white/5 px-1 text-[10px] text-zinc-400">{t('sched.manual')}</span>}
                        <span className="text-[11px] text-zinc-500">{when(r.scheduledFor)}</span>
                        {r.status !== 'missed' && r.status !== 'skipped' && r.startedAt - r.scheduledFor > 90000 && <span className="text-[11px] text-amber-300/80">{t('sched.late', { time: lateBy(r.startedAt - r.scheduledFor) })}</span>}
                        {r.endedAt && r.status !== 'missed' && r.status !== 'skipped' && <span className="text-[11px] text-zinc-500">· {Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000))}s</span>}
                        {!!r.costUsd && <span className="text-[11px] text-zinc-500">· ${r.costUsd.toFixed(2)}</span>}
                      </div>
                      {r.error && <div className="text-[11px] text-zinc-500 line-clamp-2">{r.error}</div>}
                    </div>
                    {(r.sessionId || r.agentSessionId) && <button className="shrink-0 rounded-full px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-white/10" onClick={() => onOpenRun(r)}>{t('sched.openRun')}</button>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={className}>
      <div className="shrink-0 mb-1.5 flex items-baseline gap-2"><span className="text-[11.5px] font-medium text-zinc-400">{label}</span>{hint && <span className="text-[11px] text-zinc-600">{hint}</span>}</div>
      {children}
    </div>
  );
}

function SkillRow({ active, onClick, name, description, badge, plain }: { active: boolean; onClick: () => void; name: string; description: string; badge?: string; plain?: boolean }) {
  return (
    <button onClick={onClick} className={`w-full text-left flex items-start gap-2.5 rounded-md px-2.5 py-1.5 ${active ? 'bg-violet-500/15' : 'hover:bg-white/[0.04]'}`}>
      <div className="min-w-0 flex-1">
        <div className={`${plain ? '' : 'font-mono '}text-[12px] ${active ? 'text-violet-100' : 'text-zinc-200'}`}>{name}</div>
        {description && <div className="text-[11px] text-zinc-500 line-clamp-2">{description}</div>}
      </div>
      {badge && <span className="shrink-0 mt-0.5 rounded bg-white/5 px-1.5 text-[10px] text-zinc-400">{badge}</span>}
    </button>
  );
}
