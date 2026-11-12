import { useDeferredValue, useMemo } from 'react';
import { REGEX_FLAGS, REGEX_PRESETS, replaceRegex, runRegex, splitLiteral, type RegexMatch } from '../../lib/toolbox/regex';
import { getLang, t } from '../../lib/i18n';
import { Area, CopyButton, btn, errText, input, mono, select, usePersisted } from './ui';

const FLAG_HINT: Record<string, string> = { g: 'global', i: 'ignore case', m: 'multiline', s: 'dotAll', u: 'unicode', y: 'sticky', d: 'indices' };
const SAMPLE = 'Contact: ada@example.com, grace@hopper.org\nSigned 2024-03-15, renewed 2025-01-02.\nhttps://example.com/docs?x=1';

export default function RegexTool() {
  const [patternInput, setPattern] = usePersisted('regex.pattern', '');
  const [flags, setFlags] = usePersisted('regex.flags', 'g');
  const [textInput, setText] = usePersisted('regex.text', '');
  const [replInput, setRepl] = usePersisted('regex.repl', '');
  // Matching runs over the whole test text: typing stays responsive, the results follow a moment later.
  const pattern = useDeferredValue(patternInput), text = useDeferredValue(textInput), repl = useDeferredValue(replInput);

  const result = useMemo(() => {
    if (!pattern) return { matches: [] as RegexMatch[], error: null as string | null };
    try { return { matches: runRegex(pattern, flags, text), error: null }; } catch (e) { return { matches: [], error: errText(e) }; }
  }, [pattern, flags, text]);
  const replaced = useMemo(() => { if (!pattern || result.error) return ''; try { return replaceRegex(pattern, flags, text, repl); } catch { return ''; } }, [pattern, flags, text, repl, result.error]);
  const onPattern = (v: string) => { const lit = splitLiteral(v); if (lit) { setPattern(lit.source); setFlags(lit.flags || 'g'); } else setPattern(v); };
  const toggle = (f: string) => setFlags((cur) => (cur.includes(f) ? cur.replace(f, '') : cur + f));

  const segments = useMemo(() => {
    const out: { text: string; hit?: number }[] = [];
    let pos = 0;
    result.matches.forEach((m, i) => {
      if (m.index > pos) out.push({ text: text.slice(pos, m.index) });
      out.push({ text: text.slice(m.index, m.end), hit: i });
      pos = m.end;
    });
    if (pos < text.length) out.push({ text: text.slice(pos) });
    return out;
  }, [result.matches, text]);
  // Kept between keystrokes until the (deferred) results change.
  const highlighted = useMemo(() => segments.map((s, i) => s.hit === undefined ? s.text : <mark key={i} className={`rounded-sm text-white ${s.hit % 2 ? 'bg-sky-500/40' : 'bg-amber-500/40'}`}>{s.text}</mark>), [segments]);
  const lang = getLang();
  const matchRows = useMemo(() => result.matches.slice(0, 500).map((m, i) => (
    <div key={i} className="flex items-start gap-2 px-2.5 py-1 border-b border-white/5 last:border-0">
      <span className="w-8 shrink-0 text-zinc-600 tabular-nums">{i + 1}</span>
      <span className="w-16 shrink-0 text-zinc-500 tabular-nums">{m.index}–{m.end}</span>
      <div className="flex-1 min-w-0">
        <div className="text-zinc-200 break-all">{m.text || <span className="text-zinc-600">{t('tb.regex.emptyMatch')}</span>}</div>
        {m.groups.map((g, j) => (
          <div key={j} className="text-zinc-500 break-all"><span className="text-purple-300">{g.name ? `<${g.name}>` : `$${j + 1}`}</span> {g.value === undefined ? <span className="text-zinc-600">undefined</span> : <span className="text-zinc-300">{g.value}</span>}</div>
        ))}
      </div>
    </div>
  )), [result.matches, lang]); // eslint-disable-line react-hooks/exhaustive-deps -- lang: the labels are translated

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      <div className="flex items-center gap-3">
        <span className="text-zinc-500 font-mono">/</span>
        <input className={`${input} flex-1 ${result.error ? 'border-red-500/50' : ''}`} value={patternInput} onChange={(e) => onPattern(e.target.value)} placeholder={t('tb.regex.placeholder')} autoFocus spellCheck={false} />
        <span className="text-zinc-500 font-mono">/{flags}</span>
        <div className="flex items-center gap-0.5">
          {REGEX_FLAGS.filter((f) => f !== 'd').map((f) => (
            <button key={f} title={FLAG_HINT[f]} onClick={() => toggle(f)} className={`w-6 h-6 rounded-full font-mono text-[11px] ${flags.includes(f) ? 'bg-blue-500/30 text-blue-200' : 'text-zinc-500 hover:bg-white/10'} transition-colors`}>{f}</button>
          ))}
        </div>
        <select className={select} value="" onChange={(e) => { const p = REGEX_PRESETS[Number(e.target.value)]; if (p) { setPattern(p.source); setFlags(p.flags); if (!textInput) setText(SAMPLE); } }}>
          <option value="">{t('tb.regex.presets')}</option>
          {REGEX_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
        </select>
      </div>
      {result.error && <div className="text-[11px] text-red-400">{result.error}</div>}
      <div className="flex-1 min-h-0 grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-3 min-h-0">
          <Area className="flex-1" label={t('tb.regex.testText')} value={textInput} onChange={setText} actions={!textInput ? <button className={btn} onClick={() => setText(SAMPLE)}>{t('tb.sample')}</button> : null} />
          <div className="flex flex-col min-h-0 flex-1">
            <div className="h-7 shrink-0 mb-1 flex items-center gap-3 text-[11px] text-zinc-500">
              <span>{t('tb.regex.replace')}</span>
              <input className={`${input} flex-1 py-0.5`} value={replInput} onChange={(e) => setRepl(e.target.value)} placeholder="$1 · $<name> · $&" spellCheck={false} />
              <CopyButton text={replaced} />
            </div>
            <pre className={`flex-1 min-h-[60px] overflow-auto rounded-md border border-white/10 bg-white/[.03] px-2.5 py-2 ${mono} whitespace-pre-wrap break-all text-zinc-300`}>{replaced}</pre>
          </div>
        </div>
        <div className="flex flex-col gap-3 min-h-0">
          <div className="flex flex-col min-h-0 flex-1">
            <div className="h-7 shrink-0 flex items-center text-[11px] text-zinc-500">{t('tb.regex.matches', { n: result.matches.length })}</div>
            <pre className={`flex-1 overflow-auto rounded-md border border-white/10 bg-white/[.03] px-2.5 py-2 ${mono} whitespace-pre-wrap break-all text-zinc-400`}>
              {highlighted}
            </pre>
          </div>
          <div className={`flex-1 min-h-[60px] overflow-auto rounded-md border border-white/10 ${mono} text-[11.5px]`}>
            {matchRows}
            {result.matches.length > 500 && <div className="px-2.5 py-1 text-zinc-500">… {t('tb.json.more', { n: result.matches.length - 500 })}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
