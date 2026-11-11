import path from 'node:path';
import { sessionInstructions } from './planInstructions.js';
import type { WebSocket, WebSocketServer } from 'ws';
import type { AgentEvent, AgentSession, ClientCommand, RemoteOrigin, ServerMessage } from './agents/types.js';
import { ClaudeSession } from './agents/claude.js';
import { CodexSession } from './agents/codex.js';
import { which } from './shell.js';
import { loadConfig, PORT } from './config.js';
import { browserMcpUrl, codexBrowserArgs, MCP_SERVER_NAME, registerBrowserSession } from './browserMcp.js';
import { claudeFlagSettings, codexConfigArgs, sanitizeExtensions } from './agentExtensions.js';
import { runVerify, verifySettings } from './verify.js';
import { changedFiles, repoRelative, snapshot, type Snapshot } from './turns.js';
import type { RemoteSessionSummary } from './remote/protocol.cjs';

const BUFFER_LIMIT = 5000;
const BUFFER_BYTES = 16 * 1024 * 1024;
/** Sessions nobody is watching and that have been idle this long are closed to free their CLI process. */
const ORPHAN_TTL_MS = 6 * 60 * 60 * 1000;
const REAP_EVERY_MS = 10 * 60 * 1000;
/** Tools that can change files; a turn that used one is verified afterwards. */
const MUTATING_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit|Bash|FileChange)$/;

interface Entry {
  session: AgentSession;
  buffer: ServerMessage[];
  seq: number;
  subscribers: Set<WebSocket>;
  createdAt: number;
  lastActivity: number;
  running: boolean;
  closed: boolean;
  bufferBytes: number;
  /** The current turn ran a tool that can change files. */
  touched: boolean;
  /** Verification in flight; a new turn cancels it because its result would be stale. */
  verifying?: { id: string; cancel: () => void };
  /** Working tree snapshot taken before the current turn (git projects only). */
  turnBase?: Snapshot | null;
  /** Files the session's own edit tools touched this turn, and whether it ran shell commands (which can touch anything). */
  turnPaths: Set<string>;
  turnShell: boolean;
  /** Sends are serialized: a message waiting for its snapshot must not be overtaken by the next one. */
  sendChain: Promise<void>;
  /** Origin of the message being sent through the remote host; stamped on the `user` event it produces. */
  pendingRemote?: RemoteOrigin;
}

export class SessionRegistry {
  private entries = new Map<string, Entry>();
  private closing = false;
  private changeListeners = new Set<() => void>();
  private reaper: NodeJS.Timeout = setInterval(() => void this.reap(), REAP_EVERY_MS);

  constructor() { this.reaper.unref(); }

  /** Close sessions with no subscribers that have been idle for ORPHAN_TTL_MS. */
  async reap(now = Date.now()) {
    for (const [id, e] of this.entries) {
      if (e.closed && now - e.lastActivity > REAP_EVERY_MS || e.subscribers.size === 0 && !e.running && now - e.lastActivity > ORPHAN_TTL_MS) {
        console.log(`[vibrato] reaping idle session ${id} (${e.session.agent})`);
        await this.close(id).catch(() => {});
      }
    }
  }

  list() {
    return [...this.entries.values()].filter((e) => !e.closed).map((e) => ({
      id: e.session.id, agent: e.session.agent, cwd: e.session.cwd, createdAt: e.createdAt,
      agentSessionId: (e.session as ClaudeSession | CodexSession).agentSessionId,
    }));
  }

  get(id: string) { return this.entries.get(id)?.session; }

  /**
   * Live sessions with what a remote client shows in its list: a title (the first message), whether a turn is
   * running, how many approvals / questions wait, the current permission mode.
   */
  summaries(): RemoteSessionSummary[] {
    return [...this.entries.values()].filter((e) => !e.closed).map((e) => {
      let title = '';
      let mode: string | undefined;
      const open = new Set<string>();
      for (const m of e.buffer) {
        const ev = m.event;
        if (ev.kind === 'user' && !title) title = ev.text.trim().split('\n')[0].slice(0, 120);
        else if (ev.kind === 'session.init' && ev.permissionMode) mode = ev.permissionMode;
        else if (ev.kind === 'status' && ev.permissionMode) mode = ev.permissionMode;
        else if (ev.kind === 'approval.request' || ev.kind === 'question.request') open.add(ev.requestId);
        else if (ev.kind === 'approval.resolved' || ev.kind === 'question.resolved') open.delete(ev.requestId);
      }
      return { id: e.session.id, agent: e.session.agent, cwd: e.session.cwd, title, createdAt: e.createdAt, lastActivity: e.lastActivity, running: e.running, waiting: open.size, permissionMode: mode };
    });
  }

  /** `cb` runs when a session starts, closes, starts or ends a turn, or gets / settles a request. */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => { this.changeListeners.delete(cb); };
  }

  private changed() {
    for (const cb of this.changeListeners) { try { cb(); } catch { /* a listener's problem */ } }
  }

  /** Sessions in the middle of a turn; restarting now would cut that turn off. */
  runningCount() { return [...this.entries.values()].filter((e) => !e.closed && e.running).length; }

  async start(cmd: Extract<ClientCommand, { type: 'session.start' }>, ws: WebSocket): Promise<AgentSession> {
    return this.create(cmd, ws);
  }

  /**
   * A session nobody is watching yet (scheduled runs). It is started right away; a window can attach to it
   * later like any other live session.
   */
  async startHeadless(cmd: Omit<Extract<ClientCommand, { type: 'session.start' }>, 'type'>): Promise<AgentSession> {
    const session = await this.create({ ...cmd, type: 'session.start' }, null);
    session.start();
    return session;
  }

  /** Windows currently showing the session. */
  watchers(id: string) { return this.entries.get(id)?.subscribers.size ?? 0; }

  private async create(cmd: Extract<ClientCommand, { type: 'session.start' }>, ws: WebSocket | null): Promise<AgentSession> {
    if (this.closing) throw new Error('Server is shutting down');
    let session: ClaudeSession | CodexSession;
    // Read at start so a prompt edited in Settings reaches the next session without a restart.
    const cfg = await loadConfig().catch(() => null);
    const instructions = sessionInstructions(cfg);
    const off = sanitizeExtensions(cfg?.extensionsOff);
    const browserTools = cfg?.browserTools !== false;
    // The plan checklist tool (browserMcp.ts PLAN_TOOLS) rides on the same MCP server, so it is attached for either.
    const groups = { browser: browserTools, plan: cfg?.alwaysPlan !== false };
    const mcp = groups.browser || groups.plan;
    // Each session's browser cursor and tabs carry its own colour and label ("Claude · project").
    const browserToken = browserTools ? registerBrowserSession(`${cmd.agent === 'claude' ? 'Claude' : 'Codex'} · ${path.basename(cmd.cwd) || cmd.cwd}`) : undefined;
    if (cmd.agent === 'claude') {
      const claudePath = await which('claude');
      if (!claudePath) throw new Error('claude CLI not found. Install it from Settings.');
      session = new ClaudeSession({ cwd: cmd.cwd, claudePath, resume: cmd.resume, permissionMode: cmd.permissionMode, model: cmd.model, instructions, planGuard: cfg?.alwaysPlan !== false, settings: claudeFlagSettings(off.claude),
        ...(mcp ? { mcpServers: { [MCP_SERVER_NAME]: { type: 'http' as const, url: browserMcpUrl(PORT, browserToken, groups) } } } : {}) });
    } else if (cmd.agent === 'codex') {
      const codexPath = await which('codex');
      if (!codexPath) throw new Error('codex CLI not found. Install it from Settings.');
      session = new CodexSession({ cwd: cmd.cwd, codexPath, resume: cmd.resume, permissionMode: cmd.permissionMode, model: cmd.model, instructions, configArgs: [...codexConfigArgs(off.codex), ...(mcp ? codexBrowserArgs(PORT, browserToken, groups) : [])] });
    } else {
      throw new Error(`Unknown agent: ${cmd.agent}`);
    }
    if (this.closing || (ws && ws.readyState !== ws.OPEN)) throw new Error('Connection closed before session started');
    const entry: Entry = { session, buffer: [], seq: 0, subscribers: new Set(ws ? [ws] : []), createdAt: Date.now(), lastActivity: Date.now(), running: false, closed: false, bufferBytes: 0, touched: false, sendChain: Promise.resolve(), turnPaths: new Set(), turnShell: false };
    this.entries.set(session.id, entry);
    session.onEvent((event) => this.broadcast(entry, event));
    this.changed();
    return session;
  }

  attach(id: string, ws: WebSocket, after = 0) {
    const e = this.entries.get(id);
    if (!e) return false;
    e.subscribers.add(ws);
    for (const m of e.buffer) if (m.seq > after) safeSend(ws, m);
    return true;
  }

  detach(id: string, ws: WebSocket) {
    this.entries.get(id)?.subscribers.delete(ws);
  }

  detachAll(ws: WebSocket) {
    for (const e of this.entries.values()) e.subscribers.delete(ws);
  }

  /** Close every session so child agent processes (claude, codex app-server) do not outlive the server. */
  async closeAll() {
    this.closing = true;
    clearInterval(this.reaper);
    await Promise.allSettled([...this.entries.keys()].map((id) => this.close(id)));
  }

  async close(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    e.verifying?.cancel();
    this.changed();
    await e.session.close();
  }

  /**
   * Hand a message to the CLI, in arrival order. A message that starts a new turn first snapshots the
   * working tree (bounded, so a huge repo cannot hold the send for long).
   */
  send(id: string, run: () => Promise<void>, remote?: RemoteOrigin): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return Promise.reject(new Error('Unknown session'));
    const job = e.sendChain.then(async () => {
      if (e.closed || !this.entries.has(id)) throw new Error('Session closed');
      if (!e.running) {
        const timeout = new Promise<null>((r) => setTimeout(() => r(null), 3000).unref());
        e.turnBase = await Promise.race([snapshot(e.session.cwd).catch(() => null), timeout]);
      }
      // Sends run one at a time, so the next `user` event is this message's echo.
      e.pendingRemote = remote;
      try { await run(); } finally { e.pendingRemote = undefined; }
    });
    e.sendChain = job.catch(() => {});
    return job;
  }

  /** After a turn: report what it changed, then verify if it changed anything. */
  private async finishTurn(e: Entry) {
    const base = e.turnBase;
    const touched = e.touched;
    const own = e.turnPaths; const shell = e.turnShell;
    e.turnBase = undefined; e.touched = false; e.turnPaths = new Set(); e.turnShell = false;
    let changed = touched;
    if (base) {
      const after = await snapshot(base.root).catch(() => null);
      if (after) {
        let files = await changedFiles(base.root, base.tree, after.tree).catch(() => []);
        // Without shell commands, a changed file the session never edited came from elsewhere (another
        // session in this folder, the user) and is not part of this turn. A turn that ran shell commands
        // could have touched anything, so it keeps every change.
        if (!shell) {
          const mine = new Set([...own].map((p) => repoRelative(base.root, p)).filter(Boolean));
          files = files.filter((f) => mine.has(f.path));
        }
        changed = files.length > 0;
        if (files.length && this.entries.has(e.session.id)) this.broadcast(e, { kind: 'changes', id: `changes-${Date.now().toString(36)}`, root: base.root, from: base.tree, to: after.tree, files });
        // A queued message may already have started the next turn; it begins where this one ended.
        if (e.running && e.turnBase === undefined) e.turnBase = after;
      }
    }
    if (changed && !e.running) await this.verify(e.session.id);
  }

  /**
   * Run the project's verification command and report it into the session as `verify` events.
   * Automatic runs (after a turn) need the project's auto flag and a turn that touched files.
   */
  async verify(id: string, manual = false) {
    const e = this.entries.get(id);
    if (!e || e.closed) return;
    const settings = await verifySettings(e.session.cwd);
    if (!settings) { if (manual) throw new Error('No verification command is set for this project.'); return; }
    if (!manual && !settings.auto) return;
    if (e.running) { if (manual) throw new Error('The session is still working; verify after the turn ends.'); return; }
    if (e.closed || this.closing) return;
    e.verifying?.cancel();
    const vid = `verify-${Date.now().toString(36)}`;
    const run = runVerify(e.session.cwd, settings.command);
    e.verifying = { id: vid, cancel: run.cancel };
    this.broadcast(e, { kind: 'verify', id: vid, status: 'running', command: settings.command });
    const r = await run.done;
    if (e.verifying?.id === vid) e.verifying = undefined;
    if (!this.entries.has(id)) return;
    this.broadcast(e, { kind: 'verify', id: vid, status: r.cancelled ? 'cancelled' : r.exitCode === 0 ? 'passed' : 'failed', command: settings.command, output: r.output, exitCode: r.exitCode, durationMs: r.durationMs });
  }

  private broadcast(e: Entry, event: AgentEvent) {
    if (event.kind === 'user' && e.pendingRemote) { event = { ...event, remote: e.pendingRemote }; e.pendingRemote = undefined; }
    const msg: ServerMessage = { sessionId: e.session.id, seq: ++e.seq, ts: Date.now(), event };
    e.lastActivity = msg.ts;
    if (event.kind === 'status') {
      const running = event.status === 'running' || event.status === 'compacting';
      if (running && !e.running) e.verifying?.cancel();
    }
    if (event.kind === 'tool.start' && MUTATING_TOOLS.test(event.name)) {
      e.touched = true;
      const i = (event.input ?? {}) as { file_path?: unknown; notebook_path?: unknown; changes?: unknown };
      if (event.name === 'Bash') e.turnShell = true;
      else if (event.name === 'FileChange' && Array.isArray(i.changes)) { for (const c of i.changes as Array<{ path?: unknown }>) if (typeof c?.path === 'string') e.turnPaths.add(path.resolve(e.session.cwd, c.path)); }
      else { const f = i.file_path ?? i.notebook_path; if (typeof f === 'string') e.turnPaths.add(path.resolve(e.session.cwd, f)); }
    }
    if (event.kind === 'status') e.running = event.status === 'running' || event.status === 'compacting';
    if (event.kind === 'status' && event.status === 'closed') e.closed = true;
    // Shutdown (update, restart) closes every session; clients must keep them remembered so they
    // can be resumed against the new server instead of dropping them as finished.
    if (this.closing && event.kind === 'status' && event.status === 'closed') return;
    if (event.kind !== 'log') {
      e.buffer.push(msg);
      e.bufferBytes += Buffer.byteLength(JSON.stringify(msg));
      while (e.buffer.length > 1 && (e.buffer.length > BUFFER_LIMIT || e.bufferBytes > BUFFER_BYTES)) e.bufferBytes -= Buffer.byteLength(JSON.stringify(e.buffer.shift()!));
    }
    for (const ws of e.subscribers) safeSend(ws, msg);
    if (event.kind === 'status' || event.kind === 'approval.request' || event.kind === 'approval.resolved' || event.kind === 'question.request' || event.kind === 'question.resolved' || (event.kind === 'user' && e.buffer.filter((m) => m.event.kind === 'user').length === 1)) this.changed();
    // Once the turn has settled (the adapters send `status: idle` right after `result`): changes, then verify.
    if (event.kind === 'result' && (e.touched || e.turnBase)) {
      setTimeout(() => void this.finishTurn(e).catch((err) => console.warn(`[vibrato] turn wrap-up failed: ${(err as Error).message}`)), 50);
    }
  }
}

function safeSend(ws: WebSocket, msg: unknown) {
  try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); } catch { /* socket closed between check and send */ }
}

export function attachWebSocket(wss: WebSocketServer, registry: SessionRegistry) {
  wss.on('connection', (ws) => {
    ws.on('message', async (raw) => {
      let cmd: ClientCommand;
      try { cmd = JSON.parse(String(raw)); } catch { return; }
      // Non-object frames ("null", 1, "x") would throw inside handle(); an unhandled rejection kills the server.
      if (!cmd || typeof cmd !== 'object' || typeof (cmd as { type?: unknown }).type !== 'string') return;
      try {
        await handle(cmd, ws, registry);
      } catch (err) {
        if (cmd.type === 'session.start') {
          safeSend(ws, { type: 'session.startFailed', requestId: cmd.requestId, requestCwd: cmd.cwd, message: (err as Error)?.message ?? String(err) });
          return;
        }
        const sessionId = typeof (cmd as { sessionId?: unknown }).sessionId === 'string' ? (cmd as { sessionId: string }).sessionId : '';
        safeSend(ws, { sessionId, seq: 0, ts: Date.now(), event: { kind: 'error', command: cmd.type, message: (err as Error)?.message ?? String(err) } });
      }
    });
    ws.on('close', () => registry.detachAll(ws));
  });
}

async function handle(cmd: ClientCommand, ws: WebSocket, registry: SessionRegistry) {
  switch (cmd.type) {
    case 'ping':
      safeSend(ws, { type: 'pong' });
      return;
    case 'session.start': {
      const s = await registry.start(cmd, ws);
      safeSend(ws, { type: 'session.started', sessionId: s.id, requestCwd: cmd.cwd, requestId: cmd.requestId, agent: cmd.agent });
      try { s.start(); } catch (err) {
        safeSend(ws, { sessionId: s.id, seq: 0, ts: Date.now(), event: { kind: 'error', message: (err as Error).message } });
        await registry.close(s.id);
        safeSend(ws, { type: 'session.missing', sessionId: s.id });
      }
      return;
    }
    case 'session.attach':
      if (!registry.get(cmd.sessionId)) { safeSend(ws, { type: 'session.missing', sessionId: cmd.sessionId }); return; }
      // Acknowledge before the replay: a quiet session (nothing after `after`) would otherwise send nothing at all.
      safeSend(ws, { type: 'session.attached', sessionId: cmd.sessionId });
      if (!registry.attach(cmd.sessionId, ws, cmd.after)) safeSend(ws, { type: 'session.missing', sessionId: cmd.sessionId });
      return;
    case 'session.send': {
      const s = must(registry, cmd.sessionId);
      await registry.send(cmd.sessionId, () => s.send(cmd.text, cmd.attachments ?? [], cmd.messageId));
      return;
    }
    case 'session.rewind': {
      const s = must(registry, cmd.sessionId);
      const result = s.rewindFiles
        ? await s.rewindFiles(cmd.messageId, !!cmd.dryRun).catch((err) => ({ canRewind: false, error: (err as Error).message ?? String(err) }))
        : { canRewind: false, error: 'This agent cannot undo file changes.' };
      safeSend(ws, { type: 'session.rewindResult', sessionId: cmd.sessionId, requestId: cmd.requestId, result });
      return;
    }
    case 'session.mcp': {
      const s = must(registry, cmd.sessionId);
      const result = s.mcp
        ? await s.mcp(cmd.action, cmd.server).catch(async (err) => ({ servers: await s.mcp!('status').then((r) => r.servers).catch(() => []), error: (err as Error).message ?? String(err) }))
        : { servers: [], error: 'This agent has no MCP manager.' };
      safeSend(ws, { type: 'session.mcpResult', sessionId: cmd.sessionId, requestId: cmd.requestId, result });
      return;
    }
    case 'session.approve':
      must(registry, cmd.sessionId).approve(cmd.requestId, cmd.decision, cmd.message);
      return;
    case 'session.answer':
      must(registry, cmd.sessionId).answer(cmd.requestId, cmd.answers, cmd.response);
      return;
    case 'session.interrupt':
      await must(registry, cmd.sessionId).interrupt();
      return;
    case 'session.stopTask': {
      const s = must(registry, cmd.sessionId);
      if (!s.stopTask) throw new Error('This agent cannot stop tasks.');
      await s.stopTask(cmd.taskId);
      return;
    }
    case 'session.mode':
      await must(registry, cmd.sessionId).setPermissionMode(cmd.mode);
      return;
    case 'session.model':
      await must(registry, cmd.sessionId).setModel(cmd.model);
      return;
    case 'session.close':
      await registry.close(cmd.sessionId);
      return;
    case 'session.verify':
      must(registry, cmd.sessionId);
      await registry.verify(cmd.sessionId, true);
      return;
  }
}

function must(registry: SessionRegistry, id: string): AgentSession {
  const s = registry.get(id);
  if (!s) throw new Error('Unknown session');
  return s;
}
