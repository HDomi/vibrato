import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t, useLang } from '../../lib/i18n';
import Icon, { type IconName } from '../Icon';
import { BROWSER_CHANNEL, type BrowserChannelMessage } from '../../lib/browserChannel';
import type { BrowserAgentEntry, BrowserBridge, BrowserConsoleEntry, BrowserCookie, BrowserDevice, BrowserDevicePreset, BrowserFlags, BrowserNetBody, BrowserNetEntry, BrowserStorageArea, BrowserStorageResult, BrowserTab } from '../../lib/vibe';

/**
 * The in-app browser window (`/?browser=1`, electron/browser.cts). Three blocks on the Vibrato wallpaper: a header
 * styled like the app's title bar (round glass buttons, the tabs in the sliding capsule), the browser card and the
 * debug card. The page itself is a native WKWebView that the main process lays over the `hole` element; in mobile
 * view the hole is the screen of a phone frame whose size the user drags or types.
 */

type Dock = 'right' | 'bottom' | 'left' | 'top' | 'hidden';
type Pane = 'console' | 'network' | 'storage' | 'agent';
const LS_DOCK = 'vibe.browser.dock';
const LS_SIZE = 'vibe.browser.dockSize';
const LS_PANE = 'vibe.browser.pane';
const MAX_ROWS = 2000;
const DOCKS: Dock[] = ['right', 'bottom', 'left', 'top', 'hidden'];
const DEFAULT_DEVICE = { width: 393, height: 852, preset: 'iphone-15', mobile: true };

const read = <T extends string>(k: string, ok: readonly T[], d: T): T => { try { const v = localStorage.getItem(k) as T; return ok.includes(v) ? v : d; } catch { return d; } };
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const host = (u: string) => { try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname); } catch { return u; } };

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
  const [flags, setFlags] = useState<BrowserFlags>({ paused: false, picking: false, refs: false, mocks: [] });
  const [devices, setDevices] = useState<BrowserDevicePreset[]>([]);
  const [dock, setDock] = useState<Dock>(() => read(LS_DOCK, DOCKS, 'right'));
  const [pane, setPane] = useState<Pane>(() => read(LS_PANE, ['console', 'network', 'storage', 'agent'] as const, 'console'));
  const [size, setSize] = useState(() => { try { return Number(localStorage.getItem(LS_SIZE)) || 420; } catch { return 420; } });
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [toast, setToast] = useState('');
  const [fullScreen, setFullScreen] = useState(false);
  const hole = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);

  useEffect(() => { document.title = 'Vibrato Browser'; }, []);
  useEffect(() => window.vibe?.onFullScreen?.(setFullScreen), []);
  useEffect(() => { try { localStorage.setItem(LS_DOCK, dock); localStorage.setItem(LS_PANE, pane); localStorage.setItem(LS_SIZE, String(size)); } catch { /* ignore */ } }, [dock, pane, size]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 2600); return () => clearTimeout(id); }, [toast]);

  useEffect(() => {
    if (!bridge) { setAvailable(false); setError('Electron only'); return; }
    void bridge.info().then((info) => {
      if (!info) return;
      setAvailable(info.available); setError(info.error);
      setTabs(info.tabs); setActive(info.active); setLogs(info.console); setNets(info.net); setAgent(info.agent); setFlags(info.flags); setDevices(info.devices);
    });
    const offs = [
      bridge.on('tabs', (p) => { setTabs(p.tabs); setActive(p.active); }),
      bridge.on('console', (e) => setLogs((l) => (l.length >= MAX_ROWS ? [...l.slice(-MAX_ROWS + 1), e] : [...l, e]))),
      bridge.on('net', (e) => setNets((l) => (l.length >= MAX_ROWS ? [...l.slice(-MAX_ROWS + 1), e] : [...l, e]))),
      bridge.on('agent', (e) => setAgent((l) => [...l.slice(-199), e])),
      bridge.on('flags', setFlags),
      bridge.on('picked', (p) => {
        // Hand the element to the main window's composer (same origin, so a BroadcastChannel reaches it).
        if (typeof BroadcastChannel !== 'undefined') { const ch = new BroadcastChannel(BROWSER_CHANNEL); ch.postMessage({ kind: 'pick', text: p.text, image: p.image } satisfies BrowserChannelMessage); ch.close(); }
        setToast(t('browser.picked'));
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [bridge]);

  const tab = tabs.find((x) => x.id === active) ?? null;
  const device = tab?.device ?? null;
  useEffect(() => { if (!editing) setAddress(tab?.url && tab.url !== 'about:blank' ? tab.url : ''); }, [tab?.url, tab?.id, editing]);

  // Tell the main process where the page goes; null hides it (no tab).
  const report = useCallback(() => {
    const el = hole.current;
    if (!bridge || !el || !tab) { bridge?.frame(null); return; }
    const r = el.getBoundingClientRect();
    // Round the native page like the box it sits in: the card's bottom corners, or the whole phone screen.
    const radius = parseFloat(getComputedStyle(el).borderBottomLeftRadius) || 0;
    const corners = el.dataset.corners === 'all' ? 15 : 12;
    bridge.frame({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: radius, corners });
  }, [bridge, tab]);
  useLayoutEffect(() => {
    report();
    const els = [hole.current, area.current].filter(Boolean) as HTMLElement[];
    const ro = new ResizeObserver(report);
    els.forEach((el) => ro.observe(el));
    window.addEventListener('resize', report);
    return () => { ro.disconnect(); window.removeEventListener('resize', report); };
  }, [report, dock, size, device?.width, device?.height]);

  const open = (url = '') => { void bridge?.open(url || 'about:blank'); };
  const go = () => { const v = address.trim(); if (!v) return; if (tab) bridge?.navigate(v); else open(v); setEditing(false); (document.activeElement as HTMLElement)?.blur(); bridge?.nav('focus'); };
  const setDevice = (d: BrowserDevice | null) => bridge?.device(d);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 'l') { e.preventDefault(); const el = document.getElementById('vb-address') as HTMLInputElement | null; el?.focus(); el?.select(); }
      else if (k === 't') { e.preventDefault(); open(); }
      else if (k === 'w' && tab) { e.preventDefault(); bridge?.close(tab.id); }
      else if (k === 'r') { e.preventDefault(); bridge?.nav('reload'); }
      else if (k === '[') { e.preventDefault(); bridge?.nav('back'); }
      else if (k === ']') { e.preventDefault(); bridge?.nav('forward'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // Resize the debug card by dragging the 16px gap next to it.
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const vertical = dock === 'top' || dock === 'bottom';
    const start = vertical ? e.clientY : e.clientX;
    const from = size;
    const sign = dock === 'right' || dock === 'bottom' ? -1 : 1;
    const max = (vertical ? window.innerHeight : window.innerWidth) - 260;
    const move = (ev: PointerEvent) => setSize(Math.max(200, Math.min(max, from + sign * ((vertical ? ev.clientY : ev.clientX) - start))));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.cursor = vertical ? 'row-resize' : 'col-resize';
  };

  const errors = logs.filter((l) => l.level === 'error' && (!tab || l.tab === tab.id)).length;
  const failed = nets.filter((n) => (n.error || (n.status ?? 0) >= 400) && (!tab || n.tab === tab.id)).length;
  const vertical = dock === 'top' || dock === 'bottom';
  const flexDir = dock === 'right' ? 'flex-row' : dock === 'left' ? 'flex-row-reverse' : dock === 'bottom' ? 'flex-col' : 'flex-col-reverse';
  const windowButtons = !!window.vibe?.isElectron && !fullScreen;

  return (
    <div className="app-wall h-full flex flex-col overflow-hidden text-zinc-200">
      {/* 1. Header, like the app's title bar: round glass buttons, the tabs in the sliding capsule. */}
      <div className="titlebar-drag relative z-30 h-[84px] pt-7 pb-3 shrink-0 grid grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-4 text-xs select-none">
        <div className={`min-w-0 flex items-center gap-2 ${windowButtons ? 'pl-[84px]' : 'pl-[28px]'}`}>
          <CircleButton icon="plus" title={t('browser.newTab')} onClick={() => open()} />
          <CircleButton icon="pointer" title={t('browser.pick')} on={flags.picking} disabled={!tab} onClick={() => bridge?.pick(!flags.picking)} />
          <CircleButton icon="boxes" title={t('browser.refs')} on={flags.refs} onClick={() => bridge?.refs(!flags.refs)} />
          <CircleButton icon={flags.paused ? 'play' : 'pause'} title={flags.paused ? t('browser.resume') : t('browser.pause')} on={flags.paused} tone="amber" onClick={() => bridge?.pause(!flags.paused)} />
        </div>
        <TabCapsule tabs={tabs} active={active} onPick={(id) => bridge?.activate(id)} onClose={(id) => bridge?.close(id)} />
        <div className="min-w-0 flex items-center justify-end gap-2 pr-[28px]">
          <CircleButton icon="phone" title={device ? t('browser.mobileOff') : t('browser.mobileOn')} on={!!device} disabled={!tab} onClick={() => setDevice(device ? null : DEFAULT_DEVICE)} />
          <CircleButton icon="layout" title={`${t('browser.dock')}: ${t(`browser.dock.${dock}`)}`} on={dock !== 'hidden'} onClick={() => setDock(DOCKS[(DOCKS.indexOf(dock) + 1) % DOCKS.length])} />
        </div>
      </div>

      <div className={`flex-1 min-h-0 flex ${flexDir} px-4 pb-4`}>
        {/* 2. Browser card. */}
        <div className="glass flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          <div className="h-12 shrink-0 flex items-center gap-1 px-2.5">
            <NavBtn icon="back" label={t('browser.back')} disabled={!tab?.canGoBack} onClick={() => bridge?.nav('back')} />
            <NavBtn icon="forward" label={t('browser.forward')} disabled={!tab?.canGoForward} onClick={() => bridge?.nav('forward')} />
            <NavBtn icon={tab?.loading ? 'stop' : 'reload'} label={t('browser.reload')} disabled={!tab} onClick={() => bridge?.nav(tab?.loading ? 'stop' : 'reload')} />
            <div className="flex-1 min-w-0 relative">
              {tab?.owner && <span className="absolute left-2.5 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full" style={{ background: tab.owner.color }} title={tab.owner.label} />}
              <input id="vb-address" value={address} spellCheck={false} placeholder={t('browser.addressPlaceholder')}
                onFocus={(e) => { setEditing(true); e.target.select(); }} onBlur={() => setEditing(false)}
                onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') { setEditing(false); (e.target as HTMLInputElement).blur(); } }}
                className={`w-full h-8 rounded-full ${tab?.owner ? 'pl-6' : 'pl-4'} pr-4 text-[12.5px] bg-black/25 border border-white/10 focus:border-white/30 outline-none`} />
            </div>
            {tab && tab.zoom !== 1 && <button onClick={() => bridge?.zoom(1)} className="h-7 px-2 rounded-full text-[11px] text-zinc-300 hover:bg-fill">{Math.round(tab.zoom * 100)}%</button>}
            <NavBtn label={t('browser.zoomOut')} disabled={!tab} onClick={() => bridge?.zoom((tab?.zoom ?? 1) - 0.1)} text="−" />
            <NavBtn label={t('browser.zoomIn')} disabled={!tab} onClick={() => bridge?.zoom((tab?.zoom ?? 1) + 0.1)} text="+" />
          </div>
          {tab?.loading && <div className="h-[2px] shrink-0 bg-sky-300/70 transition-[width] duration-300" style={{ width: `${Math.max(8, (tab.progress ?? 0) * 100)}%` }} />}
          {device && tab && <DeviceBar device={device} devices={devices} onChange={setDevice} />}
          {flags.paused && <div className="shrink-0 px-3 py-1.5 text-[11.5px] text-amber-200 bg-amber-400/10 border-y border-amber-300/20">{t('browser.pausedNote')}</div>}
          <div ref={area} className="flex-1 min-h-0 relative">
            {device && tab
              ? <DeviceFrame device={device} areaRef={area} holeRef={hole} onResize={(w, h) => setDevice({ ...device, width: w, height: h, preset: undefined })} />
              : <div ref={hole} data-corners="bottom" className="absolute inset-0 bg-white/[.03] rounded-b-[var(--radius-card)]" />}
            {available === false && <Empty title={t('browser.unavailable')} body={error} />}
            {available && !tab && <Empty title={t('browser.empty')} body={t('browser.emptyNote')} action={t('browser.newTab')} onAction={() => open()} />}
          </div>
        </div>

        {/* 3. Debug card, on whichever side; the 16px gap is its resize handle. */}
        {dock !== 'hidden' && (
          <>
            <div onPointerDown={startDrag} role="separator" className={`shrink-0 group relative ${vertical ? 'h-4 cursor-row-resize' : 'w-4 cursor-col-resize'}`}>
              <div className={`absolute rounded-full transition-colors duration-200 group-hover:bg-white/25 ${vertical ? 'inset-x-10 top-1/2 h-[3px] -mt-[1.5px]' : 'inset-y-10 left-1/2 w-[3px] -ml-[1.5px]'}`} />
            </div>
            <div className="glass shrink-0 flex flex-col min-w-0 min-h-0 overflow-hidden" style={vertical ? { height: size } : { width: size }}>
              <div className="h-12 shrink-0 flex items-center gap-1 px-2.5 border-b border-white/10">
                <PaneTabs pane={pane} setPane={setPane} badges={{ console: errors, network: failed, storage: 0, agent: 0 }} />
                <div className="flex-1" />
                {pane !== 'storage' && (
                  <button title={t('browser.clear')} onClick={() => { const kind = pane === 'network' ? 'net' : pane === 'console' ? 'console' : 'agent'; bridge?.clear(kind); if (pane === 'console') setLogs([]); else if (pane === 'network') setNets([]); else setAgent([]); }}
                    className="w-7 h-7 rounded-full text-zinc-400 hover:text-white hover:bg-fill flex items-center justify-center"><Icon name="undo" size={13} /></button>
                )}
              </div>
              <div className="flex-1 min-h-0">
                {pane === 'console' && <ConsoleView rows={logs} tab={tab?.id ?? null} />}
                {pane === 'network' && bridge && <NetworkView rows={nets} tab={tab?.id ?? null} bridge={bridge} flags={flags} />}
                {pane === 'storage' && bridge && <StorageView bridge={bridge} tab={tab} />}
                {pane === 'agent' && bridge && <AgentView rows={agent} bridge={bridge} onSaved={(p) => setToast(t('browser.exported', { path: p }))} />}
              </div>
            </div>
          </>
        )}
      </div>
      {toast && <div className="pop-in glass-pop fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-full px-4 py-2 text-[12px] text-white">{toast}</div>}
    </div>
  );
}

function CircleButton({ icon, title, onClick, on, disabled, tone }: { icon: IconName; title: string; onClick: () => void; on?: boolean; disabled?: boolean; tone?: 'amber' }) {
  return (
    <button type="button" title={title} aria-label={title} aria-pressed={on} onClick={onClick} disabled={disabled}
      className={`titlebar-nodrag w-[38px] h-[38px] shrink-0 rounded-full flex items-center justify-center transition-colors disabled:opacity-35 ${on ? (tone === 'amber' ? 'bg-amber-300 text-black shadow-[0_2px_10px_rgb(0_0_0/.25)]' : 'bg-selected text-on-selected shadow-[0_2px_10px_rgb(0_0_0/.25)]') : 'glass-ctl text-zinc-200 hover:text-white'}`}>
      <Icon name={icon} size={15} />
    </button>
  );
}

/** The tabs, in the app's view-switch capsule: a white marker slides to the active one. */
function TabCapsule({ tabs, active, onPick, onClose }: { tabs: BrowserTab[]; active: number | null; onPick: (id: number) => void; onClose: (id: number) => void }) {
  const refs = useRef(new Map<number, HTMLDivElement | null>());
  const [marker, setMarker] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = active !== null ? refs.current.get(active) : null;
    setMarker(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
  }, [active, tabs]);
  if (!tabs.length) return <div className="titlebar-nodrag glass-ctl rounded-full h-9 px-5 flex items-center text-[12px] text-zinc-400">{t('browser.noTabs')}</div>;
  return (
    <div className="titlebar-nodrag glass-ctl relative flex items-center p-1 rounded-full text-[12px] font-medium min-w-0 max-w-full overflow-x-auto no-scrollbar">
      {marker && <span className="absolute top-1 bottom-1 rounded-full bg-selected shadow-[0_2px_10px_rgb(0_0_0/.25)] transition-[left,width] duration-300 ease-glass" style={{ left: marker.left, width: marker.width }} />}
      {tabs.map((x) => {
        const on = x.id === active;
        return (
          <div key={x.id} ref={(el) => { refs.current.set(x.id, el); }} onClick={() => onPick(x.id)} title={`${x.title || x.url}${x.owner ? ` — ${x.owner.label}` : ''}`}
            className={`group relative h-7 pl-3 pr-1.5 rounded-full flex items-center gap-1.5 shrink-0 max-w-[200px] cursor-default transition-colors duration-200 ${on ? 'text-on-selected' : 'text-zinc-200 hover:text-white'}`}>
            {x.owner && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: x.owner.color }} />}
            {x.loading && !x.owner && <span className="w-1.5 h-1.5 rounded-full bg-sky-300 animate-pulse shrink-0" />}
            {x.device && <Icon name="phone" size={11} className="opacity-70" />}
            <span className="truncate">{x.title || host(x.url) || t('browser.newTab')}</span>
            <button onClick={(e) => { e.stopPropagation(); onClose(x.id); }} aria-label={t('browser.closeTab')}
              className={`w-5 h-5 shrink-0 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 ${on ? 'hover:bg-black/10' : 'hover:bg-fill-2'}`}><Icon name="close" size={10} /></button>
          </div>
        );
      })}
    </div>
  );
}

function PaneTabs({ pane, setPane, badges }: { pane: Pane; setPane: (p: Pane) => void; badges: Record<Pane, number> }) {
  return (
    <div className="glass-ctl flex items-center p-1 rounded-full text-[12px] font-medium">
      {(['console', 'network', 'storage', 'agent'] as const).map((k) => (
        <button key={k} onClick={() => setPane(k)} className={`h-7 px-3 rounded-full flex items-center gap-1.5 transition-colors ${pane === k ? 'bg-selected text-on-selected' : 'text-zinc-200 hover:text-white'}`}>
          {t(k === 'console' ? 'browser.console' : k === 'network' ? 'browser.network' : k === 'storage' ? 'browser.storage' : 'browser.agent')}
          {badges[k] > 0 && <span className="min-w-4 h-4 px-1 rounded-full bg-red-500/85 text-[10px] leading-4 text-white">{badges[k]}</span>}
        </button>
      ))}
    </div>
  );
}

function NavBtn({ icon, label, onClick, disabled, text }: { icon?: IconName; label: string; onClick: () => void; disabled?: boolean; text?: string }) {
  return (
    <button title={label} aria-label={label} onClick={onClick} disabled={disabled}
      className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-zinc-300 hover:text-white hover:bg-fill disabled:opacity-30 disabled:hover:bg-transparent">
      {text ? <span className="text-[15px] leading-none">{text}</span> : icon && <Icon name={icon} size={14} />}
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

/** Device preset, size and orientation for the mobile view. */
function DeviceBar({ device, devices, onChange }: { device: BrowserDevice; devices: BrowserDevicePreset[]; onChange: (d: BrowserDevice | null) => void }) {
  const [w, setW] = useState(String(device.width));
  const [h, setH] = useState(String(device.height));
  useEffect(() => { setW(String(device.width)); setH(String(device.height)); }, [device.width, device.height]);
  const commit = () => { const nw = Number(w), nh = Number(h); if (nw >= 200 && nh >= 200) onChange({ ...device, width: nw, height: nh, preset: undefined }); };
  return (
    <div className="h-10 shrink-0 flex items-center gap-1.5 px-3 border-y border-white/5 text-[11.5px]">
      <select value={device.preset ?? ''} onChange={(e) => { const d = devices.find((x) => x.id === e.target.value); if (d) onChange({ ...device, width: d.width, height: d.height, preset: d.id }); }}
        className="h-7 rounded-full px-3 glass-ctl text-[11.5px]">
        <option value="">{t('browser.device.custom')}</option>
        {devices.map((d) => <option key={d.id} value={d.id}>{d.label} · {d.width}×{d.height}</option>)}
      </select>
      <input value={w} onChange={(e) => setW(e.target.value.replace(/\D/g, ''))} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} aria-label="width"
        className="w-14 h-7 rounded-full px-2 text-center font-mono bg-black/25 border border-white/10 outline-none focus:border-white/30" />
      <span className="text-zinc-500">×</span>
      <input value={h} onChange={(e) => setH(e.target.value.replace(/\D/g, ''))} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} aria-label="height"
        className="w-14 h-7 rounded-full px-2 text-center font-mono bg-black/25 border border-white/10 outline-none focus:border-white/30" />
      <button title={t('browser.device.rotate')} onClick={() => onChange({ ...device, width: device.height, height: device.width })} className="w-7 h-7 rounded-full flex items-center justify-center text-zinc-300 hover:text-white hover:bg-fill"><Icon name="rotate" size={13} /></button>
      <label className="flex items-center gap-1.5 ml-1 text-zinc-300"><input type="checkbox" checked={device.mobile} onChange={(e) => onChange({ ...device, mobile: e.target.checked })} />{t('browser.device.mobileUa')}</label>
      <div className="flex-1" />
      <button onClick={() => onChange(null)} className="h-7 px-3 rounded-full text-zinc-300 hover:text-white hover:bg-fill">{t('browser.mobileOff')}</button>
    </div>
  );
}

/** A phone frame centred in the page area; its screen is the hole. Drag the right, bottom or corner handle to resize. */
function DeviceFrame({ device, areaRef, holeRef, onResize }: { device: BrowserDevice; areaRef: React.RefObject<HTMLDivElement | null>; holeRef: React.RefObject<HTMLDivElement | null>; onResize: (w: number, h: number) => void }) {
  const [avail, setAvail] = useState({ w: 1000, h: 800 });
  const [live, setLive] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const upd = () => setAvail({ w: el.clientWidth, h: el.clientHeight });
    upd();
    const ro = new ResizeObserver(upd); ro.observe(el);
    return () => ro.disconnect();
  }, [areaRef]);
  const bezel = 12, margin = 24;
  const want = live ?? { w: device.width, h: device.height };
  const w = Math.min(want.w, avail.w - margin * 2 - bezel * 2), h = Math.min(want.h, avail.h - margin * 2 - bezel * 2);
  const clipped = w < want.w || h < want.h;
  const drag = (axis: 'x' | 'y' | 'xy') => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const sx = e.clientX, sy = e.clientY, w0 = device.width, h0 = device.height;
    let last = { w: w0, h: h0 };
    // The frame is centred, so the edge moves half as far as the size changes: double the pointer delta.
    const move = (ev: PointerEvent) => { last = { w: axis === 'y' ? w0 : Math.max(240, Math.round(w0 + (ev.clientX - sx) * 2)), h: axis === 'x' ? h0 : Math.max(240, Math.round(h0 + (ev.clientY - sy) * 2)) }; setLive(last); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setLive(null); onResize(last.w, last.h); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative rounded-[42px] bg-black/75 shadow-[0_20px_60px_rgb(0_0_0/.45)] ring-1 ring-white/15" style={{ padding: bezel }}>
        <div ref={holeRef} data-corners="all" className="rounded-[30px] bg-white/[.04] overflow-hidden" style={{ width: w, height: h }} />
        <div onPointerDown={drag('x')} className="absolute top-1/2 -right-3 -translate-y-1/2 w-2 h-14 rounded-full bg-white/30 hover:bg-white/60 cursor-ew-resize" />
        <div onPointerDown={drag('y')} className="absolute left-1/2 -bottom-3 -translate-x-1/2 h-2 w-14 rounded-full bg-white/30 hover:bg-white/60 cursor-ns-resize" />
        <div onPointerDown={drag('xy')} className="absolute -right-3 -bottom-3 w-4 h-4 rounded-full bg-white/40 hover:bg-white/70 cursor-nwse-resize" />
        <div className="absolute -top-6 left-0 right-0 text-center font-mono text-[10.5px] text-zinc-300">{want.w} × {want.h}{clipped ? ` · ${t('browser.device.clipped')}` : ''}</div>
      </div>
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

function NetworkView({ rows, tab, bridge, flags }: { rows: BrowserNetEntry[]; tab: number | null; bridge: BrowserBridge; flags: BrowserFlags }) {
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [onlyApi, setOnlyApi] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<BrowserNetBody | null | undefined>(undefined);
  const shown = useMemo(() => rows.filter((r) => (tab === null || r.tab === tab) && (!onlyFailed || r.error || (r.status ?? 0) >= 400) && (!onlyApi || r.via === 'fetch' || r.via === 'xhr') && (!q || r.url.toLowerCase().includes(q.toLowerCase()))), [rows, tab, onlyFailed, onlyApi, q]);
  const stick = useStick(shown.length);
  const toggle = (r: BrowserNetEntry) => {
    if (open === r.seq) { setOpen(null); return; }
    setOpen(r.seq); setDetail(undefined);
    if (r.rid) void bridge.netDetail(r.seq).then(setDetail); else setDetail(null);
  };
  const pre = (v: unknown) => (typeof v === 'string' ? (() => { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } })() : JSON.stringify(v, null, 2));
  return (
    <div className="h-full flex flex-col">
      <Filters q={q} setQ={setQ}>
        <Toggle on={onlyApi} set={setOnlyApi} label="Fetch/XHR" />
        <Toggle on={onlyFailed} set={setOnlyFailed} label={t('browser.failedOnly')} />
      </Filters>
      {flags.mocks.length > 0 && (
        <div className="shrink-0 flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b border-white/5 text-[11px]">
          <span className="text-amber-200">{t('browser.mocks', { n: flags.mocks.length })}</span>
          {flags.mocks.map((m) => (
            <span key={m.id} className="flex items-center gap-1 h-6 pl-2 pr-1 rounded-full bg-amber-400/10 text-amber-100 font-mono max-w-full">
              <span className="truncate">{m.method ?? '*'} {m.url} → {m.status}</span>
              <button onClick={() => void bridge.mockRemove(m.id)} aria-label={t('browser.storage.delete')} className="w-4 h-4 rounded-full flex items-center justify-center hover:bg-white/10"><Icon name="close" size={9} /></button>
            </span>
          ))}
        </div>
      )}
      <div ref={stick.ref} onScroll={stick.onScroll} className="flex-1 min-h-0 overflow-auto font-mono text-[11px] px-3 py-1 select-text">
        {shown.length === 0 && <div className="text-zinc-500 py-3">{t('browser.noNetwork')}</div>}
        {shown.map((r) => {
          const bad = !!r.error || (r.status ?? 0) >= 400;
          return (
            <div key={r.seq} className={`py-1 border-b border-white/5 ${bad ? 'text-red-300' : 'text-zinc-200'}`}>
              <div onClick={() => toggle(r)} className="flex gap-2 min-w-0 cursor-default">
                <span className="w-10 shrink-0 text-zinc-400">{r.method}</span>
                <span className="w-9 shrink-0">{r.error ? 'ERR' : r.status ?? '—'}</span>
                <span className="w-16 shrink-0 text-zinc-500 truncate">{r.mocked ? 'mock' : r.via}</span>
                <span className="flex-1 min-w-0 truncate">{host(r.url)}</span>
                <span className="shrink-0 text-zinc-500">{r.ms !== undefined ? `${r.ms}ms` : ''}</span>
              </div>
              {open === r.seq && (
                <div className="mt-1 pl-1 text-zinc-400 whitespace-pre-wrap break-all space-y-1.5">
                  <div>{r.url}{r.type ? `\n${r.type}` : ''}{r.size ? `\n${r.size} bytes` : ''}{r.error ? `\n${r.error}` : ''}{`\n${time(r.t)}`}</div>
                  {detail === undefined && r.rid && <div className="text-zinc-500">…</div>}
                  {detail && (['reqHeaders', 'reqBody', 'resHeaders', 'resBody'] as const).map((k) => detail[k] && (typeof detail[k] !== 'object' || Object.keys(detail[k] as object).length) ? (
                    <div key={k}><div className="text-zinc-500">{t(`browser.net.${k}`)}</div><pre className="text-zinc-200 max-h-64 overflow-auto bg-black/20 rounded-lg p-2">{pre(detail[k])}</pre></div>
                  ) : null)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentView({ rows, bridge, onSaved }: { rows: BrowserAgentEntry[]; bridge: BrowserBridge; onSaved: (path: string) => void }) {
  const [who, setWho] = useState('');
  const sessions = useMemo(() => [...new Map(rows.filter((r) => r.session).map((r) => [r.session!.key, r.session!])).values()], [rows]);
  const shown = rows.filter((r) => !who || r.session?.key === who);
  const stick = useStick(shown.length);
  const exp = (fmt: 'playwright' | 'html') => void bridge.export(fmt).then((p) => { if (p) onSaved(p); });
  return (
    <div className="h-full flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-1.5 px-2 border-b border-white/5">
        <select value={who} onChange={(e) => setWho(e.target.value)} className="h-6 rounded-full px-2 text-[11px] glass-ctl max-w-[50%]">
          <option value="">{t('browser.agent.all')}</option>
          {sessions.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <div className="flex-1" />
        <button disabled={!rows.length} onClick={() => exp('playwright')} className="h-6 px-2.5 rounded-full text-[11px] text-zinc-300 hover:text-white hover:bg-fill disabled:opacity-30">Playwright</button>
        <button disabled={!rows.length} onClick={() => exp('html')} className="h-6 px-2.5 rounded-full text-[11px] text-zinc-300 hover:text-white hover:bg-fill disabled:opacity-30">HTML</button>
      </div>
      <div ref={stick.ref} onScroll={stick.onScroll} className="flex-1 min-h-0 overflow-auto px-3 py-2 text-[12px] select-text">
        {shown.length === 0 && <div className="text-zinc-500 py-3 leading-relaxed">{t('browser.noAgent')}</div>}
        {shown.map((r) => (
          <div key={r.seq} className="py-2 border-b border-white/5">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: r.ok ? r.session?.color ?? '#4299FF' : '#f87171' }} />
              <span className="font-mono text-zinc-100">{r.tool.replace(/^browser_/, '')}</span>
              <span className="text-zinc-500 text-[11px] truncate">{r.session?.label ?? 'Agent'} · {time(r.t)} · {r.ms}ms</span>
            </div>
            {r.summary !== '{}' && <div className="mt-1 font-mono text-[11px] text-zinc-400 break-all">{r.summary}</div>}
            {r.result && <div className={`mt-1 font-mono text-[11px] whitespace-pre-wrap break-words max-h-40 overflow-auto ${r.ok ? 'text-zinc-300' : 'text-red-300'}`}>{r.result}</div>}
            {r.image && <img src={r.image} alt="" className="mt-2 rounded-lg border border-white/10 max-w-full" />}
          </div>
        ))}
      </div>
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
  const [areaName, setArea] = useState<BrowserStorageArea>('local');
  const [data, setData] = useState<BrowserStorageResult | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<{ key: string; value: string; isNew: boolean; cookie?: Partial<BrowserCookie> } | null>(null);
  const run = useCallback(async (op: Parameters<BrowserBridge['storage']>[0]) => {
    try { setErr(''); const r = await bridge.storage(op); setData(r); return r; }
    catch (e) { setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); return null; }
  }, [bridge]);
  const load = useCallback(() => { if (tab) void run({ action: 'get', area: areaName }); else setData(null); }, [run, areaName, tab]);
  useEffect(() => { setEdit(null); load(); }, [areaName, tab?.id, tab?.url, tab?.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => bridge.on('storage-changed', (e) => { if (e.tab === tab?.id) load(); }), [bridge, tab?.id, load]);

  const rows: { key: string; value: string; cookie?: BrowserCookie }[] = areaName === 'cookies'
    ? (data?.cookies ?? []).map((c) => ({ key: c.name, value: c.value, cookie: c }))
    : (data?.items ?? []).map(([key, value]) => ({ key, value }));
  const shown = rows.filter((r) => !q || r.key.toLowerCase().includes(q.toLowerCase()) || r.value.toLowerCase().includes(q.toLowerCase()));
  const save = async () => {
    if (!edit || !edit.key) return;
    const ok = areaName === 'cookies'
      ? await run({ action: 'set', area: areaName, cookie: { ...edit.cookie, name: edit.key, value: edit.value } })
      : await run({ action: 'set', area: areaName, key: edit.key, value: edit.value });
    if (ok) setEdit(null);
  };
  const remove = async (r: { key: string; cookie?: Partial<BrowserCookie> }) => {
    await run(areaName === 'cookies' ? { action: 'remove', area: areaName, cookie: { name: r.key, domain: r.cookie?.domain, path: r.cookie?.path } } : { action: 'remove', area: areaName, key: r.key });
    setEdit(null);
  };
  const pretty = (v: string) => { try { const j = JSON.parse(v); return typeof j === 'object' && j !== null ? JSON.stringify(j, null, 2) : v; } catch { return v; } };

  if (!tab) return <div className="p-3 text-[12px] text-zinc-500">{t('browser.empty')}</div>;
  return (
    <div className="h-full flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-white/5">
        {(['local', 'session', 'cookies'] as const).map((a) => <Toggle key={a} on={areaName === a} set={() => setArea(a)} label={t(`browser.storage.${a}`)} />)}
        <div className="flex-1" />
        <button title={t('browser.storage.add')} onClick={() => setEdit({ key: '', value: '', isNew: true, cookie: areaName === 'cookies' ? { path: '/' } : undefined })} className="w-6 h-6 rounded-full flex items-center justify-center text-zinc-400 hover:text-white hover:bg-fill"><Icon name="plus" size={12} /></button>
        <button title={t('browser.reload')} onClick={load} className="w-6 h-6 rounded-full flex items-center justify-center text-zinc-400 hover:text-white hover:bg-fill"><Icon name="reload" size={12} /></button>
        <button title={t('browser.storage.clearAll')} disabled={!rows.length} onClick={() => { if (confirm(t('browser.storage.clearConfirm', { n: rows.length, origin: data?.origin ?? '' }))) void run({ action: 'clear', area: areaName }); }}
          className="h-6 px-2 rounded-full text-[11px] text-zinc-400 hover:text-red-300 hover:bg-fill disabled:opacity-30">{t('browser.storage.clearAll')}</button>
      </div>
      <Filters q={q} setQ={setQ}><span className="text-[10.5px] text-zinc-500 truncate max-w-[45%]">{data?.origin}</span></Filters>
      {err && <div className="px-3 py-1.5 text-[11px] text-red-300 border-b border-red-500/20">{err}</div>}
      {edit && (
        <div className="shrink-0 p-2 border-b border-white/10 space-y-1.5 bg-black/15">
          <input value={edit.key} onChange={(e) => setEdit({ ...edit, key: e.target.value })} disabled={!edit.isNew} placeholder={areaName === 'cookies' ? t('browser.storage.name') : t('browser.storage.key')}
            className="w-full h-7 rounded-lg px-2 font-mono text-[11px] bg-black/30 border border-white/10 outline-none focus:border-white/30 disabled:opacity-70" />
          <textarea value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} rows={Math.min(10, Math.max(3, edit.value.split('\n').length))} spellCheck={false} placeholder={t('browser.storage.value')}
            className="w-full rounded-lg px-2 py-1.5 font-mono text-[11px] bg-black/30 border border-white/10 outline-none focus:border-white/30 resize-y" />
          {areaName === 'cookies' && edit.cookie && (
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
            {!edit.isNew && <button onClick={() => void remove({ key: edit.key, cookie: edit.cookie })} className="h-6 px-2.5 rounded-full text-[11px] text-red-300 hover:bg-fill">{t('browser.storage.delete')}</button>}
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
