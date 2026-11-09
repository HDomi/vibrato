import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t, useLang } from '../../lib/i18n';
import Icon from '../Icon';
import type { BrowserAgentEntry, BrowserBridge, BrowserConsoleEntry, BrowserCookie, BrowserNetEntry, BrowserStorageArea, BrowserStorageResult, BrowserTab } from '../../lib/vibe';

/**
 * The in-app browser window (`/?browser=1`, electron/browser.cts). The page itself is a native WKWebView that
 * the main process lays over the `hole` element below; everything around it (tabs, address bar, Console,
 * Network, the agent's actions) is this React UI. The debug panel can sit on any side of the page or be hidden.
 */

type Dock = 'right' | 'bottom' | 'left' | 'top' | 'hidden';
type Pane = 'console' | 'network' | 'storage' | 'agent';
const LS_DOCK = 'vibe.browser.dock';
const LS_SIZE = 'vibe.browser.dockSize';
const LS_PANE = 'vibe.browser.pane';
const MAX_ROWS = 2000;
const DOCKS: Dock[] = ['right', 'bottom', 'left', 'top', 'hidden'];

const read = <T extends string>(k: string, ok: readonly T[], d: T): T => { try { const v = localStorage.getItem(k) as T; return ok.includes(v) ? v : d; } catch { return d; } };
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const host = (u: string) => { try { const x = new URL(u); return x.host + x.pathname; } catch { return u; } };

export default function BrowserApp() {
  useLang();
  const bridge = window.vibe?.browser;
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [logs, setLogs] = useState<BrowserConsoleEntry[]>([]);
  const [nets, setNets] = useState<BrowserNetEntry[]>([]);
  const [agent, setAgent] = useState<BrowserAgentEntry[]>([]);
  const [dock, setDock] = useState<Dock>(() => read(LS_DOCK, DOCKS, 'right'));
  const [pane, setPane] = useState<Pane>(() => read(LS_PANE, ['console', 'network', 'storage', 'agent'] as const, 'console'));
  const [size, setSize] = useState(() => { try { return Number(localStorage.getItem(LS_SIZE)) || 420; } catch { return 420; } });
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const hole = useRef<HTMLDivElement>(null);

  useEffect(() => { document.title = 'Vibrato Browser'; }, []);
  useEffect(() => { try { localStorage.setItem(LS_DOCK, dock); localStorage.setItem(LS_PANE, pane); localStorage.setItem(LS_SIZE, String(size)); } catch { /* ignore */ } }, [dock, pane, size]);

  useEffect(() => {
    if (!bridge) { setAvailable(false); setError('Electron only'); return; }
    void bridge.info().then((info) => {
      if (!info) return;
      setAvailable(info.available); setError(info.error);
      setTabs(info.tabs); setActive(info.active); setLogs(info.console); setNets(info.net); setAgent(info.agent);
    });
    const offs = [
      bridge.on('tabs', (p: { tabs: BrowserTab[]; active: number | null }) => { setTabs(p.tabs); setActive(p.active); }),
      bridge.on('console', (e: BrowserConsoleEntry) => setLogs((l) => (l.length >= MAX_ROWS ? [...l.slice(-MAX_ROWS + 1), e] : [...l, e]))),
      bridge.on('net', (e: BrowserNetEntry) => setNets((l) => (l.length >= MAX_ROWS ? [...l.slice(-MAX_ROWS + 1), e] : [...l, e]))),
      bridge.on('agent', (e: BrowserAgentEntry) => setAgent((l) => [...l.slice(-199), e])),
    ];
    return () => offs.forEach((f) => f());
  }, [bridge]);

  const tab = tabs.find((x) => x.id === active) ?? null;
  useEffect(() => { if (!editing) setAddress(tab?.url && tab.url !== 'about:blank' ? tab.url : ''); }, [tab?.url, tab?.id, editing]);

  // Tell the main process where the page goes; null hides it (no tab, or nothing to show).
  const report = useCallback(() => {
    const el = hole.current;
    if (!bridge || !el || !tab) { bridge?.frame(null); return; }
    const r = el.getBoundingClientRect();
    bridge.frame({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  }, [bridge, tab]);
  useLayoutEffect(() => {
    report();
    const el = hole.current;
    if (!el) return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    return () => { ro.disconnect(); window.removeEventListener('resize', report); };
  }, [report, dock, size]);

  const open = (url = '') => { void bridge?.open(url || 'about:blank'); };
  const go = () => { const v = address.trim(); if (!v) return; if (tab) bridge?.navigate(v); else open(v); setEditing(false); (document.activeElement as HTMLElement)?.blur(); bridge?.nav('focus'); };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 'l') { e.preventDefault(); document.getElementById('vb-address')?.focus(); (document.getElementById('vb-address') as HTMLInputElement | null)?.select(); }
      else if (k === 't') { e.preventDefault(); open(); }
      else if (k === 'w' && tab) { e.preventDefault(); bridge?.close(tab.id); }
      else if (k === 'r') { e.preventDefault(); bridge?.nav('reload'); }
      else if (k === '[') { e.preventDefault(); bridge?.nav('back'); }
      else if (k === ']') { e.preventDefault(); bridge?.nav('forward'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // Resize the debug panel by dragging its inner edge.
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const vertical = dock === 'top' || dock === 'bottom';
    const start = vertical ? e.clientY : e.clientX;
    const from = size;
    const sign = dock === 'right' || dock === 'bottom' ? -1 : 1;
    const max = (vertical ? window.innerHeight : window.innerWidth) - 240;
    const move = (ev: PointerEvent) => setSize(Math.max(180, Math.min(max, from + sign * ((vertical ? ev.clientY : ev.clientX) - start))));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.cursor = vertical ? 'row-resize' : 'col-resize';
  };

  const errors = logs.filter((l) => l.level === 'error' && (!tab || l.tab === tab.id)).length;
  const failed = nets.filter((n) => (n.error || (n.status ?? 0) >= 400) && (!tab || n.tab === tab.id)).length;
  const vertical = dock === 'top' || dock === 'bottom';
  const flexDir = dock === 'right' ? 'flex-row' : dock === 'left' ? 'flex-row-reverse' : dock === 'bottom' ? 'flex-col' : 'flex-col-reverse';

  const debug = dock !== 'hidden' && (
    <>
      <div onPointerDown={startDrag} role="separator" className={`shrink-0 group relative ${vertical ? 'h-3 cursor-row-resize' : 'w-3 cursor-col-resize'}`}>
        <div className={`absolute rounded-full group-hover:bg-white/25 ${vertical ? 'inset-x-10 top-1/2 h-[3px] -mt-[1.5px]' : 'inset-y-10 left-1/2 w-[3px] -ml-[1.5px]'}`} />
      </div>
      <div className="glass shrink-0 flex flex-col min-w-0 min-h-0 overflow-hidden" style={vertical ? { height: size } : { width: size }}>
        <div className="h-10 shrink-0 flex items-center gap-1 px-2 border-b border-white/10">
          {([['console', t('browser.console'), errors], ['network', t('browser.network'), failed], ['storage', t('browser.storage'), 0], ['agent', t('browser.agent'), 0]] as const).map(([k, label, n]) => (
            <button key={k} onClick={() => setPane(k)} className={`h-7 px-3 rounded-full flex items-center gap-1.5 text-[12px] ${pane === k ? 'bg-fill-3 text-white' : 'text-zinc-300 hover:bg-fill hover:text-white'}`}>
              {label}{n > 0 && <span className="min-w-4 h-4 px-1 rounded-full bg-red-500/80 text-[10px] leading-4 text-white">{n}</span>}
            </button>
          ))}
          <div className="flex-1" />
          {pane !== 'storage' && <button title={t('browser.clear')} onClick={() => { const kind = pane === 'network' ? 'net' : pane === 'console' ? 'console' : 'agent'; bridge?.clear(kind); if (pane === 'console') setLogs([]); else if (pane === 'network') setNets([]); else setAgent([]); }}
            className="w-7 h-7 rounded-full text-zinc-400 hover:text-white hover:bg-fill flex items-center justify-center"><Icon name="undo" size={13} /></button>}
        </div>
        <div className="flex-1 min-h-0">
          {pane === 'console' && <ConsoleView rows={logs} tab={tab?.id ?? null} />}
          {pane === 'network' && <NetworkView rows={nets} tab={tab?.id ?? null} />}
          {pane === 'storage' && bridge && <StorageView bridge={bridge} tab={tab} />}
          {pane === 'agent' && <AgentView rows={agent} />}
        </div>
      </div>
    </>
  );

  return (
    <div className="app-wall h-full flex flex-col overflow-hidden text-zinc-200">
      {/* Title bar: window buttons, then the tabs. */}
      <div className="titlebar-drag h-[46px] shrink-0 flex items-end gap-1 pl-[84px] pr-3 pb-1.5">
        <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto no-scrollbar">
          {tabs.map((x) => (
            <div key={x.id} onClick={() => bridge?.activate(x.id)} title={x.url}
              className={`titlebar-nodrag group h-8 min-w-0 max-w-[220px] pl-3 pr-1.5 rounded-full flex items-center gap-1.5 text-[12px] cursor-default ${x.id === active ? 'glass-ctl text-white' : 'text-zinc-300 hover:bg-fill'}`}>
              {x.loading && <span className="w-1.5 h-1.5 rounded-full bg-sky-300 animate-pulse shrink-0" />}
              {x.agent && <span className="shrink-0 text-[9px] px-1 rounded bg-white/15 text-zinc-200">AI</span>}
              <span className="truncate">{x.title || host(x.url) || t('browser.newTab')}</span>
              <button onClick={(e) => { e.stopPropagation(); bridge?.close(x.id); }} aria-label={t('browser.closeTab')}
                className="w-5 h-5 shrink-0 rounded-full flex items-center justify-center text-zinc-400 opacity-0 group-hover:opacity-100 hover:bg-fill-2 hover:text-white"><Icon name="close" size={11} /></button>
            </div>
          ))}
          <button onClick={() => open()} title={t('browser.newTab')} className="titlebar-nodrag w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-zinc-400 hover:text-white hover:bg-fill"><Icon name="plus" size={14} /></button>
        </div>
        <select value={dock} onChange={(e) => setDock(e.target.value as Dock)} title={t('browser.dock')} className="titlebar-nodrag h-8 rounded-full px-3 text-[12px] glass-ctl">
          {DOCKS.map((d) => <option key={d} value={d}>{t(`browser.dock.${d}`)}</option>)}
        </select>
      </div>

      <div className={`flex-1 min-h-0 flex ${flexDir} px-3 pb-3`}>
        <div className="glass flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          <div className="h-11 shrink-0 flex items-center gap-1 px-2">
            <NavBtn icon="back" label={t('browser.back')} disabled={!tab?.canGoBack} onClick={() => bridge?.nav('back')} />
            <NavBtn icon="forward" label={t('browser.forward')} disabled={!tab?.canGoForward} onClick={() => bridge?.nav('forward')} />
            <NavBtn icon={tab?.loading ? 'stop' : 'reload'} label={t('browser.reload')} disabled={!tab} onClick={() => bridge?.nav(tab?.loading ? 'stop' : 'reload')} />
            <input id="vb-address" value={address} spellCheck={false} placeholder={t('browser.addressPlaceholder')}
              onFocus={(e) => { setEditing(true); e.target.select(); }} onBlur={() => setEditing(false)}
              onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') { setEditing(false); (e.target as HTMLInputElement).blur(); } }}
              className="flex-1 min-w-0 h-8 rounded-full px-4 text-[12.5px] bg-black/25 border border-white/10 focus:border-white/30 outline-none" />
            {tab && tab.zoom !== 1 && <button onClick={() => bridge?.zoom(1)} className="h-7 px-2 rounded-full text-[11px] text-zinc-300 hover:bg-fill">{Math.round(tab.zoom * 100)}%</button>}
            <NavBtn icon="search" label={t('browser.zoomOut')} disabled={!tab} onClick={() => bridge?.zoom((tab?.zoom ?? 1) - 0.1)} text="−" />
            <NavBtn icon="search" label={t('browser.zoomIn')} disabled={!tab} onClick={() => bridge?.zoom((tab?.zoom ?? 1) + 0.1)} text="+" />
          </div>
          {tab?.loading && <div className="h-[2px] shrink-0 bg-sky-300/70 transition-[width] duration-300" style={{ width: `${Math.max(8, (tab.progress ?? 0) * 100)}%` }} />}
          {/* The native page sits exactly over this box. */}
          <div ref={hole} className="flex-1 min-h-0 bg-white/[.03] relative">
            {available === false && <Empty title={t('browser.unavailable')} body={error} />}
            {available && !tab && <Empty title={t('browser.empty')} body={t('browser.emptyNote')} action={t('browser.newTab')} onAction={() => open()} />}
          </div>
        </div>
        {debug}
      </div>
    </div>
  );
}

function NavBtn({ icon, label, onClick, disabled, text }: { icon: 'back' | 'forward' | 'reload' | 'stop' | 'search'; label: string; onClick: () => void; disabled?: boolean; text?: string }) {
  return (
    <button title={label} aria-label={label} onClick={onClick} disabled={disabled}
      className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-zinc-300 hover:text-white hover:bg-fill disabled:opacity-30 disabled:hover:bg-transparent">
      {text ? <span className="text-[15px] leading-none">{text}</span> : <Icon name={icon} size={14} />}
    </button>
  );
}

function Empty({ title, body, action, onAction }: { title: string; body?: string; action?: string; onAction?: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-8">
      <div className="text-[14px] text-zinc-200">{title}</div>
      {body && <div className="text-[12px] text-zinc-400 max-w-md leading-relaxed whitespace-pre-wrap">{body}</div>}
      {action && <button onClick={onAction} className="mt-2 h-8 px-4 rounded-full glass-ctl text-[12px]">{action}</button>}
    </div>
  );
}

function useStick(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useLayoutEffect(() => { const el = ref.current; if (el && stuck.current) el.scrollTop = el.scrollHeight; }, [dep]);
  const onScroll = () => { const el = ref.current; if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; };
  return { ref, onScroll };
}

const LEVEL_COLOR: Record<string, string> = { error: 'text-red-300', warn: 'text-amber-200', info: 'text-sky-200', debug: 'text-zinc-500' };

function ConsoleView({ rows, tab }: { rows: BrowserConsoleEntry[]; tab: number | null }) {
  const [level, setLevel] = useState<'all' | 'warn' | 'error'>('all');
  const [q, setQ] = useState('');
  const shown = useMemo(() => rows.filter((r) => (tab === null || r.tab === tab) && (level === 'all' || (level === 'error' ? r.level === 'error' : r.level === 'error' || r.level === 'warn')) && (!q || r.text.toLowerCase().includes(q.toLowerCase()))), [rows, tab, level, q]);
  const stick = useStick(shown.length);
  return (
    <div className="h-full flex flex-col">
      <Filters q={q} setQ={setQ}>
        <select value={level} onChange={(e) => setLevel(e.target.value as typeof level)} className="h-6 rounded-full px-2 text-[11px] glass-ctl">
          <option value="all">{t('browser.level.all')}</option><option value="warn">{t('browser.level.warn')}</option><option value="error">{t('browser.level.error')}</option>
        </select>
      </Filters>
      <div ref={stick.ref} onScroll={stick.onScroll} className="flex-1 min-h-0 overflow-auto font-mono text-[11px] leading-[1.45] px-3 py-1 select-text">
        {shown.length === 0 && <div className="text-zinc-500 py-3">{t('browser.noConsole')}</div>}
        {shown.map((r) => (
          <div key={r.seq} className={`py-1 border-b border-white/5 whitespace-pre-wrap break-words ${LEVEL_COLOR[r.level] ?? 'text-zinc-200'}`}>
            <span className="text-zinc-500 mr-2">{time(r.t)}</span>{r.text}{r.source && <span className="text-zinc-500"> — {r.source}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function NetworkView({ rows, tab }: { rows: BrowserNetEntry[]; tab: number | null }) {
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [onlyApi, setOnlyApi] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const shown = useMemo(() => rows.filter((r) => (tab === null || r.tab === tab) && (!onlyFailed || r.error || (r.status ?? 0) >= 400) && (!onlyApi || r.via === 'fetch' || r.via === 'xhr') && (!q || r.url.toLowerCase().includes(q.toLowerCase()))), [rows, tab, onlyFailed, onlyApi, q]);
  const stick = useStick(shown.length);
  return (
    <div className="h-full flex flex-col">
      <Filters q={q} setQ={setQ}>
        <Toggle on={onlyApi} set={setOnlyApi} label="Fetch/XHR" />
        <Toggle on={onlyFailed} set={setOnlyFailed} label={t('browser.failedOnly')} />
      </Filters>
      <div ref={stick.ref} onScroll={stick.onScroll} className="flex-1 min-h-0 overflow-auto font-mono text-[11px] px-3 py-1 select-text">
        {shown.length === 0 && <div className="text-zinc-500 py-3">{t('browser.noNetwork')}</div>}
        {shown.map((r) => {
          const bad = !!r.error || (r.status ?? 0) >= 400;
          return (
            <div key={r.seq} onClick={() => setOpen(open === r.seq ? null : r.seq)} className={`py-1 border-b border-white/5 cursor-default ${bad ? 'text-red-300' : 'text-zinc-200'}`}>
              <div className="flex gap-2 min-w-0">
                <span className="w-10 shrink-0 text-zinc-400">{r.method}</span>
                <span className="w-9 shrink-0">{r.error ? 'ERR' : r.status ?? '—'}</span>
                <span className="w-16 shrink-0 text-zinc-500 truncate">{r.via}</span>
                <span className="flex-1 min-w-0 truncate">{host(r.url)}</span>
                <span className="shrink-0 text-zinc-500">{r.ms !== undefined ? `${r.ms}ms` : ''}</span>
              </div>
              {open === r.seq && <div className="mt-1 pl-1 text-zinc-400 whitespace-pre-wrap break-all">{r.url}{r.type ? `\n${r.type}` : ''}{r.size ? `\n${r.size} bytes` : ''}{r.error ? `\n${r.error}` : ''}{`\n${time(r.t)}`}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentView({ rows }: { rows: BrowserAgentEntry[] }) {
  const stick = useStick(rows.length);
  return (
    <div ref={stick.ref} onScroll={stick.onScroll} className="h-full overflow-auto px-3 py-2 text-[12px] select-text">
      {rows.length === 0 && <div className="text-zinc-500 py-3 leading-relaxed">{t('browser.noAgent')}</div>}
      {rows.map((r) => (
        <div key={r.seq} className="py-2 border-b border-white/5">
          <div className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.ok ? 'bg-emerald-400' : 'bg-red-400'}`} />
            <span className="font-mono text-zinc-100">{r.tool.replace(/^browser_/, '')}</span>
            <span className="text-zinc-500 text-[11px]">{time(r.t)} · {r.ms}ms</span>
          </div>
          {r.summary !== '{}' && <div className="mt-1 font-mono text-[11px] text-zinc-400 break-all">{r.summary}</div>}
          {r.result && <div className={`mt-1 font-mono text-[11px] whitespace-pre-wrap break-words max-h-40 overflow-auto ${r.ok ? 'text-zinc-300' : 'text-red-300'}`}>{r.result}</div>}
          {r.image && <img src={r.image} alt="" className="mt-2 rounded-lg border border-white/10 max-w-full" />}
        </div>
      ))}
    </div>
  );
}

function Filters({ q, setQ, children }: { q: string; setQ: (v: string) => void; children: React.ReactNode }) {
  return (
    <div className="h-9 shrink-0 flex items-center gap-1.5 px-2 border-b border-white/5">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('browser.filter')} spellCheck={false}
        className="flex-1 min-w-0 h-6 rounded-full px-3 text-[11px] bg-black/25 border border-white/10 focus:border-white/30 outline-none" />
      {children}
    </div>
  );
}

function Toggle({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) {
  return <button onClick={() => set(!on)} className={`h-6 px-2.5 rounded-full text-[11px] ${on ? 'bg-fill-3 text-white' : 'text-zinc-400 hover:bg-fill hover:text-white'}`}>{label}</button>;
}

/** localStorage / sessionStorage / cookies of the active tab: list, edit, add, delete, clear. */
function StorageView({ bridge, tab }: { bridge: BrowserBridge; tab: BrowserTab | null }) {
  const [area, setArea] = useState<BrowserStorageArea>('local');
  const [data, setData] = useState<BrowserStorageResult | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<{ key: string; value: string; isNew: boolean; cookie?: Partial<BrowserCookie> } | null>(null);
  const run = useCallback(async (op: Parameters<BrowserBridge['storage']>[0]) => {
    try { setErr(''); const r = await bridge.storage(op); setData(r); return r; }
    catch (e) { setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); return null; }
  }, [bridge]);
  const load = useCallback(() => { if (tab) void run({ action: 'get', area }); else setData(null); }, [run, area, tab]);
  useEffect(() => { setEdit(null); load(); }, [area, tab?.id, tab?.url, tab?.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => bridge.on('storage-changed', (e) => { if (e.tab === tab?.id) load(); }), [bridge, tab?.id, load]);

  const rows: { key: string; value: string; cookie?: BrowserCookie }[] = area === 'cookies'
    ? (data?.cookies ?? []).map((c) => ({ key: c.name, value: c.value, cookie: c }))
    : (data?.items ?? []).map(([key, value]) => ({ key, value }));
  const shown = rows.filter((r) => !q || r.key.toLowerCase().includes(q.toLowerCase()) || r.value.toLowerCase().includes(q.toLowerCase()));
  const save = async () => {
    if (!edit || !edit.key) return;
    const ok = area === 'cookies'
      ? await run({ action: 'set', area, cookie: { ...edit.cookie, name: edit.key, value: edit.value } })
      : await run({ action: 'set', area, key: edit.key, value: edit.value });
    if (ok) setEdit(null);
  };
  const remove = async (r: { key: string; cookie?: BrowserCookie }) => {
    await run(area === 'cookies' ? { action: 'remove', area, cookie: { name: r.key, domain: r.cookie?.domain, path: r.cookie?.path } } : { action: 'remove', area, key: r.key });
    setEdit(null);
  };
  const pretty = (v: string) => { try { const j = JSON.parse(v); return typeof j === 'object' && j !== null ? JSON.stringify(j, null, 2) : v; } catch { return v; } };

  if (!tab) return <div className="p-3 text-[12px] text-zinc-500">{t('browser.empty')}</div>;
  return (
    <div className="h-full flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-white/5">
        {(['local', 'session', 'cookies'] as const).map((a) => (
          <Toggle key={a} on={area === a} set={() => setArea(a)} label={t(`browser.storage.${a}`)} />
        ))}
        <div className="flex-1" />
        <button title={t('browser.storage.add')} onClick={() => setEdit({ key: '', value: '', isNew: true, cookie: area === 'cookies' ? { path: '/' } : undefined })} className="w-6 h-6 rounded-full flex items-center justify-center text-zinc-400 hover:text-white hover:bg-fill"><Icon name="plus" size={12} /></button>
        <button title={t('browser.reload')} onClick={load} className="w-6 h-6 rounded-full flex items-center justify-center text-zinc-400 hover:text-white hover:bg-fill"><Icon name="reload" size={12} /></button>
        <button title={t('browser.storage.clearAll')} disabled={!rows.length} onClick={() => { if (confirm(t('browser.storage.clearConfirm', { n: rows.length, origin: data?.origin ?? '' }))) void run({ action: 'clear', area }); }}
          className="h-6 px-2 rounded-full text-[11px] text-zinc-400 hover:text-red-300 hover:bg-fill disabled:opacity-30">{t('browser.storage.clearAll')}</button>
      </div>
      <Filters q={q} setQ={setQ}><span className="text-[10.5px] text-zinc-500 truncate max-w-[45%]">{data?.origin}</span></Filters>
      {err && <div className="px-3 py-1.5 text-[11px] text-red-300 border-b border-red-500/20">{err}</div>}
      {edit && (
        <div className="shrink-0 p-2 border-b border-white/10 space-y-1.5 bg-black/15">
          <input value={edit.key} onChange={(e) => setEdit({ ...edit, key: e.target.value })} disabled={!edit.isNew} placeholder={area === 'cookies' ? t('browser.storage.name') : t('browser.storage.key')}
            className="w-full h-7 rounded-lg px-2 font-mono text-[11px] bg-black/30 border border-white/10 outline-none focus:border-white/30 disabled:opacity-70" />
          <textarea value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} rows={Math.min(10, Math.max(3, edit.value.split('\n').length))} spellCheck={false} placeholder={t('browser.storage.value')}
            className="w-full rounded-lg px-2 py-1.5 font-mono text-[11px] bg-black/30 border border-white/10 outline-none focus:border-white/30 resize-y" />
          {area === 'cookies' && edit.cookie && (
            <div className="grid grid-cols-2 gap-1.5 text-[11px]">
              <input value={edit.cookie.domain ?? ''} onChange={(e) => setEdit({ ...edit, cookie: { ...edit.cookie, domain: e.target.value || undefined } })} placeholder={`domain (${data?.origin ?? ''})`} className="h-7 rounded-lg px-2 font-mono bg-black/30 border border-white/10 outline-none" />
              <input value={edit.cookie.path ?? ''} onChange={(e) => setEdit({ ...edit, cookie: { ...edit.cookie, path: e.target.value || undefined } })} placeholder="path (/)" className="h-7 rounded-lg px-2 font-mono bg-black/30 border border-white/10 outline-none" />
              <input type="datetime-local" value={edit.cookie.expires ? new Date(edit.cookie.expires - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
                onChange={(e) => setEdit({ ...edit, cookie: { ...edit.cookie, expires: e.target.value ? new Date(e.target.value).getTime() : undefined } })} title={t('browser.storage.expires')} className="h-7 rounded-lg px-2 bg-black/30 border border-white/10 outline-none" />
              <select value={edit.cookie.sameSite ?? ''} onChange={(e) => setEdit({ ...edit, cookie: { ...edit.cookie, sameSite: e.target.value || undefined } })} className="h-7 rounded-lg px-2 glass-ctl">
                <option value="">SameSite —</option><option value="Lax">Lax</option><option value="Strict">Strict</option><option value="None">None</option>
              </select>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!edit.cookie.httpOnly} onChange={(e) => setEdit({ ...edit, cookie: { ...edit.cookie, httpOnly: e.target.checked } })} />HttpOnly</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={!!edit.cookie.secure} onChange={(e) => setEdit({ ...edit, cookie: { ...edit.cookie, secure: e.target.checked } })} />Secure</label>
            </div>
          )}
          <div className="flex items-center gap-1.5 justify-end">
            {edit.value !== pretty(edit.value) && <button onClick={() => setEdit({ ...edit, value: pretty(edit.value) })} className="h-6 px-2.5 rounded-full text-[11px] text-zinc-300 hover:bg-fill">JSON</button>}
            {!edit.isNew && <button onClick={() => void remove({ key: edit.key, cookie: edit.cookie as BrowserCookie })} className="h-6 px-2.5 rounded-full text-[11px] text-red-300 hover:bg-fill">{t('browser.storage.delete')}</button>}
            <button onClick={() => setEdit(null)} className="h-6 px-2.5 rounded-full text-[11px] text-zinc-300 hover:bg-fill">{t('browser.storage.cancel')}</button>
            <button onClick={() => void save()} disabled={!edit.key} className="h-6 px-3 rounded-full text-[11px] glass-ctl disabled:opacity-40">{t('browser.storage.save')}</button>
          </div>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto font-mono text-[11px] px-2 py-1 select-text">
        {shown.length === 0 && <div className="text-zinc-500 py-3 px-1">{t('browser.storage.none')}</div>}
        {shown.map((r) => (
          <div key={`${r.key}|${r.cookie?.domain ?? ''}|${r.cookie?.path ?? ''}`} onClick={() => setEdit({ key: r.key, value: r.value, isNew: false, cookie: r.cookie })}
            className={`group flex gap-2 py-1 px-1 rounded-md border-b border-white/5 cursor-default hover:bg-white/5 ${edit && !edit.isNew && edit.key === r.key ? 'bg-white/[.07]' : ''}`}>
            <span className="w-[38%] shrink-0 truncate text-sky-200" title={r.key}>{r.key}</span>
            <span className="flex-1 min-w-0 truncate text-zinc-300" title={r.value}>{r.value}</span>
            {r.cookie && <span className="shrink-0 text-[10px] text-zinc-500">{r.cookie.httpOnly ? 'HttpOnly ' : ''}{r.cookie.domain}</span>}
            <button onClick={(e) => { e.stopPropagation(); void remove(r); }} aria-label={t('browser.storage.delete')} className="w-5 h-5 shrink-0 rounded-full flex items-center justify-center text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-red-300 hover:bg-fill"><Icon name="close" size={10} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
