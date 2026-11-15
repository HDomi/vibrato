import { api, type ClaudeRuleFile, type PermissionsSnapshot } from '../lib/api';
import { t } from '../lib/i18n';

/** Settings > Permissions: the agents' standing allow / deny rules (Claude settings files, Codex config and execpolicy). */

type ClaudeList = 'allow' | 'ask' | 'deny' | 'additionalDirectories';
const LIST_CLASS: Record<ClaudeList, string> = { allow: 'text-green-300', ask: 'text-sky-300', deny: 'text-red-300', additionalDirectories: 'text-zinc-300' };

function RuleChip({ text, onRemove, disabled }: { text: string; onRemove: () => void; disabled: boolean }) {
  return (
    <span className="group inline-flex items-center gap-1 max-w-full rounded-lg bg-white/5 border border-white/5 pl-2 pr-1 py-0.5 font-mono text-[11px] text-zinc-300">
      <span className="truncate" title={text}>{text}</span>
      <button disabled={disabled} onClick={onRemove} title={t('perm.removeRule')}
        className="shrink-0 w-4 h-4 flex items-center justify-center rounded text-zinc-500 hover:text-white hover:bg-white/10 disabled:opacity-40">×</button>
    </span>
  );
}

function ClaudeFile({ f, busy, run }: { f: ClaudeRuleFile; busy: string | null; run: (key: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const lists: ClaudeList[] = ['allow', 'ask', 'deny', 'additionalDirectories'];
  const total = f.allow.length + f.ask.length + f.deny.length + f.additionalDirectories.length;
  const remove = (list: ClaudeList, rule: string) => {
    if (!window.confirm(t('perm.confirmRemove', { rule }))) return;
    void run(`claude:${f.file}:${rule}`, () => api.removeClaudeRule(f.file, list, rule));
  };
  return (
    <details className="rounded-xl border border-white/5 bg-black/10 px-3 py-2">
      <summary className="cursor-pointer text-xs flex items-center gap-2">
        <span className={`rounded-full px-2 py-px text-[10px] ${f.scope === 'user' ? 'bg-sky-400/15 text-sky-200' : 'bg-white/8 text-zinc-300'}`}>{t(`perm.scope.${f.scope}`)}</span>
        <span className="font-mono text-zinc-300 truncate flex-1" title={f.file}>{f.project ?? f.file}{f.project && <span className="text-zinc-500"> · {f.file.split('/').pop()}</span>}</span>
        <span className="text-zinc-500 whitespace-nowrap">{t('perm.ruleCount', { n: total })}{f.defaultMode ? ` · ${f.defaultMode}` : ''}</span>
      </summary>
      <div className="mt-2 space-y-2">
        <div className="text-[11px] text-zinc-600 font-mono break-all">{f.file}</div>
        {lists.filter((l) => f[l].length).map((l) => (
          <div key={l}>
            <div className={`text-[11px] mb-1 ${LIST_CLASS[l]}`}>{t(`perm.list.${l}`)} · {f[l].length}</div>
            <div className="flex flex-wrap gap-1">
              {f[l].map((rule) => <RuleChip key={rule} text={rule} disabled={busy !== null} onRemove={() => remove(l, rule)} />)}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

export default function AgentRules({ snap, busy, run }: { snap: PermissionsSnapshot; busy: string | null; run: (key: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const codex = snap.codex;
  return (
    <div className="rounded-2xl border border-line bg-black/15 p-5 space-y-4">
      <div className="font-medium">{t('perm.section.agents')}</div>
      <div className="text-xs text-zinc-500 leading-relaxed">{t('perm.agentsNote')}</div>
      <div className="space-y-2">
        <div className="text-sm">Claude</div>
        {snap.claude.length === 0 && <div className="text-xs text-zinc-500">{t('perm.noRules')}</div>}
        {snap.claude.map((f) => <ClaudeFile key={f.file} f={f} busy={busy} run={run} />)}
      </div>
      <div className="space-y-2">
        <div className="text-sm">Codex</div>
        {!codex && <div className="text-xs text-zinc-500">{t('perm.noRules')}</div>}
        {codex && (
          <>
            <div className="text-xs text-zinc-400">
              approval_policy <span className="font-mono text-zinc-200">{codex.approvalPolicy ?? t('perm.default')}</span>
              {' · '}sandbox_mode <span className="font-mono text-zinc-200">{codex.sandboxMode ?? t('perm.default')}</span>
              <span className="text-zinc-600 font-mono"> · {codex.file}</span>
            </div>
            {codex.trusted.length > 0 && (
              <details className="rounded-xl border border-white/5 bg-black/10 px-3 py-2">
                <summary className="cursor-pointer text-xs text-zinc-300">{t('perm.codexTrusted')} · {codex.trusted.length}</summary>
                <div className="mt-2 space-y-0.5">
                  {codex.trusted.map((p) => (
                    <div key={p.path} className="flex gap-2 text-[11px] font-mono"><span className="text-zinc-300 break-all flex-1">{p.path}</span><span className={p.level === 'trusted' ? 'text-green-300' : 'text-zinc-500'}>{p.level}</span></div>
                  ))}
                </div>
              </details>
            )}
            {codex.rules.length > 0 && (
              <details className="rounded-xl border border-white/5 bg-black/10 px-3 py-2">
                <summary className="cursor-pointer text-xs text-zinc-300">{t('perm.codexRules')} · {codex.rules.length}</summary>
                <div className="mt-2 flex flex-wrap gap-1">
                  {codex.rules.map((r) => (
                    <RuleChip key={`${r.file}:${r.line}`} text={`${r.decision === 'allow' ? '' : `[${r.decision}] `}${r.pattern.join(' ')}`} disabled={busy !== null}
                      onRemove={() => { if (window.confirm(t('perm.confirmRemove', { rule: r.pattern.join(' ') }))) void run(`codex:${r.line}`, () => api.removeCodexRule(r.file, r.text)); }} />
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
