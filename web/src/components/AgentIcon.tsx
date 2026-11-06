import type { AgentId } from '../lib/agent';

/**
 * Small neutral marks for the two agents. Deliberately not the vendors' logos (those need written permission):
 * Claude is an open ring on a warm tile, Codex a terminal prompt on a dark tile.
 */
export default function AgentIcon({ agent, size = 16, className = '', title }: { agent: AgentId; size?: number; className?: string; title?: string }) {
  const label = title ?? (agent === 'claude' ? 'Claude' : 'Codex');
  if (agent === 'claude') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label={label}>
        <title>{label}</title>
        <rect x=".5" y=".5" width="23" height="23" rx="5.5" fill="#2a211c" stroke="#5c4a3f" />
        <g fill="none" stroke="#f0bf9b" strokeWidth="2" strokeLinecap="round">
          <path d="M16.6 8.4A6 6 0 1 0 16.6 15.6" />
        </g>
        <circle cx="12" cy="12" r="1.6" fill="#f0bf9b" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-label={label}>
      <title>{label}</title>
      <rect x=".5" y=".5" width="23" height="23" rx="5.5" fill="#0f0f10" stroke="#3f3f46" />
      <g fill="none" stroke="#e4e4e7" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6.5 8.5 10 12l-3.5 3.5" />
        <path d="M12.5 16h5" />
      </g>
    </svg>
  );
}
