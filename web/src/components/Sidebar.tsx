import { useEffect, useState } from 'react';
import { api, type Favorite, type FavoriteGroup, type Favorites, type HomeInfo, type RecentSession } from '../lib/api';
import { useContextMenu, type MenuItem } from './ContextMenu';
import { UpdateBadge } from './UpdatePanel';
import { t, useLang } from '../lib/i18n';
import { pollWhileActive } from '../lib/poll';
import ProjectIcon from './ProjectIcon';
import AgentIcon from './AgentIcon';
import Icon from './Icon';

interface Props {
  home: HomeInfo | null;
  favorites: Favorites;
  cwd: string;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate: (path: string) => void;
  onFavoritesChange: (f: Favorites) => void;
  onPickFolder: () => void;
  onOpenSettings: () => void;
  onResumeSession: (s: RecentSession) => void;
}

const DRAG_FAV = 'application/x-vibe-favorite';

function Item({ label, path, active, onClick, onContextMenu, hint, indent, draggable, onDragStart, icon, lead }: {
  label: string; path: string; active: boolean; onClick: () => void; onContextMenu?: (e: React.MouseEvent) => void; hint?: string; indent?: boolean;
  draggable?: boolean; onDragStart?: (e: React.DragEvent) => void; icon?: boolean; lead?: React.ReactNode;
}) {
  return (
    <div data-companion-rung=""
      className={`group flex items-center gap-2 rounded-md py-1.5 text-sm cursor-pointer select-none ${indent ? 'pl-6 pr-2' : 'px-2'} ${active ? 'bg-white/10 text-white' : 'text-zinc-300 hover:bg-white/5'}`}
      onClick={onClick} onContextMenu={onContextMenu} title={path} draggable={draggable} onDragStart={onDragStart}
    >
      {lead ?? (icon ? <ProjectIcon path={path} name={label} size={18} /> : <span className="text-zinc-500">▸</span>)}
      <span className="truncate flex-1">{label}</span>
      {hint && <span className="text-[10px] text-zinc-600">{hint}</span>}
    </div>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="px-2 mb-1 text-[11px] uppercase tracking-wider text-zinc-500 flex items-center">{title}<div className="flex-1" />{right}</div>
      {children}
    </div>
  );
}

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

function InlineInput({ value, onCommit, onCancel, className }: { value: string; onCommit: (v: string) => void; onCancel: () => void; className?: string }) {
  const [draft, setDraft] = useState(value);
  return (
    <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => onCommit(draft)}
      onKeyDown={(e) => { if (e.key === 'Enter') onCommit(draft); if (e.key === 'Escape') onCancel(); }}
      onClick={(e) => e.stopPropagation()}
      className={`w-full bg-black/40 rounded px-2 py-1 text-sm outline-none border border-blue-400/50 ${className ?? ''}`} />
  );
}

export default function Sidebar(p: Props) {
  useLang();
  const menu = useContextMenu();
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [renaming, setRenaming] = useState<{ kind: 'fav' | 'group' | 'session'; id: string } | null>(null);
  const reloadSessions = () => api.historyAll().then(setSessions).catch(() => {});
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const { favorites, groups } = p.favorites;
  const apply = (pr: Promise<Favorites>) => pr.then(p.onFavoritesChange).catch(() => {});

  useEffect(() => {
    const load = () => api.historyAll().then(setSessions).catch(() => {});
    load();
    window.addEventListener('vibe:pins-changed', load);
    const stop = pollWhileActive(load, 60000);
    return () => { stop(); window.removeEventListener('vibe:pins-changed', load); };
  }, []);

  if (p.collapsed) {
    return (
      <aside className="w-10 shrink-0 h-full flex flex-col items-center border-r border-white/10 bg-[#0e1117] py-2 gap-2">
        <button className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-white/10 text-zinc-400" onClick={p.onToggle} title={t('sidebar.expand')}><Icon name="chevronsRight" /></button>
        <div className="flex-1 flex flex-col items-center gap-1 overflow-hidden">
          {favorites.slice(0, 12).map((f) => (
            <button key={f.path} title={f.name} onClick={() => p.onNavigate(f.path)}
              className={`w-7 h-7 rounded flex items-center justify-center ${p.cwd === f.path ? 'bg-white/15 ring-1 ring-white/30' : 'hover:bg-white/10'}`}>
              <ProjectIcon path={f.path} name={f.name} size={22} />
            </button>
          ))}
        </div>
        <button className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-white/10 text-zinc-400" onClick={p.onPickFolder} title={t('sidebar.openFolder')}><Icon name="plus" /></button>
        <button className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-white/10 text-zinc-400" onClick={p.onOpenSettings} title={t('common.settings')}><Icon name="gear" /></button>
      </aside>
    );
  }

  const moveItems = (f: Favorite): MenuItem[] => [
    ...groups.filter((g) => g.id !== f.group).map((g) => ({ label: t('sidebar.moveTo', { name: g.name }), onClick: () => apply(api.updateFavorite(f.path, { group: g.id })) })),
    ...(f.group ? [{ label: t('sidebar.moveTop'), onClick: () => apply(api.updateFavorite(f.path, { group: null })) }] : []),
    { label: t('sidebar.newGroupMenu'), onClick: () => setCreatingGroup(true) },
  ];
  const favMenu = (f: Favorite): MenuItem[] => [
    { label: t('common.open'), onClick: () => p.onNavigate(f.path) },
    { label: t('common.rename'), onClick: () => setRenaming({ kind: 'fav', id: f.path }) },
    { separator: true },
    ...moveItems(f),
    { separator: true },
    ...commonItems(f.path),
    { separator: true },
    { label: t('sidebar.removeFavorite'), danger: true, onClick: () => apply(api.removeFavorite(f.path)) },
  ];
  const groupMenu = (g: FavoriteGroup): MenuItem[] => [
    { label: g.collapsed ? t('sidebar.expandGroup') : t('sidebar.collapseGroup'), onClick: () => apply(api.updateFavoriteGroup(g.id, { collapsed: !g.collapsed })) },
    { label: t('common.rename'), onClick: () => setRenaming({ kind: 'group', id: g.id }) },
    { label: t('sidebar.newGroupMenu'), onClick: () => setCreatingGroup(true) },
    { separator: true },
    { label: t('sidebar.deleteGroup'), danger: true, onClick: () => apply(api.removeFavoriteGroup(g.id)) },
  ];
  const sessionMenu = (s: RecentSession): MenuItem[] => [
    { label: t('common.resume'), onClick: () => p.onResumeSession(s) },
    { label: s.pinned ? t('common.unpin') : t('common.pin'), onClick: () => api.historyPin(s.agent, s.sessionId, !s.pinned).then(reloadSessions).catch(() => {}) },
    { label: t('common.rename'), onClick: () => setRenaming({ kind: 'session', id: s.sessionId }) },
    { label: t('common.copySessionId'), onClick: () => navigator.clipboard.writeText(s.sessionId) },
    ...(s.cwd ? [{ separator: true }, ...commonItems(s.cwd)] : []),
    { separator: true },
    { label: s.pinned ? t('common.deleteUnpinFirst') : t('common.deletePermanently'), danger: true, disabled: !!s.pinned, onClick: () => {
      if (window.confirm(t('common.confirmDeleteSession', { title: s.title }))) api.historyDelete(s.agent, s.sessionId, s.cwd ?? undefined).then(reloadSessions).catch((e) => window.alert(e.message));
    } },
  ];

  const dropTarget = (groupId: string | null) => ({
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(DRAG_FAV)) { e.preventDefault(); setDragOver(groupId ?? '__top__'); } },
    onDragLeave: () => setDragOver(null),
    onDrop: (e: React.DragEvent) => {
      const path = e.dataTransfer.getData(DRAG_FAV);
      setDragOver(null);
      if (path) { e.preventDefault(); apply(api.updateFavorite(path, { group: groupId })); }
    },
  });

  const renderFav = (f: Favorite, indent: boolean) => renaming?.kind === 'fav' && renaming.id === f.path ? (
    <div key={f.path} className={indent ? 'pl-6 pr-2' : 'px-2'}>
      <InlineInput value={f.name} onCancel={() => setRenaming(null)} onCommit={(v) => { setRenaming(null); if (v.trim() && v !== f.name) apply(api.updateFavorite(f.path, { name: v })); }} />
    </div>
  ) : (
    <Item key={f.path} label={f.name} path={f.path} active={p.cwd === f.path} indent={indent} icon onClick={() => p.onNavigate(f.path)} onContextMenu={(e) => menu.open(e, favMenu(f))}
      draggable onDragStart={(e) => { e.dataTransfer.setData(DRAG_FAV, f.path); e.dataTransfer.effectAllowed = 'move'; }} />
  );

  const topLevel = favorites.filter((f) => !f.group || !groups.some((g) => g.id === f.group));

  return (
    <aside className="h-full flex flex-col border-r border-white/10 bg-[#0e1117] min-w-0">
      <div className="h-10 flex items-center px-3 text-xs text-zinc-500">
        <span className="pl-1 font-medium text-zinc-400">Vibrato</span>
        <span className="ml-2"><UpdateBadge /></span>
        <div className="flex-1" />
        <button className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-white/10 text-zinc-400" onClick={p.onToggle} title={t('sidebar.collapse')}><Icon name="chevronsLeft" /></button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <Section title={t('sidebar.favorites')} right={<button className="text-[11px] text-zinc-500 hover:text-zinc-200" title={t('sidebar.newGroup')} onClick={() => setCreatingGroup(true)}>{t('sidebar.newGroupBtn')}</button>}>
          {creatingGroup && (
            <div className="px-2 mb-1 flex items-center gap-1">
              <span>📁</span>
              <InlineInput value={t('sidebar.newGroupDefault')} onCancel={() => setCreatingGroup(false)} onCommit={(v) => { setCreatingGroup(false); if (v.trim()) apply(api.addFavoriteGroup(v)); }} />
            </div>
          )}
          {groups.map((g) => {
            const items = favorites.filter((f) => f.group === g.id);
            return (
              <div key={g.id} className={`rounded-md ${dragOver === g.id ? 'bg-blue-500/15 ring-1 ring-blue-400/40' : ''}`} {...dropTarget(g.id)}>
                <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-zinc-200 cursor-pointer select-none hover:bg-white/5"
                  onClick={() => apply(api.updateFavoriteGroup(g.id, { collapsed: !g.collapsed }))} onContextMenu={(e) => menu.open(e, groupMenu(g))}>
                  <span className="text-[10px] text-zinc-500 w-3">{g.collapsed ? '▸' : '▾'}</span>
                  <span>{g.collapsed ? '📁' : '📂'}</span>
                  {renaming?.kind === 'group' && renaming.id === g.id
                    ? <InlineInput value={g.name} onCancel={() => setRenaming(null)} onCommit={(v) => { setRenaming(null); if (v.trim() && v !== g.name) apply(api.updateFavoriteGroup(g.id, { name: v })); }} />
                    : <span className="truncate flex-1 font-medium">{g.name}</span>}
                  <span className="text-[10px] text-zinc-600">{items.length}</span>
                </div>
                {!g.collapsed && items.map((f) => renderFav(f, true))}
                {!g.collapsed && items.length === 0 && <div className="pl-8 pr-2 py-1 text-[11px] text-zinc-600">{t('sidebar.dropHere')}</div>}
              </div>
            );
          })}
          <div className={`rounded-md min-h-2 ${dragOver === '__top__' ? 'bg-blue-500/15 ring-1 ring-blue-400/40' : ''}`} {...dropTarget(null)}>
            {topLevel.map((f) => renderFav(f, false))}
          </div>
          {favorites.length === 0 && !creatingGroup && <div className="px-2 text-xs text-zinc-600">{t('sidebar.emptyFavorites')}</div>}
        </Section>
        <div data-companion-floor="favorites-divider" role="separator" className="h-px bg-white/10 mx-2 mb-4" />
      </div>
      {/* Recent sessions: pinned to the bottom quarter of the sidebar with its own scroll. */}
      <div data-companion-floor="recent-sessions" className="h-1/4 min-h-[120px] shrink-0 flex flex-col border-t border-white/10 bg-[#0b0d12]">
        <div className="h-8 shrink-0 flex items-center gap-2 px-3 bg-white/[0.04] border-b border-white/5">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
          <span className="text-[11px] font-semibold tracking-wide text-zinc-300">{t('sidebar.recentSessions')}</span>
          <span className="text-[10px] text-zinc-500 rounded-full bg-white/5 px-1.5">{sessions.length}</span>
          <div className="flex-1" />
          <button className="w-7 h-7 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/10" onClick={reloadSessions} title={t('common.refresh')}><Icon name="reload" size={14} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-1">
          {sessions.length === 0 && <div className="px-2 py-2 text-xs text-zinc-600">{t('sidebar.noSessions')}</div>}
          {sessions.map((s) => renaming?.kind === 'session' && renaming.id === s.sessionId ? (
            <div key={s.agent + s.sessionId} className="px-2">
              <InlineInput value={s.title} onCancel={() => setRenaming(null)} onCommit={(v) => { setRenaming(null); if (v.trim() && v !== s.title) api.historyRename(s.agent, s.sessionId, v.trim(), s.cwd ?? undefined).then(reloadSessions).catch(() => {}); }} />
            </div>
          ) : (
            <Item key={s.agent + s.sessionId} label={(s.pinned ? '📌 ' : '') + s.title} path={s.cwd ?? s.sessionId} active={false} lead={<AgentIcon agent={s.agent} size={16} />}
              onClick={() => p.onResumeSession(s)} onContextMenu={(e) => menu.open(e, sessionMenu(s))} />
          ))}
        </div>
      </div>
      <div className="p-2 border-t border-white/10 flex gap-2">
        <button className="flex-1 text-sm rounded-md bg-white/5 hover:bg-white/10 py-1.5" onClick={p.onPickFolder}>{t('sidebar.openFolderBtn')}</button>
        <button className="w-9 flex items-center justify-center rounded-md bg-white/5 hover:bg-white/10 text-zinc-300" onClick={p.onOpenSettings} title={t('common.settings')}><Icon name="gear" size={17} /></button>
      </div>
    </aside>
  );
}
