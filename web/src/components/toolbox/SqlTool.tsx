import { useDeferredValue, useMemo } from 'react';
import type { KeywordCase, SqlLanguage } from 'sql-formatter';
import { formatSql, minifySql, SQL_DIALECTS } from '../../lib/toolbox/sql';
import { t } from '../../lib/i18n';
import { Area, Code, Seg, btn, errText, select, usePersisted } from './ui';

const SAMPLE = "select u.id, u.name, count(o.id) as orders from users u left join orders o on o.user_id = u.id where u.created_at >= '2026-01-01' and u.status in ('active','trial') group by u.id, u.name having count(o.id) > 3 order by orders desc limit 20;";

export default function SqlTool() {
  const [text, setText] = usePersisted('sql.text', '');
  const [dialect, setDialect] = usePersisted<SqlLanguage>('sql.dialect', 'sql');
  const [kc, setKc] = usePersisted<KeywordCase>('sql.case', 'upper');
  const [indent, setIndent] = usePersisted('sql.indent', 2);
  const [mode, setMode] = usePersisted<'format' | 'minify'>('sql.mode', 'format');
  // Large inputs: typing stays responsive, formatting and highlighting follow a moment later.
  const deferred = useDeferredValue(text);
  const res = useMemo(() => {
    if (!deferred.trim()) return { out: '', err: null as string | null };
    try { return { out: mode === 'minify' ? minifySql(deferred) : formatSql(deferred, { dialect, keywordCase: kc, indent, linesBetween: 1 }), err: null }; }
    catch (e) { return { out: '', err: errText(e) }; }
  }, [deferred, dialect, kc, indent, mode]);
  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-500">
        <Seg value={mode} onChange={setMode} options={[{ value: 'format', label: t('tb.sql.format') }, { value: 'minify', label: t('tb.sql.minify') }]} />
        {mode === 'format' && <>
          <select className={select} value={dialect} onChange={(e) => setDialect(e.target.value as SqlLanguage)}>
            {SQL_DIALECTS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <Seg value={kc} onChange={setKc} options={[{ value: 'upper', label: 'SELECT' }, { value: 'lower', label: 'select' }, { value: 'preserve', label: t('tb.sql.preserve') }]} />
          <Seg value={String(indent)} onChange={(v) => setIndent(Number(v))} options={[{ value: '2', label: '2' }, { value: '4', label: '4' }]} />
        </>}
      </div>
      <div className="flex-1 grid grid-cols-2 gap-4 min-h-0">
        <Area label={t('tb.input')} value={text} onChange={setText} autoFocus placeholder="SELECT …"
          actions={<>
            {!text && <button className={btn} onClick={() => setText(SAMPLE)}>{t('tb.sample')}</button>}
            {text && <button className={btn} onClick={() => setText('')}>{t('tb.clear')}</button>}
          </>} />
        <Code label={t('tb.output')} code={res.out} lang="sql" error={res.err}
          actions={res.out ? <button className={btn} onClick={() => setText(res.out)}>{t('tb.useAsInputLeft')}</button> : null} />
      </div>
    </div>
  );
}
