import { memo, useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { t, useLang } from '../lib/i18n';
import { activateTerminal, closeTerminal, ensureStarted, fitTerminal, openTerminal, terminalSelection, terminalTail, useTerminals, type TerminalTab } from '../lib/terminals';
import { fencedTerminalText } from '../lib/textSearch';
import { useContextMenu } from './ContextMenu';
import Icon from './Icon';

/** Ask the composer on screen to insert text; false when no chat session is open to take it. */
function sendToChat(text: string): boolean {
  const detail = { text, handled: false };
  window.dispatchEvent(new CustomEvent('vibe:insert-composer', { detail }));
  return detail.handled;
}

interface Props {
  cwd: string | null;
  /** The panel stays mounted while hidden so the shell survives tab switches. */
  visible: boolean;
}

/** Parents the tab's persistent xterm host into this panel; unmounting only detaches it, the shell keeps running. */
function TermView({ tab, visible }: { tab: TerminalTab; visible: boolean }) {
  useLang();
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = container.current; if (!el) return;
    el.appendChild(tab.host);
    ensureStarted(tab.id);
    fitTerminal(tab.id);
    const ro = new ResizeObserver(() => fitTerminal(tab.id));
    ro.observe(el);
    return () => { ro.disconnect(); if (tab.host.parentNode === el) el.removeChild(tab.host); };
  }, [tab.id, tab.host]);

  useEffect(() => { if (visible) { fitTerminal(tab.id); tab.host.querySelector('textarea')?.focus(); } }, [visible, tab.id, tab.host]);

  return (
    <div className={`absolute inset-0 ${visible ? '' : 'invisible'}`}>
      <div ref={container} className="absolute inset-0" />
      {tab.status !== 'open' && <div className="absolute top-2 right-3 text-[11px] text-zinc-500">{tab.status === 'connecting' ? t('terminal.connecting') : tab.status === 'reconnecting' ? t('terminal.reconnecting') : t('terminal.exited')}</div>}
    </div>
  );
}

// Memoized: the app re-renders on every streaming update, and this panel stays mounted behind its tab.
export default memo(function TerminalPanel({ cwd, visible }: Props) {
  useLang();
  const { tabs, active } = useTerminals();
  const menu = useContextMenu();
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (!note) return; const timer = setTimeout(() => setNote(null), 3000); return () => clearTimeout(timer); }, [note]);
  const tab = tabs.find((x) => x.id === active);
  /** Selection when there is one, else the recent output: that is usually the error the agent should see. */
  const send = (mode: 'auto' | 'selection' | 'tail') => {
    if (!tab) return;
    const sel = mode === 'tail' ? '' : terminalSelection(tab.id);
    const text = sel || (mode === 'selection' ? '' : terminalTail(tab.id));
    if (!text.trim()) { setNote(t('terminal.nothingToSend')); return; }
    const label = t(sel ? 'terminal.sentSelectionLabel' : 'terminal.sentTailLabel', { cwd: tab.cwd });
    setNote(sendToChat(fencedTerminalText(text, label)) ? t('terminal.sent') : t('terminal.noChat'));
  };
  const onMenu = (e: React.MouseEvent) => {
    if (!tab) return;
    const hasSel = !!terminalSelection(tab.id);
    menu.open(e, [
      { label: t('terminal.sendSelection'), disabled: !hasSel, onClick: () => send('selection') },
      { label: t('terminal.sendTail'), onClick: () => send('tail') },
      { separator: true },
      { label: t('common.copy'), disabled: !hasSel, onClick: () => navigator.clipboard.writeText(terminalSelection(tab.id)) },
    ]);
  };

  const open = (cmd?: string, title?: string) => openTerminal(cwd ?? '~', cmd, title);
  useEffect(() => { if (visible && tabs.length === 0) open(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [visible]);

  return (
    <div className="h-full flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-white/10 text-xs overflow-x-auto">
        {tabs.map((tab) => (
          <div key={tab.id} className={`flex items-center gap-1 rounded-full px-2 py-1 cursor-pointer ${active === tab.id ? 'bg-white/10 text-white' : 'text-zinc-400 hover:bg-white/5'}`} onClick={() => activateTerminal(tab.id)}>
            <span className="truncate max-w-[120px]">{tab.title}</span>
            <button className="w-5 h-5 flex items-center justify-center rounded-full text-zinc-500 hover:text-red-300 hover:bg-white/10 transition-colors" onClick={(e) => { e.stopPropagation(); closeTerminal(tab.id); }}><Icon name="close" size={11} /></button>
          </div>
        ))}
        <button className="w-7 h-7 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors" onClick={() => open()} title={t('terminal.newShell')}><Icon name="plus" /></button>
        <div className="flex-1" />
        {note && <span className="text-[11px] text-amber-300 truncate max-w-48" title={note}>{note}</span>}
        <button className="px-2 py-1 rounded-full bg-sky-500/15 hover:bg-sky-500/25 text-sky-200 whitespace-nowrap disabled:opacity-40" disabled={!tab} onMouseDown={(e) => e.preventDefault()} onClick={() => send('auto')} title={t('terminal.sendHint')}>→ {t('terminal.toChat')}</button>
        <button className="px-2 py-1 rounded-full bg-fill hover:bg-fill-2 transition-colors text-zinc-300" onClick={() => open('claude', 'claude')} title={t('terminal.claudeTui')}>claude</button>
        <button className="px-2 py-1 rounded-full bg-fill hover:bg-fill-2 transition-colors text-zinc-300" onClick={() => open('codex', 'codex')} title={t('terminal.codexTui')}>codex</button>
      </div>
      <div className="flex-1 relative bg-[#0b0d12]" onContextMenu={onMenu}>
        {tabs.map((tab) => <TermView key={tab.id} tab={tab} visible={visible && active === tab.id} />)}
        {tabs.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-zinc-600 text-sm">{t('terminal.pressPlus')}</div>}
      </div>
    </div>
  );
});
