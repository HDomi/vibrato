import { useEffect, useMemo, useRef, useState } from 'react';
import { t, useLang } from '../../lib/i18n';
import { headX, heartLayout, localBaseline, signal, TAIL, type HeartLayout, type Rect } from '../../lib/lockScreen';
import type { LockInit, LockSessionSummary, LockSettings } from '../../lib/vibe';
import SegmentClock from './SegmentClock';

/*
 * Cover page loaded in every lock window (`/?lock=main|sub`, see electron/lockScreen.cts). It does not
 * load the app (no sockets, no sessions): the app window reports per-agent counts through the main process.
 */

const TRACE = '#34d399';

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

function Heartbeat({ layout, self }: { layout: HeartLayout; self: Rect }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    let w = 0; let h = 0; let base = 0;
    let dirty = true;
    const resize = () => {
      w = window.innerWidth; h = window.innerHeight;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      base = localBaseline(layout, { ...self, height: h });
      dirty = true;
    };
    resize();
    window.addEventListener('resize', resize);
    const STEP = 1.5;
    const trace = (from: number, to: number) => {
      ctx.beginPath();
      for (let x = from; ; x += STEP) {
        const cx = Math.min(x, to);
        const y = base - signal(cx + self.x, layout);
        if (x === from) ctx.moveTo(cx, y); else ctx.lineTo(cx, y);
        if (cx >= to) break;
      }
    };
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const hx = headX(Date.now(), layout) - self.x;
      const active = hx > -24 && hx - TAIL < w + 24;
      // Only the faint ghost line is left once the sweep has passed this display; draw it once and idle.
      if (!active && !dirty) return;
      dirty = active;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = TRACE;
      ctx.globalAlpha = 0.07; ctx.lineWidth = 1.2;
      trace(0, w); ctx.stroke();
      if (!active) return;
      // Fading trail: one path under a horizontal gradient (separate chunks left seams where their alphas overlap).
      // A wide faint stroke under a thin one gives the phosphor glow.
      const a = Math.max(0, hx - TAIL);
      const b = Math.min(w, hx);
      if (b > a) {
        const grad = ctx.createLinearGradient(hx - TAIL, 0, hx, 0);
        grad.addColorStop(0, 'rgba(52,211,153,0)');
        grad.addColorStop(0.45, 'rgba(52,211,153,0.22)');
        grad.addColorStop(0.75, 'rgba(52,211,153,0.6)');
        grad.addColorStop(1, 'rgba(52,211,153,1)');
        ctx.strokeStyle = grad;
        trace(a, b);
        ctx.globalAlpha = 0.18; ctx.lineWidth = 7; ctx.stroke();
        ctx.globalAlpha = 1; ctx.lineWidth = 2; ctx.stroke();
      }
      if (hx >= 0 && hx <= w) {
        const y = base - signal(hx + self.x, layout);
        const g = ctx.createRadialGradient(hx, y, 0, hx, y, 16);
        g.addColorStop(0, 'rgba(236,253,245,0.95)');
        g.addColorStop(0.25, 'rgba(52,211,153,0.6)');
        g.addColorStop(1, 'rgba(52,211,153,0)');
        ctx.globalAlpha = 1; ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(hx, y, 16, 0, Math.PI * 2); ctx.fill();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [layout, self]);
  return <canvas ref={ref} className="absolute inset-0 w-full h-full pointer-events-none" />;
}

function Clock({ now, size }: { now: number; size: string }) {
  const lang = useLang();
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', { month: 'long', day: 'numeric', weekday: 'long' }).format(d);
  return (
    <div className="flex flex-col items-center">
      <SegmentClock text={`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`} height={`calc(${size} * 0.78)`} />
      <div className="mt-[3vh] text-zinc-400 font-light" style={{ fontSize: `calc(${size} * 0.11)` }}>{date}</div>
    </div>
  );
}

function SessionCards({ sessions }: { sessions: LockSessionSummary[] }) {
  useLang();
  if (!sessions.length) return <div className="text-sm text-zinc-500">{t('lock.noSessions')}</div>;
  return (
    <div className="flex flex-wrap gap-4 justify-center">
      {sessions.map((s) => {
        const state = s.waiting ? 'waiting' : s.running ? 'running' : 'idle';
        const detail = [s.running ? t('lock.running', { n: s.running }) : t('lock.idle'), s.waiting ? t('lock.waiting', { n: s.waiting }) : ''].filter(Boolean).join(' · ');
        return (
          <div key={s.agent} className="flex items-center gap-3.5 rounded-2xl bg-white/[0.035] border border-white/[0.08] pl-4 pr-6 py-3.5 min-w-[200px]">
            <span className={`lock-dot lock-dot-${state}`} />
            <div>
              <div className="text-[15px] text-zinc-100">
                <span className="font-semibold tracking-[0.16em]">{s.agent.toUpperCase()}</span>
                <span className="ml-2 text-zinc-300">{t(s.total === 1 ? 'lock.session1' : 'lock.sessions', { n: s.total })}</span>
              </div>
              <div className="text-xs text-zinc-500 mt-0.5">{detail}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Password({ initialWait }: { initialWait: number }) {
  useLang();
  const now = useNow();
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waitUntil, setWaitUntil] = useState(() => Date.now() + initialWait * 1000);
  const input = useRef<HTMLInputElement>(null);
  const wait = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  // Keep typing on the field whatever is clicked or focused.
  useEffect(() => {
    const focus = () => window.setTimeout(() => input.current?.focus(), 0);
    focus();
    window.addEventListener('focus', focus);
    window.addEventListener('mousedown', focus);
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('mousedown', focus); };
  }, []);
  // A disabled field drops focus (while checking, while waiting out retries); take it back afterwards.
  useEffect(() => { if (!wait && !busy) input.current?.focus(); }, [wait, busy]);
  // Liveness for the main process watchdog: sent only once the field exists, so a page that never renders it is caught too.
  useEffect(() => {
    const ping = () => window.vibe?.lock?.alive();
    ping();
    const id = window.setInterval(ping, 10000);
    return () => window.clearInterval(id);
  }, []);
  const submit = async () => {
    if (busy || wait || !value) return;
    setBusy(true);
    const r = await window.vibe!.lock!.unlock(value).catch(() => ({ ok: false, retryIn: 0 }));
    setBusy(false);
    if (r.ok) return; // the main process closes this window
    setValue('');
    setError(true);
    setShake(false);
    requestAnimationFrame(() => setShake(true));
    if (r.retryIn) setWaitUntil(Date.now() + r.retryIn * 1000);
  };
  return (
    <form className="flex flex-col items-center" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div onAnimationEnd={() => setShake(false)} className={`flex items-center h-12 w-[min(360px,80vw)] rounded-full bg-white/[0.06] border pl-5 pr-1.5 ${error ? 'border-red-400/40' : 'border-white/10'} ${shake ? 'lock-shake' : ''}`}>
        <input ref={input} type="password" value={value} disabled={wait > 0 || busy} autoFocus spellCheck={false}
          onChange={(e) => { setValue(e.target.value); setError(false); }}
          placeholder={t('lock.password')}
          className="flex-1 min-w-0 bg-transparent outline-none text-[15px] tracking-wider text-zinc-100 placeholder:text-zinc-500 placeholder:tracking-normal disabled:opacity-50" />
        <button type="submit" disabled={!value || wait > 0 || busy} aria-label={t('lock.unlock')}
          className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/15 disabled:opacity-30 flex items-center justify-center text-zinc-200 transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
        </button>
      </div>
      <div className={`h-5 mt-3 text-xs ${wait || error ? 'text-red-300/80' : 'text-zinc-600'}`}>
        {wait ? t('lock.wait', { s: wait }) : error ? t('lock.wrong') : t('lock.hint')}
      </div>
    </form>
  );
}

export default function LockScreen() {
  useLang();
  const now = useNow();
  const [init, setInit] = useState<LockInit | null>(null);
  const [settings, setSettings] = useState<LockSettings | null>(null);
  const [sessions, setSessions] = useState<LockSessionSummary[]>([]);
  useEffect(() => {
    document.title = 'Vibrato';
    const lock = window.vibe?.lock;
    if (!lock) return;
    void lock.init().then((i) => { if (!i) return; setInit(i); setSettings(i.settings); setSessions(i.sessions); });
    return lock.onUpdate((u) => { if (u.settings) setSettings(u.settings); if (u.sessions) setSessions(u.sessions); });
  }, []);
  const layout = useMemo(() => (init ? heartLayout(init.displays) : null), [init]);
  // Only the context menu is blocked here; Cmd shortcuts are filtered in the main process.
  useEffect(() => { const h = (e: Event) => e.preventDefault(); window.addEventListener('contextmenu', h); return () => window.removeEventListener('contextmenu', h); }, []);
  const main = init?.role === 'main';
  const bg = settings ? (main ? settings.mainBg : settings.subBg) : '#0b0d11';
  return (
    <div className="fixed inset-0 overflow-hidden select-none cursor-default" style={{ background: bg }}>
      {init && layout && settings?.heartbeat && <Heartbeat layout={layout} self={init.self} />}
      {init && main && (
        <>
          <div className="absolute inset-x-0 top-[30%] -translate-y-1/2 flex justify-center"><Clock now={now} size="min(15vw, 25vh)" /></div>
          <div className="absolute inset-x-0 top-[53%] flex justify-center px-8"><SessionCards sessions={sessions} /></div>
          <div className="absolute inset-x-0 bottom-[6%] flex justify-center"><Password initialWait={init.retryIn} /></div>
        </>
      )}
    </div>
  );
}
