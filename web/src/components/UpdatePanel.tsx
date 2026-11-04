import { useEffect, useRef, useState } from 'react';
import { api, type ReleaseSummary, type UpdateStatus } from '../lib/api';
import { t, useLang } from '../lib/i18n';
import Icon from './Icon';

/** Small badge for the sidebar header; opens the modal with commit list and apply log. */
/** Installed version (green with the new one when an update is out); a click opens the update dialog. `onWall`: over the wallpaper (title bar). */
export function UpdateBadge({ onWall = false }: { onWall?: boolean }) {
  useLang();
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const load = (force = false) => { setChecking(true); return api.updateStatus(force).then(setSt).catch(() => {}).finally(() => setChecking(false)); };
  // Checked on app start, when the modal opens, and on manual refresh. No background polling.
  useEffect(() => { load(true); }, []);
  const available = !!st?.available;
  const installed = st?.installed;
  return (
    <>
      <button className={`titlebar-nodrag text-[11px] rounded-full px-2 py-0.5 transition-colors ${available ? 'bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30' : onWall ? 'text-white/75 hover:text-white [text-shadow:0_1px_3px_rgb(0_0_0/.6)]' : 'text-zinc-600 hover:text-zinc-300'}`}
        onClick={() => { setOpen(true); void load(true); }} title={st?.error ?? (available ? t('update.availableTitle', { v: st?.remote?.version ?? '' }) : t('update.upToDateTitle', { v: installed?.version ?? '' }))}>
        {available ? t('update.badgeVersion', { v: st?.remote?.version ?? '' }) : installed ? `v${installed.version}` : '…'}
      </button>
      {open && <UpdateModal status={st} checking={checking} onClose={() => setOpen(false)} onRefresh={() => load(true)} />}
    </>
  );
}

function UpdateModal({ status, checking, onClose, onRefresh }: { status: UpdateStatus | null; checking: boolean; onClose: () => void; onRefresh: () => void }) {
  useLang();
  const [log, setLog] = useState<{ line: string; err: boolean }[]>([]);
  const [phase, setPhase] = useState<'idle' | 'running' | 'restarting' | 'failed'>('idle');
  const logRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sourceRef.current?.close(); if (pollRef.current) clearTimeout(pollRef.current); }; }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [log]);
  // While an update runs (or the server restarts) the modal cannot be dismissed: the log is the only feedback.
  const locked = phase === 'running' || phase === 'restarting';
  const release = status?.source === 'release';
  const close = () => { if (!locked) onClose(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const [lastVersion, setLastVersion] = useState<string | undefined>();
  const apply = (force = false, version?: string) => {
    if (locked) return;
    sourceRef.current?.close();
    setPhase('running'); setLog([]); setLastVersion(version);
    const es = new EventSource(api.updateApplyUrl(force, version));
    sourceRef.current = es;
    es.addEventListener('start', (e) => setLog((l) => [...l, { line: `$ ${(e as MessageEvent).data}`, err: false }]));
    es.addEventListener('stdout', (e) => setLog((l) => [...l, { line: (e as MessageEvent).data, err: false }]));
    es.addEventListener('stderr', (e) => setLog((l) => [...l, { line: (e as MessageEvent).data, err: true }]));
    es.addEventListener('done', (e) => { if ((e as MessageEvent).data !== '0') { setPhase('failed'); es.close(); } });
    es.addEventListener('restart', () => {
      es.close(); setPhase('restarting');
      // Poll until the server is back, then reload the page.
      const started = Date.now();
      const poll = () => {
        if (!alive.current) return;
        fetch('/api/health', { signal: AbortSignal.timeout(4000), cache: 'no-store' }).then((r) => { if (r.ok) location.reload(); else throw new Error(); })
          .catch(() => {
            if (!alive.current) return;
            if (Date.now() - started < 120000) pollRef.current = setTimeout(poll, 1000);
            else { setPhase('failed'); setLog((l) => [...l, { line: t('update.restartTimeout'), err: true }]); }
          });
      };
      pollRef.current = setTimeout(poll, 2000);
    });
    es.onerror = () => { es.close(); setPhase((p) => p === 'running' ? 'failed' : p); setLog((l) => [...l, { line: t('update.connectionLost'), err: true }]); };
  };

  return (
    <div data-update-locked={locked} className="fade-in fixed inset-0 z-40 bg-black/50 flex items-center justify-center" onClick={close}>
      <div className="w-[640px] max-w-[92vw] max-h-[85vh] glass-pop pop-in !rounded-[22px] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center px-5 h-12 border-b border-white/10">
          <div className="font-medium">{t('update.title')}</div>
          <div className="flex-1" />
          <button className="text-xs text-zinc-400 hover:text-white mr-3 flex items-center gap-1 disabled:opacity-60" onClick={onRefresh} disabled={checking || locked}>
            <span className={`inline-block ${checking ? 'animate-spin' : ''}`}>↻</span>{checking ? t('update.checking') : t('update.checkAgain')}
          </button>
          <button className="w-7 h-7 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors" onClick={close} disabled={locked} title={locked ? t('update.locked') : undefined}><Icon name="close" /></button>
        </div>
        <div className="p-5 space-y-3 overflow-y-auto text-sm">
          {!status && !checking && <div className="text-zinc-500">{t('update.checking')}</div>}
          {checking && <div className="text-zinc-500 text-xs">{t('update.checking')}</div>}
          {status?.error && <div className="text-amber-300 text-xs">{status.error}</div>}
          {status && !status.error && (
            <div className="text-xs text-zinc-400 space-y-0.5">
              <div>{t('update.installed')}: <span className="text-zinc-200">v{status.installed.version}</span> <span className="font-mono">{status.installed.commit}</span>{status.installed.builtAt ? ` · ${new Date(status.installed.builtAt).toLocaleString()}` : ''}</div>
              <div>{t(release ? 'update.latestRelease' : 'update.pushed')}: <span className="text-zinc-200">v{status.remote?.version ?? '?'}</span> <span className="font-mono">{status.remote?.commit ?? ''}</span>{status.branch ? ` · ${status.branch}` : ''}</div>
            </div>
          )}
          {status && status.available ? (
            <div className="rounded-lg border border-white/10 divide-y divide-white/5">
              {status.commits.length === 0 && <div className="px-3 py-1.5 text-xs text-zinc-500">{t(release ? 'update.newReleaseAvailable' : 'update.newBuildAvailable')}</div>}
              {status.commits.map((c) => (
                <div key={c.hash} className="px-3 py-1.5 flex gap-3"><span className="font-mono text-zinc-500 text-xs">{c.hash}</span><span className="truncate">{c.subject}</span></div>
              ))}
            </div>
          ) : status && !status.error ? <div className="text-zinc-400">{t('update.upToDate')}</div> : null}
          <div className="flex gap-2">
            <button disabled={phase === 'running' || phase === 'restarting' || !status || !status.available}
              className="rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 px-3 py-1.5 disabled:opacity-40" onClick={() => apply(false)}>
              {t('update.apply')}
            </button>
            <button disabled={phase === 'running' || phase === 'restarting' || !status || !!status.error}
              className="rounded-full bg-fill hover:bg-fill-2 transition-colors text-zinc-200 px-3 py-1.5 disabled:opacity-40"
              title={t(release ? 'update.reinstallReleaseHint' : 'update.reinstallHint')}
              onClick={() => { if (window.confirm(t(release ? 'update.reinstallReleaseConfirm' : 'update.reinstallConfirm', { v: status?.remote?.version ?? '' }))) apply(false); }}>
              {t('update.reinstall')}
            </button>
            {phase === 'failed' && <button className="rounded-full bg-fill hover:bg-fill-2 transition-colors px-3 py-1.5 text-xs" onClick={() => apply(true, lastVersion)}>{t('update.force')}</button>}
          </div>
          {release && !!status?.releases?.length && (
            <RecentReleases releases={status.releases} installed={status.installed.version} disabled={locked}
              onInstall={(r, older) => { if (window.confirm(t(older ? 'update.rollbackConfirm' : 'update.installConfirm', { v: r.version, cur: status.installed.version }))) apply(false, r.version); }} />
          )}
          {locked && <div className="text-amber-200/80 text-[11px]">{t('update.locked')}</div>}
          {phase === 'restarting' && <div className="text-emerald-300 text-xs animate-pulse">{t('update.restarting')}</div>}
          {log.length > 0 && (
            <div ref={logRef} className="rounded-lg bg-black/50 p-3 font-mono text-[12px] max-h-64 overflow-auto">
              {log.map((l, i) => <div key={i} className={l.err ? 'text-amber-200' : 'text-zinc-300'}>{l.line}</div>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Standalone app: the last releases with their notes; any one can be installed, older ones to roll back. */
export function RecentReleases({ releases, installed, disabled, onInstall }: { releases: ReleaseSummary[]; installed: string; disabled: boolean; onInstall: (r: ReleaseSummary, older: boolean) => void }) {
  useLang();
  const [open, setOpen] = useState<string | null>(null);
  const cmp = (a: string, b: string) => {
    const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    return 0;
  };
  return (
    <div>
      <div className="text-xs text-zinc-500 mb-1.5">{t('update.recentReleases')}</div>
      <div className="rounded-lg border border-white/10 divide-y divide-white/5">
        {releases.map((r) => {
          const order = cmp(r.version, installed);
          return (
            <div key={r.tag} className="text-xs">
              <div className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/[0.03]" onClick={() => setOpen(open === r.tag ? null : r.tag)}>
                <span className="text-zinc-600 text-[10px] w-2">{r.notes ? (open === r.tag ? '▾' : '▸') : ''}</span>
                <span className="font-mono text-zinc-100">v{r.version}</span>
                {r.name && r.name !== r.tag && <span className="truncate min-w-0 text-zinc-400">{r.name}</span>}
                <span className="shrink-0 text-zinc-600">{r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : ''}</span>
                <div className="flex-1" />
                {order === 0
                  ? <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10.5px] text-emerald-200">{t('update.current')}</span>
                  : <button disabled={disabled} onClick={(e) => { e.stopPropagation(); onInstall(r, order < 0); }}
                      className={`shrink-0 rounded px-2 py-0.5 disabled:opacity-40 ${order < 0 ? 'bg-white/5 hover:bg-white/10 text-zinc-300' : 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200'}`}>
                      {order < 0 ? t('update.rollback') : t('update.installThis')}
                    </button>}
              </div>
              {open === r.tag && r.notes && <div className="px-8 pb-2.5 whitespace-pre-wrap text-[11.5px] leading-relaxed text-zinc-400 max-h-48 overflow-y-auto">{r.notes}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
