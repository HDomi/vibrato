import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { backgroundState, displayTitle, inProject, pendingRequests, sortSessions, type ChatSession } from './lib/chatStore';
import { api, ApiError, type Entry, type Favorites, type HomeInfo, type Listing, type RecentSession, type ScheduleRun } from './lib/api';
import { agentClient, type Attachment } from './lib/agent';
import { openTerminal, reconnectTerminals, terminalsBusy } from './lib/terminals';
import { keepAwakeEnabled, workInProgress } from './lib/power';
import { lockSummary } from './lib/lockScreen';
import { requestNotificationPermission, useSessions, setOnScreenSession } from './lib/useSessions';
import Dock from './components/Dock';
import FileList from './components/FileList';
import Preview, { PreviewDialog } from './components/Preview';
import ToolsPanel from './components/ToolsPanel';
import UsageBar, { VIEW_ORDER, type ViewMode } from './components/UsageBar';
import { useScheduleWatch } from './lib/scheduleWatch';
import ChatPanel, { type PairOptions, type StartOptions } from './components/ChatPanel';
import type { BackgroundSession } from './components/Composer';
import TerminalPanel from './components/TerminalPanel';
import GitPanel from './components/GitPanel';
import RunPanel from './components/RunPanel';
import Splitter, { SideSplitter, usePaneWidth } from './components/Splitter';
import { ContextMenuProvider, useContextMenu, type MenuItem } from './components/ContextMenu';
import QuickOpen from './components/QuickOpen';
import { t, useLang } from './lib/i18n';
import { fencedTerminalText } from './lib/textSearch';
import { handoffText } from './lib/handoff';
import { draftKey, writeDraft } from './lib/draft';
import { hasTransfer, readTransfer, sendTransfer, setTransferTargets } from './lib/transfer';
import AgentIcon from './components/AgentIcon';
import Lightbox from './components/Lightbox';
import Toaster, { toast } from './components/Toast';
import BacklogPanel from './components/BacklogPanel';
import AgentContextDialog from './components/AgentContextDialog';
import { EMPTY_BACKLOG, useBacklogs } from './lib/backlog';
import Icon, { type IconName } from './components/Icon';
import { IDE_CHANNEL, openIde, type IdeMessage } from './lib/ide';
import { ViewActiveContext } from './lib/viewActive';
import { shortcutKey } from './lib/keys';

// The toolbox and schedules load the first time their view is shown.
const ToolboxView = lazy(() => import('./components/toolbox/ToolboxView'));
const ScheduleView = lazy(() => import('./components/ScheduleView'));

const LS_CWD = 'vibe.cwd';
const LS_PROJECT = 'vibe.project';
const LS_RIGHT = 'vibe.right.collapsed';
// v2: the old 'ide' value meant today's VIBE mode. The IDE now has its own window, so a stored 'ide' means VIBE too.
const LS_MODE = 'vibe.mode.view.v2';
const LS_MODE_V1 = 'vibe.mode.view';
const LS_ACTIVE_SESSION = 'vibe.active.session';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i;

/**
 * A hidden (kept-alive) view does not re-render with the app: while streaming, the app re-renders on every
 * token, and the views behind other tabs would redo their whole tree each time. It catches up when shown.
 */
const Freeze = memo(function Freeze({ children }: { active: boolean; children: ReactNode }) {
  return <>{children}</>;
}, (prev, next) => !prev.active && !next.active);

export default function App() {
  return (
    <ContextMenuProvider>
      <AppInner />
    </ContextMenuProvider>
  );
}

function AppInner() {
  useLang();
  const menu = useContextMenu();
  const [home, setHome] = useState<HomeInfo | null>(null);
  const [favorites, setFavorites] = useState<Favorites>({ favorites: [], groups: [] });
  const [recent, setRecent] = useState<string[]>([]);
  const [cwd, setCwd] = useState<string>(() => { try { return localStorage.getItem(LS_CWD) || '~'; } catch { return '~'; } });
  const [project, setProject] = useState<string | null>(() => { try { return localStorage.getItem(LS_PROJECT); } catch { return null; } });
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [toolsFocusLock, setToolsFocusLock] = useState(false);
  const [rightTab, setRightTab] = useState<'files' | 'preview' | 'terminal' | 'git' | 'run'>('files');
  const [runStatus, setRunStatus] = useState({ running: 0, errors: false });
  // Remembered so an update/relaunch comes back to the tab that was on screen, not the new-session view.
  const [activeSession, setActiveSession] = useState<string | 'new' | null>(() => { try { return localStorage.getItem(LS_ACTIVE_SESSION); } catch { return null; } });
  const [rightCollapsed, setRightCollapsed] = useState(() => { try { return localStorage.getItem(LS_RIGHT) === '1'; } catch { return false; } });
  const [dragging, setDragging] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const [quickOpen, setQuickOpen] = useState(false);
  const [view, setViewState] = useState<ViewMode>(() => {
    try {
      const v = localStorage.getItem(LS_MODE) || (localStorage.getItem(LS_MODE_V1) === 'agent' ? 'agent' : 'vibe');
      return VIEW_ORDER.includes(v as ViewMode) ? v as ViewMode : 'vibe';
    } catch { return 'vibe'; }
  });
  // Views slide in from the side of the tab that was picked (left of the old one: from the left).
  const [slide, setSlide] = useState<'left' | 'right'>('right');
  const [mountedViews, setMountedViews] = useState<Set<ViewMode>>(() => new Set([view]));
  const viewEls = useRef<Partial<Record<ViewMode, HTMLDivElement | null>>>({});
  const viewRef = useRef(view);
  viewRef.current = view;
  const setView = useCallback((v: ViewMode) => {
    if (v === viewRef.current) return;
    setSlide(VIEW_ORDER.indexOf(v) > VIEW_ORDER.indexOf(viewRef.current) ? 'right' : 'left');
    setMountedViews((m) => (m.has(v) ? m : new Set(m).add(v)));
    setViewState(v);
  }, []);
  // The slide moves `left` (a transform would misalign the glass with the wallpaper) and stays within the page
  // padding: Chromium does not repaint the fixed background of glass that started partly off screen.
  const firstView = useRef(true);
  useLayoutEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    const el = viewEls.current[view];
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timing = { duration: 260, easing: 'cubic-bezier(.2, .8, .2, 1)' };
    el.animate([{ left: `${slide === 'right' ? 16 : -16}px`, opacity: 0.55 }, { left: '0px', opacity: 1 }], timing);
    // Repaint the glass every frame of the slide so its fixed wallpaper copy stays lined up (see --glass-nudge in index.css).
    for (const g of el.querySelectorAll<HTMLElement>('.glass, .glass-fill')) g.animate([{ '--glass-nudge': 0 }, { '--glass-nudge': 1 }], timing);
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  // Mount the other views (hidden) shortly after start, so even their first visit has nothing left to load.
  useEffect(() => {
    const id = window.setTimeout(() => setMountedViews(new Set(VIEW_ORDER)), 1500);
    return () => window.clearTimeout(id);
  }, []);
  const [agentActive, setAgentActive] = useState<string | 'new' | null>(null);
  useEffect(() => { try { localStorage.setItem(LS_MODE, view); } catch { /* ignore */ } }, [view]);
  useEffect(() => { try { activeSession ? localStorage.setItem(LS_ACTIVE_SESSION, activeSession) : localStorage.removeItem(LS_ACTIVE_SESSION); } catch { /* ignore */ } }, [activeSession]);
  const right = usePaneWidth('vibe.w.right', 420, 280, 1200);
  const S = useSessions();
  const B = useBacklogs(S);
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  useEffect(() => { const h = () => setContextOpen(true); window.addEventListener('vibe:agent-context', h); return () => window.removeEventListener('vibe:agent-context', h); }, []);
  const backlogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!backlogOpen) return;
    const away = (e: MouseEvent) => { if (!backlogRef.current?.contains(e.target as Node)) setBacklogOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) setBacklogOpen(false); };
    window.addEventListener('mousedown', away); window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, [backlogOpen]);
  // A session revived after a server restart gets a new id; keep it selected.
  useEffect(() => {
    if (activeSession && S.replaced[activeSession]) setActiveSession(S.replaced[activeSession]);
    if (agentActive && S.replaced[agentActive]) setAgentActive(S.replaced[agentActive]);
  }, [S.replaced, activeSession, agentActive]);

  useEffect(() => {
    api.home().then(setHome).catch(() => {});
    api.favorites().then(setFavorites).catch(() => {});
    api.recent().then(setRecent).catch(() => {});
  }, []);
  useEffect(() => { try { localStorage.setItem(LS_RIGHT, rightCollapsed ? '1' : '0'); } catch { /* ignore */ } }, [rightCollapsed]);
  const paneTransition = dragging ? '' : 'transition-[width] duration-250 ease-[cubic-bezier(.2,.8,.2,1)]';

  useEffect(() => {
    let alive = true;
    api.list(cwd).then((l) => {
      if (!alive) return;
      setListing(l); setError(null);
      try { localStorage.setItem(LS_CWD, l.path); } catch { /* ignore */ }
    }).catch((e: ApiError) => { if (alive) setError({ code: e.code ?? 'ERR', message: e.message }); });
    return () => { alive = false; };
  }, [cwd, refreshTick]);
  // Live refresh: the server watches the folder on screen and nudges us when its contents change.
  useEffect(() => {
    if (!listing?.path) return;
    const es = new EventSource(api.fsWatchUrl(listing.path));
    es.addEventListener('change', () => setRefreshTick((t) => t + 1));
    return () => es.close();
  }, [listing?.path]);

  useEffect(() => { try { project ? localStorage.setItem(LS_PROJECT, project) : localStorage.removeItem(LS_PROJECT); } catch { /* ignore */ } }, [project]);
  useEffect(() => { const h = () => requestNotificationPermission(); window.addEventListener('click', h, { once: true }); return () => window.removeEventListener('click', h); }, []);

  const projectSessions = sortSessions(Object.values(S.sessions).filter((s) => inProject(s, project)));
  const session = activeSession === 'new' ? null
    : (activeSession && S.sessions[activeSession] && inProject(S.sessions[activeSession], project) ? S.sessions[activeSession] : projectSessions[0]) ?? null;
  const projectBacklog = (project && B.backlogs[project]) || EMPTY_BACKLOG;
  const backlogTodo = projectBacklog.items.filter((i) => i.status === 'todo' || i.status === 'running').length;
  // A worktree session's files, terminal, Git and Run panels follow its own folder.
  const panelRoot = session?.worktree ? session.cwd : project;

  const navigate = useCallback((p: string) => { setCwd(p); setSelected(null); }, []);
  // Local file links inside markdown (chat or preview) open in the Preview tab.
  // Views without the right-hand panel (Agents, Tools, Schedules, IDE without a project) show files in a dialog.
  const [previewPopup, setPreviewPopup] = useState<Entry | null>(null);
  useEffect(() => {
    const h = (ev: Event) => {
      const path = (ev as CustomEvent<{ path: string }>).detail?.path;
      if (!path) return;
      api.stat(path).then((e) => {
        if (e.isDir) {
          navigate(e.path);
          if (view !== 'vibe') { setPreviewPopup(null); setView('vibe'); }
          setRightTab('files'); setRightCollapsed(false);
        } else if (view === 'vibe') { setSelected(e); setRightTab('preview'); setRightCollapsed(false); }
        else setPreviewPopup(e);
      }).catch(() => toast(t('preview.openFailed', { path }), 'error'));
    };
    window.addEventListener('vibe:open-file', h);
    return () => window.removeEventListener('vibe:open-file', h);
  }, [navigate, view, project, setView]);
  useEffect(() => { setPreviewPopup(null); }, [view]);
  const openProject = useCallback((p: string) => {
    setProject(p); navigate(p); setActiveSession(null);
    api.pushRecent(p).then(setRecent).catch(() => {});
  }, [navigate]);
  // Notifications are skipped for the session on screen while the window is focused.
  useEffect(() => { setOnScreenSession(view === 'agent' ? (agentActive && agentActive !== 'new' ? agentActive : null) : (session?.id ?? null)); }, [view, agentActive, session?.id]);
  // Dock badges: sessions whose turn ended while their project was not on screen stay "done, unseen" until it is opened.
  const [unseen, setUnseen] = useState<Set<string>>(() => new Set());
  const lastStatus = useRef<Record<string, ChatSession['status']>>({});
  const shownProject = view === 'vibe' ? project : null;
  useEffect(() => {
    const ended: string[] = [];
    for (const s of Object.values(S.sessions)) {
      const before = lastStatus.current[s.id];
      if ((before === 'running' || before === 'compacting') && s.status === 'idle' && !inProject(s, shownProject)) ended.push(s.id);
      lastStatus.current[s.id] = s.status;
    }
    if (ended.length) setUnseen((u) => new Set([...u, ...ended]));
  }, [S.sessions, shownProject]);
  useEffect(() => {
    if (!shownProject) return;
    setUnseen((u) => {
      const left = [...u].filter((id) => { const s = S.sessions[id]; return s && !inProject(s, shownProject); });
      return left.length === u.size ? u : new Set(left);
    });
  }, [shownProject, unseen, S.sessions]);
  // Clicking a notification brings its session on screen in whichever view is active.
  const focusSession = useRef<(id: string) => void>(() => {});
  const approveRef = useRef<(sessionId: string, requestId: string, decision: 'allow' | 'allow_always' | 'deny') => void>(() => {});
  approveRef.current = S.approve;
  focusSession.current = (id: string) => {
    if (id.startsWith('schedule:')) { const run = scheduleRuns.current.get(id.slice(9)); if (run) openRun(run); return; }
    const s = S.sessions[id];
    if (!s) return;
    // The Agent view lists home-folder sessions only; a project session opens in VIBE.
    if (view === 'agent' && s.cwd === home?.home) setAgentActive(id);
    else { if (view === 'agent') setView('vibe'); if (!inProject(s, project)) openProject(s.worktree?.origin ?? s.cwd); setActiveSession(id); }
  };
  // Sessions a message can be sent to (right-click / drag): every open one except the one on screen.
  const onScreenId = view === 'agent' ? (agentActive && agentActive !== 'new' ? agentActive : null) : (session?.id ?? null);
  setTransferTargets(() => sortSessions(Object.values(S.sessions)).filter((s) => s.id !== onScreenId && s.status !== 'closed')
    .map((s) => ({ id: s.id, agent: s.agent, name: `${displayTitle(s, 28) ?? t('common.new')} · ${(s.worktree?.origin ?? s.cwd).split('/').pop()}` })));
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [renamingTab, setRenamingTab] = useState<string | null>(null);
  const dropProps = (id: string) => ({
    onDragOver: (e: React.DragEvent) => { if (hasTransfer(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (dropTarget !== id) setDropTarget(id); } },
    onDragLeave: () => setDropTarget((d) => (d === id ? null : d)),
    onDrop: (e: React.DragEvent) => { if (!hasTransfer(e)) return; e.preventDefault(); setDropTarget(null); const p = readTransfer(e); if (p) sendTransfer(id, p); },
  });
  useEffect(() => {
    const h = (ev: Event) => { const id = (ev as CustomEvent<{ sessionId: string }>).detail?.sessionId; if (id) focusSession.current(id); };
    window.addEventListener('vibe:notify-click', h);
    window.addEventListener('vibe:transfer-done', h);
    window.vibe?.onNotificationClick?.((id) => focusSession.current(id));
    window.vibe?.onNotificationApproval?.(({ sessionId, requestId, decision }) => approveRef.current(sessionId, requestId, decision));
    // Waking from sleep: reconnect the agent socket (re-attaches every live session) and the shells at once.
    window.vibe?.onPowerResume?.(() => { agentClient.reconnectNow(); reconnectTerminals(); });
    return () => { window.removeEventListener('vibe:notify-click', h); window.removeEventListener('vibe:transfer-done', h); };
  }, []);
  // Keep the Mac awake only while an agent turn or a busy shell is in flight; re-evaluated on session changes and every 10s for shells.
  const sessionsForPower = useRef(S.sessions);
  sessionsForPower.current = S.sessions;
  useEffect(() => {
    if (!window.vibe?.keepAwake) return;
    let last: boolean | null = null;
    const update = () => {
      const busy = keepAwakeEnabled() && workInProgress(Object.values(sessionsForPower.current), terminalsBusy());
      if (busy !== last) { last = busy; window.vibe!.keepAwake!(busy); }
    };
    update();
    const timer = window.setInterval(update, 10000);
    window.addEventListener('vibe:keep-awake', update);
    return () => { window.clearInterval(timer); window.removeEventListener('vibe:keep-awake', update); window.vibe!.keepAwake!(false); };
  }, []);
  useEffect(() => { window.dispatchEvent(new Event('vibe:keep-awake')); }, [S.sessions]);
  // Lock screen: per-agent session counts for the cover windows (no titles), and the menu's "Lock Screen Settings…".
  const lastLockSummary = useRef('');
  useEffect(() => {
    if (!window.vibe?.lock) return;
    const list = lockSummary(Object.values(S.sessions));
    const key = JSON.stringify(list);
    if (key !== lastLockSummary.current) { lastLockSummary.current = key; window.vibe.lock.reportSessions(list); }
  }, [S.sessions]);
  useEffect(() => window.vibe?.lock?.onOpenSettings(() => { setToolsFocusLock(true); setShowTools(true); }), []);
  // A built-in Claude command the SDK cannot show (/plugin, /hooks, ...) runs in a terminal tab of the right panel.
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ cwd: string; cmd: string; title: string; handled: boolean }>).detail;
      openTerminal(d.cwd, d.cmd, d.title);
      // The Agent view has no right panel: the terminal lives in the project view.
      setView('vibe'); setRightTab('terminal'); setRightCollapsed(false);
      d.handled = true;
    };
    window.addEventListener('vibe:run-in-terminal', h);
    return () => window.removeEventListener('vibe:run-in-terminal', h);
  }, [setView]);
  const [toolsFocusForms, setToolsFocusForms] = useState(false);
  // The prompt form's "Edit types" opens Settings at the form type editor.
  useEffect(() => {
    const h = () => { setToolsFocusForms(true); setShowTools(true); };
    window.addEventListener('vibe:open-settings', h);
    return () => window.removeEventListener('vibe:open-settings', h);
  }, []);

  const isFavorite = !!listing && favorites.favorites.some((f) => f.path === listing.path);
  const toggleFavorite = () => {
    if (!listing) return;
    (isFavorite ? api.removeFavorite(listing.path) : api.addFavorite(listing.path)).then(setFavorites).catch(() => {});
  };
  const pickFolder = async () => {
    if (window.vibe?.pickFolder) { const p = await window.vibe.pickFolder(); if (p) openProject(p); }
    else { const p = window.prompt(t('app.folderPathPrompt'), listing?.path ?? '~'); if (p) openProject(p); }
  };
  const start = async (c: string, o?: StartOptions) => {
    try {
      if (o?.isolate) {
        const wt = await api.worktreeCreate(c, o.isolate.branch);
        setActiveSession(await S.start(wt.path, { ...o, worktree: { ...wt, origin: c } }));
      } else setActiveSession(await S.start(c, o));
    } catch (e) { window.alert((e as Error).message); }
  };
  // Compare mode: one prompt, Claude and Codex each in a worktree of their own (created one after the other: git locks).
  const startPair = async (c: string, o: PairOptions) => {
    try {
      const d = new Date();
      const base = o.branch || `vs/${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
      const pairKey = crypto.randomUUID();
      const title = o.prompt.split('\n')[0].slice(0, 40);
      const ids: string[] = [];
      for (const agent of ['claude', 'codex'] as const) {
        const wt = await api.worktreeCreate(c, `${base}-${agent}`);
        const id = await S.start(wt.path, { agent, permissionMode: agent === 'codex' && o.permissionMode === 'auto' ? 'default' : o.permissionMode, model: o.models[agent], worktree: { ...wt, origin: c }, pairKey, title });
        ids.push(id);
      }
      for (const id of ids) S.send(id, o.prompt, []);
      setActiveSession(ids[0]);
    } catch (e) { window.alert((e as Error).message); }
  };
  const partnerOf = (s: ChatSession | null) => (s?.pairKey ? Object.values(S.sessions).find((x) => x.pairKey === s.pairKey && x.id !== s.id) ?? null : null);
  // Switching to a worktree session shows its folder in the file list; leaving it goes back to the project.
  const lastPanelRoot = useRef(panelRoot);
  useEffect(() => {
    if (panelRoot === lastPanelRoot.current) return;
    const prev = lastPanelRoot.current;
    lastPanelRoot.current = panelRoot;
    if (panelRoot && (cwd === prev || (prev && cwd.startsWith(prev + '/')))) navigate(panelRoot);
  }, [panelRoot, cwd, navigate]);
  const closeSession = (id: string, confirmed = false) => {
    const s = S.sessions[id];
    if (!s) return;
    if (!confirmed && (s.status === 'running' || s.status === 'compacting') && !window.confirm(t('app.confirmCloseRunning'))) return;
    S.close(id);
    if (activeSession === id) setActiveSession(null);
  };
  const resumeSession = (s: RecentSession) => {
    const dir = s.cwd ?? project ?? cwd;
    if (s.cwd && s.cwd !== project) openProject(s.cwd);
    void start(dir, { agent: s.agent, resume: s.sessionId, title: s.title || undefined });
  };
  // A scheduled run's session: attach to it while the server still has it, otherwise resume the conversation.
  const openRun = (r: ScheduleRun) => {
    void (async () => {
      const live = r.sessionId ? (await api.liveSessions().catch(() => [])).some((x) => x.id === r.sessionId) : false;
      setView('vibe');
      if (r.cwd !== project) openProject(r.cwd);
      if (live && r.sessionId) {
        S.adopt({ id: r.sessionId, cwd: r.cwd, agent: r.agent, agentSessionId: r.agentSessionId, title: r.name });
        setActiveSession(r.sessionId);
      } else if (r.agentSessionId) {
        resumeSession({ agent: r.agent, sessionId: r.agentSessionId, title: r.name, cwd: r.cwd, lastModified: r.endedAt ?? r.startedAt });
      }
    })();
  };
  const scheduleRuns = useScheduleWatch();
  const attach = (entries: Entry[]) => {
    setPendingAttachments((prev) => [...prev, ...entries.filter((e) => !e.isDir).map((e) => ({ path: e.path, name: e.name, kind: IMAGE_RE.test(e.name) ? 'image' as const : 'file' as const }))]);
    if (!session && project) setActiveSession(null);
  };
  // "Attach to chat" from an IDE window: show VIBE on that project and queue the files in its composer.
  const attachRef = useRef(attach);
  attachRef.current = attach;
  const ideTarget = useRef({ project, openProject, setView });
  ideTarget.current = { project, openProject, setView };
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(IDE_CHANNEL);
    ch.onmessage = (ev: MessageEvent<IdeMessage>) => {
      const m = ev.data;
      if (m?.kind !== 'attach' || !m.files?.length) return;
      const { project: cur, openProject: open, setView: show } = ideTarget.current;
      show('vibe');
      if (cur !== m.root) open(m.root);
      attachRef.current(m.files.map((f) => ({ path: f.path, name: f.name, isDir: false, size: 0, mtime: 0, ext: '', hidden: false, kind: 'binary' as const })));
      window.focus();
    };
    return () => ch.close();
  }, []);

  const rightTabs = [['files', t('app.tab.files')], ['preview', t('app.tab.preview')], ['terminal', t('app.tab.terminal')], ['git', t('app.tab.git')], ['run', t('app.tab.run')]] as const;
  const TAB_KEYS = ['1', '2', '3', '4', '5'];
  // Global keyboard shortcuts.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (document.querySelector('[data-update-locked="true"]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = shortcutKey(e);
      const inText = (e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]');
      // The editor owns ⌘W (close tab), ⌘/ (toggle comment), ⌘S and ⇧⌘K (delete line) while it has focus.
      const inEditor = !!(e.target as HTMLElement)?.closest?.('[data-editor-scope]');
      if (inEditor && (k === 'w' || k === '/' || k === 's' || k === 'k')) return;
      // Tools mode has no sessions or panels; its own ⌘1-9 switch tools (see ToolboxView). Schedules have none either.
      if (view === 'tools' || view === 'schedule') return;
      if (k === 'p' && !e.shiftKey) { e.preventDefault(); if (project && view === 'vibe') setQuickOpen((v) => !v); }
      else if (k === 'j') { e.preventDefault(); setRightCollapsed((v) => !v); }
      else if (k === 'k') { e.preventDefault(); window.dispatchEvent(new Event('vibe:focus-composer')); }
      else if (k === 'f' && !e.shiftKey && !(e.target as HTMLElement)?.closest?.('[data-own-find]')) { e.preventDefault(); window.dispatchEvent(new Event('vibe:chat-search')); }
      else if (k === 'n' && !e.shiftKey) { e.preventDefault(); if (view === 'agent') setAgentActive('new'); else if (project) setActiveSession('new'); }
      else if (k === 'w') {
        e.preventDefault();
        const target = view === 'agent' ? S.sessions[agentActive ?? ''] : session;
        if (target) {
          if ((target.status === 'running' || target.status === 'compacting') && !window.confirm(t('app.confirmCloseRunning'))) return;
          S.close(target.id);
          if (view === 'agent') setAgentActive(null); else setActiveSession(null);
        }
      }
      else if (k === '/') { e.preventDefault(); setShowTools(true); }
      else if (TAB_KEYS.includes(e.key) && !inText) { e.preventDefault(); setRightTab(rightTabs[Number(e.key) - 1][0]); setRightCollapsed(false); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [project, session, S, view, agentActive]);

  const waiting = Object.values(S.sessions).reduce((n, s) => n + pendingRequests(s), 0);
  // Same element every render: the toolbox takes no props, so React skips it when the app re-renders.
  const toolbox = useMemo(() => <Suspense fallback={null}><ToolboxView /></Suspense>, []);
  /** Per project: 'running' while any of its sessions works, else 'done' if one finished unseen. */
  const projectBadge = (path: string): 'running' | 'done' | null => {
    const mine = Object.values(S.sessions).filter((s) => inProject(s, path));
    if (mine.some((s) => s.status === 'running' || s.status === 'compacting')) return 'running';
    return mine.some((s) => unseen.has(s.id)) ? 'done' : null;
  };
  const tabIcons: Record<typeof rightTabs[number][0], IconName> = { files: 'list', preview: 'file', terminal: 'terminal', git: 'branch', run: 'play' };

  return (
      <div className="app-wall h-full flex flex-col overflow-hidden">
        <Lightbox />
        <Toaster />
        {previewPopup && <PreviewDialog entry={previewPopup} onClose={() => setPreviewPopup(null)} />}
        <UsageBar mode={view} onMode={setView} onPickFolder={pickFolder} onOpenSettings={() => setShowTools(true)} />
        {/* Opened views stay mounted (hidden when another tab is on screen): switching back is instant and keeps their state. */}
        <div className="flex-1 min-h-0 relative">
        {VIEW_ORDER.filter((v) => mountedViews.has(v)).map((v) => (
          <ViewActiveContext.Provider key={v} value={v === view}>
          {/* left-0 + w-full (not inset-0): the slide moves `left` without changing the width. */}
          <div ref={(el) => { viewEls.current[v] = el; }} aria-hidden={v !== view}
            className={`absolute top-0 bottom-0 left-0 w-full flex ${v === view ? '' : 'invisible pointer-events-none'}`}>
          <Freeze active={v === view}>
          {v === 'agent' ? (
          <AgentView home={home?.home ?? '~'} S={S} active={agentActive} setActive={setAgentActive} onFocusSession={(id) => focusSession.current(id)} />
          ) : v === 'tools' ? (
          toolbox
          ) : v === 'schedule' ? (
          <Suspense fallback={null}><ScheduleView defaultCwd={project} projects={[...favorites.favorites.map((f) => f.path), ...recent]} onOpenRun={openRun} /></Suspense>
        ) : (
        <div className="flex-1 min-w-0 flex px-[42px] pb-4">
          <div className="w-[61px] shrink-0 flex items-center">
            <Dock favorites={favorites} project={project} onNavigate={openProject} onFavoritesChange={setFavorites} onResumeSession={resumeSession} waiting={waiting} badge={projectBadge} />
          </div>
          <main className="flex-1 min-w-0 flex ml-8">
            <section className="glass flex-1 min-w-0 flex flex-col overflow-hidden">
              {project && projectSessions.length > 0 && (
                <div className="h-11 shrink-0 flex items-center gap-1 px-2.5 border-b border-line text-xs">
                  {/* Only the tabs scroll; the backlog and new-session buttons stay pinned at the right end. */}
                  <div className="flex-1 min-w-0 h-full flex items-center gap-1 overflow-x-auto no-scrollbar">
                  {projectSessions.map((s) => (
                    <div key={s.id} onClick={() => setActiveSession(s.id)} onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeSession(s.id); } }}
                      onContextMenu={(e) => menu.open(e, sessionMenu(s, { setPinned: S.setPinned, rename: () => setRenamingTab(s.id), close: () => closeSession(s.id), remove: () => deleteSession(s, () => closeSession(s.id, true)) }))} {...(s.id !== session?.id ? dropProps(s.id) : {})}
                      className={`group flex items-center gap-1.5 rounded-full pl-3 pr-1 py-1 whitespace-nowrap cursor-pointer transition-colors duration-150 ${dropTarget === s.id ? 'ring-2 ring-sky-400/70 bg-sky-400/15 text-white' : session?.id === s.id ? 'bg-fill-3 text-white' : 'text-zinc-400 hover:bg-fill'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${s.status === 'running' || s.status === 'compacting' ? 'bg-amber-400 animate-pulse' : s.status === 'closed' ? 'bg-zinc-600' : 'bg-emerald-400'}`} />
                      <AgentIcon agent={s.agent} size={14} />
                      {s.pinned && <span className="text-[9px]" title={t('common.pin')}>📌</span>}
                      {renamingTab === s.id
                        ? <RenameInput s={s} onDone={(v) => { setRenamingTab(null); if (v) S.rename(s.id, v); }} className="w-40 rounded-full bg-black/30 px-2 text-xs text-zinc-100 outline-none border border-white/20" />
                        : <span className={session?.id === s.id ? 'text-zinc-100' : 'text-zinc-300'} title={displayTitle(s, 300) ?? undefined}>{displayTitle(s, 18) ?? t('common.new')}</span>}
                      {s.worktree && <span className="flex items-center gap-0.5 rounded-full bg-violet-400/10 px-1.5 text-[10px] text-violet-200 max-w-28" title={`${s.worktree.branch} · ${s.worktree.path}`}><Icon name="branch" size={10} /><span className="truncate">{s.worktree.branch}</span></span>}
                      <AttentionBadge s={s} />
                      <button className="ml-0.5 w-5 h-5 flex items-center justify-center rounded-full text-zinc-500 hover:text-white hover:bg-white/15 opacity-0 group-hover:opacity-100 transition-opacity" title={t('app.closeSession')}
                        onClick={(e) => { e.stopPropagation(); closeSession(s.id); }}><Icon name="close" size={11} /></button>
                    </div>
                  ))}
                  </div>
                  <div ref={backlogRef} className="relative shrink-0">
                    <button className={`h-7 px-2 flex items-center gap-1 rounded-full hover:bg-fill-2 ${projectBacklog.auto ? 'text-amber-300' : 'text-zinc-400 hover:text-white'}`} onClick={() => setBacklogOpen((v) => !v)} title={t('backlog.title')}>
                      <Icon name="list" size={14} />
                      {backlogTodo > 0 && <span className="text-[10px] tabular-nums">{backlogTodo}</span>}
                    </button>
                    {backlogOpen && project && (
                      <div className="glass-pop pop-in absolute right-0 top-full mt-2 z-30 p-3">
                        <BacklogPanel backlog={projectBacklog} onChange={(fn) => B.update(project, fn)} onFocusSession={(id) => { setBacklogOpen(false); focusSession.current(S.replaced[id] ?? id); }} />
                      </div>
                    )}
                  </div>
                  <button className="w-7 h-7 shrink-0 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-fill-2" onClick={() => setActiveSession('new')} title={t('app.newSession')}><Icon name="plus" /></button>
                </div>
              )}
              <div className="flex-1 min-h-0">
                <ChatPanel cwd={project} session={session}
                  onStart={start} onStartPair={startPair}
                  backlog={project ? projectBacklog : undefined} onBacklogChange={(fn) => project && B.update(project, fn)} onOpenBacklogSession={(id) => focusSession.current(S.replaced[id] ?? id)}
                  partner={partnerOf(session)} worktreeUsers={session?.worktree ? Object.values(S.sessions).filter((x) => x.id !== session.id && x.status !== 'closed' && x.worktree?.path === session.worktree!.path).length : 0}
                  openWorktrees={Object.values(S.sessions).flatMap((x) => (x.worktree ? [x.worktree.path] : []))}
                  onOpenWorktree={(wt) => { if (project) void S.start(wt.path, { agent: (localStorage.getItem('vibe.agent') as 'claude' | 'codex') || 'claude', worktree: { ...wt, origin: project } }).then(setActiveSession).catch((e) => window.alert((e as Error).message)); }} onFocusPartner={(id) => setActiveSession(id)} onClosePartner={(id) => S.close(id)}
                  onSend={(t, a) => session && S.send(session.id, t, a)}
                  onApprove={(r, d, m) => session && S.approve(session.id, r, d, m)}
                  onAnswer={(r, a) => session && S.answer(session.id, r, a)}
                  onInterrupt={() => session && S.interrupt(session.id)}
                  onStopTask={(id) => session && S.stopTask(session.id, id)}
                  onMode={(m) => session && S.setMode(session.id, m)}
                  onModel={(m) => session && S.setModel(session.id, m)}
                  onClose={() => { if (session) { S.close(session.id); setActiveSession(null); } }}
                  pendingAttachments={pendingAttachments} onConsumeAttachments={() => setPendingAttachments([])}
                  background={backgroundSessions(S.sessions, session?.id)} onFocusSession={(id) => focusSession.current(id)}
                  onRewind={(id, dry) => session ? S.rewind(session.id, id, dry) : Promise.resolve({ canRewind: false })}
                  onVerify={() => session && S.verify(session.id)}
                  onCrossReview={(changes) => { if (session) startCrossReview(S, session, changes).then(setActiveSession).catch((e) => window.alert((e as Error).message)); }}
                  onHandoff={() => { if (session) startHandoff(S, session).then(setActiveSession).catch((e) => window.alert((e as Error).message)); }} />
              </div>
            </section>
            {rightCollapsed ? <div className="w-4 shrink-0" /> : <Splitter gap onStart={() => setDragging(true)} onEnd={() => setDragging(false)} onDrag={(dx) => right.setWidth(right.width - dx)} />}
            <section style={{ width: rightCollapsed ? 61 : right.width }} className={`glass shrink-0 relative overflow-hidden ${paneTransition}`}>
              {/* Collapsed: a strip as wide as the dock with one button per tab. */}
              <div className={`absolute inset-0 flex flex-col items-center gap-1.5 py-2 transition-opacity duration-200 ${rightCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} aria-hidden={!rightCollapsed}>
                <button className="w-[45px] h-[45px] shrink-0 flex items-center justify-center rounded-full text-zinc-300 hover:bg-fill-2 hover:text-white" onClick={() => setRightCollapsed(false)} title={t('app.expandPanel')}><Icon name="chevronsLeft" /></button>
                <span className="w-8 h-px bg-line my-0.5" />
                {rightTabs.map(([k, label]) => (
                  <button key={k} title={label} aria-label={label} onClick={() => { setRightTab(k); setRightCollapsed(false); }}
                    className={`relative w-[45px] h-[45px] shrink-0 flex items-center justify-center rounded-full transition-colors ${rightTab === k ? 'bg-fill-3 text-white' : 'text-zinc-400 hover:bg-fill-2 hover:text-white'}`}>
                    <Icon name={tabIcons[k]} size={15} />
                    {k === 'run' && runStatus.running > 0 && <span className={`absolute top-2 right-2 w-1.5 h-1.5 rounded-full ${runStatus.errors ? 'bg-red-400' : 'bg-emerald-400'}`} />}
                  </button>
                ))}
              </div>
              <div className={`absolute inset-y-0 left-0 flex flex-col transition-opacity duration-200 ${rightCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`} style={{ width: right.width }} aria-hidden={rightCollapsed}>
                <div className="h-11 shrink-0 flex items-center gap-1 px-2 border-b border-line text-xs">
                  <div className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto whitespace-nowrap no-scrollbar">
                    {rightTabs.map(([k, label]) => (
                      <button key={k} className={`shrink-0 h-7 px-3 rounded-full flex items-center gap-1.5 transition-colors duration-150 ${rightTab === k ? 'bg-fill-3 text-white' : 'text-zinc-300 hover:text-white hover:bg-fill'}`} onClick={() => setRightTab(k)}>
                        {label}
                        {k === 'run' && runStatus.running > 0 && <span className={`w-1.5 h-1.5 rounded-full ${runStatus.errors ? 'bg-red-400' : 'bg-emerald-400'}`} />}
                      </button>
                    ))}
                  </div>
                  {panelRoot && (
                    <button className="shrink-0 h-7 px-2.5 flex items-center gap-1 rounded-full text-zinc-300 hover:text-white hover:bg-fill-2" title={t('app.openInIde')} onClick={() => openIde(panelRoot)}>
                      <Icon name="devtools" size={13} />IDE
                    </button>
                  )}
                  {project && (
                    <button className="shrink-0 h-7 px-2.5 rounded-full text-zinc-400 hover:text-white hover:bg-fill-2" title={t('app.openProjectIn')}
                      onClick={(e) => menu.open(e, [
                        { label: t('app.openInIde'), onClick: () => openIde(panelRoot ?? project) },
                        { separator: true },
                        { label: t('common.openInTerminal'), onClick: () => api.open(project, 'terminal').catch(() => {}) },
                        { label: t('common.revealInFinder'), onClick: () => api.open(project, 'finder').catch(() => {}) },
                        { label: t('common.openInVSCode'), onClick: () => api.open(project, 'vscode').catch(() => {}) },
                        { label: t('common.openInCursor'), onClick: () => api.open(project, 'cursor').catch(() => {}) },
                        { separator: true },
                        { label: t('context.menu'), onClick: () => setContextOpen(true) },
                        { label: t('common.copyPath'), onClick: () => navigator.clipboard.writeText(project) },
                      ])}>{t('app.openMenu')}</button>
                  )}
                  <button className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full hover:bg-fill-2 text-zinc-400 hover:text-white" onClick={() => setRightCollapsed(true)} title={t('app.collapsePanel')}><Icon name="chevronsRight" /></button>
                </div>
                <div className="flex-1 min-h-0 relative">
                  <div className={`absolute inset-0 ${rightTab === 'files' ? '' : 'invisible'}`}>
                    <FileList listing={listing} error={error} isFavorite={isFavorite}
                      onNavigate={navigate} onPreview={(e) => { setSelected(e); setRightTab('preview'); }} onToggleFavorite={toggleFavorite}
                      onRefresh={() => setRefreshTick((t) => t + 1)} onAttach={project ? attach : undefined}
                      onOpenInIde={(e) => openIde(panelRoot ?? project ?? e.path, e.isDir ? undefined : e.path)} />
                  </div>
                  <div className={`absolute inset-0 ${rightTab === 'preview' ? '' : 'invisible'}`}><Preview entry={selected} /></div>
                  <div className={`absolute inset-0 ${rightTab === 'terminal' ? '' : 'invisible'}`}><TerminalPanel cwd={panelRoot} visible={rightTab === 'terminal' && !rightCollapsed} /></div>
                  <div className={`absolute inset-0 ${rightTab === 'git' ? '' : 'invisible'}`}><GitPanel cwd={panelRoot} visible={rightTab === 'git' && !rightCollapsed} /></div>
                  <div className={`absolute inset-0 ${rightTab === 'run' ? '' : 'invisible'}`}><RunPanel cwd={panelRoot} visible={rightTab === 'run' && !rightCollapsed} onStatus={setRunStatus} /></div>
                </div>
              </div>
            </section>
          </main>
          {contextOpen && panelRoot && <AgentContextDialog cwd={panelRoot} onClose={() => setContextOpen(false)} onOpenFile={(p) => { setContextOpen(false); openIde(panelRoot, p); }} />}
          {quickOpen && project && (
            <QuickOpen cwd={project} onClose={() => setQuickOpen(false)}
              onOpen={(h) => { if (h.isDir) navigate(h.path); else api.stat(h.path).then((e) => { setSelected(e); setRightTab('preview'); setRightCollapsed(false); }).catch(() => {}); }}
              onAttach={(h) => { if (!h.isDir) attach([{ path: h.path, name: h.rel.split('/').pop() ?? h.rel, isDir: false, size: 0, mtime: 0, ext: '', hidden: false, kind: 'binary' }]); }} />
          )}
        </div>
        )}
          </Freeze>
          </div>
          </ViewActiveContext.Provider>
        ))}
        </div>
        {showTools && <ToolsPanel focusLock={toolsFocusLock} focusFormTypes={toolsFocusForms} onClose={() => { setShowTools(false); setToolsFocusLock(false); setToolsFocusForms(false); }} />}
      </div>
  );
}

/** Agent mode: free conversation not tied to a project. Left: live sessions; center: chat / all previous conversations. */
function AgentView({ home, S, active, setActive, onFocusSession }: { home: string; S: ReturnType<typeof useSessions>; active: string | 'new' | null; setActive: (v: string | 'new' | null) => void; onFocusSession: (id: string) => void }) {
  useLang();
  const menu = useContextMenu();
  // Only sessions run in the home folder; project sessions live in VIBE's project tabs.
  const live = sortSessions(Object.values(S.sessions).filter((s) => s.cwd === home));
  const session = active && active !== 'new' ? S.sessions[active] ?? null : null;
  const start = (c: string, o?: StartOptions) => S.start(c, o).then(setActive).catch((e) => window.alert(e.message));
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const closeOne = (s: ChatSession, confirmed = false) => {
    if (!confirmed && (s.status === 'running' || s.status === 'compacting') && !window.confirm(t('app.confirmCloseRunning'))) return;
    S.close(s.id); if (session?.id === s.id) setActive(null);
  };
  const list = usePaneWidth('vibe.w.agentList', 288, 200, 560);
  return (
    <div className="flex-1 min-w-0 flex px-[42px] pb-4 relative">
      <aside style={{ width: list.width }} className="glass shrink-0 flex flex-col overflow-hidden">
        <div className="h-12 shrink-0 flex items-center px-4 border-b border-line">
          <span className="text-[13px] font-semibold text-zinc-100">{t('app.agent')}</span>
          <div className="flex-1" />
          <button className="h-7 px-3 flex items-center gap-1 rounded-full bg-fill-2 hover:bg-fill-3 text-xs text-zinc-100 transition-colors" onClick={() => setActive('new')} title={t('app.newConversation')}>{t('app.newBtn')}</button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <div className="px-2.5 pt-1 pb-1.5 text-[11px] uppercase tracking-wider text-zinc-500">{t('app.openSessions')}</div>
          {live.length === 0 && <div className="px-2.5 text-xs text-zinc-500 leading-relaxed">{t('app.nothingOpen')}</div>}
          {live.map((s) => (
            <div key={s.id} onClick={() => setActive(s.id)}
              onDragOver={(e) => { if (s.id !== session?.id && hasTransfer(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropTarget(s.id); } }}
              onDragLeave={() => setDropTarget((d) => (d === s.id ? null : d))}
              onDrop={(e) => { if (s.id === session?.id || !hasTransfer(e)) return; e.preventDefault(); setDropTarget(null); const p = readTransfer(e); if (p) sendTransfer(s.id, p); }}
              onContextMenu={(e) => menu.open(e, sessionMenu(s, { setPinned: S.setPinned, rename: () => setRenaming(s.id), close: () => closeOne(s), remove: () => deleteSession(s, () => closeOne(s, true)) }))}
              className={`flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm cursor-pointer transition-colors duration-150 ${dropTarget === s.id ? 'ring-2 ring-sky-400/70 bg-sky-400/15 text-white' : session?.id === s.id ? 'bg-fill-3 text-white' : 'text-zinc-300 hover:bg-fill'}`}>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.status === 'running' || s.status === 'compacting' ? 'bg-amber-400 animate-pulse' : s.status === 'closed' ? 'bg-zinc-600' : 'bg-emerald-400'}`} />
              <AgentIcon agent={s.agent} size={16} />
              {s.pinned && <span className="text-[10px]" title={t('common.pin')}>📌</span>}
              {renaming === s.id
                ? <RenameInput s={s} onDone={(v) => { setRenaming(null); if (v) S.rename(s.id, v); }} className="flex-1 min-w-0 rounded-lg bg-black/30 px-2 py-0.5 text-sm text-zinc-100 outline-none border border-white/20" />
                : <span className="truncate flex-1">{displayTitle(s, 40) ?? t('common.new')}</span>}
              <AttentionBadge s={s} />
              <span className="text-[10px] text-zinc-600 truncate max-w-[70px]" title={s.cwd}>{s.cwd.split('/').pop()}</span>
            </div>
          ))}
        </div>
      </aside>
      <SideSplitter pane={list} />
      <section className="glass flex-1 min-w-0 overflow-hidden">
        <ChatPanel cwd={home} scope="home" session={session}
          onStart={start}
          onSend={(t, a) => session && S.send(session.id, t, a)}
          onApprove={(r, d, m) => session && S.approve(session.id, r, d, m)}
          onAnswer={(r, a) => session && S.answer(session.id, r, a)}
          onInterrupt={() => session && S.interrupt(session.id)}
          onStopTask={(id) => session && S.stopTask(session.id, id)}
          onMode={(m) => session && S.setMode(session.id, m)}
          onModel={(m) => session && S.setModel(session.id, m)}
          onClose={() => { if (session) { S.close(session.id); setActive(null); } }}
          background={backgroundSessions(S.sessions, session?.id)} onFocusSession={onFocusSession}
          onRewind={(id, dry) => session ? S.rewind(session.id, id, dry) : Promise.resolve({ canRewind: false })}
          onVerify={() => session && S.verify(session.id)}
          onCrossReview={(changes) => { if (session) startCrossReview(S, session, changes).then(setActive).catch((e) => window.alert((e as Error).message)); }}
          onHandoff={() => { if (session) startHandoff(S, session).then(setActive).catch((e) => window.alert((e as Error).message)); }} />
      </section>
    </div>
  );
}

type ChangesItem = Extract<ChatSession['items'][number], { kind: 'changes' }>;
const REVIEW_DIFF_LIMIT = 80000;

/**
 * Second opinion: open the other agent in the same folder, read-only (plan mode), and ask it to review
 * a turn's changes (the diff is inlined) or, without one, the folder's uncommitted work. Returns its id.
 */
async function startCrossReview(S: ReturnType<typeof useSessions>, s: ChatSession, changes?: ChangesItem): Promise<string> {
  const other = s.agent === 'claude' ? 'codex' : 'claude';
  const author = s.agent === 'claude' ? 'Claude' : 'Codex';
  let body = t('review.uncommitted');
  if (changes) {
    const diff = await api.turnDiff(changes.root, changes.from, changes.to, '').catch(() => '');
    const files = changes.files.map((f) => `- ${f.status} ${f.path}`).join('\n');
    body = diff && diff.length <= REVIEW_DIFF_LIMIT
      ? `${t('review.withDiff', { files })}\n\n${fencedTerminalText(diff)}`
      : t('review.tooBig', { files, from: changes.from, to: changes.to });
  }
  const id = await S.start(s.cwd, { agent: other, permissionMode: 'plan', worktree: s.worktree && { ...s.worktree, shared: true }, title: t('review.title', { author }) });
  S.send(id, t('review.prompt', { author, body }), []);
  return id;
}

/** Continue a session with the other agent: same folder (and worktree), briefing put into its composer to edit and send. */
async function startHandoff(S: ReturnType<typeof useSessions>, s: ChatSession): Promise<string> {
  const other = s.agent === 'claude' ? 'codex' : 'claude';
  // A new session: mode and model follow Settings > AI behavior for the other agent.
  const id = await S.start(s.cwd, { agent: other, worktree: s.worktree && { ...s.worktree, shared: true }, title: displayTitle(s, 40) ?? undefined });
  writeDraft(draftKey(id), { text: handoffText(s), attachments: [] });
  return id;
}

/** Every other live session that is working or waiting, for the chips beside the composer's "Attach". */
function backgroundSessions(sessions: Record<string, ChatSession>, currentId?: string): BackgroundSession[] {
  const out: BackgroundSession[] = [];
  for (const s of Object.values(sessions)) {
    if (s.id === currentId) continue;
    const state = backgroundState(s);
    if (state) out.push({ id: s.id, name: displayTitle(s, 18) ?? s.cwd.split('/').pop() ?? t('common.new'), state });
  }
  // Sessions that stopped to ask something come first: they block until the user answers.
  return out.sort((a, b) => (a.state === b.state ? 0 : a.state === 'waiting' ? -1 : 1));
}

/** Amber count on a session tab while its turn is blocked on approvals or questions. */
function AttentionBadge({ s }: { s: ChatSession }) {
  const n = pendingRequests(s);
  if (!n) return null;
  return <span className="min-w-4 h-4 px-1 rounded-full bg-amber-400 text-[10px] font-semibold leading-4 text-center text-black shrink-0" title={t('app.waitingRequests', { n })}>{n}</span>;
}

interface SessionActions { setPinned: (id: string, pinned: boolean) => void; rename: () => void; close: () => void; remove: () => void }

/** Right-click menu shared by project tabs and the Agent view list; mirrors the recent-sessions menu. */
function sessionMenu(s: ChatSession, a: SessionActions): MenuItem[] {
  const id = s.agentSessionId;
  return [
    { label: t(s.pinned ? 'common.unpin' : 'common.pin'), onClick: () => a.setPinned(s.id, !s.pinned) },
    { label: t('common.rename'), onClick: a.rename },
    { label: t('common.copySessionId'), disabled: !id, onClick: () => { if (id) void navigator.clipboard.writeText(id); } },
    { separator: true },
    { label: t('app.closeSession'), shortcut: '⌘W', onClick: a.close },
    { label: t(s.pinned ? 'common.deleteUnpinFirst' : 'common.deletePermanently'), danger: true, disabled: !!s.pinned || !id, onClick: a.remove },
  ];
}

/** Closes the tab and deletes the CLI session behind it, after one confirm. */
function deleteSession(s: ChatSession, close: () => void) {
  const id = s.agentSessionId;
  if (!id || !window.confirm(t('common.confirmDeleteSession', { title: displayTitle(s, 60) ?? id }))) return;
  const running = s.status === 'running' || s.status === 'compacting';
  close();
  // A running CLI may still append to its transcript while it stops; let it exit before the file goes.
  window.setTimeout(() => {
    api.historyDelete(s.agent, id, s.cwd).then(() => window.dispatchEvent(new Event('vibe:history-changed'))).catch((e: Error) => window.alert(e.message));
  }, running ? 1000 : 0);
}

/** In-place title editor for a session tab or list row; Enter saves, Escape cancels. */
function RenameInput({ s, onDone, className }: { s: ChatSession; onDone: (title: string | null) => void; className: string }) {
  const initial = s.title?.trim() || displayTitle(s, 300) || '';
  return (
    <input autoFocus defaultValue={initial} onFocus={(e) => e.target.select()} onClick={(e) => e.stopPropagation()} className={className}
      onBlur={(e) => { const v = e.target.value.trim(); onDone(v && v !== initial ? v : null); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur();
        if (e.key === 'Escape') { e.currentTarget.value = initial; e.currentTarget.blur(); }
      }} />
  );
}
