import { useEffect, useState } from 'react';
import { AES_DEFAULTS, aesDecrypt, aesEncrypt, digest, HASH_ALGS, hmac, randomBytes, type AesMode, type AesOptions, type HashAlg, type KeySource } from '../../lib/toolbox/crypto';
import { bytesToBase64, bytesToHex, fromBytes, hexToBytes, toBytes, utf8ToBytes, type ByteFormat, type Bytes } from '../../lib/toolbox/bytes';
import { t } from '../../lib/i18n';
import { Area, Field, Rows, Seg, btn, btnPrimary, errText, input, select, usePersisted } from './ui';

const FORMATS: { value: ByteFormat; label: string }[] = [{ value: 'utf8', label: 'UTF-8' }, { value: 'hex', label: 'Hex' }, { value: 'base64', label: 'Base64' }, { value: 'base64url', label: 'Base64url' }];

type Tab = 'aes' | 'hash' | 'hmac';

export default function CryptoTool() {
  const [tab, setTab] = usePersisted<Tab>('crypto.tab', 'aes');
  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      <Seg value={tab} onChange={setTab} options={[{ value: 'aes', label: t('tb.crypto.aes') }, { value: 'hash', label: t('tb.crypto.hash') }, { value: 'hmac', label: 'HMAC' }]} className="self-start" />
      <div className="flex-1 min-h-0 overflow-y-auto pr-1">
        {tab === 'aes' ? <Aes /> : tab === 'hash' ? <Hash /> : <Hmac />}
      </div>
    </div>
  );
}

type Persisted = Pick<AesOptions, 'mode' | 'keySource' | 'keyFormat' | 'saltFormat' | 'iterations' | 'keyBits' | 'ivFormat' | 'dataFormat' | 'iv'>;

function Aes() {
  const [o, setO] = usePersisted<Persisted>('crypto.aes', { mode: 'AES-GCM', keySource: 'raw', keyFormat: 'utf8', saltFormat: 'utf8', iterations: 100000, keyBits: 256, ivFormat: 'hex', dataFormat: 'base64', iv: '' });
  // Key, salt, and texts are never written to localStorage.
  const [key, setKey] = useState('');
  const [salt, setSalt] = useState('');
  const [plain, setPlain] = useState('');
  const [cipher, setCipher] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const opts = (): AesOptions => ({ ...AES_DEFAULTS, ...o, key, salt });
  const set = <K extends keyof Persisted>(k: K, v: Persisted[K]) => setO((p) => ({ ...p, [k]: v }));
  const run = async (dir: 'enc' | 'dec') => {
    setBusy(true); setErr(null);
    try {
      if (dir === 'enc') setCipher(await aesEncrypt(plain, opts())); else setPlain(await aesDecrypt(cipher, opts()));
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const ivLen = o.mode === 'AES-GCM' ? 12 : 16;
  const randomIv = () => { const b = randomBytes(ivLen); const f: ByteFormat = o.ivFormat === 'utf8' ? 'hex' : o.ivFormat; setO((p) => ({ ...p, iv: fromBytes(b, f), ivFormat: f })); };
  const randomKey = () => { setKey(bytesToHex(randomBytes(o.keyBits / 8))); set('keyFormat', 'hex'); };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Field label={t('tb.crypto.mode')}>
          <Seg value={o.mode} onChange={(v: AesMode) => set('mode', v)} options={[{ value: 'AES-GCM', label: 'GCM' }, { value: 'AES-CBC', label: 'CBC' }, { value: 'AES-CTR', label: 'CTR' }]} />
        </Field>
        <Field label={t('tb.crypto.keySource')}>
          <Seg value={o.keySource} onChange={(v: KeySource) => set('keySource', v)} options={[{ value: 'raw', label: t('tb.crypto.rawKey') }, { value: 'passphrase', label: t('tb.crypto.passphrase') }]} />
        </Field>
        {o.keySource === 'passphrase' && (
          <Field label={t('tb.crypto.keyBits')}>
            <Seg value={String(o.keyBits)} onChange={(v) => set('keyBits', Number(v) as 128 | 192 | 256)} options={[{ value: '128', label: '128' }, { value: '192', label: '192' }, { value: '256', label: '256' }]} />
          </Field>
        )}
        <Field label={t('tb.crypto.dataFormat')}>
          <Seg value={o.dataFormat} onChange={(v: ByteFormat) => set('dataFormat', v)} options={FORMATS.filter((f) => f.value !== 'utf8')} />
        </Field>
      </div>
      <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-3 gap-y-2.5 text-[11px] text-zinc-500">
        <span>{t(o.keySource === 'raw' ? 'tb.crypto.key' : 'tb.crypto.passphrase')}</span>
        <input className={input} value={key} onChange={(e) => setKey(e.target.value)} placeholder={o.keySource === 'raw' ? t('tb.crypto.keyPlaceholder') : ''} spellCheck={false} />
        {o.keySource === 'raw' ? <FormatSelect value={o.keyFormat} onChange={(v) => set('keyFormat', v)} /> : <span />}
        {o.keySource === 'raw' ? <button className={btn} onClick={randomKey}>{t('tb.random')}</button> : <span />}
        {o.keySource === 'passphrase' && <>
          <span>{t('tb.crypto.salt')}</span>
          <input className={input} value={salt} onChange={(e) => setSalt(e.target.value)} spellCheck={false} />
          <FormatSelect value={o.saltFormat} onChange={(v) => set('saltFormat', v)} />
          <span />
          <span>{t('tb.crypto.iterations')}</span>
          <input className={input} type="number" min={1} value={o.iterations} onChange={(e) => set('iterations', Math.max(1, Number(e.target.value) || 1))} />
          <span className="col-span-2 text-zinc-600">PBKDF2 · SHA-256</span>
        </>}
        <span>{t(o.mode === 'AES-GCM' ? 'tb.crypto.nonce' : o.mode === 'AES-CTR' ? 'tb.crypto.counter' : 'tb.crypto.iv')}</span>
        <input className={input} value={o.iv} onChange={(e) => set('iv', e.target.value)} placeholder={t('tb.crypto.ivPlaceholder', { n: ivLen })} spellCheck={false} />
        <FormatSelect value={o.ivFormat} onChange={(v) => set('ivFormat', v)} />
        <button className={btn} onClick={randomIv}>{t('tb.random')}</button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Area label={t('tb.crypto.plain')} value={plain} onChange={setPlain} minRows={6}
          actions={<button className={btnPrimary} disabled={busy || !plain} onClick={() => run('enc')}>{t('tb.crypto.encrypt')} →</button>} />
        <Area label={<span>{t('tb.crypto.cipher')} <span className="text-zinc-600">· {FORMATS.find((f) => f.value === o.dataFormat)?.label}</span></span>} value={cipher} onChange={setCipher} minRows={6}
          actions={<button className={btnPrimary} disabled={busy || !cipher} onClick={() => run('dec')}>← {t('tb.crypto.decrypt')}</button>} />
      </div>
      {err && <div className="text-[11px] text-red-400">{err}</div>}
      <div className="text-[11px] text-zinc-500 leading-relaxed">{t('tb.crypto.aesNote')}</div>
    </div>
  );
}

function FormatSelect({ value, onChange, utf8 = true }: { value: ByteFormat; onChange: (v: ByteFormat) => void; utf8?: boolean }) {
  return (
    <select className={select} value={value} onChange={(e) => onChange(e.target.value as ByteFormat)}>
      {FORMATS.filter((f) => utf8 || f.value !== 'utf8').map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
    </select>
  );
}

function useDigests(data: Bytes | null, algs: readonly HashAlg[], secret?: Bytes | null) {
  const [out, setOut] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!data) { setOut({}); return; }
    let alive = true;
    Promise.all(algs.map(async (a) => [a, secret ? await hmac(a as Exclude<HashAlg, 'MD5'>, secret, data) : await digest(a, data)] as const))
      .then((pairs) => alive && setOut(Object.fromEntries(pairs))).catch(() => alive && setOut({}));
    return () => { alive = false; };
  }, [data, algs, secret]);
  return out;
}

function Hash() {
  const [text, setText] = useState('');
  const [file, setFile] = useState<{ name: string; bytes: Bytes } | null>(null);
  const [fmt, setFmt] = usePersisted<'hex' | 'base64'>('crypto.hashFmt', 'hex');
  const [upper, setUpper] = usePersisted('crypto.hashUpper', false);
  const [data, setData] = useState<Bytes | null>(null);
  useEffect(() => { setData(file ? file.bytes : text ? utf8ToBytes(text) : null); }, [text, file]);
  const out = useDigests(data, HASH_ALGS);
  const show = (hex: string) => { const s = fmt === 'hex' ? hex : bytesToBase64(hexToBytes(hex)); return upper && fmt === 'hex' ? s.toUpperCase() : s; };
  const pick = (f: File | undefined) => { if (!f) return; f.arrayBuffer().then((b) => { setFile({ name: f.name, bytes: new Uint8Array(b) }); setText(''); }); };
  return (
    <div className="flex flex-col gap-3">
      <Area label={t('tb.input')} value={text} onChange={(v) => { setText(v); setFile(null); }} minRows={5} copy={false}
        actions={<>
          <Seg value={fmt} onChange={setFmt} options={[{ value: 'hex', label: 'Hex' }, { value: 'base64', label: 'Base64' }]} />
          <label className={`${btn} cursor-pointer`}>{t('tb.crypto.hashFile')}<input type="file" className="hidden" onChange={(e) => pick(e.target.files?.[0])} /></label>
          <label className="flex items-center gap-1 text-[11px] text-zinc-400 cursor-pointer"><input type="checkbox" checked={upper} onChange={(e) => setUpper(e.target.checked)} />ABC</label>
        </>} />
      {file && <div className="text-[11px] text-zinc-400">{t('tb.crypto.fileLoaded', { name: file.name, n: file.bytes.length.toLocaleString() })} <button className="text-zinc-500 hover:text-zinc-300 underline" onClick={() => setFile(null)}>{t('tb.clear')}</button></div>}
      <Rows rows={HASH_ALGS.map((a) => ({ label: a, value: out[a] ? show(out[a]) : '' }))} />
    </div>
  );
}

function Hmac() {
  const [secret, setSecret] = useState('');
  const [secretFmt, setSecretFmt] = usePersisted<ByteFormat>('crypto.hmacSecretFmt', 'utf8');
  const [text, setText] = useState('');
  const [fmt, setFmt] = usePersisted<'hex' | 'base64'>('crypto.hmacFmt', 'hex');
  const [data, setData] = useState<Bytes | null>(null);
  const [sec, setSec] = useState<Bytes | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    try { setSec(secret ? toBytes(secret, secretFmt) : null); setErr(null); } catch (e) { setSec(null); setErr(errText(e)); }
    setData(text ? utf8ToBytes(text) : null);
  }, [secret, secretFmt, text]);
  const algs = HASH_ALGS.filter((a) => a !== 'MD5');
  const out = useDigests(sec ? data : null, algs, sec);
  const show = (hex: string) => (fmt === 'hex' ? hex : bytesToBase64(hexToBytes(hex)));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-[11px] text-zinc-500">
        <span>{t('tb.crypto.secret')}</span>
        <input className={`${input} flex-1`} value={secret} onChange={(e) => setSecret(e.target.value)} spellCheck={false} />
        <FormatSelect value={secretFmt} onChange={setSecretFmt} />
        <Seg value={fmt} onChange={setFmt} options={[{ value: 'hex', label: 'Hex' }, { value: 'base64', label: 'Base64' }]} />
      </div>
      {err && <div className="text-[11px] text-red-400">{err}</div>}
      <Area label={t('tb.crypto.message')} value={text} onChange={setText} minRows={5} copy={false} />
      <Rows rows={algs.map((a) => ({ label: `HMAC-${a}`, value: out[a] ? show(out[a]) : '' }))} />
    </div>
  );
}
