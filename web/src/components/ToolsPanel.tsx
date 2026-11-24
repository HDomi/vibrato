import { useEffect, useRef, useState } from 'react';
import { api, type ToolsInfo, type ToolStatus } from '../lib/api';
import { LANGS, setLang, t, useLang, type Lang } from '../lib/i18n';
import { keepAwakeEnabled, setKeepAwakeEnabled } from '../lib/power';
import Icon from './Icon';
import FormTypesSettings from './FormTypesSettings';
import StyleSettings from './StyleSettings';
import AgentDefaultsSettings from './AgentDefaultsSettings';
import PermissionsSettings from './PermissionsSettings';
import AgentExtensionsSettings from './AgentExtensionsSettings';
import { UpdateBadge } from './UpdatePanel';
import { setUsageVisible, useHiddenUsage, type UsageAgent } from '../lib/usageVisibility';
import { PLATFORM } from '../platform';
import { SETTINGS_TABS } from '../platform/settings';

interface Props { onClose: () => void; /** Open at this section (a platform's own, from its menu bar). */ focusTab?: string; /** Open at the form type editor (from the prompt form). */ focusFormTypes?: boolean }

type Tab = string;
const SHARED_TABS: { id: Tab; key: string }[] = [
  { id: 'general', key: 'settings.general' },
  { id: 'agentDefaults', key: 'settings.tab.agentDefaults' },
  { id: 'style', key: 'settings.tab.style' },
  { id: 'customPrompt', key: 'settings.customPrompt' },
  { id: 'formTypes', key: 'settings.tab.formTypes' },
  { id: 'agents', key: 'settings.tab.agents' },
  { id: 'permissions', key: 'settings.tab.permissions' },
  { id: 'tmp', key: 'settings.tab.tmp' },
];
/** The shared sections, each followed by the platform's own sections that go after it (platform/settings.tsx). */
const TABS: { id: Tab; key: string; available?: () => boolean }[] = SHARED_TABS.flatMap((x) => [x, ...SETTINGS_TABS.filter((p) => p.after === x.id)]);

function methodLabel(m: string): string {
  if (m === 'official') return t('settings.method.official');
  if (m === 'brew') return 'Homebrew';
  return m;
}

function methodsFor(tool: ToolStatus, inst: ToolsInfo['installers']): string[] {
  const m: string[] = [];
  if (tool.id === 'claude') m.push('official');
  if (inst.brew) m.push('brew');
  if (inst.npm) m.push('npm');
  return m;
}

function GeneralSettings() {
  const lang = useLang();
  const [login, setLogin] = useState<boolean | null>(null);
  const [awake, setAwake] = useState(keepAwakeEnabled);
  const [alwaysPlan, setAlwaysPlan] = useState<boolean | null>(null);
  useEffect(() => { api.alwaysPlan().then((r) => setAlwaysPlan(r.on)).catch(() => {}); }, []);
  const [browserTools, setBrowserTools] = useState<boolean | null>(null);
  useEffect(() => { api.browserTools().then((r) => setBrowserTools(r.on)).catch(() => {}); }, []);
  useEffect(() => { window.vibe?.loginItem?.(null).then(setLogin).catch(() => {}); }, []);
  return (
    <div className="rounded-2xl border border-line bg-black/15 p-5 space-y-3">
      <div className="font-medium">{t('settings.general')}</div>
      <div className="flex items-center gap-3 text-sm">
        <span className="w-28 text-zinc-400">{t('settings.version')}</span>
        <UpdateBadge />
      </div>
      <label className="flex items-center gap-3 text-sm">
        <span className="w-28 text-zinc-400">{t('settings.language')}</span>
        <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} className="bg-black/20 border border-line rounded-full text-xs px-3 py-1.5 outline-none">
          {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
      </label>
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={!!alwaysPlan} disabled={alwaysPlan === null}
            onChange={(e) => { const on = e.target.checked; setAlwaysPlan(on); api.setAlwaysPlan(on).catch(() => setAlwaysPlan(!on)); }} />
          {t('settings.alwaysPlan')}
        </label>
        <div className="text-xs text-zinc-500 leading-relaxed pl-6">{t('settings.alwaysPlanNote')}</div>
      </div>
      {PLATFORM.inAppBrowser && (
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={!!browserTools} disabled={browserTools === null}
              onChange={(e) => { const on = e.target.checked; setBrowserTools(on); api.setBrowserTools(on).catch(() => setBrowserTools(!on)); }} />
            {t('settings.browserTools')}
          </label>
          <div className="text-xs text-zinc-500 leading-relaxed pl-6">{t('settings.browserToolsNote')}</div>
        </div>
      )}
      {window.vibe?.isElectron ? (
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={!!login} disabled={login === null} onChange={(e) => window.vibe!.loginItem(e.target.checked).then(setLogin)} />
          {t('settings.openAtLogin')}
        </label>
      ) : <div className="text-xs text-zinc-500">{t('settings.browserNote')}</div>}
      {window.vibe?.keepAwake && (
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={awake} onChange={(e) => { setAwake(e.target.checked); setKeepAwakeEnabled(e.target.checked); }} />
            {t('settings.keepAwake')}
          </label>
          <div className="text-xs text-zinc-500 leading-relaxed pl-6">{t('settings.keepAwakeNote')}</div>
        </div>
      )}
      {window.vibe?.openNotificationSettings && (
        <div className="flex items-start gap-3 text-xs">
          <span className="text-zinc-500 leading-relaxed flex-1">{t('settings.notificationStyle')}</span>
          <button className="shrink-0 rounded-full bg-fill-2 hover:bg-fill-3 px-3.5 py-1.5 text-zinc-200 transition-colors" onClick={() => window.vibe!.openNotificationSettings!()}>{t('settings.openNotificationSettings')}</button>
        </div>
      )}
      <div className="text-xs text-zinc-500 leading-relaxed">{t('settings.shortcuts')}</div>
    </div>
  );
}

/** One folder of temporary or leftover data: where it lives, what uses it, how big it is. */
interface TempRow { id: string; dir: string; files: number; bytes: number; legacy?: boolean; app?: boolean }

/**
 * Temp cleanup: every folder of temporary or leftover data with its size and what it is for, each deleted on its own.
 * Server folders come from /api/tmp (server/tmpFiles.ts); the app's own (web cache, old browser stores) from the
 * Electron process (window.vibe.storage), so they only show in the desktop app.
 */
function TmpSettings({ active }: { active: boolean }) {
  useLang();
  const [rows, setRows] = useState<TempRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = async () => {
    const [server, app] = await Promise.all([
      api.tmpStats().catch(() => [] as TempRow[]),
      window.vibe?.storage?.list().catch(() => [] as TempRow[]) ?? Promise.resolve([] as TempRow[]),
    ]);
    setRows([...server, ...app.map((x) => ({ ...x, app: true }))]);
  };
  useEffect(() => { if (active) void load(); }, [active]);
  const size = (b: number) => (b < 1024 * 1024 ? `${Math.max(b ? 1 : 0, Math.round(b / 1024))} KB` : b < 1024 ** 3 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`);
  const clear = async (row: TempRow) => {
    if (!window.confirm(t('settings.tmp.confirmOne', { name: t(`settings.tmp.target.${row.id}`), size: size(row.bytes) }))) return;
    setBusy(row.id);
    try {
      const r = row.app ? await window.vibe!.storage!.clear(row.id) : await api.clearTmp(row.id);
      setNotes((n) => ({ ...n, [row.id]: t('settings.tmp.clearedOne', { size: size(r.bytes) }) + (r.failed ? ` ${t('settings.tmp.skipped', { n: r.failed })}` : '') }));
    } catch (e) { setNotes((n) => ({ ...n, [row.id]: t('settings.tmp.failed', { reason: (e as Error).message }) })); }
    setBusy(null);
    void load();
  };
  const total = rows?.reduce((n, r) => n + r.bytes, 0) ?? 0;
  return (
    <div className="rounded-2xl border border-line bg-black/15 p-5 space-y-3" data-settings-tmp="">
      <div className="flex items-baseline gap-2">
        <div className="font-medium">{t('settings.tab.tmp')}</div>
        {rows && <div className="text-xs text-zinc-500 tabular-nums">{t('settings.tmp.total', { size: size(total) })}</div>}
      </div>
      <div className="text-xs text-zinc-500 leading-relaxed">{t('settings.tmp.note')}</div>
      {!rows ? <div className="text-sm text-zinc-500">…</div> : (
        <div className="divide-y divide-white/5 rounded-xl border border-line">
          {rows.map((r) => (
            <div key={r.id} className="flex items-start gap-3 px-3.5 py-3" data-tmp-target={r.id}>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="text-zinc-200">{t(`settings.tmp.target.${r.id}`)}</span>
                  {r.legacy || r.id === 'oldPartitions' ? <span className="rounded bg-amber-400/10 px-1.5 text-[10.5px] text-amber-200/90">{t('settings.tmp.unused')}</span> : null}
                  <span className="ml-auto shrink-0 tabular-nums text-zinc-300">{r.bytes ? size(r.bytes) : t('settings.tmp.empty')}</span>
                </div>
                <div className="mt-0.5 text-xs text-zinc-500 leading-relaxed">{t(`settings.tmp.use.${r.id}`)}</div>
                <div className="mt-0.5 font-mono text-[11px] text-zinc-600 break-all">{r.dir}</div>
                {notes[r.id] && <div className="mt-1 text-xs text-zinc-400">{notes[r.id]}</div>}
              </div>
              <button type="button" disabled={!!busy || !r.bytes} onClick={() => void clear(r)} data-tmp-clear={r.id}
                className="shrink-0 rounded-full bg-red-500/15 text-red-200 hover:bg-red-500/25 text-xs px-3.5 py-1.5 transition-colors disabled:opacity-40">
                {busy === r.id ? t('settings.tmp.clearing') : t('settings.tmp.clearOne')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomPromptSettings() {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [flash, setFlash] = useState(false);
  useEffect(() => { api.customPrompt().then((r) => { setText(r.text); setSaved(r.text); }).catch(() => {}); }, []);
  const dirty = text.trim() !== saved.trim();
  const save = () => api.saveCustomPrompt(text).then((r) => { setText(r.text); setSaved(r.text); setFlash(true); setTimeout(() => setFlash(false), 1500); }).catch(() => {});
  return (
    <div className="rounded-2xl border border-line bg-black/15 p-5 space-y-2">
      <div className="font-medium">{t('settings.customPrompt')}</div>
      <div className="text-xs text-zinc-500 leading-relaxed">{t('settings.customPromptNote')}</div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} spellCheck={false} placeholder={t('settings.customPromptPlaceholder')}
        className="w-full resize-y rounded-2xl bg-black/20 border border-line px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-white/30 transition-colors" />
      <div className="flex items-center justify-end gap-3 text-xs">
        {flash && <span className="text-zinc-500">{t('settings.customPromptSaved')}</span>}
        <button disabled={!dirty} onClick={save} className="rounded-full bg-fill-2 px-3.5 py-1.5 text-zinc-200 hover:bg-fill-3 disabled:opacity-40 disabled:hover:bg-fill-2 transition-colors">{t('settings.customPromptSave')}</button>
      </div>
    </div>
  );
}

export default function ToolsPanel({ onClose, focusTab, focusFormTypes }: Props) {
  useLang();
  const hiddenUsage = useHiddenUsage();
  const [info, setInfo] = useState<ToolsInfo | null>(null);
  const [log, setLog] = useState<{ line: string; err: boolean }[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>(focusTab ?? (focusFormTypes ? 'formTypes' : 'general'));
  // Opened again while already showing (menu bar, prompt form): jump to the asked section.
  useEffect(() => { if (focusTab) setTab(focusTab); }, [focusTab]);
  useEffect(() => { if (focusFormTypes) setTab('formTypes'); }, [focusFormTypes]);
  const tabs = TABS.filter((x) => !x.available || x.available());
  const agentsNeedAttention = !!info?.tools.some((x) => !x.installed || x.loggedIn === false);

  const [extReload, setExtReload] = useState(0);
  const refresh = () => api.tools(true).then(setInfo).catch((e) => setLog((l) => [...l, { line: e.message, err: true }]));
  useEffect(() => { refresh(); }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [log]);
  // Escape closes, unless it is finishing an IME composition or another layer (menu, dialog) handled it first.
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const run = (tool: string, method: string) => {
    if (running) return;
    setRunning(`${tool}:${method}`);
    setLog([]);
    const es = new EventSource(api.installUrl(tool, method));
    es.addEventListener('start', (e) => setLog((l) => [...l, { line: `$ ${(e as MessageEvent).data}`, err: false }]));
    es.addEventListener('stdout', (e) => setLog((l) => [...l, { line: (e as MessageEvent).data, err: false }]));
    es.addEventListener('stderr', (e) => setLog((l) => [...l, { line: (e as MessageEvent).data, err: true }]));
    es.addEventListener('done', (e) => {
      setLog((l) => [...l, { line: t('settings.exitCode', { code: (e as MessageEvent).data }), err: (e as MessageEvent).data !== '0' }]);
      es.close(); setRunning(null); refresh();
    });
    es.onerror = () => { es.close(); setRunning(null); refresh(); };
  };

  return (
    <div className="fade-in fixed inset-0 z-40 bg-black/50 flex items-center justify-center" onClick={onClose}>
      <div className="w-[980px] max-w-[94vw] h-[85vh] glass-pop pop-in !rounded-[22px] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center pl-6 pr-4 h-[60px] shrink-0 border-b border-white/10">
          <div className="text-[15px] font-semibold">{t('settings.title')}</div>
          <div className="flex-1" />
          {tab === 'agents' && <button className="text-xs text-zinc-400 hover:text-white mr-3" onClick={() => { refresh(); setExtReload((n) => n + 1); }}>{t('settings.redetect')}</button>}
          <button className="w-8 h-8 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-fill-2 transition-colors" onClick={onClose} title="Esc"><Icon name="close" /></button>
        </div>
        {/* Left: sections; right: the selected section. Two cards inside the dialog. */}
        <div className="flex-1 min-h-0 flex gap-3 p-3">
          <nav className="w-[210px] shrink-0 rounded-[18px] border border-line bg-black/20 p-2 space-y-0.5 overflow-y-auto">
            {tabs.map((x) => (
              <button key={x.id} onClick={() => setTab(x.id)}
                className={`w-full flex items-center gap-2 text-left rounded-xl px-3 py-2 text-sm transition-colors duration-150 ${tab === x.id ? 'bg-selected text-on-selected' : 'text-zinc-300 hover:text-white hover:bg-fill'}`}>
                <span className="flex-1 truncate">{t(x.key)}</span>
                {x.id === 'agents' && (running ? <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" /> : agentsNeedAttention && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />)}
              </button>
            ))}
          </nav>
          {/* Every tab stays mounted so unsaved edits survive switching. */}
          <div className="flex-1 min-w-0 rounded-[18px] border border-line bg-black/20 p-5 overflow-y-auto">
            <div className={tab === 'general' ? '' : 'hidden'}><GeneralSettings /></div>
            <div className={tab === 'agentDefaults' ? '' : 'hidden'}><AgentDefaultsSettings /></div>
            <div className={tab === 'style' ? '' : 'hidden'}><StyleSettings /></div>
            <div className={tab === 'customPrompt' ? '' : 'hidden'}><CustomPromptSettings /></div>
            <div className={tab === 'formTypes' ? '' : 'hidden'}><FormTypesSettings focus={focusFormTypes} /></div>
            {SETTINGS_TABS.map((x) => <div key={x.id} className={tab === x.id ? '' : 'hidden'}>{x.render({ focus: focusTab === x.id })}</div>)}
            <div className={tab === 'permissions' ? '' : 'hidden'}><PermissionsSettings active={tab === 'permissions'} /></div>
            <div className={tab === 'tmp' ? '' : 'hidden'}><TmpSettings active={tab === 'tmp'} /></div>
            <div className={tab === 'agents' ? 'space-y-4' : 'hidden'}>
              {!info && <div className="text-sm text-zinc-500">{t('settings.detecting')}</div>}
              {info?.tools.map((tool) => (
                <div key={tool.id} className="rounded-2xl border border-line bg-black/15 p-4">
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${tool.installed ? (tool.loggedIn ? 'bg-green-400' : 'bg-amber-400') : 'bg-zinc-600'}`} />
                    <div className="font-medium">{tool.name}</div>
                    {tool.installed ? (
                      <span className="text-xs text-zinc-400">{tool.version} · {tool.path}</span>
                    ) : (
                      <span className="text-xs text-zinc-500">{t('settings.notInstalled')}</span>
                    )}
                    <div className="flex-1" />
                    {(tool.id === 'claude' || tool.id === 'codex') && (
                      <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer select-none" title={t('settings.showStatusHint')} data-show-status={tool.id}>
                        <input type="checkbox" checked={!hiddenUsage.includes(tool.id)} onChange={(e) => setUsageVisible(tool.id as UsageAgent, e.target.checked)} />
                        {t('settings.showStatus')}
                      </label>
                    )}
                    {tool.installed && (
                      <button disabled={!!running} className="text-xs rounded-full bg-fill-2 hover:bg-fill-3 px-3 py-1 disabled:opacity-40 transition-colors"
                        onClick={() => run(tool.id, 'update')}>{t('settings.update')}</button>
                    )}
                  </div>
                  {tool.installed && (
                    <div className="mt-2 text-xs text-zinc-400">
                      {tool.loggedIn === true && <>{t('settings.loggedIn')} · {tool.authInfo}</>}
                      {tool.loggedIn === false && <span className="text-amber-300">{t('settings.loginRequired', { cmd: tool.id === 'claude' ? 'claude → /login' : 'codex login' })}</span>}
                      {tool.loggedIn === null && t('settings.loginUnknown')}
                    </div>
                  )}
                  {tool.installed && <AgentExtensionsSettings agent={tool.id} reload={extReload} />}
                  {!tool.installed && (
                    <div className="mt-3 flex gap-2 flex-wrap">
                      {methodsFor(tool, info.installers).map((m) => (
                        <button key={m} disabled={!!running}
                          className="text-xs rounded-full bg-selected hover:bg-white text-on-selected font-medium px-3.5 py-1.5 disabled:opacity-40 transition-colors"
                          onClick={() => run(tool.id, m)}>{t('settings.installVia', { method: methodLabel(m) })}</button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {info && (
                <div className="text-xs text-zinc-500">
                  {t('settings.installers')}: {Object.entries(info.installers).map(([name, found]) => `${name} ${found ? '✓' : '✗'}`).join(' · ')}
                </div>
              )}
              {log.length > 0 && (
                <div ref={logRef} className="rounded-2xl bg-black/40 border border-line p-3 font-mono text-[12px] max-h-64 overflow-auto">
                  {log.map((l, i) => <div key={i} className={l.err ? 'text-amber-200' : 'text-zinc-300'}>{l.line}</div>)}
                  {running && <div className="text-zinc-500 animate-pulse">{t('settings.running')}</div>}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
