import { useEffect, useMemo, useState } from 'react';
import { CRON_FIELD_NAMES, CRON_PRESETS, describeCron, fieldSummary, nextRuns, parseCron } from '../../lib/toolbox/cron';
import { getLang, t } from '../../lib/i18n';
import { relativeTime } from '../../lib/toolbox/time';
import { CopyButton, Section, Seg, btn, errText, input, mono, usePersisted } from './ui';

export default function CronTool() {
  const [expr, setExpr] = usePersisted('cron.expr', '*/15 9-18 * * 1-5');
  const [zone, setZone] = usePersisted<'local' | 'utc'>('cron.zone', 'local');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(id); }, []);
  const ko = getLang() === 'ko';
  const parsed = useMemo(() => { try { return { ok: true as const, s: parseCron(expr) }; } catch (e) { return { ok: false as const, msg: errText(e) }; } }, [expr]);
  const desc = useMemo(() => (parsed.ok ? describeCron(parsed.s, ko ? 'ko' : 'en') : ''), [parsed, ko]);
  const runs = useMemo(() => (parsed.ok ? nextRuns(parsed.s, 10, now, zone === 'utc') : []), [parsed, now, zone]);
  const fmt = (d: Date) => zone === 'utc'
    ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : d.toLocaleString(ko ? 'ko-KR' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = expr.trim().split(/\s+/);

  return (
    <div className="h-full flex flex-col gap-5 min-h-0 overflow-y-auto pr-1">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <input className={`${input} flex-1 text-[16px] py-2 tracking-wider ${!parsed.ok ? 'border-red-500/50' : ''}`} value={expr} onChange={(e) => setExpr(e.target.value)} spellCheck={false} autoFocus />
          <CopyButton text={expr} />
        </div>
        {parsed.ok && parts.length === 5 && (
          <div className="grid grid-cols-5 gap-3 text-center">
            {CRON_FIELD_NAMES.map((n, i) => (
              <div key={n} className="rounded-md border border-white/10 px-2 py-1.5">
                <div className={`${mono} text-zinc-200`}>{parts[i]}</div>
                <div className="text-[10.5px] text-zinc-500">{t(`tb.cron.field.${i}`)}</div>
                <div className="text-[10.5px] text-zinc-400 truncate" title={fieldSummary([parsed.s.minute, parsed.s.hour, parsed.s.dom, parsed.s.month, parsed.s.dow][i], i)}>
                  {fieldSummary([parsed.s.minute, parsed.s.hour, parsed.s.dom, parsed.s.month, parsed.s.dow][i], i)}
                </div>
              </div>
            ))}
          </div>
        )}
        {parsed.ok ? <div className="text-[14px] text-emerald-300">{desc}</div> : <div className="text-[12px] text-red-400">{parsed.msg}</div>}
        <div className="flex flex-wrap gap-2">
          {CRON_PRESETS.map((p) => <button key={p.expr} className={btn} onClick={() => setExpr(p.expr)} title={p.expr}>{t(`tb.cron.preset.${p.key}`)}</button>)}
        </div>
      </div>
      {parsed.ok && (
        <Section title={t('tb.cron.next')} actions={<Seg value={zone} onChange={setZone} options={[{ value: 'local', label: t('tb.cron.local') }, { value: 'utc', label: 'UTC' }]} />}>
          <div className="rounded-md border border-white/10 divide-y divide-white/5">
            {runs.map((d, i) => (
              <div key={i} className="flex items-center gap-3 px-2.5 py-1.5 text-[12px]">
                <span className="w-6 text-zinc-600 tabular-nums">{i + 1}</span>
                <span className={`flex-1 ${mono} text-zinc-200`}>{fmt(d)}</span>
                <span className="text-[11px] text-zinc-500">{relativeTime(d.getTime(), now, ko ? 'ko' : 'en')}</span>
              </div>
            ))}
            {!runs.length && <div className="px-2.5 py-1.5 text-[12px] text-zinc-500">{t('tb.cron.never')}</div>}
          </div>
          <div className="text-[11px] text-zinc-500 leading-relaxed">{t('tb.cron.note')}</div>
        </Section>
      )}
      <Section title={t('tb.cron.syntax')}>
        <div className={`rounded-md border border-white/10 px-3 py-2 ${mono} text-[12px] text-zinc-400 whitespace-pre`}>{`┌───────────── ${t('tb.cron.field.0')} (0-59)
│ ┌─────────── ${t('tb.cron.field.1')} (0-23)
│ │ ┌───────── ${t('tb.cron.field.2')} (1-31)
│ │ │ ┌─────── ${t('tb.cron.field.3')} (1-12, JAN-DEC)
│ │ │ │ ┌───── ${t('tb.cron.field.4')} (0-7, SUN-SAT, 0·7 = ${t('tb.cron.sunday')})
* * * * *

*  ${t('tb.cron.any')}    ,  ${t('tb.cron.list')}    -  ${t('tb.cron.range')}    /  ${t('tb.cron.step')}
@yearly @monthly @weekly @daily @hourly`}</div>
      </Section>
    </div>
  );
}
