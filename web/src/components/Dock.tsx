import { Fragment, useEffect, useRef, useState } from 'react';

/** How long a removed favorite stays on screen for its shrink animation (.dock-out). */
const LEAVE_MS = 330;
import { api, type Favorite, type FavoriteGroup, type Favorites, type RecentSession } from '../lib/api';
import { useContextMenu, type MenuItem } from './ContextMenu';
import { t, useLang } from '../lib/i18n';
import { pollWhileActive } from '../lib/poll';
import ProjectIcon from './ProjectIcon';
import AgentIcon from './AgentIcon';
import Icon from './Icon';

interface Props {
  favorites: Favorites;
  /** The project on screen. */
  project: string | null;
  onNavigate: (path: string) => void;
  onFavoritesChange: (f: Favorites) => void;
  onResumeSession: (s: RecentSession) => void;
  /** Approvals and questions waiting across open sessions (badge on the recent-sessions button). */
  waiting: number;
  /** Per-project dot: yellow while a session works, green when one finished and the project was not opened since. */
  badge: (path: string) => 'running' | 'done' | null;
}

function StatusDot({ state }: { state: 'running' | 'done' | null }) {
  if (!state) return null;
  return <span className={`absolute top-0 right-0 w-2.5 h-2.5 rounded-full ring-2 ring-black/45 ${state === 'running' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} aria-hidden="true" />;
}

const DRAG_FAV = 'application/x-vibe-favorite';

/** Shared "open this folder in…" entries; built per call so they follow the current language. */
export function commonItems(path: string): MenuItem[] {
  return [
    { label: t('common.openInTerminal'), onClick: () => api.open(path, 'terminal').catch(() => {}) },
    { label: t('common.openInVSCode'), onClick: () => api.open(path, 'vscode').catch(() => {}) },
    { label: t('common.openInCursor'), onClick: () => api.open(path, 'cursor').catch(() => {}) },
    { label: t('common.revealInFinder'), onClick: () => api.open(path, 'finder').catch(() => {}) },
    { label: t('common.copyPath'), onClick: () => navigator.clipboard.writeText(path) },
  ];
}

const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

/** Label beside the dock. Fixed-positioned: the dock scrolls, so an absolute child would be clipped. */
function Tip({ tip }: { tip: { text: string; sub?: string; x: number; y: number } | null }) {
  if (!tip) return null;
  return (
    <div role="tooltip" className="glass-pop pop-in fixed z-50 -translate-y-1/2 whitespace-nowrap rounded-xl px-3 py-1.5 text-[12px] text-zinc-100 pointer-events-none"
      style={{ left: tip.x, top: tip.y }}>
      {tip.text}{tip.sub && <span className="ml-2 text-[11px] text-zinc-400">{tip.sub}</span>}
    </div>
  );
}

/** Small floating text field (new group, rename) next to the dock. */
function Prompt({ at, value, onCommit, onCancel }: { at: { x: number; y: number }; value: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <div className="glass-pop pop-in fixed z-50 -translate-y-1/2 p-1.5" style={{ left: at.x, top: at.y }}>
      <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.target.select()}
        onBlur={() => onCommit(draft)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) onCommit(draft); if (e.key === 'Escape') onCancel(); }}
        className="w-52 rounded-lg bg-black/30 px-2.5 py-1.5 text-[13px] text-zinc-100 outline-none border border-white/10 focus:border-white/30" />
    </div>
  );
}

/**
 * VIBE's left dock: favorites as round icons (name on hover), groups as dividers, ungrouped favorites at the
 * bottom, the current folder on top when it is not a favorite, and recent sessions behind the bottom button.
 */
export default function Dock(p: Props) {
  useLang();
  const menu = useContextMenu();
  const nav = useRef<HTMLElement>(null);
  const [tip, setTip] = useState<{ text: string; sub?: string; x: number; y: number } | null>(null);
  const [prompt, setPrompt] = useState<{ kind: 'newGroup' | 'renameGroup' | 'renameFav'; id?: string; value: string; y: number } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Favorites that just appeared spring in; removed ones stay a moment (at their old place) to shrink away.
  const prevFavs = useRef<Favorite[] | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState<{ fav: Favorite; index: number }[]>([]);
  useEffect(() => {
    const prev = prevFavs.current;
    prevFavs.current = p.favorites.favorites;
    if (!prev) return;
    const now = p.favorites.favorites;
    const added = now.filter((f) => !prev.some((x) => x.path === f.path)).map((f) => f.path);
    const gone = prev.flatMap((f, index) => (now.some((x) => x.path === f.path) ? [] : [{ fav: f, index }]));
    if (added.length) setFresh(new Set(added));
    if (!gone.length) return;
    setLeaving((l) => [...l.filter((x) => !gone.some((g) => g.fav.path === x.fav.path)), ...gone]);
    // Not cleared on the next change: a second edit within LEAVE_MS must not leave these stuck on screen.
    window.setTimeout(() => setLeaving((l) => l.filter((x) => !gone.some((g) => g.fav.path === x.fav.path))), LEAVE_MS);
  }, [p.favorites.favorites]);
  const [recentOpen, setRecentOpen] = useState(false);
  const { favorites, groups } = p.favorites;
  const apply = (pr: Promise<Favorites>) => pr.then(p.onFavoritesChange).catch(() => {});
  const dockRight = () => (nav.current?.getBoundingClientRect().right ?? 72) + 10;
  const showTip = (e: React.MouseEvent, text: string, sub?: string) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTip({ text, sub, x: dockRight(), y: r.top + r.height / 2 });
  };
  const ask = (e: { clientY: number }, kind: 'newGroup' | 'renameGroup' | 'renameFav', value: string, id?: string) => {
    setTip(null);
    setPrompt({ kind, id, value, y: e.clientY });
  };
  const commitPrompt = (v: string) => {
    const cur = prompt;
    setPrompt(null);
    const name = v.trim();
    if (!cur || !name || name === cur.value) return;
    if (cur.kind === 'newGroup') apply(api.addFavoriteGroup(name));
    else if (cur.kind === 'renameGroup' && cur.id) apply(api.updateFavoriteGroup(cur.id, { name }));
    else if (cur.kind === 'renameFav' && cur.id) apply(api.updateFavorite(cur.id, { name }));
  };

  const favMenu = (f: Favorite, e: React.MouseEvent): MenuItem[] => [
    { label: t('common.open'), onClick: () => p.onNavigate(f.path) },
    { label: t('common.rename'), onClick: () => ask(e, 'renameFav', f.name, f.path) },
    { separator: true },
    ...groups.filter((g) => g.id !== f.group).map((g) => ({ label: t('sidebar.moveTo', { name: g.name }), onClick: () => apply(api.updateFavorite(f.path, { group: g.id })) })),
    ...(f.group ? [{ label: t('sidebar.moveTop'), onClick: () => apply(api.updateFavorite(f.path, { group: null })) }] : []),
    { label: t('sidebar.newGroupMenu'), onClick: () => ask(e, 'newGroup', t('sidebar.newGroupDefault')) },
    { separator: true },
    ...commonItems(f.path),
    { separator: true },
    { label: t('sidebar.removeFavorite'), danger: true, onClick: () => apply(api.removeFavorite(f.path)) },
  ];
  const groupMenu = (g: FavoriteGroup, e: React.MouseEvent): MenuItem[] => [
    { label: t('common.rename'), onClick: () => ask(e, 'renameGroup', g.name, g.id) },
    { label: t('sidebar.newGroupMenu'), onClick: () => ask(e, 'newGroup', t('sidebar.newGroupDefault')) },
    { separator: true },
    { label: t('sidebar.deleteGroup'), danger: true, onClick: () => apply(api.removeFavoriteGroup(g.id)) },
  ];
  const dropTarget = (groupId: string | null) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(DRAG_FAV)) { e.preventDefault(); e.stopPropagation(); setDragOver(groupId ?? '__top__'); } },
    onDragLeave: (e: React.DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragOver((d) => (d === (groupId ?? '__top__') ? null : d)); },
    onDrop: (e: React.DragEvent) => {
      const path = e.dataTransfer.getData(DRAG_FAV);
      setDragOver(null);
      if (path) { e.preventDefault(); e.stopPropagation(); apply(api.updateFavorite(path, { group: groupId })); }
    },
  });

  const leavingPaths = new Set(leaving.map((x) => x.fav.path));
  const icon = (f: Favorite) => {
    const active = p.project === f.path;
    const anim = leavingPaths.has(f.path) ? 'dock-out' : fresh.has(f.path) ? 'dock-in' : '';
    return (
      <button key={f.path} draggable={!anim} onAnimationEnd={() => { if (anim === 'dock-in') setFresh((s) => { const n = new Set(s); n.delete(f.path); return n; }); }} onDragStart={(e) => { setTip(null); e.dataTransfer.setData(DRAG_FAV, f.path); e.dataTransfer.effectAllowed = 'move'; }}
        onClick={() => p.onNavigate(f.path)} onContextMenu={(e) => { setTip(null); menu.open(e, favMenu(f, e)); }}
        onMouseEnter={(e) => showTip(e, f.name)} onMouseLeave={() => setTip(null)} aria-label={f.name} aria-current={active || undefined}
        className={`relative w-10 h-10 shrink-0 rounded-full flex items-center justify-center transition-[background-color,box-shadow,transform] duration-200 ease-glass active:scale-95 ${anim} ${active ? 'bg-selected shadow-[0_4px_14px_rgb(0_0_0/.3)]' : 'hover:bg-fill-2'}`}>
        <ProjectIcon path={f.path} name={f.name} size={22} />
        <StatusDot state={p.badge(f.path)} />
      </button>
    );
  };
  // Removed favorites are put back at their old index until their animation ends.
  const shown = favorites.slice();
  for (const l of [...leaving].sort((a, b) => a.index - b.index)) if (!shown.some((f) => f.path === l.fav.path)) shown.splice(Math.min(l.index, shown.length), 0, l.fav);
  const topLevel = shown.filter((f) => !f.group || !groups.some((g) => g.id === f.group));
  const current = p.project && !favorites.some((f) => f.path === p.project) ? p.project : null;

  return (
    <nav ref={nav} className="glass relative w-14 max-h-full flex flex-col items-center py-2 rounded-[28px] select-none"
      onContextMenu={(e) => menu.open(e, [{ label: t('sidebar.newGroupMenu'), onClick: () => ask(e, 'newGroup', t('sidebar.newGroupDefault')) }])}>
      {current && (
        <div className="shrink-0 flex flex-col items-center gap-2 pb-2 mb-1 border-b border-line w-10">
          <button onClick={() => p.onNavigate(current)} aria-label={baseName(current)} aria-current
            onMouseEnter={(e) => showTip(e, baseName(current), t('dock.current'))} onMouseLeave={() => setTip(null)}
            onContextMenu={(e) => { setTip(null); menu.open(e, [{ label: t('dock.addFavorite'), onClick: () => apply(api.addFavorite(current)) }, { separator: true }, ...commonItems(current)]); }}
            className="relative w-10 h-10 rounded-full flex items-center justify-center bg-selected shadow-[0_4px_14px_rgb(0_0_0/.3)] outline-dashed outline-[1.5px] outline-offset-[3px] outline-white/45">
            <ProjectIcon path={current} name={baseName(current)} size={22} />
            <StatusDot state={p.badge(current)} />
          </button>
        </div>
      )}
      <div className="min-h-0 overflow-y-auto no-scrollbar flex flex-col items-center gap-1.5 py-1 w-full">
        {groups.map((g) => {
          const items = shown.filter((f) => f.group === g.id);
          return (
            <Fragment key={g.id}>
              <div {...dropTarget(g.id)} className={`w-full flex flex-col items-center gap-1.5 rounded-2xl transition-colors ${dragOver === g.id ? 'bg-sky-400/15' : ''}`}>
                <div role="separator" aria-label={g.name} tabIndex={-1}
                  onMouseEnter={(e) => showTip(e, g.name, String(items.length))} onMouseLeave={() => setTip(null)}
                  onContextMenu={(e) => { setTip(null); menu.open(e, groupMenu(g, e)); }}
                  className="group/div w-10 h-3.5 shrink-0 flex items-center justify-center cursor-default">
                  <span className="h-[2px] w-6 rounded-full bg-white/25 transition-all duration-200 ease-glass group-hover/div:w-9 group-hover/div:bg-white/60" />
                </div>
                {items.map(icon)}
              </div>
            </Fragment>
          );
        })}
        <div {...dropTarget(null)} className={`w-full min-h-3 flex flex-col items-center gap-1.5 rounded-2xl transition-colors ${dragOver === '__top__' ? 'bg-sky-400/15' : ''}`}>
          {groups.length > 0 && topLevel.length > 0 && <span className="w-10 h-px my-1 bg-line" aria-hidden="true" />}
          {topLevel.map(icon)}
        </div>
      </div>
      <div className="shrink-0 pt-1.5 mt-1 border-t border-line w-10 flex justify-center">
        <button onClick={() => { setTip(null); setRecentOpen((v) => !v); }} aria-label={t('sidebar.recentSessions')} aria-expanded={recentOpen}
          onMouseEnter={(e) => { if (!recentOpen) showTip(e, t('sidebar.recentSessions')); }} onMouseLeave={() => setTip(null)}
          className={`relative w-10 h-10 rounded-full flex items-center justify-center transition-colors duration-200 ${recentOpen ? 'bg-selected text-on-selected' : 'text-zinc-300 hover:bg-fill-2 hover:text-white'}`}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></svg>
          {p.waiting > 0 && <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-amber-400 text-[10px] font-semibold leading-4 text-center text-black" title={t('app.waitingRequests', { n: p.waiting })}>{p.waiting}</span>}
        </button>
      </div>
      {recentOpen && <RecentSessions anchor={nav} onResume={(s) => { setRecentOpen(false); p.onResumeSession(s); }} onClose={() => setRecentOpen(false)} />}
      <Tip tip={tip} />
      {prompt && <Prompt at={{ x: dockRight(), y: prompt.y }} value={prompt.value} onCommit={commitPrompt} onCancel={() => setPrompt(null)} />}
    </nav>
  );
}

/** Recent sessions popover beside the dock's bottom button. Closes on a pick or a click outside (not on its own menus). */
function RecentSessions({ anchor, onResume, onClose }: { anchor: React.RefObject<HTMLElement | null>; onResume: (s: RecentSession) => void; onClose: () => void }) {
  useLang();
  const menu = useContextMenu();
  const box = useRef<HTMLDivElement>(null);
  const [sessions, setSessions] = useState<RecentSession[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const reload = () => api.historyAll().then(setSessions).catch(() => setSessions((s) => s ?? []));
  useEffect(() => {
    void reload();
    window.addEventListener('vibe:pins-changed', reload);
    const stop = pollWhileActive(reload, 60000);
    return () => { stop(); window.removeEventListener('vibe:pins-changed', reload); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const away = (e: MouseEvent) => {
      const target = e.target as Element;
      if (box.current?.contains(target) || target.closest?.('[data-context-menu]') || anchor.current?.querySelector('[aria-expanded]')?.contains(target)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && !renaming) onClose(); };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, [anchor, onClose, renaming]);

  const r = anchor.current?.getBoundingClientRect();
  const sessionMenu = (s: RecentSession): MenuItem[] => [
    { label: t('common.resume'), onClick: () => onResume(s) },
    { label: s.pinned ? t('common.unpin') : t('common.pin'), onClick: () => api.historyPin(s.agent, s.sessionId, !s.pinned).then(reload).catch(() => {}) },
    { label: t('common.rename'), onClick: () => setRenaming(s.sessionId) },
    { label: t('common.copySessionId'), onClick: () => navigator.clipboard.writeText(s.sessionId) },
    ...(s.cwd ? [{ separator: true }, ...commonItems(s.cwd)] : []),
    { separator: true },
    { label: s.pinned ? t('common.deleteUnpinFirst') : t('common.deletePermanently'), danger: true, disabled: !!s.pinned, onClick: () => {
      if (window.confirm(t('common.confirmDeleteSession', { title: s.title }))) api.historyDelete(s.agent, s.sessionId, s.cwd ?? undefined).then(reload).catch((e) => window.alert(e.message));
    } },
  ];
  return (
    <div ref={box} className="glass-pop pop-in fixed z-40 w-80 max-h-[min(560px,70vh)] flex flex-col overflow-hidden"
      style={{ left: (r?.right ?? 72) + 12, bottom: Math.max(16, window.innerHeight - (r?.bottom ?? window.innerHeight - 16)) }}
      onContextMenu={(e) => e.stopPropagation()}>
      <div className="h-10 shrink-0 flex items-center gap-2 px-3.5 border-b border-white/10">
        <span className="text-[12px] font-semibold text-zinc-200">{t('sidebar.recentSessions')}</span>
        {sessions && <span className="text-[10px] text-zinc-400 rounded-full bg-white/10 px-1.5">{sessions.length}</span>}
        <div className="flex-1" />
        <button className="w-7 h-7 flex items-center justify-center rounded-full text-zinc-400 hover:text-zinc-100 hover:bg-white/10 transition-colors" onClick={() => void reload()} title={t('common.refresh')}><Icon name="reload" size={13} /></button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
        {sessions === null && <div className="px-2.5 py-2 text-xs text-zinc-500">…</div>}
        {sessions?.length === 0 && <div className="px-2.5 py-2 text-xs text-zinc-500">{t('sidebar.noSessions')}</div>}
        {sessions?.map((s) => renaming === s.sessionId ? (
          <input key={s.agent + s.sessionId} autoFocus defaultValue={s.title} onFocus={(e) => e.target.select()}
            onBlur={(e) => { setRenaming(null); const v = e.target.value.trim(); if (v && v !== s.title) api.historyRename(s.agent, s.sessionId, v, s.cwd ?? undefined).then(reload).catch(() => {}); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { (e.target as HTMLInputElement).value = s.title; (e.target as HTMLInputElement).blur(); } }}
            className="w-full my-0.5 rounded-lg bg-black/30 px-2.5 py-1.5 text-[13px] outline-none border border-white/20" />
        ) : (
          <button key={s.agent + s.sessionId} onClick={() => onResume(s)} onContextMenu={(e) => menu.open(e, sessionMenu(s))} title={s.cwd ?? s.sessionId}
            className="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-zinc-200 hover:bg-white/10 transition-colors">
            <AgentIcon agent={s.agent} size={16} />
            <span className="truncate flex-1">{s.pinned && <span className="mr-1 text-[10px]">📌</span>}{s.title}</span>
            {s.cwd && <span className="shrink-0 max-w-[90px] truncate text-[10px] text-zinc-500">{baseName(s.cwd)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
