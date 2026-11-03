import { useEffect, useState } from 'react';
import type { UsageWindow } from '../lib/api';
import { loadUsage, useUsage } from '../lib/usageStore';
import { t, useLang } from '../lib/i18n';
import Icon from './Icon';

export type ViewMode = 'vibe' | 'ide' | 'agent' | 'tools' | 'schedule';

interface Props { mode: ViewMode; onMode: (m: ViewMode) => void }

function color(remain: number) {
  if (remain > 50) return 'bg-emerald-400';
  if (remain > 20) return 'bg-amber-400';
  return 'bg-red-400';
}

/** "2d 3h 15m" until `ts` (unix seconds); leading zero units are dropped. Null once the window has reset. */
export function untilReset(ts: number, now = Date.now()): string | null {
  const mins = Math.ceil((ts * 1000 - now) / 60000);
  if (mins <= 0) return null;
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function resetLabel(ts: number | null) {
  if (!ts) return t('usage.noReset');
  const left = untilReset(ts);
  return left ? t('usage.resetsAfter', { time: left }) : t('usage.reset');
}

/** Tiny battery: remaining % fills the cell from the left. Hover shows when the window resets. */
/** "47m" / "2h 5m" for a forecast in minutes. */
export function minutesLabel(m: number): string {
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export function Battery({ label, win, error, loading, empty }: { label: string; win: UsageWindow | null; error?: string; loading: boolean; /** Minutes until used up at the recent rate (before the reset). */ empty?: number | null }) {
  const [hover, setHover] = useState(false);
  const [, tick] = useState(0);
  // Keep the countdown live while the popover is open.
  useEffect(() => {
    if (!hover) return;
    const timer = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(timer);
  }, [hover]);
  const remain = win ? Math.min(100, Math.max(0, 100 - win.usedPct)) : null;
  const title = error
    ? t(win ? 'usage.cached' : 'usage.unavailable', { label, reason: error })
    : win ? t('usage.used', { label, pct: win.usedPct, reset: resetLabel(win.resetsAt) }) : t(loading ? 'usage.loading' : 'usage.unavailable', { label, reason: '' });
  return (
    <div className="titlebar-nodrag relative flex items-center gap-[5px] cursor-default" aria-label={title} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {hover && (
        <div role="tooltip" className="absolute top-full right-0 mt-2 z-50 whitespace-nowrap rounded-md border border-white/10 bg-[#171a22] px-2.5 py-1.5 text-[11px] text-zinc-200 shadow-xl pointer-events-none">
          {win ? <div className="tabular-nums"><span className="text-zinc-400">{label}</span> {remain}% · {resetLabel(win.resetsAt)}</div> : !error && <div className="text-zinc-400">{t(loading ? 'usage.loading' : 'usage.unavailable', { label, reason: '' })}</div>}
          {empty != null && <div className="text-amber-300 tabular-nums">{t('usage.forecast', { time: minutesLabel(empty) })}</div>}
          {error && <div className="text-amber-300">{error}</div>}
        </div>
      )}
      <span className="text-[12.5px] text-zinc-500 @max-[470px]:hidden">{label}</span>
      <span className="relative inline-flex items-center">
        <span className="w-[23px] h-[11px] rounded-[3px] border border-zinc-500/80 p-px flex">
          <span className={`h-full rounded-[1px] ${remain === null ? 'bg-zinc-600' : color(remain)}`} style={{ width: `${remain ?? 0}%` }} />
        </span>
        <span className="w-[3px] h-[5px] bg-zinc-500/80 rounded-r-[1px] ml-px" />
        {empty != null && empty <= 60 && <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />}
      </span>
      <span className={`text-[12.5px] tabular-nums w-[35px] @max-[660px]:hidden ${error ? 'text-amber-400' : 'text-zinc-400'}`}>{remain === null ? '—' : `${remain}%`}</span>
    </div>
  );
}

export default function UsageBar({ mode, onMode }: Props) {
  useLang();
  const { usage: u, loading, error: loadError, forecast } = useUsage();
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => window.vibe?.onFullScreen?.(setFullScreen), []);
  const windowButtons = typeof window !== 'undefined' && !!window.vibe?.isElectron && !fullScreen;

  const load = (force = false) => loadUsage(force);

  return (
    <div className="titlebar-drag h-[45px] shrink-0 flex items-center border-b border-white/10 bg-[#0e1117] text-xs select-none">
      {/* Left: room for the macOS window buttons, a divider, then the mode switch. */}
      <div className={`shrink-0 flex items-center ${windowButtons ? 'pl-[80px]' : 'pl-3'}`}>
        {windowButtons && <span className="w-px h-[18px] bg-white/10 mr-3" aria-hidden="true" />}
        <div className="titlebar-nodrag flex items-center rounded-md bg-white/5 p-0.5">
          {(['vibe', 'ide', 'agent', 'tools', 'schedule'] as ViewMode[]).map((m) => (
            <button key={m} onClick={() => onMode(m)}
              className={`px-3 py-0.5 rounded text-[11px] font-medium transition-colors ${mode === m ? 'bg-white/15 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
              {t(`usage.${m}`)}
            </button>
          ))}
        </div>
      </div>
      {/* Usage batteries, right-aligned. When the cell gets narrow (small window) they compact in steps
          instead of running under the switch: percentages, then window labels, then agent names. */}
      <div className="@container flex-1 min-w-0 h-full flex items-center justify-end">
      <div className="flex items-center gap-[15px] @max-[660px]:gap-3 pr-3 min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="text-[12.5px] text-zinc-400 font-medium @max-[360px]:hidden">Claude</span>
            <Battery label="5h" win={u?.claude?.fiveHour ?? null} error={loadError ?? u?.errors.find((e) => e.startsWith('claude:'))} loading={loading} empty={forecast('claude.fiveHour', u?.claude?.fiveHour ?? null)} />
            <Battery label={t('usage.week')} win={u?.claude?.weekly ?? null} error={loadError ?? u?.errors.find((e) => e.startsWith('claude:'))} loading={loading} empty={forecast('claude.weekly', u?.claude?.weekly ?? null)} />
            {u?.claude?.model && <Battery label={u.claude.model.name.slice(0, 5)} win={u.claude.model} loading={loading} />}
          </div>
        <span className="text-zinc-700">|</span>
          <div className="flex items-center gap-2.5">
            <span className="text-[12.5px] text-zinc-400 font-medium @max-[360px]:hidden">Codex</span>
            <Battery label="5h" win={u?.codex?.fiveHour ?? null} error={loadError ?? u?.errors.find((e) => e.startsWith('codex:'))} loading={loading} empty={forecast('codex.fiveHour', u?.codex?.fiveHour ?? null)} />
            <Battery label={t('usage.week')} win={u?.codex?.weekly ?? null} error={loadError ?? u?.errors.find((e) => e.startsWith('codex:'))} loading={loading} empty={forecast('codex.weekly', u?.codex?.weekly ?? null)} />
          </div>
        <button className={`titlebar-nodrag w-7 h-7 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/10 ${loading ? 'animate-spin' : ''}`} onClick={() => load(true)} title={t('usage.refresh')}><Icon name="reload" size={14} /></button>
      </div>
      </div>
    </div>
  );
}
