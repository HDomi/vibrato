import { useDeferredValue, useMemo } from 'react';
import { convertData, type DataFormat } from '../../lib/toolbox/formats';
import { t } from '../../lib/i18n';
import { Area, Code, Seg, btn, errText, select, usePersisted } from './ui';

const LABEL: Record<DataFormat, string> = { json: 'JSON', yaml: 'YAML', toml: 'TOML' };
const SAMPLE = `# app config
name: vibrato
server:
  host: 127.0.0.1
  port: 11398
features: [tools, ide]
`;

export default function FormatsTool() {
  const [text, setText] = usePersisted('formats.text', '');
  const [from, setFrom] = usePersisted<DataFormat | 'auto'>('formats.from', 'auto');
  const [to, setTo] = usePersisted<DataFormat>('formats.to', 'json');
  const [indent, setIndent] = usePersisted('formats.indent', 2);
  // Large inputs: typing stays responsive, the conversion and its highlighting follow a moment later.
  const deferred = useDeferredValue(text);
  const res = useMemo(() => {
    if (!deferred.trim()) return null;
    try { return { ok: true as const, ...convertData(deferred, from, to, indent) }; } catch (e) { return { ok: false as const, msg: errText(e) }; }
  }, [deferred, from, to, indent]);
  return (
    <div className="h-full grid grid-cols-2 gap-4 min-h-0">
      <Area label={<span className="flex items-center gap-2">{t('tb.input')}
        <select className={select} value={from} onChange={(e) => setFrom(e.target.value as DataFormat | 'auto')}>
          <option value="auto">{t('tb.formats.auto')}{res?.ok && from === 'auto' ? ` · ${LABEL[res.from]}` : ''}</option>
          {(['json', 'yaml', 'toml'] as const).map((f) => <option key={f} value={f}>{LABEL[f]}</option>)}
        </select></span>}
        value={text} onChange={setText} autoFocus placeholder={t('tb.formats.placeholder')}
        actions={<>
          {!text && <button className={btn} onClick={() => setText(SAMPLE)}>{t('tb.sample')}</button>}
          {text && <button className={btn} onClick={() => setText('')}>{t('tb.clear')}</button>}
        </>} />
      <Code code={res?.ok ? res.output : ''} lang={to === 'toml' ? 'ini' : to} error={res && !res.ok ? res.msg : null}
        label={<span className="flex items-center gap-3">
          <Seg value={to} onChange={setTo} options={(['json', 'yaml', 'toml'] as const).map((f) => ({ value: f, label: LABEL[f] }))} />
          {to !== 'toml' && <Seg value={String(indent)} onChange={(v) => setIndent(Number(v))} options={[{ value: '2', label: '2' }, { value: '4', label: '4' }]} />}
        </span>}
        actions={res?.ok ? <button className={btn} onClick={() => { setText(res.output); setFrom(to); }}>{t('tb.useAsInputLeft')}</button> : null} />
    </div>
  );
}
