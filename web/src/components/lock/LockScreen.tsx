import { useEffect, useRef, useState } from 'react';
import { t, useLang } from '../../lib/i18n';
import type { LockInit, LockSessionSummary } from '../../lib/vibe';
import SegmentClock from './SegmentClock';

/*
 * Cover page loaded in every lock window (`/?lock=main|sub`, see electron/lockScreen.cts). It does not
 * load the app (no sockets, no sessions): the app window reports per-agent counts through the main process.
 * Every display shows the app wallpaper under a 15px blur; the main one adds the PIN card.
 */

const PIN_LENGTH = 4;
/** The orange sweep runs at least this long before the PIN is checked, so it reads as a step and not a flicker. */
const CHECK_MS = 900;
/** Red boxes stay this long before they clear for the next try. */
const WRONG_MS = 750;

type Phase = 'idle' | 'checking' | 'ok' | 'wrong';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Current time, re-rendered on each second boundary. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer = 0;
    const tick = () => { setNow(Date.now()); timer = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5); };
    tick();
    return () => window.clearTimeout(timer);
  }, []);
  return now;
}

/** Sends the unlock request; a match closes this window from the main process (after the green boxes show). */
async function tryUnlock(secret: string): Promise<{ ok: boolean; retryIn?: number }> {
  return window.vibe!.lock!.unlock(secret).catch(() => ({ ok: false, retryIn: 0 }));
}

/**
 * Four PIN boxes over one hidden password field: typing fills the next box, Backspace empties the previous one.
 * On the fourth digit an orange light runs around the boxes one after another, then they turn green (open) or red.
 */
function PinBoxes({ wait, onWait }: { wait: number; onWait: (seconds: number) => void }) {
  const [pin, setPin] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [shake, setShake] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const locked = wait > 0 || phase === 'checking' || phase === 'ok';
  // Keep typing on the field whatever is clicked or focused.
  useEffect(() => {
    const focus = () => window.setTimeout(() => input.current?.focus(), 0);
    focus();
    window.addEventListener('focus', focus);
    window.addEventListener('mousedown', focus);
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('mousedown', focus); };
  }, []);
  useEffect(() => { if (!locked) input.current?.focus(); }, [locked]);

  const check = async (value: string) => {
    setPhase('checking');
    await sleep(CHECK_MS);
    const r = await tryUnlock(value);
    if (r.ok) { setPhase('ok'); return; }
    setPhase('wrong');
    setShake(false);
    requestAnimationFrame(() => setShake(true));
    if (r.retryIn) onWait(r.retryIn);
    await sleep(WRONG_MS);
    setPin('');
    setPhase('idle');
  };
  const onChange = (raw: string) => {
    if (locked) return;
    const v = raw.replace(/\D/g, '').slice(0, PIN_LENGTH);
    setPin(v);
    if (phase === 'wrong') setPhase('idle');
    if (v.length === PIN_LENGTH) void check(v);
  };

  return (
    <div className="relative">
      <input ref={input} type="password" inputMode="numeric" autoComplete="off" spellCheck={false} value={pin} maxLength={PIN_LENGTH}
        aria-label={t('lock.enterPin')} readOnly={locked} onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 w-full h-full opacity-0 cursor-default" />
      <div onAnimationEnd={() => setShake(false)} className={`flex gap-4 ${shake ? 'lock-shake' : ''}`} aria-hidden="true">
        {Array.from({ length: PIN_LENGTH }, (_, i) => {
          const filled = i < pin.length;
          const current = phase === 'idle' && !wait && i === pin.length;
          return (
            <div key={i} data-state={phase} style={{ '--i': i } as React.CSSProperties}
              className={`pin-box ${current ? 'pin-box-current' : ''} ${wait ? 'opacity-40' : ''}`}>
              {phase === 'checking' && <span className="pin-flow" />}
              <span className={`pin-dot ${filled ? 'pin-dot-on' : ''}`} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The single-use recovery code (20 characters) does not fit the boxes: a plain field instead. */
function RecoveryField({ wait, onWait }: { wait: number; onWait: (seconds: number) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const submit = async () => {
    if (busy || wait || !value) return;
    setBusy(true);
    const r = await tryUnlock(value);
    setBusy(false);
    if (r.ok) return;
    setError(true); setValue('');
    if (r.retryIn) onWait(r.retryIn);
    input.current?.focus();
  };
  return (
    <form className="w-full" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className={`flex items-center h-12 rounded-full bg-black/40 border pl-5 pr-1.5 transition-colors ${error ? 'border-red-400/60' : 'border-white/12'}`}>
        <input ref={input} value={value} disabled={wait > 0 || busy} spellCheck={false} autoComplete="off"
          onChange={(e) => { setValue(e.target.value); setError(false); }} placeholder={t('lock.recoveryPlaceholder')}
          className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[14px] tracking-wider text-zinc-100 placeholder:font-sans placeholder:tracking-normal placeholder:text-zinc-500 disabled:opacity-50" />
        <button type="submit" disabled={!value || wait > 0 || busy} aria-label={t('lock.unlock')}
          className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/15 disabled:opacity-30 flex items-center justify-center text-zinc-200 transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
        </button>
      </div>
    </form>
  );
}

function Sessions({ sessions }: { sessions: LockSessionSummary[] }) {
  useLang();
  if (!sessions.length) return <div className="text-[11px] text-zinc-500">{t('lock.noSessions')}</div>;
  return (
    <div className="flex flex-wrap gap-2 justify-center">
      {sessions.map((s) => {
        const state = s.waiting ? 'waiting' : s.running ? 'running' : 'idle';
        const detail = [s.running ? t('lock.running', { n: s.running }) : t('lock.idle'), s.waiting ? t('lock.waiting', { n: s.waiting }) : ''].filter(Boolean).join(' · ');
        return (
          <div key={s.agent} className="flex items-center gap-2 rounded-full bg-white/[0.06] border border-white/[0.08] pl-2.5 pr-3 py-1 text-[11px]" title={detail}>
            <span className={`lock-dot lock-dot-${state} !w-1.5 !h-1.5`} />
            <span className="font-semibold tracking-[0.12em] text-zinc-200">{s.agent.toUpperCase()}</span>
            <span className="text-zinc-400">{s.total}</span>
          </div>
        );
      })}
    </div>
  );
}

function Card({ init, sessions }: { init: LockInit; sessions: LockSessionSummary[] }) {
  useLang();
  const now = useNow();
  const [recovery, setRecovery] = useState(false);
  const [waitUntil, setWaitUntil] = useState(() => Date.now() + init.retryIn * 1000);
  const wait = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  const onWait = (s: number) => setWaitUntil(Date.now() + s * 1000);
  // Liveness for the main process watchdog: sent only once the card exists, so a page that never renders it is caught too.
  useEffect(() => {
    const ping = () => window.vibe?.lock?.alive();
    ping();
    const id = window.setInterval(ping, 10000);
    return () => window.clearInterval(id);
  }, []);
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    <div className="lock-card pop-in w-[min(440px,90vw)] flex flex-col items-center px-10 pt-5 pb-7">
      <span className="w-12 h-1 rounded-full bg-white/25 mb-9" aria-hidden="true" />
      <SegmentClock text={`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`} height="46px" />
      <div className="mt-4 text-[13px] font-light tracking-wide text-zinc-300">{recovery ? t('lock.useRecovery') : t('lock.enterPin')}</div>
      <div className="mt-8 w-full flex justify-center">
        {recovery ? <RecoveryField wait={wait} onWait={onWait} /> : <PinBoxes wait={wait} onWait={onWait} />}
      </div>
      <div className={`h-5 mt-5 text-xs ${wait ? 'text-red-300/80' : 'text-transparent'}`}>{wait ? t('lock.wait', { s: wait }) : '.'}</div>
      <div className="mt-3 w-full flex flex-col items-center gap-3">
        <Sessions sessions={sessions} />
        <button type="button" onClick={() => setRecovery((v) => !v)} className="text-[12px] text-zinc-500 hover:text-zinc-200 transition-colors">
          {recovery ? t('lock.usePin') : t('lock.useRecovery')}
        </button>
      </div>
    </div>
  );
}

export default function LockScreen() {
  useLang();
  const [init, setInit] = useState<LockInit | null>(null);
  const [sessions, setSessions] = useState<LockSessionSummary[]>([]);
  useEffect(() => {
    document.title = 'Vibrato';
    const lock = window.vibe?.lock;
    if (!lock) return;
    void lock.init().then((i) => { if (!i) return; setInit(i); setSessions(i.sessions); });
    return lock.onUpdate((u) => { if (u.sessions) setSessions(u.sessions); });
  }, []);
  // Only the context menu is blocked here; Cmd shortcuts are filtered in the main process.
  useEffect(() => { const h = (e: Event) => e.preventDefault(); window.addEventListener('contextmenu', h); return () => window.removeEventListener('contextmenu', h); }, []);
  return (
    <div className="app-wall fixed inset-0 overflow-hidden select-none cursor-default">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-[15px]" />
      {init?.role === 'main' && (
        <div className="absolute inset-0 flex items-center justify-center p-6"><Card init={init} sessions={sessions} /></div>
      )}
    </div>
  );
}
