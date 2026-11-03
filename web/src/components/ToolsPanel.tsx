import { useEffect, useRef, useState } from 'react';
import { api, type ToolsInfo, type ToolStatus } from '../lib/api';
import { LANGS, setLang, t, useLang, type Lang } from '../lib/i18n';
import { keepAwakeEnabled, setKeepAwakeEnabled } from '../lib/power';
import Icon from './Icon';
import LockSettings from './LockSettings';
import FormTypesSettings from './FormTypesSettings';
import WallpaperSettings from './WallpaperSettings';
import { UpdateBadge } from './UpdatePanel';

interface Props { onClose: () => void; /** Open at the lock screen tab (from the menu bar). */ focusLock?: boolean; /** Open at the form type editor (from the prompt form). */ focusFormTypes?: boolean }

type Tab = 'general' | 'wallpaper' | 'customPrompt' | 'formTypes' | 'lock' | 'agents';
const TABS: { id: Tab; key: string }[] = [
  { id: 'general', key: 'settings.general' },
  { id: 'wallpaper', key: 'settings.tab.wallpaper' },
  { id: 'customPrompt', key: 'settings.customPrompt' },
  { id: 'formTypes', key: 'settings.tab.formTypes' },
  { id: 'lock', key: 'settings.tab.lock' },
  { id: 'agents', key: 'settings.tab.agents' },
];

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

export default function ToolsPanel({ onClose, focusLock, focusFormTypes }: Props) {
  useLang();
  const [info, setInfo] = useState<ToolsInfo | null>(null);
  const [log, setLog] = useState<{ line: string; err: boolean }[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>(focusLock ? 'lock' : focusFormTypes ? 'formTypes' : 'general');
  // Opened again while already showing (menu bar, prompt form): jump to the asked section.
  useEffect(() => { if (focusLock) setTab('lock'); }, [focusLock]);
  useEffect(() => { if (focusFormTypes) setTab('formTypes'); }, [focusFormTypes]);
  const tabs = TABS.filter((x) => x.id !== 'lock' || !!window.vibe?.lock);
  const agentsNeedAttention = !!info?.tools.some((x) => !x.installed || x.loggedIn === false);

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
          {tab === 'agents' && <button className="text-xs text-zinc-400 hover:text-white mr-3" onClick={refresh}>{t('settings.redetect')}</button>}
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
            <div className={tab === 'wallpaper' ? '' : 'hidden'}><WallpaperSettings /></div>
            <div className={tab === 'customPrompt' ? '' : 'hidden'}><CustomPromptSettings /></div>
            <div className={tab === 'formTypes' ? '' : 'hidden'}><FormTypesSettings focus={focusFormTypes} /></div>
            <div className={tab === 'lock' ? '' : 'hidden'}><LockSettings focus={focusLock} /></div>
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
                  {t('settings.installers')}: brew {info.installers.brew ? '✓' : '✗'} · npm {info.installers.npm ? '✓' : '✗'} · node {info.installers.node ? '✓' : '✗'}
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
