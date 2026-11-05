import { useEffect, useMemo, useRef, useState } from 'react';
import { indentUnit as indentUnitFacet } from '@codemirror/language';
import type { Entry } from '../../lib/api';
import { api } from '../../lib/api';
import { editor, useEditor, type Doc } from '../../lib/editor/store';
import { LANGS } from '../../lib/editor/languages';
import { M } from '../../lib/editor/theme';
import { t, useLang } from '../../lib/i18n';
import { useContextMenu, type MenuItem } from '../ContextMenu';
import FileIcon from '../FileIcon';
import Icon from '../Icon';
import MarkdownView from '../MarkdownView';
import MediaView from './MediaView';
import Splitter, { usePaneWidth } from '../Splitter';
import CodeEditor from './CodeEditor';
import FileTree from './FileTree';
import { shortcutKey } from '../../lib/keys';

interface Props { root: string | null; visible: boolean; onAttach?: (entries: Entry[]) => void }

const LS_TREE = 'vibe.editor.tree';
const MEDIA = ['image', 'video', 'audio', 'pdf'];
const isText = (d: Doc | null) => !!d && d.status === 'ready' && !!d.state && !(d.kind && MEDIA.includes(d.kind));

export default function EditorPanel({ root, visible, onAttach }: Props) {
  useLang();
  const ed = useEditor();
  const menu = useContextMenu();
  const [tree, setTree] = useState(() => { try { return localStorage.getItem(LS_TREE) !== '0'; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem(LS_TREE, tree ? '1' : '0'); } catch { /* ignore */ } }, [tree]);
  const treeW = usePaneWidth('vibe.w.tree', 260, 160, 520);
  useEffect(() => { const h = () => setTree((v) => !v); window.addEventListener('vibe:toggle-tree', h); return () => window.removeEventListener('vibe:toggle-tree', h); }, []);
  const dragStart = useRef(0);
  const doc = ed.activeDoc;
  // A new focus request each time the active tab changes (or the panel is shown).
  const [focusKey, setFocusKey] = useState(0);
  useEffect(() => { if (visible && doc) setFocusKey((k) => k + 1); }, [ed.active, visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => { tabsRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [ed.active]);

  const onKey = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.defaultPrevented) return;
    // Physical key for non-ASCII e.key: Korean input (⌘ㄴ) and ⌥ ("ß" for ⌥⌘S).
    const k = shortcutKey(e);
    if (k === 'w') { e.preventDefault(); if (ed.active) ed.close(ed.active); }
    else if (k === 's' && e.altKey) { e.preventDefault(); void ed.saveAll(); }
    else if (k === 's') { e.preventDefault(); if (ed.active) void ed.save(ed.active); }
    else if (e.shiftKey && (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}')) {
      e.preventDefault();
      const i = ed.tabs.findIndex((x) => x.path === ed.active);
      const n = ed.tabs.length;
      if (n) ed.activate(ed.tabs[(i + (e.key === '[' || e.key === '{' ? -1 : 1) + n) % n].path);
    }
  };

  const tabMenu = (path: string): MenuItem[] => [
    { label: t('editor.close'), shortcut: '⌘W', onClick: () => ed.close(path) },
    { label: t('editor.closeOthers'), onClick: () => ed.closeOthers(path) },
    { label: t('editor.closeAll'), onClick: () => ed.closeAll() },
    { separator: true },
    { label: t('common.copyPath'), onClick: () => navigator.clipboard.writeText(path) },
    { label: t('common.revealInFinder'), onClick: () => api.open(path, 'finder').catch(() => {}) },
  ];
  const dragTab = useRef<number | null>(null);

  const mdText = useMemo(() => (doc?.kind === 'markdown' && doc.mdMode === 'preview' && doc.state ? doc.state.doc.toString() : ''), [doc, doc?.mdMode, doc?.state?.doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const showCode = isText(doc) && !(doc!.kind === 'markdown' && doc!.mdMode === 'preview');

  return (
    <div data-editor-scope data-own-find className="h-full flex-1 flex min-w-0" style={{ background: M.bg, color: M.fg }} onKeyDown={onKey}>
      {tree && root && (
        <>
          <div className="shrink-0 min-w-0" style={{ width: treeW.width }}><FileTree root={root} activePath={ed.active} onAttach={onAttach} /></div>
          <Splitter onStart={() => { dragStart.current = treeW.width; }} onDrag={(dx) => treeW.setWidth(dragStart.current + dx)} />
        </>
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="h-8 shrink-0 flex items-stretch" style={{ background: M.bg, borderBottom: `1px solid ${M.border}` }}>
          {root && (
            <button className="shrink-0 w-8 flex items-center justify-center hover:text-white" style={{ color: tree ? M.fg : M.faint }} title={`${t('editor.toggleTree')} (⌘B)`} onClick={() => setTree((v) => !v)}>
              <Icon name="sidebar" size={14} />
            </button>
          )}
          <div ref={tabsRef} className="flex-1 min-w-0 flex items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {ed.tabs.map((tab, i) => {
              const d = ed.docs.get(tab.path);
              const active = tab.path === ed.active;
              return (
                <div key={tab.path} data-active={active} title={tab.path} draggable
                  onDragStart={() => { dragTab.current = i; }}
                  onDragOver={(e) => { if (dragTab.current !== null) e.preventDefault(); }}
                  onDrop={() => { if (dragTab.current !== null && dragTab.current !== i) ed.move(dragTab.current, i); dragTab.current = null; }}
                  onClick={() => ed.activate(tab.path)}
                  onDoubleClick={() => ed.pin(tab.path)}
                  onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); ed.close(tab.path); } }}
                  onContextMenu={(e) => menu.open(e, tabMenu(tab.path))}
                  className="group shrink-0 flex items-center gap-1.5 pl-3 pr-1.5 text-[12px] cursor-default"
                  style={{ color: active ? '#FFFFFF' : M.dim, background: active ? M.bg : M.sidebar, boxShadow: active ? `inset 0 -2px 0 ${M.accent}` : undefined, borderRight: `1px solid ${M.border}` }}>
                  <FileIcon name={d?.name ?? tab.path} isDir={false} className="w-3.5 h-3.5" />
                  <span className={`max-w-40 truncate ${tab.preview ? 'italic' : ''}`}>{d?.name}</span>
                  <button className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10" onClick={(e) => { e.stopPropagation(); ed.close(tab.path); }} title={t('editor.close')}>
                    {d?.dirty
                      ? <><span className="group-hover:hidden w-2 h-2 rounded-full" style={{ background: d.conflict ? M.yellow : M.fg }} /><span className="hidden group-hover:block"><Icon name="close" size={11} /></span></>
                      : <span className={active ? '' : 'opacity-0 group-hover:opacity-100'}><Icon name="close" size={11} /></span>}
                  </button>
                </div>
              );
            })}
          </div>
          {doc?.kind === 'markdown' && isText(doc) && (
            <button className="shrink-0 px-2.5 text-[11px] hover:text-white" style={{ color: M.dim }} onClick={() => ed.setMdMode(doc.path, doc.mdMode === 'preview' ? 'edit' : 'preview')}>
              {doc.mdMode === 'preview' ? t('editor.editSource') : t('editor.showPreview')}
            </button>
          )}
        </div>

        {doc && <Banner doc={doc} />}

        <div className="flex-1 min-h-0 relative">
          <CodeEditor doc={isText(doc) ? doc : null} hidden={!showCode} focusKey={showCode ? focusKey : 0} />
          {!doc && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-[13px]" style={{ color: M.faint }}>
              <div>{t('editor.emptyHint')}</div>
              <div className="text-[11px]">⌘P {t('editor.quickOpen')} · ⌘S {t('editor.save')} · ⌘F {t('editor.find')}</div>
            </div>
          )}
          {doc && (doc.status === 'loading' || doc.status === 'idle') && <div className="absolute inset-0 p-4 text-[13px]" style={{ color: M.faint }}>{t('common.loading')}</div>}
          {doc?.status === 'error' && <div className="absolute inset-0 p-4 text-[13px]" style={{ color: M.red }}>{doc.error}</div>}
          {doc?.status === 'binary' && <div className="absolute inset-0"><MediaView path={doc.path} name={doc.name} kind="binary" /></div>}
          {doc?.status === 'ready' && doc.kind && MEDIA.includes(doc.kind) && <div className="absolute inset-0" style={{ background: '#0b0d12' }}><MediaView path={doc.path} name={doc.name} kind={doc.kind} rev={doc.rev} /></div>}
          {doc?.kind === 'markdown' && doc.mdMode === 'preview' && isText(doc) && (
            <div className="absolute inset-0 overflow-auto p-5" style={{ background: '#0b0d12' }}>
              <MarkdownView text={mdText} baseDir={doc.path.slice(0, doc.path.lastIndexOf('/'))} className="prose-md max-w-3xl text-[15px] text-[#e6e8ee]" />
            </div>
          )}
        </div>

        {doc && isText(doc) && <StatusBar doc={doc} />}
      </div>
    </div>
  );
}

function Banner({ doc }: { doc: Doc }) {
  const bar = (tone: string, text: string, actions: [string, () => void][]) => (
    <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 text-[12px]" style={{ background: `${tone}18`, color: tone, borderBottom: `1px solid ${M.border}` }}>
      <span className="flex-1 min-w-0">{text}</span>
      {actions.map(([label, run]) => <button key={label} className="shrink-0 px-2 py-0.5 rounded hover:bg-white/10" style={{ border: `1px solid ${tone}60` }} onClick={run}>{label}</button>)}
    </div>
  );
  if (doc.conflict === 'changed') return bar(M.yellow, t('editor.conflictChanged'), [[t('editor.loadDisk'), () => void editor.revert(doc.path)], [t('editor.overwrite'), () => void editor.save(doc.path, true)]]);
  if (doc.conflict === 'deleted') return bar(M.red, t('editor.conflictDeleted'), [[t('editor.saveAgain'), () => void editor.save(doc.path, true)], [t('editor.close'), () => editor.close(doc.path, true)]]);
  if (doc.readOnly === 'truncated') return bar(M.dim, t('editor.readOnlyTruncated'), []);
  if (doc.readOnly === 'lossy') return bar(M.dim, t('editor.readOnlyLossy'), []);
  return null;
}

function StatusBar({ doc }: { doc: Doc }) {
  const [, force] = useState(0);
  useEffect(() => editor.onCursor(() => force((x) => x + 1)), []);
  const state = doc.state!;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  const chosen = state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0);
  const unit = state.facet(indentUnitFacet);
  return (
    <div className="h-6 shrink-0 flex items-center gap-3 px-3 text-[11px] tabular-nums whitespace-nowrap overflow-hidden" style={{ background: M.sidebar, color: M.faint, borderTop: `1px solid ${M.border}` }}>
      <span>{t('editor.lnCol', { ln: line.number, col: sel.head - line.from + 1 })}{chosen ? ` (${t('editor.selected', { n: chosen })})` : ''}</span>
      {state.selection.ranges.length > 1 && <span>{t('editor.cursors', { n: state.selection.ranges.length })}</span>}
      <div className="flex-1" />
      {doc.readOnly && <span>{t('editor.readOnly')}</span>}
      <span>{unit === '\t' ? t('editor.tabs') : t('editor.spaces', { n: unit.length })}</span>
      <span>{doc.bom ? 'UTF-8 BOM' : 'UTF-8'}</span>
      <span>{doc.eol === '\r\n' ? 'CRLF' : 'LF'}</span>
      <select value={doc.lang} onChange={(e) => void editor.setLanguage(doc.path, e.target.value)} className="bg-transparent outline-none hover:text-white cursor-pointer" style={{ color: M.dim }}>
        {Object.values(LANGS).map((l) => <option key={l.id} value={l.id} style={{ background: M.sidebar }}>{l.label}</option>)}
      </select>
    </div>
  );
}
