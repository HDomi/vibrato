import { useEffect, useRef, useState } from 'react';
import type { ChatItem } from '../lib/chatStore';
import { api } from '../lib/api';
import { t, useLang } from '../lib/i18n';
import Icon from './Icon';

type VerifyItemData = Extract<ChatItem, { kind: 'verify' }>;

/** The last `n` lines of a run's output: where compilers and test runners print their summary. */
function tail(text: string, n: number) {
  const lines = text.split('\n');
  return lines.length > n ? lines.slice(-n).join('\n') : text;
}

const seconds = (ms?: number) => (ms === undefined ? '' : `${(ms / 1000).toFixed(1)}s`);

/** Ask the composer on screen to insert text (same channel as the terminal's "→ Chat"). */
function insertIntoComposer(text: string) {
  window.dispatchEvent(new CustomEvent('vibe:insert-composer', { detail: { text, handled: false } }));
}

/** One verification run in the transcript: a spinner while running, a quiet line when it passes, the failing output otherwise. */
export function VerifyItem({ item, latest, onRerun }: { item: VerifyItemData; latest: boolean; onRerun?: () => void }) {
  useLang();
  const failed = item.status === 'failed';
  const [open, setOpen] = useState(failed && latest);
  useEffect(() => { if (failed && latest) setOpen(true); }, [failed, latest]);
  const sendFailure = () => insertIntoComposer(t('verify.fixPrompt', { command: item.command, code: item.exitCode ?? '?', output: tail(item.output ?? '', 120) }));

  if (item.status === 'running') {
    return (
      <div className="flex items-center gap-2 text-[11.5px] text-zinc-400 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
        <span className="inline-block w-3 h-3 rounded-full border-2 border-sky-400/70 border-t-transparent animate-spin" />
        <span className="whitespace-nowrap shrink-0">{t('verify.running')}</span>
        <code className="truncate min-w-0 text-zinc-500 font-mono text-[11px]">{item.command}</code>
      </div>
    );
  }
  if (item.status === 'passed' || item.status === 'cancelled') {
    return (
      <div className={`flex items-center gap-2 text-[11.5px] ${item.status === 'passed' ? 'text-emerald-300/90' : 'text-zinc-500'}`}>
        <span className={`w-4 h-4 shrink-0 rounded-full flex items-center justify-center ${item.status === 'passed' ? 'bg-emerald-400/15' : 'bg-white/5'}`}>
          <Icon name={item.status === 'passed' ? 'check' : 'close'} size={10} />
        </span>
        <span className="whitespace-nowrap shrink-0">{t(item.status === 'passed' ? 'verify.passed' : 'verify.cancelled')}</span>
        <code className="truncate min-w-0 text-zinc-500 font-mono text-[11px]">{item.command}</code>
        <span className="text-zinc-600 tabular-nums shrink-0">{seconds(item.durationMs)}</span>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/[0.06] text-[12px]">
      <div className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none" onClick={() => setOpen((v) => !v)}>
        <span className="w-4 h-4 shrink-0 rounded-full bg-red-400/20 text-red-300 flex items-center justify-center"><Icon name="close" size={10} /></span>
        <span className="text-red-200 font-medium whitespace-nowrap shrink-0">{t('verify.failed')}</span>
        <code className="truncate min-w-0 text-zinc-400 font-mono text-[11px]">{item.command}</code>
        <span className="text-zinc-500 tabular-nums shrink-0">exit {item.exitCode} · {seconds(item.durationMs)}</span>
        <div className="flex-1" />
        <button className="shrink-0 flex items-center gap-1 rounded-full bg-red-400/15 hover:bg-red-400/25 text-red-100 px-2 py-0.5 text-[11px]"
          onClick={(e) => { e.stopPropagation(); sendFailure(); }} title={t('verify.sendHint')}><Icon name="send" size={11} /><span className="whitespace-nowrap">{t('verify.send')}</span></button>
        {onRerun && <button className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
          onClick={(e) => { e.stopPropagation(); onRerun(); }} title={t('verify.rerun')}><Icon name="reload" size={12} /></button>}
      </div>
      {open && item.output && (
        <pre className="max-h-72 overflow-auto border-t border-red-500/20 px-3 py-2 font-mono text-[11px] leading-[1.5] text-zinc-300 whitespace-pre-wrap break-all">{tail(item.output, 200)}</pre>
      )}
    </div>
  );
}

/** Chat header control: the project's verification command, auto-run toggle, and "run now". */
export function VerifyButton({ cwd, running, onRun }: { cwd: string; running: boolean; onRun: () => void }) {
  useLang();
  const [open, setOpen] = useState(false);
  const [command, setCommand] = useState('');
  const [auto, setAuto] = useState(false);
  const [saved, setSaved] = useState<{ command: string; auto: boolean } | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const load = () => api.projectVerify(cwd).then((r) => {
    setSaved({ command: r.command, auto: r.auto }); setCommand(r.command); setAuto(r.auto); setSuggestions(r.suggestions);
  }).catch(() => setSaved({ command: '', auto: false }));
  useEffect(() => { setSaved(null); void load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [cwd]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); setOpen(false); } };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, [open]);

  const save = async (nextCommand = command, nextAuto = auto) => {
    setError(null);
    try {
      const r = await api.saveProjectVerify(cwd, nextCommand, nextAuto);
      setSaved(r); setCommand(r.command); setAuto(r.auto);
      return r;
    } catch (e) { setError((e as Error).message); return null; }
  };
  const dirty = !!saved && (saved.command !== command.trim() || saved.auto !== auto);
  const active = !!saved?.command;

  return (
    <div ref={root} className="relative">
      <button className={`flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-1 ${active ? (saved?.auto ? 'text-sky-300 hover:bg-sky-400/10' : 'text-zinc-300 hover:bg-white/10') : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'}`}
        onClick={() => setOpen((v) => !v)} title={active ? `${t('verify.title')}: ${saved?.command}` : t('verify.title')}>
        <Icon name="shieldCheck" size={14} />
        <span className="@max-[520px]:hidden">{t('verify.short')}</span>
        {saved?.auto && <span className="text-[9px] uppercase tracking-wide rounded-full bg-sky-400/15 px-1">auto</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-30 w-[380px] glass-pop pop-in rounded-xl p-3 space-y-3 text-[12px]">
          <div>
            <div className="text-zinc-200 font-medium">{t('verify.title')}</div>
            <div className="text-[11px] text-zinc-500 leading-relaxed mt-0.5">{t('verify.about')}</div>
          </div>
          <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder={suggestions[0] ?? 'npm test'} spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save(); }}
            className="w-full rounded-md bg-black/40 border border-white/10 focus:border-sky-400/50 px-2 py-1.5 font-mono text-[11.5px] outline-none" />
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {suggestions.map((s) => (
                <button key={s} onClick={() => setCommand(s)} className={`rounded-full px-1.5 py-0.5 font-mono text-[10.5px] ${command === s ? 'bg-sky-400/20 text-sky-200' : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'}`}>{s}</button>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 cursor-pointer text-zinc-300">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            {t('verify.auto')}
          </label>
          {error && <div className="text-red-300 text-[11px]">{error}</div>}
          <div className="flex items-center gap-2">
            <button disabled={!dirty} onClick={() => void save()} className="rounded-full bg-sky-500/25 hover:bg-sky-500/35 disabled:opacity-40 px-2.5 py-1 text-sky-100">{t('common.save')}</button>
            <div className="flex-1" />
            <button disabled={!command.trim() || running}
              onClick={async () => { const r = dirty ? await save() : saved; if (r?.command) { onRun(); setOpen(false); } }}
              className="flex items-center gap-1 rounded-full bg-fill-2 hover:bg-fill-3 transition-colors disabled:opacity-40 px-2.5 py-1 text-zinc-200" title={running ? t('verify.busy') : undefined}>
              <Icon name="play" size={11} filled />{t('verify.runNow')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
