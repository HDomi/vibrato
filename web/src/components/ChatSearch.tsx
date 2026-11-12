import { useEffect, useRef, useState } from 'react';
import { useViewActiveRef } from '../lib/viewActive';
import { t, useLang } from '../lib/i18n';
import { matchOffsets } from '../lib/textSearch';
import Icon from './Icon';
import { revealSkipped } from '../lib/skipOffscreen';

interface Props {
  /** Rendered conversation; text nodes inside it are searched. */
  content: React.RefObject<HTMLDivElement | null>;
  scroller: React.RefObject<HTMLDivElement | null>;
  /** Changes whenever the conversation re-renders, so matches are recomputed. */
  version: unknown;
  onClose: () => void;
  /** Called before jumping to a match so "follow latest" does not pull the view back down. */
  onJump: () => void;
}

const ALL = 'chat-search';
const ACTIVE = 'chat-search-active';

function clearHighlights() {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  CSS.highlights.delete(ALL);
  CSS.highlights.delete(ACTIVE);
}

/** Text ranges matching `query` in the visible conversation, in document order. */
function findRanges(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const start of matchOffsets(node.nodeValue ?? '', query)) {
      const r = document.createRange();
      r.setStart(node, start);
      r.setEnd(node, start + query.length);
      ranges.push(r);
    }
  }
  return ranges;
}

/** ⌘F bar over the chat: highlights matches with the CSS Custom Highlight API and steps through them. */
export default function ChatSearch({ content, scroller, version, onClose, onJump }: Props) {
  useLang();
  const [query, setQuery] = useState('');
  const [ranges, setRanges] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const viewActive = useViewActiveRef();
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => {
    const refocus = () => { if (!viewActive.current) return; input.current?.focus(); input.current?.select(); };
    window.addEventListener('vibe:chat-search', refocus);
    return () => window.removeEventListener('vibe:chat-search', refocus);
  }, []);
  useEffect(() => clearHighlights, []);

  // Query the current ranges were computed for: only a new query auto-jumps, not new conversation content.
  const searched = useRef('');
  const jumpPending = useRef(false);
  // Recompute after typing settles or the conversation changes; keep the current position when possible.
  useEffect(() => {
    const timer = setTimeout(() => {
      const root = content.current;
      const next = root && query.trim() ? findRanges(root, query) : [];
      if (searched.current !== query) { searched.current = query; jumpPending.current = true; }
      setRanges((prev) => (!next.length && !prev.length ? prev : next));
      setIndex((i) => (next.length ? Math.min(i, next.length - 1) : 0));
    }, 120);
    return () => clearTimeout(timer);
  }, [query, version, content]);
  useEffect(() => { setIndex(0); }, [query]);

  useEffect(() => {
    if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
    if (!ranges.length) { clearHighlights(); return; }
    CSS.highlights.set(ALL, new Highlight(...ranges));
    CSS.highlights.set(ACTIVE, new Highlight(ranges[index]));
  }, [ranges, index]);

  const jump = (i: number) => {
    if (!ranges.length) return;
    const next = (i + ranges.length) % ranges.length;
    setIndex(next);
    revealSkipped(ranges[next].startContainer);
    const box = scroller.current, rect = ranges[next].getBoundingClientRect();
    if (!box || (!rect.width && !rect.height)) return;
    onJump();
    const view = box.getBoundingClientRect();
    if (rect.top < view.top + 40 || rect.bottom > view.bottom - 40) box.scrollTop += rect.top - view.top - view.height / 3;
  };
  // Bring the first match into view as soon as results for a new query arrive. Content updates (streaming)
  // only refresh the highlights, so the chat is not scrolled or unstuck from the bottom on every change.
  useEffect(() => {
    if (!jumpPending.current) return;
    jumpPending.current = false;
    if (ranges.length) jump(index);
  }, [ranges]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="absolute top-2 right-4 z-20 flex items-center gap-1 glass-pop rounded-xl px-2 py-1 text-xs">
      <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('chat.searchPlaceholder')} aria-label={t('chat.searchPlaceholder')}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') { e.preventDefault(); jump(index + (e.shiftKey ? -1 : 1)); }
          else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        }}
        className="w-52 bg-transparent outline-none px-1 py-0.5 text-[13px]" />
      <span className="tabular-nums text-zinc-500 min-w-12 text-right">{query.trim() ? `${ranges.length ? index + 1 : 0}/${ranges.length}` : ''}</span>
      <button className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10 text-zinc-400 disabled:opacity-30 transition-colors" disabled={!ranges.length} onClick={() => jump(index - 1)} title={t('chat.searchPrev')}><Icon name="up" size={14} /></button>
      <button className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10 text-zinc-400 disabled:opacity-30 transition-colors" disabled={!ranges.length} onClick={() => jump(index + 1)} title={t('chat.searchNext')}><Icon name="up" size={14} className="rotate-180" /></button>
      <button className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-white/10 text-zinc-400 transition-colors" onClick={onClose} title="Esc"><Icon name="close" size={14} /></button>
    </div>
  );
}
