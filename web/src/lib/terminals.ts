import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useSyncExternalStore } from 'react';

/**
 * Terminal tabs live outside React so a shell survives any re-render or unmount of the panel
 * (right-pane tab switch, IDE/agent view switch, project change). A shell ends only when the
 * user closes its tab, the process exits, or the page itself goes away.
 */
export interface TerminalTab {
  id: number;
  title: string;
  cwd: string;
  cmd?: string;
  status: 'connecting' | 'open' | 'reconnecting' | 'closed';
  /** Detached DOM node that xterm renders into; TermView parents it wherever the panel currently is. */
  host: HTMLDivElement;
  term?: Terminal;
  fit?: FitAddon;
  ws?: WebSocket;
  /** Server-side shell id: a reconnect within the server's grace period reattaches to the same process. */
  key: string;
  /** When the shell last printed something; recent output counts as work worth keeping the Mac awake for. */
  lastOutputAt: number;
}
/** Close code sent by the server when the shell process itself ended (do not reconnect). */
const CLOSE_EXITED = 4000;
const retryTimers = new Map<number, number>();
const retries = new Map<number, number>();

export interface TerminalState { tabs: TerminalTab[]; active: number | null }

let state: TerminalState = { tabs: [], active: null };
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: Partial<TerminalState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}
function patch(id: number, changes: Partial<TerminalTab>) {
  publish({ tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...changes } : t)) });
}

export function useTerminals(): TerminalState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

export function openTerminal(cwd: string, cmd?: string, title?: string): TerminalTab {
  const host = document.createElement('div');
  host.className = 'absolute inset-0 p-2';
  const tab: TerminalTab = { id: nextId++, title: title ?? (cmd ? cmd.split(' ')[0] : cwd.split('/').pop() || 'shell'), cwd, cmd, status: 'connecting', host, key: crypto.randomUUID(), lastOutputAt: 0 };
  publish({ tabs: [...state.tabs, tab], active: tab.id });
  return tab;
}

export function activateTerminal(id: number) { publish({ active: id }); }

export function closeTerminal(id: number) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  const timer = retryTimers.get(id); if (timer) { window.clearTimeout(timer); retryTimers.delete(id); }
  retries.delete(id);
  // Tell the server this is deliberate so it kills the shell now instead of keeping it for a reattach.
  try { if (tab.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ type: 'close' })); tab.ws?.close(); } catch { /* already closed */ }
  tab.term?.dispose();
  tab.host.remove();
  const tabs = state.tabs.filter((t) => t.id !== id);
  publish({ tabs, active: state.active === id ? tabs[tabs.length - 1]?.id ?? null : state.active });
}

/** First time the host is in the document: create xterm and connect the shell. Later mounts reuse both. */
export function ensureStarted(id: number) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab || tab.term) return;
  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", Monaco, "Pretendard Variable", monospace', fontSize: 13, lineHeight: 1.2, cursorBlink: true,
    theme: { background: '#0b0d12', foreground: '#e6e8ee', cursor: '#e6e8ee', selectionBackground: '#3b4252' },
    allowProposedApi: true, scrollback: 5000, macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit); term.loadAddon(new WebLinksAddon());
  term.open(tab.host);
  fit.fit();
  patch(id, { term, fit });
  term.onData((d) => { const ws = state.tabs.find((t) => t.id === id)?.ws; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: d })); });
  connect(id);
}

/** Open (or reopen) the socket for a tab. The server reattaches the same shell when the tab's key is still known. */
function connect(id: number) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab?.term) return;
  const term = tab.term;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams({ cwd: tab.cwd, cols: String(term.cols), rows: String(term.rows), id: tab.key });
  // The initial command belongs to the first shell only; a reattach must not run it again.
  if (tab.cmd && tab.status === 'connecting') q.set('cmd', tab.cmd);
  const ws = new WebSocket(`${proto}://${location.host}/pty?${q}`);
  ws.onopen = () => { retries.delete(id); const wasReconnect = state.tabs.find((t) => t.id === id)?.status === 'reconnecting'; patch(id, { status: 'open' }); if (!wasReconnect) term.focus(); };
  ws.onmessage = (e) => { term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data)); patch(id, { lastOutputAt: Date.now() }); };
  ws.onclose = (e) => {
    const current = state.tabs.find((t) => t.id === id);
    if (!current || current.ws !== ws) return; // tab closed or superseded
    if (e.code === CLOSE_EXITED) { patch(id, { status: 'closed' }); return; }
    // Connection lost (sleep/wake, server restart): keep trying; the shell waits on the server.
    patch(id, { status: 'reconnecting' });
    const n = retries.get(id) ?? 0; retries.set(id, n + 1);
    retryTimers.set(id, window.setTimeout(() => { retryTimers.delete(id); connect(id); }, Math.min(10000, 1000 * 2 ** n)));
  };
  patch(id, { ws });
}

/** After the Mac wakes: reconnect every tab whose socket is not open, without waiting for the backoff. */
export function reconnectTerminals() {
  for (const tab of state.tabs) {
    if (!tab.term || tab.status === 'closed' || tab.ws?.readyState === WebSocket.OPEN || tab.ws?.readyState === WebSocket.CONNECTING) continue;
    const timer = retryTimers.get(tab.id); if (timer) { window.clearTimeout(timer); retryTimers.delete(tab.id); }
    retries.delete(tab.id);
    connect(tab.id);
  }
}

/** True when some shell printed output within `withinMs` (a build, a test run, a TUI agent still working). */
export function terminalsBusy(withinMs = 60000, now = Date.now()) {
  return state.tabs.some((t) => t.status === 'open' && now - t.lastOutputAt < withinMs);
}

/** Refit to the current host size and tell the shell. Safe to call while hidden (zero size is skipped). */
export function fitTerminal(id: number) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab?.term || !tab.fit || tab.host.clientWidth === 0 || tab.host.clientHeight === 0) return;
  tab.fit.fit();
  if (tab.ws?.readyState === WebSocket.OPEN) tab.ws.send(JSON.stringify({ type: 'resize', cols: tab.term.cols, rows: tab.term.rows }));
}

/** Text the user selected in this terminal, or '' when nothing is selected. */
export function terminalSelection(id: number): string {
  return state.tabs.find((t) => t.id === id)?.term?.getSelection() ?? '';
}

/** The last `count` non-empty lines on screen and in scrollback, oldest first. */
export function terminalTail(id: number, count = 40): string {
  const term = state.tabs.find((t) => t.id === id)?.term;
  if (!term) return '';
  const buf = term.buffer.active;
  const lines: string[] = [];
  // Rows soft-wrapped by the terminal width belong to the line above; join them back.
  let row = '';
  for (let i = buf.length - 1; i >= 0 && lines.length < count; i--) {
    const line = buf.getLine(i);
    row = (line?.translateToString(true) ?? '') + row;
    if (line?.isWrapped) continue;
    if (row.trim() || lines.length) lines.push(row);
    row = '';
  }
  return lines.reverse().join('\n').trimEnd();
}
