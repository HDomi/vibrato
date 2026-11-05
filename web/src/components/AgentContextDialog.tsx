import { useEffect, useState } from 'react';
import { api, ApiError, type AgentContext, type ContextDoc } from '../lib/api';
import { t, useLang } from '../lib/i18n';
import Icon from './Icon';
import { shortcutKey } from '../lib/keys';

type Tab = 'docs' | 'skills' | 'hooks' | 'mcp';

/** One instruction file: editable text with its own save, aware of changes made on disk meanwhile. */
function DocEditor({ doc, value, onChange, onSaved, label }: { doc: ContextDoc; value: string; onChange: (v: string) => void; onSaved: (d: ContextDoc) => void; label: string }) {
  useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = value !== doc.content || (!doc.exists && value !== '');
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.saveText(doc.path, value, { baseMtime: doc.mtime, bom: false });
      onSaved({ ...doc, exists: true, content: value, mtime: r.mtime });
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? t('context.conflict') : (e as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <div className="flex-1 min-w-0 flex flex-col rounded-lg border border-white/10 overflow-hidden">
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-white/10 bg-white/[0.02] text-[12px]">
        <span className="shrink-0 whitespace-nowrap font-medium text-zinc-200">{label}</span>
        <span className="truncate min-w-0 font-mono text-[10.5px] text-zinc-500" title={doc.path}>{doc.path.replace(/^\/Users\/[^/]+/, '~')}</span>
        {!doc.exists && <span className="shrink-0 rounded bg-white/5 px-1.5 text-[10px] text-zinc-400">{t('context.new')}</span>}
        <div className="flex-1" />
        <button disabled={!dirty || busy} onClick={() => void save()} className="shrink-0 rounded-md bg-sky-500/25 hover:bg-sky-500/35 disabled:opacity-30 px-2.5 py-0.5 text-sky-100">{t('common.save')}</button>
      </div>
      {error && <div className="px-3 py-1 text-[11px] text-red-300 border-b border-white/5">{error}</div>}
      <textarea value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} placeholder={t('context.emptyDoc')}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && shortcutKey(e) === 's') { e.preventDefault(); if (dirty) void save(); } }}
        className="flex-1 min-h-0 w-full resize-none bg-black/30 px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-zinc-200 outline-none" />
    </div>
  );
}

/** CLAUDE.md / AGENTS.md side by side with sync helpers, plus the skills, hooks and MCP servers both agents load. */
export default function AgentContextDialog({ cwd, onClose, onOpenFile }: { cwd: string; onClose: () => void; onOpenFile: (path: string) => void }) {
  useLang();
  const [ctx, setCtx] = useState<AgentContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('docs');
  const [scope, setScope] = useState<'project' | 'user'>('project');
  const [texts, setTexts] = useState<Record<string, string>>({});

  const load = () => api.agentContext(cwd).then((c) => { setCtx(c); setTexts(Object.fromEntries(c.docs.map((d) => [d.path, d.content]))); }).catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [cwd]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const claude = ctx?.docs.find((d) => d.scope === scope && d.agent === 'claude');
  const codex = ctx?.docs.find((d) => d.scope === scope && d.agent === 'codex');
  const saved = (d: ContextDoc) => setCtx((c) => (c ? { ...c, docs: c.docs.map((x) => (x.path === d.path ? d : x)) } : c));
  // Claude Code reads `@path` lines in CLAUDE.md as imports, so one file can feed both agents.
  const importLine = scope === 'project' ? '@AGENTS.md' : '@~/.codex/AGENTS.md';
  const cText = claude ? texts[claude.path] ?? '' : '';
  const xText = codex ? texts[codex.path] ?? '' : '';
  const imports = cText.split('\n').some((l) => l.trim() === importLine);
  const sync = !claude || !codex ? null
    : imports ? 'imports'
    : !cText.trim() && !xText.trim() ? 'empty'
    : cText.trim() === xText.trim() ? 'same'
    : !cText.trim() ? 'noClaude' : !xText.trim() ? 'noCodex' : 'different';
  const set = (p: string, v: string) => setTexts((m) => ({ ...m, [p]: v }));
  const count = (k: Exclude<Tab, 'docs'>) => ctx?.[k].length ?? 0;

  return (
    <div className="fade-in fixed inset-0 z-40 bg-black/50 flex items-center justify-center" onClick={onClose}>
      <div className="w-[1040px] max-w-[94vw] h-[720px] max-h-[88vh] glass-pop pop-in !rounded-[22px] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 pl-6 pr-4 h-[60px] shrink-0 border-b border-white/10">
          <div className="text-[15px] font-semibold">{t('context.title')}</div>
          <span className="text-xs text-zinc-500 truncate">{cwd.split('/').pop()}</span>
          <div className="ml-4 flex items-center rounded-md bg-white/5 p-0.5 text-[12px]">
            {(['docs', 'skills', 'hooks', 'mcp'] as Tab[]).map((k) => (
              <button key={k} onClick={() => setTab(k)} className={`px-3 py-1 rounded ${tab === k ? 'bg-white/15 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
                {t(`context.tab.${k}`)}{k !== 'docs' && <span className="ml-1 text-[10px] text-zinc-500">{count(k)}</span>}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <button className="text-xs text-zinc-400 hover:text-white" onClick={() => void load()}>{t('context.reload')}</button>
          <button className="w-8 h-8 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors" onClick={onClose} title="Esc"><Icon name="close" /></button>
        </div>
        {error && <div className="p-4 text-sm text-red-300">{error}</div>}
        {!ctx && !error && <div className="p-6 text-sm text-zinc-500">{t('common.loading')}</div>}
        {ctx && tab === 'docs' && claude && codex && (
          <div className="flex-1 min-h-0 flex flex-col p-4 gap-3">
            <div className="shrink-0 flex items-center gap-2 text-[12px]">
              <div className="flex rounded-md bg-white/5 p-0.5">
                {(['project', 'user'] as const).map((s) => (
                  <button key={s} onClick={() => setScope(s)} className={`px-2.5 py-0.5 rounded ${scope === s ? 'bg-white/15 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>{t(`context.scope.${s}`)}</button>
                ))}
              </div>
              <span className={`ml-2 ${sync === 'same' || sync === 'imports' ? 'text-emerald-300' : sync === 'empty' ? 'text-zinc-500' : 'text-amber-300'}`}>{sync && t(`context.sync.${sync}`)}</span>
              <div className="flex-1" />
              {sync !== 'imports' && <>
                <button disabled={!cText.trim()} onClick={() => set(codex.path, cText)} className="rounded-md px-2 py-1 text-zinc-300 hover:bg-white/10 disabled:opacity-30">{t('context.copyToCodex')}</button>
                <button disabled={!xText.trim()} onClick={() => set(claude.path, xText)} className="rounded-md px-2 py-1 text-zinc-300 hover:bg-white/10 disabled:opacity-30">{t('context.copyToClaude')}</button>
                <button disabled={!cText.trim() && !xText.trim()} title={t('context.linkHint')}
                  onClick={() => { const body = xText.trim() ? xText : cText; set(codex.path, body); set(claude.path, `${importLine}\n`); }}
                  className="rounded-md bg-violet-500/20 hover:bg-violet-500/30 px-2 py-1 text-violet-100 disabled:opacity-30">{t('context.link')}</button>
              </>}
            </div>
            <div className="flex-1 min-h-0 flex gap-3">
              <DocEditor doc={claude} value={cText} onChange={(v) => set(claude.path, v)} onSaved={saved} label="CLAUDE.md · Claude" />
              <DocEditor doc={codex} value={xText} onChange={(v) => set(codex.path, v)} onSaved={saved} label="AGENTS.md · Codex" />
            </div>
          </div>
        )}
        {ctx && tab !== 'docs' && (
          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            {count(tab) === 0 && <div className="text-sm text-zinc-500 px-1">{t(`context.none.${tab}`)}</div>}
            <div className="space-y-1">
              {tab === 'skills' && ctx.skills.map((s) => (
                <button key={s.path} onClick={() => onOpenFile(s.path)} className="w-full text-left flex items-start gap-3 rounded-lg border border-white/5 hover:border-white/15 hover:bg-white/[0.03] px-3 py-2">
                  <span className="shrink-0 mt-0.5 rounded bg-white/5 px-1.5 text-[10px] text-zinc-400">{s.agent === 'claude' ? 'Claude' : 'Codex'} · {t(`context.scope.${s.scope}`)}</span>
                  <div className="min-w-0"><div className="font-mono text-[12.5px] text-zinc-100">{s.name}</div><div className="text-[11.5px] text-zinc-500 line-clamp-2">{s.description}</div></div>
                </button>
              ))}
              {tab === 'hooks' && ctx.hooks.map((h, i) => (
                <button key={i} onClick={() => onOpenFile(h.file)} className="w-full text-left flex items-center gap-3 rounded-lg border border-white/5 hover:border-white/15 hover:bg-white/[0.03] px-3 py-2 text-[12px]">
                  <span className="shrink-0 rounded bg-sky-400/10 px-1.5 text-[10.5px] text-sky-200">{h.event}</span>
                  {h.matcher && <span className="shrink-0 font-mono text-zinc-400">{h.matcher}</span>}
                  <code className="truncate min-w-0 text-zinc-200">{h.command}</code>
                  <div className="flex-1" />
                  <span className="shrink-0 text-[10.5px] text-zinc-500">{t(`context.scope.${h.scope}`)} · {h.file.split('/').pop()}</span>
                </button>
              ))}
              {tab === 'mcp' && ctx.mcp.map((m, i) => (
                <button key={i} onClick={() => onOpenFile(m.file)} className="w-full text-left flex items-center gap-3 rounded-lg border border-white/5 hover:border-white/15 hover:bg-white/[0.03] px-3 py-2 text-[12px]">
                  <span className="shrink-0 rounded bg-white/5 px-1.5 text-[10px] text-zinc-400">{m.agent === 'claude' ? 'Claude' : 'Codex'} · {t(`context.scope.${m.scope}`)}</span>
                  <span className="shrink-0 font-mono text-zinc-100">{m.name}</span>
                  <code className="truncate min-w-0 text-zinc-500">{m.command}</code>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
