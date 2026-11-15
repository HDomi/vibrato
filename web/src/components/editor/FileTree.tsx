import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type Entry } from '../../lib/api';
import { editor } from '../../lib/editor/store';
import { M } from '../../lib/editor/theme';
import { t, useLang } from '../../lib/i18n';
import { useContextMenu, type MenuItem } from '../ContextMenu';
import FileIcon from '../FileIcon';
import Icon from '../Icon';
import { isInside, lastSegment, parentDir } from '../../lib/paths';

interface Props {
  root: string;
  activePath: string | null;
  onAttach?: (entries: Entry[]) => void;
}

type Row =
  | { type: 'entry'; entry: Entry; depth: number }
  | { type: 'loading'; depth: number; key: string }
  | { type: 'create'; dir: string; kind: 'file' | 'folder'; depth: number };

const ROW = 22;
const OVERSCAN = 12;
const HIDE = new Set(['.git', '.DS_Store']);
const LS_EXPANDED = 'vibe.tree.expanded:';
const dirOf = parentDir;

/**
 * Project explorer: lazily loaded, virtualized (only the rows on screen are in the DOM, so a
 * 5,000-entry node_modules costs the same as a small folder) and kept live by the store's
 * recursive watch — no refresh button needed.
 */
export default function FileTree({ root, activePath, onAttach }: Props) {
  useLang();
  const menu = useContextMenu();
  const children = useRef(new Map<string, Entry[]>());
  const [tick, setTick] = useState(0);
  const bump = () => setTick((x) => x + 1);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(LS_EXPANDED + root) ?? '[]') as string[]); } catch { return new Set(); }
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; draft: string } | null>(null);
  const [creating, setCreating] = useState<{ dir: string; kind: 'file' | 'folder'; draft: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const pending = useRef(new Map<string, Promise<void>>());

  const fail = (e: unknown) => setNote((e as Error).message ?? String(e));
  useEffect(() => { if (!note) return; const id = setTimeout(() => setNote(null), 3000); return () => clearTimeout(id); }, [note]);

  const load = useCallback((dir: string): Promise<void> => {
    let p = pending.current.get(dir);
    if (p) return p;
    p = api.list(dir).then((l) => {
      children.current.set(dir, l.entries.filter((e) => !HIDE.has(e.name)));
    }).catch(() => {
      children.current.delete(dir);
    }).finally(() => { pending.current.delete(dir); bump(); });
    pending.current.set(dir, p);
    return p;
  }, []);

  // New root: start over, then load the root and every folder that was open last time.
  useEffect(() => {
    children.current = new Map();
    let saved: string[] = [];
    try { saved = JSON.parse(localStorage.getItem(LS_EXPANDED + root) ?? '[]') as string[]; } catch { /* ignore */ }
    const set = new Set(saved.filter((p) => isInside(p, root)));
    setExpanded(set);
    void load(root);
    for (const p of set) void load(p);
  }, [root, load]);
  useEffect(() => { try { localStorage.setItem(LS_EXPANDED + root, JSON.stringify([...expanded])); } catch { /* ignore */ } }, [root, expanded]);

  // Live: refetch only folders that are loaded and were touched.
  useEffect(() => editor.onFsChange((change) => {
    const dirs = new Set<string>();
    if (change === '*') for (const d of children.current.keys()) dirs.add(d);
    else for (const p of change) {
      const d = dirOf(p);
      if (children.current.has(d)) dirs.add(d);
      if (children.current.has(p)) dirs.add(p);
    }
    for (const d of dirs) void load(d);
  }), [load]);

  const toggle = (dir: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const want = open ?? !next.has(dir);
      if (want) { next.add(dir); if (!children.current.has(dir)) void load(dir); } else next.delete(dir);
      return next;
    });
  };

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      if (creating?.dir === dir) out.push({ type: 'create', dir, kind: creating.kind, depth });
      const list = children.current.get(dir);
      if (!list) { out.push({ type: 'loading', depth, key: dir }); return; }
      for (const e of list) {
        out.push({ type: 'entry', entry: e, depth });
        if (e.isDir && expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    walk(root, 0);
    return out;
    // `tick` stands for the children map, which is mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, expanded, creating?.dir, creating?.kind, tick]);

  // Reveal the active editor tab: open its folders and scroll it into view.
  useEffect(() => {
    if (!activePath || !isInside(activePath, root)) return;
    let alive = true;
    const chain: string[] = [];
    for (let d = dirOf(activePath); d.length > root.length; d = dirOf(d)) chain.unshift(d);
    void (async () => {
      for (const d of chain) if (!children.current.has(d)) await load(d);
      if (!alive) return;
      setExpanded((prev) => (chain.every((d) => prev.has(d)) ? prev : new Set([...prev, ...chain])));
      setSelected(activePath);
    })();
    return () => { alive = false; };
  }, [activePath, root, load]);
  const selIndex = rows.findIndex((r) => r.type === 'entry' && r.entry.path === selected);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || selIndex < 0) return;
    const top = selIndex * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  }, [selIndex]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const frame = useRef(0);
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; setScrollTop(scroller.current?.scrollTop ?? 0); });
  };

  /* ── actions ── */
  const openFile = (e: Entry, preview: boolean) => editor.open(e.path, { preview, kind: e.kind });
  const startCreate = (dir: string, kind: 'file' | 'folder') => {
    if (dir !== root) toggle(dir, true);
    setCreating({ dir, kind, draft: '' });
  };
  const commitCreate = () => {
    const c = creating; setCreating(null);
    const name = c?.draft.trim();
    if (!c || !name) return;
    (c.kind === 'file' ? api.fsCreate(c.dir, name) : api.fsMkdir(c.dir, name)).then(async (r) => {
      await load(c.dir);
      setSelected(r.path);
      if (c.kind === 'file') editor.open(r.path, { kind: 'text' });
    }).catch(fail);
  };
  const commitRename = () => {
    const r = renaming; setRenaming(null);
    if (!r) return;
    const name = r.draft.trim();
    if (!name || name === lastSegment(r.path)) return;
    api.fsRename(r.path, name).then(async (res) => {
      editor.renamed(r.path, res.path);
      if (expanded.has(r.path)) setExpanded((prev) => new Set([...prev].map((p) => (p === r.path || isInside(p, r.path) ? res.path + p.slice(r.path.length) : p))));
      await load(dirOf(r.path));
      setSelected(res.path);
    }).catch(fail);
  };
  const trash = (e: Entry) => {
    api.fsTrash([e.path]).then(() => { editor.removed([e.path]); void load(dirOf(e.path)); }).catch(fail);
  };
  const rel = (p: string) => p.slice(root.length + 1);

  const entryMenu = (e: Entry): MenuItem[] => {
    const dir = e.isDir ? e.path : dirOf(e.path);
    return [
      ...(!e.isDir ? [{ label: t('common.open'), onClick: () => openFile(e, false) }] : []),
      ...(onAttach && !e.isDir ? [{ label: t('files.attachToChat'), onClick: () => onAttach([e]) }] : []),
      ...(!e.isDir ? [{ separator: true }] : []),
      { label: t('tree.newFile'), onClick: () => startCreate(dir, 'file') },
      { label: t('files.newFolderMenu'), onClick: () => startCreate(dir, 'folder') },
      { separator: true },
      { label: t('files.renameItem'), shortcut: '⏎', onClick: () => setRenaming({ path: e.path, draft: e.name }) },
      { label: t('files.duplicate'), onClick: () => api.fsDuplicate(e.path).then(() => load(dirOf(e.path))).catch(fail) },
      { label: t('files.moveToTrash'), shortcut: '⌘⌫', danger: true, onClick: () => trash(e) },
      { separator: true },
      { label: t('common.revealInFinder'), onClick: () => api.open(e.path, 'finder').catch(fail) },
      ...(e.isDir ? [{ label: t('common.openInTerminal'), onClick: () => api.open(e.path, 'terminal').catch(fail) }] : []),
      { label: t('common.copyPath'), onClick: () => navigator.clipboard.writeText(e.path) },
      { label: t('tree.copyRelativePath'), onClick: () => navigator.clipboard.writeText(rel(e.path)) },
    ];
  };
  const bgMenu = (): MenuItem[] => [
    { label: t('tree.newFile'), onClick: () => startCreate(root, 'file') },
    { label: t('files.newFolderMenu'), onClick: () => startCreate(root, 'folder') },
    { separator: true },
    { label: t('tree.collapseAll'), onClick: () => setExpanded(new Set()) },
    { label: t('common.refresh'), onClick: () => { for (const d of [...children.current.keys()]) void load(d); } },
  ];

  const entryRows = rows.filter((r): r is Extract<Row, { type: 'entry' }> => r.type === 'entry');
  const onKey = (ev: React.KeyboardEvent) => {
    if (renaming || creating) return;
    const i = entryRows.findIndex((r) => r.entry.path === selected);
    const cur = entryRows[i]?.entry;
    const mod = ev.metaKey || ev.ctrlKey;
    const go = (n: number) => { const r = entryRows[Math.max(0, Math.min(entryRows.length - 1, n))]; if (r) setSelected(r.entry.path); };
    if (ev.key === 'ArrowDown' && !mod) { ev.preventDefault(); go(i + 1); }
    else if (ev.key === 'ArrowUp' && !mod) { ev.preventDefault(); go(i - 1); }
    else if (ev.key === 'ArrowRight' && cur?.isDir) { ev.preventDefault(); if (!expanded.has(cur.path)) toggle(cur.path, true); else go(i + 1); }
    else if (ev.key === 'ArrowLeft' && cur) {
      ev.preventDefault();
      if (cur.isDir && expanded.has(cur.path)) toggle(cur.path, false);
      else { const parent = dirOf(cur.path); if (parent !== root) setSelected(parent); }
    }
    else if (ev.key === 'Enter' && cur) { ev.preventDefault(); setRenaming({ path: cur.path, draft: cur.name }); }
    else if ((ev.key === ' ' || (mod && ev.key === 'ArrowDown')) && cur) { ev.preventDefault(); if (cur.isDir) toggle(cur.path); else openFile(cur, !mod); }
    else if (mod && ev.key === 'Backspace' && cur) { ev.preventDefault(); trash(cur); }
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN);
  const indent = (depth: number) => 8 + depth * 12;
  const inputCls = 'flex-1 min-w-0 rounded-sm px-1 outline-none text-[12.5px]';
  const inputStyle = { background: M.input, color: M.fg, border: `1px solid ${M.accent}` };

  return (
    <div className="h-full flex flex-col min-w-0" style={{ background: M.sidebar, color: M.dim }}>
      <div className="h-8 shrink-0 flex items-center gap-1 pl-3 pr-1 text-[11px] uppercase tracking-wide" style={{ color: M.fg, borderBottom: `1px solid ${M.border}` }}>
        <span className="flex-1 truncate" title={root}>{lastSegment(root) || root}</span>
        {note && <span className="normal-case tracking-normal text-[10px] truncate max-w-28" style={{ color: M.yellow }} title={note}>{note}</span>}
        <button className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10" title={t('tree.newFile')} onClick={() => startCreate(selectedDir(), 'file')}><Icon name="filePlus" size={14} /></button>
        <button className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10" title={t('files.newFolderMenu')} onClick={() => startCreate(selectedDir(), 'folder')}><Icon name="folderPlus" size={14} /></button>
        <button className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10" title={t('tree.collapseAll')} onClick={() => setExpanded(new Set())}><Icon name="collapse" size={14} /></button>
      </div>
      <div ref={scroller} tabIndex={0} onKeyDown={onKey} onScroll={onScroll} onContextMenu={(e) => menu.open(e, bgMenu())}
        className="flex-1 min-h-0 overflow-auto outline-none text-[12.5px] select-none">
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          {rows.slice(start, end).map((r, k) => {
            const top = (start + k) * ROW;
            const base = { position: 'absolute' as const, top, left: 0, right: 0, height: ROW, paddingLeft: indent(r.depth) };
            if (r.type === 'loading') return <div key={`l:${r.key}`} style={base} className="flex items-center text-[11px] pl-5 opacity-60">…</div>;
            if (r.type === 'create') {
              return (
                <div key="create" style={base} className="flex items-center gap-1.5 pr-2">
                  <span className="w-3" />
                  <FileIcon name={creating?.draft || (r.kind === 'folder' ? 'folder' : 'file')} isDir={r.kind === 'folder'} className="w-4 h-4" />
                  <input autoFocus value={creating?.draft ?? ''} placeholder={r.kind === 'file' ? t('tree.newFilePlaceholder') : t('files.untitledFolder')}
                    onChange={(e) => setCreating((c) => (c ? { ...c, draft: e.target.value } : c))}
                    onBlur={commitCreate}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.nativeEvent.isComposing) return; if (e.key === 'Enter') commitCreate(); if (e.key === 'Escape') setCreating(null); }}
                    className={inputCls} style={inputStyle} />
                </div>
              );
            }
            const e = r.entry;
            const isSel = selected === e.path;
            const isActive = activePath === e.path;
            const open = e.isDir && expanded.has(e.path);
            return (
              <div key={e.path} style={{ ...base, color: isSel || isActive ? M.accent : e.hidden ? M.faint : undefined, background: isSel ? '#ffffff0d' : undefined }}
                className="flex items-center gap-1.5 pr-2 cursor-default hover:bg-white/[0.04] hover:text-white"
                title={e.path}
                onClick={() => { setSelected(e.path); if (e.isDir) toggle(e.path); else openFile(e, true); }}
                onDoubleClick={() => { if (!e.isDir) editor.pin(e.path); }}
                onContextMenu={(ev) => { setSelected(e.path); menu.open(ev, entryMenu(e)); }}
                draggable={!renaming}
                onDragStart={(ev) => { ev.dataTransfer.setData('text/plain', e.path); ev.dataTransfer.setData('application/x-vibe-path', e.path); }}>
                <span className="w-3 flex items-center justify-center" style={{ color: M.faint }}>
                  {e.isDir && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: open ? 'rotate(90deg)' : undefined }}><path d="M9 18l6-6-6-6" /></svg>}
                </span>
                <FileIcon name={e.name} isDir={e.isDir} className="w-4 h-4" />
                {renaming?.path === e.path
                  ? <input autoFocus value={renaming.draft} onChange={(ev) => setRenaming({ path: e.path, draft: ev.target.value })} onBlur={commitRename}
                      onClick={(ev) => ev.stopPropagation()}
                      onFocus={(ev) => { const dot = e.isDir ? -1 : e.name.lastIndexOf('.'); ev.target.setSelectionRange(0, dot > 0 ? dot : e.name.length); }}
                      onKeyDown={(ev) => { ev.stopPropagation(); if (ev.nativeEvent.isComposing) return; if (ev.key === 'Enter') commitRename(); if (ev.key === 'Escape') setRenaming(null); }}
                      className={inputCls} style={inputStyle} />
                  : <span className="truncate">{e.name}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  function selectedDir() {
    const r = entryRows.find((x) => x.entry.path === selected);
    if (!r) return root;
    return r.entry.isDir ? r.entry.path : dirOf(r.entry.path);
  }
}
