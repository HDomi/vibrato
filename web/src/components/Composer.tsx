import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Attachment, PermissionModeId } from '../lib/agent';
import { t, useLang } from '../lib/i18n';
import { openLightbox } from './Lightbox';
import FileIcon from './FileIcon';
import PromptMenu from './PromptMenu';
import PromptFormDialog from './PromptFormDialog';
import { draftKey as draftStorageKey, readDraft, writeDraft } from '../lib/draft';
import { mergeAttachments, resolveFiles, toAttachment } from '../lib/attachFiles';
import TaskChips from './TaskChips';
import type { TaskInfo } from '../lib/agent';

interface Props {
  /** Session working directory; root for "@" file mentions. */
  cwd?: string;
  agent?: 'claude' | 'codex';
  disabled: boolean;
  running: boolean;
  mode: PermissionModeId;
  /** Slash commands / skills reported by the agent at session start. */
  commands?: string[];
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onMode: (m: PermissionModeId) => void;
  /** Attachments pushed from outside (file browser "Attach to Chat"). */
  pendingAttachments?: Attachment[];
  onConsumeAttachments?: () => void;
  /** Other sessions still working or waiting for the user; shown next to "Attach" so they are not forgotten. */
  background?: BackgroundSession[];
  onFocusSession?: (id: string) => void;
  /** Stable id (session id) under which unsent text and attachments survive view switches and restarts. */
  draftKey?: string;
  /** This session's subagents / background tasks (Claude); shown as purple chips that open the relation graph. */
  tasks?: Record<string, TaskInfo>;
  /** Root node label of that graph: the session title, else the agent name. */
  taskRootLabel?: string;
  taskRootSub?: string;
  onShowTaskCard?: (toolUseId: string) => void;
  onStopTask?: (taskId: string) => void;
}

export interface BackgroundSession { id: string; name: string; state: 'running' | 'waiting' }
const MAX_BACKGROUND_CHIPS = 3;

const MODE_IDS: { id: PermissionModeId; key: string }[] = [
  { id: 'default', key: 'composer.mode.default' },
  { id: 'acceptEdits', key: 'composer.mode.acceptEdits' },
  { id: 'plan', key: 'composer.mode.plan' },
  { id: 'bypassPermissions', key: 'composer.mode.bypass' },
  { id: 'auto', key: 'composer.mode.auto' },
];


export default function Composer({ cwd, agent, disabled, running, mode, commands = [], onSend, onStop, onMode, pendingAttachments, onConsumeAttachments, background = [], onFocusSession, draftKey, tasks, taskRootLabel, taskRootSub, onShowTaskCard, onStopTask }: Props) {
  useLang();
  const storageKey = draftKey ? draftStorageKey(draftKey) : null;
  const [draft] = useState(() => readDraft(storageKey));
  const [text, setText] = useState(draft.text);
  const [attachments, setAttachments] = useState<Attachment[]>(draft.attachments);
  // The draft is kept until the user actually sends it; an empty composer clears it.
  useEffect(() => writeDraft(storageKey, { text, attachments }), [storageKey, text, attachments]);
  const [dragging, setDragging] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [cmdIdx, setCmdIdx] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [fileHits, setFileHits] = useState<{ path: string; rel: string; isDir: boolean }[]>([]);
  const [fileIdx, setFileIdx] = useState(0);
  const fileTimer = useRef<number | null>(null);

  // "@" mention: the token containing the caret starts with "@" and has no whitespace.
  const mention = useMemo(() => {
    const before = text.slice(0, caret);
    const m = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) return null;
    return { query: m[1], start: caret - m[1].length - 1 };
  }, [text, caret]);
  useEffect(() => {
    let alive = true;
    if (!mention || !cwd) { setFileHits([]); return; }
    if (fileTimer.current) window.clearTimeout(fileTimer.current);
    fileTimer.current = window.setTimeout(() => {
      api.search(cwd, mention.query).then((h) => { if (alive) { setFileHits(h.slice(0, 10)); setFileIdx(0); } }).catch(() => { if (alive) setFileHits([]); });
    }, 100);
    return () => { alive = false; if (fileTimer.current) window.clearTimeout(fileTimer.current); };
  }, [mention?.query, mention?.start, cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickMention = (h: { path: string; rel: string; isDir: boolean }) => {
    if (!mention) return;
    const rel = h.rel.includes(' ') ? `"${h.rel}"` : h.rel;
    const next = text.slice(0, mention.start) + '@' + rel + ' ' + text.slice(caret);
    setText(next);
    if (!h.isDir) setAttachments((a) => (a.some((x) => x.path === h.path) ? a : [...a, toAttachment(h.path)]));
    setFileHits([]);
    requestAnimationFrame(() => { const el = ta.current; if (el) { const pos = mention.start + rel.length + 2; el.focus(); el.setSelectionRange(pos, pos); setCaret(pos); } });
  };

  // Slash-command autocomplete: active while the text is a single "/token" with no space.
  const cmdQuery = useMemo(() => { const m = text.match(/^\/([\w.:-]*)$/); return m ? m[1].toLowerCase() : null; }, [text]);
  const cmdHits = useMemo(() => (cmdQuery === null ? [] : commands.filter((c) => c.toLowerCase().includes(cmdQuery)).slice(0, 12)), [cmdQuery, commands]);
  useEffect(() => setCmdIdx(0), [cmdQuery]);

  useEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(240, el.scrollHeight) + 'px';
  }, [text]);

  useEffect(() => {
    const focus = () => ta.current?.focus();
    window.addEventListener('vibe:focus-composer', focus);
    return () => window.removeEventListener('vibe:focus-composer', focus);
  }, []);

  useEffect(() => {
    if (!pendingAttachments?.length) return;
    setAttachments((a) => [...a, ...pendingAttachments].filter((x, i, arr) => arr.findIndex((y) => y.path === x.path) === i));
    onConsumeAttachments?.();
    ta.current?.focus();
  }, [pendingAttachments, onConsumeAttachments]);

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    const r = await resolveFiles(files);
    setUploading(false);
    setUploadError(r.error);
    setAttachments((a) => mergeAttachments(a, r.attachments));
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const vibePaths = e.dataTransfer.getData('application/x-vibe-path');
    if (vibePaths) {
      const list = vibePaths.split('\n').filter(Boolean).map((p) => toAttachment(p));
      setAttachments((a) => [...a, ...list].filter((x, i, arr) => arr.findIndex((y) => y.path === x.path) === i));
      return;
    }
    void addFiles(Array.from(e.dataTransfer.files));
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) { e.preventDefault(); void addFiles(files); }
  };

  /** Put text at the caret (saved prompts, terminal selections), keeping what was already typed. */
  const insertText = useCallback((value: string) => {
    const el = ta.current;
    const at = el ? el.selectionStart ?? text.length : text.length;
    const end = el ? el.selectionEnd ?? at : at;
    const before = text.slice(0, at), after = text.slice(end);
    const pad = before && !before.endsWith('\n') && !before.endsWith(' ') ? (value.includes('\n') ? '\n' : ' ') : '';
    const next = before + pad + value + after;
    setText(next);
    const pos = before.length + pad.length + value.length;
    requestAnimationFrame(() => { const t2 = ta.current; if (t2) { t2.focus(); t2.setSelectionRange(pos, pos); setCaret(pos); } });
  }, [text]);

  // Text pushed from elsewhere (terminal "→ Chat"): insert it and tell the sender someone took it.
  useEffect(() => {
    const h = (ev: Event) => {
      const d = (ev as CustomEvent<{ text: string; handled: boolean }>).detail;
      if (!d?.text || d.handled || disabled) return;
      d.handled = true;
      insertText(d.text);
    };
    window.addEventListener('vibe:insert-composer', h);
    return () => window.removeEventListener('vibe:insert-composer', h);
  }, [insertText, disabled]);

  const submit = () => {
    const body = text.trim();
    if (disabled || uploading || (!body && attachments.length === 0)) return;
    onSend(body, attachments);
    setText(''); setAttachments([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (mention && fileHits.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setFileIdx((i) => (i + 1) % fileHits.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setFileIdx((i) => (i - 1 + fileHits.length) % fileHits.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickMention(fileHits[fileIdx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setFileHits([]); return; }
    }
    if (cmdHits.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIdx((i) => (i + 1) % cmdHits.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIdx((i) => (i - 1 + cmdHits.length) % cmdHits.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && cmdHits[cmdIdx] !== text)) { e.preventDefault(); setText(cmdHits[cmdIdx] + ' '); return; }
      if (e.key === 'Escape') { setText(text + ' '); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
  };

  const modes = MODE_IDS.filter((m) => m.id !== 'auto' || agent === 'claude');
  const modeHint = t(`${MODE_IDS.find((m) => m.id === mode)?.key ?? 'composer.mode.default'}.hint`);

  return (
    <div className={`px-4 pb-4 pt-2 transition-colors ${dragging ? 'bg-blue-500/10' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((a) => (
            <div key={a.path} className="relative group" title={a.path}>
              {a.kind === 'image'
                ? <img src={api.rawUrl(a.path)} alt={a.name} className="h-16 w-16 object-cover rounded-md border border-white/10 cursor-zoom-in" onClick={() => openLightbox(api.rawUrl(a.path), a.name)} />
                : <div className="h-16 px-3 flex items-center text-xs bg-white/5 rounded-md border border-white/10 max-w-50 truncate">📎 {a.name}</div>}
              <button className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-800 border border-white/20 text-[10px] opacity-0 group-hover:opacity-100"
                onClick={() => setAttachments((l) => l.filter((x) => x.path !== a.path))}>✕</button>
            </div>
          ))}
        </div>
      )}
      {uploadError && <div role="alert" className="text-xs text-red-300 mb-2">{uploadError}</div>}
      <div className="relative rounded-[22px] border border-white/12 bg-black/25 shadow-[0_10px_30px_rgb(0_0_0/.3),inset_0_1px_0_rgb(255_255_255/.06)] transition-colors duration-200 focus-within:border-white/25">
        {mention && fileHits.length > 0 && (
          <div className="absolute bottom-full left-2 mb-1 w-[480px] max-w-[95%] glass-pop pop-in rounded-xl py-1 text-[13px] z-10">
            {fileHits.map((h, i) => (
              <div key={h.path} onMouseEnter={() => setFileIdx(i)} onMouseDown={(e) => { e.preventDefault(); pickMention(h); }}
                className={`px-3 py-1 flex items-center gap-2 cursor-pointer ${i === fileIdx ? 'bg-blue-500/20 text-white' : 'text-zinc-300'}`}>
                <FileIcon name={h.rel.split('/').pop() ?? h.rel} isDir={h.isDir} className="w-3.5 h-3.5" />
                <span className="font-mono truncate">{h.rel}</span>
              </div>
            ))}
            <div className="px-3 pt-1 text-[10px] text-zinc-600">{t('composer.mentionHint')}</div>
          </div>
        )}
        {cmdHits.length > 0 && (
          <div className="absolute bottom-full left-2 mb-1 w-90 max-w-[90%] glass-pop pop-in rounded-xl py-1 text-[13px] z-10">
            {cmdHits.map((c, i) => (
              <div key={c} onMouseEnter={() => setCmdIdx(i)} onMouseDown={(e) => { e.preventDefault(); setText(c + ' '); }}
                className={`px-3 py-1 font-mono cursor-pointer ${i === cmdIdx ? 'bg-blue-500/20 text-white' : 'text-zinc-300'}`}>{c}</div>
            ))}
            <div className="px-3 pt-1 text-[10px] text-zinc-600">{t('composer.cmdHint')}</div>
          </div>
        )}
        <textarea ref={ta} value={text} onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); }} onPaste={onPaste}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)} onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)} onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          disabled={disabled} onKeyDown={onKeyDown}
          placeholder={disabled ? t('composer.startFirst') : running ? t('composer.queueHint') : t('composer.placeholder')}
          className="w-full bg-transparent px-4 pt-3 pb-2 text-[14px] outline-none resize-none min-h-11" rows={1} />
        <div className="flex items-center gap-2 px-2 pb-2 whitespace-nowrap">
          <select value={mode} onChange={(e) => onMode(e.target.value as PermissionModeId)} disabled={disabled}
            className="bg-black/20 border border-line rounded-full text-xs px-3 py-1 outline-none min-w-0 shrink" title={modeHint}>
            {modes.map((m) => <option key={m.id} value={m.id}>{t(m.key)}</option>)}
          </select>
          <label className="shrink-0 text-xs text-zinc-400 hover:text-white hover:bg-fill rounded-full cursor-pointer px-2.5 py-1 transition-colors">
            📎 {t('composer.attach')}
            <input type="file" multiple className="hidden" onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          </label>
          <PromptMenu draft={text} onInsert={insertText} disabled={disabled} />
          {uploading && <span className="text-xs text-zinc-500">{t('composer.uploading')}</span>}
          {tasks && <TaskChips tasks={tasks} rootLabel={taskRootLabel ?? (agent === 'codex' ? 'Codex' : 'Claude')} rootSub={taskRootSub} onShowCard={onShowTaskCard} onStopTask={onStopTask} />}
          {background.length > 0 && (
            <div className="flex items-center gap-1 min-w-0 overflow-hidden" title={t('composer.backgroundTitle', { n: background.length })}>
              {background.slice(0, MAX_BACKGROUND_CHIPS).map((b) => (
                <button key={b.id} type="button" onClick={() => onFocusSession?.(b.id)}
                  title={`${b.name} · ${t(b.state === 'waiting' ? 'composer.bgWaiting' : 'composer.bgRunning')} · ${t('composer.bgOpen')}`}
                  className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] max-w-40 hover:bg-white/10 ${b.state === 'waiting' ? 'text-amber-200 bg-amber-500/10' : 'text-zinc-400 bg-white/5'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${b.state === 'waiting' ? 'bg-amber-400' : 'bg-amber-400 animate-pulse'}`} />
                  <span className="truncate">{b.name}</span>
                </button>
              ))}
              {background.length > MAX_BACKGROUND_CHIPS && <span className="text-[11px] text-zinc-500 shrink-0">+{background.length - MAX_BACKGROUND_CHIPS}</span>}
            </div>
          )}
          <div className="flex-1" />
          {running && <button className="shrink-0 rounded-full bg-red-500/20 hover:bg-red-500/30 text-red-200 text-xs px-3.5 py-1.5 transition-colors" onClick={onStop}>{t('composer.stop')}</button>}
          <button className="shrink-0 rounded-full bg-fill hover:bg-fill-2 transition-colors text-xs text-zinc-300 px-3 py-1.5 disabled:opacity-40" disabled={disabled} onClick={() => setFormOpen(true)} title={t('composer.formHint')}>{t('composer.form')}</button>
          <button className="shrink-0 rounded-full bg-selected hover:bg-white text-on-selected font-medium text-xs px-4 py-1.5 transition-colors disabled:opacity-40" disabled={disabled || uploading || (!text.trim() && !attachments.length)} onClick={submit}>{running ? t('composer.queue') : t('composer.send')}</button>
        </div>
      </div>
      {formOpen && (
        <PromptFormDialog cwd={cwd ?? null} agent={agent} draftKey={draftKey} running={!!running} onClose={() => setFormOpen(false)}
          onSend={(body, atts) => onSend(body, atts)} onInsert={insertText}
          onEditTypes={() => { setFormOpen(false); window.dispatchEvent(new CustomEvent('vibe:open-settings', { detail: { section: 'formTypes' } })); }} />
      )}
    </div>
  );
}
