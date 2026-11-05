import { useEffect, useLayoutEffect, useRef } from 'react';
import type { StateEffect } from '@codemirror/state';
import { EditorView } from '../../lib/editor/setup';
import { editor, type Doc } from '../../lib/editor/store';

/**
 * One EditorView for all tabs. Switching tabs swaps the view's EditorState (each tab keeps its own
 * undo history, selection and scroll position) instead of keeping a DOM tree per open file.
 */
export default function CodeEditor({ doc, hidden, focusKey }: { doc: Doc | null; hidden: boolean; focusKey: number }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const shown = useRef<Doc | null>(null);

  useLayoutEffect(() => {
    const v = new EditorView({ parent: host.current! });
    view.current = v;
    editor.view = v;
    return () => {
      if (shown.current?.state === v.state) shown.current.scroll = v.scrollSnapshot();
      v.destroy();
      if (editor.view === v) editor.view = null;
      view.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const v = view.current;
    if (!v || !doc?.state || v.state === doc.state) return;
    const prev = shown.current;
    if (prev && prev !== doc && prev.state === v.state) prev.scroll = v.scrollSnapshot();
    v.setState(doc.state);
    if (doc.scroll) v.dispatch({ effects: doc.scroll as StateEffect<unknown> });
    shown.current = doc;
  });

  // A pending ⇧⌘F jump: select the match and center it, once this doc's state is in the view.
  useLayoutEffect(() => {
    const v = view.current;
    const at = doc?.reveal;
    if (!v || !doc || !at || !doc.state || v.state !== doc.state) return;
    doc.reveal = undefined;
    const text = v.state.doc;
    const line = text.line(Math.min(Math.max(1, at.line), text.lines));
    const from = Math.min(line.from + at.col, line.to);
    const to = Math.min(from + at.len, line.to);
    v.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    if (!hidden) requestAnimationFrame(() => v.focus());
  });

  // Focus when a file is opened or its tab picked, not on every re-render.
  useEffect(() => {
    if (!hidden && focusKey) requestAnimationFrame(() => view.current?.focus());
  }, [focusKey, hidden]);

  return <div ref={host} className={`absolute inset-0 ${hidden ? 'hidden' : ''}`} />;
}
