import type { AgentId, PermissionModeId } from '../lib/agent';
import { modesFor, setAgentDefaults, useAgentDefaults } from '../lib/agentDefaults';
import { useState } from 'react';
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
      <SessionViewDefault />
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

const VIEW_KEY = 'vibe.sessionView';
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off: this window only */ } };

/** Which view a session opens in (Chat or Plan), and whether each session keeps the view last used in it. */
function SessionViewDefault() {
  const [view, setView] = useState(() => (read(VIEW_KEY) === 'plan' ? 'plan' : 'chat'));
  const [remember, setRemember] = useState(() => read(`${VIEW_KEY}.remember`) !== '0');
  return (
    <div className="rounded-xl border border-line bg-black/10 px-4 py-3 space-y-2.5">
      <div className="flex items-center gap-3 text-sm">
        <span className="w-24 shrink-0 text-zinc-400">{t('settings.defaultView')}</span>
        <span className="flex items-center p-0.5 rounded-full bg-black/20 border border-line text-xs">
          {(['chat', 'plan'] as const).map((v) => (
            <button key={v} type="button" onClick={() => { setView(v); write(VIEW_KEY, v); }}
              className={`h-6 px-3 rounded-full transition-colors ${view === v ? 'bg-fill-3 text-white' : 'text-zinc-400 hover:text-white'}`}>{t(`plan.view.${v}`)}</button>
          ))}
        </span>
      </div>
      <label className="flex items-start gap-2.5 text-sm cursor-pointer">
        <input type="checkbox" className="mt-1" checked={remember} onChange={(e) => { setRemember(e.target.checked); write(`${VIEW_KEY}.remember`, e.target.checked ? '1' : '0'); }} />
        <span>
          <span className="block text-zinc-200">{t('agentDefaults.viewRemember')}</span>
          <span className="block text-xs text-zinc-500">{t(remember ? 'agentDefaults.viewRememberOn' : 'agentDefaults.viewRememberOff')}</span>
        </span>
      </label>
    </div>
  );
}
