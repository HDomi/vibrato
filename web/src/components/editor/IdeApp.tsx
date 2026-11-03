import { useEffect, useState } from 'react';
import type { Entry } from '../../lib/api';
import { editor } from '../../lib/editor/store';
import { M } from '../../lib/editor/theme';
import { useLang } from '../../lib/i18n';
import { IDE_CHANNEL, type IdeMessage } from '../../lib/ide';
import { ContextMenuProvider } from '../ContextMenu';
import Lightbox from '../Lightbox';
import QuickOpen from '../QuickOpen';
import Toaster from '../Toast';
import EditorPanel from './EditorPanel';

/**
 * The IDE window (`/?ide=<root>[&file=<path>]`, opened by electron/main.cts `open-ide`). One project per
 * window; it loads none of the chat app, so no second agent socket or notifications.
 */
export default function IdeApp({ root, file }: { root: string; file: string | null }) {
  useLang();
  const [quickOpen, setQuickOpen] = useState(false);
  const name = root.split('/').filter(Boolean).pop() ?? root;
  useEffect(() => {
    document.title = `${name} — IDE`;
    editor.setRoot(root);
    if (file) editor.open(file);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => window.vibe?.onIdeOpenFile?.((f) => editor.open(f)), []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      // The editor owns ⌘W, ⌘/, ⌘S and ⇧⌘K while it has focus.
      if ((e.target as HTMLElement)?.closest?.('[data-editor-scope]') && (k === 'w' || k === '/' || k === 's' || k === 'k')) return;
      if (k === 'w') { e.preventDefault(); if (editor.active) editor.close(editor.active); }
      else if (k === 's') { e.preventDefault(); if (editor.active) void editor.save(editor.active); }
      else if (k === 'b') { e.preventDefault(); window.dispatchEvent(new Event('vibe:toggle-tree')); }
      else if (k === 'p' && !e.shiftKey) { e.preventDefault(); setQuickOpen((v) => !v); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  // "Attach to chat" goes to the main window's composer.
  const attach = (entries: Entry[]) => {
    const files = entries.filter((x) => !x.isDir).map((x) => ({ path: x.path, name: x.name }));
    if (!files.length || typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(IDE_CHANNEL);
    ch.postMessage({ kind: 'attach', root, files } satisfies IdeMessage);
    ch.close();
  };

  return (
    <ContextMenuProvider>
      {/* Nothing but the editor: a strip in the editor's color for the window buttons, then the IDE. */}
      <div className="h-full flex flex-col overflow-hidden" style={{ background: M.bg }}>
        <Lightbox />
        <Toaster />
        <div className="titlebar-drag h-7 shrink-0" style={{ borderBottom: `1px solid ${M.border}` }} />
        <div className="flex-1 min-h-0 flex">
          <EditorPanel root={root} visible onAttach={attach} />
        </div>
        {quickOpen && (
          <QuickOpen cwd={root} onClose={() => setQuickOpen(false)}
            onOpen={(h) => { if (!h.isDir) editor.open(h.path); }}
            onAttach={(h) => { if (!h.isDir) attach([{ path: h.path, name: h.rel.split('/').pop() ?? h.rel, isDir: false, size: 0, mtime: 0, ext: '', hidden: false, kind: 'binary' }]); }} />
        )}
      </div>
    </ContextMenuProvider>
  );
}
