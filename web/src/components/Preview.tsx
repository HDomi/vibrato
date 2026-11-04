import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ImageConvertDialog from './ImageConvertDialog';
import { highlight, highlightedLines, LANGUAGES, languageFor, rememberLanguage } from '../lib/highlight';
import { CopyButton, LocalLinkContext, openLocalFile } from './MarkdownView';
import MarkdownView from './MarkdownView';
import { api, ApiError, formatSize, imageSrc, type Entry, type TextFile } from '../lib/api';
import { findTables } from '../lib/mdtable';

// The grid editor only loads when a Markdown file's tables are edited.
const MdTableEditor = lazy(() => import('./MdTableEditor'));
import { t, useLang } from '../lib/i18n';
import Icon from './Icon';
import { toast } from './Toast';

interface Props {
  entry: Entry | null;
  /** Shown in a dialog (views without a preview panel): adds a close button. */
  onClose?: () => void;
  /** A linked file stacked over another preview: its links open in the outer preview's stack. */
  layer?: boolean;
}

/** Syntax-highlighted source view with line numbers and a language picker (remembered per extension). */
function CodeView({ content, name, ext }: { content: string; name: string; ext: string }) {
  useLang();
  const [lang, setLang] = useState(() => languageFor(name, ext));
  useEffect(() => { setLang(languageFor(name, ext)); }, [name, ext]);
  const lines = useMemo(() => highlightedLines(highlight(content, lang)), [content, lang]);
  return (
    <div className="h-full flex flex-col">
      <div className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-white/5 text-[11px] text-zinc-500">
        <span>{t('preview.language')}</span>
        <select value={lang} onChange={(e) => { setLang(e.target.value); rememberLanguage(name, ext, e.target.value); }} className="bg-black/20 border border-line rounded px-1.5 py-0.5 outline-none text-zinc-300">
          {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        <span className="text-zinc-600">{lines.length} {t('preview.lines')}</span>
        <div className="flex-1" />
        <CopyButton text={content} />
      </div>
      <div className="flex-1 overflow-auto">
        <table className="hljs text-[12.5px] leading-[1.55] font-mono border-collapse min-w-full" style={{ background: 'transparent' }}>
          <tbody>
            {lines.map((html, i) => (
              <tr key={i} className="hover:bg-white/[0.03]">
                <td className="select-none text-right pr-3 pl-3 text-zinc-600 align-top w-10 whitespace-nowrap">{i + 1}</td>
                <td className="pr-4 whitespace-pre align-top" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TextView({ path, markdown, name, ext, reload }: { path: string; markdown: boolean; name: string; ext: string; /** Bumped when the file changed on disk. */ reload: number }) {
  useLang();
  const [state, setState] = useState<TextFile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'tables'>('view');
  const [conflict, setConflict] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState(null); setErr(null); setConflict(false);
    api.text(path).then((r) => alive && setState(r)).catch((e) => alive && setErr(e.message));
    return () => { alive = false; };
  }, [path, tick]);
  useEffect(() => { setMode('view'); }, [path]);
  // Changed on disk: swap the content in place (no loading flash, scroll kept). The table editor keeps its
  // edits; saving them over a newer file is caught as a conflict.
  useEffect(() => {
    if (!reload || mode === 'tables') return;
    let alive = true;
    api.text(path).then((r) => { if (alive) setState((s) => (s && s.mtime === r.mtime && s.content === r.content ? s : r)); setErr(null); }).catch(() => {});
    return () => { alive = false; };
  }, [reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const tableCount = useMemo(() => (markdown && state ? findTables(state.content).length : 0), [markdown, state]);
  const saveTables = async (next: string) => {
    if (!state) return;
    try {
      const r = await api.saveText(path, next, { baseMtime: state.mtime, bom: state.bom });
      setState({ ...state, content: next, mtime: r.mtime, size: r.size });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setConflict(true); throw new Error(t('preview.table.conflict')); }
      throw e;
    }
  };
  if (err) return <div className="p-4 text-red-300 text-sm">{err}</div>;
  if (!state) return <div className="p-4 text-zinc-500 text-sm">{t('common.loading')}</div>;
  if (!markdown) {
    return (
      <div className="h-full flex flex-col">
        {state.truncated && <div className="px-3 py-1 text-xs text-amber-400 border-b border-white/5">{t('preview.truncated')}</div>}
        <div className="flex-1 min-h-0"><CodeView content={state.content} name={name} ext={ext} /></div>
      </div>
    );
  }
  const editable = !state.truncated && !state.lossy && !state.binary;
  return (
    <div className="p-5">
      {state.truncated && <div className="mb-3 text-xs text-amber-400">{t('preview.truncated')}</div>}
      {editable && (
        <div className="mb-4 flex items-center gap-2 text-[11px]">
          <div className="inline-flex items-center rounded-md bg-white/5 p-0.5">
            {(['view', 'tables'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`px-2 py-0.5 rounded ${mode === m ? 'bg-white/15 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
                {m === 'view' ? t('preview.table.view') : t('preview.table.edit', { n: tableCount })}
              </button>
            ))}
          </div>
          {conflict && <>
            <span className="text-amber-400">{t('preview.table.conflict')}</span>
            <button className="px-2 py-0.5 rounded-full bg-fill-2 hover:bg-fill-3 transition-colors text-zinc-200" onClick={() => setTick((n) => n + 1)}>{t('preview.table.reload')}</button>
          </>}
        </div>
      )}
      {mode === 'tables' && editable
        ? <Suspense fallback={null}><MdTableEditor text={state.content} onSave={saveTables} /></Suspense>
        : <MarkdownView text={state.content} baseDir={path.slice(0, path.lastIndexOf('/'))} className="prose-md max-w-3xl text-[15px]" />}
    </div>
  );
}

/** Copies the Markdown file as written on disk (the full source, not the rendered or truncated view). */
function CopySourceButton({ path }: { path: string }) {
  useLang();
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');
  useEffect(() => { setState('idle'); }, [path]);
  const copy = async () => {
    try {
      const res = await fetch(api.rawUrl(path), { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      await navigator.clipboard.writeText(await res.text());
      setState('done');
    } catch { setState('error'); }
    setTimeout(() => setState('idle'), 1400);
  };
  return (
    <button className={`text-xs ${state === 'error' ? 'text-red-300' : state === 'done' ? 'text-emerald-300' : 'text-zinc-400 hover:text-white'}`} onClick={() => void copy()} title={t('preview.copySourceHint')}>
      {state === 'done' ? t('common.copied') : state === 'error' ? t('preview.copySourceFailed') : t('preview.copySource')}
    </button>
  );
}

export default function Preview({ entry, onClose, layer }: Props) {
  useLang();
  const [converting, setConverting] = useState(false);
  // Files linked from the Markdown on screen open as closable layers over it, so the linking file stays put.
  const [layers, setLayers] = useState<Entry[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const entryPath = entry?.path;
  useEffect(() => { setLayers([]); }, [entryPath]);
  const openLink = useCallback((path: string) => {
    api.stat(path).then((e) => {
      if (e.isDir) openLocalFile(e.path);
      else setLayers((l) => [...l, e]);
    }).catch(() => toast(t('preview.openFailed', { path }), 'error'));
  }, []);
  const hasLayers = layers.length > 0;
  useEffect(() => {
    if (!hasLayers) return;
    // Capture phase: the top layer closes before an enclosing preview dialog sees the key.
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
      if (root.current && !root.current.checkVisibility({ visibilityProperty: true })) return;
      e.preventDefault(); e.stopPropagation();
      setLayers((l) => l.slice(0, -1));
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [hasLayers]);
  // Bumped when the file on screen changes (saved here, edited elsewhere, opened again), so it is read again.
  const [rev, setRev] = useState(0);
  const seen = useRef<{ path: string; mtime: number } | null>(null);
  useEffect(() => {
    if (!entry) return;
    const prev = seen.current;
    seen.current = { path: entry.path, mtime: entry.mtime };
    if (prev?.path === entry.path && prev.mtime !== entry.mtime) setRev((r) => r + 1);
  }, [entry]);
  const watchPath = entry && !entry.isDir ? entry.path : null;
  useEffect(() => {
    if (!watchPath) return;
    const es = new EventSource(api.fsWatchUrl(watchPath.slice(0, watchPath.lastIndexOf('/')) || '/'));
    es.addEventListener('change', (ev) => {
      let changed: unknown;
      try { changed = JSON.parse((ev as MessageEvent<string>).data); } catch { return; }
      if (changed === '*' || (Array.isArray(changed) && changed.includes(watchPath))) setRev((r) => r + 1);
    });
    return () => es.close();
  }, [watchPath]);
  if (!entry) {
    return <div className="h-full flex items-center justify-center text-zinc-600 text-sm">{t('preview.hint')}</div>;
  }
  const url = api.rawUrl(entry.path);
  const body = (
    <div ref={root} className="relative h-full flex flex-col min-w-0">
      <div className="h-10 flex items-center gap-3 px-4 border-b border-white/10 text-sm">
        <span className="truncate font-medium">{entry.name}</span>
        <span className="text-zinc-500 text-xs">{formatSize(entry.size)}</span>
        <div className="flex-1" />
        {entry.kind === 'image' && (
          <button className="text-xs px-2 py-1 rounded-md border border-white/10 text-zinc-300 hover:text-white hover:bg-white/10" onClick={() => setConverting(true)}>{t('image.convertButton')}</button>
        )}
        {entry.kind === 'markdown' && <CopySourceButton path={entry.path} />}
        <button className="text-xs text-zinc-400 hover:text-white" onClick={() => navigator.clipboard.writeText(entry.path)} title={entry.path}>{t('preview.copyPath')}</button>
        {onClose && <button className="-mr-2 w-7 h-7 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors" onClick={onClose} title="Esc"><Icon name="close" /></button>}
      </div>
      {converting && (
        <ImageConvertDialog entry={entry} onClose={() => setConverting(false)}
          onSaved={(p) => { if (p === entry.path) setRev((r) => r + 1); else window.dispatchEvent(new CustomEvent('vibe:open-file', { detail: { path: p } })); }} />
      )}
      <div className="flex-1 overflow-auto">
        {entry.kind === 'markdown' && <TextView path={entry.path} markdown name={entry.name} ext={entry.ext} reload={rev} />}
        {entry.kind === 'text' && <TextView path={entry.path} markdown={false} name={entry.name} ext={entry.ext} reload={rev} />}
        {entry.kind === 'image' && (
          <div className="h-full flex items-center justify-center p-4">
            <img src={imageSrc(entry.path, entry.ext, rev)} alt={entry.name} className="max-w-full max-h-full object-contain rounded" />
          </div>
        )}
        {entry.kind === 'video' && (
          <div className="h-full flex items-center justify-center p-4 bg-black">
            <video src={url} controls className="max-w-full max-h-full" />
          </div>
        )}
        {entry.kind === 'audio' && (
          <div className="h-full flex items-center justify-center p-4">
            <audio src={url} controls className="w-full max-w-xl" />
          </div>
        )}
        {entry.kind === 'pdf' && <iframe src={url} title={entry.name} className="w-full h-full border-0 bg-white" />}
        {entry.kind === 'binary' && (
          <div className="h-full flex flex-col items-center justify-center text-zinc-500 text-sm gap-2">
            <div>{t('preview.noPreview')}</div>
            <div className="text-xs text-zinc-600">{entry.ext || t('preview.noExt')}</div>
          </div>
        )}
      </div>
      {layers.map((l, i) => (
        <div key={`${i}:${l.path}`} className="fade-in absolute inset-0 z-20 bg-black/40" style={{ padding: 12 + i * 10 }} onMouseDown={() => setLayers((ls) => ls.slice(0, i))}>
          <div className="h-full glass-pop pop-in !rounded-[18px] !bg-[rgb(24_26_33/.97)] overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
            <Preview entry={l} layer onClose={() => setLayers((ls) => ls.slice(0, i))} />
          </div>
        </div>
      ))}
    </div>
  );
  return layer ? body : <LocalLinkContext.Provider value={openLink}>{body}</LocalLinkContext.Provider>;
}

/** The preview as a dialog, for views without the right-hand panel (Agents, Tools, Schedules). */
export function PreviewDialog({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fade-in fixed inset-0 z-40 bg-black/50 flex items-center justify-center" onMouseDown={onClose}>
      <div className="w-[960px] max-w-[94vw] h-[86vh] glass-pop pop-in !rounded-[22px] overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        <Preview entry={entry} onClose={onClose} />
      </div>
    </div>
  );
}
