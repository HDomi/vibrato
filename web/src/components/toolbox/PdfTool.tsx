import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useViewActiveRef } from '../../lib/viewActive';
import {
  assemblePdf, baseName, duplicatePages, isEncrypted, movePages, nudgePages, pageImageName, pagesOf, PdfLockedError,
  removePages, rotatePages, type ImageFormat, type PageRef, type PdfSource,
} from '../../lib/pdfDoc';
import { openPdf, PdfPasswordError, renderPageImage, renderThumb, type OpenedPdf } from '../../lib/pdfRender';
import { takePayload } from './bus';
import { Check, Seg, blobToBase64, btn, btnPrimary, errText, fmtBytes, select, usePersisted } from './ui';

/** What other parts of the app send with `openTool('pdf', …)`. */
export interface PdfToolPayload { paths: string[]; exportImages?: boolean }

interface Incoming { name: string; bytes: Uint8Array; path?: string }
interface ExportOpts { format: ImageFormat; dpi: number; quality: number; transparent: boolean }

const DPIS = [72, 96, 150, 200, 300, 600];
const THUMB = 168;
const HISTORY = 50;
const isPdfName = (n: string) => /\.pdf$/i.test(n);
const dirOf = (p?: string) => (p ? p.slice(0, p.lastIndexOf('/')) : '');

async function readPath(path: string): Promise<Incoming> {
  const res = await fetch(api.rawUrl(path), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: ${res.statusText}`);
  return { name: path.slice(path.lastIndexOf('/') + 1), path, bytes: new Uint8Array(await res.arrayBuffer()) };
}

async function readFile(f: File): Promise<Incoming> {
  let path: string | undefined;
  try { path = window.vibe?.getPathForFile(f) || undefined; } catch { /* plain browser */ }
  return { name: f.name, path, bytes: new Uint8Array(await f.arrayBuffer()) };
}

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Thumbnails by source/page/rotation; object URLs live until their source is closed or the tool unmounts. */
class ThumbCache {
  private map = new Map<string, Promise<string>>();
  get(doc: OpenedPdf, src: string, index: number, rotate: number): Promise<string> {
    const k = `${src}:${index}:${rotate}`;
    let p = this.map.get(k);
    if (!p) {
      p = renderThumb(doc.doc, index, rotate, THUMB).then((r) => r.url);
      p.catch(() => this.map.delete(k));
      this.map.set(k, p);
    }
    return p;
  }
  drop(src?: string) {
    for (const [k, p] of this.map) {
      if (src && !k.startsWith(`${src}:`)) continue;
      void p.then((u) => URL.revokeObjectURL(u), () => {});
      this.map.delete(k);
    }
  }
}

/** PDF pages: merge files, delete / duplicate / reorder / rotate pages, save as PDF, export pages as images. */
export default function PdfTool() {
  const [sources, setSources] = useState<Map<string, PdfSource>>(() => new Map());
  const docs = useRef(new Map<string, OpenedPdf>());
  const thumbs = useRef(new ThumbCache());
  const [pages, setPagesRaw] = useState<PageRef[]>([]);
  const past = useRef<PageRef[][]>([]);
  const future = useRef<PageRef[][]>([]);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const cancel = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; path?: string } | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [ex, setEx] = usePersisted<ExportOpts>('pdf.export', { format: 'png', dpi: 150, quality: 90, transparent: false });
  const [drag, setDrag] = useState<{ over: number | null; files: boolean } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const viewActive = useViewActiveRef();
  const idSeq = useRef(0);

  useEffect(() => () => {
    thumbs.current.drop();
    for (const d of docs.current.values()) void d.close();
  }, []);

  /** Every page edit goes through here so it can be undone. */
  const edit = useCallback((next: PageRef[] | ((p: PageRef[]) => PageRef[])) => {
    setPagesRaw((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      if (v === prev) return prev;
      past.current = [...past.current.slice(-HISTORY + 1), prev];
      future.current = [];
      setDirty(true);
      return v;
    });
  }, []);
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    setPagesRaw((cur) => { future.current.push(cur); return prev; });
    setSel(new Set());
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    setPagesRaw((cur) => { past.current.push(cur); return next; });
    setSel(new Set());
  }, []);

  const closeSource = useCallback((id: string) => {
    thumbs.current.drop(id);
    void docs.current.get(id)?.close();
    docs.current.delete(id);
    setSources((m) => { const n = new Map(m); n.delete(id); return n; });
  }, []);

  const reset = useCallback(() => {
    for (const id of docs.current.keys()) closeSource(id);
    setPagesRaw([]); past.current = []; future.current = [];
    setSel(new Set()); setDirty(false); setNotice(null); setErr(null);
  }, [closeSource]);

  /** Open files and insert all their pages at `at` (end by default). */
  const add = useCallback(async (load: () => Promise<Incoming[]>, at?: number) => {
    setBusy(t('pdf.opening')); setErr(null);
    const failed: string[] = [];
    try {
      const files = await load();
      const added: PageRef[] = [];
      for (const f of files) {
        if (!isPdfName(f.name) && !(f.bytes[0] === 0x25 && f.bytes[1] === 0x50)) { failed.push(t('pdf.notPdf', { name: f.name })); continue; }
        try {
          const opened = await openPdf(f.bytes, f.name);
          const locked = await isEncrypted(f.bytes).catch(() => false);
          const src: PdfSource = { id: `s${++idSeq.current}`, name: f.name, path: f.path, bytes: f.bytes, pageCount: opened.doc.numPages, locked };
          docs.current.set(src.id, opened);
          setSources((m) => new Map(m).set(src.id, src));
          added.push(...pagesOf(src));
        } catch (e) {
          failed.push(e instanceof PdfPasswordError ? t('pdf.password', { name: f.name }) : errText(e));
        }
      }
      if (added.length) {
        edit((prev) => { const i = at ?? prev.length; return [...prev.slice(0, i), ...added, ...prev.slice(i)]; });
        setSel(new Set(added.map((p) => p.key)));
      }
    } catch (e) {
      failed.push(errText(e));
    } finally {
      setBusy(null);
      if (failed.length) setErr(failed.join('\n'));
    }
  }, [edit]);

  // Files sent from the file list / preview ("Open in PDF tool", "Export pages as images").
  const receive = useCallback((p: PdfToolPayload | undefined) => {
    if (!p?.paths.length) return;
    if (pages.length && dirty && window.confirm(t('pdf.replaceConfirm'))) reset();
    else if (pages.length && !dirty) reset();
    void add(() => Promise.all(p.paths.map(readPath))).then(() => { if (p.exportImages) setShowExport(true); });
  }, [add, dirty, pages.length, reset]);
  const receiveRef = useRef(receive);
  receiveRef.current = receive;
  useEffect(() => {
    receiveRef.current(takePayload<PdfToolPayload>('pdf'));
    const h = (e: Event) => { if ((e as CustomEvent<{ id: string }>).detail?.id === 'pdf') receiveRef.current(takePayload<PdfToolPayload>('pdf')); };
    window.addEventListener('vibe:tool-payload', h);
    return () => window.removeEventListener('vibe:tool-payload', h);
  }, []);

  const selected = useMemo(() => pages.filter((p) => sel.has(p.key)), [pages, sel]);
  const target = selected.length ? sel : new Set(pages.map((p) => p.key));

  const remove = useCallback(() => { if (sel.size) { edit((p) => removePages(p, sel)); setSel(new Set()); } }, [edit, sel]);
  const duplicate = useCallback(() => {
    if (!sel.size) return;
    let added: string[] = [];
    edit((p) => { const r = duplicatePages(p, sel); added = r.added; return r.pages; });
    setTimeout(() => setSel(new Set(added)));
  }, [edit, sel]);
  const rotate = useCallback((d: number) => { if (sel.size) edit((p) => rotatePages(p, sel, d)); }, [edit, sel]);
  const nudge = useCallback((d: -1 | 1) => { if (sel.size) edit((p) => nudgePages(p, sel, d)); }, [edit, sel]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!viewActive.current || busy) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'a' && pages.length) { e.preventDefault(); setSel(new Set(pages.map((p) => p.key))); }
      else if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && k === 'd') { e.preventDefault(); duplicate(); }
      else if ((e.key === 'Backspace' || e.key === 'Delete') && sel.size) { e.preventDefault(); remove(); }
      else if (e.key === 'Escape' && sel.size) setSel(new Set());
      else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowUp')) { e.preventDefault(); nudge(-1); }
      else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) { e.preventDefault(); nudge(1); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [busy, duplicate, nudge, pages, redo, remove, sel.size, undo, viewActive]);

  const click = (p: PageRef, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current) {
      const a = pages.findIndex((x) => x.key === anchor.current);
      const b = pages.findIndex((x) => x.key === p.key);
      if (a >= 0 && b >= 0) {
        const range = pages.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.key);
        setSel((s) => new Set(e.metaKey || e.ctrlKey ? [...s, ...range] : range));
        return;
      }
    }
    anchor.current = p.key;
    if (e.metaKey || e.ctrlKey) setSel((s) => { const n = new Set(s); if (n.has(p.key)) n.delete(p.key); else n.add(p.key); return n; });
    else setSel(new Set([p.key]));
  };

  // Drag: pages within the grid move (the whole selection when the dragged page is part of it);
  // PDFs from Finder or from the file list are inserted at the drop point.
  const dragKeys = useRef<Set<string> | null>(null);
  const startDrag = (p: PageRef, e: DragEvent) => {
    const keys = sel.has(p.key) ? sel : new Set([p.key]);
    if (!sel.has(p.key)) setSel(keys);
    dragKeys.current = keys;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-vibe-pdf-page', String(keys.size));
  };
  const isExternal = (e: DragEvent) => !dragKeys.current && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/x-vibe-path'));
  const overCard = (i: number, e: DragEvent) => {
    if (!dragKeys.current && !isExternal(e)) return;
    e.preventDefault(); e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = e.clientX < r.left + r.width / 2 ? i : i + 1;
    if (drag?.over !== at) setDrag({ over: at, files: isExternal(e) });
  };
  const drop = (e: DragEvent, at: number) => {
    e.preventDefault();
    e.stopPropagation();
    const keys = dragKeys.current;
    dragKeys.current = null;
    setDrag(null);
    if (keys) { edit((p) => movePages(p, keys, at)); return; }
    const vibePaths = e.dataTransfer.getData('application/x-vibe-path').split('\n').filter(isPdfName);
    const files = [...e.dataTransfer.files];
    if (vibePaths.length) void add(() => Promise.all(vibePaths.map(readPath)), at);
    else if (files.length) void add(() => Promise.all(files.map(readFile)), at);
  };

  const firstSource = pages.length ? sources.get(pages[0].src) : undefined;
  const srcIds = new Set(pages.map((p) => p.src));
  const outBase = srcIds.size > 1 ? 'merged' : firstSource ? baseName(firstSource.name) : 'document';

  const savePdf = async (onlySelected: boolean) => {
    const list = onlySelected ? selected : pages;
    if (!list.length) return;
    setErr(null); setNotice(null);
    const name = onlySelected ? `${outBase}-pages.pdf` : srcIds.size > 1 ? 'merged.pdf' : `${outBase}-edited.pdf`;
    const dir = dirOf(firstSource?.path);
    let dest: string | null = null;
    if (window.vibe?.saveDialog) {
      dest = await window.vibe.saveDialog({ defaultPath: dir ? `${dir}/${name}` : name, ext: 'pdf', label: 'PDF' });
      if (!dest) return;
    }
    setBusy(t('pdf.saving'));
    try {
      const bytes = await assemblePdf(sources, list, { title: baseName(dest ? dest.slice(dest.lastIndexOf('/') + 1) : name) });
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
      if (dest) {
        const r = await api.imageWrite(dest, await blobToBase64(blob), true);
        setNotice({ text: t('pdf.savedPdf', { path: r.path, n: list.length, size: fmtBytes(bytes.length) }), path: r.path });
      } else {
        download(name, blob);
        setNotice({ text: t('pdf.downloaded', { name }) });
      }
      if (!onlySelected) setDirty(false);
    } catch (e) {
      setErr(e instanceof PdfLockedError ? t('pdf.lockedSave', { names: e.names.join(', ') }) : errText(e));
    } finally {
      setBusy(null);
    }
  };

  const exportImages = async () => {
    const list = pages.filter((p) => target.has(p.key));
    if (!list.length) return;
    setErr(null); setNotice(null);
    const names = list.map((_, i) => pageImageName(outBase, i + 1, list.length, ex.format));
    let dir: string | null = null;
    if (window.vibe?.pickFolder) {
      dir = await window.vibe.pickFolder();
      if (!dir) return;
      try {
        const listing = await api.list(dir);
        const clash = names.filter((n) => listing.entries.some((e) => e.name === n));
        if (clash.length && !window.confirm(t('pdf.overwrite', { n: clash.length, files: clash.slice(0, 5).join(', ') + (clash.length > 5 ? ' …' : '') }))) return;
      } catch (e) { setErr(errText(e)); return; }
    }
    cancel.current = false;
    setExporting(true);
    let done = 0;
    try {
      for (let i = 0; i < list.length; i++) {
        if (cancel.current) break;
        setBusy(t('pdf.exporting', { i: i + 1, n: list.length }));
        const p = list[i];
        const doc = docs.current.get(p.src);
        if (!doc) continue;
        const blob = await renderPageImage(doc.doc, p.index, p.rotate, ex);
        if (dir) await api.imageWrite(`${dir}/${names[i]}`, await blobToBase64(blob), true);
        else download(names[i], blob);
        done++;
      }
      setNotice({ text: t(cancel.current ? 'pdf.exportCancelled' : dir ? 'pdf.exported' : 'pdf.downloadedN', { n: done, dir: dir ?? '' }), path: dir ?? undefined });
      if (!cancel.current) setShowExport(false);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
      setExporting(false);
    }
  };

  const showSourceName = srcIds.size > 1;
  const lockedUsed = [...srcIds].some((id) => sources.get(id)?.locked);

  if (!pages.length && !sources.size) {
    return (
      <div className="h-full flex flex-col gap-3">
        <div
          onClick={() => picker.current?.click()}
          onDragOver={(e) => { if (isExternal(e)) { e.preventDefault(); setDrag({ over: 0, files: true }); } }}
          onDragLeave={() => setDrag(null)}
          onDrop={(e) => drop(e, 0)}
          className={`flex-1 cursor-pointer rounded-2xl border border-dashed flex flex-col items-center justify-center gap-2 text-center transition-colors ${drag ? 'border-blue-400 bg-blue-500/10' : 'border-white/15 hover:border-white/30 hover:bg-white/[.02]'}`}>
          <div className="text-[13px] text-zinc-300">{busy ?? t('pdf.drop')}</div>
          <div className="text-[11px] text-zinc-500 max-w-md">{t('pdf.dropHint')}</div>
        </div>
        <FilePicker refEl={picker} onFiles={(fs) => void add(() => Promise.all(fs.map(readFile)))} />
        {err && <div className="shrink-0 text-[11px] text-red-400 whitespace-pre-wrap">{err}</div>}
      </div>
    );
  }

  const one = selected.length > 0;
  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      <div className="shrink-0 flex flex-wrap items-center gap-1.5">
        <button className={btn} disabled={!!busy} onClick={() => picker.current?.click()}>{t('pdf.addFiles')}</button>
        <span className="mx-1 h-4 w-px bg-white/10" />
        <button className={btn} disabled={!one || !!busy} onClick={() => rotate(-90)} title={t('pdf.rotateLeft')}>⟲</button>
        <button className={btn} disabled={!one || !!busy} onClick={() => rotate(90)} title={t('pdf.rotateRight')}>⟳</button>
        <button className={btn} disabled={!one || !!busy} onClick={() => nudge(-1)} title={`${t('pdf.moveEarlier')} (⌥←)`}>←</button>
        <button className={btn} disabled={!one || !!busy} onClick={() => nudge(1)} title={`${t('pdf.moveLater')} (⌥→)`}>→</button>
        <button className={btn} disabled={!one || !!busy} onClick={duplicate} title="⌘D">{t('pdf.duplicate')}</button>
        <button className={`${btn} hover:!bg-red-500/30`} disabled={!one || !!busy} onClick={remove} title="⌫">{t('pdf.delete')}</button>
        <span className="mx-1 h-4 w-px bg-white/10" />
        <button className={btn} disabled={!past.current.length || !!busy} onClick={undo} title="⌘Z">{t('pdf.undo')}</button>
        <button className={btn} disabled={!future.current.length || !!busy} onClick={redo} title="⇧⌘Z">{t('pdf.redo')}</button>
        <div className="flex-1" />
        <span className="text-[11px] text-zinc-500 tabular-nums">{one ? t('pdf.selectedOf', { n: selected.length, total: pages.length }) : t('pdf.pageCount', { n: pages.length })}</span>
        <button className={btn} disabled={!pages.length || !!busy} onClick={() => setShowExport((v) => !v)}>{t('pdf.exportImages')}</button>
        {one && selected.length < pages.length && <button className={btn} disabled={!!busy || lockedUsed} onClick={() => void savePdf(true)}>{t('pdf.saveSelected', { n: selected.length })}</button>}
        <button className={btnPrimary} disabled={!pages.length || !!busy || lockedUsed} onClick={() => void savePdf(false)}>{t('pdf.savePdf')}</button>
      </div>
      <FilePicker refEl={picker} onFiles={(fs) => void add(() => Promise.all(fs.map(readFile)))} />

      <div className="shrink-0 flex flex-wrap items-center gap-1.5 text-[11px]">
        {[...sources.values()].map((s) => {
          const used = pages.filter((p) => p.src === s.id).length;
          return (
            <span key={s.id} title={s.path ?? s.name} className="inline-flex items-center gap-1.5 rounded-full bg-fill pl-2.5 pr-1 py-0.5 text-zinc-300">
              {s.locked && <span title={t('pdf.lockedHint')}>🔒</span>}
              <span className="max-w-[220px] truncate">{s.name}</span>
              <span className="text-zinc-500 tabular-nums">{used === s.pageCount ? s.pageCount : `${used}/${s.pageCount}`}p · {fmtBytes(s.bytes.length)}</span>
              <button className="w-4 h-4 rounded-full text-zinc-500 hover:text-white hover:bg-white/10" title={t('pdf.closeFile')} disabled={!!busy}
                onClick={() => { edit((p) => p.filter((x) => x.src !== s.id)); closeSource(s.id); setSel(new Set()); }}>×</button>
            </span>
          );
        })}
        <button className="ml-1 text-zinc-500 hover:text-zinc-200" disabled={!!busy} onClick={() => { if (!dirty || window.confirm(t('pdf.clearConfirm'))) reset(); }}>{t('pdf.clear')}</button>
      </div>

      {showExport && (
        <div className="shrink-0 rounded-2xl border border-line bg-black/15 px-3 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-zinc-400">
          <Seg value={ex.format} onChange={(format) => setEx({ ...ex, format })} options={[{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPG' }, { value: 'webp', label: 'WebP' }]} />
          <label className="flex items-center gap-1.5">{t('pdf.resolution')}
            <select className={select} value={ex.dpi} onChange={(e) => setEx({ ...ex, dpi: Number(e.target.value) })}>
              {DPIS.map((d) => <option key={d} value={d}>{d} dpi{d === 72 ? ` (${t('pdf.dpiScreen')})` : d === 300 ? ` (${t('pdf.dpiPrint')})` : ''}</option>)}
            </select>
          </label>
          {ex.format !== 'png' && (
            <label className="flex items-center gap-1.5">{t('pdf.quality')}
              <input type="range" min={30} max={100} value={ex.quality} onChange={(e) => setEx({ ...ex, quality: Number(e.target.value) })} className="w-24" />
              <span className="w-6 tabular-nums text-zinc-300">{ex.quality}</span>
            </label>
          )}
          {ex.format !== 'jpeg' && <Check label={t('pdf.transparent')} checked={ex.transparent} onChange={(transparent) => setEx({ ...ex, transparent })} />}
          <div className="flex-1" />
          <span>{t(one ? 'pdf.exportSelected' : 'pdf.exportAll', { n: one ? selected.length : pages.length })}</span>
          <button className={btnPrimary} disabled={!!busy} onClick={() => void exportImages()}>{window.vibe?.pickFolder ? t('pdf.exportToFolder') : t('pdf.download')}</button>
        </div>
      )}

      {(busy || err || notice) && (
        <div className="shrink-0 flex items-start gap-2 text-[11px]">
          {busy ? <span className="text-zinc-400">{busy}</span>
            : err ? <span className="text-red-400 whitespace-pre-wrap">{err}</span>
            : notice && <span className="text-emerald-300/90 break-all">{notice.text}</span>}
          {exporting && <button className={btn} onClick={() => { cancel.current = true; }}>{t('pdf.cancel')}</button>}
          {!busy && notice?.path && <button className={btn} onClick={() => window.dispatchEvent(new CustomEvent('vibe:open-file', { detail: { path: notice.path } }))}>{t('pdf.show')}</button>}
        </div>
      )}

      <div
        className="flex-1 min-h-0 overflow-y-auto rounded-2xl border border-line bg-black/15 p-3"
        onClick={(e) => { if (e.target === e.currentTarget) setSel(new Set()); }}
        onDragOver={(e) => { if (dragKeys.current || isExternal(e)) { e.preventDefault(); if (drag?.over !== pages.length) setDrag({ over: pages.length, files: isExternal(e) }); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(null); }}
        onDrop={(e) => drop(e, drag?.over ?? pages.length)}>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(136px, 1fr))' }} onClick={(e) => { if (e.target === e.currentTarget) setSel(new Set()); }}>
          {pages.map((p, i) => {
            const doc = docs.current.get(p.src);
            const src = sources.get(p.src);
            return (
              <PageCard key={p.key} page={p} n={i + 1} doc={doc} cache={thumbs.current} selected={sel.has(p.key)}
                label={showSourceName && src ? `${baseName(src.name)} · ${p.index + 1}` : undefined}
                marker={drag?.over === i ? 'before' : drag?.over === i + 1 && i === pages.length - 1 ? 'after' : null}
                onClick={(e) => click(p, e)}
                onDragStart={(e) => startDrag(p, e)}
                onDragEnd={() => { dragKeys.current = null; setDrag(null); }}
                onDragOver={(e) => overCard(i, e)}
                onDrop={(e) => drop(e, drag?.over ?? i)} />
            );
          })}
        </div>
        {!pages.length && <div className="py-10 text-center text-[12px] text-zinc-500">{t('pdf.noPages')}</div>}
      </div>
    </div>
  );
}

function FilePicker({ refEl, onFiles }: { refEl: React.RefObject<HTMLInputElement | null>; onFiles: (f: File[]) => void }) {
  return <input ref={refEl} type="file" multiple accept="application/pdf,.pdf" className="hidden" onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; if (fs.length) onFiles(fs); }} />;
}

interface CardProps {
  page: PageRef; n: number; doc?: OpenedPdf; cache: ThumbCache; selected: boolean; label?: string; marker: 'before' | 'after' | null;
  onClick: (e: React.MouseEvent) => void; onDragStart: (e: DragEvent) => void; onDragEnd: () => void; onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void;
}

/** A page thumbnail, rendered when it first scrolls into view. */
function PageCard({ page, n, doc, cache, selected, label, marker, onClick, onDragStart, onDragEnd, onDragOver, onDrop }: CardProps) {
  const el = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = el.current;
    if (!node || seen) return;
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '400px' });
    io.observe(node);
    return () => io.disconnect();
  }, [seen]);
  useEffect(() => {
    if (!seen || !doc) return;
    let alive = true;
    setFailed(false);
    cache.get(doc, page.src, page.index, page.rotate).then((u) => { if (alive) setUrl(u); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [seen, doc, cache, page.src, page.index, page.rotate]);
  return (
    <div ref={el} draggable onClick={onClick} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={onDragOver} onDrop={onDrop}
      className="relative flex flex-col items-center gap-1.5 cursor-default select-none">
      {marker && <div className={`absolute top-0 bottom-6 w-[3px] rounded-full bg-blue-400 ${marker === 'before' ? '-left-[7px]' : '-right-[7px]'}`} />}
      <div className={`w-full h-[184px] flex items-center justify-center rounded-xl p-2 transition-colors ${selected ? 'bg-blue-500/25 ring-2 ring-blue-400' : 'bg-white/[.03] hover:bg-white/[.06]'}`}>
        {url ? <img src={url} alt="" draggable={false} className="max-w-full max-h-full object-contain shadow-md shadow-black/40 bg-white" />
          : <div className="w-[70%] h-[85%] rounded bg-white/5 flex items-center justify-center text-[10px] text-zinc-600">{failed ? '!' : '…'}</div>}
      </div>
      <div className="max-w-full truncate text-[11px] tabular-nums text-zinc-400">
        {n}{label && <span className="text-zinc-600"> · {label}</span>}{page.rotate ? <span className="text-zinc-600"> · {page.rotate}°</span> : null}
      </div>
    </div>
  );
}
