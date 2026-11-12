import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type GitBranch, type GitCommit, type GitCommitFile, type GitFile, type GitStatus } from '../lib/api';
import { t, useLang } from '../lib/i18n';
import { pollWhileActive } from '../lib/poll';
import CommitGraph from './CommitGraph';
import Icon from './Icon';

interface Props { cwd: string | null; visible: boolean }

const CODE: Record<string, string> = { M: 'mod', A: 'add', D: 'del', R: 'ren', C: 'copy', U: 'conf', '?': 'new' };
const PAGE = 30;

function DiffView({ text }: { text: string }) {
  useLang();
  if (!text) return <div className="p-3 text-xs text-zinc-500">{t('git.noChanges')}</div>;
  return (
    <pre className="p-3 text-[12px] font-mono leading-relaxed whitespace-pre overflow-auto">
      {text.split('\n').map((l, i) => (
        <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'bg-emerald-500/10 text-emerald-200' : l.startsWith('-') && !l.startsWith('---') ? 'bg-red-500/10 text-red-200' : l.startsWith('@@') ? 'text-blue-300' : 'text-zinc-400'}>{l || ' '}</div>
      ))}
    </pre>
  );
}

/** Sticky section header: colored marker, title, count pill, optional actions on the right. */
function SectionHeader({ color, title, count, children }: { color: string; title: string; count?: number; children?: ReactNode }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 px-3 h-8 glass-fill border-b border-line text-[11px]">
      <span className={`w-1.5 h-1.5 rounded-full ${color}`} />
      <span className="font-medium tracking-wide text-zinc-300">{title}</span>
      {count !== undefined && <span className="min-w-[18px] px-1.5 py-px rounded-full bg-white/5 text-[10px] text-zinc-400 text-center font-mono">{count}</span>}
      <div className="flex-1" />
      <div className="flex items-center gap-2 text-[10px] text-zinc-500">{children}</div>
    </div>
  );
}

// Memoized: the app re-renders on every streaming update, and this panel stays mounted behind its tab.
export default memo(function GitPanel({ cwd, visible }: Props) {
  useLang();
  const [st, setSt] = useState<GitStatus | null>(null);
  const [sel, setSel] = useState<{ path: string; staged: boolean } | null>(null);
  const [diff, setDiff] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [remoteBusy, setRemoteBusy] = useState<string | null>(null);
  const logRef = useRef<GitCommit[]>([]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const cwdRef = useRef(cwd);
  const projectRef = useRef(0);
  if (cwdRef.current !== cwd) projectRef.current++;
  cwdRef.current = cwd;
  const project = projectRef.current;
  const generation = useRef(0);
  const refreshId = useRef(0);
  const operationRef = useRef(false);
  const [diffTick, setDiffTick] = useState(0);
  const [newBranch, setNewBranch] = useState<string | null>(null);
  /** Commit opened from the log: its changed files and the diff of the picked file. */
  const [commitView, setCommitView] = useState<{ commit: GitCommit; files: GitCommitFile[] | null; error?: string } | null>(null);
  const [commitFile, setCommitFile] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState('');
  // Must stay above the early returns below: a hook after them breaks the hook order when cwd appears.
  const [suggesting, setSuggesting] = useState(false);
  useEffect(() => { logRef.current = log; }, [log]);

  const refresh = useCallback(() => {
    if (!cwd) return;
    const request = ++refreshId.current;
    const current = () => projectRef.current === project && refreshId.current === request;
    api.gitStatus(cwd).then((st) => { if (current()) { setSt(st); setDiffTick((n) => n + 1); } }).catch((e) => { if (current()) setNote(e.message); });
    api.gitBranches(cwd).then((rows) => { if (current()) setBranches(rows); }).catch(() => { if (current()) setBranches([]); });
    // First page only. Pages already scrolled in are kept when the head is unchanged.
    api.gitLog(cwd, 0, PAGE).then((r) => {
      if (!current()) return;
      const cur = logRef.current;
      if (cur.length > PAGE && r.hasMore && r.commits.length === PAGE && r.commits.every((commit, i) => cur[i]?.hash === commit.hash)) {
        const updated = [...r.commits, ...cur.slice(PAGE)];
        logRef.current = updated; setLog(updated);
        return;
      }
      generation.current++;
      logRef.current = r.commits;
      setLog(r.commits); setHasMore(r.hasMore);
    }).catch((e) => { if (current()) setNote(e.message); });
  }, [cwd]);

  const loadMore = useCallback(() => {
    if (!cwd || loadingRef.current) return;
    loadingRef.current = true; setLoadingMore(true);
    const epoch = generation.current;
    const current = () => projectRef.current === project && generation.current === epoch;
    const skip = logRef.current.length;
    api.gitLog(cwd, skip, PAGE).then((r) => {
      if (!current()) return;
      setLog((prev) => {
        const seen = new Set(prev.map((c) => c.hash));
        return [...prev, ...r.commits.filter((c) => !seen.has(c.hash))];
      });
      setHasMore(r.hasMore);
    }).catch((e) => { if (current()) setNote(e.message); }).finally(() => { if (projectRef.current === project) { loadingRef.current = false; setLoadingMore(false); } });
  }, [cwd]);

  // Reset paging when the project changes.
  useEffect(() => {
    generation.current++; refreshId.current++; logRef.current = []; loadingRef.current = false; operationRef.current = false;
    setLog([]); setHasMore(false); setSel(null); setSt(null); setBranches([]); setDiff(''); setMsg(''); setNote(null); setBusy(false); setRemoteBusy(null); setLoadingMore(false); setNewBranch(null);
    setCommitView(null); setCommitFile(null); setCommitDiff('');
  }, [cwd]);
  useEffect(() => { if (visible) refresh(); }, [visible, refresh]);
  useEffect(() => {
    if (!visible || !cwd) return;
    return pollWhileActive(refresh, 8000);
  }, [visible, cwd, refresh]);
  useEffect(() => {
    if (!cwd || !sel) { setDiff(''); return; }
    let alive = true;
    api.gitDiff(cwd, sel.path, sel.staged).then((text) => { if (alive) setDiff(text); }).catch((e) => { if (alive) setDiff(e.message); });
    return () => { alive = false; };
  }, [cwd, sel, diffTick]);

  const openCommit = (commit: GitCommit) => {
    if (!cwd) return;
    if (commitView?.commit.hash === commit.hash) { setCommitView(null); return; }
    setCommitView({ commit, files: null }); setCommitFile(null); setCommitDiff('');
    api.gitCommitFiles(cwd, commit.hash).then((files) => {
      if (projectRef.current !== project) return;
      setCommitView((v) => v?.commit.hash === commit.hash ? { ...v, files } : v);
      if (files.length === 1) setCommitFile(files[0].path);
    }).catch((e) => { if (projectRef.current === project) setCommitView((v) => v?.commit.hash === commit.hash ? { ...v, files: [], error: e.message } : v); });
  };
  useEffect(() => {
    if (!cwd || !commitView || !commitFile) { setCommitDiff(''); return; }
    let alive = true;
    api.gitCommitDiff(cwd, commitView.commit.hash, commitFile).then((text) => { if (alive) setCommitDiff(text); }).catch((e) => { if (alive) setCommitDiff(e.message); });
    return () => { alive = false; };
  }, [cwd, commitView?.commit.hash, commitFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Infinite scroll: fetch the next page when the sentinel enters the commit list's viewport.
  useEffect(() => {
    const el = sentinelRef.current, root = scrollRef.current;
    if (!el || !root || !hasMore || sel || commitView) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) loadMore(); }, { root, rootMargin: '200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, sel, commitView, loadMore, log.length]);

  if (!cwd) return <div className="h-full flex items-center justify-center text-zinc-600 text-sm">{t('git.openProject')}</div>;
  if (st && !st.repo) return <div className="h-full flex items-center justify-center text-zinc-600 text-sm">{t('git.notRepo')}</div>;

  const staged = st?.files.filter((f) => f.staged) ?? [];
  const unstaged = st?.files.filter((f) => !f.staged || f.worktree !== ' ') ?? [];
  const stage = (files: GitFile[], action: 'add' | 'reset' | 'discard') => {
    if (!files.length || operationRef.current || remoteBusy) return;
    if (action === 'discard' && !window.confirm(t('git.confirmDiscard', { n: files.length }))) return;
    operationRef.current = true; setBusy(true);
    api.gitStage(cwd, files.map((f) => f.path), action).then(() => { if (projectRef.current === project) refresh(); }).catch((e) => { if (projectRef.current === project) setNote(e.message); }).finally(() => { if (projectRef.current === project) { operationRef.current = false; setBusy(false); } });
  };
  // Commit message from the staged diff, written by the local CLI following the repo's conventions.
  const suggest = () => {
    if (!cwd || suggesting) return;
    setSuggesting(true);
    api.gitSuggestMessage(cwd).then((r) => { if (projectRef.current === project) setMsg(r.message); })
      .catch((e) => { if (projectRef.current === project) setNote(e.message); })
      .finally(() => setSuggesting(false));
  };
  const commit = (push = false) => {
    if (!msg.trim() || !staged.length || operationRef.current || remoteBusy) return;
    operationRef.current = true; setBusy(true); setNote(null);
    api.gitCommit(cwd, msg.trim()).then((r) => { if (projectRef.current !== project) return; setNote(r.output); if (r.ok) { setMsg(''); if (push) {
        setRemoteBusy('push');
        return api.gitRemote(cwd, 'push').then((result) => { if (projectRef.current === project) setNote(result.output); }).finally(() => { if (projectRef.current === project) { setRemoteBusy(null); refresh(); } });
      } } refresh(); }).catch((e) => { if (projectRef.current === project) setNote(e.message); }).finally(() => { if (projectRef.current === project) { operationRef.current = false; setBusy(false); } });
  };

  const remote = (op: 'fetch' | 'pull' | 'push') => {
    if (operationRef.current || remoteBusy) return;
    operationRef.current = true; setRemoteBusy(op); setNote(null);
    api.gitRemote(cwd, op).then((r) => { if (projectRef.current === project) setNote(`${op}: ${r.ok ? t('git.ok') : t('git.failed')} ${r.output.split('\n').slice(-1)[0] ?? ''}`); }).catch((e) => { if (projectRef.current === project) setNote(`${op} ${t('git.failed')}: ${e.message}`); }).finally(() => { if (projectRef.current === project) { operationRef.current = false; setRemoteBusy(null); refresh(); } });
  };
  const checkout = (value: string) => {
    if (!value) return;
    if (operationRef.current || remoteBusy) return;
    if (value === '__new__') { setNewBranch(''); return; }
    operationRef.current = true; setBusy(true);
    api.gitCheckout(cwd, value).then((r) => { if (projectRef.current === project) setNote(r.output.split('\n')[0] ?? ''); }).catch((e) => { if (projectRef.current === project) setNote(e.message); }).finally(() => { if (projectRef.current === project) { operationRef.current = false; setBusy(false); refresh(); } });
  };
  const createBranch = () => {
    const name = newBranch?.trim();
    if (!name || operationRef.current || remoteBusy) return;
    operationRef.current = true; setBusy(true);
    api.gitCheckout(cwd, name, true).then((r) => { if (projectRef.current !== project) return; setNote(r.output); if (r.ok) setNewBranch(null); }).catch((e) => { if (projectRef.current === project) setNote(e.message); }).finally(() => { if (projectRef.current === project) { operationRef.current = false; setBusy(false); refresh(); } });
  };

  const row = ({ f, isStaged }: { f: GitFile; isStaged: boolean }) => {
    const code = isStaged ? f.index : (f.untracked ? '?' : f.worktree);
    const tone = f.untracked || code === 'A' ? 'text-emerald-300 bg-emerald-500/10' : code === 'D' ? 'text-red-300 bg-red-500/10' : 'text-amber-300 bg-amber-500/10';
    const active = sel?.path === f.path && sel.staged === isStaged;
    return (
      <div className={`group flex items-center gap-2 px-3 py-1 text-xs cursor-pointer border-l-2 ${active ? 'bg-blue-500/15 border-blue-400' : 'border-transparent hover:bg-white/5'}`} onClick={() => setSel({ path: f.path, staged: isStaged })}>
        <span className={`w-9 text-center text-[9px] font-mono rounded px-1 py-px ${tone}`}>{CODE[code] ?? ''}</span>
        <span className="truncate flex-1 font-mono text-zinc-300" title={f.path}>{f.path}</span>
        <button className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-white w-5 h-5 rounded-full hover:bg-white/10 transition-colors" title={isStaged ? t('git.unstage') : t('git.stage')} onClick={(e) => { e.stopPropagation(); stage([f], isStaged ? 'reset' : 'add'); }}>{isStaged ? '−' : '＋'}</button>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col text-sm">
      <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-white/10 text-xs">
        <select value={st?.branch ?? ''} onChange={(e) => checkout(e.target.value)} disabled={busy || !!remoteBusy} title={t('git.switchBranch')}
          className="bg-black/20 border border-line rounded-md px-1.5 py-1 outline-none max-w-[45%] font-medium text-zinc-200">
          {st?.branch && !branches.some((b) => b.name === st.branch) && <option value={st.branch}>{st.branch}</option>}
          {branches.filter((b) => !b.remote).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          {branches.some((b) => b.remote) && <optgroup label={t('git.remote')}>{branches.filter((b) => b.remote).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}</optgroup>}
          <option value="__new__">{t('git.newBranch')}</option>
        </select>
        {st && (st.ahead > 0 || st.behind > 0) && <span className="text-zinc-500 whitespace-nowrap font-mono">↑{st.ahead} ↓{st.behind}</span>}
        <div className="flex-1" />
        {(['fetch', 'pull', 'push'] as const).map((op) => (
          <button key={op} disabled={!!remoteBusy || busy} onClick={() => remote(op)}
            className={`px-2 py-1 rounded hover:bg-white/10 disabled:opacity-40 ${remoteBusy === op ? 'text-amber-300 animate-pulse' : 'text-zinc-300'}`}>{op}</button>
        ))}
        <button className="w-7 h-7 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors" onClick={refresh} disabled={busy} title={t('common.refresh')}><Icon name="reload" /></button>
      </div>
      {newBranch !== null && <form className="flex gap-2 px-2 py-2 border-b border-white/10" onSubmit={(e) => { e.preventDefault(); createBranch(); }}>
        <input autoFocus aria-label={t('git.newBranch')} placeholder={t('git.newBranchPrompt')} value={newBranch} onChange={(e) => setNewBranch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setNewBranch(null); }} className="min-w-0 flex-1 rounded bg-black/20 border border-line px-2 text-xs outline-none" />
        <button disabled={busy || !!remoteBusy || !newBranch.trim()} className="text-xs text-sky-200 disabled:opacity-40">{t('git.newBranch')}</button>
        <button type="button" onClick={() => setNewBranch(null)} className="text-xs">✕</button>
      </form>}
      {note && <div className="px-3 py-1 text-[11px] text-amber-200 border-b border-white/5 truncate" title={note}>{note}</div>}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="max-h-[45%] overflow-y-auto border-b border-white/10">
          <section>
          <SectionHeader color="bg-emerald-400" title={t('git.stagedTitle')} count={staged.length}>
            {staged.length > 0 && <button className="hover:text-white" onClick={() => stage(staged, 'reset')}>{t('git.unstageAll')}</button>}
          </SectionHeader>
          {staged.length === 0 ? <div className="px-3 py-2 text-[11px] text-zinc-600">{t('git.nothingStaged')}</div> : <div className="py-1">{staged.map((f) => <div key={'s' + f.path}>{row({ f, isStaged: true })}</div>)}</div>}
          </section>
          <section>
          <SectionHeader color="bg-amber-400" title={t('git.changesTitle')} count={unstaged.length}>
            {unstaged.length > 0 && <>
              <button className="hover:text-white" onClick={() => stage(unstaged, 'add')}>{t('git.stageAll')}</button>
              {unstaged.some((f) => !f.untracked) && <button className="hover:text-red-300" onClick={() => stage(unstaged.filter((f) => !f.untracked), 'discard')}>{t('git.discard')}</button>}
            </>}
          </SectionHeader>
          {st && unstaged.length === 0 ? <div className="px-3 py-2 text-[11px] text-zinc-600">{t('git.clean')}</div> : <div className="py-1">{unstaged.map((f) => <div key={'u' + f.path}>{row({ f, isStaged: false })}</div>)}</div>}
          </section>
        </div>
        <div className="relative flex-1 min-h-0">
        <div ref={scrollRef} className="absolute inset-0 overflow-auto bg-black/20">
          {sel ? (
            <>
              <SectionHeader color="bg-blue-400" title={sel.path}>
                <button className="hover:text-white" onClick={() => setSel(null)}>✕ {t('git.closeDiff')}</button>
              </SectionHeader>
              <DiffView text={diff} />
            </>
          ) : (
            <>
              <SectionHeader color="bg-violet-400" title={t('git.recentCommits')} count={log.length}>
                {!hasMore && log.length > 0 && <span>{t('git.allLoaded')}</span>}
              </SectionHeader>
              {log.length === 0 && <div className="px-3 py-3 text-[11px] text-zinc-600">{t('git.noCommits')}</div>}
              <CommitGraph commits={log} selected={commitView?.commit.hash} onSelect={openCommit} />
              <div ref={sentinelRef} className="px-3 py-2 text-[10px] text-zinc-600 text-center">
                {loadingMore ? <span className="animate-pulse">{t('git.loadingMore')}</span> : hasMore ? <button className="hover:text-zinc-300" onClick={loadMore}>{t('git.loadMore')}</button> : null}
              </div>
            </>
          )}
        </div>
        {commitView && !sel && (
          <CommitDetail view={commitView} root={st?.root ?? cwd} file={commitFile} diff={commitDiff}
            onFile={setCommitFile} onClose={() => { setCommitView(null); setCommitFile(null); }} />
        )}
        </div>
        <div className="shrink-0 border-t border-line bg-black/15">
          <div className="flex items-center gap-2 px-3 h-7 text-[11px]">
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
            <span className="font-medium tracking-wide text-zinc-300">{t('git.commitTitle')}</span>
            {st?.branch && <span className="font-mono text-[10px] text-zinc-500 truncate">· {st.branch}</span>}
            <div className="flex-1" />
            <button disabled={suggesting || !staged.length} onClick={suggest} title={staged.length ? t('git.suggestHint') : t('git.suggestNothing')}
              className="shrink-0 flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] text-zinc-400 hover:text-sky-200 hover:bg-white/5 disabled:opacity-40">
              {suggesting ? <span className="inline-block w-2.5 h-2.5 rounded-full border-[1.5px] border-sky-300/70 border-t-transparent animate-spin" /> : <Icon name="sparkle" size={11} />}
              {suggesting ? t('git.suggesting') : t('git.suggest')}
            </button>
          </div>
          <div className="px-2 pb-2 space-y-2">
            <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={2} placeholder={t('git.commitPlaceholder')}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); commit(); } }}
              className="w-full bg-black/30 rounded-lg border border-white/10 focus:border-sky-400/40 px-2 py-1.5 text-xs outline-none resize-none font-mono" />
            <div className="flex items-center gap-2">
              <button disabled={busy || !msg.trim() || !staged.length} className="rounded-full bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 text-xs px-3 py-1.5 disabled:opacity-40" onClick={() => commit()}>{t('git.commit', { n: staged.length })}</button>
              <button disabled={busy || !msg.trim() || !staged.length || !!remoteBusy} className="rounded-full bg-fill hover:bg-fill-2 transition-colors text-xs px-3 py-1.5 disabled:opacity-40"
                onClick={() => commit(true)}>{t('git.commitPush')}</button>
              <span className="ml-auto text-[10px] text-zinc-600">⌘↩</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * Overlay over the commit log (which stays mounted, keeping its scroll position): the files a commit
 * changed, and the diff of the picked one. "Preview" opens the file as it is now in the Preview tab.
 */
function CommitDetail({ view, root, file, diff, onFile, onClose }: {
  view: { commit: GitCommit; files: GitCommitFile[] | null; error?: string }; root: string; file: string | null; diff: string;
  onFile: (path: string) => void; onClose: () => void;
}) {
  useLang();
  const { commit, files, error } = view;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]')) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const preview = (path: string) => window.dispatchEvent(new CustomEvent('vibe:open-file', { detail: { path: `${root.replace(/\/$/, '')}/${path}` } }));
  return (
    <div className="glass-fill absolute inset-0 flex flex-col z-20">
      <SectionHeader color="bg-violet-400" title={commit.subject} count={files?.length}>
        <span className="font-mono text-violet-300/75" title={commit.hash}>{commit.hash.slice(0, 7)}</span>
        <button className="hover:text-white" onClick={onClose} title="Esc">✕ {t('git.closeCommit')}</button>
      </SectionHeader>
      <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-white/10 py-1">
        {files === null && <div className="px-3 py-2 text-[11px] text-zinc-500 animate-pulse">{t('git.loadingFiles')}</div>}
        {error && <div className="px-3 py-2 text-[11px] text-red-300">{error}</div>}
        {files?.length === 0 && !error && <div className="px-3 py-2 text-[11px] text-zinc-600">{t('git.noFilesInCommit')}</div>}
        {files?.map((f) => {
          const tone = f.status === 'A' ? 'text-emerald-300 bg-emerald-500/10' : f.status === 'D' ? 'text-red-300 bg-red-500/10' : 'text-amber-300 bg-amber-500/10';
          const active = file === f.path;
          return (
            <div key={f.path} onClick={() => onFile(f.path)}
              className={`group flex items-center gap-2 px-3 py-1 text-xs cursor-pointer border-l-2 ${active ? 'bg-blue-500/15 border-blue-400' : 'border-transparent hover:bg-white/5'}`}>
              <span className={`w-9 text-center text-[9px] font-mono rounded px-1 py-px ${tone}`}>{CODE[f.status] ?? f.status}</span>
              <span className="truncate flex-1 font-mono text-zinc-300" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                {f.oldPath && <span className="text-zinc-500">{f.oldPath} → </span>}{f.path}
              </span>
              {f.status !== 'D' && <button className="opacity-0 group-hover:opacity-100 text-[10px] text-zinc-400 hover:text-white px-1.5 rounded hover:bg-white/10" title={t('git.openPreviewHint')}
                onClick={(e) => { e.stopPropagation(); preview(f.path); }}>{t('git.openPreview')}</button>}
            </div>
          );
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {file ? <DiffView text={diff} /> : files && files.length > 0 && <div className="p-3 text-xs text-zinc-500">{t('git.pickFile')}</div>}
      </div>
    </div>
  );
}
