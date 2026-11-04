import { memo, useRef, useState } from 'react';
import MarkdownView, { CopyButton } from './MarkdownView';
import { todosFromInput, injectedSummary, type ChatItem } from '../lib/chatStore';
import { imageSrc } from '../lib/api';
import { openLightbox } from './Lightbox';
import { t, useLang } from '../lib/i18n';
import { useContextMenu } from './ContextMenu';
import { setDragTransfer, transferMenu, type Transfer } from '../lib/transfer';
import type { Attachment } from '../lib/agent';

/** Text selected inside `el`, if any: right-clicking a selection sends only that part. */
function selectionIn(el: HTMLElement | null): string {
  const sel = window.getSelection();
  if (!el || !sel || sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return '';
  return sel.toString().trim();
}

/** Drag handle shown on hover: drop it on another session's tab to put the message in its box. */
function TransferGrip({ payload, className = '' }: { payload: () => Transfer; className?: string }) {
  return (
    <span draggable onDragStart={(e) => setDragTransfer(e, payload())} title={t('transfer.dragHint')}
      className={`cursor-grab active:cursor-grabbing select-none rounded px-1 text-[11px] leading-4 text-zinc-500 hover:text-zinc-200 hover:bg-white/10 ${className}`}>⠿</span>
  );
}

/** "14:32:05": when an answer block finished. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

const fileAttachment = (path: string, kind: 'image' | 'file' = 'image'): Attachment => ({ path, name: path.split('/').pop() ?? path, kind });

export function summarizeInput(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'Bash': return String(i.command ?? '');
    case 'Read': case 'Write': case 'Edit': return String(i.file_path ?? '');
    case 'Glob': case 'Grep': return `${i.pattern ?? ''} ${i.path ?? ''}`.trim();
    case 'WebFetch': return String(i.url ?? '');
    case 'WebSearch': return String(i.query ?? '');
    case 'Agent': case 'Task': return String(i.description ?? i.prompt ?? '').slice(0, 120);
    case 'FileChange': return ((i.changes as Array<{ path: string }> | undefined) ?? []).map((c) => c.path).join(', ');
    case 'Permissions': return String(i.reason ?? JSON.stringify(i.permissions ?? {}));
    default: { const s = JSON.stringify(i); return s.length > 140 ? s.slice(0, 140) + '…' : s; }
  }
}

export function UserItem({ item, onRewind }: { item: Extract<ChatItem, { kind: 'user' }>; /** Undo file changes made from this message on; absent when not possible. */ onRewind?: () => void }) {
  useLang();
  const menu = useContextMenu();
  const bubble = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  if (item.injected) {
    const summary = injectedSummary(item.injected, item.text);
    return (
      <div className="my-1 rounded-lg border border-dashed border-white/10 bg-white/[0.02] text-xs">
        <button className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-zinc-400 hover:text-zinc-200" onClick={() => setOpen((v) => !v)}>
          <span className="text-[10px] shrink-0">{open ? '▾' : '▸'}</span>
          <span className="shrink-0">{t(item.injected === 'task' ? 'chat.injectedTask' : 'chat.injectedCommand')}</span>
          {summary && <span className="min-w-0 truncate text-zinc-500">{summary}</span>}
          <span className="ml-auto shrink-0 text-[10px] text-zinc-600">{t('chat.injectedHint')}</span>
        </button>
        {open && <div className="px-3 pb-2 whitespace-pre-wrap font-mono text-[11px] text-zinc-400 max-h-80 overflow-auto">{item.text}</div>}
      </div>
    );
  }
  if (item.compact) {
    return (
      <div className="my-1 rounded-lg border border-dashed border-white/10 bg-white/[0.02] text-xs">
        <button className="w-full flex items-center gap-2 px-3 py-1.5 text-zinc-400 hover:text-zinc-200" onClick={() => setOpen((v) => !v)}>
          <span className="text-[10px]">{open ? '▾' : '▸'}</span>
          <span>{t('chat.compactSummary')}</span>
          <span className="ml-auto text-[10px] text-zinc-600">{t('chat.compactSummaryHint')}</span>
        </button>
        {open && <div className="px-3 pb-2 whitespace-pre-wrap text-zinc-400 max-h-80 overflow-auto">{item.text}</div>}
      </div>
    );
  }
  return (
    <div className="group/user flex justify-end items-start gap-2">
      {!item.pending && <TransferGrip className="mt-2.5 opacity-0 group-hover/user:opacity-100" payload={() => ({ text: item.text, attachments: item.attachments })} />}
      {onRewind && !item.pending && (
        <button onClick={onRewind} title={t('rewind.hint')}
          className="mt-2 shrink-0 opacity-0 group-hover/user:opacity-100 rounded-md px-2 py-1 text-[11px] text-zinc-400 hover:text-amber-200 hover:bg-white/5">⟲ {t('rewind.button')}</button>
      )}
      <div ref={bubble} onContextMenu={(e) => { const sel = selectionIn(bubble.current); menu.open(e, transferMenu(sel ? { text: sel, attachments: [] } : { text: item.text, attachments: item.attachments }, sel || item.text)); }}
        className={`max-w-[80%] rounded-[20px] rounded-br-md bg-sky-400/[0.18] border border-sky-200/15 shadow-[0_6px_20px_rgb(0_0_0/.18)] px-4 py-2.5 text-[14px] whitespace-pre-wrap ${item.pending ? 'opacity-60' : ''}`}>
        {item.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {item.attachments.map((a) => a.kind === 'image'
              ? <img key={a.path} draggable onDragStart={(e) => setDragTransfer(e, { text: '', attachments: [a] })} src={imageSrc(a.path, a.name.slice(a.name.lastIndexOf('.')))} alt={a.name} className="h-20 rounded-md object-cover cursor-zoom-in hover:opacity-90 transition-opacity" title={a.path} onClick={() => openLightbox(imageSrc(a.path, a.name.slice(a.name.lastIndexOf('.'))), a.name)} />
              : <span key={a.path} draggable onDragStart={(e) => setDragTransfer(e, { text: '', attachments: [a] })} className="text-xs bg-white/10 rounded px-2 py-1 cursor-grab" title={a.path}>📎 {a.name}</span>)}
          </div>
        )}
        {item.text}
      </div>
    </div>
  );
}

export const AssistantItem = memo(function AssistantItem({ item, baseDir }: { item: Extract<ChatItem, { kind: 'assistant' }>; baseDir?: string }) {
  useLang();
  const menu = useContextMenu();
  const root = useRef<HTMLDivElement>(null);
  const [showThinking, setShowThinking] = useState(false);
  return (
    <div ref={root} className={`group/msg relative ${item.parent ? 'ml-6 border-l border-white/10 pl-3' : ''}`}
      onContextMenu={item.text && !item.streaming ? (e) => { const sel = selectionIn(root.current); menu.open(e, transferMenu({ text: sel || item.text, attachments: [] }, sel || item.text)); } : undefined}>
      {item.text && !item.streaming && (
        <div className="absolute -top-2 right-0 z-[1] flex items-center gap-1 opacity-0 group-hover/msg:opacity-100">
          <TransferGrip payload={() => ({ text: item.text, attachments: [] })} className="bg-black/40" />
          <CopyButton text={item.text} />
        </div>
      )}
      {item.thinking && (
        <div className="mb-1">
          <button className="text-[11px] text-zinc-500 hover:text-zinc-300" onClick={() => setShowThinking((v) => !v)}>
            {showThinking ? '▾' : '▸'} {t('items.thinking')}{item.streaming && !item.text ? '…' : ''}
          </button>
          {showThinking && <div className="mt-1 text-xs text-zinc-500 whitespace-pre-wrap border-l-2 border-white/10 pl-2">{item.thinking}</div>}
        </div>
      )}
      {item.text && (
        <div className="prose-md text-[14px] max-w-none">
          <MarkdownView text={item.text} baseDir={baseDir} />
          {item.streaming && <span className="inline-block w-1.5 h-4 bg-zinc-400 animate-pulse align-middle ml-0.5" />}
        </div>
      )}
      {item.at && !item.streaming && item.text && <div className="mt-0.5 text-right text-[10px] tabular-nums text-zinc-600" title={new Date(item.at).toLocaleString()}>{clockTime(item.at)}</div>}
    </div>
  );
});

const SUBAGENT_TOOLS = new Set(['Agent', 'Task', 'SubAgent', 'SubAgentActivity']);
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif|tiff?|ico)$/i;

/** Pictures to show under a tool card: what the tool returned, else the image file a Read / ImageView opened. */
function toolImages(item: Extract<ChatItem, { kind: 'tool' }>): { src: string; label: string }[] {
  const toSrc = (p: string) => (p.startsWith('data:') ? p : imageSrc(p, p.slice(p.lastIndexOf('.'))));
  if (item.images?.length) return item.images.map((p) => ({ src: toSrc(p), label: p.startsWith('data:') ? item.name : p }));
  if (!item.done || item.isError) return [];
  const i = (item.input ?? {}) as Record<string, unknown>;
  const file = item.name === 'Read' ? i.file_path : item.name === 'ImageView' ? i.path : null;
  return typeof file === 'string' && IMAGE_FILE.test(file) ? [{ src: toSrc(file), label: file }] : [];
}

function ToolImages({ images }: { images: { src: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((im, n) => (
        <img key={n} src={im.src} alt={im.label} title={im.label} loading="lazy" draggable={!im.label.startsWith('data:') && im.label.startsWith('/')}
          onDragStart={(e) => { if (im.label.startsWith('/')) setDragTransfer(e, { text: '', attachments: [fileAttachment(im.label)] }); }}
          className="max-h-56 max-w-full rounded-md border border-white/10 bg-black/30 object-contain cursor-zoom-in hover:border-white/25 transition-colors"
          onClick={(e) => { e.stopPropagation(); openLightbox(im.src, im.label); }} />
      ))}
    </div>
  );
}

/**
 * A checklist update (TodoWrite, or a Codex plan update recorded the same way): one line with progress and the
 * step in hand, the whole list on click. The plan view shows these as the steps themselves.
 */
export function PlanSnapshot({ item, onShowPlan }: { item: Extract<ChatItem, { kind: 'tool' }>; onShowPlan?: () => void }) {
  useLang();
  const [open, setOpen] = useState(false);
  const todos = todosFromInput(item.input) ?? [];
  const done = todos.filter((x) => x.status === 'completed').length;
  const current = todos.find((x) => x.status === 'in_progress');
  return (
    <div className="rounded-xl border border-line bg-black/10 text-[12px]">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button className="flex-1 min-w-0 flex items-center gap-2 text-left" onClick={() => setOpen((v) => !v)}>
          <span className="shrink-0 text-zinc-400">{t('plan.checklist')}</span>
          <span className="shrink-0 tabular-nums text-zinc-500">{done}/{todos.length}</span>
          {current && <span className="truncate text-amber-200">◐ {current.activeForm || current.content}</span>}
          <span className="shrink-0 text-zinc-600">{open ? '▾' : '▸'}</span>
        </button>
        {onShowPlan && <button className="shrink-0 text-[11px] text-zinc-400 hover:text-white transition-colors" onClick={onShowPlan}>{t('plan.jumpPlan')} →</button>}
      </div>
      {open && (
        <ul className="border-t border-line px-3 py-1.5 space-y-0.5">
          {todos.map((x, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className={`shrink-0 w-3 text-center ${x.status === 'completed' ? 'text-emerald-300' : x.status === 'in_progress' ? 'text-amber-300' : 'text-zinc-500'}`}>{x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '◐' : '○'}</span>
              <span className={x.status === 'completed' ? 'text-zinc-400 line-through decoration-zinc-600' : x.status === 'in_progress' ? 'text-zinc-100' : 'text-zinc-300'}>{x.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One line for a TaskCreate / TaskUpdate / TaskList call (current Claude Code checklist). */
export function PlanEvent({ item, title, onShowPlan }: { item: Extract<ChatItem, { kind: 'tool' }>; title?: string; onShowPlan?: () => void }) {
  useLang();
  const i = (item.input ?? {}) as Record<string, unknown>;
  const status = typeof i.status === 'string' ? i.status : null;
  let text: React.ReactNode;
  if (item.name === 'TaskCreate') text = <><span className="text-zinc-400">{t('plan.ev.create')}</span> <span className="text-zinc-200">{String(i.subject ?? '')}</span></>;
  else if (item.name === 'TaskUpdate') {
    const label = status === 'deleted' ? t('plan.ev.deleted') : status ? t(`plan.st.${status}`) : '';
    const tone = status === 'completed' ? 'text-emerald-300' : status === 'in_progress' ? 'text-amber-200' : 'text-zinc-400';
    text = <><span className="text-zinc-400">{t('plan.ev.update')}</span> <span className="text-zinc-200">{title || `#${String(i.taskId ?? '')}`}</span>{label && <span className={tone}> → {label}</span>}</>;
  } else text = <span className="text-zinc-400">{t('plan.ev.list')}</span>;
  return (
    <div className="flex items-center gap-2 px-1 text-[12px]">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status === 'completed' ? 'bg-emerald-400' : status === 'in_progress' ? 'bg-amber-400' : 'bg-zinc-500'}`} />
      <span className="flex-1 min-w-0 truncate">{text}</span>
      {onShowPlan && <button className="shrink-0 text-[11px] text-zinc-500 hover:text-white transition-colors" onClick={onShowPlan}>{t('plan.jumpPlan')} →</button>}
    </div>
  );
}

export function ToolItem({ item, children }: { item: Extract<ChatItem, { kind: 'tool' }>; children?: React.ReactNode }) {
  useLang();
  const [open, setOpen] = useState(true); // tool cards start expanded (input + output visible)
  const [showKids, setShowKids] = useState(true);
  const summary = summarizeInput(item.name, item.input);
  const isSubagent = SUBAGENT_TOOLS.has(item.name);
  const i = (item.input ?? {}) as Record<string, unknown>;
  const images = toolImages(item);
  // "[image]" placeholders say nothing once the picture itself is on screen.
  const output = images.length && item.output !== null ? item.output.split('\n').filter((l) => l.trim() !== '[image]').join('\n').trim() : item.output;
  return (
    <div data-tool-use={item.id} className={`rounded-lg border ${item.isError ? 'border-red-500/30' : isSubagent && !item.done ? 'border-violet-400/40' : 'border-white/10'} ${isSubagent ? 'bg-violet-500/[0.04]' : 'bg-white/[0.03]'} text-[13px] ${item.parent ? 'ml-6' : ''}`}>
      <button className="w-full flex items-center gap-2 px-3 py-1.5 text-left" onClick={() => setOpen((v) => !v)}>
        <span className={`w-1.5 h-1.5 rounded-full ${item.done ? (item.isError ? 'bg-red-400' : 'bg-emerald-400') : 'bg-amber-400 animate-pulse'}`} />
        {isSubagent && <span className={`text-[10px] rounded px-1.5 py-0.5 ${item.done ? 'bg-violet-500/15 text-violet-200' : 'bg-violet-500/25 text-violet-100 animate-pulse'}`}>{item.done ? t('items.subagent') : t('items.subagentWorking')}</span>}
        <span className="font-medium text-zinc-200">{isSubagent ? String(i.subagent_type ?? i.description ?? item.name) : item.name}</span>
        <span className="truncate text-zinc-400 font-mono text-[12px] flex-1">{summary}</span>
        {!item.done && item.elapsed > 0 && <span className="text-zinc-500 text-[11px]">{Math.round(item.elapsed)}s</span>}
        <span className="text-zinc-600">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-white/10 px-3 py-2 space-y-2">
          <pre className="text-[12px] text-zinc-400 whitespace-pre-wrap break-all max-h-48 overflow-auto">{JSON.stringify(item.input, null, 2)}</pre>
          {output !== null && (!images.length || output) && (
            <pre className={`text-[12px] whitespace-pre-wrap break-all max-h-72 overflow-auto rounded bg-black/40 p-2 ${item.isError ? 'text-red-300' : 'text-zinc-300'}`}>{output.slice(0, 20000)}{output.length > 20000 ? '\n…' : ''}</pre>
          )}
          {images.length > 0 && <ToolImages images={images} />}
        </div>
      )}
      {!open && images.length > 0 && <div className="border-t border-white/10 px-3 py-2"><ToolImages images={images} /></div>}
      {children && (
        <div className="border-t border-white/10">
          <button className="w-full text-left px-3 py-1 text-[11px] text-zinc-500 hover:text-zinc-300" onClick={() => setShowKids((v) => !v)}>
            {showKids ? '▾' : '▸'} {isSubagent ? t('items.subagentActivity') : t('items.nestedActivity')}
          </button>
          {showKids && <div className="px-2 pb-2 space-y-2 border-l-2 border-violet-400/30 ml-3">{children}</div>}
        </div>
      )}
    </div>
  );
}

export function ApprovalItem({ item, onDecide }: { item: Extract<ChatItem, { kind: 'approval' }>; onDecide: (d: 'allow' | 'allow_always' | 'deny', message?: string) => void }) {
  useLang();
  const [msg, setMsg] = useState('');
  const summary = summarizeInput(item.toolName, item.input);
  const i = (item.input ?? {}) as Record<string, unknown>;
  const decisionLabel: Record<string, string> = { allow: t('items.allowed'), allow_always: t('items.alwaysAllowed'), deny: t('items.denied'), cancelled: t('items.cancelled') };
  return (
    <div className={`rounded-lg border ${item.decision ? 'border-white/10 opacity-70' : 'border-amber-400/40 bg-amber-400/5'} p-3 text-[13px]`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-amber-300">{t('items.approval')}</span>
        <span className="font-medium">{item.toolName}</span>
        {item.decision && <span className="ml-auto text-xs text-zinc-400">{decisionLabel[item.decision] ?? item.decision}</span>}
      </div>
      <pre className="font-mono text-[12px] text-zinc-200 whitespace-pre-wrap break-all bg-black/30 rounded p-2 max-h-40 overflow-auto">{summary}</pre>
      {item.toolName === 'Edit' && typeof i.old_string === 'string' && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] font-mono">
          <pre className="bg-red-500/10 text-red-200 rounded p-2 whitespace-pre-wrap max-h-40 overflow-auto">{String(i.old_string)}</pre>
          <pre className="bg-emerald-500/10 text-emerald-200 rounded p-2 whitespace-pre-wrap max-h-40 overflow-auto">{String(i.new_string)}</pre>
        </div>
      )}
      {item.toolName === 'FileChange' && Array.isArray(i.changes) && (
        <div className="mt-2 space-y-2">
          {(i.changes as Array<{ path: string; diff: string }>).map((c) => (
            <div key={c.path}>
              <div className="text-[11px] text-zinc-400 font-mono">{c.path}</div>
              <pre className="text-[12px] font-mono whitespace-pre-wrap max-h-48 overflow-auto rounded bg-black/30 p-2">{c.diff.split('\n').map((l, idx) => <span key={idx} className={l.startsWith('+') ? 'text-emerald-300' : l.startsWith('-') ? 'text-red-300' : 'text-zinc-400'}>{l}{'\n'}</span>)}</pre>
            </div>
          ))}
        </div>
      )}
      {item.toolName === 'Write' && typeof i.content === 'string' && (
        <pre className="mt-2 bg-emerald-500/10 text-emerald-200 rounded p-2 text-[12px] font-mono whitespace-pre-wrap max-h-40 overflow-auto">{String(i.content).slice(0, 4000)}</pre>
      )}
      {!item.decision && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className="rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 px-3 py-1" onClick={() => onDecide('allow')}>{t('items.allow')}</button>
          {item.canAlwaysAllow && <button className="rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 px-3 py-1" onClick={() => onDecide('allow_always')}>{t('items.alwaysAllow')}</button>}
          <button className="rounded bg-red-500/20 hover:bg-red-500/30 text-red-200 px-3 py-1" onClick={() => onDecide('deny', msg || undefined)}>{t('items.deny')}</button>
          <input className="flex-1 min-w-40 bg-black/30 rounded px-2 py-1 text-xs outline-none" placeholder={t('items.denyReason')} value={msg} onChange={(e) => setMsg(e.target.value)} />
        </div>
      )}
    </div>
  );
}

export function QuestionItem({ item, onAnswer }: { item: Extract<ChatItem, { kind: 'question' }>; onAnswer: (answers: Record<string, string>) => void }) {
  useLang();
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (q: string, label: string, multi: boolean) => {
    setSel((s) => {
      const cur = s[q] ?? [];
      if (!multi) return { ...s, [q]: [label] };
      return { ...s, [q]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
    });
  };
  const submit = () => {
    const answers: Record<string, string> = {};
    for (const q of item.questions) {
      const o = other[q.question]?.trim();
      answers[q.question] = o || (sel[q.question] ?? []).join(', ');
    }
    onAnswer(answers);
  };
  const complete = item.questions.every((q) => (sel[q.question]?.length ?? 0) > 0 || other[q.question]?.trim());
  return (
    <div className={`rounded-lg border ${item.resolved ? 'border-white/10 opacity-70' : 'border-blue-400/40 bg-blue-400/5'} p-3 text-[13px] space-y-3`}>
      <div className="text-blue-300">{t('items.question')}</div>
      {item.questions.map((q) => (
        <div key={q.question}>
          <div className="text-[11px] uppercase tracking-wide text-zinc-500">{q.header}</div>
          <div className="font-medium mb-1.5">{q.question}</div>
          <div className="grid gap-1.5">
            {q.options.map((o) => {
              const on = (sel[q.question] ?? []).includes(o.label);
              return (
                <button key={o.label} disabled={item.resolved} onClick={() => toggle(q.question, o.label, q.multiSelect)}
                  className={`text-left rounded-md border px-3 py-1.5 ${on ? 'border-blue-400 bg-blue-400/15' : 'border-white/10 hover:bg-white/5'}`}>
                  <div className="font-medium">{o.label}</div>
                  {o.description && <div className="text-xs text-zinc-400">{o.description}</div>}
                </button>
              );
            })}
            {!item.resolved && (
              <input className="bg-black/30 rounded-md px-3 py-1.5 text-xs outline-none border border-white/10" placeholder={t('items.ownAnswer')}
                value={other[q.question] ?? ''} onChange={(e) => setOther((s) => ({ ...s, [q.question]: e.target.value }))} />
            )}
          </div>
        </div>
      ))}
      {!item.resolved && (
        <button disabled={!complete} className="rounded-full bg-selected hover:bg-white text-on-selected font-medium px-3.5 py-1 transition-colors disabled:opacity-40" onClick={submit}>{t('items.sendAnswers')}</button>
      )}
    </div>
  );
}

export function ResultItem({ item }: { item: Extract<ChatItem, { kind: 'result' }> }) {
  useLang();
  return (
    <div className="text-[11px] text-zinc-500 flex gap-3 justify-end">
      <span>{item.ok ? t('items.done') : t('items.error')}{item.at ? ` · ${clockTime(item.at)}` : ''}</span>
      <span>{(item.durationMs / 1000).toFixed(1)}s</span>
      <span>{t('items.turns', { n: item.numTurns })}</span>
      <span>${item.costUsd.toFixed(3)}</span>
    </div>
  );
}
