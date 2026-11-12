import { useContext, useMemo } from 'react';
import { COMMON_ZONES, formatDuration, isoInZone, parseDuration, parseTime, relativeTime } from '../../lib/toolbox/time';
import { getLang, t } from '../../lib/i18n';
import { useClock } from '../../lib/clock';
import { ViewActiveContext } from '../../lib/viewActive';
import { Rows, Section, btn, errText, input, usePersisted } from './ui';

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export default function TimeTool() {
  const [text, setText] = usePersisted('time.input', '');
  const [zone, setZone] = usePersisted('time.zone', '');
  // Ticks only while the Tools view is on screen (it stays mounted behind other views).
  const now = useClock(useContext(ViewActiveContext));
  const locale = getLang() === 'ko' ? 'ko' : 'en';
  const parsed = useMemo(() => { if (!text.trim()) return null; try { return { ok: true as const, ...parseTime(text) }; } catch (e) { return { ok: false as const, msg: errText(e) }; } }, [text]);
  const ms = parsed?.ok ? parsed.ms : null;
  const unit = parsed?.ok ? parsed.unit : 'natural';
  const d = ms !== null ? new Date(ms) : null;
  const zoneOk = useMemo(() => { if (!zone.trim()) return false; try { Intl.DateTimeFormat('en', { timeZone: zone.trim() }); return true; } catch { return false; } }, [zone]);
  const zones = [LOCAL_ZONE, ...COMMON_ZONES.filter((z) => z !== LOCAL_ZONE), ...(zoneOk && !COMMON_ZONES.includes(zone.trim()) && zone.trim() !== LOCAL_ZONE ? [zone.trim()] : [])];

  return (
    <div className="h-full flex flex-col gap-4 min-h-0 overflow-y-auto pr-1">
      <Section title={t('tb.time.now')}>
        <Rows rows={[
          { label: 'Unix (s)', value: String(Math.floor(now / 1000)) },
          { label: 'Unix (ms)', value: String(now) },
          { label: 'ISO (UTC)', value: new Date(now).toISOString() },
          { label: `ISO (${LOCAL_ZONE})`, value: isoInZone(now, LOCAL_ZONE) },
        ]} />
      </Section>
      <Section title={t('tb.time.convert')}>
        <div className="flex items-center gap-3">
          <input className={`${input} flex-1`} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('tb.time.placeholder')} autoFocus spellCheck={false} />
          <button className={btn} onClick={() => setText(String(Math.floor(Date.now() / 1000)))}>{t('tb.time.nowBtn')}</button>
          {text && <button className={btn} onClick={() => setText('')}>{t('tb.clear')}</button>}
        </div>
        {parsed && !parsed.ok && <div className="text-[11px] text-red-400">{parsed.msg}</div>}
        {d && ms !== null && <>
          <div className="text-[11px] text-zinc-500">{t('tb.time.detected', { unit: t(`tb.time.unit.${unit}`) })} · {relativeTime(ms, now, locale)}</div>
          <Rows rows={[
            { label: 'Unix (s)', value: String(Math.floor(ms / 1000)) },
            { label: 'Unix (ms)', value: String(Math.round(ms)) },
            { label: 'ISO (UTC)', value: d.toISOString() },
            { label: t('tb.time.local'), value: d.toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { dateStyle: 'full', timeStyle: 'long' }) },
            { label: 'RFC 2822', value: d.toUTCString() },
            { label: t('tb.time.dayOfYear'), value: String(Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1), hint: `${t('tb.time.week')} ${isoWeek(d)}` },
          ]} />
          <div className="flex items-center gap-2 text-[11px] text-zinc-500">
            <span>{t('tb.time.zones')}</span>
            <input className={`${input} w-56 py-0.5 ${zone && !zoneOk ? 'border-red-500/50' : ''}`} value={zone} onChange={(e) => setZone(e.target.value)} placeholder="Europe/Madrid" spellCheck={false} />
          </div>
          <Rows rows={zones.map((z) => ({ label: z === LOCAL_ZONE ? `${z} ★` : z, value: isoInZone(ms, z), hint: d.toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { timeZone: z, weekday: 'short', hour: 'numeric', minute: '2-digit' }) }))} />
        </>}
      </Section>
      <Duration now={now} />
    </div>
  );
}

function isoWeek(d: Date): number {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const start = Date.UTC(x.getUTCFullYear(), 0, 1);
  return Math.ceil(((x.getTime() - start) / 864e5 + 1) / 7);
}

function Duration({ now }: { now: number }) {
  const [a, setA] = usePersisted('time.a', '');
  const [b, setB] = usePersisted('time.b', '');
  const [dur, setDur] = usePersisted('time.dur', '');
  const diff = useMemo(() => {
    try {
      const x = parseTime(a, now).ms, y = parseTime(b, now).ms;
      return { ok: true as const, ms: y - x, days: (y - x) / 864e5 };
    } catch (e) { return { ok: false as const, msg: errText(e) }; }
  }, [a, b, now]);
  const parsedDur = useMemo(() => {
    const s = dur.trim();
    if (!s) return null;
    try {
      const ms = /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : /^P/i.test(s) ? parseDuration(s) : parseHuman(s);
      return { ok: true as const, ms };
    } catch (e) { return { ok: false as const, msg: errText(e) }; }
  }, [dur]);
  return (
    <Section title={t('tb.time.duration')}>
      <div className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-x-3 gap-y-2 text-[11px] text-zinc-500">
        <span>{t('tb.time.from')}</span><input className={input} value={a} onChange={(e) => setA(e.target.value)} placeholder="now" spellCheck={false} />
        <span>{t('tb.time.to')}</span><input className={input} value={b} onChange={(e) => setB(e.target.value)} placeholder="2030-01-01" spellCheck={false} />
      </div>
      {(a || b) && (diff.ok
        ? <Rows rows={[{ label: t('tb.time.difference'), value: formatDuration(diff.ms), hint: `${Number(diff.days.toFixed(2))} ${t('tb.time.days')} · ${Math.round(diff.ms / 1000).toLocaleString()} s` }]} />
        : <div className="text-[11px] text-red-400">{diff.msg}</div>)}
      <div className="flex items-center gap-3 text-[11px] text-zinc-500">
        <span>{t('tb.time.parseDuration')}</span>
        <input className={`${input} flex-1`} value={dur} onChange={(e) => setDur(e.target.value)} placeholder="P1DT2H30M · 90000 · 1h 30m" spellCheck={false} />
      </div>
      {parsedDur && (parsedDur.ok
        ? <Rows rows={[
          { label: t('tb.time.formatted'), value: formatDuration(parsedDur.ms) },
          { label: 'ms', value: String(parsedDur.ms) },
          { label: 's', value: String(parsedDur.ms / 1000) },
          { label: 'min', value: String(Number((parsedDur.ms / 6e4).toFixed(4))) },
          { label: 'h', value: String(Number((parsedDur.ms / 36e5).toFixed(4))) },
        ]} />
        : <div className="text-[11px] text-red-400">{parsedDur.msg}</div>)}
    </Section>
  );
}

/** "1h 30m 15s", "2d", "45min" style. */
function parseHuman(s: string): number {
  const re = /(\d+(?:\.\d+)?)\s*(ms|d|h|m|s|min|sec|hr|day|days|hours?|minutes?|seconds?)\b/gi;
  let total = 0, any = false, m: RegExpExecArray | null;
  const size: Record<string, number> = { ms: 1, s: 1e3, sec: 1e3, second: 1e3, seconds: 1e3, m: 6e4, min: 6e4, minute: 6e4, minutes: 6e4, h: 36e5, hr: 36e5, hour: 36e5, hours: 36e5, d: 864e5, day: 864e5, days: 864e5 };
  while ((m = re.exec(s))) { any = true; total += Number(m[1]) * (size[m[2].toLowerCase()] ?? 0); }
  if (!any) throw new Error('Not a duration');
  return total;
}
