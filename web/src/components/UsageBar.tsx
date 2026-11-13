import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { UsageWindow } from '../lib/api';
import { loadUsage, useUsage } from '../lib/usageStore';
import { t, useLang } from '../lib/i18n';
import { UpdateBadge } from './UpdatePanel';
import Icon from './Icon';
import { useHostClients, useRemoteState, useRemoteUnread } from '../lib/remote';
import { useScheduleCount } from '../lib/scheduleCount';

export type ViewMode = 'vibe' | 'agent' | 'tools' | 'schedule' | 'remote';
export const VIEW_ORDER: ViewMode[] = ['vibe', 'agent', 'tools', 'schedule', 'remote'];

interface Props {
  mode: ViewMode;
  onMode: (m: ViewMode) => void;
  /** Shown in VIBE only. */
  onPickFolder?: () => void;
  onOpenSettings?: () => void;
}

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

/** "47m" / "2h 5m" for a forecast in minutes. */
export function minutesLabel(m: number): string {
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

/**
 * One usage window as a round glass button tinted with its agent's color: a small battery over "5h: 99%".
 * Hover shows the reset time and forecast; a click refreshes all usage.
 */
export function UsageChip({ agent, label, win, error, loading, empty }: {
  agent: 'claude' | 'codex'; label: string; win: UsageWindow | null; error?: string; loading: boolean;
  /** Minutes until used up at the recent rate (before the reset). */ empty?: number | null;
}) {
  const [hover, setHover] = useState(false);
  const [, tick] = useState(0);
  // Keep the countdown live while the tooltip is open.
  useEffect(() => {
    if (!hover) return;
    const timer = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(timer);
  }, [hover]);
  const remain = win ? Math.min(100, Math.max(0, 100 - win.usedPct)) : null;
  const name = agent === 'claude' ? 'Claude' : 'Codex';
  const title = error
    ? t(win ? 'usage.cached' : 'usage.unavailable', { label, reason: error })
    : win ? t('usage.used', { label, pct: win.usedPct, reset: resetLabel(win.resetsAt) }) : t(loading ? 'usage.loading' : 'usage.unavailable', { label, reason: '' });
  return (
    <button type="button" aria-label={title} data-agent={agent} onClick={() => loadUsage(true)} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      className={`titlebar-nodrag glass-ctl relative h-[38px] min-w-[38px] px-2 rounded-full flex flex-col items-center justify-center gap-[3px] ${agent === 'claude' ? 'glass-ctl-claude' : 'glass-ctl-codex'}`}>
      <span className={`relative inline-flex items-center ${loading ? 'animate-pulse' : ''}`}>
        <span className="w-[19px] h-[9px] rounded-[2.5px] border border-zinc-300/60 p-px flex">
          <span className={`h-full rounded-[1px] transition-[width] duration-500 ease-glass ${remain === null ? 'bg-zinc-600' : color(remain)}`} style={{ width: `${remain ?? 0}%` }} />
        </span>
        <span className="w-[2px] h-[4px] bg-zinc-300/60 rounded-r-[1px] ml-px" />
        {empty != null && empty <= 60 && <span className="absolute -top-1 -right-1.5 w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />}
      </span>
      <span className={`relative text-[9.5px] leading-none tabular-nums whitespace-nowrap ${error ? 'text-amber-300' : 'text-zinc-100'}`}>{label}: {remain === null ? '—' : `${remain}%`}</span>
      {hover && (
        <span role="tooltip" className="glass-pop pop-in absolute top-full right-0 mt-2 z-50 whitespace-nowrap rounded-xl px-3 py-2 text-left text-[11px] text-zinc-200 pointer-events-none">
          <span className="block font-medium text-zinc-100">{name} · {label}</span>
          {win ? <span className="block tabular-nums text-zinc-300">{remain}% · {resetLabel(win.resetsAt)}</span> : !error && <span className="block text-zinc-400">{t(loading ? 'usage.loading' : 'usage.unavailable', { label, reason: '' })}</span>}
          {empty != null && <span className="block text-amber-300 tabular-nums">{t('usage.forecast', { time: minutesLabel(empty) })}</span>}
          {error && <span className="block text-amber-300">{error}</span>}
          <span className="block mt-1 text-[10px] text-zinc-500">{t('usage.clickRefresh')}</span>
        </span>
      )}
    </button>
  );
}

/** Round glass icon button for the title bar; 38px like the view switch capsule (1px border, 4px padding, 28px tabs). */
function CircleButton({ title, onClick, children }: { title: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick}
      className="titlebar-nodrag glass-ctl w-[38px] h-[38px] shrink-0 rounded-full flex items-center justify-center text-zinc-200 hover:text-white">
      {children}
    </button>
  );
}

/** Whether the window is in front (focused and not hidden); the remote dot breathes only then. */
function useWindowActive(): boolean {
  const read = () => typeof document !== 'undefined' && !document.hidden && document.hasFocus();
  const [active, setActive] = useState(read);
  useEffect(() => {
    const update = () => setActive(read());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => { window.removeEventListener('focus', update); window.removeEventListener('blur', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  return active;
}

/** View switch: a glass capsule whose opaque white marker slides to the selected tab. */
function ModeTabs({ mode, onMode }: { mode: ViewMode; onMode: (m: ViewMode) => void }) {
  const refs = useRef<Partial<Record<ViewMode, HTMLButtonElement | null>>>({});
  const [marker, setMarker] = useState<{ left: number; width: number } | null>(null);
  const lang = useLang();
  // Green breathing dot on the Remote tab while this Mac is connected to a host, or a client is logged in here.
  const remoteStatus = useRemoteState().status;
  const hostClients = useHostClients();
  const remoteLive = remoteStatus === 'connected' || hostClients > 0;
  const windowActive = useWindowActive();
  // Red count badges: remote replies not seen yet (they replace the green dot), and schedules set up on this Mac.
  const remoteUnread = useRemoteUnread().size;
  const schedules = useScheduleCount();
  const badge = (m: ViewMode) => (m === 'remote' ? remoteUnread : m === 'schedule' ? schedules : 0);
  useLayoutEffect(() => {
    const el = refs.current[mode];
    if (el) setMarker({ left: el.offsetLeft, width: el.offsetWidth });
  }, [mode, lang]);
  return (
    <div className="titlebar-nodrag glass-ctl relative flex items-center p-1 rounded-full text-[12px] font-medium">
      {marker && <span className="absolute top-1 bottom-1 rounded-full bg-selected shadow-[0_2px_10px_rgb(0_0_0/.25)] transition-[left,width] duration-300 ease-glass" style={{ left: marker.left, width: marker.width }} />}
      {VIEW_ORDER.map((m) => (
        <button key={m} ref={(el) => { refs.current[m] = el; }} onClick={() => onMode(m)}
          className={`relative h-7 px-4 rounded-full transition-colors duration-200 ${mode === m ? 'text-on-selected' : 'text-zinc-200 hover:text-white'}`}>
          {t(`usage.${m}`)}
          {badge(m) > 0 ? <span className="count-badge" title={t(m === 'remote' ? 'usage.remoteUnread' : 'usage.scheduleCount', { n: badge(m) })}>{badge(m) > 99 ? '99+' : badge(m)}</span>
            : m === 'remote' && remoteLive && <span className={`live-dot -top-px right-px ${windowActive ? 'live-dot-breathe' : ''}`} title={t('usage.remoteLive')} />}
        </button>
      ))}
    </div>
  );
}

/** Title bar: folder + settings at the left, the view switch centered, usage on the right. No background: the wallpaper shows through. */
export default function UsageBar({ mode, onMode, onPickFolder, onOpenSettings }: Props) {
  useLang();
  const { usage: u, loading, error: loadError, forecast } = useUsage();
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => window.vibe?.onFullScreen?.(setFullScreen), []);
  const windowButtons = typeof window !== 'undefined' && !!window.vibe?.isElectron && !fullScreen;
  const claudeError = loadError ?? u?.errors.find((e) => e.startsWith('claude:'));
  const codexError = loadError ?? u?.errors.find((e) => e.startsWith('codex:'));
  const showFolder = mode === 'vibe' && !!onPickFolder;
  const openBrowser = typeof window !== 'undefined' ? window.vibe?.openBrowser : undefined;

  return (
    // z-30: the usage tooltips hang over the cards below.
    <div className="titlebar-drag relative z-30 h-[100px] pt-9 pb-6 shrink-0 grid grid-cols-[1fr_auto_1fr] items-center gap-4 text-xs select-none">
      {/* Left: room for the macOS window buttons, then the folder (VIBE only) and settings buttons. */}
      <div className={`min-w-0 flex items-center ${windowButtons ? 'pl-[84px]' : 'pl-[42px]'}`}>
        {/* Not overflow-hidden: that would clip the round button's shadow into a square. */}
        <div className={`shrink-0 transition-[width,margin,opacity,scale] duration-300 ease-glass ${showFolder ? 'w-[38px] mr-2 opacity-100 scale-100' : 'w-0 mr-0 opacity-0 scale-75 pointer-events-none'}`} aria-hidden={!showFolder}>
          <CircleButton title={t('sidebar.openFolder')} onClick={onPickFolder}><Icon name="folderPlus" size={15} /></CircleButton>
        </div>
        {onOpenSettings && <CircleButton title={t('common.settings')} onClick={onOpenSettings}><Icon name="gear" size={15} /></CircleButton>}
        <span className="ml-1.5"><UpdateBadge onWall /></span>
      </div>
      {/* The browser button hangs off the capsule's right edge so the tabs stay centered. */}
      <div className="relative">
        <ModeTabs mode={mode} onMode={onMode} />
        {openBrowser && (
          <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2.5">
            <CircleButton title={t('usage.openBrowser')} onClick={() => void openBrowser()}><Icon name="globe" size={16} /></CircleButton>
          </div>
        )}
      </div>
      <div className="min-w-0 flex items-center justify-end gap-1.5 pr-[42px]">
        <UsageChip agent="claude" label="5h" win={u?.claude?.fiveHour ?? null} error={claudeError} loading={loading} empty={forecast('claude.fiveHour', u?.claude?.fiveHour ?? null)} />
        <UsageChip agent="claude" label={t('usage.week')} win={u?.claude?.weekly ?? null} error={claudeError} loading={loading} empty={forecast('claude.weekly', u?.claude?.weekly ?? null)} />
        {u?.claude?.model && <UsageChip agent="claude" label={u.claude.model.name.slice(0, 5)} win={u.claude.model} loading={loading} />}
        <span className="w-2.5 shrink-0" aria-hidden="true" />
        <UsageChip agent="codex" label="5h" win={u?.codex?.fiveHour ?? null} error={codexError} loading={loading} empty={forecast('codex.fiveHour', u?.codex?.fiveHour ?? null)} />
        <UsageChip agent="codex" label={t('usage.week')} win={u?.codex?.weekly ?? null} error={codexError} loading={loading} empty={forecast('codex.weekly', u?.codex?.weekly ?? null)} />
      </div>
    </div>
  );
}
