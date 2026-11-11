import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { t, useLang } from '../../lib/i18n';
import type { ChatItem } from '../../lib/chatStore';
import type { AgentId, PermissionModeId } from '../../lib/agent';
import {
  closeSession, remoteBridge, remoteOnly, startSession, useRemoteChat, useRemoteSessions, useRemoteState, watchSession,
  type RemoteHistoryRow, type RemoteHostView, type RemoteProjects, type RemoteSessionSummary, type RemoteState,
} from '../../lib/remote';
import { AssistantItem, ApprovalItem, QuestionItem, ResultItem, summarizeInput } from '../ChatItems';
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
    <div className="flex-1 min-w-0 flex gap-4 px-[42px] pb-4">
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
    try { await b.connect({ hostId: host.id, code: code.trim() || undefined, remember }); setCode(''); }
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
          {!host.hasCode && (
            <label className="flex items-center gap-2 text-[12px] text-zinc-300"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />{t('remote.remember')}</label>
          )}
          <div className="flex items-center gap-2">
            <button className={`${primaryCls} flex-1`} disabled={busy || (!host.hasCode && !code.trim())} onClick={() => void connect()}>{busy ? t('remote.connecting') : t('remote.connect')}</button>
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

  if (project) {
    const mine = live(project);
    return (
      <div className="flex-1 min-h-0 overflow-auto p-2 space-y-3">
        <div className="flex items-center gap-1 px-1">
          <button className="text-zinc-400 hover:text-white text-[13px] px-1" onClick={() => { setProject(null); }}>‹</button>
          <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-zinc-100" title={project}>{base(project)}</span>
          <button className={primaryCls} onClick={() => setSel({ kind: 'new', cwd: project })}>{t('remote.newSession')}</button>
        </div>
        <Group title={t('remote.liveSessions')}>
          {mine.length === 0 ? <Empty text={t('remote.noLive')} /> : mine.map((s) => <SessionRow key={s.id} s={s} active={s.id === selectedId} onClick={() => setSel({ kind: 'session', id: s.id })} />)}
        </Group>
        <Group title={t('remote.history')}>
          {history === null ? <Empty text={t('common.loading')} /> : history.length === 0 ? <Empty text={t('remote.noHistory')} /> : history.map((h) => (
            <button key={`${h.agent}:${h.sessionId}`} className="w-full text-left rounded-lg px-2 py-1.5 hover:bg-fill-2" onClick={() => setSel({ kind: 'new', cwd: project, resume: h })}>
              <div className="text-[12px] text-zinc-200 truncate">{h.title}</div>
              <div className="text-[11px] text-zinc-500">{h.agent === 'claude' ? 'Claude' : 'Codex'} · {ago(h.lastModified)}</div>
            </button>
          ))}
        </Group>
      </div>
    );
  }

  const active = [...sessions].sort((a, z) => Number(z.waiting > 0) - Number(a.waiting > 0) || Number(z.running) - Number(a.running) || z.lastActivity - a.lastActivity);
  return (
    <div className="flex-1 min-h-0 overflow-auto p-2 space-y-3">
      <Group title={t('remote.liveSessions')}>
        {active.length === 0 ? <Empty text={t('remote.noLive')} /> : active.map((s) => <SessionRow key={s.id} s={s} showProject active={s.id === selectedId} onClick={() => setSel({ kind: 'session', id: s.id })} />)}
      </Group>
      <Group title={t('remote.projects')}>
        {projects === null ? <Empty text={t('common.loading')} /> : list.length === 0 ? <Empty text={t('remote.noProjects')} /> : list.map((p) => {
          const n = live(p.path).length;
          return (
            <button key={p.path} className="w-full flex items-center gap-2 text-left rounded-lg px-2 py-1.5 hover:bg-fill-2" onClick={() => setProject(p.path)} title={p.path}>
              <span className="flex-1 min-w-0 truncate text-[13px] text-zinc-200">{p.name}</span>
              {n > 0 && <span className="text-[10px] rounded-full bg-fill-3 px-1.5 py-0.5 text-zinc-200">{n}</span>}
            </button>
          );
        })}
        <div className="flex gap-1 px-1 pt-1">
          <input className={`${inputCls} h-7 text-[12px]`} value={path} onChange={(e) => setPath(e.target.value)} placeholder={t('remote.pathPh')} spellCheck={false}
            onKeyDown={(e) => { if (e.key === 'Enter' && path.trim()) setProject(path.trim()); }} />
          <button className={`${ghostCls} h-7`} disabled={!path.trim()} onClick={() => setProject(path.trim())}>{t('remote.open')}</button>
        </div>
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <div><div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{title}</div><div className="space-y-0.5">{children}</div></div>;
}

function Empty({ text }: { text: string }) {
  return <div className="px-2 py-1 text-[12px] text-zinc-500">{text}</div>;
}

function SessionRow({ s, active, showProject, onClick }: { s: RemoteSessionSummary; active: boolean; showProject?: boolean; onClick: () => void }) {
  return (
    <button className={`w-full flex items-center gap-2 text-left rounded-lg px-2 py-1.5 ${active ? 'bg-fill-3' : 'hover:bg-fill-2'}`} onClick={onClick}>
      <span className={`w-1.5 h-1.5 shrink-0 rounded-full ${s.waiting ? 'bg-amber-400' : s.running ? 'bg-sky-400 animate-pulse' : 'bg-zinc-500'}`} />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-zinc-100 truncate">{s.title || t('remote.untitled')}</div>
        <div className="text-[11px] text-zinc-500 truncate">{s.agent === 'claude' ? 'Claude' : 'Codex'}{showProject ? ` · ${base(s.cwd)}` : ''} · {ago(s.lastActivity)}</div>
      </div>
      {s.waiting > 0 && <span className="text-[10px] rounded-full bg-amber-500/25 text-amber-200 px-1.5 py-0.5">{t('remote.waiting', { n: s.waiting })}</span>}
    </button>
  );
}

// ---- new session ----

function NewSession({ cwd, resume, onStarted, onCancel }: { cwd: string; resume?: RemoteHistoryRow; onStarted: (id: string) => void; onCancel: () => void }) {
  const b = remoteBridge()!;
  const [agent, setAgent] = useState<AgentId>(resume?.agent ?? 'claude');
  const [mode, setMode] = useState<PermissionModeId>('default');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = async () => {
    setBusy(true); setError('');
    try {
      const id = await startSession({ agent, cwd, permissionMode: mode, resume: resume?.sessionId });
      if (text.trim()) await b.call('send', { sessionId: id, text: text.trim() });
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
  const [text, setText] = useState('');
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
        <select className="h-7 rounded-lg bg-black/30 border border-white/10 px-2 text-[12px] text-zinc-200 outline-none" value={mode} disabled={gone}
          onChange={(e) => act(b.call('mode', { sessionId: id, mode: e.target.value }))}>
          {MODES.map((m) => <option key={m.id} value={m.id}>{t(m.key)}</option>)}
        </select>
        {running && <button className={`${btnCls} bg-red-500/20 text-red-200 hover:bg-red-500/30`} onClick={() => act(b.call('interrupt', { sessionId: id }))}>{t('remote.interrupt')}</button>}
        {!gone && <button className={ghostCls} onClick={() => { if (confirm(t('remote.closeConfirm'))) act(closeSession(id).then(onClosed)); }}>{t('remote.closeSession')}</button>}
      </div>
      <div ref={scroller} className="flex-1 min-h-0 overflow-auto px-5 py-4 space-y-3"
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
