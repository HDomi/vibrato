import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { t, useLang } from '../lib/i18n';
import FileIcon from './FileIcon';

interface Hit { path: string; rel: string; isDir: boolean }

interface Props {
  cwd: string;
  onClose: () => void;
  onOpen: (hit: Hit) => void;
  onAttach: (hit: Hit) => void;
}

/** ⌘P: fuzzy file search inside the project. Enter opens, ⌘Enter attaches to chat. */
export default function QuickOpen({ cwd, onClose, onOpen, onAttach }: Props) {
  useLang();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const timer = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setLoading(true);
      api.search(cwd, q).then((h) => { setHits(h); setIdx(0); }).catch(() => setHits([])).finally(() => setLoading(false));
    }, 120);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [q, cwd]);

  useEffect(() => { listRef.current?.children[idx]?.scrollIntoView({ block: 'nearest' }); }, [idx]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(hits.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const h = hits[idx]; if (h) { (e.metaKey || e.ctrlKey ? onAttach : onOpen)(h); onClose(); } }
    else if (e.key === 'Escape') onClose();
  };

  return (
    <div className="absolute inset-0 z-30 bg-black/50 flex items-start justify-center pt-[12vh]" onClick={onClose}>
      <div className="w-[640px] max-w-[92vw] glass-pop pop-in !rounded-[22px] overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={t('quickopen.placeholder')}
          className="w-full bg-transparent px-4 py-3 text-sm outline-none border-b border-white/10" />
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {hits.map((h, i) => (
            <div key={h.path} onMouseEnter={() => setIdx(i)} onClick={() => { onOpen(h); onClose(); }}
              className={`px-4 py-1.5 text-sm flex items-center gap-2 cursor-pointer ${i === idx ? 'bg-blue-500/20' : ''}`}>
              <FileIcon name={h.rel.split('/').pop() ?? h.rel} isDir={h.isDir} />
              <span className="truncate flex-1 font-mono text-[13px]">{h.rel}</span>
              {i === idx && !h.isDir && <button className="text-[10px] text-zinc-400 hover:text-white" onClick={(e) => { e.stopPropagation(); onAttach(h); onClose(); }}>{t('quickopen.attach')}</button>}
            </div>
          ))}
          {!loading && hits.length === 0 && <div className="px-4 py-3 text-xs text-zinc-500">{t('quickopen.noMatches')}</div>}
          {loading && hits.length === 0 && <div className="px-4 py-3 text-xs text-zinc-500">{t('quickopen.searching')}</div>}
        </div>
      </div>
    </div>
  );
}
