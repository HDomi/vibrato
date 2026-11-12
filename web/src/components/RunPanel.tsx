import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type RunInfo, type RunScript } from '../lib/api';
import { findErrors, type LogLine } from '../lib/runLog';
import { fencedTerminalText } from '../lib/textSearch';
import { pollWhileActive } from '../lib/poll';
import { t, useLang } from '../lib/i18n';
import Icon from './Icon';

interface Props {
  cwd: string | null;
  visible: boolean;
  /** Running count and whether the selected log shows errors, for the tab's status dot. */
  onStatus?: (s: { running: number; errors: boolean }) => void;
}

const SHOW_LINES = 1500;

/** Ask the composer on screen to insert text; false when no chat session is open to take it. */
function sendToChat(text: string): boolean {
  const detail = { text, handled: false };
  window.dispatchEvent(new CustomEvent('vibe:insert-composer', { detail }));
  return detail.handled;
}

/** Live output of one run (SSE), resuming after the last line seen when the stream reconnects. */
function useRunLog(id: string | null) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [info, setInfo] = useState<RunInfo | null>(null);
  useEffect(() => {
    setLines([]); setInfo(null);
    if (!id) return;
    let last = -1;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    // Reconnects by hand so the server resumes after the last line instead of replaying the whole backlog.
    const open = () => {
      es = new EventSource(api.runStreamUrl(id, last));
      es.addEventListener('lines', (e) => {
        const batch = JSON.parse((e as MessageEvent).data) as LogLine[];
        const fresh = batch.filter((l) => l.n > last);
        if (!fresh.length) return;
        last = fresh[fresh.length - 1].n;
        setLines((prev) => { const next = prev.concat(fresh); return next.length > 3000 ? next.slice(-3000) : next; });
      });
      es.addEventListener('info', (e) => setInfo(JSON.parse((e as MessageEvent).data) as RunInfo));
      es.addEventListener('removed', () => { done = true; es?.close(); });
      es.onerror = () => { es?.close(); if (!done) retry = setTimeout(open, 2000); };
    };
    open();
    return () => { done = true; clearTimeout(retry); es?.close(); };
  }, [id]);
  return { lines, info };
}

// Memoized: the app re-renders on every streaming update, and this panel stays mounted behind its tab.
export default memo(function RunPanel({ cwd, visible, onStatus }: Props) {
  useLang();
  const [scripts, setScripts] = useState<RunScript[]>([]);
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** Errors at or before this line were dismissed. */
  const [dismissed, setDismissed] = useState<Record<string, number>>({});
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const refresh = useCallback(() => {
    if (!cwd) { setRuns([]); return; }
    api.runList(cwd).then(setRuns).catch(() => {});
  }, [cwd]);
  useEffect(() => {
    setScripts([]); setSelected(null); refresh();
    if (cwd) api.runScripts(cwd).then((r) => setScripts(r.scripts)).catch(() => {});
  }, [cwd, refresh]);
  // Status for the tab dot even while the panel is hidden: slower then, and only while something runs.
  // Ticks are skipped while the app window is in the background (pollWhileActive).
  const anyRunning = runs.some((r) => r.status === 'running');
  useEffect(() => (visible || anyRunning ? pollWhileActive(refresh, visible ? 2500 : 10000) : undefined), [refresh, visible, anyRunning]);
  useEffect(() => { if (!selected && runs.length) setSelected(runs[runs.length - 1].id); else if (selected && !runs.some((r) => r.id === selected)) setSelected(runs[runs.length - 1]?.id ?? null); }, [runs, selected]);
  useEffect(() => { if (!note) return; const timer = setTimeout(() => setNote(null), 3000); return () => clearTimeout(timer); }, [note]);

  const { lines, info: liveInfo } = useRunLog(selected);
  const current = (selected && runs.find((r) => r.id === selected)) || null;
  const info = liveInfo?.id === selected ? liveInfo : current;
  const errors = useMemo(() => findErrors(lines, selected ? dismissed[selected] ?? -1 : -1), [lines, dismissed, selected]);
  const running = runs.filter((r) => r.status === 'running').length;
  useEffect(() => { onStatus?.({ running, errors: errors.length > 0 }); }, [running, errors.length, onStatus]);

  useEffect(() => { const el = logRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [lines, selected, visible]);

  const start = async (name: string, command: string) => {
    if (!cwd) return;
    try { const r = await api.runStart(cwd, name, command); setSelected(r.id); stick.current = true; refresh(); }
    catch (e) { setNote((e as Error).message); }
  };
  const stop = (id: string) => api.runStop(id).then(refresh).catch(() => {});
  const remove = (id: string) => api.runRemove(id).then(refresh).catch(() => {});
  const sendErrors = () => {
    const last = errors[errors.length - 1];
    if (!last || !info) return;
    const text = fencedTerminalText(last.lines.map((l) => l.text).join('\n'), t('run.errorPrompt', { name: info.name, command: info.command }));
    setNote(sendToChat(text) ? t('run.sent') : t('run.noComposer'));
  };

  if (!cwd) return <div className="h-full flex items-center justify-center text-sm text-zinc-600">{t('run.noProject')}</div>;
  const runningNames = new Set(runs.filter((r) => r.status === 'running').map((r) => r.name));
  const shown = lines.length > SHOW_LINES ? lines.slice(-SHOW_LINES) : lines;
  const errorStarts = new Set(errors.map((b) => b.start));

  return (
    <div className="h-full flex flex-col text-xs" data-own-find>
      <div className="shrink-0 border-b border-white/10 px-2 py-2">
        <div className="flex flex-wrap items-center gap-1">
          {scripts.map((s) => {
            const on = runningNames.has(s.name);
            return (
              <button key={s.name} onClick={() => void start(s.name, s.command)} title={s.command}
                className={`group flex items-center gap-1 rounded-full px-2 py-1 font-mono text-[11px] ${on ? 'bg-emerald-400/10 text-emerald-200' : 'bg-white/5 text-zinc-300 hover:bg-white/10'}`}>
                <Icon name={on ? 'reload' : 'play'} size={10} filled={!on} className={on ? '' : 'text-zinc-500 group-hover:text-emerald-300'} />{s.name}
              </button>
            );
          })}
          {adding ? (
            <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) { void start(custom.trim(), custom.trim()); setCustom(''); setAdding(false); } }}>
              <input autoFocus value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setAdding(false); }} placeholder={t('run.customPlaceholder')} spellCheck={false}
                className="w-52 rounded-md bg-black/40 border border-white/10 focus:border-sky-400/50 px-2 py-1 font-mono text-[11px] outline-none" />
            </form>
          ) : (
            <button onClick={() => setAdding(true)} className="flex items-center gap-1 rounded-full px-2 py-1 text-zinc-500 hover:text-zinc-200 hover:bg-white/5"><Icon name="plus" size={11} />{t('run.custom')}</button>
          )}
          {!scripts.length && !adding && <span className="text-zinc-600 px-1">{t('run.noScripts')}</span>}
        </div>
      </div>
      {runs.length > 0 && (
        <div className="shrink-0 flex items-center gap-1 px-2 h-9 border-b border-white/10 overflow-x-auto">
          {runs.map((r) => (
            <div key={r.id} onClick={() => setSelected(r.id)}
              className={`group shrink-0 flex items-center gap-1.5 rounded-full pl-2 pr-1 py-1 cursor-pointer whitespace-nowrap ${r.id === selected ? 'bg-white/10 text-white' : 'text-zinc-400 hover:bg-white/5'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${r.status === 'running' ? 'bg-emerald-400' : r.exitCode === 0 ? 'bg-zinc-500' : 'bg-red-400'}`} />
              <span className="font-mono text-[11px]">{r.name}</span>
              <button onClick={(e) => { e.stopPropagation(); if (r.status === 'running') void stop(r.id); else void remove(r.id); }}
                className="w-5 h-5 flex items-center justify-center rounded-full text-zinc-500 hover:text-white hover:bg-white/15 opacity-60 group-hover:opacity-100 transition-colors" title={r.status === 'running' ? t('run.stop') : t('run.remove')}>
                <Icon name={r.status === 'running' ? 'stop' : 'close'} size={r.status === 'running' ? 10 : 11} filled={r.status === 'running'} />
              </button>
            </div>
          ))}
        </div>
      )}
      {info ? (
        <>
          <div className="shrink-0 flex items-center gap-2 px-3 h-8 border-b border-white/5 text-[11px]">
            <span className={info.status === 'running' ? 'text-emerald-300' : info.exitCode === 0 ? 'text-zinc-400' : 'text-red-300'}>
              {info.status === 'running' ? t('run.running') : t('run.exited', { code: info.exitCode ?? '?' })}
            </span>
            <code className="truncate min-w-0 text-zinc-500">{info.command}</code>
            <div className="flex-1" />
            {info.url && (
              <button onClick={() => window.open(info.url!, '_blank')} className="shrink-0 flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-sky-300 hover:bg-sky-400/10" title={t('run.openExternal')}>{info.url.replace(/^https?:\/\//, '')} ↗</button>
            )}
            {info.url && window.vibe?.openBrowser && (
              <button onClick={() => void window.vibe?.openBrowser?.(info.url!)} className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors" title={t('browser.openInBrowser')}><Icon name="devtools" size={12} /></button>
            )}
            <button onClick={() => void start(info.name, info.command)} className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors" title={t('run.restart')}><Icon name="reload" size={12} /></button>
            {info.status === 'running' && <button onClick={() => void stop(info.id)} className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-zinc-400 hover:text-red-300 hover:bg-white/10 transition-colors" title={t('run.stop')}><Icon name="stop" size={11} filled /></button>}
          </div>
          {errors.length > 0 && (
            <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-red-500/20 bg-red-500/[0.07] text-[11px]">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
              <span className="text-red-200 whitespace-nowrap">{t('run.errors', { n: errors.length })}</span>
              <span className="truncate min-w-0 font-mono text-zinc-400">{errors[errors.length - 1].lines[0].text.trim()}</span>
              <div className="flex-1" />
              <button onClick={sendErrors} className="shrink-0 flex items-center gap-1 rounded-full bg-red-400/15 hover:bg-red-400/25 text-red-100 px-2 py-0.5"><Icon name="send" size={10} />{t('run.sendErrors')}</button>
              <button onClick={() => selected && setDismissed((d) => ({ ...d, [selected]: lines[lines.length - 1]?.n ?? -1 }))} className="shrink-0 text-zinc-500 hover:text-zinc-200" title={t('run.dismiss')}><Icon name="close" size={11} /></button>
            </div>
          )}
          <div ref={logRef} className="flex-1 min-h-0 overflow-auto bg-black/30 py-1.5 font-mono text-[11.5px] leading-[1.5]"
            onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30; }}>
            {lines.length > SHOW_LINES && <div className="px-3 text-zinc-600">… {lines.length - SHOW_LINES} {t('run.earlier')}</div>}
            {/* Hidden panel: keep counting errors for the tab dot, but skip rendering hundreds of rows per batch. */}
            {visible && shown.map((l) => (
              <div key={l.n} className={`px-3 whitespace-pre-wrap break-all ${errorStarts.has(l.n) ? 'bg-red-500/10 text-red-200' : l.err ? 'text-amber-200/80' : 'text-zinc-300'}`}>{l.text || ' '}</div>
            ))}
            {!lines.length && <div className="px-3 text-zinc-600">{info.status === 'running' ? t('run.waiting') : t('run.noOutput')}</div>}
          </div>
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center text-zinc-600 px-6 text-center leading-relaxed whitespace-pre-line">{t('run.empty')}</div>
      )}
      {note && <div className="shrink-0 px-3 py-1.5 border-t border-white/10 text-[11px] text-zinc-300">{note}</div>}
    </div>
  );
});
