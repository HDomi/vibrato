import { useCallback, useEffect, useRef, useState } from 'react';
import { t, useLang } from '../lib/i18n';
import type { LockDisplay, LockSettings as Settings } from '../lib/vibe';

/** The macOS display arrangement scaled down; clicking a display makes it the lock screen's main display. */
function DisplayMap({ displays, onPick }: { displays: LockDisplay[]; onPick: (key: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!displays.length) return null;
  const minX = Math.min(...displays.map((d) => d.bounds.x));
  const minY = Math.min(...displays.map((d) => d.bounds.y));
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  const scale = Math.min((width - 8) / (maxX - minX), 170 / (maxY - minY));
  const left = (width - (maxX - minX) * scale) / 2;
  return (
    <div ref={box} className="relative w-full" style={{ height: (maxY - minY) * scale + 8 }}>
      {displays.map((d) => (
        <button key={`${d.key}-${d.bounds.x}`} title={d.label} onClick={() => onPick(d.key)}
          className={`absolute rounded-md border-2 flex flex-col items-center justify-center gap-0.5 overflow-hidden px-1 transition-colors ${d.main ? 'border-emerald-400/80 bg-emerald-400/10' : 'border-white/15 bg-white/[0.03] hover:border-white/35'}`}
          style={{ left: left + (d.bounds.x - minX) * scale + 2, top: (d.bounds.y - minY) * scale + 4, width: d.bounds.width * scale - 4, height: d.bounds.height * scale - 4 }}>
          <span className="text-[11px] text-zinc-200 truncate max-w-full">{d.internal ? t('lockSettings.builtin') : d.label}</span>
          <span className="text-[10px] text-zinc-500">{d.bounds.width}×{d.bounds.height}</span>
          {d.main && <span className="text-[10px] font-medium text-emerald-300">{t('lockSettings.mainBadge')}</span>}
        </button>
      ))}
    </div>
  );
}

export default function LockSettings({ focus }: { focus?: boolean }) {
  useLang();
  const lock = window.vibe?.lock;
  const ref = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [hasPassword, setHasPassword] = useState(false);
  const [hasPin, setHasPin] = useState(false);
  const [hasRecovery, setHasRecovery] = useState(false);
  const [shownCode, setShownCode] = useState<string | null>(null);
  const [displays, setDisplays] = useState<LockDisplay[]>([]);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const refresh = useCallback(() => {
    void lock?.get().then((r) => { if (!r) return; setSettings(r.settings); setHasPassword(r.hasPassword); setHasPin(r.hasPin); setHasRecovery(r.hasRecovery); setDisplays(r.displays); });
  }, [lock]);
  useEffect(() => {
    refresh();
    const off = lock?.onDisplays(refresh);
    window.addEventListener('focus', refresh);
    return () => { off?.(); window.removeEventListener('focus', refresh); };
  }, [lock, refresh]);
  useEffect(() => { if (focus) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [focus, settings === null]);

  if (!lock) return null;
  const patch = (p: Partial<Settings>) => {
    if (settings) setSettings({ ...settings, ...p });
    void lock.set(p).then(() => { if ('mainDisplay' in p) refresh(); });
  };
  const errorText = (r: { error?: string; retryIn?: number }) =>
    r.error === 'pin' ? t('lockSettings.errPin') : r.error === 'wrong' ? (r.retryIn ? t('lockSettings.errWait', { s: r.retryIn }) : t('lockSettings.errWrong'))
      : r.error === 'wait' ? t('lockSettings.errWait', { s: r.retryIn ?? 0 }) : t('lockSettings.errWrong');
  const savePassword = async () => {
    if (!/^\d{4}$/.test(next)) { setMsg({ text: t('lockSettings.errPin'), ok: false }); return; }
    if (next !== confirm) { setMsg({ text: t('lockSettings.errMismatch'), ok: false }); return; }
    const r = await lock.setPassword({ current, next });
    if (!r.ok) { setMsg({ text: errorText(r), ok: false }); return; }
    setHasPassword(true); setHasPin(true); setHasRecovery(!!r.hasRecovery); setCurrent(''); setNext(''); setConfirm('');
    if (r.recoveryCode) setShownCode(r.recoveryCode);
    setMsg({ text: t('lockSettings.saved'), ok: true });
  };
  const removePassword = async () => {
    const r = await lock.setPassword({ current, next: '' });
    if (!r.ok) { setMsg({ text: errorText(r), ok: false }); return; }
    setHasPassword(false); setHasPin(false); setHasRecovery(false); setShownCode(null); setCurrent(''); setNext(''); setConfirm('');
    setMsg({ text: t('lockSettings.removed'), ok: true });
  };
  const newRecovery = async () => {
    if (!current) { setMsg({ text: t('lockSettings.recoveryNeedsCurrent'), ok: false }); return; }
    const r = await lock.newRecoveryCode(current);
    if (!r.ok || !r.recoveryCode) { setMsg({ text: errorText(r), ok: false }); return; }
    setCurrent(''); setMsg(null); setHasRecovery(true); setShownCode(r.recoveryCode);
  };
  const field = 'bg-black/20 border border-line rounded-full text-xs px-3 py-1.5 outline-none w-36 placeholder:text-zinc-600 tracking-[0.3em] placeholder:tracking-normal';
  // PIN fields keep digits only, at most four.
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 4);

  return (
    <div ref={ref} id="lock-settings" className="rounded-2xl border border-line bg-black/15 p-5 space-y-4 scroll-mt-4">
      <div className="flex items-center">
        <div className="font-medium">{t('lockSettings.title')}</div>
        <div className="flex-1" />
        <button disabled={!hasPin} onClick={() => lock.now()}
          className="text-xs rounded-full bg-fill-2 hover:bg-fill-3 px-3.5 py-1.5 transition-colors text-zinc-200 disabled:opacity-40">{t('lockSettings.lockNow')}</button>
      </div>
      <div className="text-xs text-zinc-500 leading-relaxed">{t('lockSettings.note')}</div>

      <div className="space-y-2">
        <div className="flex items-center gap-3 text-sm">
          <span className="w-28 text-zinc-400">{t('lockSettings.password')}</span>
          <span className={`text-xs ${hasPin ? 'text-emerald-300' : 'text-amber-300'}`}>{hasPin ? t('lockSettings.passwordSet') : hasPassword ? t('lockSettings.pinNeeded') : t('lockSettings.passwordNone')}</span>
        </div>
        <form className="flex flex-wrap items-center gap-2 pl-[124px]" onSubmit={(e) => { e.preventDefault(); void savePassword(); }}>
          {hasPassword && <input type="password" value={current} onChange={(e) => setCurrent(hasPin ? digits(e.target.value) : e.target.value)} placeholder={t('lockSettings.current')} className={field} autoComplete="off" inputMode={hasPin ? 'numeric' : undefined} />}
          <input type="password" value={next} onChange={(e) => setNext(digits(e.target.value))} placeholder={t('lockSettings.new')} className={field} autoComplete="new-password" inputMode="numeric" maxLength={4} />
          <input type="password" value={confirm} onChange={(e) => setConfirm(digits(e.target.value))} placeholder={t('lockSettings.confirm')} className={field} autoComplete="new-password" inputMode="numeric" maxLength={4} />
          <button type="submit" disabled={!next} className="text-xs rounded-full bg-selected hover:bg-white text-on-selected font-medium px-3.5 py-1.5 transition-colors disabled:opacity-40">{t('lockSettings.save')}</button>
          {hasPassword && <button type="button" disabled={!current} onClick={() => void removePassword()} className="text-xs text-zinc-400 hover:text-red-300 disabled:opacity-40 px-1">{t('lockSettings.remove')}</button>}
        </form>
        {msg && <div className={`text-xs pl-[124px] ${msg.ok ? 'text-emerald-300' : 'text-red-300'}`}>{msg.text}</div>}
      </div>

      {hasPassword && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-sm">
            <span className="w-28 text-zinc-400">{t('lockSettings.recovery')}</span>
            <span className={`text-xs ${hasRecovery ? 'text-emerald-300' : 'text-amber-300'}`}>{hasRecovery ? t('lockSettings.recoverySet') : t('lockSettings.recoveryNone')}</span>
            <div className="flex-1" />
            <button onClick={() => void newRecovery()} className="text-xs rounded-full bg-fill-2 hover:bg-fill-3 px-3.5 py-1.5 transition-colors text-zinc-200">{t('lockSettings.recoveryNew')}</button>
          </div>
          {shownCode && (
            <div className="ml-[124px] rounded-md border border-amber-400/30 bg-amber-400/[0.06] p-3 space-y-2">
              <div className="flex items-center gap-3">
                <code className="font-mono text-base tracking-wider text-zinc-100 select-all">{shownCode}</code>
                <div className="flex-1" />
                <button className="text-xs text-zinc-400 hover:text-white" onClick={() => void navigator.clipboard.writeText(shownCode)}>{t('common.copy')}</button>
                <button className="text-xs rounded-full bg-fill-2 hover:bg-fill-3 transition-colors px-2.5 py-1 text-zinc-200" onClick={() => setShownCode(null)}>{t('lockSettings.recoveryDone')}</button>
              </div>
              <div className="text-xs text-amber-200/80 leading-relaxed">{t('lockSettings.recoveryShow')}</div>
            </div>
          )}
        </div>
      )}
      <div className="text-xs text-zinc-500 leading-relaxed">{t('lockSettings.failsafe')}</div>

      {settings && (
        <>
          <div className="space-y-2">
            <div className="flex items-center gap-3 text-sm">
              <span className="w-28 text-zinc-400">{t('lockSettings.displays')}</span>
              <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                <input type="checkbox" checked={settings.mainDisplay === null} onChange={(e) => patch({ mainDisplay: e.target.checked ? null : (displays.find((d) => d.main)?.key ?? null) })} />
                {t('lockSettings.auto')}
              </label>
            </div>
            <DisplayMap displays={displays} onPick={(key) => patch({ mainDisplay: key })} />
            <div className="text-xs text-zinc-500">{t('lockSettings.displaysNote')}</div>
          </div>
        </>
      )}
    </div>
  );
}
