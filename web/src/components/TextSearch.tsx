import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, type GrepHit } from '../lib/api';
import { t, useLang } from '../lib/i18n';
import FileIcon from './FileIcon';

interface Props {
  cwd: string;
  /** Prefill (the editor's selection); otherwise the last query is kept. */
  initial?: string;
  onClose: () => void;
  onOpen: (hit: GrepHit) => void;
}

let lastQuery = '';
let lastCase = false;
let lastRegex = false;

/** ⇧⌘F: text search across the project's files. ↑↓ pick a match, Enter opens the file at it. */
export default function TextSearch({ cwd, initial, onClose, onOpen }: Props) {
  useLang();
  const [q, setQ] = useState(initial || lastQuery);
  const [caseSensitive, setCase] = useState(lastCase);
  const [regex, setRegex] = useState(lastRegex);
  const [res, setRes] = useState<{ hits: GrepHit[]; files: number; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [idx, setIdx] = useState(0);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.select(); }, []);
  useEffect(() => { lastQuery = q; lastCase = caseSensitive; lastRegex = regex; }, [q, caseSensitive, regex]);

  useEffect(() => {
    const n = ++seq.current;
    if (!q) { setRes(null); setError(null); setLoading(false); return; }
    const timer = window.setTimeout(() => {
      setLoading(true);
      api.grep(cwd, q, { caseSensitive, regex })
        .then((r) => { if (n === seq.current) { setRes(r); setError(null); setIdx(0); } })
        .catch((e: unknown) => { if (n === seq.current) { setRes(null); setError(e instanceof ApiError && e.code === 'BAD_REGEX' ? t('textsearch.badRegex') : String((e as Error)?.message ?? e)); } })
        .finally(() => { if (n === seq.current) setLoading(false); });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q, caseSensitive, regex, cwd]);

  const hits = res?.hits ?? [];
  // Group consecutive hits by file (the server returns them file by file).
  const groups = useMemo(() => {
    const out: { rel: string; start: number; count: number }[] = [];
    hits.forEach((h, i) => {
      const g = out[out.length - 1];
      if (g && hits[g.start].path === h.path) g.count++;
      else out.push({ rel: h.rel, start: i, count: 1 });
    });
    return out;
  }, [hits]);

  useEffect(() => { listRef.current?.querySelector(`[data-hit="${idx}"]`)?.scrollIntoView({ block: 'nearest' }); }, [idx]);

  const pick = (h: GrepHit | undefined) => { if (h) { onOpen(h); onClose(); } };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(hits.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(hits[idx]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.altKey && e.code === 'KeyC') { e.preventDefault(); setCase((v) => !v); }
    else if (e.altKey && e.code === 'KeyR') { e.preventDefault(); setRegex((v) => !v); }
  };

  const toggle = (on: boolean, set: (f: (v: boolean) => boolean) => void, label: string, title: string) => (
    <button type="button" title={title} onClick={() => { set((v) => !v); inputRef.current?.focus(); }}
      className={`shrink-0 h-6 min-w-6 px-1.5 rounded-md font-mono text-[11px] ${on ? 'bg-accent/30 text-white' : 'text-zinc-400 hover:text-white hover:bg-fill-2'}`}>{label}</button>
  );

  return (
    <div className="absolute inset-0 z-30 bg-black/50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div className="w-[760px] max-w-[94vw] glass-pop pop-in !rounded-[22px] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1 pr-3 border-b border-white/10">
          <input ref={inputRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={t('textsearch.placeholder')}
            spellCheck={false} className="flex-1 min-w-0 bg-transparent px-4 py-3 text-sm outline-none" />
          {toggle(caseSensitive, setCase, 'Aa', t('textsearch.case'))}
          {toggle(regex, setRegex, '.*', t('textsearch.regex'))}
        </div>
        <div ref={listRef} className="max-h-[56vh] overflow-y-auto py-1">
          {groups.map((g) => (
            <Fragment key={g.start}>
              <div className="sticky top-0 z-10 px-4 py-1 flex items-center gap-2 text-[12px] text-zinc-300 bg-[#15171d]/95">
                <FileIcon name={g.rel.split('/').pop() ?? g.rel} isDir={false} />
                <span className="truncate font-mono">{g.rel}</span>
                <span className="shrink-0 text-zinc-500">{g.count}</span>
              </div>
              {hits.slice(g.start, g.start + g.count).map((h, j) => {
                const i = g.start + j;
                return (
                  <div key={i} data-hit={i} onMouseEnter={() => setIdx(i)} onClick={() => pick(h)}
                    className={`pl-9 pr-4 py-0.5 flex items-baseline gap-3 cursor-pointer font-mono text-[12px] ${i === idx ? 'bg-blue-500/20' : ''}`}>
                    <span className="shrink-0 w-10 text-right text-zinc-500 tabular-nums">{h.line}</span>
                    <span className="truncate text-zinc-300 whitespace-pre">{line(h)}</span>
                  </div>
                );
              })}
            </Fragment>
          ))}
          {error && <div className="px-4 py-3 text-xs text-red-300">{error}</div>}
          {!error && q && !loading && res && hits.length === 0 && <div className="px-4 py-3 text-xs text-zinc-500">{t('textsearch.noMatches')}</div>}
          {!error && loading && hits.length === 0 && <div className="px-4 py-3 text-xs text-zinc-500">{t('textsearch.searching')}</div>}
        </div>
        {res && hits.length > 0 && (
          <div className="px-4 py-1.5 border-t border-white/10 text-[11px] text-zinc-500 flex gap-2">
            <span>{t('textsearch.summary', { n: hits.length, files: res.files })}</span>
            {res.truncated && <span className="text-amber-300/80">{t('textsearch.truncated')}</span>}
            <span className="ml-auto">{t('textsearch.hint')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** The line with the match highlighted; leading indentation dropped. The server cuts long lines 80 chars before the match. */
function line(h: GrepHit) {
  const from = Math.max(0, h.col - 80);
  let at = (from ? 1 : 0) + (h.col - from);
  let text = h.text;
  const indent = text.length - text.trimStart().length;
  if (indent && indent <= at) { text = text.slice(indent); at -= indent; }
  return <>{text.slice(0, at)}<mark className="bg-amber-400/35 text-white rounded-[2px]">{text.slice(at, at + h.len)}</mark>{text.slice(at + h.len)}</>;
}
