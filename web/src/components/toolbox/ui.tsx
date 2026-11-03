import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { highlight } from '../../lib/highlight';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';

const LS = 'vibe.toolbox.';
const PERSIST_MAX = 200_000;

/**
 * Tool inputs survive mode switches and restarts. Values over 200 KB and anything secret
 * (keys, passphrases, plaintext to encrypt) must stay in plain useState instead.
 */
export function usePersisted<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(LS + key); return s === null ? initial : JSON.parse(s) as T; } catch { return initial; }
  });
  const timer = useRef(0);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      try {
        const s = JSON.stringify(v);
        if (s.length > PERSIST_MAX) localStorage.removeItem(LS + key); else localStorage.setItem(LS + key, s);
      } catch { /* quota exceeded: this value just will not be remembered */ }
    }, 300);
    return () => window.clearTimeout(timer.current);
  }, [key, v]);
  return [v, setV];
}

export const btn = 'shrink-0 px-2.5 py-1 rounded-full text-[11px] bg-fill-2 hover:bg-fill-3 text-zinc-200 transition-colors disabled:opacity-40 disabled:hover:bg-fill-2 disabled:cursor-default';
export const btnPrimary = 'shrink-0 px-3 py-1 rounded-full text-[11px] font-medium bg-selected hover:bg-white text-on-selected transition-colors disabled:opacity-40 disabled:hover:bg-selected disabled:cursor-default';
export const input = 'min-w-0 bg-black/20 border border-line rounded-lg px-2.5 py-1 text-[12px] text-zinc-200 outline-none transition-colors focus:border-white/30 font-mono placeholder:text-zinc-600';
export const select = 'bg-black/20 border border-line rounded-lg px-2 py-1 text-[11px] text-zinc-200 outline-none';
export const mono = 'font-mono text-[12.5px] leading-relaxed';

export function CopyButton({ text, label, className = '' }: { text: string; label?: string; className?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button className={`${btn} ${className}`} disabled={!text} title={t('common.copy')}
      onClick={() => navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }).catch(() => {})}>
      {ok ? t('common.copied') : (label ?? t('common.copy'))}
    </button>
  );
}

interface AreaProps {
  label?: ReactNode; value: string; onChange?: (v: string) => void; placeholder?: string; readOnly?: boolean; error?: string | null;
  actions?: ReactNode; className?: string; minRows?: number; autoFocus?: boolean; spell?: boolean; copy?: boolean;
}

/** Labeled monospace textarea with a copy button; the one block every tool is built from. */
export function Area({ label, value, onChange, placeholder, readOnly, error, actions, className = '', minRows = 4, autoFocus, spell = false, copy = true }: AreaProps) {
  return (
    <div className={`flex flex-col min-h-0 ${className}`}>
      {(label || actions || copy) && (
        <div className="h-7 shrink-0 mb-1 flex items-center gap-2 text-[11px] text-zinc-500">
          <span className="flex-1 truncate">{label}</span>
          {actions}
          {copy && <CopyButton text={value} />}
        </div>
      )}
      <textarea spellCheck={spell} value={value} onChange={(e) => onChange?.(e.target.value)} readOnly={readOnly} placeholder={placeholder} autoFocus={autoFocus}
        style={{ minHeight: `${minRows * 1.5 + 1.2}em` }}
        className={`flex-1 w-full resize-none rounded-2xl border px-3 py-2.5 ${mono} outline-none bg-black/20 text-zinc-200 transition-colors placeholder:text-zinc-600 ${readOnly ? 'text-zinc-300' : ''} ${error ? 'border-red-500/50' : 'border-line focus:border-white/30'}`} />
      {error && <div className="mt-1 shrink-0 text-[11px] text-red-400 whitespace-pre-wrap break-all">{error}</div>}
    </div>
  );
}

export function Seg<T extends string>({ value, onChange, options, className = '' }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string }) {
  return (
    <div className={`inline-flex items-center rounded-full bg-black/20 border border-line p-0.5 ${className}`}>
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={`px-2.5 py-0.5 rounded-full text-[11px] whitespace-nowrap transition-colors duration-150 ${value === o.value ? 'bg-selected text-on-selected' : 'text-zinc-400 hover:text-zinc-200'}`}>{o.label}</button>
      ))}
    </div>
  );
}

export function Field({ label, children, className = '' }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`flex items-center gap-2 text-[11px] text-zinc-500 min-w-0 ${className}`}>
      <span className="shrink-0">{label}</span>
      {children}
    </label>
  );
}

export function Check({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** Key/value rows with a copy button per value. */
export function Rows({ rows }: { rows: { label: ReactNode; value: string; hint?: ReactNode }[] }) {
  return (
    <div className="rounded-2xl border border-line bg-black/15 divide-y divide-white/5 overflow-hidden">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
          <span className="w-28 shrink-0 text-zinc-500 text-[11px]">{r.label}</span>
          <span className={`flex-1 min-w-0 truncate ${mono} text-zinc-200`} title={r.value}>{r.value}</span>
          {r.hint && <span className="shrink-0 text-[11px] text-zinc-500">{r.hint}</span>}
          <CopyButton text={r.value} />
        </div>
      ))}
    </div>
  );
}

export function Section({ title, children, className = '', actions }: { title: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-zinc-500">
        <span>{title}</span>
        <div className="flex-1" />
        {actions}
      </div>
      {children}
    </section>
  );
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Read-only highlighted code block with a header row (label, actions, copy). */
export function Code({ code, lang, label, actions, className = '', error, wrap }: { code: string; lang: string; label?: ReactNode; actions?: ReactNode; className?: string; error?: string | null; wrap?: boolean }) {
  const html = useMemo(() => (code ? highlight(code, lang) : ''), [code, lang]);
  return (
    <div className={`flex flex-col min-h-0 ${className}`}>
      <div className="h-7 shrink-0 mb-1 flex items-center gap-2 text-[11px] text-zinc-500">
        <span className="flex-1 truncate">{label}</span>
        {actions}
        <CopyButton text={code} />
      </div>
      <pre className={`hljs flex-1 min-h-[3em] overflow-auto rounded-2xl border px-3 py-2.5 ${mono} !bg-black/20 ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'} ${error ? 'border-red-500/50' : 'border-line'}`}>
        {error ? <span className="text-red-400 whitespace-pre-wrap">{error}</span> : <code dangerouslySetInnerHTML={{ __html: html }} />}
      </pre>
    </div>
  );
}

/** Native Save As in the app (writes through the server); a download in a plain browser tab. Resolves to the saved path or null. */
export async function saveBytes(name: string, base64: string): Promise<string | null> {
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  if (window.vibe?.saveDialog) {
    const target = await window.vibe.saveDialog({ defaultPath: name, ext });
    if (!target) return null;
    await api.imageWrite(target, base64, true);
    return target;
  }
  const a = document.createElement('a');
  a.href = `data:application/octet-stream;base64,${base64}`;
  a.download = name;
  a.click();
  return name;
}

export function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

/** Click to pick, drop a file, or paste one (⌘V) while the tool is on screen. */
export function DropZone({ accept, onFile, children, className = '' }: { accept?: string; onFile: (f: File) => void; children: ReactNode; className?: string }) {
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
      const f = [...(e.clipboardData?.files ?? [])][0];
      if (f) { e.preventDefault(); onFile(f); }
    };
    window.addEventListener('paste', h);
    return () => window.removeEventListener('paste', h);
  }, [onFile]);
  return (
    <div onClick={() => ref.current?.click()} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
      className={`cursor-pointer rounded-2xl border border-dashed transition-colors flex items-center justify-center text-center text-[12px] text-zinc-500 ${over ? 'border-blue-400 bg-blue-500/10' : 'border-white/15 hover:border-white/30 hover:bg-white/[.02]'} ${className}`}>
      <input ref={ref} type="file" accept={accept} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
      {children}
    </div>
  );
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(2)} MB`);
