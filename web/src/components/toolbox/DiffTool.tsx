import { useDeferredValue, useMemo } from 'react';
import { diffLines, diffStats, unifiedDiff } from '../../lib/toolbox/diff';
import { t } from '../../lib/i18n';
import { Area, Check, CopyButton, Seg, btn, mono, usePersisted } from './ui';

const MAX_RENDER = 5000;

export default function DiffTool() {
  const [a, setA] = usePersisted('diff.a', '');
  const [b, setB] = usePersisted('diff.b', '');
  const [ws, setWs] = usePersisted('diff.ws', false);
  const [ci, setCi] = usePersisted('diff.ci', false);
  const [mode, setMode] = usePersisted<'inline' | 'side'>('diff.mode', 'inline');
  const [onlyChanges, setOnly] = usePersisted('diff.onlyChanges', false);
  // Typing stays responsive: the diff (and its up to MAX_RENDER rows) follows a moment later.
  const da = useDeferredValue(a), db = useDeferredValue(b);
  const ops = useMemo(() => (da || db ? diffLines(da, db, { ignoreWhitespace: ws, ignoreCase: ci }) : []), [da, db, ws, ci]);
  const stats = useMemo(() => diffStats(ops), [ops]);
  const unified = useMemo(() => (ops.length ? unifiedDiff(ops) : ''), [ops]);
  const shown = useMemo(() => {
    if (!onlyChanges) return ops.slice(0, MAX_RENDER);
    // Changed lines with two lines of context on each side, in one pass.
    const keep = new Uint8Array(ops.length);
    ops.forEach((o, i) => { if (o.type !== 'equal') for (let j = Math.max(0, i - 2); j <= Math.min(ops.length - 1, i + 2); j++) keep[j] = 1; });
    return ops.filter((_, i) => keep[i]).slice(0, MAX_RENDER);
  }, [ops, onlyChanges]);
  const rows = useMemo(() => (mode === 'side' ? pairUp(shown) : null), [mode, shown]);
  // The rendered rows, kept between keystrokes until the (deferred) diff changes.
  const body = useMemo(() => (
    rows ? rows.map((r, i) => (
      <div key={i} className="grid grid-cols-2 border-b border-white/5 last:border-0">
        <Cell n={r.l?.a} text={r.l?.line} kind={r.l ? (r.l.type === 'delete' ? 'del' : 'eq') : 'none'} />
        <Cell n={r.r?.b} text={r.r?.line} kind={r.r ? (r.r.type === 'insert' ? 'ins' : 'eq') : 'none'} className="border-l border-white/10" />
      </div>
    )) : shown.map((o, i) => (
      <div key={i} className={`flex leading-5 ${o.type === 'insert' ? 'bg-emerald-500/15 text-emerald-200' : o.type === 'delete' ? 'bg-red-500/15 text-red-200' : 'text-zinc-400'}`}>
        <span className="w-10 shrink-0 text-right pr-1 text-zinc-600 tabular-nums select-none">{o.a ?? ''}</span>
        <span className="w-10 shrink-0 text-right pr-2 text-zinc-600 tabular-nums select-none border-r border-white/10">{o.b ?? ''}</span>
        <span className="w-4 shrink-0 text-center select-none">{o.type === 'insert' ? '+' : o.type === 'delete' ? '−' : ' '}</span>
        <span className="whitespace-pre-wrap break-all">{o.line}</span>
      </div>
    ))
  ), [rows, shown]);

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      <div className="grid grid-cols-2 gap-4 h-[38%] min-h-[120px]">
        <Area label={t('tb.diff.old')} value={a} onChange={setA} autoFocus />
        <Area label={t('tb.diff.new')} value={b} onChange={setB} actions={<button className={btn} onClick={() => { setA(b); setB(a); }}>{t('tb.diff.swap')}</button>} />
      </div>
      <div className="flex items-center gap-3 text-[11px] text-zinc-500">
        <Seg value={mode} onChange={setMode} options={[{ value: 'inline', label: t('tb.diff.inline') }, { value: 'side', label: t('tb.diff.side') }]} />
        <Check label={t('tb.diff.ignoreWs')} checked={ws} onChange={setWs} />
        <Check label={t('tb.diff.ignoreCase')} checked={ci} onChange={setCi} />
        <Check label={t('tb.diff.onlyChanges')} checked={onlyChanges} onChange={setOnly} />
        <div className="flex-1" />
        {ops.length > 0 && <span className="tabular-nums"><span className="text-emerald-400">+{stats.added}</span> <span className="text-red-400">−{stats.removed}</span>{stats.added + stats.removed === 0 && <span className="ml-2">{t('tb.diff.identical')}</span>}</span>}
        <CopyButton text={unified} label={t('tb.diff.copyUnified')} />
      </div>
      <div className={`flex-1 min-h-0 overflow-auto rounded-md border border-white/10 bg-white/[.03] ${mono} text-[12px]`}>
        {body}
        {ops.length > MAX_RENDER && <div className="px-3 py-1 text-zinc-500">… {t('tb.diff.truncated', { n: MAX_RENDER })}</div>}
      </div>
    </div>
  );
}

function Cell({ n, text, kind, className = '' }: { n?: number; text?: string; kind: 'eq' | 'del' | 'ins' | 'none'; className?: string }) {
  const bg = kind === 'del' ? 'bg-red-500/15 text-red-200' : kind === 'ins' ? 'bg-emerald-500/15 text-emerald-200' : kind === 'none' ? 'bg-white/[.02]' : 'text-zinc-400';
  return (
    <div className={`flex leading-5 min-w-0 ${bg} ${className}`}>
      <span className="w-10 shrink-0 text-right pr-2 text-zinc-600 tabular-nums select-none">{n ?? ''}</span>
      <span className="whitespace-pre-wrap break-all min-w-0">{text ?? ''}</span>
    </div>
  );
}

/** Side-by-side rows: a run of deletes lines up against the run of inserts that follows it. */
function pairUp(ops: ReturnType<typeof diffLines>) {
  const rows: { l?: (typeof ops)[number]; r?: (typeof ops)[number] }[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'equal') { rows.push({ l: ops[i], r: ops[i] }); i++; continue; }
    const dels: typeof ops = [], ins: typeof ops = [];
    while (i < ops.length && ops[i].type === 'delete') dels.push(ops[i++]);
    while (i < ops.length && ops[i].type === 'insert') ins.push(ops[i++]);
    for (let k = 0; k < Math.max(dels.length, ins.length); k++) rows.push({ l: dels[k], r: ins[k] });
  }
  return rows;
}
