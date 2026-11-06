import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type PermState, type ToolStatus } from '../../lib/api';
import { LANGS, setLang, t, useLang } from '../../lib/i18n';
import { folderReady, foldersToAsk, INTRO_FOLDERS, type IntroFolder } from '../../lib/intro';
import AgentIcon from '../AgentIcon';
import Icon, { type IconName } from '../Icon';

type Stage = 'welcome' | 'perms' | 'ready';
const STAGES: Stage[] = ['welcome', 'perms', 'ready'];
/** Card fade between stages; the inner content also rises a little (it is not glass, so a transform is fine). */
const STAGE_FADE_MS = 240;

const primary = 'h-11 px-6 rounded-full bg-zinc-100 text-zinc-900 text-sm font-medium hover:bg-white disabled:opacity-50 transition-colors';
const quiet = 'h-11 px-4 rounded-full text-sm text-zinc-400 hover:text-white hover:bg-fill-2 transition-colors';
const small = 'shrink-0 h-8 px-3.5 rounded-full bg-fill-2 hover:bg-fill-3 text-xs text-zinc-100 disabled:opacity-40 transition-colors';

/**
 * First launch (see lib/intro.ts): what Vibrato is, the macOS folder permissions it needs (asked one at a
 * time, here, instead of while a project is opening), then "Start". `onDone` runs once the card has faded out.
 */
export default function Intro({ onDone }: { onDone: () => void }) {
  useLang();
  const [stage, setStage] = useState<Stage>('welcome');
  const [shown, setShown] = useState(false);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(id); }, []);

  const go = (next: Stage) => {
    setShown(false);
    window.setTimeout(() => { setStage(next); setShown(true); }, STAGE_FADE_MS);
  };
  const finish = () => {
    if (leaving) return;
    setLeaving(true);
    setShown(false);
    window.setTimeout(onDone, 520);
  };

  return (
    <div className="relative h-full flex flex-col items-center justify-center px-8 select-none">
      <div className="titlebar-drag absolute inset-x-0 top-0 h-14" />
      <div className="titlebar-nodrag absolute top-5 right-6 flex items-center gap-0.5 rounded-full glass-ctl p-0.5 text-xs">
        {LANGS.map((l) => <LangButton key={l.id} id={l.id} label={l.label} />)}
      </div>
      <div className="glass w-full max-w-[620px] transition-opacity ease-out"
        style={{ opacity: shown ? 1 : 0, transitionDuration: `${leaving ? 500 : STAGE_FADE_MS}ms` }}>
        <div key={stage} className="intro-rise px-11 py-10">
          {stage === 'welcome' ? <Welcome onNext={() => go('perms')} />
            : stage === 'perms' ? <Permissions onNext={() => go('ready')} />
            : <Ready onStart={finish} />}
        </div>
      </div>
      <div className="mt-6 flex items-center gap-2 transition-opacity duration-300" style={{ opacity: leaving ? 0 : 1 }} aria-hidden>
        {STAGES.map((s) => <span key={s} className={`h-1.5 rounded-full transition-all duration-300 ${s === stage ? 'w-5 bg-zinc-100' : 'w-1.5 bg-white/25'}`} />)}
      </div>
    </div>
  );
}

function LangButton({ id, label }: { id: 'en' | 'ko'; label: string }) {
  const cur = useLang();
  return (
    <button className={`h-7 px-3 rounded-full transition-colors ${cur === id ? 'bg-fill-3 text-white' : 'text-zinc-400 hover:text-white'}`} onClick={() => setLang(id)}>{label}</button>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  const features: { icon: IconName; title: string; body: string }[] = [
    { icon: 'sparkle', title: t('intro.f1.title'), body: t('intro.f1.body') },
    { icon: 'terminal', title: t('intro.f2.title'), body: t('intro.f2.body') },
    { icon: 'play', title: t('intro.f3.title'), body: t('intro.f3.body') },
  ];
  return (
    <>
      <div className="flex items-center gap-4">
        <img src="/icon.svg" alt="" className="w-16 h-16 drop-shadow-[0_8px_24px_rgb(120_160_255/.25)]" draggable={false} />
        <div>
          <div className="text-[11px] uppercase tracking-[.22em] text-zinc-500">{t('intro.kicker')}</div>
          <h1 className="text-[34px] leading-tight font-semibold tracking-tight text-white">Vibrato</h1>
        </div>
      </div>
      <p className="mt-5 text-[15px] leading-relaxed text-zinc-300 whitespace-pre-line">{t('intro.tagline')}</p>
      <div className="mt-7 space-y-2">
        {features.map((f) => (
          <div key={f.title} className="flex items-start gap-3.5 rounded-2xl bg-black/15 px-4 py-3.5">
            <span className="mt-0.5 w-8 h-8 shrink-0 flex items-center justify-center rounded-full bg-fill-2 text-zinc-100"><Icon name={f.icon} size={14} /></span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-zinc-100">{f.title}</div>
              <div className="text-xs leading-relaxed text-zinc-400 mt-0.5">{f.body}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-8 flex justify-end"><button className={primary} onClick={onNext} autoFocus>{t('intro.next')}</button></div>
    </>
  );
}

type Asking = IntroFolder | 'all' | null;

function Permissions({ onNext }: { onNext: () => void }) {
  const [folders, setFolders] = useState<Partial<Record<IntroFolder, PermState>>>({});
  const [fullDisk, setFullDisk] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [asking, setAsking] = useState<Asking>(null);
  const [current, setCurrent] = useState<IntroFolder | null>(null);
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const askingRef = useRef<Asking>(null);
  askingRef.current = asking;

  const load = useCallback(async () => {
    try {
      const info = await window.vibe?.permissions?.info().catch(() => null);
      const snap = await api.permissions(info?.bundlePath);
      // A state learned from a prompt here outlives a snapshot that cannot read it back (no Full Disk Access).
      setFolders((prev) => {
        const next = { ...prev };
        for (const id of INTRO_FOLDERS) if (snap.folders[id] !== 'unknown' || !prev[id]) next[id] = snap.folders[id];
        return next;
      });
      setFullDisk(snap.fullDisk);
      setError(null);
    } catch (e) { setError((e as Error).message); } finally { setLoaded(true); }
  }, []);
  useEffect(() => {
    void load();
    api.tools().then((r) => setTools(r.tools)).catch(() => setTools([]));
    // Coming back from System Settings (Full Disk Access, Files and Folders) re-reads the states.
    const h = () => { if (!askingRef.current) void load(); };
    window.addEventListener('focus', h);
    return () => window.removeEventListener('focus', h);
  }, [load]);

  const ask = async (ids: IntroFolder[], key: Asking) => {
    setAsking(key); setError(null);
    try {
      // One at a time: each macOS prompt waits for its answer before the next one shows.
      for (const id of ids) {
        setCurrent(id);
        const { state } = await api.requestPermission(id);
        setFolders((f) => ({ ...f, [id]: state }));
      }
    } catch (e) { setError((e as Error).message); } finally { setAsking(null); setCurrent(null); }
  };

  const pending = foldersToAsk(folders, fullDisk);
  const ready = INTRO_FOLDERS.every((id) => folderReady(folders[id], fullDisk));
  const refused = INTRO_FOLDERS.some((id) => !fullDisk && (folders[id] === 'denied' || folders[id] === 'restricted'));
  const openPane = (pane: string) => void api.openPermissionPane(pane).catch((e: Error) => setError(e.message));

  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight text-white">{t('intro.perms.title')}</h2>
      <p className="mt-2 text-sm leading-relaxed text-zinc-400">{t('intro.perms.body')}</p>

      <div className="mt-6 rounded-2xl bg-black/15 p-1.5">
        {INTRO_FOLDERS.map((id) => (
          <Row key={id} title={t(`perm.item.${id}`)} sub={`~/${id[0].toUpperCase()}${id.slice(1)}`}
            state={<FolderState state={folders[id]} fullDisk={fullDisk} loading={!loaded} asking={current === id} />}>
            {!folderReady(folders[id], fullDisk) && loaded && (
              folders[id] === 'denied' || folders[id] === 'restricted'
                ? <button className={small} onClick={() => openPane('files')}>{t('intro.perms.settings')}</button>
                : <button className={small} disabled={!!asking} onClick={() => void ask([id], id)}>{t('intro.perms.allow')}</button>
            )}
          </Row>
        ))}
        <div className="mx-3 my-1 h-px bg-line" />
        <Row title={<>{t('perm.item.fullDisk')}<span className="ml-2 rounded-full px-2 py-px text-[10px] bg-sky-400/15 text-sky-200">{t('perm.need.recommended')}</span></>}
          sub={t('intro.perms.fullDiskBody')}
          state={loaded ? <Dot ok={fullDisk} label={t(fullDisk ? 'intro.state.on' : 'intro.state.off')} /> : <Dot label={t('intro.state.checking')} />}>
          {!fullDisk && loaded && <button className={small} onClick={() => openPane('fullDisk')}>{t('intro.perms.settings')}</button>}
        </Row>
      </div>

      <div className="mt-3 flex items-center gap-2 px-1 text-xs text-zinc-400">
        <span className="mr-1">{t('intro.agents')}</span>
        {(['claude', 'codex'] as const).map((id) => {
          const s = tools?.find((x) => x.id === id);
          const label = !tools ? t('intro.state.checking') : !s?.installed ? t('intro.agent.missing') : s.loggedIn === false ? t('intro.agent.login') : t('intro.agent.ready');
          const ok = !!s?.installed && s.loggedIn !== false;
          return (
            <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-black/15 pl-1.5 pr-2.5 py-1">
              <AgentIcon agent={id} size={14} />
              <span className="text-zinc-200">{id === 'claude' ? 'Claude Code' : 'Codex'}</span>
              <span className={ok ? 'text-emerald-300' : tools ? 'text-amber-200' : 'text-zinc-500'}>{label}</span>
            </span>
          );
        })}
      </div>

      {asking && <div className="mt-4 text-xs text-sky-200 leading-relaxed">{t('intro.perms.waiting')}</div>}
      {refused && !asking && <div className="mt-4 text-xs text-amber-200 leading-relaxed">{t('intro.perms.refused')}</div>}
      {error && <div className="mt-4 text-xs text-red-300 break-words">{error}</div>}

      <div className="mt-8 flex items-center justify-end gap-2">
        {!ready && <button className={quiet} disabled={!!asking} onClick={onNext}>{t('intro.later')}</button>}
        {pending.length > 0
          ? <button className={primary} disabled={!!asking || !loaded} onClick={() => void ask(pending, 'all')}>{asking ? t('intro.state.asking') : t('intro.perms.allowAll')}</button>
          : <button className={primary} disabled={!loaded || !!asking} onClick={onNext}>{t('intro.next')}</button>}
      </div>
    </>
  );
}

function Row({ title, sub, state, children }: { title: ReactNode; sub: string; state: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-xl px-3.5 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center text-sm text-zinc-100">{title}</div>
        <div className="text-xs text-zinc-500 mt-0.5 leading-relaxed">{sub}</div>
      </div>
      {state}
      {children}
    </div>
  );
}

function Dot({ ok, warn, label }: { ok?: boolean; warn?: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-300 whitespace-nowrap">
      <span className={`w-2 h-2 rounded-full ${ok ? 'bg-emerald-400' : warn ? 'bg-red-400' : 'bg-zinc-500'}`} />
      {label}
    </span>
  );
}

function FolderState({ state, fullDisk, loading, asking }: { state: PermState | undefined; fullDisk: boolean; loading: boolean; asking: boolean }) {
  if (asking) return <span className="inline-flex items-center gap-1.5 text-xs text-sky-200 whitespace-nowrap"><span className="w-2 h-2 rounded-full bg-sky-300 animate-pulse" />{t('intro.state.asking')}</span>;
  if (loading) return <Dot label={t('intro.state.checking')} />;
  if (folderReady(state, fullDisk)) return <span className="inline-flex items-center gap-1 text-xs text-emerald-300 whitespace-nowrap"><Icon name="check" size={13} />{t('intro.state.allowed')}</span>;
  if (state === 'denied' || state === 'restricted') return <Dot warn label={t('intro.state.denied')} />;
  return <Dot label={t('intro.state.needed')} />;
}

function Ready({ onStart }: { onStart: () => void }) {
  return (
    <div className="py-8 flex flex-col items-center text-center">
      <img src="/icon.svg" alt="" className="w-14 h-14 opacity-90" draggable={false} />
      <h2 className="mt-7 text-[30px] leading-snug font-semibold tracking-tight text-white">{t('intro.ready.title')}</h2>
      <p className="mt-3 text-sm leading-relaxed text-zinc-400">{t('intro.ready.body')}</p>
      <button className={`${primary} mt-9 px-9`} onClick={onStart} autoFocus>{t('intro.start')}</button>
    </div>
  );
}
