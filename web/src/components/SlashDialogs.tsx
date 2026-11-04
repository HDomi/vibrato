import { useEffect, useRef, useState } from 'react';
import { mcpRequest, type McpAction, type McpServerInfo } from '../lib/agent';
import { t, useLang } from '../lib/i18n';
import Icon from './Icon';

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

function Shell({ title, sub, onClose, actions, width = 'w-[720px]', children }: { title: string; sub?: string; onClose: () => void; actions?: React.ReactNode; width?: string; children: React.ReactNode }) {
  useEscape(onClose);
  return (
    <div className="fade-in fixed inset-0 z-40 bg-black/50 flex items-center justify-center" onClick={onClose}>
      <div className={`${width} max-w-[94vw] max-h-[84vh] glass-pop pop-in !rounded-[22px] flex flex-col`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 pl-6 pr-4 h-[56px] shrink-0 border-b border-white/10">
          <div className="text-[15px] font-semibold">{title}</div>
          {sub && <span className="text-xs text-zinc-500 truncate">{sub}</span>}
          <div className="flex-1" />
          {actions}
          <button className="w-8 h-8 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors" onClick={onClose} title="Esc"><Icon name="close" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

const STATUS_DOT: Record<McpServerInfo['status'], string> = {
  connected: 'bg-emerald-400', failed: 'bg-red-400', 'needs-auth': 'bg-amber-400', pending: 'bg-sky-400 animate-pulse', disabled: 'bg-zinc-600',
};
const SCOPE_ORDER = ['local', 'project', 'user', 'plugin', 'claudeai'];
const scopeRank = (s?: string) => { const i = SCOPE_ORDER.indexOf(s ?? ''); return i < 0 ? SCOPE_ORDER.length - 1 : i; };
const scopeLabel = (s?: string) => { const key = `mcp.scope.${s ?? 'other'}`; const label = t(key); return label === key ? (s ?? '') : label; };

/**
 * In-app counterpart of the CLI's /mcp dialog, acting on this session's own CLI process:
 * status, tools, reconnect, enable / disable, and sign-in (opened in the browser).
 */
export function McpManagerDialog({ sessionId, onClose, onOpenTerminal }: { sessionId: string; onClose: () => void; onOpenTerminal: () => void }) {
  useLang();
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const apply = (r: { servers: McpServerInfo[]; error?: string }) => {
    if (!alive.current) return;
    if (r.servers.length || !r.error) setServers(r.servers);
    setError(r.error ? (r.error === 'timeout' ? t('rewind.timeout') : r.error) : null);
  };
  const refresh = () => mcpRequest(sessionId, 'status').then(apply);

  useEffect(() => {
    // Servers load in the background after the CLI starts (claude.ai connectors take a few seconds):
    // keep looking for a while, and longer while any is still connecting.
    const until = Date.now() + 20000;
    let timer = 0;
    let rounds = 0;
    const tick = async () => {
      const r = await mcpRequest(sessionId, 'status');
      apply(r);
      rounds++;
      const waiting = r.servers.some((s) => s.status === 'pending') || (!r.servers.length && !r.error) || rounds < 3;
      if (alive.current && waiting && Date.now() < until) timer = window.setTimeout(tick, 1500);
    };
    void tick();
    return () => window.clearTimeout(timer);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Name of a server whose sign-in page is open; polling watches it until it connects. */
  const authWaiting = useRef<string | null>(null);
  const watchAuth = (name: string) => {
    authWaiting.current = name;
    const until = Date.now() + 3 * 60 * 1000;
    const loop = async () => {
      if (!alive.current || authWaiting.current !== name || Date.now() > until) return;
      const r = await mcpRequest(sessionId, 'status');
      apply(r);
      const s = r.servers.find((x) => x.name === name);
      if (s && s.status !== 'needs-auth' && s.status !== 'pending') { authWaiting.current = null; setNote(t('mcp.authDone', { name })); return; }
      window.setTimeout(loop, 3000);
    };
    window.setTimeout(loop, 3000);
  };

  const act = async (s: McpServerInfo, action: McpAction) => {
    setBusy(s.name); setError(null); setNote(null);
    const r = await mcpRequest(sessionId, action, s.name, action === 'authenticate' ? 60000 : 30000);
    setBusy(null);
    apply(r);
    if (action === 'authenticate' && r.authUrl) {
      window.open(r.authUrl, '_blank');
      setNote(t(s.scope === 'claudeai' ? 'mcp.authOpenedClaudeAi' : 'mcp.authOpened', { name: s.name }));
      watchAuth(s.name);
    }
  };

  const sorted = servers ? [...servers].sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope)) : [];
  const counts = { connected: 0, attention: 0, disabled: 0 };
  for (const s of sorted) { if (s.status === 'connected') counts.connected++; else if (s.status === 'disabled') counts.disabled++; else counts.attention++; }
  let lastScope: string | undefined | null = null;

  const button = (label: string, onClick: () => void, tone: 'sky' | 'plain' = 'plain') => (
    <button className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] transition-colors disabled:opacity-40 ${tone === 'sky' ? 'bg-sky-500/25 hover:bg-sky-500/35 text-sky-100' : 'bg-fill hover:bg-fill-2 text-zinc-300'}`}
      disabled={busy !== null} onClick={onClick}>{label}</button>
  );

  return (
    <Shell title={t('mcp.title')} sub={servers ? t('mcp.summary', { n: sorted.length, ok: counts.connected, bad: counts.attention, off: counts.disabled }) : undefined} onClose={onClose}
      actions={<>
        <button className="text-xs text-zinc-400 hover:text-white" onClick={() => void refresh()}>{t('context.reload')}</button>
        <button className="text-xs text-zinc-400 hover:text-white" onClick={onOpenTerminal} title={t('mcp.inTerminalHint')}>{t('mcp.inTerminal')}</button>
      </>}>
      {(error || note) && <div className={`px-6 py-2 text-[12px] border-b border-white/5 ${error ? 'text-red-300' : 'text-emerald-300'}`}>{error ?? note}</div>}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
        {!servers && <div className="p-6 text-sm text-zinc-500">{t('mcp.loading')}</div>}
        {servers && !sorted.length && <div className="p-6 text-sm text-zinc-500">{t('mcp.none')}</div>}
        {sorted.map((s) => {
          const header = s.scope !== lastScope ? <div className="px-3 pt-3 pb-1 text-[10.5px] uppercase tracking-wide text-zinc-500">{scopeLabel(s.scope)}</div> : null;
          lastScope = s.scope;
          const expanded = open === s.name;
          return (
            <div key={s.name}>
              {header}
              <div className="rounded-xl px-3 py-2 hover:bg-white/[0.03]">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className={`shrink-0 w-2 h-2 rounded-full ${STATUS_DOT[s.status]}`} />
                  <button className="min-w-0 flex items-baseline gap-2 text-left" onClick={() => setOpen(expanded ? null : s.name)} disabled={!s.tools.length && !s.target}>
                    <span className="truncate text-[13px] text-zinc-100">{s.name}</span>
                    <span className="shrink-0 text-[11px] text-zinc-500">{t(`mcp.status.${s.status}`)}{s.status === 'connected' ? ` · ${t('mcp.tools', { n: s.tools.length })}` : ''}</span>
                  </button>
                  <div className="flex-1" />
                  {busy === s.name && <span className="inline-block w-3 h-3 rounded-full border-2 border-sky-400/70 border-t-transparent animate-spin" />}
                  {s.status === 'needs-auth' && button(t('mcp.authenticate'), () => void act(s, 'authenticate'), 'sky')}
                  {(s.status === 'failed' || s.status === 'needs-auth' || s.status === 'connected') && button(t('mcp.reconnect'), () => void act(s, 'reconnect'))}
                  {s.status === 'connected' && s.scope !== 'claudeai' && (s.type === 'http' || s.type === 'sse') && button(t('mcp.signOut'), () => void act(s, 'clearAuth'))}
                  {s.status === 'disabled' ? button(t('mcp.enable'), () => void act(s, 'enable'), 'sky') : s.status !== 'pending' && button(t('mcp.disable'), () => void act(s, 'disable'))}
                </div>
                {s.error && <div className="mt-1 pl-[18px] text-[11.5px] text-red-300/90 break-words">{s.error}</div>}
                {expanded && (
                  <div className="mt-1.5 pl-[18px] space-y-1">
                    {s.target && <div className="font-mono text-[11px] text-zinc-500 break-all">{s.type ? `${s.type} · ` : ''}{s.target}</div>}
                    {s.tools.length > 0 && <div className="flex flex-wrap gap-1">{s.tools.map((tool) => <span key={tool} className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-400">{tool}</span>)}</div>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-6 py-2.5 shrink-0 border-t border-white/10 text-[11px] text-zinc-500">{t('mcp.footnote')}</div>
    </Shell>
  );
}

export interface Choice { value: string; label: string; description?: string; current?: boolean }

/** A list to pick one value from: the in-app form of the CLI's /model and /effort pickers. */
export function ChoiceDialog({ title, sub, choices, onPick, onClose }: { title: string; sub?: string; choices: Choice[]; onPick: (value: string) => void; onClose: () => void }) {
  useLang();
  const [idx, setIdx] = useState(() => Math.max(0, choices.findIndex((c) => c.current)));
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.isComposing || !choices.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => (i + 1) % choices.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => (i - 1 + choices.length) % choices.length); }
      else if (e.key === 'Enter') { e.preventDefault(); onPick(choices[idx].value); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [choices, idx, onPick]);
  return (
    <Shell title={title} sub={sub} onClose={onClose} width="w-[520px]">
      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {!choices.length && <div className="p-4 text-sm text-zinc-500">{t('mcp.loading')}</div>}
        {choices.map((c, i) => (
          <button key={c.value} onMouseEnter={() => setIdx(i)} onClick={() => onPick(c.value)}
            className={`w-full text-left rounded-xl px-3 py-2 flex items-start gap-2.5 ${i === idx ? 'bg-white/10' : ''}`}>
            <span className="shrink-0 w-4 pt-0.5 text-emerald-300">{c.current ? <Icon name="check" size={13} /> : null}</span>
            <span className="min-w-0">
              <span className="block text-[13px] text-zinc-100">{c.label}</span>
              {c.description && <span className="block text-[11.5px] text-zinc-500">{c.description}</span>}
            </span>
          </button>
        ))}
      </div>
    </Shell>
  );
}
