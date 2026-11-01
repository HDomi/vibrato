import { currentTodos, displayTitle, isInjected, type ChatSession } from './chatStore';
import { t } from './i18n';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * A briefing for another agent taking over a session (e.g. when one hits its usage limit), built from
 * the transcript without spending tokens: what was asked, the latest answer, files changed, open todos.
 */
export function handoffText(s: ChatSession): string {
  const author = s.agent === 'claude' ? 'Claude' : 'Codex';
  const asks = s.items.filter((i) => i.kind === 'user' && !isInjected(i) && i.text.trim()).slice(-8)
    .map((i) => `- ${clip((i as { text: string }).text.trim().replace(/\n+/g, ' '), 300)}`);
  let last = '';
  for (let i = s.items.length - 1; i >= 0; i--) { const it = s.items[i]; if (it.kind === 'assistant' && !it.parent && it.text.trim()) { last = it.text.trim(); break; } }
  const files = [...new Set(s.items.flatMap((i) => (i.kind === 'changes' ? i.files.map((f) => `${f.status} ${f.path}`) : [])))].slice(0, 40);
  const todos = currentTodos(s).filter((x) => x.status !== 'completed').map((x) => `- [ ] ${x.content}`);
  const parts = [t('handoff.intro', { author, title: displayTitle(s, 80) ?? '' })];
  if (asks.length) parts.push(`${t('handoff.asks')}\n${asks.join('\n')}`);
  if (last) parts.push(`${t('handoff.last')}\n${clip(last, 2000)}`);
  if (files.length) parts.push(`${t('handoff.files')}\n${files.map((f) => `- ${f}`).join('\n')}`);
  if (todos.length) parts.push(`${t('handoff.todos')}\n${todos.join('\n')}`);
  parts.push(t('handoff.outro'));
  return parts.join('\n\n');
}
