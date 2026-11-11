import { useEffect, useState } from 'react';
import { t, useLang } from '../../lib/i18n';
import { hostApi, type HostStatus } from '../../lib/remote';
import { CopyButton } from '../MarkdownView';

/**
 * "Allow remote access to this Mac": turn the remote host (server/remote/host.ts) on or off, pick its port,
 * issue the access code (shown once; only its hash is kept) and see who is connected.
 */
export default function HostSettings({ onClose }: { onClose: () => void }) {
  useLang();
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [port, setPort] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');

  const load = () => hostApi.status().then((s) => { setStatus(s); setPort((p) => p || String(s.port)); }).catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
    const id = window.setInterval(() => void hostApi.status().then(setStatus).catch(() => {}), 3000);
    return () => window.clearInterval(id);
  }, []);

  const run = async (fn: () => Promise<HostStatus & { code?: string | null }>) => {
    setBusy(true); setError('');
    try {
      const r = await fn();
      setStatus(r);
      setPort(String(r.port));
      if (r.code) setCode(r.code);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const pwValid = pw.length >= 4 && pw.length <= 128 && pw === pw2;
  // The password belongs to an access code: the first time, make the code too (shown below, once).
  const savePassword = () => void run(async () => {
    if (!status?.configured) { const r = await hostApi.configure({}); if (r.code) setCode(r.code); }
    const r = await hostApi.setPassword(pw);
    setPw(''); setPw2('');
    return r;
  });

  const portNum = Number(port);
  const portValid = Number.isInteger(portNum) && portNum >= 1024 && portNum <= 65535;
  const portChanged = !!status && portValid && portNum !== status.port;

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-xl mx-auto space-y-5">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="text-base font-semibold text-zinc-100">{t('remote.host.title')}</div>
            <div className="text-[12px] text-zinc-400 whitespace-pre-line">{t('remote.host.desc')}</div>
          </div>
          <button className="h-8 px-3 rounded-lg text-xs text-zinc-300 hover:bg-fill-2 hover:text-white" onClick={onClose}>{t('remote.close')}</button>
        </div>

        {status && (
          <>
            <div className="flex items-center gap-3 rounded-xl bg-black/20 border border-white/10 p-3">
              <span className={`w-2.5 h-2.5 rounded-full ${status.listening ? 'bg-emerald-400' : status.enabled ? 'bg-red-400' : 'bg-zinc-500'}`} />
              <div className="flex-1 text-[13px] text-zinc-200">
                {status.listening ? t('remote.host.on', { port: status.port }) : status.enabled ? t('remote.host.failed', { error: status.error ?? '' }) : t('remote.host.off')}
              </div>
              <button className={`h-8 px-3 rounded-lg text-xs font-medium ${status.enabled ? 'text-zinc-200 hover:bg-fill-2' : 'bg-selected text-on-selected'} disabled:opacity-40`} disabled={busy || (!status.enabled && !status.passwordSetAt)}
                title={!status.enabled && !status.passwordSetAt ? t('remote.host.needPassword') : undefined}
                onClick={() => void run(() => hostApi.configure({ enabled: !status.enabled, ...(portValid ? { port: portNum } : {}) }))}>
                {status.enabled ? t('remote.host.turnOff') : t('remote.host.turnOn')}
              </button>
            </div>

            <div className="space-y-1">
              <div className="text-[12px] font-medium text-zinc-300">{t('remote.port')}</div>
              <div className="flex gap-2">
                <input className="w-32 h-8 rounded-lg bg-black/30 border border-white/10 px-2.5 text-[13px] text-zinc-100 outline-none focus:border-white/30" value={port} inputMode="numeric"
                  onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))} onKeyDown={(e) => { if (e.key === 'Enter' && portChanged) void run(() => hostApi.configure({ port: portNum })); }} />
                <button className="h-8 px-3 rounded-lg text-xs text-zinc-200 hover:bg-fill-2 disabled:opacity-40" disabled={busy || !portChanged} onClick={() => void run(() => hostApi.configure({ port: portNum }))}>{t('remote.host.applyPort')}</button>
              </div>
              <div className={`text-[11px] ${port && !portValid ? 'text-red-300' : 'text-zinc-500'}`}>{port && !portValid ? t('remote.host.portRange') : t('remote.host.portHint')}</div>
            </div>

            <div className="space-y-2">
              <Toggle on={status.keepAwake} disabled={busy} label={t('remote.host.keepAwake')} hint={t(status.awake ? 'remote.host.keepAwakeOn' : 'remote.host.keepAwakeHint')}
                onChange={(v) => void run(() => hostApi.configure({ keepAwake: v }))} />
              <Toggle on={status.wakeOnConnect} disabled={busy} label={t('remote.host.wakeOnConnect')} hint={t('remote.host.wakeOnConnectHint')}
                onChange={(v) => void run(() => hostApi.configure({ wakeOnConnect: v }))} />
            </div>

            <div className="space-y-1">
              <div className="text-[12px] font-medium text-zinc-300">{t('remote.password')}</div>
              {!status.passwordSetAt && (
                <div className={`text-[12px] ${status.enabled ? 'text-amber-300' : 'text-zinc-400'}`}>{t(status.enabled ? 'remote.host.noPasswordOn' : 'remote.host.needPassword')}</div>
              )}
              {status.passwordSetAt && <div className="text-[12px] text-zinc-400">{t('remote.host.passwordSince', { date: new Date(status.passwordSetAt).toLocaleString() })}</div>}
              <div className="flex gap-2">
                <input type="password" className="flex-1 h-8 rounded-lg bg-black/30 border border-white/10 px-2.5 text-[13px] text-zinc-100 outline-none focus:border-white/30" value={pw}
                  onChange={(e) => setPw(e.target.value)} placeholder={t('remote.host.passwordNew')} autoComplete="new-password" />
                <input type="password" className="flex-1 h-8 rounded-lg bg-black/30 border border-white/10 px-2.5 text-[13px] text-zinc-100 outline-none focus:border-white/30" value={pw2}
                  onChange={(e) => setPw2(e.target.value)} placeholder={t('remote.host.passwordAgain')} autoComplete="new-password"
                  onKeyDown={(e) => { if (e.key === 'Enter' && pwValid && !busy) savePassword(); }} />
                <button className="h-8 px-3 shrink-0 whitespace-nowrap rounded-lg text-xs text-zinc-200 hover:bg-fill-2 disabled:opacity-40" disabled={busy || !pwValid} onClick={savePassword}>
                  {status.passwordSetAt ? t('remote.host.passwordChange') : t('remote.host.passwordSet')}
                </button>
              </div>
              <div className={`text-[11px] ${pw && pw2 && pw !== pw2 ? 'text-red-300' : pw && pw.length < 4 ? 'text-red-300' : 'text-zinc-500'}`}>
                {pw && pw.length < 4 ? t('remote.host.passwordShort') : pw && pw2 && pw !== pw2 ? t('remote.host.passwordMismatch') : t('remote.host.passwordHint')}
              </div>
            </div>

            {code && (
              <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 space-y-2">
                <div className="text-[12px] text-amber-200">{t('remote.host.codeOnce')}</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 font-mono text-[16px] tracking-wider text-white select-all">{code}</code>
                  <CopyButton text={code} />
                </div>
              </div>
            )}

            <div className="space-y-1">
              <div className="text-[12px] font-medium text-zinc-300">{t('remote.code')}</div>
              <div className="flex items-center gap-2">
                <div className="flex-1 text-[12px] text-zinc-400">{status.codeCreatedAt ? t('remote.host.codeSince', { date: new Date(status.codeCreatedAt).toLocaleString() }) : t('remote.host.noCode')}</div>
                <button className="h-8 px-3 rounded-lg text-xs text-zinc-200 hover:bg-fill-2 disabled:opacity-40" disabled={busy}
                  onClick={() => { if (!status.configured || confirm(t('remote.host.newCodeConfirm'))) void run(() => (status.configured ? hostApi.newCode() : hostApi.configure({}))); }}>
                  {status.configured ? t('remote.host.newCode') : t('remote.host.makeCode')}
                </button>
              </div>
            </div>

            {status.fingerprint && (
              <div className="space-y-1">
                <div className="text-[12px] font-medium text-zinc-300">{t('remote.host.fingerprint')}</div>
                <div className="font-mono text-[11px] text-zinc-400 break-all">{status.fingerprint}</div>
                <div className="text-[11px] text-zinc-500">{t('remote.host.fingerprintHint')}</div>
              </div>
            )}

            <div className="space-y-1">
              <div className="text-[12px] font-medium text-zinc-300">{t('remote.host.addresses')}</div>
              <div className="text-[12px] text-zinc-400 font-mono">{status.addresses.length ? status.addresses.map((a) => `${a}:${status.port}`).join('   ') : '-'}</div>
              <div className="text-[11px] text-zinc-500 whitespace-pre-line">{t('remote.host.forwardHint', { port: status.port })}</div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center">
                <div className="flex-1 text-[12px] font-medium text-zinc-300">{t('remote.host.clients', { n: status.clients.length })}</div>
                {status.clients.length > 0 && <button className="h-7 px-2.5 rounded-lg text-[11px] text-red-300 hover:bg-red-500/10" onClick={() => void run(() => hostApi.disconnectAll())}>{t('remote.host.kick')}</button>}
              </div>
              {status.clients.map((c) => (
                <div key={`${c.address}:${c.since}`} className="text-[12px] text-zinc-400 font-mono">{c.address} · {new Date(c.since).toLocaleTimeString()}</div>
              ))}
            </div>
          </>
        )}
        {error && <div className="text-[12px] text-red-300">{error}</div>}
      </div>
    </div>
  );
}

function Toggle({ on, disabled, label, hint, onChange }: { on: boolean; disabled?: boolean; label: string; hint: string; onChange: (v: boolean) => void }) {
  return (
    <label className={`flex items-start gap-2.5 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" className="mt-0.5" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="flex-1">
        <span className="block text-[13px] text-zinc-200">{label}</span>
        <span className="block text-[11px] text-zinc-500">{hint}</span>
      </span>
    </label>
  );
}
