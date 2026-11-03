import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatSize, type Entry, type Listing } from '../lib/api';
import { useContextMenu, type MenuItem } from './ContextMenu';
import { t, useLang } from '../lib/i18n';
import FileIcon from './FileIcon';
import Icon from './Icon';
import { editor } from '../lib/editor/store';

interface Props {
  listing: Listing | null;
  error: { code: string; message: string } | null;
  isFavorite: boolean;
  onNavigate: (path: string) => void;
  onPreview: (entry: Entry) => void;
  onToggleFavorite: () => void;
  onRefresh: () => void;
  onAttach?: (entries: Entry[]) => void;
  onOpenInIde?: (entry: Entry) => void;
}

// `change` is the macOS pasteboard changeCount right after we put these files there; if it has moved
// since, something else (Finder, another app) owns the pasteboard and its content wins.
interface Clipboard { paths: string[]; cut: boolean; change?: number }
interface SearchHit { path: string; rel: string; isDir: boolean }
let clipboard: Clipboard | null = null; // module-level so it survives re-renders and folder changes

export default function FileList({ listing, error, isFavorite, onNavigate, onPreview, onToggleFavorite, onRefresh, onAttach, onOpenInIde }: Props) {
  useLang();
  const menu = useContextMenu();
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState<false | 'folder' | 'file'>(false);
  const [note, setNote] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // Name search under the folder on screen (recursive, same matcher as "@" mentions).
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [hitIdx, setHitIdx] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const searching = query.trim().length > 0;

  const entries = (listing?.entries ?? []).filter((e) => showHidden || !e.hidden);
  const selectedEntries = entries.filter((e) => selected.has(e.path));
  const crumbs = listing ? listing.path.split('/').filter(Boolean) : [];

  useEffect(() => { setSelected(new Set()); setAnchor(null); setRenaming(null); setQuery(''); }, [listing?.path]);
  useEffect(() => {
    if (!listing || !searching) { setHits(null); return; }
    let alive = true;
    const timer = setTimeout(() => {
      api.search(listing.path, query.trim()).then((h) => { if (alive) { setHits(h); setHitIdx(0); } }).catch((e) => { if (alive) { setHits([]); fail(e); } });
    }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [query, listing?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  // ⌘F inside the file panel searches files instead of the chat.
  const onFind = (ev: React.KeyboardEvent) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'f') { ev.preventDefault(); searchInput.current?.focus(); searchInput.current?.select(); return true; }
    return false;
  };
  const openHit = (h: SearchHit) => {
    if (h.isDir) onNavigate(h.path);
    // Search hits carry only the path; Preview needs the full entry (kind, size, ext).
    else api.stat(h.path).then(onPreview).catch(fail);
  };
  const hitMenu = (h: SearchHit): MenuItem[] => [
    { label: h.isDir ? t('common.open') : t('files.preview'), onClick: () => openHit(h) },
    ...(onAttach && !h.isDir ? [{ label: t('files.attachToChat'), onClick: () => { api.stat(h.path).then((e) => onAttach([e])).catch(fail); } }] : []),
    { label: t('files.openContainingFolder'), onClick: () => onNavigate(h.path.slice(0, h.path.lastIndexOf('/')) || '/') },
    { separator: true },
    { label: t('common.revealInFinder'), onClick: () => api.open(h.path, 'finder').catch(fail) },
    { label: t('common.copyPath'), onClick: () => navigator.clipboard.writeText(h.path) },
  ];
  useEffect(() => { if (!note) return; const timer = setTimeout(() => setNote(null), 3000); return () => clearTimeout(timer); }, [note]);

  const fail = (e: unknown) => setNote((e as Error).message ?? String(e));

  const select = (e: Entry, ev: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
    setSelected((prev) => {
      const next = new Set(ev.metaKey || ev.ctrlKey ? prev : []);
      if (ev.shiftKey && anchor) {
        const a = entries.findIndex((x) => x.path === anchor); const b = entries.findIndex((x) => x.path === e.path);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) next.add(entries[i].path);
        return next;
      }
      if ((ev.metaKey || ev.ctrlKey) && prev.has(e.path)) next.delete(e.path); else next.add(e.path);
      return next;
    });
    if (!ev.shiftKey) setAnchor(e.path);
  };

  const open = (e: Entry) => (e.isDir ? onNavigate(e.path) : onPreview(e));

  // Copies go to the system pasteboard as files, so Finder (or any app taking files) can paste them.
  const copy = (cut: boolean, items = selectedEntries) => {
    if (!items.length) return;
    const c: Clipboard = { paths: items.map((e) => e.path), cut };
    clipboard = c;
    api.setClipboardFiles(c.paths).then((r) => { c.change = r.change; }).catch(() => { void navigator.clipboard.writeText(c.paths.join('\n')); });
    setNote(t(cut ? 'files.cutItems' : 'files.copiedItems', { n: c.paths.length }));
  };
  // Pastes whatever files are on the system pasteboard (e.g. copied in Finder); a cut made here moves.
  const paste = async () => {
    if (!listing) return;
    const dest = listing.path;
    const own = clipboard;
    const sys = await api.clipboardFiles().catch(() => null);
    let paths: string[]; let cut = false;
    if (own && (!sys || own.change === undefined || own.change === sys.change)) { paths = own.paths; cut = own.cut; }
    else paths = sys?.paths ?? [];
    if (!paths.length) { setNote(t('files.nothingToPaste')); return; }
    (cut ? api.fsMove(paths, dest) : api.fsCopy(paths, dest)).then((r) => {
      if (cut) { clipboard = null; paths.forEach((p, i) => { if (r.paths[i] && r.paths[i] !== p) editor.renamed(p, r.paths[i]); }); }
      setSelected(new Set(r.paths)); setAnchor(r.paths[0] ?? null);
      onRefresh();
    }).catch(fail);
  };
  const trash = () => {
    if (!selectedEntries.length) return;
    const paths = selectedEntries.map((e) => e.path);
    api.fsTrash(paths).then(() => { editor.removed(paths); setSelected(new Set()); onRefresh(); }).catch(fail);
  };
  const startRename = () => { const e = selectedEntries[0]; if (e) { setRenaming(e.path); setDraft(e.name); } };
  const commitRename = () => {
    const target = renaming; setRenaming(null);
    if (!target) return;
    const cur = entries.find((e) => e.path === target);
    if (!cur || draft === cur.name || !draft.trim()) return;
    api.fsRename(target, draft.trim()).then((r) => { editor.renamed(target, r.path); onRefresh(); }).catch(fail);
  };
  const createEntry = () => {
    const kind = creating;
    setCreating(false);
    if (!listing || !kind || !draft.trim()) return;
    if (kind === 'folder') api.fsMkdir(listing.path, draft.trim()).then(onRefresh).catch(fail);
    else api.fsCreate(listing.path, draft.trim()).then((r) => { onRefresh(); return api.stat(r.path).then(onPreview); }).catch(fail);
  };
  const duplicate = () => { const e = selectedEntries[0]; if (e) api.fsDuplicate(e.path).then(onRefresh).catch(fail); };
  const newFolder = () => { setDraft(t('files.untitledFolder')); setCreating('folder'); };
  const newFile = () => { setDraft(''); setCreating('file'); };

  const onKey = useCallback((ev: React.KeyboardEvent) => {
    if (onFind(ev)) return;
    if (renaming || creating || searching) return;
    const mod = ev.metaKey || ev.ctrlKey;
    const idx = anchor ? entries.findIndex((e) => e.path === anchor) : -1;
    const moveTo = (i: number) => { const e = entries[Math.max(0, Math.min(entries.length - 1, i))]; if (e) { setSelected(new Set([e.path])); setAnchor(e.path); } };
    if (!mod && ev.key === 'ArrowDown') { ev.preventDefault(); moveTo(idx + 1); }
    else if (!mod && ev.key === 'ArrowUp') { ev.preventDefault(); moveTo(idx - 1); }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (selectedEntries.length === 1) startRename(); }
    else if (mod && ev.key === 'ArrowDown') { ev.preventDefault(); const e = selectedEntries[0]; if (e) open(e); }
    else if (mod && ev.key === 'ArrowUp') { ev.preventDefault(); if (listing?.parent) onNavigate(listing.parent); }
    else if (ev.key === ' ') { ev.preventDefault(); const e = selectedEntries[0]; if (e && !e.isDir) onPreview(e); }
    else if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); setSelected(new Set(entries.map((e) => e.path))); }
    else if (mod && ev.key.toLowerCase() === 'c') { ev.preventDefault(); copy(false); }
    else if (mod && ev.key.toLowerCase() === 'x') { ev.preventDefault(); copy(true); }
    else if (mod && ev.key.toLowerCase() === 'v') { ev.preventDefault(); void paste(); }
    else if (mod && ev.key.toLowerCase() === 'd') { ev.preventDefault(); duplicate(); }
    else if (mod && ev.key === 'Backspace') { ev.preventDefault(); trash(); }
    else if (ev.key === 'Backspace' && !mod) { ev.preventDefault(); if (listing?.parent) onNavigate(listing.parent); }
    else if (mod && ev.shiftKey && ev.key.toLowerCase() === 'n') { ev.preventDefault(); newFolder(); }
    else if (ev.key === 'Escape') setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, anchor, selectedEntries, listing, renaming, creating, searching]);

  const itemMenu = (e: Entry): MenuItem[] => {
    const sel = selected.has(e.path) ? selectedEntries : [e];
    if (!selected.has(e.path)) { setSelected(new Set([e.path])); setAnchor(e.path); }
    const many = sel.length > 1;
    return [
      { label: e.isDir ? t('common.open') : t('files.preview'), onClick: () => open(e) },
      ...(onOpenInIde && !e.isDir && !many ? [{ label: t('files.openInIde'), onClick: () => onOpenInIde(e) }] : []),
      ...(onAttach ? [{ label: many ? t('files.attachNToChat', { n: sel.length }) : t('files.attachToChat'), onClick: () => onAttach(sel) }] : []),
      { separator: true },
      { label: t('common.revealInFinder'), onClick: () => api.open(e.path, 'finder').catch(fail) },
      ...(e.isDir ? [{ label: t('common.openInTerminal'), onClick: () => api.open(e.path, 'terminal').catch(fail) }] : []),
      { label: t('common.openInVSCode'), onClick: () => api.open(e.path, 'vscode').catch(fail) },
      { label: t('common.openInCursor'), onClick: () => api.open(e.path, 'cursor').catch(fail) },
      { label: many ? t('common.copyPaths') : t('common.copyPath'), onClick: () => navigator.clipboard.writeText(sel.map((x) => x.path).join('\n')) },
      { separator: true },
      { label: t('common.copy'), shortcut: '⌘C', onClick: () => copy(false, sel) },
      { label: t('common.cut'), shortcut: '⌘X', onClick: () => copy(true, sel) },
      { label: t('common.paste'), shortcut: '⌘V', onClick: () => void paste() },
      { label: t('files.duplicate'), shortcut: '⌘D', disabled: many, onClick: () => api.fsDuplicate(e.path).then(onRefresh).catch(fail) },
      { label: t('files.renameItem'), shortcut: '⏎', disabled: many, onClick: () => { setRenaming(e.path); setDraft(e.name); } },
      { separator: true },
      { label: t('files.moveToTrash'), shortcut: '⌘⌫', danger: true, onClick: () => api.fsTrash(sel.map((x) => x.path)).then(() => { editor.removed(sel.map((x) => x.path)); setSelected(new Set()); onRefresh(); }).catch(fail) },
    ];
  };
  const bgMenu = (): MenuItem[] => [
    { label: t('tree.newFile'), onClick: newFile },
    { label: t('files.newFolderMenu'), shortcut: '⇧⌘N', onClick: newFolder },
    { label: t('common.paste'), shortcut: '⌘V', onClick: () => void paste() },
    { separator: true },
    { label: t('common.openInTerminal'), onClick: () => listing && api.open(listing.path, 'terminal').catch(fail) },
    { label: t('common.openInVSCode'), onClick: () => listing && api.open(listing.path, 'vscode').catch(fail) },
    { label: t('common.openInCursor'), onClick: () => listing && api.open(listing.path, 'cursor').catch(fail) },
    { label: t('common.revealInFinder'), onClick: () => listing && api.open(listing.path, 'finder').catch(fail) },
    { label: t('common.copyPath'), onClick: () => listing && navigator.clipboard.writeText(listing.path) },
    { separator: true },
    { label: isFavorite ? t('sidebar.removeFavorite') : t('sidebar.addFavorite'), onClick: onToggleFavorite },
    { label: showHidden ? t('files.hideHidden') : t('files.showHidden'), onClick: () => setShowHidden((v) => !v) },
    { label: t('common.refresh'), onClick: onRefresh },
  ];

  return (
    <div ref={root} tabIndex={0} onKeyDown={onKey} data-own-find className="flex flex-col h-full min-w-0 outline-none">
      <div className="h-10 flex items-center gap-2 px-3 border-b border-white/10 text-sm">
        <button className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10 text-zinc-300 disabled:opacity-30 transition-colors" disabled={!listing?.parent} onClick={() => listing?.parent && onNavigate(listing.parent)} title={t('files.parentFolder')}><Icon name="left" /></button>
        <div className="flex items-center gap-1 overflow-x-auto whitespace-nowrap text-zinc-400">
          <span className="cursor-pointer hover:text-white" onClick={() => onNavigate('/')}>/</span>
          {crumbs.map((c, i) => {
            const p = '/' + crumbs.slice(0, i + 1).join('/');
            return <span key={p} className="flex items-center gap-1"><span className="text-zinc-600">›</span><span className={`cursor-pointer hover:text-white ${i === crumbs.length - 1 ? 'text-white' : ''}`} onClick={() => onNavigate(p)}>{c}</span></span>;
          })}
        </div>
        <div className="flex-1" />
        {note && <span className="text-[11px] text-amber-300 truncate max-w-40" title={note}>{note}</span>}
        <button className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10 text-zinc-400 transition-colors" onClick={newFile} title={t('files.newFile')}><Icon name="filePlus" /></button>
        <button className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10 text-zinc-400 transition-colors" onClick={newFolder} title={t('files.newFolder')}><Icon name="folderPlus" /></button>
        <button className={`w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10 ${isFavorite ? 'text-amber-300' : 'text-zinc-400'} transition-colors`} onClick={onToggleFavorite} title={isFavorite ? t('sidebar.removeFavorite') : t('sidebar.addFavorite')}><Icon name="star" filled={isFavorite} /></button>
      </div>
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-white/5">
        <Icon name="search" size={14} className="text-zinc-500" />
        <input ref={searchInput} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('files.searchPlaceholder')} aria-label={t('files.searchPlaceholder')}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.nativeEvent.isComposing) return;
            if (onFind(e)) return;
            const n = hits?.length ?? 0;
            if (e.key === 'Escape') { e.preventDefault(); setQuery(''); root.current?.focus(); }
            else if (e.key === 'ArrowDown' && n) { e.preventDefault(); setHitIdx((i) => (i + 1) % n); }
            else if (e.key === 'ArrowUp' && n) { e.preventDefault(); setHitIdx((i) => (i - 1 + n) % n); }
            else if (e.key === 'Enter' && hits?.[hitIdx]) { e.preventDefault(); openHit(hits[hitIdx]); }
          }}
          className="flex-1 min-w-0 bg-transparent text-[13px] outline-none placeholder:text-zinc-600" />
        {searching && <span className="text-[10px] text-zinc-500 tabular-nums">{hits === null ? '…' : t('files.searchCount', { n: hits.length })}</span>}
        {searching && <button className="w-6 h-6 flex items-center justify-center rounded-full text-zinc-500 hover:text-white hover:bg-white/10 transition-colors" onClick={() => setQuery('')} title="Esc"><Icon name="close" size={12} /></button>}
      </div>

      {searching ? (
        <div className="flex-1 overflow-y-auto py-1">
          {hits?.length === 0 && <div className="p-6 text-center text-sm text-zinc-600">{t('files.searchNone')}</div>}
          {hits?.map((h, i) => {
            const slash = h.rel.lastIndexOf('/');
            return (
              <div key={h.path} onMouseEnter={() => setHitIdx(i)} onClick={() => openHit(h)} onContextMenu={(ev) => menu.open(ev, hitMenu(h))} title={h.path}
                draggable onDragStart={(ev) => { ev.dataTransfer.setData('text/plain', h.path); ev.dataTransfer.setData('application/x-vibe-path', h.path); }}
                className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer ${i === hitIdx ? 'bg-blue-500/20' : 'hover:bg-white/5'}`}>
                <FileIcon name={h.rel.slice(slash + 1)} isDir={h.isDir} />
                <span className="truncate">{h.rel.slice(slash + 1)}</span>
                {slash > 0 && <span className="truncate text-[11px] text-zinc-500 font-mono">{h.rel.slice(0, slash)}</span>}
              </div>
            );
          })}
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto" onContextMenu={(e) => menu.open(e, bgMenu())} onClick={(e) => { if (e.target === e.currentTarget) setSelected(new Set()); }}>
        {error && (
          <div className="m-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm">
            <div className="font-medium text-red-300">{error.code}</div>
            <div className="text-zinc-300 mt-1 whitespace-pre-wrap">{error.message}</div>
            {error.code === 'EACCES' && <a className="inline-block mt-3 text-xs underline text-blue-300" href="x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles">{t('files.fullDisk')}</a>}
          </div>
        )}
        {listing && (
          <table className="w-full text-sm">
            <tbody>
              {creating && (
                <tr className="bg-blue-500/10"><td className="w-9 pl-3 pr-2 py-1.5"><FileIcon name={draft || 'file'} isDir={creating === 'folder'} /></td>
                  <td colSpan={3} className="py-1 pr-3"><input autoFocus value={draft} placeholder={creating === 'file' ? t('tree.newFilePlaceholder') : undefined} onChange={(e) => setDraft(e.target.value)} onBlur={createEntry} onKeyDown={(e) => { e.stopPropagation(); if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') createEntry(); if (e.key === 'Escape') setCreating(false); }} className="w-full bg-black/40 rounded px-2 py-0.5 outline-none border border-blue-400/50" /></td></tr>
              )}
              {entries.map((e) => (
                <tr key={e.path}
                  className={`cursor-default border-b border-white/5 ${selected.has(e.path) ? 'bg-blue-500/25' : 'hover:bg-white/5'} ${e.hidden ? 'opacity-50' : ''}`}
                  onClick={(ev) => select(e, ev)} onDoubleClick={() => open(e)} onContextMenu={(ev) => menu.open(ev, itemMenu(e))}
                  draggable
                  onDragStart={(ev) => { const paths = selected.has(e.path) ? selectedEntries.map((x) => x.path) : [e.path]; ev.dataTransfer.setData('text/plain', paths.join('\n')); ev.dataTransfer.setData('application/x-vibe-path', paths.join('\n')); }}
                >
                  <td className="w-9 pl-3 pr-2 py-1.5"><FileIcon name={e.name} isDir={e.isDir} /></td>
                  <td className="py-1.5 pl-1 truncate max-w-0 w-full">
                    {renaming === e.path
                      ? <input autoFocus value={draft} onChange={(ev) => setDraft(ev.target.value)} onBlur={commitRename} onClick={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}
                          onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') commitRename(); if (ev.key === 'Escape') setRenaming(null); }}
                          className="w-full bg-black/40 rounded px-2 py-0.5 outline-none border border-blue-400/50" />
                      : e.name}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-zinc-500 whitespace-nowrap">{e.isDir ? '' : formatSize(e.size)}</td>
                  <td className="py-1.5 pr-3 text-right text-zinc-600 whitespace-nowrap hidden lg:table-cell">{new Date(e.mtime).toLocaleDateString()}</td>
                </tr>
              ))}
              {entries.length === 0 && !creating && <tr><td className="p-6 text-center text-zinc-600" colSpan={4}>{t('files.empty')}</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      )}
      <div className="h-6 shrink-0 flex items-center px-3 text-[10px] text-zinc-600 border-t border-white/5">
        {selected.size > 0 ? t('files.selected', { n: selected.size }) : t('files.items', { n: entries.length })} · {t('files.footerHint')}
      </div>
    </div>
  );
}
