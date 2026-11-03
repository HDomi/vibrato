import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type AgentContext } from '../lib/api';
import type { Attachment } from '../lib/agent';
import { mergeAttachments, resolveFiles } from '../lib/attachFiles';
import { formLabels, useFormTypes } from '../lib/formTypes';
import { t, useLang } from '../lib/i18n';
import { APPROACHES, assemblePrompt, chipPresets, emptyForm, readFormState, switchType, withSkill, type FormField, type FormState } from '../lib/promptForm';
import FileIcon from './FileIcon';
import Icon from './Icon';

const box = 'w-full bg-white/5 rounded-md px-2.5 py-1.5 outline-none border border-white/5 focus:border-white/20 placeholder:text-zinc-600';
const storeKey = (k: string) => `vibe.form.${k}`;

/**
 * "Send as form": fill in fields shaped by a form type, watch the prompt they assemble into, then send it
 * (queued if the agent is busy) or drop it into the composer to edit. Separate from the composer's own text;
 * the form keeps its draft per session until it is sent. In a Claude session a skill can be picked; the message
 * then starts with "/skill".
 */
export default function PromptFormDialog({ cwd, agent, draftKey, running, onSend, onInsert, onClose, onEditTypes }: {
  cwd: string | null;
  agent?: 'claude' | 'codex';
  draftKey?: string;
  running: boolean;
  onSend: (text: string, attachments: Attachment[]) => void;
  onInsert: (text: string) => void;
  onClose: () => void;
  onEditTypes: () => void;
}) {
  useLang();
  const { types, ready } = useFormTypes();
  const key = draftKey ? storeKey(draftKey) : null;
  const saved = useMemo(() => { try { return key ? JSON.parse(localStorage.getItem(key) ?? 'null') as { state?: unknown; attachments?: Attachment[] } | null : null; } catch { return null; } }, [key]);
  const [state, setState] = useState<FormState | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>(() => (Array.isArray(saved?.attachments) ? saved.attachments : []));
  const [override, setOverride] = useState<string | null>(null);
  const [verifyCmd, setVerifyCmd] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [skills, setSkills] = useState<AgentContext['skills'] | null>(null);
  const skillsOn = agent === 'claude';

  // The saved draft once the types are known; a type that was deleted falls back to the first one.
  useEffect(() => {
    if (!ready || state || !types.length) return;
    const fresh = emptyForm(types[0]);
    const s = readFormState(saved?.state, fresh);
    setState(types.some((x) => x.id === s.typeId) ? s : switchType(s, types[0]));
  }, [ready, types, state, saved]);
  useEffect(() => {
    if (!key || !state) return;
    try { localStorage.setItem(key, JSON.stringify({ state, attachments })); } catch { /* ignore */ }
  }, [key, state, attachments]);
  useEffect(() => { if (cwd) api.projectVerify(cwd).then((v) => setVerifyCmd(v.command?.trim() || null)).catch(() => {}); }, [cwd]);
  useEffect(() => {
    if (!skillsOn) return;
    let live = true;
    api.agentContext(cwd ?? '~').then((c) => { if (live) setSkills(c.skills.filter((s) => s.agent === 'claude')); }).catch(() => { if (live) setSkills([]); });
    return () => { live = false; };
  }, [cwd, skillsOn]);

  const type = (state && types.find((x) => x.id === state.typeId)) ?? types[0];
  const skill = skillsOn ? state?.skill ?? '' : '';
  const prompt = useMemo(() => (state && type ? withSkill(skill, assemblePrompt(state, type, formLabels(), verifyCmd)) : ''), [state, type, verifyCmd, skill]);
  const text = override ?? prompt;
  const canSend = !!text.trim() && (override !== null || !!state?.goal.trim() || !!skill);

  const finish = (send: boolean) => {
    if (!canSend) return;
    if (send) onSend(text.trim(), attachments); else onInsert(text.trim());
    if (key) try { localStorage.removeItem(key); } catch { /* ignore */ }
    onClose();
  };
  const reset = () => { if (type) { setState(emptyForm(type)); setAttachments([]); setOverride(null); } };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  if (!state || !type) return null;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setState((s) => (s ? { ...s, [k]: v } : s));
  const has = (f: FormField) => type.fields.includes(f);
  const presets = chipPresets(t);
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const r = await resolveFiles(files);
    setUploadError(r.error);
    setAttachments((a) => mergeAttachments(a, r.attachments));
  };

  return (
    <div className="fade-in fixed inset-0 z-40 bg-black/50 flex items-center justify-center" onMouseDown={onClose}>
      <div className="w-[1120px] max-w-[95vw] h-[86vh] glass-pop pop-in !rounded-[22px] flex flex-col text-[12.5px]" onMouseDown={(e) => e.stopPropagation()}
        onPaste={(e) => { const f = Array.from(e.clipboardData.files); if (f.length && has('attachments')) { e.preventDefault(); void addFiles(f); } }}>
        <div className="flex items-center gap-3 pl-5 pr-3 h-[56px] shrink-0 border-b border-white/10">
          <div className="text-[14px] font-semibold shrink-0">{t('form.title')}</div>
          <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto">
            {types.map((x) => (
              <button key={x.id} onClick={() => setState((s) => (s ? switchType(s, x) : s))}
                className={`shrink-0 rounded-full px-3 py-1 ${x.id === type.id ? 'bg-sky-500/25 text-sky-100' : 'bg-white/5 text-zinc-400 hover:text-zinc-200'}`}>{x.name}</button>
            ))}
          </div>
          <button className="shrink-0 text-[11.5px] text-zinc-500 hover:text-zinc-200" onClick={onEditTypes}>{t('form.editTypes')}</button>
          <button className="w-8 h-8 flex items-center justify-center rounded-md text-zinc-400 hover:text-white hover:bg-white/10" onClick={onClose} title="Esc"><Icon name="close" /></button>
        </div>

        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 overflow-y-auto px-5 py-4 space-y-4">
            {type.instruction && <div className="rounded-md bg-white/[0.03] border border-white/5 px-3 py-2 text-[11.5px] text-zinc-400 whitespace-pre-wrap">{type.instruction}</div>}
            {skillsOn && <Field label={t('form.f.skill')}><SkillInput skills={skills} value={state.skill} onChange={(v) => set('skill', v)} /></Field>}
            <Field label={t('form.f.goal')} required={!skill}>
              <input autoFocus className={box} value={state.goal} onChange={(e) => set('goal', e.target.value)} placeholder={t('form.p.goal')} />
            </Field>
            {has('context') && <Field label={t('form.f.context')}><Area value={state.context} onChange={(v) => set('context', v)} placeholder={t('form.p.context')} /></Field>}
            {has('files') && <Field label={t('form.f.files')}><FilesInput cwd={cwd} files={state.files} onChange={(v) => set('files', v)} /></Field>}
            {has('repro') && <Field label={t('form.f.repro')}><Area value={state.repro} onChange={(v) => set('repro', v)} placeholder={t('form.p.repro')} /></Field>}
            {(has('actual') || has('expected')) && (
              <div className="grid grid-cols-2 gap-3">
                {has('actual') && <Field label={t('form.f.actual')}><Area value={state.actual} onChange={(v) => set('actual', v)} /></Field>}
                {has('expected') && <Field label={t('form.f.expected')}><Area value={state.expected} onChange={(v) => set('expected', v)} /></Field>}
              </div>
            )}
            {has('logs') && <Field label={t('form.f.logs')}><Area mono rows={4} value={state.logs} onChange={(v) => set('logs', v)} placeholder={t('form.p.logs')} /></Field>}
            {has('requirements') && <Field label={t('form.f.requirements')}><ListInput items={state.requirements} onChange={(v) => set('requirements', v)} placeholder={t('form.p.requirement')} /></Field>}
            {has('constraints') && <Field label={t('form.f.constraints')}><Chips options={[...presets.constraints, ...type.constraints]} value={state.constraints} onChange={(v) => set('constraints', v)} /></Field>}
            {has('done') && (
              <Field label={t('form.f.done')}>
                <Chips options={[...presets.done, ...type.done]} value={state.done} onChange={(v) => set('done', v)}
                  lead={verifyCmd ? <Chip on={state.verify} onClick={() => set('verify', !state.verify)}>{t('form.out.verify').replace('{cmd}', verifyCmd)}</Chip> : null} />
              </Field>
            )}
            {has('approach') && (
              <Field label={t('form.f.approach')}>
                <div className="inline-flex rounded-md bg-white/5 p-0.5">
                  {APPROACHES.map((a) => <button key={a} onClick={() => set('approach', a)} className={`px-3 py-1 rounded ${state.approach === a ? 'bg-white/15 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>{t(`form.approach.${a}`)}</button>)}
                </div>
              </Field>
            )}
            {has('output') && <Field label={t('form.f.output')}><Chips options={[...presets.output, ...type.output]} value={state.output} onChange={(v) => set('output', v)} /></Field>}
            {has('attachments') && (
              <Field label={t('form.f.attachments')}>
                <div className="rounded-md border border-dashed border-white/10 px-3 py-2" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void addFiles(Array.from(e.dataTransfer.files)); }}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {attachments.map((a) => (
                      <span key={a.path} className="flex items-center gap-1 rounded-md bg-white/5 pl-1.5 pr-1 py-0.5" title={a.path}>
                        <FileIcon name={a.name} isDir={false} /><span className="max-w-48 truncate">{a.name}</span>
                        <button className="text-zinc-500 hover:text-white" onClick={() => setAttachments((x) => x.filter((y) => y.path !== a.path))}><Icon name="close" size={10} /></button>
                      </span>
                    ))}
                    <label className="cursor-pointer text-zinc-400 hover:text-white">📎 {t('form.addFiles')}<input type="file" multiple className="hidden" onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} /></label>
                  </div>
                  {uploadError && <div className="mt-1 text-red-300">{uploadError}</div>}
                </div>
              </Field>
            )}
            {has('notes') && <Field label={t('form.f.notes')}><Area value={state.notes} onChange={(v) => set('notes', v)} /></Field>}
          </div>

          <div className="w-[40%] shrink-0 border-l border-white/10 flex flex-col min-h-0">
            <div className="h-10 shrink-0 flex items-center gap-2 px-4 border-b border-white/10">
              <span className="text-[11.5px] font-medium text-zinc-400">{t('form.preview')}</span>
              {override !== null && <span className="text-[11px] text-amber-300/80">{t('form.overridden')}</span>}
              <div className="flex-1" />
              {override === null
                ? <button className="text-[11.5px] text-zinc-500 hover:text-zinc-200" disabled={!prompt} onClick={() => setOverride(prompt)}>{t('form.editText')}</button>
                : <button className="text-[11.5px] text-zinc-500 hover:text-zinc-200" onClick={() => setOverride(null)}>{t('form.backToForm')}</button>}
            </div>
            {override === null
              ? <pre className="flex-1 min-h-0 overflow-auto px-4 py-3 font-mono text-[12px] text-zinc-300 whitespace-pre-wrap break-words">{prompt || <span className="text-zinc-600">{t('form.previewEmpty')}</span>}</pre>
              : <textarea className="flex-1 min-h-0 resize-none bg-transparent px-4 py-3 font-mono text-[12px] text-zinc-100 outline-none" value={override} onChange={(e) => setOverride(e.target.value)} />}
            {attachments.length > 0 && <div className="shrink-0 px-4 py-1.5 border-t border-white/10 text-[11px] text-zinc-500">{t('form.withAttachments', { n: attachments.length })}</div>}
          </div>
        </div>

        <div className="h-[56px] shrink-0 flex items-center gap-2 px-5 border-t border-white/10">
          <button className="text-zinc-500 hover:text-zinc-200" onClick={reset}>{t('form.reset')}</button>
          <div className="flex-1" />
          <button className="rounded-md px-3 py-1.5 text-zinc-300 hover:bg-white/10" onClick={onClose}>{t('form.cancel')}</button>
          <button disabled={!canSend} className="rounded-md bg-white/10 hover:bg-white/15 px-3 py-1.5 text-zinc-100 disabled:opacity-40" onClick={() => finish(false)}>{t('form.toComposer')}</button>
          <button disabled={!canSend} className="rounded-md bg-blue-500/40 hover:bg-blue-500/50 px-3.5 py-1.5 text-white disabled:opacity-40" onClick={() => finish(true)} title="⌘↵">{running ? t('form.queue') : t('form.send')}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11.5px] font-medium text-zinc-400">{label}{required && <span className="ml-0.5 text-sky-300">*</span>}</div>
      {children}
    </div>
  );
}

function Area({ value, onChange, placeholder, rows = 2, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; mono?: boolean }) {
  return <textarea className={`${box} resize-y ${mono ? 'font-mono text-[12px]' : ''}`} rows={Math.max(rows, Math.min(12, value.split('\n').length))} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={!mono} />;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={`rounded-full px-2.5 py-0.5 border ${on ? 'border-sky-400/50 bg-sky-500/15 text-sky-100' : 'border-white/10 text-zinc-400 hover:text-zinc-200'}`}>{on ? '✓ ' : ''}{children}</button>;
}

/** Toggle chips: the presets, the type's defaults, and anything typed in. */
function Chips({ options, value, onChange, lead }: { options: string[]; value: string[]; onChange: (v: string[]) => void; lead?: React.ReactNode }) {
  const [custom, setCustom] = useState('');
  const all = [...new Set([...options, ...value])];
  const toggle = (x: string) => onChange(value.includes(x) ? value.filter((y) => y !== x) : [...value, x]);
  const add = () => { const v = custom.trim(); if (v && !value.includes(v)) onChange([...value, v]); setCustom(''); };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {lead}
      {all.map((x) => <Chip key={x} on={value.includes(x)} onClick={() => toggle(x)}>{x}</Chip>)}
      <input className="w-40 bg-transparent border-b border-white/10 focus:border-white/30 px-1 py-0.5 outline-none placeholder:text-zinc-600" placeholder={t('form.addChip')} value={custom}
        onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }} onBlur={add} />
    </div>
  );
}

/** Editable bullet list; Enter in the last line adds the next one. */
function ListInput({ items, onChange, placeholder }: { items: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const add = () => { const v = draft.trim(); if (v) onChange([...items, v]); setDraft(''); };
  return (
    <div className="space-y-1">
      {items.map((x, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="text-zinc-600">•</span>
          <input ref={(el) => { refs.current[i] = el; }} className={box} value={x} onChange={(e) => onChange(items.map((y, j) => (j === i ? e.target.value : y)))}
            onBlur={() => { if (!items[i].trim()) onChange(items.filter((_, j) => j !== i)); }} />
          <button className="text-zinc-500 hover:text-white" onClick={() => onChange(items.filter((_, j) => j !== i))}><Icon name="close" size={11} /></button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <span className="text-zinc-600">+</span>
        <input className={box} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }} onBlur={add} />
      </div>
    </div>
  );
}

/** One Claude skill (project, global or plugin), picked from a search over name and description. */
function SkillInput({ skills, value, onChange }: { skills: AgentContext['skills'] | null; value: string; onChange: (v: string) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^\//, '');
    return (skills ?? []).filter((s) => !needle || `${s.name} ${s.description}`.toLowerCase().includes(needle));
  }, [skills, q]);
  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => { listRef.current?.children[idx]?.scrollIntoView({ block: 'nearest' }); }, [idx]);
  const pick = (name: string) => { onChange(name); setQ(''); setOpen(false); };

  if (value) {
    const s = skills?.find((x) => x.name === value);
    return (
      <div className="flex items-start gap-2 rounded-md bg-violet-500/10 border border-violet-400/20 px-2.5 py-1.5">
        <span className="font-mono text-violet-200 shrink-0">/{value}</span>
        {s && <span className="shrink-0 mt-0.5 rounded bg-white/5 px-1.5 text-[10px] text-zinc-400">{t(`context.scope.${s.scope}`)}</span>}
        <span className="flex-1 min-w-0 truncate text-zinc-500" title={s?.description}>{s ? s.description : skills ? t('form.skillMissing') : ''}</span>
        <button className="shrink-0 text-zinc-500 hover:text-white" onClick={() => onChange('')} title={t('form.skillClear')}><Icon name="close" size={11} /></button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input className={box} value={q} placeholder={skills && !skills.length ? t('form.skillNone') : t('form.p.skill')} disabled={!!skills && !skills.length}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'ArrowDown' && hits.length) { e.preventDefault(); setOpen(true); setIdx((i) => (i + 1) % hits.length); }
          if (e.key === 'ArrowUp' && hits.length) { e.preventDefault(); setIdx((i) => (i - 1 + hits.length) % hits.length); }
          if (e.key === 'Enter' && open && hits[idx]) { e.preventDefault(); pick(hits[idx].name); }
          if (e.key === 'Escape' && open && q) { e.preventDefault(); setQ(''); setOpen(false); }
        }} />
      {open && hits.length > 0 && (
        <div ref={listRef} className="absolute left-0 right-0 top-full mt-1 z-10 max-h-72 overflow-y-auto glass-pop pop-in rounded-xl py-1">
          {hits.map((s, i) => (
            <div key={`${s.scope}:${s.name}`} onMouseEnter={() => setIdx(i)} onMouseDown={(e) => { e.preventDefault(); pick(s.name); }}
              className={`px-3 py-1.5 cursor-pointer ${i === idx ? 'bg-blue-500/20' : ''}`}>
              <div className="flex items-center gap-2">
                <span className={`font-mono text-[12px] ${i === idx ? 'text-white' : 'text-zinc-200'}`}>/{s.name}</span>
                <span className="rounded bg-white/5 px-1.5 text-[10px] text-zinc-400">{t(`context.scope.${s.scope}`)}</span>
              </div>
              {s.description && <div className="text-[11px] text-zinc-500 line-clamp-2">{s.description}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Project files as chips, added from a search of the project (paths are relative to it). */
function FilesInput({ cwd, files, onChange }: { cwd: string | null; files: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ rel: string; isDir: boolean }[]>([]);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (!cwd || !q.trim()) { setHits([]); return; }
    let live = true;
    const timer = setTimeout(() => api.search(cwd, q.trim()).then((h) => { if (live) { setHits(h.slice(0, 8)); setIdx(0); } }).catch(() => {}), 150);
    return () => { live = false; clearTimeout(timer); };
  }, [cwd, q]);
  const add = (rel: string) => { if (rel && !files.includes(rel)) onChange([...files, rel]); setQ(''); setHits([]); };
  return (
    <div>
      {files.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <span key={f} className="flex items-center gap-1 rounded-md bg-white/5 pl-1.5 pr-1 py-0.5 font-mono text-[11.5px]">
              <FileIcon name={f.split('/').pop() ?? f} isDir={f.endsWith('/')} />{f}
              <button className="text-zinc-500 hover:text-white" onClick={() => onChange(files.filter((x) => x !== f))}><Icon name="close" size={10} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <input className={box} value={q} placeholder={t('form.p.files')} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'ArrowDown' && hits.length) { e.preventDefault(); setIdx((i) => (i + 1) % hits.length); }
            if (e.key === 'ArrowUp' && hits.length) { e.preventDefault(); setIdx((i) => (i - 1 + hits.length) % hits.length); }
            if (e.key === 'Enter') { e.preventDefault(); const h = hits[idx]; add(h ? h.rel + (h.isDir ? '/' : '') : q.trim()); }
          }} />
        {hits.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 z-10 glass-pop pop-in rounded-xl py-1">
            {hits.map((h, i) => (
              <div key={h.rel} onMouseEnter={() => setIdx(i)} onMouseDown={(e) => { e.preventDefault(); add(h.rel + (h.isDir ? '/' : '')); }}
                className={`flex items-center gap-2 px-3 py-1 cursor-pointer font-mono text-[12px] ${i === idx ? 'bg-blue-500/20 text-white' : 'text-zinc-300'}`}>
                <FileIcon name={h.rel.split('/').pop() ?? h.rel} isDir={h.isDir} />{h.rel}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
