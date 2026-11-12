import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { t, useLang } from '../../lib/i18n';
import type { ChatItem } from '../../lib/chatStore';
import type { AgentId, PermissionModeId } from '../../lib/agent';
import {
  closeSession, remoteBridge, remoteOnly, startSession, useRemoteChat, useRemoteDraft, useRemoteModels, useRemoteSessions, useRemoteState, watchSession,
  type RemoteHistoryRow, type RemoteHostView, type RemoteModel, type RemoteProjects, type RemoteSessionSummary, type RemoteState,
} from '../../lib/remote';
import { AssistantItem, ApprovalItem, QuestionItem, ResultItem, summarizeInput } from '../ChatItems';
import AgentIcon from '../AgentIcon';
import PlanView from '../PlanView';
import Icon from '../Icon';
import HostSettings from './HostSettings';

/*
 * Remote tab: work on another Vibrato's sessions (server/remote/host.ts) without screen sharing. Left: the
 * connection, then the host's projects and sessions. Right: one session's chat, or the new-session form.
 * Deliberately small: chat, approvals, questions, interrupt, mode. No files, terminal or git.
 */

const MODES: { id: PermissionModeId; key: string }[] = [
  { id: 'default', key: 'chat.mode.default' },
  { id: 'acceptEdits', key: 'chat.mode.acceptEdits' },
  { id: 'plan', key: 'chat.mode.plan' },
  { id: 'bypassPermissions', key: 'chat.mode.bypass' },
];

const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return t('remote.ago.now');
  if (s < 3600) return t('remote.ago.min', { n: Math.floor(s / 60) });
  if (s < 86400) return t('remote.ago.hour', { n: Math.floor(s / 3600) });
  return t('remote.ago.day', { n: Math.floor(s / 86400) });
}

type Selection = { kind: 'session'; id: string } | { kind: 'new'; cwd: string; resume?: RemoteHistoryRow } | null;

export default function RemoteView() {
  useLang();
  const state = useRemoteState();
  const connected = state.status === 'connected';
  const sessions = useRemoteSessions(connected);
  const [project, setProject] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection>(null);
  const [hostPanel, setHostPanel] = useState(false);
  // A new connection (or another host) starts from the project list.
  useEffect(() => { if (!state.hostId) { setProject(null); setSel(null); } }, [state.hostId]);

  if (!remoteBridge()) return <div className="flex-1 flex items-center justify-center text-sm text-zinc-400">{t('remote.needsApp')}</div>;

  return (
    <div className="flex-1 min-w-0 min-h-0 flex gap-4 px-[42px] pb-4">
      <aside className="glass w-[320px] shrink-0 flex flex-col overflow-hidden">
        <ConnectionPanel state={state} />
        {connected && (
          <Browser sessions={sessions} project={project} setProject={setProject} sel={sel} setSel={setSel} />
        )}
        {!remoteOnly() && (
          <div className="shrink-0 border-t border-line p-2">
            <button className={`w-full h-8 rounded-lg text-xs transition-colors ${hostPanel ? 'bg-fill-3 text-white' : 'text-zinc-300 hover:bg-fill-2 hover:text-white'}`} onClick={() => setHostPanel((v) => !v)}>
              {t('remote.host.toggle')}
            </button>
          </div>
        )}
        {/* Last in the panel: the host's usage, refreshed only on request. */}
        {connected && <UsagePanel hostKey={String(state.hostId)} />}
      </aside>
      <section className="glass flex-1 min-w-0 flex flex-col overflow-hidden">
        {hostPanel && !remoteOnly() ? <HostSettings onClose={() => setHostPanel(false)} />
          : !connected ? <Placeholder text={state.status === 'reconnecting' ? t('remote.reconnectingHint') : t('remote.connectFirst')} />
          : sel?.kind === 'session' ? <Chat key={sel.id} summary={sessions.find((s) => s.id === sel.id) ?? null} id={sel.id} onClosed={() => setSel(null)} />
          : sel?.kind === 'new' ? <NewSession key={`${sel.cwd}:${sel.resume?.sessionId ?? ''}`} cwd={sel.cwd} resume={sel.resume} onStarted={(id) => setSel({ kind: 'session', id })} onCancel={() => setSel(null)} />
          : <Placeholder text={t('remote.pickSession')} />}
      </section>
    </div>
  );
}

function Placeholder({ text }: { text: string }) {
  return <div className="flex-1 flex items-center justify-center p-8 text-center text-sm text-zinc-400 whitespace-pre-line">{text}</div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-[11px] text-zinc-400 space-y-1"><span>{label}</span>{children}</label>;
}

const inputCls = 'w-full h-8 rounded-lg bg-black/30 border border-white/10 px-2.5 text-[13px] text-zinc-100 outline-none focus:border-white/30';
const btnCls = 'h-8 px-3 shrink-0 whitespace-nowrap rounded-lg text-xs font-medium transition-colors disabled:opacity-40';
const primaryCls = `${btnCls} bg-selected text-on-selected hover:opacity-90`;
const ghostCls = `${btnCls} text-zinc-300 hover:bg-fill-2 hover:text-white`;

// ---- connection ----

function ConnectionPanel({ state }: { state: RemoteState }) {
  const b = remoteBridge()!;
  const [hosts, setHosts] = useState<RemoteHostView[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [editing, setEditing] = useState<RemoteHostView | 'new' | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const reload = () => b.hosts().then((list) => { setHosts(list); setHostId((cur) => cur && list.some((h) => h.id === cur) ? cur : state.hostId ?? list[0]?.id ?? null); });
  useEffect(() => { void reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The fingerprint is pinned on the first login: show it once connected.
  useEffect(() => { if (state.status === 'connected') void reload(); }, [state.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const host = hosts.find((h) => h.id === (state.hostId ?? hostId)) ?? null;

  const connect = async () => {
    if (!host) return;
    setBusy(true);
    try { await b.connect({ hostId: host.id, code: code.trim() || undefined, password: password || undefined, remember }); setCode(''); setPassword(''); }
    finally { setBusy(false); void reload(); }
  };

  if (editing) return <HostForm host={editing === 'new' ? null : editing} onDone={(h) => { setEditing(null); if (h) setHostId(h.id); void reload(); }} onRemove={editing !== 'new' ? async () => { await b.removeHost(editing.id); setEditing(null); void reload(); } : undefined} />;

  if (state.status === 'connected' || state.status === 'connecting' || state.status === 'reconnecting') {
    return (
      <div className="shrink-0 p-3 border-b border-line space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${state.status === 'connected' ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
          <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-zinc-100">{host?.name ?? state.hostName ?? ''}</span>
          <button className={ghostCls} onClick={() => void b.disconnect()}>{t('remote.disconnect')}</button>
        </div>
        <div className="text-[11px] text-zinc-400 truncate">
          {state.status === 'connected' ? t('remote.connectedTo', { host: state.hostName ?? '', addr: host ? `${host.address}:${host.port}` : '' })
            : state.status === 'reconnecting' ? t('remote.reconnecting', { n: state.attempt }) : t('remote.connecting')}
        </div>
        {state.status === 'reconnecting' && state.error && <div className="text-[11px] text-amber-300/90 truncate">{state.error.message}</div>}
      </div>
    );
  }

  const err = state.error && (state.hostId === host?.id || !host) ? state.error : null;
  return (
    <div className="shrink-0 p-3 border-b border-line space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-zinc-200 flex-1">{t('remote.hosts')}</span>
        <button className={ghostCls} onClick={() => setEditing('new')}>{t('remote.addHost')}</button>
      </div>
      {hosts.length === 0 ? <div className="text-[12px] text-zinc-400">{t('remote.noHosts')}</div> : (
        <div className="space-y-1 max-h-40 overflow-auto">
          {hosts.map((h) => (
            <div key={h.id} className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 cursor-pointer ${h.id === host?.id ? 'bg-fill-3' : 'hover:bg-fill-2'}`} onClick={() => setHostId(h.id)}>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-zinc-100 truncate">{h.name}</div>
                <div className="text-[11px] text-zinc-400 truncate">{h.address}:{h.port}{h.hasCode ? ` · ${t('remote.codeSaved')}` : ''}</div>
              </div>
              <button className="opacity-0 group-hover:opacity-100 text-[11px] text-zinc-400 hover:text-white" onClick={(e) => { e.stopPropagation(); setEditing(h); }}>{t('remote.edit')}</button>
            </div>
          ))}
        </div>
      )}
      {host && (
        <>
          {!host.hasCode && (
            <Field label={t('remote.code')}>
              <input type="password" className={`${inputCls} font-mono tracking-wider`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void connect(); }} autoComplete="off" spellCheck={false} />
            </Field>
          )}
          <Field label={t('remote.password')}>
            <input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('remote.passwordPh')}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void connect(); }} autoComplete="off" />
          </Field>
          {!host.hasCode && (
            <label className="flex items-center gap-2 text-[12px] text-zinc-300"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{t('remote.remember')}</label>
          )}
          <div className="flex items-center gap-2">
            <button className={`${primaryCls} flex-1`} disabled={busy || (!host.hasCode && !code.trim()) || !password} onClick={() => void connect()}>{busy ? t('remote.connecting') : t('remote.connect')}</button>
            {host.hasCode && <button className={ghostCls} onClick={() => void b.forgetCode(host.id).then(reload)}>{t('remote.forgetCode')}</button>}
          </div>
        </>
      )}
      {err && <ConnectError host={host} err={err} onTrusted={() => void connect()} />}
    </div>
  );
}

function ConnectError({ host, err, onTrusted }: { host: RemoteHostView | null; err: NonNullable<RemoteState['error']>; onTrusted: () => void }) {
  const b = remoteBridge()!;
  const msg = err.code === 'DENIED_CODE' ? t('remote.err.code')
    : err.code === 'DENIED_LOCKED' ? t('remote.err.locked', { s: Math.ceil((err.retryAfterMs ?? 30000) / 1000) })
    : err.code === 'DENIED_BUSY' ? t('remote.err.busy')
    : err.code === 'DENIED_DISABLED' ? t('remote.err.disabled')
    : err.code === 'DENIED_NOPASSWORD' ? t('remote.err.hostNoPassword')
    : err.code === 'NEED_PASSWORD' ? t('remote.err.needPassword')
    : err.code === 'KICKED' ? t('remote.err.kicked')
    : err.code === 'KICKED_IDLE' ? t('remote.err.idle')
    : err.code === 'NEED_CODE' ? t('remote.err.needCode')
    : err.code === 'FINGERPRINT_MISMATCH' ? t('remote.err.fingerprint')
    : err.code === 'BAD_HOST' ? t('remote.err.badHost', { message: err.message })
    : t('remote.err.network', { message: err.message });
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-[12px] text-red-200 space-y-2">
      <div className="whitespace-pre-line">{msg}</div>
      {err.code === 'FINGERPRINT_MISMATCH' && err.fingerprint && host && (
        <>
          <div className="text-[11px] text-zinc-300">{t('remote.fp.was')}<div className="font-mono break-all text-zinc-400">{host.fingerprint}</div></div>
          <div className="text-[11px] text-zinc-300">{t('remote.fp.now')}<div className="font-mono break-all text-zinc-100">{err.fingerprint}</div></div>
          <button className={`${ghostCls} border border-red-400/40`} onClick={() => void b.trust(host.id, err.fingerprint!).then(onTrusted)}>{t('remote.fp.trust')}</button>
        </>
      )}
    </div>
  );
}

function HostForm({ host, onDone, onRemove }: { host: RemoteHostView | null; onDone: (h: RemoteHostView | null) => void; onRemove?: () => void }) {
  const b = remoteBridge()!;
  const [name, setName] = useState(host?.name ?? '');
  const [address, setAddress] = useState(host?.address ?? '');
  const [port, setPort] = useState(String(host?.port ?? 11399));
  const [error, setError] = useState('');
  const save = async () => {
    try { onDone(await b.saveHost({ id: host?.id, name, address, port })); }
    catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  };
  return (
    <div className="shrink-0 p-3 border-b border-line space-y-2.5">
      <div className="text-xs font-semibold text-zinc-200">{host ? t('remote.editHost') : t('remote.addHost')}</div>
      <Field label={t('remote.hostName')}><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('remote.hostNamePh')} /></Field>
      <Field label={t('remote.address')}><input className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="203.0.113.7 / home.example.com" spellCheck={false} /></Field>
      <Field label={t('remote.port')}><input className={inputCls} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} inputMode="numeric" /></Field>
      {host?.fingerprint && <div className="text-[11px] text-zinc-400">{t('remote.fp.pinned')}<div className="font-mono break-all">{host.fingerprint}</div></div>}
      {error && <div className="text-[12px] text-red-300">{error}</div>}
      <div className="flex items-center gap-2">
        <button className={`${primaryCls} flex-1`} disabled={!address.trim()} onClick={() => void save()}>{t('remote.save')}</button>
        <button className={ghostCls} onClick={() => onDone(null)}>{t('remote.cancel')}</button>
        {onRemove && <button className={`${ghostCls} text-red-300`} onClick={onRemove}>{t('remote.remove')}</button>}
      </div>
    </div>
  );
}

// ---- projects and sessions ----

function Browser({ sessions, project, setProject, sel, setSel }: {
  sessions: RemoteSessionSummary[]; project: string | null; setProject: (p: string | null) => void; sel: Selection; setSel: (s: Selection) => void;
}) {
  const b = remoteBridge()!;
  const [projects, setProjects] = useState<RemoteProjects | null>(null);
  const [history, setHistory] = useState<RemoteHistoryRow[] | null>(null);
  const [path, setPath] = useState('');
  useEffect(() => { void b.call<RemoteProjects>('projects').then(setProjects).catch(() => setProjects({ favorites: [], recent: [] })); }, [sessions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setHistory(null);
    if (!project) return;
    let alive = true;
    void b.call<RemoteHistoryRow[]>('history', { cwd: project }).then((h) => { if (alive) setHistory(h); }).catch(() => { if (alive) setHistory([]); });
    return () => { alive = false; };
  }, [project]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => {
    const seen = new Set<string>();
    const out: { path: string; name: string }[] = [];
    for (const f of projects?.favorites ?? []) if (!seen.has(f.path)) { seen.add(f.path); out.push(f); }
    for (const r of projects?.recent ?? []) if (!seen.has(r)) { seen.add(r); out.push({ path: r, name: base(r) }); }
    // Folders with live sessions that are in neither list (started elsewhere).
    for (const s of sessions) if (!seen.has(s.cwd)) { seen.add(s.cwd); out.push({ path: s.cwd, name: base(s.cwd) }); }
    return out;
  }, [projects, sessions]);

  const live = (cwd: string) => sessions.filter((s) => s.cwd === cwd).sort((a, z) => z.lastActivity - a.lastActivity);
  const selectedId = sel?.kind === 'session' ? sel.id : null;
  const resumeId = sel?.kind === 'new' ? sel.resume?.sessionId : undefined;

  if (project) {
    const mine = live(project);
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="shrink-0 px-3 pt-3 pb-3 border-b border-line">
          <div className="flex items-center gap-2.5">
            <button className="w-7 h-7 shrink-0 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-fill-2 transition-colors"
              title={t('remote.projects')} aria-label={t('remote.projects')} onClick={() => setProject(null)}>
              <Icon name="back" size={14} />
            </button>
            <ProjectBadge name={base(project)} size={32} />
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold text-zinc-100 truncate">{base(project)}</div>
              <div className="text-[11px] text-zinc-500 truncate" title={project}>{tildify(project)}</div>
            </div>
          </div>
          <button className={`mt-3 w-full h-9 flex items-center justify-center gap-2 rounded-xl border text-[13px] font-medium transition-colors ${sel?.kind === 'new' && !sel.resume ? 'bg-selected text-on-selected border-transparent' : 'border-white/10 bg-white/[0.05] text-zinc-100 hover:bg-white/[0.09]'}`}
            onClick={() => setSel({ kind: 'new', cwd: project })}>
            <Icon name="plus" size={14} />
            {t('remote.newSession')}
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-2 py-3 space-y-4">
          <Group title={t('remote.liveSessions')} count={mine.length}>
            {mine.length === 0 ? <Empty text={t('remote.noLive')} /> : mine.map((s) => <SessionRow key={s.id} s={s} active={s.id === selectedId} onClick={() => setSel({ kind: 'session', id: s.id })} />)}
          </Group>
          <Group title={t('remote.history')} count={history?.length}>
            {history === null ? <Empty text={t('common.loading')} /> : history.length === 0 ? <Empty text={t('remote.noHistory')} /> : history.map((h) => (
              <button key={`${h.agent}:${h.sessionId}`} title={h.title}
                className={`group w-full flex items-start gap-2.5 text-left rounded-xl px-2.5 py-2 transition-colors ${resumeId === h.sessionId ? 'bg-fill-3' : 'hover:bg-fill-2'}`}
                onClick={() => setSel({ kind: 'new', cwd: project, resume: h })}>
                <AgentIcon agent={h.agent} size={16} className="mt-0.5 shrink-0 opacity-80 group-hover:opacity-100" />
                <span className="flex-1 min-w-0 text-[12.5px] leading-[18px] text-zinc-200 line-clamp-2 break-words">{h.title}</span>
                <span className="shrink-0 mt-0.5 text-[10.5px] text-zinc-500 tabular-nums">{ago(h.lastModified)}</span>
              </button>
            ))}
          </Group>
        </div>
      </div>
    );
  }

  const active = [...sessions].sort((a, z) => Number(z.waiting > 0) - Number(a.waiting > 0) || Number(z.running) - Number(a.running) || z.lastActivity - a.lastActivity);
  const open = () => { if (path.trim()) setProject(path.trim()); };
  return (
    <div className="flex-1 min-h-0 overflow-auto px-2 py-3 space-y-4">
      <Group title={t('remote.liveSessions')} count={active.length}>
        {active.length === 0 ? <Empty text={t('remote.noLive')} /> : active.map((s) => <SessionRow key={s.id} s={s} showProject active={s.id === selectedId} onClick={() => setSel({ kind: 'session', id: s.id })} />)}
      </Group>
      <Group title={t('remote.projects')} count={projects ? list.length : undefined}>
        {projects === null ? <Empty text={t('common.loading')} /> : list.length === 0 ? <Empty text={t('remote.noProjects')} /> : list.map((p) => {
          const n = live(p.path).length;
          return (
            <button key={p.path} className="w-full flex items-center gap-2.5 text-left rounded-xl px-2.5 py-2 hover:bg-fill-2 transition-colors" onClick={() => setProject(p.path)} title={p.path}>
              <ProjectBadge name={p.name} size={28} />
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-medium text-zinc-100 truncate">{p.name}</span>
                <span className="block text-[10.5px] text-zinc-500 truncate">{tildify(p.path)}</span>
              </span>
              {n > 0 && <span className="shrink-0 flex items-center gap-1 rounded-full bg-sky-400/15 px-2 py-0.5 text-[10.5px] text-sky-200"><span className="w-1.5 h-1.5 rounded-full bg-sky-400" />{n}</span>}
            </button>
          );
        })}
        <div className="mt-1.5 mx-1 flex items-center rounded-xl border border-white/10 bg-black/25 focus-within:border-white/25 transition-colors">
          <input className="flex-1 min-w-0 h-8 bg-transparent px-3 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600" value={path} onChange={(e) => setPath(e.target.value)}
            placeholder={t('remote.pathPh')} spellCheck={false} onKeyDown={(e) => { if (e.key === 'Enter') open(); }} />
          <button className="h-8 px-3 shrink-0 text-[12px] text-zinc-300 hover:text-white disabled:opacity-30" disabled={!path.trim()} onClick={open}>{t('remote.open')}</button>
        </div>
      </Group>
    </div>
  );
}

/** Home folder as "~", the way paths read in a terminal. */
const tildify = (p: string) => p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~').replace(/^C:\\Users\\[^\\]+/i, '~');

const BADGE_TONES = ['from-sky-400/40 to-indigo-500/40', 'from-emerald-400/40 to-teal-500/40', 'from-amber-300/40 to-orange-500/40', 'from-fuchsia-400/40 to-violet-500/40', 'from-rose-400/40 to-pink-500/40', 'from-lime-300/40 to-emerald-500/40'];

/** A folder's first letter on a tinted square; the tint follows the name, so a project keeps its colour. */
function ProjectBadge({ name, size }: { name: string; size: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={`shrink-0 flex items-center justify-center rounded-lg bg-gradient-to-br ${BADGE_TONES[h % BADGE_TONES.length]} border border-white/10 font-semibold text-white/90`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}>
      {(name.match(/[\p{L}\p{N}]/u)?.[0] ?? '·').toUpperCase()}
    </span>
  );
}

function Group({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 px-2.5 pb-1.5">
        <span className="text-[11px] font-semibold tracking-wide text-zinc-400">{title}</span>
        {count !== undefined && count > 0 && <span className="rounded-full bg-fill-2 px-1.5 text-[10px] leading-4 text-zinc-400 tabular-nums">{count}</span>}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="mx-1 rounded-xl border border-dashed border-white/10 px-3 py-2.5 text-center text-[11.5px] text-zinc-500">{text}</div>;
}

function SessionRow({ s, active, showProject, onClick }: { s: RemoteSessionSummary; active: boolean; showProject?: boolean; onClick: () => void }) {
  const dot = s.waiting ? 'bg-amber-400' : s.running ? 'bg-sky-400 animate-pulse' : 'bg-zinc-500';
  return (
    <button className={`w-full flex items-center gap-2.5 text-left rounded-xl px-2.5 py-2 transition-colors ${active ? 'bg-fill-3' : 'hover:bg-fill-2'}`} onClick={onClick}>
      <span className="relative shrink-0">
        <AgentIcon agent={s.agent} size={18} />
        <span className={`absolute -right-0.5 -bottom-0.5 w-2 h-2 rounded-full ring-2 ring-[#16181d] ${dot}`} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[12.5px] text-zinc-100 truncate">{s.title || t('remote.untitled')}</span>
        <span className="block text-[10.5px] text-zinc-500 truncate">{showProject ? `${base(s.cwd)} · ` : ''}{s.running ? t('remote.working') : ago(s.lastActivity)}</span>
      </span>
      {s.waiting > 0 && <span className="shrink-0 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10.5px] text-amber-200">{t('remote.waiting', { n: s.waiting })}</span>}
    </button>
  );
}

// ---- new session ----

function NewSession({ cwd, resume, onStarted, onCancel }: { cwd: string; resume?: RemoteHistoryRow; onStarted: (id: string) => void; onCancel: () => void }) {
  const b = remoteBridge()!;
  const [agent, setAgent] = useState<AgentId>(resume?.agent ?? 'claude');
  const [mode, setMode] = useState<PermissionModeId>('default');
  const [model, setModel] = useState('');
  const conn = useRemoteState();
  const models = useRemoteModels(agent, conn.since ? String(conn.hostId) : null);
  useEffect(() => { setModel(''); }, [agent]);
  const [text, setText] = useRemoteDraft(`new:${cwd}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = async () => {
    setBusy(true); setError('');
    try {
      const id = await startSession({ agent, cwd, permissionMode: mode, resume: resume?.sessionId, model: model || undefined });
      if (text.trim()) await b.call('send', { sessionId: id, text: text.trim() });
      setText('');
      onStarted(id);
    } catch (e) { setError(cleanErr(e)); setBusy(false); }
  };
  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-xl mx-auto space-y-4">
        <div>
          <div className="text-base font-semibold text-zinc-100">{resume ? t('remote.resumeTitle') : t('remote.newTitle')}</div>
          <div className="text-[12px] text-zinc-400 break-all">{cwd}</div>
          {resume && <div className="mt-1 text-[13px] text-zinc-300">“{resume.title}”</div>}
        </div>
        {!resume && (
          <Field label={t('remote.agent')}>
            <div className="flex gap-1">
              {(['claude', 'codex'] as AgentId[]).map((a) => (
                <button key={a} className={`${btnCls} ${agent === a ? 'bg-fill-3 text-white' : 'text-zinc-300 hover:bg-fill-2'}`} onClick={() => setAgent(a)}>{a === 'claude' ? 'Claude' : 'Codex'}</button>
              ))}
            </div>
          </Field>
        )}
        {models && models.length > 0 && (
          <Field label={t('remote.model')}>
            <ModelSelect models={models} value={model} onChange={setModel} className={inputCls} />
          </Field>
        )}
        <Field label={t('remote.mode')}>
          <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as PermissionModeId)}>
            {MODES.map((m) => <option key={m.id} value={m.id}>{t(m.key)}</option>)}
          </select>
        </Field>
        {mode === 'bypassPermissions' && <div className="text-[12px] text-amber-300">{t('remote.bypassWarn')}</div>}
        <Field label={t('remote.firstMessage')}>
          <textarea className={`${inputCls} h-32 py-2 resize-none`} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('remote.firstMessagePh')}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void start(); } }} />
        </Field>
        {error && <div className="text-[12px] text-red-300">{error}</div>}
        <div className="flex gap-2">
          <button className={primaryCls} disabled={busy} onClick={() => void start()}>{busy ? t('remote.starting') : resume ? t('remote.resume') : t('remote.start')}</button>
          <button className={ghostCls} onClick={onCancel}>{t('remote.cancel')}</button>
        </div>
      </div>
    </div>
  );
}

const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---- chat ----

function Chat({ id, summary, onClosed }: { id: string; summary: RemoteSessionSummary | null; onClosed: () => void }) {
  useLang();
  const b = remoteBridge()!;
  const chat = useRemoteChat(id);
  const [text, setText] = useRemoteDraft(id);
  const [error, setError] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (!summary && !chat) return;
    void watchSession(summary ?? { id, agent: chat!.agent, cwd: chat!.cwd }).catch((e) => setError(cleanErr(e)));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [chat?.items]);

  const items = (chat?.items ?? []).filter((it) => !((it.kind === 'assistant' || it.kind === 'tool') && it.parent));
  const running = chat ? chat.status === 'running' || chat.status === 'compacting' : !!summary?.running;
  const gone = !summary && chat?.status === 'closed';
  const mode = chat?.permissionMode ?? (summary?.permissionMode as PermissionModeId | undefined) ?? 'default';
  const conn = useRemoteState();
  const models = useRemoteModels(chat?.agent ?? summary?.agent, conn.since ? String(conn.hostId) : null);
  // Switching models sends no new session.init: show the choice until the session reports another one.
  const [pickedModel, setPickedModel] = useState<{ value: string; from: string | undefined } | null>(null);
  const shownModel = pickedModel && pickedModel.from === chat?.model ? pickedModel.value : chat?.model ?? '';

  // Plan view first: from afar the steps and results matter, not every shell command. The choice is remembered.
  const [view, setViewState] = useState<'plan' | 'chat'>(() => { try { return localStorage.getItem(VIEW_KEY) === 'chat' ? 'chat' : 'plan'; } catch { return 'plan'; } });
  const setView = (v: 'plan' | 'chat') => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ } };
  useEffect(() => { if (view === 'chat') { stick.current = true; const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; } }, [view]);
  const activity = running && chat ? activityOf(chat.items, chat.status) : null;

  const act = (p: Promise<unknown>) => void p.catch((e) => setError(cleanErr(e)));
  const send = () => {
    const v = text.trim();
    if (!v) return;
    setText(''); setError('');
    stick.current = true;
    act(b.call('send', { sessionId: id, text: v }));
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-12 shrink-0 flex items-center gap-2 px-4 border-b border-line">
        <span className={`w-2 h-2 rounded-full ${running ? 'bg-sky-400 animate-pulse' : gone ? 'bg-zinc-600' : 'bg-emerald-400'}`} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-zinc-100 truncate">{summary?.title || t('remote.untitled')}</div>
          <div className="text-[11px] text-zinc-500 truncate">{(chat?.agent ?? summary?.agent) === 'codex' ? 'Codex' : 'Claude'} · {base(chat?.cwd ?? summary?.cwd ?? '')}</div>
        </div>
        <div className="shrink-0 flex items-center p-0.5 rounded-full bg-black/30 border border-white/10 text-[11.5px]">
          {(['plan', 'chat'] as const).map((v) => (
            <button key={v} className={`h-6 px-2.5 rounded-full transition-colors ${view === v ? 'bg-fill-3 text-white' : 'text-zinc-400 hover:text-white'}`} onClick={() => setView(v)}>{t(`plan.view.${v}`)}</button>
          ))}
        </div>
        {models && models.length > 0 && (
          <ModelSelect models={models} value={shownModel} disabled={gone}
            onChange={(v) => { setPickedModel({ value: v, from: chat?.model }); act(b.call('model', { sessionId: id, model: v || null })); }}
            className="h-7 max-w-[180px] rounded-lg bg-black/30 border border-white/10 px-2 text-[12px] text-zinc-200 outline-none" />
        )}
        <select className="h-7 rounded-lg bg-black/30 border border-white/10 px-2 text-[12px] text-zinc-200 outline-none" value={mode} disabled={gone}
          onChange={(e) => act(b.call('mode', { sessionId: id, mode: e.target.value }))}>
          {MODES.map((m) => <option key={m.id} value={m.id}>{t(m.key)}</option>)}
        </select>
        {running && <button className={`${btnCls} bg-red-500/20 text-red-200 hover:bg-red-500/30`} onClick={() => act(b.call('interrupt', { sessionId: id }))}>{t('remote.interrupt')}</button>}
        {!gone && <button className={ghostCls} onClick={() => { if (confirm(t('remote.closeConfirm'))) act(closeSession(id).then(onClosed)); }}>{t('remote.closeSession')}</button>}
      </div>
      {view === 'plan' && (
        <div className="flex-1 min-h-0 relative">
          {chat ? (
            <PlanView remote items={chat.items} cwd={chat.cwd} running={running} tasks={chat.tasks} activity={activity}
              onJump={() => setView('chat')}
              onApprove={(requestId, decision, message) => act(b.call('approve', { sessionId: id, requestId, decision, message }))}
              onAnswer={(requestId, answers) => act(b.call('answer', { sessionId: id, requestId, answers }))} />
          ) : <div className="text-center text-[12px] text-zinc-500 pt-8">{t('common.loading')}</div>}
        </div>
      )}
      <div ref={scroller} className={`flex-1 min-h-0 overflow-auto px-5 py-4 space-y-3 ${view === 'plan' ? 'hidden' : ''}`}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {items.length === 0 && <div className="text-center text-[12px] text-zinc-500 pt-8">{chat ? t('remote.emptyChat') : t('common.loading')}</div>}
        {items.map((it) => <Item key={it.id} it={it} cwd={chat?.cwd} sessionId={id} onError={setError} />)}
        {running && <div className="text-[12px] text-zinc-500 animate-pulse">{t('remote.working')}</div>}
      </div>
      {error && <div className="px-4 py-1.5 text-[12px] text-red-300 border-t border-red-500/20 bg-red-500/5">{error}</div>}
      <div className="shrink-0 border-t border-line p-3 flex gap-2 items-end">
        <textarea className="flex-1 min-h-[40px] max-h-48 rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-[13px] text-zinc-100 outline-none focus:border-white/30 resize-none"
          rows={Math.min(8, Math.max(1, text.split('\n').length))} value={text} disabled={gone} placeholder={gone ? t('remote.sessionGone') : t('remote.messagePh')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <button className={`${primaryCls} h-10`} disabled={!text.trim() || gone} onClick={send}>{t('remote.send')}</button>
      </div>
    </div>
  );
}

function Item({ it, cwd, sessionId, onError }: { it: ChatItem; cwd?: string; sessionId: string; onError: (m: string) => void }) {
  const b = remoteBridge()!;
  const act = (p: Promise<unknown>) => void p.catch((e) => onError(cleanErr(e)));
  switch (it.kind) {
    case 'user':
      if (it.compact || it.injected) return null;
      return <div className="flex justify-end"><div className="max-w-[80%] rounded-2xl bg-fill-3 px-3.5 py-2 text-[13px] text-zinc-100 whitespace-pre-wrap break-words">{it.text}</div></div>;
    case 'assistant':
      return it.text ? <AssistantItem item={it} baseDir={cwd} /> : null;
    case 'tool':
      return (
        <div className="flex items-center gap-2 rounded-lg bg-white/[0.03] border border-white/10 px-3 py-1.5 text-[12px]">
          <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${it.done ? (it.isError ? 'bg-red-400' : 'bg-emerald-400') : 'bg-amber-400 animate-pulse'}`} />
          <span className="font-medium text-zinc-200">{it.name}</span>
          <span className="truncate text-zinc-400 font-mono">{summarizeInput(it.name, it.input)}</span>
        </div>
      );
    case 'approval':
      return <ApprovalItem item={it} onDecide={(d, m) => act(b.call('approve', { sessionId, requestId: it.id, decision: d, message: m }))} />;
    case 'question':
      return <QuestionItem item={it} onAnswer={(answers) => act(b.call('answer', { sessionId, requestId: it.id, answers }))} />;
    case 'result':
      return <ResultItem item={it} />;
    case 'error':
      return <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[13px] text-red-200 whitespace-pre-wrap">{it.message}</div>;
    case 'system':
      return <div className="text-xs text-zinc-500 text-center py-1">{it.text}</div>;
    case 'changes':
      return <div className="text-[12px] text-zinc-400">{t('remote.changes', { n: it.files.length })} <span className="text-zinc-500">{it.files.slice(0, 6).map((f) => f.path).join(', ')}{it.files.length > 6 ? '…' : ''}</span></div>;
    case 'verify':
      return <div className={`text-[12px] ${it.status === 'failed' ? 'text-red-300' : it.status === 'passed' ? 'text-emerald-300' : 'text-zinc-400'}`}>{t(`remote.verify.${it.status}`, { cmd: it.command })}</div>;
  }
}

/** Model picker: "" is the CLI's default; a model the session reports but the list lacks still shows as itself. */
function ModelSelect({ models, value: raw, onChange, className, disabled, title }: { models: RemoteModel[]; value: string; onChange: (v: string) => void; className: string; disabled?: boolean; title?: string }) {
  const value = matchModel(models, raw);
  const known = !value || models.some((m) => m.id === value);
  return (
    <select className={className} value={value} disabled={disabled} title={title} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('remote.modelDefault')}</option>
      {!known && <option value={value}>{value}</option>}
      {models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.isDefault ? t('chat.defaultSuffix') : ''}</option>)}
    </select>
  );
}

// ---- the host's usage ----

interface UsageWindow { usedPct: number; resetsAt: number | null }
interface UsageSnapshot {
  fetchedAt: number;
  claude: { fiveHour: UsageWindow | null; weekly: UsageWindow | null; model: (UsageWindow & { name: string }) | null } | null;
  codex: { fiveHour: UsageWindow | null; weekly: UsageWindow | null } | null;
  errors: string[];
}

/** "2h 5m" until a reset given in unix seconds. */
function resetIn(ts: number | null): string {
  if (!ts) return t('usage.noReset');
  const mins = Math.round((ts * 1000 - Date.now()) / 60_000);
  if (mins <= 0) return t('usage.reset');
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return t('usage.resetsAfter', { time: d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m` });
}

/**
 * Bottom of the left panel: how much of the host's Claude and Codex limits is left. Shown once on connect from
 * the host's cached copy; only the refresh button asks the providers again.
 */
function UsagePanel({ hostKey }: { hostKey: string }) {
  useLang();
  const b = remoteBridge()!;
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'unsupported' | 'error'>('idle');
  const load = (force: boolean) => {
    setState('loading');
    void b.call<UsageSnapshot>('usage', { force }).then((u) => { setUsage(u); setState('idle'); },
      (e) => setState(/Unknown method/.test(String((e as Error)?.message)) ? 'unsupported' : 'error'));
  };
  useEffect(() => { setUsage(null); load(false); }, [hostKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (state === 'unsupported') return null;
  const groups: { agent: 'claude' | 'codex'; rows: { label: string; win: UsageWindow | null }[] }[] = usage ? [
    ...(usage.claude ? [{ agent: 'claude' as const, rows: [
      { label: '5h', win: usage.claude.fiveHour },
      { label: t('usage.week'), win: usage.claude.weekly },
      ...(usage.claude.model ? [{ label: usage.claude.model.name, win: usage.claude.model }] : []),
    ] }] : []),
    ...(usage.codex ? [{ agent: 'codex' as const, rows: [
      { label: '5h', win: usage.codex.fiveHour },
      { label: t('usage.week'), win: usage.codex.weekly },
    ] }] : []),
  ] : [];
  return (
    <div className="shrink-0 border-t border-line px-3 pt-2.5 pb-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11px] font-semibold tracking-wide text-zinc-400">{t('remote.usage')}</span>
        {usage && <span className="text-[10px] text-zinc-500 tabular-nums">{t('remote.usageAt', { time: new Date(usage.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</span>}
        <button className="w-6 h-6 flex items-center justify-center rounded-full text-zinc-400 hover:bg-fill-2 hover:text-white disabled:opacity-40" disabled={state === 'loading'}
          title={t('common.refresh')} aria-label={t('common.refresh')} onClick={() => load(true)}>
          <Icon name="reload" size={12} className={state === 'loading' ? 'animate-spin' : ''} />
        </button>
      </div>
      {state === 'error' && <div className="text-[11px] text-red-300">{t('remote.usageFailed')}</div>}
      {usage && groups.length === 0 && <div className="text-[11px] text-zinc-500">{t('remote.usageNone')}</div>}
      {groups.map((g) => (
        <div key={g.agent} className="flex gap-2.5">
          <AgentIcon agent={g.agent} size={14} className="mt-[3px] shrink-0 opacity-80" title={g.agent === 'claude' ? 'Claude' : 'Codex'} />
          <div className="flex-1 min-w-0 space-y-1">
            {g.rows.map((r) => {
              const left = r.win ? Math.max(0, 100 - r.win.usedPct) : null;
              const tone = left === null ? '' : left <= 10 ? 'bg-red-400' : left <= 30 ? 'bg-amber-400' : 'bg-emerald-400';
              return (
                <div key={r.label} className="flex items-center gap-2 text-[11px]" title={r.win ? resetIn(r.win.resetsAt) : undefined}>
                  <span className="w-10 shrink-0 truncate text-zinc-500">{r.label}</span>
                  <span className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden">
                    {left !== null && <span className={`block h-full rounded-full ${tone}`} style={{ width: `${left}%` }} />}
                  </span>
                  <span className={`w-9 shrink-0 text-right tabular-nums ${left === null ? 'text-zinc-600' : left <= 10 ? 'text-red-300' : left <= 30 ? 'text-amber-300' : 'text-zinc-300'}`}>{left === null ? '–' : `${left}%`}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The list names models by alias ("haiku") while a running session reports the full id ("claude-haiku-5-5"):
 * find the entry whose display name ("Haiku 5.5") reads as that id, so the picker shows it by name.
 */
export function matchModel(models: RemoteModel[], id: string): string {
  if (!id || models.some((m) => m.id === id)) return id;
  const want = id.toLowerCase();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const hit = models.find((m) => { const n = slug(m.name); return n.length > 2 && (want === n || want.endsWith(`-${n}`) || want.includes(`-${n}-`)); });
  return hit?.id ?? id;
}

const VIEW_KEY = 'vibe.remote.view';

/** One line on what the agent is doing now, like the chat's status line (shown under the plan step in progress). */
function activityOf(items: ChatItem[], status: string): string | null {
  if (status === 'compacting') return t('activity.compacting');
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'user') break;
    if (it.kind === 'approval' && !it.decision) return t('activity.waitingApproval');
    if (it.kind === 'question' && !it.resolved) return t('activity.waitingAnswer');
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'tool' && !it.done) {
      const isSub = ['Agent', 'Task', 'SubAgent'].includes(it.name);
      const detail = summarizeInput(it.name, it.input).split('\n')[0].slice(0, 60);
      return `${isSub ? t('activity.subagent') : t('activity.running', { tool: it.name })}${detail ? ` · ${detail}` : ''}`;
    }
  }
  return null;
}
