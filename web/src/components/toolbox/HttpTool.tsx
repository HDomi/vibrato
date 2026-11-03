import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ProxyResult } from '../../lib/api';
import { parseCurl, toCurl, type HttpRequestSpec } from '../../lib/toolbox/curl';
import { base64ToBytes } from '../../lib/toolbox/bytes';
import { t } from '../../lib/i18n';
import { Check, Code, CopyButton, Seg, btn, btnPrimary, errText, input, mono, select, usePersisted } from './ui';
import { openTool, takePayload } from './bus';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
type Row = { k: string; v: string; on: boolean };
type BodyType = 'none' | 'json' | 'text' | 'form';
type Tab = 'params' | 'headers' | 'body' | 'auth' | 'options';
interface Draft { method: string; url: string; headers: Row[]; bodyType: BodyType; body: string; form: Row[]; follow: boolean; insecure: boolean; timeout: number }
interface HistoryItem { at: number; draft: Draft; status?: number; ms?: number }

const EMPTY: Draft = { method: 'GET', url: '', headers: [{ k: '', v: '', on: true }], bodyType: 'none', body: '', form: [{ k: '', v: '', on: true }], follow: true, insecure: false, timeout: 30 };
const HIGHLIGHT_MAX = 300_000;

function queryRows(url: string): Row[] {
  const i = url.indexOf('?');
  if (i < 0) return [];
  return url.slice(i + 1).split('#')[0].split('&').filter(Boolean).map((kv) => {
    const j = kv.indexOf('=');
    const d = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
    return { k: d(j < 0 ? kv : kv.slice(0, j)), v: d(j < 0 ? '' : kv.slice(j + 1)), on: true };
  });
}

function withQuery(url: string, rows: Row[]): string {
  const [base, hash] = url.split('#');
  const path = base.split('?')[0];
  const q = rows.filter((r) => r.on && r.k).map((r) => `${encodeURIComponent(r.k)}=${encodeURIComponent(r.v)}`).join('&');
  return `${path}${q ? `?${q}` : ''}${hash !== undefined ? `#${hash}` : ''}`;
}

function fromSpec(r: HttpRequestSpec): Draft {
  const ct = r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  return {
    ...EMPTY, method: r.method, url: r.url, follow: r.followRedirects ?? true, insecure: !!r.insecure,
    headers: [...r.headers.map(([k, v]) => ({ k, v, on: true })), { k: '', v: '', on: true }],
    bodyType: r.form?.length ? 'form' : r.body === undefined ? 'none' : /json/i.test(ct) ? 'json' : 'text',
    body: r.body ?? '', form: [...(r.form ?? []).map((f) => ({ k: f.name, v: f.value, on: true })), { k: '', v: '', on: true }],
  };
}

/** The request as actually sent: enabled rows, implied Content-Type, and form body encoding. */
function toSpec(d: Draft): HttpRequestSpec {
  const headers: [string, string][] = d.headers.filter((r) => r.on && r.k.trim()).map((r) => [r.k.trim(), r.v]);
  const has = (n: string) => headers.some(([k]) => k.toLowerCase() === n);
  let body: string | undefined;
  if (d.bodyType === 'json' || d.bodyType === 'text') body = d.body;
  if (d.bodyType === 'form') body = d.form.filter((r) => r.on && r.k).map((r) => `${encodeURIComponent(r.k)}=${encodeURIComponent(r.v)}`).join('&');
  if (d.bodyType === 'json' && !has('content-type')) headers.push(['Content-Type', 'application/json']);
  if (d.bodyType === 'form' && !has('content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(d.url.trim()) ? d.url.trim() : `http://${d.url.trim()}`;
  return { method: d.method, url, headers, body, followRedirects: d.follow, insecure: d.insecure };
}

export default function HttpTool() {
  const [d, setD] = usePersisted<Draft>('http.draft', EMPTY);
  const [tab, setTab] = usePersisted<Tab>('http.tab', 'params');
  const [history, setHistory] = usePersisted<HistoryItem[]>('http.history', []);
  const [res, setRes] = useState<ProxyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [auth, setAuth] = useState<{ type: 'bearer' | 'basic'; token: string; user: string; pass: string }>({ type: 'bearer', token: '', user: '', pass: '' });
  const urlRef = useRef<HTMLInputElement>(null);
  const set = (p: Partial<Draft>) => setD((cur) => ({ ...cur, ...p }));

  useEffect(() => { const p = takePayload<{ request: HttpRequestSpec }>('http'); if (p?.request) { setD(fromSpec(p.request)); setRes(null); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (!d.url.trim() || busy) return;
    setBusy(true); setErr(null);
    const spec = toSpec(d);
    try {
      const r = await api.netHttp({ method: spec.method, url: spec.url, headers: spec.headers, body: spec.body, followRedirects: spec.followRedirects, insecure: spec.insecure, timeoutMs: d.timeout * 1000 });
      setRes(r);
      setHistory((h) => [{ at: Date.now(), draft: d, status: r.ok ? r.status : undefined, ms: r.timing.total }, ...h.filter((x) => x.draft.method !== d.method || x.draft.url !== d.url)].slice(0, 30));
    } catch (e) { setErr(errText(e)); setRes(null); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const onUrl = (v: string) => {
    // Pasting a whole curl command into the URL box imports it.
    if (/^\s*curl\s/i.test(v)) { try { setD(fromSpec(parseCurl(v))); return; } catch (e) { setErr(errText(e)); } }
    set({ url: v });
  };
  const params = queryRows(d.url);
  const enabledHeaders = d.headers.filter((r) => r.on && r.k).length;
  const applyAuth = () => {
    const value = auth.type === 'bearer' ? `Bearer ${auth.token.trim()}` : `Basic ${btoa(unescape(encodeURIComponent(`${auth.user}:${auth.pass}`)))}`;
    const rows = d.headers.filter((r) => r.k.toLowerCase() !== 'authorization' && (r.k || r.v));
    set({ headers: [...rows, { k: 'Authorization', v: value, on: true }, { k: '', v: '', on: true }] });
    setTab('headers');
  };

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      <div className="flex items-center gap-3">
        <select className={`${select} py-1.5 font-mono text-[12px]`} value={d.method} onChange={(e) => set({ method: e.target.value })}>
          {METHODS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <input ref={urlRef} className={`${input} flex-1 py-1.5`} value={d.url} onChange={(e) => onUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
          placeholder={t('tb.http.urlPlaceholder')} spellCheck={false} autoFocus />
        <button className={`${btnPrimary} px-4 py-1.5`} disabled={busy || !d.url.trim()} onClick={() => void send()}>{busy ? t('tb.http.sending') : t('tb.http.send')}</button>
        <CopyButton text={d.url ? toCurl(toSpec(d)) : ''} label={t('tb.http.copyCurl')} />
        <button className={btn} onClick={() => { setD(EMPTY); setRes(null); urlRef.current?.focus(); }}>{t('tb.http.new')}</button>
      </div>
      {err && <div className="text-[11px] text-red-400">{err}</div>}
      <div className="flex-1 grid grid-cols-2 gap-4 min-h-0">
        <div className="flex flex-col gap-3 min-h-0">
          <Seg value={tab} onChange={setTab} className="self-start" options={[
            { value: 'params', label: `${t('tb.http.params')}${params.length ? ` ${params.length}` : ''}` },
            { value: 'headers', label: `${t('tb.http.headers')}${enabledHeaders ? ` ${enabledHeaders}` : ''}` },
            { value: 'body', label: `${t('tb.http.body')}${d.bodyType !== 'none' ? ' •' : ''}` },
            { value: 'auth', label: t('tb.http.auth') },
            { value: 'options', label: t('tb.http.options') },
          ]} />
          <div className="flex-1 min-h-0 overflow-y-auto">
            {tab === 'params' && <KV rows={[...params, { k: '', v: '', on: true }]} onChange={(rows) => set({ url: withQuery(d.url, rows) })} />}
            {tab === 'headers' && <KV rows={d.headers} onChange={(rows) => set({ headers: rows })} suggest />}
            {tab === 'body' && (
              <div className="h-full flex flex-col gap-3">
                <Seg value={d.bodyType} onChange={(v) => set({ bodyType: v })} className="self-start" options={[{ value: 'none', label: t('tb.http.none') }, { value: 'json', label: 'JSON' }, { value: 'text', label: t('tb.http.text') }, { value: 'form', label: 'x-www-form-urlencoded' }]} />
                {(d.bodyType === 'json' || d.bodyType === 'text') && <>
                  <textarea className={`flex-1 min-h-[120px] w-full resize-none rounded-md border px-2.5 py-2 ${mono} outline-none bg-white/[.03] text-zinc-200 ${d.bodyType === 'json' && d.body.trim() && !isJson(d.body) ? 'border-amber-500/50' : 'border-white/10 focus:border-blue-400/50'}`}
                    value={d.body} onChange={(e) => set({ body: e.target.value })} spellCheck={false} placeholder={d.bodyType === 'json' ? '{\n  "key": "value"\n}' : ''} />
                  {d.bodyType === 'json' && <div className="flex gap-2">
                    <button className={btn} disabled={!isJson(d.body)} onClick={() => set({ body: JSON.stringify(JSON.parse(d.body), null, 2) })}>{t('tb.json.format')}</button>
                    {d.body.trim() && !isJson(d.body) && <span className="text-[11px] text-amber-400 self-center">{t('tb.http.notJson')}</span>}
                  </div>}
                </>}
                {d.bodyType === 'form' && <KV rows={d.form} onChange={(rows) => set({ form: rows })} />}
              </div>
            )}
            {tab === 'auth' && (
              <div className="flex flex-col gap-3 text-[11px] text-zinc-500">
                <Seg value={auth.type} onChange={(v) => setAuth((a) => ({ ...a, type: v }))} className="self-start" options={[{ value: 'bearer', label: 'Bearer' }, { value: 'basic', label: 'Basic' }]} />
                {auth.type === 'bearer'
                  ? <input className={input} value={auth.token} onChange={(e) => setAuth((a) => ({ ...a, token: e.target.value.replace(/^Bearer\s+/i, '') }))} placeholder="token" spellCheck={false} />
                  : <div className="flex gap-3"><input className={`${input} flex-1`} value={auth.user} onChange={(e) => setAuth((a) => ({ ...a, user: e.target.value }))} placeholder="user" spellCheck={false} /><input type="password" className={`${input} flex-1`} value={auth.pass} onChange={(e) => setAuth((a) => ({ ...a, pass: e.target.value }))} placeholder="password" /></div>}
                <button className={`${btn} self-start`} disabled={auth.type === 'bearer' ? !auth.token.trim() : !auth.user} onClick={applyAuth}>{t('tb.http.applyAuth')}</button>
                <div>{t('tb.http.authNote')}</div>
              </div>
            )}
            {tab === 'options' && (
              <div className="flex flex-col gap-3 text-[11px] text-zinc-500">
                <Check label={t('tb.http.follow')} checked={d.follow} onChange={(v) => set({ follow: v })} />
                <Check label={t('tb.http.insecure')} checked={d.insecure} onChange={(v) => set({ insecure: v })} />
                <label className="flex items-center gap-3">{t('tb.http.timeout')}<input type="number" min={1} max={300} className={`${input} w-20`} value={d.timeout} onChange={(e) => set({ timeout: Math.min(300, Math.max(1, Number(e.target.value) || 30)) })} />s</label>
                <div className="leading-relaxed">{t('tb.http.proxyNote')}</div>
              </div>
            )}
          </div>
          {history.length > 0 && (
            <div className="shrink-0 max-h-[34%] flex flex-col min-h-0">
              <div className="h-7 shrink-0 flex items-center text-[11px] text-zinc-500"><span className="flex-1">{t('tb.http.history')}</span><button className={btn} onClick={() => setHistory([])}>{t('tb.clear')}</button></div>
              <div className="overflow-y-auto rounded-md border border-white/10 divide-y divide-white/5">
                {history.map((h, i) => (
                  <button key={i} onClick={() => { setD(h.draft); setRes(null); }} className="w-full flex items-center gap-3 px-2.5 py-1 text-left text-[11.5px] hover:bg-white/5">
                    <span className={`w-14 shrink-0 font-mono ${methodColor(h.draft.method)}`}>{h.draft.method}</span>
                    <span className="flex-1 min-w-0 truncate font-mono text-zinc-300">{h.draft.url}</span>
                    {h.status !== undefined && <span className={`shrink-0 font-mono ${statusColor(h.status)}`}>{h.status}</span>}
                    <span className="shrink-0 w-14 text-right text-zinc-600">{h.ms}ms</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <Response res={res} busy={busy} />
      </div>
    </div>
  );
}

const isJson = (s: string) => { try { JSON.parse(s); return true; } catch { return false; } };
const methodColor = (m: string) => ({ GET: 'text-emerald-300', POST: 'text-amber-300', PUT: 'text-sky-300', PATCH: 'text-purple-300', DELETE: 'text-red-300' } as Record<string, string>)[m] ?? 'text-zinc-400';
const statusColor = (s: number) => (s < 300 ? 'text-emerald-300' : s < 400 ? 'text-sky-300' : s < 500 ? 'text-amber-300' : 'text-red-300');
const COMMON_HEADERS = ['Accept', 'Authorization', 'Content-Type', 'Cookie', 'User-Agent', 'Origin', 'Referer', 'Cache-Control', 'If-None-Match', 'X-Requested-With', 'X-API-Key'];

/** Editable key/value rows; a blank row is kept at the end. */
function KV({ rows, onChange, suggest }: { rows: Row[]; onChange: (rows: Row[]) => void; suggest?: boolean }) {
  const norm = (list: Row[]) => { const kept = list.filter((r, i) => r.k || r.v || i === list.length - 1); return kept.length && !kept[kept.length - 1].k && !kept[kept.length - 1].v ? kept : [...kept, { k: '', v: '', on: true }]; };
  const upd = (i: number, p: Partial<Row>) => onChange(norm(rows.map((r, j) => (j === i ? { ...r, ...p } : r))));
  return (
    <div className="flex flex-col gap-1.5">
      {suggest && <datalist id="http-headers">{COMMON_HEADERS.map((h) => <option key={h} value={h} />)}</datalist>}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <input type="checkbox" checked={r.on} onChange={(e) => upd(i, { on: e.target.checked })} className={!r.k && !r.v ? 'invisible' : ''} />
          <input className={`${input} w-[38%] ${r.on ? '' : 'opacity-50'}`} value={r.k} list={suggest ? 'http-headers' : undefined} onChange={(e) => upd(i, { k: e.target.value })} placeholder="key" spellCheck={false} />
          <input className={`${input} flex-1 ${r.on ? '' : 'opacity-50'}`} value={r.v} onChange={(e) => upd(i, { v: e.target.value })} placeholder="value" spellCheck={false} />
          <button className={`w-6 h-6 shrink-0 rounded-full text-zinc-500 hover:text-white hover:bg-white/10 ${!r.k && !r.v ? 'invisible' : ''} transition-colors`} onClick={() => onChange(norm(rows.filter((_, j) => j !== i)))}>×</button>
        </div>
      ))}
    </div>
  );
}

function Response({ res, busy }: { res: ProxyResult | null; busy: boolean }) {
  const [view, setView] = usePersisted<'pretty' | 'raw' | 'headers'>('http.resView', 'pretty');
  const ct = res?.ok ? res.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '' : '';
  const json = useMemo(() => { if (!res?.ok || res.encoding !== 'utf8') return null; try { return JSON.parse(res.body) as unknown; } catch { return null; } }, [res]);
  const pretty = json !== null ? JSON.stringify(json, null, 2) : res?.ok && res.encoding === 'utf8' ? res.body : '';
  const isImage = res?.ok && res.encoding === 'base64' && /^image\//i.test(ct);
  if (!res) return <div className="rounded-md border border-white/10 flex items-center justify-center text-[12px] text-zinc-600">{busy ? t('tb.http.sending') : t('tb.http.noResponse')}</div>;
  if (!res.ok) return (
    <div className="rounded-md border border-red-500/30 bg-red-500/5 p-4 text-[12px] flex flex-col gap-2">
      <div className="text-red-300 font-medium">{res.code ?? 'ERROR'}</div>
      <div className="text-zinc-300 break-all">{res.error}</div>
      <div className="text-zinc-500">{res.timing.total} ms</div>
    </div>
  );
  const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(2)} MB`);
  return (
    <div className="flex flex-col gap-2 min-h-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        <span className={`font-mono font-semibold ${statusColor(res.status)}`}>{res.status} {res.statusText}</span>
        <span className="text-zinc-500">{res.timing.total} ms <span className="text-zinc-600">(TTFB {res.timing.ttfb})</span></span>
        <span className="text-zinc-500">{kb(res.size)}{res.wireSize !== res.size && <span className="text-zinc-600"> · {t('tb.http.wire')} {kb(res.wireSize)}</span>}</span>
        {res.redirects.length > 0 && <span className="text-sky-400" title={res.redirects.map((r) => `${r.status} ${r.url}`).join('\n')}>↪ {res.redirects.length}</span>}
        {res.truncated && <span className="text-amber-400">{t('tb.http.truncated')}</span>}
      </div>
      <div className="flex items-center gap-2">
        <Seg value={view} onChange={setView} options={[{ value: 'pretty', label: t('tb.http.pretty') }, { value: 'raw', label: t('tb.http.raw') }, { value: 'headers', label: `${t('tb.http.headers')} ${res.headers.length}` }]} />
        <div className="flex-1" />
        {json !== null && <button className={btn} onClick={() => openTool('json', { text: res.body })}>{t('tb.http.openJson')}</button>}
      </div>
      {view === 'headers' ? (
        <div className="flex-1 min-h-0 overflow-auto rounded-md border border-white/10 divide-y divide-white/5 text-[12px]">
          {res.headers.map(([k, v], i) => (
            <div key={i} className="flex items-start gap-3 px-2.5 py-1">
              <span className="w-44 shrink-0 font-mono text-sky-300 break-all">{k}</span>
              <span className="flex-1 min-w-0 font-mono text-zinc-300 break-all">{v}</span>
            </div>
          ))}
        </div>
      ) : isImage ? (
        <div className="flex-1 min-h-0 overflow-auto rounded-md border border-white/10 flex items-center justify-center bg-[repeating-conic-gradient(#222_0_25%,#2a2a2a_0_50%)] bg-[length:16px_16px]">
          <img src={`data:${ct.split(';')[0]};base64,${res.body}`} className="max-w-full max-h-full" alt="" />
        </div>
      ) : res.encoding === 'base64' ? (
        <div className="flex-1 min-h-0 rounded-md border border-white/10 p-4 text-[12px] text-zinc-400 flex flex-col gap-2">
          <div>{t('tb.http.binary', { type: ct || '?', size: kb(res.size) })}</div>
          <CopyButton text={res.body} label={t('tb.http.copyBase64')} className="self-start" />
          <div className={`${mono} text-zinc-600 break-all line-clamp-6`}>{bytesPreview(res.body)}</div>
        </div>
      ) : view === 'raw' || pretty.length > HIGHLIGHT_MAX ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="h-7 shrink-0 flex items-center justify-end"><CopyButton text={res.body} /></div>
          <pre className={`flex-1 min-h-0 overflow-auto rounded-md border border-white/10 bg-white/[.03] px-2.5 py-2 ${mono} text-zinc-300 whitespace-pre-wrap break-all`}>{view === 'raw' ? res.body : pretty}</pre>
        </div>
      ) : (
        <Code className="flex-1 min-h-0" code={pretty} lang={json !== null ? 'json' : /html|xml/i.test(ct) ? 'xml' : /javascript/i.test(ct) ? 'javascript' : /css/i.test(ct) ? 'css' : 'plaintext'} />
      )}
    </div>
  );
}

function bytesPreview(b64: string): string {
  try { return [...base64ToBytes(b64.slice(0, 256))].slice(0, 96).map((x) => x.toString(16).padStart(2, '0')).join(' '); } catch { return ''; }
}
