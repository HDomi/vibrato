import { useContext, useEffect, useMemo, useState } from 'react';
import { decodeJwt, jwtTimeStatus, signHsJwt, TIME_CLAIMS, verifyJwt, type JwtParts } from '../../lib/toolbox/jwt';
import { relativeTime } from '../../lib/toolbox/time';
import { getLang, t } from '../../lib/i18n';
import { useClock } from '../../lib/clock';
import { ViewActiveContext } from '../../lib/viewActive';
import { Area, CopyButton, Section, btn, btnPrimary, errText, mono, usePersisted } from './ui';

export default function JwtTool() {
  const [token, setToken] = usePersisted('jwt.token', '');
  const [key, setKey] = useState('');
  const [verdict, setVerdict] = useState<{ ok: boolean; msg?: string } | null>(null);
  const [header, setHeader] = useState('');
  const [payload, setPayload] = useState('');
  const [signed, setSigned] = useState('');
  const [signErr, setSignErr] = useState<string | null>(null);

  const decoded = useMemo(() => {
    if (!token.trim()) return null;
    try { return { ok: true as const, parts: decodeJwt(token) }; } catch (e) { return { ok: false as const, msg: errText(e) }; }
  }, [token]);
  const parts = decoded?.ok ? decoded.parts : null;
  useEffect(() => {
    if (parts) { setHeader(JSON.stringify(parts.header, null, 2)); setPayload(JSON.stringify(parts.payload, null, 2)); }
    setSigned(''); setSignErr(null);
  }, [parts]);
  // Re-verify whenever the token or the key changes, so the badge is never stale.
  useEffect(() => {
    if (!parts || !key.trim()) { setVerdict(null); return; }
    let alive = true;
    verifyJwt(parts, key).then((ok) => alive && setVerdict({ ok })).catch((e) => alive && setVerdict({ ok: false, msg: errText(e) }));
    return () => { alive = false; };
  }, [parts, key]);

  const alg = String(parts?.header.alg ?? '');
  const sign = async () => {
    try {
      const h = JSON.parse(header), p = JSON.parse(payload);
      setSigned(await signHsJwt(h, p, key)); setSignErr(null);
    } catch (e) { setSignErr(errText(e)); setSigned(''); }
  };

  return (
    <div className="h-full flex flex-col gap-3 min-h-0 overflow-y-auto pr-1">
      <Area label={t('tb.jwt.token')} value={token} onChange={setToken} placeholder={t('tb.jwt.placeholder')} minRows={3} autoFocus
        error={decoded && !decoded.ok ? decoded.msg : null}
        actions={token ? <button className={btn} onClick={() => setToken('')}>{t('tb.clear')}</button> : null} />
      {parts && <ColorToken parts={parts} />}
      {parts && (
        <div className="grid grid-cols-2 gap-4">
          <Area label={<span>{t('tb.jwt.header')} <span className="text-zinc-600">· {alg || '?'}</span></span>} value={header} onChange={setHeader} minRows={5} />
          <div className="flex flex-col gap-2 min-h-0">
            <Area label={t('tb.jwt.payload')} value={payload} onChange={setPayload} minRows={5} className="flex-1" />
            <Claims payload={parts.payload} />
          </div>
        </div>
      )}
      {parts && (
        <Section title={t('tb.jwt.verify')} actions={verdict && (
          <span className={`px-2 py-0.5 rounded-md text-[11px] font-medium ${verdict.ok ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>
            {verdict.msg ?? t(verdict.ok ? 'tb.jwt.sigOk' : 'tb.jwt.sigBad')}
          </span>
        )}>
          <Area label={t(alg.startsWith('HS') ? 'tb.jwt.secret' : 'tb.jwt.publicKey')} value={key} onChange={setKey} minRows={2} copy={false}
            placeholder={alg.startsWith('HS') ? t('tb.jwt.secretPlaceholder') : '-----BEGIN PUBLIC KEY----- … / {"kty":…}'} />
          <div className="text-[11px] text-zinc-500">{t('tb.jwt.verifyNote')}</div>
        </Section>
      )}
      {parts && (
        <Section title={t('tb.jwt.resign')} actions={<button className={btnPrimary} disabled={!key} onClick={sign}>{t('tb.jwt.sign')}</button>}>
          <div className="text-[11px] text-zinc-500">{t('tb.jwt.resignNote')}</div>
          {signErr && <div className="text-[11px] text-red-400">{signErr}</div>}
          {signed && (
            <div className="flex items-start gap-3">
              <div className={`flex-1 min-w-0 break-all rounded-md border border-white/10 bg-white/[.03] px-2.5 py-2 ${mono} text-zinc-200`}>{signed}</div>
              <CopyButton text={signed} />
              <button className={btn} onClick={() => setToken(signed)}>{t('tb.useAsInput')}</button>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

/** The raw token with its three parts tinted like jwt.io, so a stray character is easy to spot. */
function ColorToken({ parts }: { parts: JwtParts }) {
  const [h, p, s] = parts.raw;
  return (
    <div className={`rounded-md border border-white/10 bg-white/[.03] px-2.5 py-2 ${mono} break-all`}>
      <span className="text-red-300">{h}</span><span className="text-zinc-500">.</span>
      <span className="text-purple-300">{p}</span><span className="text-zinc-500">.</span>
      <span className="text-sky-300">{s}</span>
    </div>
  );
}

function Claims({ payload }: { payload: Record<string, unknown> }) {
  // Ticks only while the Tools view is on screen (it stays mounted behind other views).
  const now = useClock(useContext(ViewActiveContext));
  const times = Object.entries(payload).filter(([k, v]) => TIME_CLAIMS.has(k) && typeof v === 'number') as [string, number][];
  const status = jwtTimeStatus(payload, now);
  const locale = getLang() === 'ko' ? 'ko' : 'en';
  return (
    <div className="rounded-md border border-white/10 text-[12px]">
      <div className={`px-2.5 py-1.5 border-b border-white/10 text-[11px] font-medium ${status ? 'text-red-300' : typeof payload.exp === 'number' ? 'text-emerald-300' : 'text-zinc-400'}`}>
        {status ? t(status.claim === 'exp' ? 'tb.jwt.expired' : 'tb.jwt.notYet', { when: relativeTime(status.at * 1000, now, locale) })
          : typeof payload.exp === 'number' ? t('tb.jwt.validFor', { when: relativeTime(payload.exp * 1000, now, locale) }) : t('tb.jwt.noExp')}
      </div>
      {times.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2 px-2.5 py-1 border-b border-white/5 last:border-0">
          <span className="w-16 shrink-0 text-zinc-500 font-mono">{k}</span>
          <span className="font-mono text-zinc-300 tabular-nums">{v}</span>
          <span className="flex-1 min-w-0 truncate text-zinc-400">{new Date(v * 1000).toLocaleString()}</span>
          <span className="shrink-0 text-[11px] text-zinc-500">{relativeTime(v * 1000, now, locale)}</span>
        </div>
      ))}
    </div>
  );
}
