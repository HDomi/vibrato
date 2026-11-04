import { useEffect, useState } from 'react';
import type { AgentId, PermissionModeId } from './agent';

/** Model and permission mode every new session of an agent starts with (Settings > AI behavior). */
export interface AgentDefaults {
  /** Model id, or null for the CLI's own default. */
  model: string | null;
  mode: PermissionModeId;
}

const MODES: PermissionModeId[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'];
const LS_KEY = (agent: AgentId) => `vibe.defaults.${agent}`;
const EVENT = 'vibe:agent-defaults';

/** Modes an agent can start in: Codex has no classifier ("auto") mode. */
export function modesFor(agent: AgentId): PermissionModeId[] {
  return MODES.filter((m) => m !== 'auto' || agent === 'claude');
}

/**
 * Stored defaults for an agent. Before the setting existed the start screen remembered the last mode and model
 * (`vibe.mode`, `vibe.model.<agent>`); those seed the defaults until they are saved once.
 */
export function parseAgentDefaults(agent: AgentId, raw: string | null, legacy: { mode: string | null; model: string | null } = { mode: null, model: null }): AgentDefaults {
  let saved: { model?: unknown; mode?: unknown } | null = null;
  try { saved = raw ? JSON.parse(raw) : null; } catch { saved = null; }
  if (!saved || typeof saved !== 'object') saved = { mode: legacy.mode, model: legacy.model };
  const mode = typeof saved.mode === 'string' && (modesFor(agent) as string[]).includes(saved.mode) ? saved.mode as PermissionModeId : 'default';
  const model = typeof saved.model === 'string' && saved.model.trim() ? saved.model.trim() : null;
  return { model, mode };
}

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function agentDefaults(agent: AgentId): AgentDefaults {
  return parseAgentDefaults(agent, read(LS_KEY(agent)), { mode: read('vibe.mode'), model: read(`vibe.model.${agent}`) });
}

export function setAgentDefaults(agent: AgentId, d: AgentDefaults) {
  const clean = parseAgentDefaults(agent, JSON.stringify(d));
  try { localStorage.setItem(LS_KEY(agent), JSON.stringify(clean)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Both agents' defaults, updated when Settings changes them (same window). */
export function useAgentDefaults(): Record<AgentId, AgentDefaults> {
  const get = () => ({ claude: agentDefaults('claude'), codex: agentDefaults('codex') });
  const [v, setV] = useState(get);
  useEffect(() => {
    const h = () => setV(get());
    window.addEventListener(EVENT, h);
    // Another window (IDE) saved them.
    const onStorage = (e: StorageEvent) => { if (!e.key || e.key.startsWith('vibe.defaults.')) h(); };
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener(EVENT, h); window.removeEventListener('storage', onStorage); };
  }, []);
  return v;
}
