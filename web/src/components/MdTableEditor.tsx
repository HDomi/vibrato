import { useEffect, useMemo, useRef, useState } from 'react';
import { emptyTable, findTables, formatTable, parseDelimited, replaceRange, toCsv, toHtml, type Align, type MdTable } from '../lib/mdtable';
import { t } from '../lib/i18n';

type Grid = Pick<MdTable, 'header' | 'align' | 'rows'>;
interface Draft { grid: Grid; origin: { start: number; end: number } | null; deleted: boolean; dirty: boolean }

const ALIGN_NEXT: Record<string, Align> = { null: 'left', left: 'center', center: 'right', right: null };
const ALIGN_ICON: Record<string, string> = { null: '·', left: '⇤', center: '↔', right: '⇥' };
const btn = 'shrink-0 px-2 py-1 rounded-md text-[11px] bg-white/10 hover:bg-white/15 text-zinc-200 disabled:opacity-40 disabled:cursor-default';

function fromText(text: string): Draft[] {
  return findTables(text).map((tb) => ({ grid: { header: [...tb.header], align: [...tb.align], rows: tb.rows.map((r) => [...r]) }, origin: { start: tb.start, end: tb.end }, deleted: false, dirty: false }));
}

/** Applies the drafts to the document: changed tables are rewritten aligned, new ones appended at the end. */
export function applyDrafts(text: string, drafts: Draft[]): string {
  let out = text;
  const existing = drafts.filter((d) => d.origin).sort((a, b) => b.origin!.start - a.origin!.start);
  for (const d of existing) {
    if (d.deleted) {
      const lines = out.split(/\r?\n/);
      lines.splice(d.origin!.start, d.origin!.end - d.origin!.start + 1);
      out = lines.join(out.includes('\r\n') ? '\r\n' : '\n');
    } else if (d.dirty) out = replaceRange(out, d.origin!.start, d.origin!.end, formatTable(d.grid));
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const d of drafts.filter((x) => !x.origin && !x.deleted)) out = `${out.replace(/\s*$/, '')}${eol}${eol}${formatTable(d.grid).split('\n').join(eol)}${eol}`;
  return out;
}

/**
 * Grid editor for every table in a Markdown file. Edits stay local until Save, which rewrites only the
 * touched tables (aligned) and keeps everything else byte for byte.
 */
export default function MdTableEditor({ text, onSave }: { text: string; onSave: (next: string) => Promise<void> }) {
  const [drafts, setDrafts] = useState<Draft[]>(() => fromText(text));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { setDrafts(fromText(text)); }, [text]);
  const dirty = drafts.some((d) => d.dirty || d.deleted || !d.origin);
  const update = (i: number, f: (g: Grid) => Grid) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, grid: f(d.grid), dirty: true } : d)));
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true); setStatus('');
    try { await onSave(applyDrafts(text, drafts)); setStatus(t('preview.table.saved')); }
    catch (e) { setStatus(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 's') return;
      const el = root.current;
      if (!el || el.closest('.invisible') || !el.offsetParent) return;
      e.preventDefault(); void save();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  const live = drafts.map((d, i) => ({ d, i })).filter(({ d }) => !d.deleted);

  return (
    <div ref={root} className="flex flex-col gap-4">
      <div className="sticky top-0 z-10 -mx-5 -mt-5 px-5 py-2 glass-fill border-b border-line flex items-center gap-2 text-[11px] text-zinc-500">
        <span>{t('preview.table.count', { n: live.length })}</span>
        <div className="flex-1" />
        <span className="truncate">{status}</span>
        <button className={btn} onClick={() => setDrafts((ds) => [...ds, { grid: emptyTable(), origin: null, deleted: false, dirty: true }])}>{t('preview.table.add')}</button>
        <button className={btn} disabled={!live.some(({ d }) => d.origin)} onClick={() => setDrafts((ds) => ds.map((d) => ({ ...d, dirty: true })))}>{t('preview.table.alignAll')}</button>
        <button className={btn} disabled={!dirty} onClick={() => { setDrafts(fromText(text)); setStatus(''); }}>{t('preview.table.revert')}</button>
        <button className="shrink-0 px-2.5 py-1 rounded-md text-[11px] font-medium bg-blue-500/80 hover:bg-blue-500 text-white disabled:opacity-40" disabled={!dirty || saving} onClick={() => void save()}>{saving ? t('preview.table.saving') : t('preview.table.save')}</button>
      </div>
      {!live.length && <div className="text-[13px] text-zinc-500">{t('preview.table.none')}</div>}
      {live.map(({ d, i }, n) => (
        <TableCard key={i} n={n + 1} draft={d} onChange={(f) => update(i, f)}
          onDelete={() => setDrafts((ds) => (d.origin ? ds.map((x, j) => (j === i ? { ...x, deleted: true } : x)) : ds.filter((_, j) => j !== i)))} />
      ))}
    </div>
  );
}

function TableCard({ n, draft, onChange, onDelete }: { n: number; draft: Draft; onChange: (f: (g: Grid) => Grid) => void; onDelete: () => void }) {
  const g = draft.grid;
  const cols = g.header.length;
  const [copied, setCopied] = useState('');
  const md = useMemo(() => formatTable(g), [g]);
  const copy = (label: string, s: string) => { navigator.clipboard.writeText(s).catch(() => {}); setCopied(label); setTimeout(() => setCopied(''), 1200); };
  const setCell = (r: number, c: number, v: string) => onChange((x) => r < 0
    ? { ...x, header: x.header.map((h, k) => (k === c ? v : h)) }
    : { ...x, rows: x.rows.map((row, i) => (i === r ? row.map((cell, k) => (k === c ? v : cell)) : row)) });
  /** Pasting a block copied from a spreadsheet (tabs/newlines) fills cells from here, growing the table as needed. */
  const paste = (r: number, c: number, text: string) => onChange((x) => {
    const block = parseDelimited(text);
    const width = Math.max(x.header.length, c + Math.max(...block.map((b) => b.length)));
    const grow = (row: string[]) => [...row, ...Array(width - row.length).fill('')];
    let header = grow(x.header), rows = x.rows.map(grow);
    const align = [...x.align, ...Array(width - x.align.length).fill(null)];
    block.forEach((b, i) => {
      const rr = r + i;
      if (rr < 0) { header = header.map((h, k) => (k >= c && k < c + b.length ? b[k - c] : h)); return; }
      while (rows.length <= rr) rows.push(Array(width).fill(''));
      rows[rr] = rows[rr].map((cell, k) => (k >= c && k < c + b.length ? b[k - c] : cell));
    });
    return { header, align, rows };
  });
  const cell = (r: number, c: number, v: string) => (
    <input value={v} data-cell={`${r}:${c}`} spellCheck={false}
      onChange={(e) => setCell(r, c, e.target.value)}
      onPaste={(e) => { const s = e.clipboardData.getData('text'); if (/[\t\n]/.test(s.trim())) { e.preventDefault(); paste(r, c, s); } }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const tbl = e.currentTarget.closest('table');
        const next = r + 1;
        if (next >= g.rows.length) onChange((x) => ({ ...x, rows: [...x.rows, Array(cols).fill('')] }));
        requestAnimationFrame(() => (tbl?.querySelector(`[data-cell="${next}:${c}"]`) as HTMLInputElement | null)?.focus());
      }}
      style={{ fieldSizing: 'content', textAlign: g.align[c] ?? 'left' } as React.CSSProperties}
      className={`min-w-[4.5rem] max-w-[28rem] bg-transparent px-2 py-1 outline-none focus:bg-blue-500/10 text-[13px] ${r < 0 ? 'font-semibold text-zinc-100' : 'text-zinc-300'}`} />
  );
  return (
    <div className={`rounded-lg border ${draft.dirty || !draft.origin ? 'border-blue-400/30' : 'border-white/10'}`}>
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/10 text-[11px] text-zinc-500">
        <span className="text-zinc-300">{t('preview.table.title', { n })}</span>
        <span>{draft.origin ? t('preview.table.lines', { a: draft.origin.start + 1, b: draft.origin.end + 1 }) : t('preview.table.new')}</span>
        {(draft.dirty || !draft.origin) && <span className="text-blue-300">● {t('preview.table.edited')}</span>}
        <div className="flex-1" />
        {copied && <span className="text-emerald-300">{t('common.copied')}</span>}
        <button className={btn} onClick={() => onChange((x) => ({ ...x, rows: [...x.rows, Array(cols).fill('')] }))}>{t('preview.table.addRow')}</button>
        <button className={btn} onClick={() => onChange((x) => ({ header: [...x.header, ''], align: [...x.align, null], rows: x.rows.map((r) => [...r, '']) }))}>{t('preview.table.addCol')}</button>
        <button className={btn} onClick={() => copy('md', md)}>MD</button>
        <button className={btn} onClick={() => copy('csv', toCsv(g))}>CSV</button>
        <button className={btn} onClick={() => copy('html', toHtml(g))}>HTML</button>
        <button className={`${btn} text-red-300`} onClick={onDelete}>{t('preview.table.delete')}</button>
      </div>
      <div className="overflow-x-auto">
        <table className="border-collapse">
          <thead>
            <tr className="text-[10.5px] text-zinc-500">
              {g.header.map((_, c) => (
                <th key={c} className="px-1 py-0.5 font-normal border-b border-white/5">
                  <div className="flex items-center justify-center gap-1">
                    <button title={t('preview.table.align')} className="w-6 h-5 rounded hover:bg-white/10" onClick={() => onChange((x) => ({ ...x, align: x.align.map((a, k) => (k === c ? ALIGN_NEXT[String(a)] : a)) }))}>{ALIGN_ICON[String(g.align[c])]}</button>
                    <button title={t('preview.table.deleteCol')} disabled={cols <= 1} className="w-5 h-5 rounded hover:bg-white/10 hover:text-red-300 disabled:opacity-30" onClick={() => onChange((x) => ({ header: x.header.filter((_, k) => k !== c), align: x.align.filter((_, k) => k !== c), rows: x.rows.map((r) => r.filter((_, k) => k !== c)) }))}>×</button>
                  </div>
                </th>
              ))}
              <th />
            </tr>
            <tr>{g.header.map((h, c) => <th key={c} className="p-0 border border-white/10 bg-white/[.04]">{cell(-1, c, h)}</th>)}<th /></tr>
          </thead>
          <tbody>
            {g.rows.map((row, r) => (
              <tr key={r} className="group">
                {row.map((v, c) => <td key={c} className="p-0 border border-white/10">{cell(r, c, v)}</td>)}
                <td className="pl-1"><button title={t('preview.table.deleteRow')} className="w-5 h-5 rounded text-zinc-600 hover:text-red-300 hover:bg-white/10 opacity-0 group-hover:opacity-100" onClick={() => onChange((x) => ({ ...x, rows: x.rows.filter((_, i) => i !== r) }))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-1.5 border-t border-white/5 text-[10.5px] text-zinc-600">{t('preview.table.hint')}</div>
    </div>
  );
}
