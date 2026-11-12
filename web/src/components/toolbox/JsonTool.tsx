import { memo, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { countNodes, errorPosition, jsAccessor, jsonPath, parseLenient, searchJson, sortKeys, toTypeScript, type JsonValue } from '../../lib/toolbox/json';
import { getLang, t } from '../../lib/i18n';
import { Area, CopyButton, Seg, btn, errText, input, mono, usePersisted } from './ui';
import { takePayload } from './bus';

interface Ctx { lang: string; gen: number; forceOpen: boolean; openKeys: Set<string>; matchKeys: Set<string>; copyPath: (p: (string | number)[], js: boolean) => void; copyValue: (v: JsonValue) => void }

const ROOT: (string | number)[] = [];

const SAMPLE = '{"user":{"id":42,"name":"Ada","tags":["admin","ops"],"active":true,"lastLogin":null},"items":[{"sku":"A-1","qty":2},{"sku":"B-7","qty":0}]}';

export default function JsonTool() {
  const [text, setText] = usePersisted('json.text', '');
  // Another tool (HTTP response) can hand a body over.
  useEffect(() => { const p = takePayload<{ text: string }>('json'); if (p) setText(p.text); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [view, setView] = usePersisted<'tree' | 'text' | 'ts'>('json.view', 'tree');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [reset, setReset] = useState({ gen: 0, open: true });

  // Large documents: typing stays responsive, the parse and the tree follow a moment later.
  const deferredText = useDeferredValue(text);
  const parsed = useMemo(() => {
    if (!deferredText.trim()) return null;
    try { return { ok: true as const, ...parseLenient(deferredText) }; }
    catch (e) { const msg = errText(e); return { ok: false as const, msg, pos: errorPosition(msg, deferredText) }; }
  }, [deferredText]);
  const value = parsed?.ok ? parsed.value : undefined;
  const matches = useMemo(() => (value !== undefined && query ? searchJson(value, query) : []), [value, query]);
  const matchKeys = useMemo(() => new Set(matches.map((p) => jsonPath(p))), [matches]);
  const openKeys = useMemo(() => {
    const s = new Set<string>();
    for (const p of matches) for (let i = 0; i < p.length; i++) s.add(jsonPath(p.slice(0, i)));
    return s;
  }, [matches]);
  const nodes = useMemo(() => (value === undefined ? 0 : countNodes(value)), [value]);
  // Only the text view shows (and copies) it; the tree does not need it.
  const pretty = useMemo(() => (value === undefined || view !== 'text' ? '' : JSON.stringify(value, null, 2)), [value, view]);
  const ts = useMemo(() => { if (value === undefined || view !== 'ts') return ''; try { return toTypeScript(value); } catch (e) { return errText(e); } }, [value, view]);
  useEffect(() => { if (!status) return; const id = setTimeout(() => setStatus(''), 2000); return () => clearTimeout(id); }, [status]);

  // Stable between keystrokes so the memoized tree re-renders only when the document, search or expand state changes.
  const lang = getLang();
  const ctx = useMemo<Ctx>(() => ({
    lang, gen: reset.gen, forceOpen: reset.open, openKeys, matchKeys,
    copyPath: (p, js) => { const s = js ? jsAccessor(p) : jsonPath(p); navigator.clipboard.writeText(s).catch(() => {}); setStatus(t('tb.copiedX', { x: s })); },
    copyValue: (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); navigator.clipboard.writeText(s).catch(() => {}); setStatus(t('tb.copiedX', { x: s.length > 60 ? s.slice(0, 60) + '…' : s })); },
  }), [lang, reset, openKeys, matchKeys]);
  const error = parsed && !parsed.ok ? (parsed.pos ? `${parsed.msg}\n${t('tb.json.at', { line: parsed.pos.line, col: parsed.pos.col })}` : parsed.msg) : null;

  return (
    <div className="h-full flex min-h-0 gap-4">
      <Area className="w-[42%] shrink-0" label={t('tb.input')} value={text} onChange={setText} placeholder={t('tb.json.placeholder')} error={error} autoFocus
        actions={<>
          <button className={btn} disabled={value === undefined} onClick={() => setText(JSON.stringify(value, null, 2))}>{t('tb.json.format')}</button>
          <button className={btn} disabled={value === undefined} onClick={() => setText(JSON.stringify(value))}>{t('tb.json.minify')}</button>
          <button className={btn} disabled={value === undefined} onClick={() => setText(JSON.stringify(sortKeys(value as JsonValue), null, 2))}>{t('tb.json.sortKeys')}</button>
          {!text && <button className={btn} onClick={() => setText(SAMPLE)}>{t('tb.sample')}</button>}
          {text && <button className={btn} onClick={() => setText('')}>{t('tb.clear')}</button>}
        </>} />
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="h-7 shrink-0 mb-1 flex items-center gap-2 text-[11px] text-zinc-500">
          <Seg value={view} onChange={setView} options={[{ value: 'tree', label: t('tb.json.tree') }, { value: 'text', label: t('tb.json.text') }, { value: 'ts', label: 'TypeScript' }]} />
          {view === 'tree' && <>
            <button className={btn} onClick={() => setReset((r) => ({ gen: r.gen + 1, open: true }))}>{t('tb.json.expandAll')}</button>
            <button className={btn} onClick={() => setReset((r) => ({ gen: r.gen + 1, open: false }))}>{t('tb.json.collapseAll')}</button>
            <input className={`${input} flex-1 py-0.5`} placeholder={t('tb.json.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
            {query && <span className="shrink-0 tabular-nums">{t('tb.json.matches', { n: matches.length })}</span>}
          </>}
          <div className="flex-1" />
          {parsed?.ok && <span className="shrink-0 tabular-nums">{t('tb.json.nodes', { n: nodes })}{parsed.relaxed && <span className="text-amber-400"> · {t('tb.json.relaxed')}</span>}</span>}
          {view !== 'tree' && <CopyButton text={view === 'ts' ? ts : pretty} />}
        </div>
        <div className={`flex-1 min-h-0 overflow-auto rounded-md border border-white/10 bg-white/[.03] px-3 py-2 ${mono}`}>
          {value === undefined
            ? <div className="text-zinc-600">{deferredText.trim() ? t('tb.json.invalid') : t('tb.json.empty')}</div>
            : view === 'tree' ? <Node v={value} path={ROOT} depth={0} ctx={ctx} />
            : <pre className="whitespace-pre text-zinc-200">{view === 'ts' ? ts : pretty}</pre>}
        </div>
        <div className="h-5 shrink-0 text-[11px] text-zinc-500 truncate pt-1">{status || (view === 'tree' && value !== undefined ? t('tb.json.hint') : '')}</div>
      </div>
    </div>
  );
}

/** Memoized: parsed values and child paths keep their identity, so only the changed parts of the tree re-render. */
const Node = memo(function Node({ k, v, path, depth, ctx }: { k?: string | number; v: JsonValue; path: (string | number)[]; depth: number; ctx: Ctx }) {
  const isObj = v !== null && typeof v === 'object';
  const arr = Array.isArray(v);
  const entries = useMemo((): [string | number, JsonValue][] => (v !== null && typeof v === 'object' ? (Array.isArray(v) ? v.map((x, i): [number, JsonValue] => [i, x]) : Object.entries(v)) : []), [v]);
  const childPaths = useMemo(() => entries.map(([ck]) => [...path, ck]), [entries, path]);
  const p = useMemo(() => jsonPath(path), [path]);
  const [open, setOpen] = useState(depth < 2);
  const [limit, setLimit] = useState(200);
  useEffect(() => { if (ctx.gen) setOpen(ctx.forceOpen); }, [ctx.gen, ctx.forceOpen]);
  useEffect(() => { if (ctx.openKeys.has(p)) setOpen(true); }, [ctx.openKeys, p]);
  const hit = ctx.matchKeys.has(p);
  const bracket = arr ? ['[', ']'] : ['{', '}'];
  return (
    <div>
      <div className={`flex items-start gap-1 leading-5 rounded px-1 -mx-1 hover:bg-white/5 ${hit ? 'bg-amber-400/15' : ''}`} style={{ paddingLeft: depth * 14 + 4 }}>
        {isObj ? <button onClick={() => setOpen((o) => !o)} className="w-3.5 shrink-0 text-zinc-500 hover:text-zinc-300 text-left">{open ? '▾' : '▸'}</button> : <span className="w-3.5 shrink-0" />}
        {k !== undefined && <>
          <span className="text-sky-300 cursor-pointer hover:underline shrink-0" title={`${p}\n${t('tb.json.pathHint')}`} onClick={(e) => ctx.copyPath(path, e.altKey)}>{typeof k === 'number' ? k : JSON.stringify(k)}</span>
          <span className="text-zinc-600 shrink-0">:</span>
        </>}
        {isObj
          ? <span className="text-zinc-500 cursor-pointer" onClick={() => setOpen((o) => !o)}>{open ? bracket[0] : `${bracket[0]} ${t(arr ? 'tb.json.items' : 'tb.json.keys', { n: entries.length })} ${bracket[1]}`}</span>
          : <Leaf v={v} onClick={() => ctx.copyValue(v)} />}
      </div>
      {isObj && open && entries.slice(0, limit).map(([ck, cv], i) => <Node key={ck} k={ck} v={cv} path={childPaths[i]} depth={depth + 1} ctx={ctx} />)}
      {isObj && open && entries.length > limit && (
        <button className="text-zinc-500 hover:text-zinc-300 leading-5" style={{ paddingLeft: (depth + 1) * 14 + 22 }} onClick={() => setLimit((l) => l * 4)}>… {t('tb.json.more', { n: entries.length - limit })}</button>
      )}
      {isObj && open && <div className="text-zinc-500 leading-5" style={{ paddingLeft: depth * 14 + 22 }}>{bracket[1]}</div>}
    </div>
  );
});

function Leaf({ v, onClick }: { v: JsonValue; onClick: () => void }) {
  const cls = v === null ? 'text-zinc-500' : typeof v === 'string' ? 'text-emerald-300' : typeof v === 'number' ? 'text-amber-300' : 'text-purple-300';
  const text = typeof v === 'string' ? JSON.stringify(v.length > 300 ? v.slice(0, 300) + '…' : v) : String(v);
  return <span className={`${cls} cursor-pointer break-all whitespace-pre-wrap`} title={t('tb.json.valueHint')} onClick={onClick}>{text}</span>;
}
