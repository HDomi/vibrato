import type { AgentId, PermissionModeId } from '../lib/agent';
import { modesFor, setAgentDefaults, useAgentDefaults } from '../lib/agentDefaults';
import { t, useLang } from '../lib/i18n';
import AgentIcon from './AgentIcon';
import { ModelSelect } from './ChatPanel';

const MODE_KEY: Record<PermissionModeId, string> = {
  default: 'chat.mode.default', acceptEdits: 'chat.mode.acceptEdits', plan: 'chat.mode.plan', bypassPermissions: 'chat.mode.bypass', auto: 'chat.mode.auto',
};

/** Settings > AI behavior: the model and permission mode new sessions of each agent start with. */
export default function AgentDefaultsSettings() {
  useLang();
  const defaults = useAgentDefaults();
  return (
    <div className="rounded-2xl border border-line bg-black/15 p-5 space-y-4">
      <div className="font-medium">{t('settings.tab.agentDefaults')}</div>
      <div className="text-xs text-zinc-500 leading-relaxed">{t('agentDefaults.note')}</div>
      {(['claude', 'codex'] as AgentId[]).map((agent) => {
        const d = defaults[agent];
        return (
          <div key={agent} className="rounded-xl border border-line bg-black/10 px-4 py-3 space-y-2.5">
            <div className="flex items-center gap-2 text-sm font-medium"><AgentIcon agent={agent} size={14} />{agent === 'claude' ? 'Claude' : 'Codex'}</div>
            <label className="flex items-center gap-3 text-sm">
              <span className="w-24 shrink-0 text-zinc-400">{t('agentDefaults.model')}</span>
              <ModelSelect agent={agent} value={d.model} onChange={(model) => setAgentDefaults(agent, { ...d, model })} />
            </label>
            <label className="flex items-center gap-3 text-sm">
              <span className="w-24 shrink-0 text-zinc-400">{t('agentDefaults.mode')}</span>
              <select value={d.mode} onChange={(e) => setAgentDefaults(agent, { ...d, mode: e.target.value as PermissionModeId })}
                className="bg-black/20 border border-line rounded-full text-xs px-3 py-1.5 outline-none">
                {modesFor(agent).map((m) => <option key={m} value={m}>{t(MODE_KEY[m])}</option>)}
              </select>
            </label>
          </div>
        );
      })}
    </div>
  );
}
