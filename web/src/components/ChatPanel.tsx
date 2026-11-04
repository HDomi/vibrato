import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewActiveRef } from '../lib/viewActive';
import { currentTodos, displayTitle, isInjected, type ChatItem, type ChatSession } from '../lib/chatStore';
import type { AgentId, Attachment, PermissionModeId, RewindResult } from '../lib/agent';
import { api, type Backlog, type HistorySession, type ModelInfo, type WorktreeInfo } from '../lib/api';
import LeftoverWorktrees from './LeftoverWorktrees';
import BacklogPanel from './BacklogPanel';
import Composer, { type BackgroundSession } from './Composer';
import ChatSearch from './ChatSearch';
import TodoPanel from './TodoPanel';
import { ApprovalItem, AssistantItem, PlanSnapshot, QuestionItem, ResultItem, ToolItem, UserItem } from './ChatItems';
import PlanView from './PlanView';
import { PLAN_TOOL } from '../lib/planView';
import { useContextMenu } from './ContextMenu';
import { t, useLang } from '../lib/i18n';
import ProjectIcon from './ProjectIcon';
import AgentIcon from './AgentIcon';
import Icon from './Icon';
import { VerifyButton, VerifyItem } from './Verify';
import { TurnChangesItem } from './TurnChanges';
import WorktreeChip from './WorktreeChip';
import { useUsage } from '../lib/usageStore';
import { minutesLabel } from './UsageBar';
import { sessionBrief } from '../lib/brief';
import { exportFileName, exportMarkdown } from '../lib/exportMarkdown';
import { toast } from './Toast';

/** Same prompt to Claude and Codex, each in its own worktree, to compare and keep the better result. */
export interface PairOptions { prompt: string; branch?: string; permissionMode: PermissionModeId; models: { claude: string | null; codex: string | null } }

export interface StartOptions { resume?: string; permissionMode?: PermissionModeId; agent?: AgentId; model?: string | null; title?: string; /** Start in a new git worktree (optional branch name). */ isolate?: { branch?: string } }

interface Props {
  cwd: string | null;
  /** 'folder': a project's start screen. 'home': the Agent view, which holds only sessions run in the home folder. */
  scope?: 'folder' | 'home';
  session: ChatSession | null;
  onStart: (cwd: string, opts?: StartOptions) => void;
  onStartPair?: (cwd: string, opts: PairOptions) => void;
  /** Project task queue, shown on the start screen. */
  backlog?: Backlog;
  onBacklogChange?: (fn: (b: Backlog) => Backlog) => void;
  onOpenBacklogSession?: (id: string) => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onApprove: (requestId: string, decision: 'allow' | 'allow_always' | 'deny', message?: string) => void;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
  onInterrupt: () => void;
  /** Stop one subagent / background task (Claude). */
  onStopTask?: (taskId: string) => void;
  onMode: (m: PermissionModeId) => void;
  onModel: (m: string | null) => void;
  onClose: () => void;
  pendingAttachments?: Attachment[];
  onConsumeAttachments?: () => void;
  /** Claude: preview or undo file changes since a user message. */
  onRewind?: (messageId: string, dryRun: boolean) => Promise<RewindResult>;
  /** Other live sessions that are working or waiting; the composer lists them so they stay visible. */
  background?: BackgroundSession[];
  onFocusSession?: (id: string) => void;
  /** Run the project's verification command now. */
  onVerify?: () => void;
  /** Other open sessions working in this session's worktree (review, handoff): merge waits for them. */
  worktreeUsers?: number;
  /** Worktree folders open in some session, and opening a leftover one (start screen list). */
  openWorktrees?: string[];
  onOpenWorktree?: (wt: WorktreeInfo) => void;
  /** The other session of a Claude-vs-Codex comparison, if any. */
  partner?: ChatSession | null;
  onFocusPartner?: (id: string) => void;
  onClosePartner?: (id: string) => void;
  /** Continue this conversation with the other agent (usage limit close). */
  onHandoff?: () => void;
  /** Ask the other agent to review a turn's changes (or the uncommitted work). */
  onCrossReview?: (changes?: Extract<ChatItem, { kind: 'changes' }>) => void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const modelCache: Partial<Record<AgentId, ModelInfo[]>> = {};
function useModels(agent: AgentId) {
  const [models, setModels] = useState<ModelInfo[]>(modelCache[agent] ?? []);
  useEffect(() => {
    if (modelCache[agent]) { setModels(modelCache[agent]!); return; }
    let alive = true;
    api.models(agent).then((m) => { modelCache[agent] = m; if (alive) setModels(m); }).catch(() => {});
    return () => { alive = false; };
  }, [agent]);
  return models;
}

export function ModelSelect({ agent, value, onChange, compact }: { agent: AgentId; value: string | null; onChange: (m: string | null) => void; compact?: boolean }) {
  useLang();
  const models = useModels(agent);
  const known = value && models.some((m) => m.id === value || m.name === value);
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} title={t('chat.model')}
      className={`bg-white/5 rounded-md outline-none ${compact ? 'text-[11px] px-1.5 py-0.5 max-w-45 min-w-0' : 'text-xs px-2 py-1.5'}`}>
      <option value="">{t('chat.defaultModel')}</option>
      {value && !known && <option value={value}>{value}</option>}
      {models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.isDefault ? t('chat.defaultSuffix') : ''}</option>)}
    </select>
  );
}

type SessionView = 'chat' | 'plan';
const LS_VIEW = 'vibe.sessionView';
/** This session's last view, else the default for new sessions (Settings > General). */
function readSessionView(id: string): SessionView {
  try {
    const v = localStorage.getItem(`${LS_VIEW}.${id}`) ?? localStorage.getItem(LS_VIEW);
    return v === 'plan' ? 'plan' : 'chat';
  } catch { return 'chat'; }
}

function renderItem(it: ChatItem, childrenOf: Map<string, ChatItem[]>, actions: { showPlan?: (todoId: string) => void; approve: Props['onApprove']; answer: Props['onAnswer']; cwd: string; rewind?: (messageId: string) => void; latestVerify?: string; verify?: () => void; review?: (changes: Extract<ChatItem, { kind: 'changes' }>) => void; otherAgent?: string }): React.ReactNode {
  switch (it.kind) {
    case 'user': return <UserItem key={it.id} item={it} onRewind={actions.rewind && UUID_RE.test(it.id) && !isInjected(it) ? () => actions.rewind!(it.id) : undefined} />;
    case 'assistant': return <AssistantItem key={it.id} item={it} baseDir={actions.cwd} />;
    case 'tool': {
      if (it.name === PLAN_TOOL && !it.parent) return <PlanSnapshot key={it.id} item={it} onShowPlan={actions.showPlan ? () => actions.showPlan!(it.id) : undefined} />;
      const kids = childrenOf.get(it.id);
      return <ToolItem key={it.id} item={it}>{kids?.map((k) => renderItem(k, childrenOf, actions))}</ToolItem>;
    }
    case 'approval': return <ApprovalItem key={it.id} item={it} onDecide={(d, m) => actions.approve(it.id, d, m)} />;
    case 'question': return <QuestionItem key={it.id} item={it} onAnswer={(a) => actions.answer(it.id, a)} />;
    case 'result': return <ResultItem key={it.id} item={it} />;
    case 'error': return <div key={it.id} className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[13px] text-red-200 whitespace-pre-wrap">{it.message}</div>;
    case 'system': return <div key={it.id} className="text-xs text-zinc-500 text-center py-1">{it.text}</div>;
    case 'changes': return <TurnChangesItem key={it.id} item={it} onReview={actions.review ? () => actions.review!(it) : undefined} reviewer={actions.otherAgent} />;
    case 'verify': return <VerifyItem key={it.id} item={it} latest={it.id === actions.latestVerify} onRerun={it.id === actions.latestVerify ? actions.verify : undefined} />;
  }
}

/** Pinned to the top of a resumed conversation: what it already did, without scrolling back through it. */
function ResumeBrief({ session }: { session: ChatSession }) {
  useLang();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const b = useMemo(() => sessionBrief(session), [session.items, session.todos, session.cwd]); // eslint-disable-line react-hooks/exhaustive-deps
  if (hidden || !b.asks) return null;
  const parts = [t('brief.asks', { n: b.asks }), b.files.length ? t('brief.files', { n: b.files.length }) : null, b.commits.length ? t('brief.commits', { n: b.commits.length }) : null, b.todos.length ? t('brief.todos', { n: b.todos.length }) : null].filter(Boolean);
  return (
    <div className="sticky top-0 z-10 -mx-5 -mt-4 mb-1 px-5 pt-2 pb-2 glass-fill border-b border-line">
      <div className="rounded-lg border border-sky-400/20 bg-sky-400/[0.05] text-[12px]">
        <div className="flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none" onClick={() => setOpen((v) => !v)}>
          <Icon name="undo" size={12} className="text-sky-300 shrink-0" />
          <span className="text-sky-100 font-medium whitespace-nowrap">{t('brief.title')}</span>
          <span className="truncate min-w-0 text-zinc-400">{parts.join(' · ')}</span>
          <div className="flex-1" />
          <span className="text-zinc-500 text-[10px]">{open ? '▾' : '▸'}</span>
          <button onClick={(e) => { e.stopPropagation(); setHidden(true); }} className="text-zinc-500 hover:text-zinc-200"><Icon name="close" size={11} /></button>
        </div>
        {open && (
          <div className="border-t border-sky-400/10 px-3 py-2 space-y-2 max-h-72 overflow-y-auto">
            {b.files.length > 0 && <div><div className="text-[11px] text-zinc-500 mb-0.5">{t('brief.filesTitle')}</div><div className="flex flex-wrap gap-1">{b.files.slice(0, 30).map((f) => (
              <button key={f} onClick={() => window.dispatchEvent(new CustomEvent('vibe:open-file', { detail: { path: f.startsWith('/') ? f : `${session.cwd}/${f}` } }))} className="rounded-full bg-fill hover:bg-fill-2 transition-colors px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">{f}</button>
            ))}{b.files.length > 30 && <span className="text-[11px] text-zinc-500">+{b.files.length - 30}</span>}</div></div>}
            {b.commits.length > 0 && <div><div className="text-[11px] text-zinc-500 mb-0.5">{t('brief.commitsTitle')}</div>{b.commits.slice(-8).map((c, i) => <div key={i} className="font-mono text-[11.5px] text-zinc-300 truncate">{c}</div>)}</div>}
            {b.todos.length > 0 && <div><div className="text-[11px] text-zinc-500 mb-0.5">{t('brief.todosTitle')}</div>{b.todos.map((x, i) => <div key={i} className="text-zinc-300">☐ {x}</div>)}</div>}
            {b.last && <div><div className="text-[11px] text-zinc-500 mb-0.5">{t('brief.lastTitle')}</div><div className="text-zinc-400 whitespace-pre-wrap line-clamp-6">{b.last}</div></div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Above the composer when this agent's 5-hour window is nearly used up: offer to continue with the other one. */
function LimitBanner({ agent, sessionId, onHandoff }: { agent: AgentId; sessionId: string; onHandoff: () => void }) {
  useLang();
  const { usage, forecast } = useUsage();
  const [hidden, setHidden] = useState<string | null>(null);
  const win = usage?.[agent]?.fiveHour ?? null;
  const empty = forecast(`${agent}.fiveHour`, win);
  if (!win || hidden === sessionId) return null;
  const near = win.usedPct >= 90 || (empty !== null && empty <= 20);
  if (!near) return null;
  const name = agent === 'claude' ? 'Claude' : 'Codex';
  const other = agent === 'claude' ? 'Codex' : 'Claude';
  const otherWin = usage?.[agent === 'claude' ? 'codex' : 'claude']?.fiveHour;
  return (
    <div className="shrink-0 mx-4 mb-1 flex items-center gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.07] px-3 py-1.5 text-[11.5px]">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
      <span className="text-amber-100 truncate min-w-0">
        {t('limit.near', { agent: name, pct: win.usedPct })}{empty !== null ? ` · ${t('usage.forecast', { time: minutesLabel(empty) })}` : ''}
      </span>
      <div className="flex-1" />
      <button onClick={onHandoff} className="shrink-0 rounded-md bg-amber-400/20 hover:bg-amber-400/30 px-2 py-0.5 text-amber-50 whitespace-nowrap"
        title={otherWin ? t('limit.otherLeft', { agent: other, pct: 100 - otherWin.usedPct }) : undefined}>{t('limit.handoff', { agent: other })}</button>
      <button onClick={() => setHidden(sessionId)} className="shrink-0 text-amber-200/60 hover:text-amber-100"><Icon name="close" size={11} /></button>
    </div>
  );
}

const MODE_IDS: { id: PermissionModeId; key: string }[] = [
  { id: 'default', key: 'chat.mode.default' },
  { id: 'acceptEdits', key: 'chat.mode.acceptEdits' },
  { id: 'plan', key: 'chat.mode.plan' },
  { id: 'bypassPermissions', key: 'chat.mode.bypass' },
  { id: 'auto', key: 'chat.mode.auto' },
];

function StartScreen({ cwd, scope = 'folder', onStart, onStartPair, backlog, onBacklogChange, onOpenBacklogSession, openWorktrees, onOpenWorktree }: { cwd: string | null; scope?: 'folder' | 'home'; onStart: Props['onStart']; onStartPair?: Props['onStartPair']; backlog?: Backlog; onBacklogChange?: Props['onBacklogChange']; onOpenBacklogSession?: Props['onOpenBacklogSession']; openWorktrees?: string[]; onOpenWorktree?: Props['onOpenWorktree'] }) {
  useLang();
  const menu = useContextMenu();
  const [history, setHistory] = useState<HistorySession[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [mode, setMode] = useState<PermissionModeId>(() => { try { return (localStorage.getItem('vibe.mode') as PermissionModeId) || 'default'; } catch { return 'default'; } });
  const [agent, setAgent] = useState<AgentId>(() => { try { return (localStorage.getItem('vibe.agent') as AgentId) || 'claude'; } catch { return 'claude'; } });
  const [model, setModel] = useState<string | null>(() => { try { return localStorage.getItem(`vibe.model.${agent}`); } catch { return null; } });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  // Worktree start: only offered inside a git repository with at least one commit.
  const [isGit, setIsGit] = useState(false);
  const [isolate, setIsolate] = useState(false);
  const [branch, setBranch] = useState('');
  const [compare, setCompare] = useState(false);
  const [pairPrompt, setPairPrompt] = useState('');
  useEffect(() => {
    setIsGit(false); setIsolate(false);
    if (!cwd || scope === 'home') return;
    let alive = true;
    api.gitStatus(cwd).then((st) => { if (alive) setIsGit(st.repo); }).catch(() => {});
    return () => { alive = false; };
  }, [cwd, scope]);
  useEffect(() => { try { localStorage.setItem('vibe.agent', agent); setModel(localStorage.getItem(`vibe.model.${agent}`)); } catch { /* ignore */ } }, [agent]);
  useEffect(() => { try { localStorage.setItem('vibe.mode', mode); } catch { /* ignore */ } }, [mode]);
  useEffect(() => { try { model ? localStorage.setItem(`vibe.model.${agent}`, model) : localStorage.removeItem(`vibe.model.${agent}`); } catch { /* ignore */ } }, [model, agent]);

  const historyRequest = useRef(0);
  const loadHistory = () => {
    const request = ++historyRequest.current;
    if (!cwd) return;
    setLoadingHistory(true);
    const p = api.history(cwd, 'all', scope === 'home' ? 200 : undefined);
    p.then((rows) => { if (request === historyRequest.current) setHistory(rows); }).catch(() => { if (request === historyRequest.current) setHistory([]); }).finally(() => { if (request === historyRequest.current) setLoadingHistory(false); });
  };
  useEffect(() => { setHistory([]); loadHistory(); return () => { historyRequest.current++; }; /* eslint-disable-line react-hooks/exhaustive-deps */ }, [cwd, scope]);
  // A pin toggled on a tab or in the sidebar shows here too.
  useEffect(() => { const h = () => loadHistory(); window.addEventListener('vibe:pins-changed', h); return () => window.removeEventListener('vibe:pins-changed', h); }); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cwd) return <div className="h-full flex items-center justify-center text-zinc-600 text-sm">{t('chat.openFolderFirst')}</div>;
  const shown = filter.trim() ? history.filter((h) => `${h.customTitle ?? ''} ${h.summary} ${h.firstPrompt ?? ''} ${h.cwd ?? ''}`.toLowerCase().includes(filter.toLowerCase())) : history;
  const opts = (extra: Partial<StartOptions> = {}) => ({ permissionMode: mode, agent, model, ...extra });
  const rename = (h: HistorySession) => {
    const title = draft.trim(); setRenaming(null);
    if (!title) return;
    api.historyRename(h.agent, h.sessionId, title, cwd).then(loadHistory).catch(() => {});
  };
  const titleOf = (h: HistorySession) => h.customTitle || h.summary || h.firstPrompt || h.sessionId;
  const remove = (h: HistorySession) => {
    if (h.pinned) { window.alert(t('common.pinnedUnpinFirst', { title: titleOf(h) })); return; }
    if (!window.confirm(t('common.confirmDeleteSession', { title: titleOf(h) }))) return;
    api.historyDelete(h.agent, h.sessionId, cwd).then(loadHistory).catch((e) => window.alert(e.message));
  };
  const togglePin = (h: HistorySession) => api.historyPin(h.agent, h.sessionId, !h.pinned).then(loadHistory).catch(() => {});
  const agentName = agent === 'claude' ? 'Claude' : 'Codex';

  return (
    <div className="@container h-full overflow-y-auto p-6">
    {/* Project: start options left and previous sessions right when wide. Agent view: always stacked (its own list is on the left). */}
    <div className={`mx-auto grid gap-4 items-start ${scope === 'home' ? 'max-w-3xl' : 'max-w-6xl @[860px]:grid-cols-2'}`}>
    <section className="rounded-[20px] border border-line bg-black/15 p-6 min-w-0">
      <div className="text-xs text-zinc-500 mb-1">{scope === 'home' ? t('chat.agent') : t('chat.project')}</div>
      {scope === 'home'
        ? <div className="text-lg font-medium mb-6">{t('chat.freeConversation')}</div>
        : <div className="flex items-center gap-3 mb-6" title={cwd}><ProjectIcon path={cwd} name={cwd.split('/').pop() || cwd} size={40} /><div className="text-xl font-semibold truncate">{cwd.split('/').pop() || cwd}</div>
            <div className="flex-1" />
            <button onClick={() => window.dispatchEvent(new Event('vibe:agent-context'))} className="shrink-0 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-zinc-300 bg-fill hover:text-white hover:bg-fill-2 transition-colors"><Icon name="file" size={13} />{t('context.menu')}</button>
          </div>}
      {scope === 'home' && <div className="text-xs text-zinc-500 -mt-4 mb-6">{t('chat.freeHint', { cwd })}</div>}
      <div className="flex items-center gap-1 mb-4 rounded-full bg-black/20 border border-line p-1 w-fit text-sm">
        {(['claude', 'codex'] as AgentId[]).map((a) => (
          <button key={a} onClick={() => { setAgent(a); setCompare(false); }} className={`px-4 py-1.5 rounded-full transition-colors duration-150 ${agent === a && !compare ? 'bg-selected text-on-selected' : 'text-zinc-400 hover:text-white'}`}>{a === 'claude' ? t('chat.claudeCode') : 'Codex'}</button>
        ))}
        {isGit && onStartPair && <button onClick={() => setCompare(true)} className={`px-4 py-1.5 rounded-full flex items-center gap-1.5 transition-colors duration-150 ${compare ? 'bg-violet-300 text-violet-950' : 'text-zinc-400 hover:text-white'}`} title={t('pair.hint')}><Icon name="branch" size={13} />{t('pair.tab')}</button>}
      </div>
      {compare && isGit && onStartPair ? (
        <div className="mb-6 rounded-lg border border-violet-400/25 bg-violet-400/[0.05] p-3 space-y-2.5">
          <div className="text-xs text-zinc-400 leading-relaxed">{t('pair.about')}</div>
          <textarea value={pairPrompt} onChange={(e) => setPairPrompt(e.target.value)} rows={4} placeholder={t('pair.placeholder')}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && pairPrompt.trim()) onStartPair(cwd, { prompt: pairPrompt.trim(), branch: branch.trim() || undefined, permissionMode: mode, models: { claude: localStorage.getItem('vibe.model.claude'), codex: localStorage.getItem('vibe.model.codex') } }); }}
            className="w-full rounded-md bg-black/40 border border-white/10 focus:border-violet-400/50 px-3 py-2 text-[13px] outline-none resize-y" />
          <div className="flex items-center gap-2 flex-wrap">
            <button disabled={!pairPrompt.trim()} className="rounded-full bg-violet-300 hover:bg-violet-200 text-violet-950 font-medium disabled:opacity-40 px-4 py-2 text-sm transition-colors"
              onClick={() => onStartPair(cwd, { prompt: pairPrompt.trim(), branch: branch.trim() || undefined, permissionMode: mode, models: { claude: localStorage.getItem('vibe.model.claude'), codex: localStorage.getItem('vibe.model.codex') } })}>
              {t('pair.start')} <span className="opacity-60 text-xs ml-1">⌘⏎</span>
            </button>
            <select value={mode} onChange={(e) => setMode(e.target.value as PermissionModeId)} className="bg-black/20 border border-line rounded-full text-xs px-3 py-1.5 outline-none">
              {MODE_IDS.filter((m) => m.id !== 'auto').map((m) => <option key={m.id} value={m.id}>{t(m.key)}</option>)}
            </select>
            <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={t('pair.branchPlaceholder')} spellCheck={false}
              className="w-48 rounded-md bg-black/40 border border-white/10 focus:border-violet-400/50 px-2 py-1.5 font-mono text-[11.5px] outline-none" />
          </div>
        </div>
      ) : <>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <button className="rounded-full bg-selected hover:bg-white text-on-selected font-medium px-4 py-2 text-sm shadow-[0_4px_14px_rgb(0_0_0/.25)] transition-colors" onClick={() => onStart(cwd, opts(isolate ? { isolate: { branch: branch.trim() || undefined } } : {}))}>{t('chat.newSession', { agent: agentName })} <span className="opacity-50 text-xs ml-1">⌘N</span></button>
        <select value={mode} onChange={(e) => setMode(e.target.value as PermissionModeId)} className="bg-black/20 border border-line rounded-full text-xs px-3 py-1.5 outline-none">
          {MODE_IDS.filter((m) => m.id !== 'auto' || agent === 'claude').map((m) => <option key={m.id} value={m.id}>{t(m.key)}</option>)}
        </select>
        <ModelSelect agent={agent} value={model} onChange={setModel} />
      </div>
      {isGit && (
        <div className={`mb-3 rounded-2xl border px-3.5 py-2.5 text-xs transition-colors ${isolate ? 'border-violet-400/30 bg-violet-400/[0.06]' : 'border-line bg-black/10'}`}>
          <label className="flex items-center gap-2 cursor-pointer text-zinc-300">
            <input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} />
            <Icon name="branch" size={13} className={isolate ? 'text-violet-300' : 'text-zinc-500'} />
            {t('worktree.startIn')}
          </label>
          {isolate && (
            <div className="mt-2 pl-6 space-y-1.5">
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={t('worktree.branchPlaceholder')} spellCheck={false}
                className="w-64 rounded-md bg-black/40 border border-white/10 focus:border-violet-400/50 px-2 py-1 font-mono text-[11.5px] outline-none" />
              <div className="text-[11px] text-zinc-500 leading-relaxed">{t('worktree.startHint')}</div>
            </div>
          )}
        </div>
      )}
      <div className="text-xs text-zinc-500 mb-6">{agent === 'codex' ? t('chat.codexHint') : t('chat.claudeHint')}</div>
      </>}
      {isGit && onOpenWorktree && scope === 'folder' && <LeftoverWorktrees cwd={cwd} open={openWorktrees ?? []} onOpen={onOpenWorktree} />}
      {backlog && onBacklogChange && scope === 'folder' && (
        <div className="rounded-2xl border border-line bg-black/10 p-3.5">
          <BacklogPanel compact backlog={backlog} onChange={onBacklogChange} onFocusSession={(id) => onOpenBacklogSession?.(id)} />
        </div>
      )}
    </section>
    <section className="rounded-[20px] border border-line bg-black/15 p-4 min-w-0">
      <div className="flex items-center text-xs text-zinc-400 mb-3 px-1 gap-3 h-7">
        <span className="font-medium">{scope === 'home' ? t('chat.previousAll', { n: history.length }) : t('chat.previousFolder')}</span>
        <div className="flex-1" />
        {scope === 'home' && <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('common.search')} className="bg-black/20 border border-line rounded-full px-3 py-1 text-xs outline-none w-44 focus:border-white/30 transition-colors" />}
        {loadingHistory && <span className="text-zinc-600">{t('chat.loading')}</span>}
      </div>
      {history.length === 0 && !loadingHistory && <div className="px-1 text-xs text-zinc-500">{t('chat.noSessions')}</div>}
      <div className="space-y-1">
        {shown.map((h) => (
          <div key={h.agent + h.sessionId} className="w-full text-left rounded-xl hover:bg-fill-2 px-3 py-2 cursor-pointer flex items-center gap-3 transition-colors duration-150"
            onClick={() => onStart(h.cwd ?? cwd, opts({ resume: h.sessionId, agent: h.agent, title: h.customTitle || h.summary || undefined }))}
            onContextMenu={(e) => menu.open(e, [
              { label: t('common.resume'), onClick: () => onStart(h.cwd ?? cwd, opts({ resume: h.sessionId, agent: h.agent, title: h.customTitle || h.summary || undefined })) },
              { label: h.pinned ? t('common.unpin') : t('common.pin'), onClick: () => togglePin(h) },
              { label: t('common.rename'), onClick: () => { setRenaming(h.sessionId); setDraft(h.customTitle || h.summary || ''); } },
              { label: t('common.copySessionId'), onClick: () => navigator.clipboard.writeText(h.sessionId) },
              { separator: true },
              { label: h.pinned ? t('common.deleteUnpinFirst') : t('common.deletePermanently'), danger: true, disabled: !!h.pinned, onClick: () => remove(h) },
            ])}>
            <AgentIcon agent={h.agent} size={18} />
            {h.pinned && <span title={t('common.pinned')}>📌</span>}
            <div className="flex-1 min-w-0">
              {renaming === h.sessionId
                ? <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onClick={(e) => e.stopPropagation()} onBlur={() => rename(h)}
                    onKeyDown={(e) => { if (e.key === 'Enter') rename(h); if (e.key === 'Escape') setRenaming(null); }}
                    className="w-full bg-black/40 rounded px-2 py-0.5 text-sm outline-none border border-blue-400/50" />
                : <div className="text-sm truncate">{titleOf(h)}</div>}
              <div className="text-[11px] text-zinc-500 truncate">{new Date(h.lastModified).toLocaleString()}{h.gitBranch ? ` · ${h.gitBranch}` : ''}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
    </div>
    </div>
  );
}

export default function ChatPanel({ cwd, scope = 'folder', session, onStart, onStartPair, backlog, onBacklogChange, onOpenBacklogSession, onSend, onApprove, onAnswer, onInterrupt, onStopTask, onMode, onModel, onClose, pendingAttachments, onConsumeAttachments, background, onFocusSession, onRewind, onVerify, onCrossReview, partner, onFocusPartner, onClosePartner, onHandoff, worktreeUsers = 0, openWorktrees, onOpenWorktree }: Props) {
  useLang();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);          // follow new content until the user scrolls up
  const programmatic = useRef(false);  // ignore scroll events we caused ourselves
  const [atBottom, setAtBottom] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [searching, setSearching] = useState(false);
  // Chat or plan view, remembered per session; new sessions follow Settings > General.
  const [view, setView] = useState<SessionView>('chat');
  const [focusTurn, setFocusTurn] = useState<string | null>(null);
  useEffect(() => { if (session) { setView(readSessionView(session.id)); setFocusTurn(null); } }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const switchView = (v: SessionView) => {
    setView(v);
    if (session) try { localStorage.setItem(`${LS_VIEW}.${session.id}`, v); } catch { /* ignore */ }
  };
  // Export mode: top-level blocks get a checkbox; the picked ones become one Markdown file (plus images, zipped).
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [withThinking, setWithThinking] = useState(false);
  const [exporting, setExporting] = useState(false);
  useEffect(() => { setPicked(null); }, [session?.id]);
  const viewActive = useViewActiveRef();
  useEffect(() => {
    if (!picked) return;
    const h = (e: KeyboardEvent) => { if (viewActive.current && e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) { e.preventDefault(); setPicked(null); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [picked]);
  // ⌘F (dispatched by the app's shortcut handler) opens the in-chat search bar.
  useEffect(() => {
    const open = () => { if (viewActive.current) { setView('chat'); setSearching(true); } };
    window.addEventListener('vibe:chat-search', open);
    return () => window.removeEventListener('vibe:chat-search', open);
  }, []);
  useEffect(() => { setSearching(false); }, [session?.id]);

  const { top, childrenOf } = useMemo(() => {
    const childrenOf = new Map<string, ChatItem[]>();
    const top: ChatItem[] = [];
    for (const it of session?.items ?? []) {
      const parent = (it.kind === 'assistant' || it.kind === 'tool') ? it.parent : null;
      if (parent) { const l = childrenOf.get(parent) ?? []; l.push(it); childrenOf.set(parent, l); }
      else top.push(it);
    }
    return { top, childrenOf };
  }, [session?.items]);
  const latestVerify = useMemo(() => { const items = session?.items ?? []; for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'verify') return items[i].id; return undefined; }, [session?.items]);

  const scrollToBottom = () => {
    const el = scroller.current; if (!el) return;
    programmatic.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => { programmatic.current = false; });
  };
  // Follow content growth (streaming text, images, expanding cards) while stuck to the bottom.
  useEffect(() => {
    const el = content.current; if (!el) return;
    const ro = new ResizeObserver(() => { if (stick.current) scrollToBottom(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [session?.id]);
  useEffect(() => { if (stick.current) scrollToBottom(); }, [session?.items]);
  useEffect(() => { stick.current = true; setAtBottom(true); scrollToBottom(); }, [session?.id]);
  // 1s tick for the elapsed counter in the activity line.
  useEffect(() => {
    if (!session?.turnStartedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session?.turnStartedAt]);

  if (!session) return <StartScreen cwd={cwd} scope={scope} onStart={onStart} onStartPair={onStartPair} backlog={backlog} onBacklogChange={onBacklogChange} onOpenBacklogSession={onOpenBacklogSession} openWorktrees={openWorktrees} onOpenWorktree={onOpenWorktree} />;

  const running = session.status === 'running' || session.status === 'compacting';
  const close = () => {
    if (running && !window.confirm(t('chat.confirmCloseRunning'))) return;
    onClose();
  };
  // Undo file changes from a user message on: preview with a dry run, confirm with the file list, then restore.
  const canRewind = !!onRewind && session.agent === 'claude' && !running && session.status !== 'closed';
  const rewind = async (messageId: string) => {
    if (!onRewind) return;
    const dry = await onRewind(messageId, true);
    if (!dry.canRewind) { window.alert(t('rewind.unavailable', { reason: dry.error ?? '' })); return; }
    const files = dry.filesChanged ?? [];
    if (!files.length) { window.alert(t('rewind.nothing')); return; }
    // macOS reports /tmp and /var through /private; compare without it so paths show relative to the project.
    const strip = (p: string) => p.replace(/^\/private(?=\/(?:tmp|var)\/)/, '');
    const base = strip(session.cwd).replace(/\/$/, '') + '/';
    const rel = (p: string) => (strip(p).startsWith(base) ? strip(p).slice(base.length) : p);
    const list = files.slice(0, 12).map((f) => `• ${rel(f)}`).join('\n') + (files.length > 12 ? `\n… +${files.length - 12}` : '');
    if (!window.confirm(t('rewind.confirm', { n: files.length, ins: dry.insertions ?? 0, del: dry.deletions ?? 0, files: list }))) return;
    const done = await onRewind(messageId, false);
    if (!done.canRewind) window.alert(t('rewind.failed', { reason: done.error ?? '' }));
  };
  const jump = () => { stick.current = true; setAtBottom(true); scrollToBottom(); };
  // Blocks worth picking by default: the conversation itself, not tool calls or status lines.
  const exportable = top.filter((it) => !(it.kind === 'assistant' && it.streaming && !it.text) && !(it.kind === 'user' && isInjected(it)));
  const chatOnly = () => new Set(exportable.filter((it) => it.kind === 'user' || it.kind === 'assistant').map((it) => it.id));
  const startExport = () => { setSearching(false); switchView('chat'); setPicked(chatOnly()); };
  // Plan view -> the item in the chat, briefly outlined.
  const showInChat = (id: string) => {
    switchView('chat');
    stick.current = false; setAtBottom(false);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = content.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('item-flash');
      window.setTimeout(() => el.classList.remove('item-flash'), 1600);
    }));
  };
  // A checklist in the chat -> its turn in the plan view.
  const showInPlan = (todoId: string) => {
    let turn: string | null = null;
    for (const it of top) {
      if (it.kind === 'user' && !isInjected(it)) turn = it.id;
      else if (!turn) turn = `pre-${it.id}`;
      if (it.id === todoId) break;
    }
    setFocusTurn(turn);
    switchView('plan');
  };
  const togglePick = (id: string) => setPicked((p) => { if (!p) return p; const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const runExport = async () => {
    if (!picked || !picked.size || exporting) return;
    setExporting(true);
    try {
      const title = displayTitle(session, 80) ?? session.cwd.split('/').pop() ?? 'session';
      const name = exportFileName(title);
      const agent = session.agent === 'codex' ? 'Codex' : 'Claude';
      const { markdown, images } = exportMarkdown(session.items, picked, { title, agent, cwd: session.cwd, date: new Date().toISOString().slice(0, 10), includeThinking: withThinking });
      const dir = session.worktree?.origin ?? session.cwd;
      let saved: string; let missing = 0;
      if (window.vibe?.saveDialog) {
        if (!images.length) {
          const target = await window.vibe.saveDialog({ defaultPath: `${dir}/${name}.md`, ext: 'md', label: 'Markdown' });
          if (!target) return;
          await api.saveText(target, markdown, { baseMtime: null, bom: false, force: true });
          saved = target;
        } else {
          const target = await window.vibe.saveDialog({ defaultPath: `${dir}/${name}.zip`, ext: 'zip', label: 'ZIP' });
          if (!target) return;
          const res = await api.exportZip(target, name, markdown, images);
          saved = res.path; missing = res.missing.length;
        }
      } else {
        let blob: Blob; let file: string;
        if (!images.length) { blob = new Blob([markdown], { type: 'text/markdown' }); file = `${name}.md`; }
        else { const res = await api.exportZipBlob(name, markdown, images); blob = res.blob; missing = res.missing; file = `${name}.zip`; }
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        saved = file;
      }
      toast(missing ? t('export.savedMissing', { path: saved, n: missing }) : t('export.saved', { path: saved }));
      setPicked(null);
    } catch (err) {
      toast(t('export.failed', { reason: (err as Error).message }), 'error');
    } finally {
      setExporting(false);
    }
  };
  // Bring the tool card that started a subagent into view (from the task relation graph).
  const showToolCard = (toolUseId: string) => {
    const el = content.current?.querySelector<HTMLElement>(`[data-tool-use="${CSS.escape(toolUseId)}"]`);
    if (!el) return;
    stick.current = false; setAtBottom(false);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('ring-2', 'ring-violet-400/60');
    setTimeout(() => el.classList.remove('ring-2', 'ring-violet-400/60'), 1800);
  };
  const onScroll = () => {
    if (programmatic.current) return;
    const el = scroller.current; if (!el) return;
    const b = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stick.current = b; setAtBottom(b);
  };
  const onWheel = (e: React.WheelEvent) => { if (e.deltaY < 0 && scroller.current && scroller.current.scrollHeight > scroller.current.clientHeight) { stick.current = false; setAtBottom(false); } };

  // What the agent is doing right now, for the CLI-style status line.
  const activity = (() => {
    if (!running) return null;
    if (session.status === 'compacting') return t('activity.compacting');
    const items = session.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'user') break;
      if (it.kind === 'approval' && !it.decision) return t('activity.waitingApproval');
      if (it.kind === 'question' && !it.resolved) return t('activity.waitingAnswer');
    }
    const openTool = [...items].reverse().find((it) => it.kind === 'tool' && !it.done) as Extract<ChatItem, { kind: 'tool' }> | undefined;
    if (openTool) {
      const isSub = ['Agent', 'Task', 'SubAgent'].includes(openTool.name);
      const detail = (() => { const i = (openTool.input ?? {}) as Record<string, unknown>; const v = i.command ?? i.file_path ?? i.pattern ?? i.query ?? i.description ?? ''; return String(v).split('\n')[0].slice(0, 60); })();
      return `${isSub ? t('activity.subagent') : t('activity.running', { tool: openTool.name })}${detail ? ` · ${detail}` : ''}`;
    }
    const last = items[items.length - 1];
    if (last?.kind === 'assistant' && last.streaming && !last.text) return t('activity.thinking');
    return t('activity.working');
  })();
  const elapsed = session.turnStartedAt ? Math.max(0, Math.round((now - session.turnStartedAt) / 1000)) : 0;
  const elapsedLabel = t(elapsed >= 3600 ? 'activity.elapsedHours' : elapsed >= 60 ? 'activity.elapsedMinutes' : 'activity.elapsedSeconds', {
    hours: Math.floor(elapsed / 3600),
    minutes: Math.floor(elapsed / 60) % 60,
    seconds: elapsed % 60,
  });

  return (
    <div className="h-full flex flex-col min-w-0">
      <div className="@container h-10 shrink-0 flex items-center gap-3 px-4 border-b border-white/10 text-xs whitespace-nowrap">
        <span className={`w-2 h-2 rounded-full ${running ? 'bg-amber-400 animate-pulse' : session.status === 'closed' ? 'bg-zinc-600' : 'bg-emerald-400'}`} />
        <AgentIcon agent={session.agent} size={16} />
        <span className="font-medium text-zinc-200">{session.agent === 'codex' ? 'Codex' : 'Claude'}</span>
        <ModelSelect agent={session.agent} value={session.model ?? null} onChange={onModel} compact />
        <div className="shrink-0 flex items-center rounded-full bg-black/20 border border-line p-0.5" title={t('plan.view.hint')}>
          {(['chat', 'plan'] as const).map((v) => (
            <button key={v} onClick={() => { setFocusTurn(null); switchView(v); }}
              className={`h-6 px-2.5 rounded-full text-[11px] transition-colors duration-150 ${view === v ? 'bg-selected text-on-selected' : 'text-zinc-300 hover:text-white'}`}>
              {t(`plan.view.${v}`)}
            </button>
          ))}
        </div>
        <span className="text-zinc-500 truncate min-w-0 @max-[560px]:hidden" title={session.cwd}>{session.cwd.split('/').slice(-2).join('/')}</span>
        {session.worktree && <WorktreeChip info={session.worktree} running={running} othersUsing={worktreeUsers} onFinished={onClose} commitTitle={displayTitle(session, 60) ?? session.worktree.branch}
          partner={partner && partner.worktree ? { id: partner.id, agent: partner.agent, worktree: partner.worktree, running: partner.status === 'running' } : undefined}
          onFocusPartner={onFocusPartner} onClosePartner={onClosePartner} />}
        {session.status === 'compacting' && <span className="text-amber-300">{t('chat.compacting')}</span>}
        <div className="flex-1" />
        {onCrossReview && <button onClick={() => onCrossReview()} className="shrink-0 flex items-center gap-1 rounded-md px-1.5 py-1 text-zinc-500 hover:text-zinc-200 hover:bg-white/5" title={t('review.headerHint', { agent: session.agent === 'claude' ? 'Codex' : 'Claude' })}>
          <Icon name="sparkle" size={13} /><span className="@max-[600px]:hidden">{t('review.short')}</span>
        </button>}
        {onVerify && session.cwd && <VerifyButton cwd={session.worktree?.origin ?? session.cwd} running={running} onRun={onVerify} />}
        <button onClick={() => (picked ? setPicked(null) : startExport())} className={`shrink-0 flex items-center justify-center w-7 h-7 rounded-full hover:bg-white/5 ${picked ? 'text-sky-300 bg-white/10' : 'text-zinc-500 hover:text-zinc-200'} transition-colors`} title={t('export.button')}><Icon name="download" size={14} /></button>
        {session.agentSessionId && <button className="text-zinc-600 hover:text-zinc-300" title={t('chat.copySessionIdTitle', { id: session.agentSessionId })} onClick={() => navigator.clipboard.writeText(session.agentSessionId!)}>id</button>}
        {session.agent === 'claude' && <span className="text-zinc-500 @max-[440px]:hidden">${session.totalCostUsd.toFixed(3)}</span>}
        <button className="w-7 h-7 -mr-2 shrink-0 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors" onClick={close} title={t('chat.closeSession')}><Icon name="close" /></button>
      </div>
      {picked && (
        <div className="shrink-0 border-b border-sky-400/20 bg-sky-500/[0.06] px-4 py-2 text-xs text-zinc-300 space-y-1">
          <div className="flex items-center gap-2 whitespace-nowrap">
            <span className="text-zinc-400">{t('export.selected', { n: picked.size, total: exportable.length })}</span>
            <span className="text-zinc-600">·</span>
            <button className="hover:text-white" onClick={() => setPicked(new Set(exportable.map((it) => it.id)))}>{t('export.all')}</button>
            <button className="hover:text-white" onClick={() => setPicked(new Set())}>{t('export.none')}</button>
            <button className="hover:text-white" onClick={() => setPicked(chatOnly())}>{t('export.chatOnly')}</button>
            <span className="text-zinc-600">·</span>
            <label className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={withThinking} onChange={(e) => setWithThinking(e.target.checked)} />{t('export.thinking')}</label>
            <span className="flex-1" />
            <button disabled={!picked.size || exporting} onClick={runExport} className="rounded-md bg-sky-500/30 hover:bg-sky-500/40 disabled:opacity-40 px-2.5 py-1 text-sky-50">{t('export.save')}</button>
            <button onClick={() => setPicked(null)} className="rounded-full bg-fill-2 hover:bg-fill-3 transition-colors px-2.5 py-1">{t('export.cancel')}</button>
          </div>
          <div className="text-zinc-500 whitespace-normal">{t('export.hint')}</div>
        </div>
      )}
      <div className="flex-1 min-h-0 relative">
        {view === 'plan' && <PlanView items={session.items} running={running} cwd={session.cwd} focusTurn={focusTurn} onJump={showInChat} onApprove={onApprove} onAnswer={onAnswer} />}
        {searching && view === 'chat' && <ChatSearch content={content} scroller={scroller} version={session.items} onClose={() => setSearching(false)}
          onJump={() => { stick.current = false; setAtBottom(false); }} />}
        {/* Kept mounted under the plan view so switching back keeps its place. */}
        <div ref={scroller} className={`absolute inset-0 overflow-y-auto ${view === 'plan' ? 'invisible' : ''}`} onScroll={onScroll} onWheel={onWheel}>
          <div ref={content} className="px-5 py-4 space-y-3">
            {session.resumed && <ResumeBrief session={session} />}
            {top.length === 0 && <div className="text-center text-zinc-600 text-sm py-10">{session.restoring ? t('chat.restoring') : session.status === 'starting' ? t('chat.starting') : t('chat.firstMessage')}</div>}
            {top.map((it) => {
              const node = renderItem(it, childrenOf, { showPlan: picked ? undefined : showInPlan, approve: onApprove, answer: onAnswer, cwd: session.cwd, rewind: canRewind ? rewind : undefined, latestVerify, verify: running ? undefined : onVerify, review: onCrossReview, otherAgent: session.agent === 'claude' ? 'Codex' : 'Claude' });
              if (!picked) return <div key={it.id} data-item-id={it.id}>{node}</div>;
              const on = picked.has(it.id);
              // In export mode a click anywhere on a block toggles it; the block's own buttons are inert meanwhile.
              return (
                <div key={it.id} className="flex items-start gap-2">
                  <input type="checkbox" checked={on} onChange={() => togglePick(it.id)} className="mt-2 shrink-0 accent-sky-400" />
                  <div className={`flex-1 min-w-0 cursor-pointer rounded-lg transition-opacity ${on ? '' : 'opacity-40'}`} onClickCapture={(e) => { e.preventDefault(); e.stopPropagation(); togglePick(it.id); }}>{node}</div>
                </div>
              );
            })}
          </div>
        </div>
        {!atBottom && view === 'chat' && (
          <button onClick={jump} className="absolute bottom-3 left-1/2 -translate-x-1/2 glass-pop pop-in !rounded-full px-3.5 py-1.5 text-xs text-zinc-200 hover:text-white">{t('chat.jumpLatest')}</button>
        )}
      </div>
      {activity && (
        <div className="h-7 shrink-0 flex items-center gap-2 px-4 text-[11px] text-zinc-400 border-t border-line bg-black/15">
          <span className="inline-block w-3 h-3 rounded-full border-2 border-amber-400/70 border-t-transparent animate-spin" />
          <span className="shrink-0 whitespace-nowrap text-zinc-600 tabular-nums">{elapsedLabel}</span>
          <span className="truncate">{activity}</span>
        </div>
      )}
      {onHandoff && <LimitBanner agent={session.agent} sessionId={session.id} onHandoff={onHandoff} />}
      <TodoPanel todos={currentTodos(session)} running={running} />
      <Composer key={session.id} draftKey={session.id} cwd={session.cwd} agent={session.agent} disabled={session.status === 'closed'} running={running} mode={session.permissionMode} commands={session.commands}
        onSend={(text, atts) => { stick.current = true; setAtBottom(true); onSend(text, atts); requestAnimationFrame(scrollToBottom); }}
        onStop={onInterrupt} onMode={onMode} pendingAttachments={pendingAttachments} onConsumeAttachments={onConsumeAttachments}
        background={background} onFocusSession={onFocusSession}
        tasks={session.tasks} taskRootLabel={displayTitle(session, 24) ?? (session.agent === 'codex' ? 'Codex' : 'Claude')} taskRootSub={session.agentSessionId?.slice(0, 8)} onShowTaskCard={showToolCard} onStopTask={session.agent === 'claude' ? onStopTask : undefined} />
    </div>
  );
}
