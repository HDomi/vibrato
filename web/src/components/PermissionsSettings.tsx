import { useCallback, useEffect, useState } from 'react';
import { api, type ClaudeRuleFile, type PermissionsSnapshot, type PermState, type TccRow } from '../lib/api';
import { t, useLang } from '../lib/i18n';
import type { AppPermissionInfo } from '../lib/vibe';
import Icon from './Icon';

/**
 * Settings > Permissions: every macOS privacy permission the app or its agents may need, its current state,
 * the TCC history of this app (including earlier bundle ids), and the agents' standing allow / deny rules.
 * Reloads when the tab is shown and when the window regains focus (back from System Settings).
 */

type Need = 'required' | 'recommended' | 'optional';
type Action = { kind: 'request'; id: string } | { kind: 'ask'; id: 'accessibility' | 'camera' | 'microphone' } | { kind: 'notify' } | { kind: 'wakeHelper' };
interface Item { id: string; need: Need; state: PermState; pane?: string; action?: Action; detail?: string; /** State text when the generic one reads wrong (a switch, not a prompt). */ label?: string }

const NEED_CLASS: Record<Need, string> = {
  required: 'bg-amber-400/15 text-amber-200',
  recommended: 'bg-sky-400/15 text-sky-200',
  optional: 'bg-white/8 text-zinc-400',
};
const STATE_CLASS: Record<PermState, string> = {
  granted: 'bg-green-400', limited: 'bg-green-400/60', denied: 'bg-red-400', restricted: 'bg-red-400/60', notDetermined: 'bg-zinc-500', unknown: 'bg-zinc-700',
};

/** Electron's media access status strings. */
function mediaState(s: string | undefined): PermState | null {
  if (s === 'granted') return 'granted';
  if (s === 'denied') return 'denied';
  if (s === 'restricted') return 'restricted';
  if (s === 'not-determined') return 'notDetermined';
  return null;
}

function StateBadge({ state, stale, label }: { state: PermState; stale?: boolean; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-300 whitespace-nowrap">
      <span className={`w-2 h-2 rounded-full ${stale ? 'bg-amber-400' : STATE_CLASS[state]}`} />
      {stale ? t('perm.state.stale') : label ?? t(`perm.state.${state}`)}
    </span>
  );
}

const btn = 'shrink-0 rounded-full bg-fill-2 hover:bg-fill-3 px-3 py-1 text-xs text-zinc-200 disabled:opacity-40 transition-colors';
const fmtDate = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : '—');
const svcLabel = (svc: string) => { const k = `perm.svc.${svc}`; const v = t(k); return v === k ? svc : v; };

export default function PermissionsSettings({ active }: { active: boolean }) {
  useLang();
  const [snap, setSnap] = useState<PermissionsSnapshot | null>(null);
  const [info, setInfo] = useState<AppPermissionInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const i = (await window.vibe?.permissions?.info().catch(() => null)) ?? null;
      setInfo(i);
      setSnap(await api.permissions(i?.bundlePath));
      setError(null);
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { if (active) void load(); }, [active, load]);
  useEffect(() => {
    if (!active) return;
    const h = () => void load();
    window.addEventListener('focus', h);
    return () => window.removeEventListener('focus', h);
  }, [active, load]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); void load(); }
  };
  const openPane = (pane: string) => void run(`pane:${pane}`, () => api.openPermissionPane(pane));

  const ownId = snap?.bundleIds[0] ?? 'com.hdomi.vibrato';
  const own = (snap?.tcc ?? []).filter((r) => r.client === ownId);
  const fromTcc = (svc: string): PermState | null => {
    if (!snap?.tcc) return null;
    const row = own.find((r) => r.service === svc && !r.stale);
    return row ? row.state : 'notDetermined';
  };
  const stale = (snap?.tcc ?? []).filter((r) => r.stale);
  const automation = own.filter((r) => r.service === 'AppleEvents' && !r.stale);

  const items: Item[] = snap ? [
    { id: 'fullDisk', need: 'recommended', state: snap.fullDisk ? 'granted' : 'denied', pane: 'fullDisk' },
    ...(['desktop', 'documents', 'downloads'] as const).map((id): Item => ({ id, need: 'required', state: snap.folders[id], pane: 'files', action: { kind: 'request', id } })),
    { id: 'removable', need: 'optional', state: fromTcc('SystemPolicyRemovableVolumes') ?? 'unknown', pane: 'files' },
    { id: 'network', need: 'optional', state: fromTcc('SystemPolicyNetworkVolumes') ?? 'unknown', pane: 'files' },
    { id: 'notifications', need: 'recommended', state: 'unknown', pane: 'notifications', action: window.vibe?.isElectron ? { kind: 'notify' } : undefined },
    { id: 'appManagement', need: 'recommended', state: fromTcc('SystemPolicyAppBundles') ?? 'unknown', pane: 'appManagement' },
    { id: 'photos', need: 'optional', state: snap.photos !== 'unknown' ? snap.photos : fromTcc('Photos') ?? 'unknown', pane: 'photos', action: { kind: 'request', id: 'photos' } },
    { id: 'screen', need: 'optional', state: mediaState(info?.screen) ?? fromTcc('ScreenCapture') ?? 'unknown', pane: 'screen' },
    { id: 'accessibility', need: 'optional', state: info ? (info.accessibility ? 'granted' : fromTcc('Accessibility') ?? 'notDetermined') : fromTcc('Accessibility') ?? 'unknown', pane: 'accessibility', action: info ? { kind: 'ask', id: 'accessibility' } : undefined },
    {
      id: 'automation', need: 'optional', pane: 'automation',
      state: automation.some((r) => r.state === 'granted') ? 'granted' : automation.length ? 'denied' : snap.tcc ? 'notDetermined' : 'unknown',
      detail: automation.length ? automation.map((r) => `${r.target ?? '?'} ${r.state === 'granted' ? '✓' : '✗'}`).join(' · ') : undefined,
    },
    { id: 'developerTools', need: 'optional', state: fromTcc('DeveloperTool') ?? 'unknown', pane: 'developerTools' },
    { id: 'inputMonitoring', need: 'optional', state: fromTcc('ListenEvent') ?? 'unknown', pane: 'inputMonitoring' },
    { id: 'camera', need: 'optional', state: mediaState(info?.camera) ?? fromTcc('Camera') ?? 'unknown', pane: 'camera', action: info ? { kind: 'ask', id: 'camera' } : undefined },
    { id: 'microphone', need: 'optional', state: mediaState(info?.microphone) ?? fromTcc('Microphone') ?? 'unknown', pane: 'microphone', action: info ? { kind: 'ask', id: 'microphone' } : undefined },
    { id: 'loginItem', need: 'optional', state: info ? (info.loginItem ? 'granted' : 'notDetermined') : 'unknown', label: info ? t(info.loginItem ? 'perm.state.on' : 'perm.state.off') : undefined, pane: 'loginItems' },
    { id: 'wakeHelper', need: 'optional', state: snap.wakeHelper ? 'granted' : 'notDetermined', label: t(snap.wakeHelper ? 'perm.state.installed' : 'perm.state.notInstalled'), action: snap.wakeHelper ? undefined : { kind: 'wakeHelper' } },
  ] : [];

  const doAction = (a: Action) => {
    if (a.kind === 'request') void run(a.id, () => api.requestPermission(a.id));
    else if (a.kind === 'ask') void run(a.id, () => window.vibe!.permissions!.ask(a.id));
    else if (a.kind === 'notify') { window.vibe?.notify({ title: 'Vibrato', body: t('perm.testNotificationBody'), sessionId: '' }); }
    else void run('wakeHelper', async () => { const r = await api.scheduleWakeHelper(true, t('sched.helperPrompt')); if (r.result === 'cancelled') throw new Error(t('sched.helperCancelled')); });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-line bg-black/15 p-5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="font-medium flex-1">{t('perm.title')}</div>
          <button className="w-7 h-7 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-fill-2 transition-colors disabled:opacity-40"
            disabled={loading} onClick={() => void load()} title={t('perm.refresh')}><Icon name="reload" /></button>
        </div>
        <div className="text-xs text-zinc-500 leading-relaxed">{t('perm.note')}</div>
        {snap && (
          <div className="text-xs text-zinc-500">
            {t('perm.identity')}: <span className="font-mono text-zinc-300">{ownId}</span>
            {info?.bundlePath && <> · <span className="font-mono">{info.bundlePath}</span></>}
          </div>
        )}
        {snap && !snap.fullDisk && (
          <div className="flex items-start gap-3 rounded-xl bg-amber-400/10 border border-amber-400/20 px-3 py-2.5 text-xs text-amber-100">
            <span className="flex-1 leading-relaxed">{t('perm.noFullDisk')}</span>
            <button className={btn} onClick={() => openPane('fullDisk')}>{t('perm.openSettings')}</button>
          </div>
        )}
        {stale.length > 0 && (
          <div className="rounded-xl bg-amber-400/10 border border-amber-400/20 px-3 py-2.5 text-xs text-amber-100 leading-relaxed">
            {t('perm.staleNote', { n: stale.length })}
          </div>
        )}
        {error && <div className="text-xs text-red-300 break-words">{error}</div>}
        {!snap && !error && <div className="text-sm text-zinc-500">{t('settings.detecting')}</div>}
      </div>

      {snap && (
        <div className="rounded-2xl border border-line bg-black/15 p-2">
          <div className="px-3 pt-3 pb-2 font-medium">{t('perm.section.mac')}</div>
          {items.map((it) => (
            <div key={it.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-white/[0.03]">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  <span>{t(`perm.item.${it.id}`)}</span>
                  <span className={`rounded-full px-2 py-px text-[10px] ${NEED_CLASS[it.need]}`}>{t(`perm.need.${it.need}`)}</span>
                </div>
                <div className="text-xs text-zinc-500 leading-relaxed mt-0.5">{t(`perm.desc.${it.id}`)}</div>
                {it.detail && <div className="text-xs text-zinc-400 mt-0.5 font-mono break-all">{it.detail}</div>}
              </div>
              <div className="w-28 shrink-0"><StateBadge state={it.state} label={it.label} /></div>
              <div className="w-[190px] shrink-0 flex justify-end gap-1.5">
                {it.action && it.state !== 'granted' && (
                  <button className={btn} disabled={busy !== null} onClick={() => doAction(it.action!)}>
                    {busy === it.id || (it.action.kind === 'wakeHelper' && busy === 'wakeHelper') ? t('perm.waiting') : t(it.action.kind === 'notify' ? 'perm.test' : it.action.kind === 'wakeHelper' ? 'perm.install' : 'perm.request')}
                  </button>
                )}
                {it.pane && <button className={btn} disabled={busy !== null} onClick={() => openPane(it.pane!)} title={t('perm.openSettings')}>{t('perm.open')}</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {snap && <TccHistory rows={snap.tcc} ownId={ownId} />}
      {snap && <AgentRules snap={snap} busy={busy} run={run} />}
    </div>
  );
}

function clientLabel(client: string, ownId: string): string {
  if (client === ownId) return t('perm.client.current');
  if (client === 'com.github.Electron') return t('perm.client.dev');
  if (client.startsWith('com.hdomi.')) return t('perm.client.previous');
  return t('perm.client.other');
}

function TccHistory({ rows, ownId }: { rows: TccRow[] | null; ownId: string }) {
  return (
    <div className="rounded-2xl border border-line bg-black/15 p-5 space-y-2">
      <div className="font-medium">{t('perm.section.history')}</div>
      <div className="text-xs text-zinc-500 leading-relaxed">{t('perm.historyNote')}</div>
      {rows === null && <div className="text-xs text-zinc-500">{t('perm.historyLocked')}</div>}
      {rows?.length === 0 && <div className="text-xs text-zinc-500">{t('perm.historyEmpty')}</div>}
      {!!rows?.length && (
        <table className="w-full text-xs">
          <thead className="text-zinc-500 text-left">
            <tr><th className="font-normal py-1.5">{t('perm.col.permission')}</th><th className="font-normal">{t('perm.col.app')}</th><th className="font-normal">{t('perm.col.state')}</th><th className="font-normal text-right">{t('perm.col.changed')}</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-white/5">
                <td className="py-1.5 pr-3">
                  <div className="text-zinc-200">{svcLabel(r.service)}</div>
                  {r.target && <div className="text-zinc-500 font-mono break-all">→ {r.target}</div>}
                </td>
                <td className="pr-3">
                  <div className="text-zinc-300">{clientLabel(r.client, ownId)}</div>
                  <div className="text-zinc-600 font-mono break-all">{r.client}</div>
                </td>
                <td className="pr-3"><StateBadge state={r.state} stale={r.stale} /></td>
                <td className="text-right text-zinc-500 whitespace-nowrap">{fmtDate(r.modified)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

type ClaudeList = 'allow' | 'ask' | 'deny' | 'additionalDirectories';
const LIST_CLASS: Record<ClaudeList, string> = { allow: 'text-green-300', ask: 'text-sky-300', deny: 'text-red-300', additionalDirectories: 'text-zinc-300' };

function RuleChip({ text, onRemove, disabled }: { text: string; onRemove: () => void; disabled: boolean }) {
  return (
    <span className="group inline-flex items-center gap-1 max-w-full rounded-lg bg-white/5 border border-white/5 pl-2 pr-1 py-0.5 font-mono text-[11px] text-zinc-300">
      <span className="truncate" title={text}>{text}</span>
      <button disabled={disabled} onClick={onRemove} title={t('perm.removeRule')}
        className="shrink-0 w-4 h-4 flex items-center justify-center rounded text-zinc-500 hover:text-white hover:bg-white/10 disabled:opacity-40">×</button>
    </span>
  );
}

function ClaudeFile({ f, busy, run }: { f: ClaudeRuleFile; busy: string | null; run: (key: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const lists: ClaudeList[] = ['allow', 'ask', 'deny', 'additionalDirectories'];
  const total = f.allow.length + f.ask.length + f.deny.length + f.additionalDirectories.length;
  const remove = (list: ClaudeList, rule: string) => {
    if (!window.confirm(t('perm.confirmRemove', { rule }))) return;
    void run(`claude:${f.file}:${rule}`, () => api.removeClaudeRule(f.file, list, rule));
  };
  return (
    <details className="rounded-xl border border-white/5 bg-black/10 px-3 py-2">
      <summary className="cursor-pointer text-xs flex items-center gap-2">
        <span className={`rounded-full px-2 py-px text-[10px] ${f.scope === 'user' ? 'bg-sky-400/15 text-sky-200' : 'bg-white/8 text-zinc-300'}`}>{t(`perm.scope.${f.scope}`)}</span>
        <span className="font-mono text-zinc-300 truncate flex-1" title={f.file}>{f.project ?? f.file}{f.project && <span className="text-zinc-500"> · {f.file.split('/').pop()}</span>}</span>
        <span className="text-zinc-500 whitespace-nowrap">{t('perm.ruleCount', { n: total })}{f.defaultMode ? ` · ${f.defaultMode}` : ''}</span>
      </summary>
      <div className="mt-2 space-y-2">
        <div className="text-[11px] text-zinc-600 font-mono break-all">{f.file}</div>
        {lists.filter((l) => f[l].length).map((l) => (
          <div key={l}>
            <div className={`text-[11px] mb-1 ${LIST_CLASS[l]}`}>{t(`perm.list.${l}`)} · {f[l].length}</div>
            <div className="flex flex-wrap gap-1">
              {f[l].map((rule) => <RuleChip key={rule} text={rule} disabled={busy !== null} onRemove={() => remove(l, rule)} />)}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function AgentRules({ snap, busy, run }: { snap: PermissionsSnapshot; busy: string | null; run: (key: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const codex = snap.codex;
  return (
    <div className="rounded-2xl border border-line bg-black/15 p-5 space-y-4">
      <div className="font-medium">{t('perm.section.agents')}</div>
      <div className="text-xs text-zinc-500 leading-relaxed">{t('perm.agentsNote')}</div>
      <div className="space-y-2">
        <div className="text-sm">Claude</div>
        {snap.claude.length === 0 && <div className="text-xs text-zinc-500">{t('perm.noRules')}</div>}
        {snap.claude.map((f) => <ClaudeFile key={f.file} f={f} busy={busy} run={run} />)}
      </div>
      <div className="space-y-2">
        <div className="text-sm">Codex</div>
        {!codex && <div className="text-xs text-zinc-500">{t('perm.noRules')}</div>}
        {codex && (
          <>
            <div className="text-xs text-zinc-400">
              approval_policy <span className="font-mono text-zinc-200">{codex.approvalPolicy ?? t('perm.default')}</span>
              {' · '}sandbox_mode <span className="font-mono text-zinc-200">{codex.sandboxMode ?? t('perm.default')}</span>
              <span className="text-zinc-600 font-mono"> · {codex.file}</span>
            </div>
            {codex.trusted.length > 0 && (
              <details className="rounded-xl border border-white/5 bg-black/10 px-3 py-2">
                <summary className="cursor-pointer text-xs text-zinc-300">{t('perm.codexTrusted')} · {codex.trusted.length}</summary>
                <div className="mt-2 space-y-0.5">
                  {codex.trusted.map((p) => (
                    <div key={p.path} className="flex gap-2 text-[11px] font-mono"><span className="text-zinc-300 break-all flex-1">{p.path}</span><span className={p.level === 'trusted' ? 'text-green-300' : 'text-zinc-500'}>{p.level}</span></div>
                  ))}
                </div>
              </details>
            )}
            {codex.rules.length > 0 && (
              <details className="rounded-xl border border-white/5 bg-black/10 px-3 py-2">
                <summary className="cursor-pointer text-xs text-zinc-300">{t('perm.codexRules')} · {codex.rules.length}</summary>
                <div className="mt-2 flex flex-wrap gap-1">
                  {codex.rules.map((r) => (
                    <RuleChip key={`${r.file}:${r.line}`} text={`${r.decision === 'allow' ? '' : `[${r.decision}] `}${r.pattern.join(' ')}`} disabled={busy !== null}
                      onRemove={() => { if (window.confirm(t('perm.confirmRemove', { rule: r.pattern.join(' ') }))) void run(`codex:${r.line}`, () => api.removeCodexRule(r.file, r.text)); }} />
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
