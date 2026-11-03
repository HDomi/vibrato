import { useEffect, useRef, useState } from 'react';
import { saveFormTypes, useFormTypes } from '../lib/formTypes';
import { t, useLang } from '../lib/i18n';
import { APPROACHES, FORM_FIELDS, type FormType } from '../lib/promptForm';

const box = 'w-full rounded-md bg-black/20 border border-line px-2.5 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:bg-white/[0.07]';
const toLines = (v: string[]) => v.join('\n');
const fromLines = (v: string) => v.split('\n').map((x) => x.trim()).filter(Boolean);

/** Settings: the type chips of "Send as form" — add, rename, reorder, and choose each one's fields and defaults. */
export default function FormTypesSettings({ focus }: { focus?: boolean }) {
  useLang();
  const { types, custom, ready } = useFormTypes();
  const [list, setList] = useState<FormType[] | null>(null);
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ready && list === null) setList(types.map((x) => ({ ...x }))); }, [ready, types, list]);
  useEffect(() => { if (focus && list) ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [focus, list === null]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list) return null;

  const cur = list[Math.min(sel, list.length - 1)];
  const dirty = JSON.stringify(list) !== JSON.stringify(types);
  const patch = (p: Partial<FormType>) => setList((l) => l && l.map((x, i) => (i === sel ? { ...x, ...p } : x)));
  const move = (d: -1 | 1) => {
    const j = sel + d;
    if (j < 0 || j >= list.length) return;
    const next = list.slice();
    [next[sel], next[j]] = [next[j], next[sel]];
    setList(next); setSel(j);
  };
  const add = (from?: FormType) => {
    const base: FormType = from ? { ...from, name: `${from.name} 2` } : { id: '', name: t('form.settings.newType'), instruction: '', fields: ['context', 'files', 'requirements', 'constraints', 'done', 'approach', 'output', 'attachments', 'notes'], constraints: [], done: [], verify: true, output: [], approach: 'direct' };
    setList([...list, { ...base, id: `t${Date.now().toString(36)}` }]);
    setSel(list.length);
  };
  const remove = () => {
    if (list.length <= 1) return;
    setList(list.filter((_, i) => i !== sel));
    setSel(Math.max(0, sel - 1));
  };
  const done = (next: FormType[] | null) => { setList(next ?? null); setError(null); setFlash(true); setTimeout(() => setFlash(false), 1500); };
  const save = () => saveFormTypes(list).then(() => done(null)).catch((e) => setError((e as Error).message));
  const restore = () => {
    if (!window.confirm(t('form.settings.confirmRestore'))) return;
    saveFormTypes(null).then(() => { setSel(0); done(null); }).catch((e) => setError((e as Error).message));
  };

  return (
    <div ref={ref} className="rounded-2xl border border-line bg-black/15 p-5 space-y-3 text-sm">
      <div>
        <div className="font-medium">{t('form.settings.title')}</div>
        <div className="text-xs text-zinc-500 leading-relaxed">{t('form.settings.note')}</div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {list.map((x, i) => (
          <button key={x.id + i} onClick={() => setSel(i)} className={`rounded-full px-3 py-1 text-xs ${i === sel ? 'bg-sky-500/25 text-sky-100' : 'bg-white/5 text-zinc-400 hover:text-zinc-200'}`}>{x.name || '—'}</button>
        ))}
        <button onClick={() => add()} className="rounded-full px-2.5 py-1 text-xs text-zinc-400 hover:text-white hover:bg-white/10">＋ {t('form.settings.add')}</button>
      </div>

      <div className="space-y-3 rounded-md bg-white/[0.02] border border-white/5 p-3">
        <div className="flex items-center gap-2">
          <input className={box} value={cur.name} maxLength={40} onChange={(e) => patch({ name: e.target.value })} placeholder={t('form.settings.name')} />
          <button disabled={sel === 0} onClick={() => move(-1)} className="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 disabled:opacity-30" title={t('form.settings.up')}>↑</button>
          <button disabled={sel === list.length - 1} onClick={() => move(1)} className="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 disabled:opacity-30" title={t('form.settings.down')}>↓</button>
          <button onClick={() => add(cur)} className="shrink-0 rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10">{t('form.settings.duplicate')}</button>
          <button disabled={list.length <= 1} onClick={remove} className="shrink-0 rounded-md px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-30">{t('form.settings.delete')}</button>
        </div>
        <Label text={t('form.settings.instruction')}>
          <textarea className={`${box} resize-y`} rows={2} value={cur.instruction} onChange={(e) => patch({ instruction: e.target.value })} placeholder={t('form.settings.instructionPlaceholder')} />
        </Label>
        <Label text={t('form.settings.fields')}>
          <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
            <label className="flex items-center gap-1.5 text-zinc-500"><input type="checkbox" checked disabled />{t('form.f.goal')}</label>
            {FORM_FIELDS.map((f) => (
              <label key={f} className="flex items-center gap-1.5 text-zinc-300 cursor-pointer">
                <input type="checkbox" checked={cur.fields.includes(f)} onChange={(e) => patch({ fields: FORM_FIELDS.filter((x) => (x === f ? e.target.checked : cur.fields.includes(x))) })} />{t(`form.f.${f}`)}
              </label>
            ))}
          </div>
        </Label>
        <div className="grid grid-cols-3 gap-3">
          <Lines label={t('form.settings.defConstraints')} value={cur.constraints} onChange={(v) => patch({ constraints: v })} />
          <Lines label={t('form.settings.defDone')} value={cur.done} onChange={(v) => patch({ done: v })} />
          <Lines label={t('form.settings.defOutput')} value={cur.output} onChange={(v) => patch({ output: v })} />
        </div>
        <div className="flex items-center gap-4 text-xs">
          <label className="flex items-center gap-1.5 text-zinc-300 cursor-pointer"><input type="checkbox" checked={cur.verify} onChange={(e) => patch({ verify: e.target.checked })} />{t('form.settings.verify')}</label>
          <label className="flex items-center gap-1.5 text-zinc-400">{t('form.f.approach')}
            <select className="bg-black/20 border border-line rounded-md px-1.5 py-0.5 outline-none text-zinc-200" value={cur.approach} onChange={(e) => patch({ approach: e.target.value as FormType['approach'] })}>
              {APPROACHES.map((a) => <option key={a} value={a}>{t(`form.approach.${a}`)}</option>)}
            </select>
          </label>
        </div>
      </div>

      {error && <div className="text-xs text-red-300">{error}</div>}
      <div className="flex items-center gap-3 text-xs">
        {custom && <button onClick={restore} className="text-zinc-500 hover:text-zinc-200">{t('form.settings.restore')}</button>}
        <div className="flex-1" />
        {flash && <span className="text-zinc-500">{t('settings.customPromptSaved')}</span>}
        {dirty && <button onClick={() => setList(types.map((x) => ({ ...x })))} className="text-zinc-500 hover:text-zinc-200">{t('form.settings.discard')}</button>}
        <button disabled={!dirty} onClick={() => void save()} className="rounded-md bg-white/10 px-2.5 py-1.5 text-zinc-200 hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-white/10">{t('settings.customPromptSave')}</button>
      </div>
    </div>
  );
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return <div><div className="mb-1 text-xs text-zinc-400">{text}</div>{children}</div>;
}

/** One entry per line; kept as typed until the line is finished so blank lines while typing do not vanish. */
function Lines({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(toLines(value));
  useEffect(() => { if (JSON.stringify(fromLines(text)) !== JSON.stringify(value)) setText(toLines(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Label text={label}>
      <textarea className={`${box} resize-y text-xs`} rows={4} value={text} placeholder={t('form.settings.onePerLine')}
        onChange={(e) => { setText(e.target.value); onChange(fromLines(e.target.value)); }} />
    </Label>
  );
}
