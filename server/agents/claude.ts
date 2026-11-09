import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { query, type HookJSONOutput, type HookInput, type Options, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { saveToolImage } from '../attachments.js';
import { planGap } from '../planGuard.js';
import { PLAN_REMINDER } from '../planInstructions.js';
import { MCP_SERVER_NAME } from '../browserMcp.js';
import { tokenSum, turnCost } from './turnCost.js';
import type { AgentEvent, AgentSession, AssistantBlock, Attachment, McpAction, McpResult, McpServerInfo, PermissionModeId, Question, RewindResult, TaskInfo } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { mimeOf } from '../mime.js';

const IMAGE_LIMIT = 5 * 1024 * 1024;

interface Pending {
  kind: 'approval' | 'question';
  resolve: (r: PermissionResult) => void;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
}

/** Async queue used as the SDK's streaming-input prompt. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((v: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(m: SDKUserMessage) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.items.push(m);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export interface ClaudeSessionOptions {
  cwd: string;
  claudePath: string;
  resume?: string;
  permissionMode?: PermissionModeId;
  model?: string;
  /** User's standing instructions (Settings > Custom prompt), appended to the system prompt. */
  instructions?: string;
  /** Hold the agent to the plan protocol: remind it with every message, send it back when a reply misses a part. */
  planGuard?: boolean;
  /** Flag settings turning skills / plugins off for this session (Settings > Agent CLIs, see agentExtensions.ts). */
  settings?: Options['settings'];
  /** Extra MCP servers for this session (the Vibrato browser tools, server/browserMcp.ts). */
  mcpServers?: Options['mcpServers'];
}

export class ClaudeSession implements AgentSession {
  readonly id = randomUUID();
  readonly agent = 'claude' as const;
  readonly cwd: string;
  agentSessionId: string | undefined;

  private listeners = new Set<(e: AgentEvent) => void>();
  private input = new InputQueue();
  private q: Query | null = null;
  private pending = new Map<string, Pending>();
  private abort = new AbortController();
  private closed = false;
  private running = false;
  /** Incremented on every (re)launch so a superseded pump does not report 'closed'. */
  private generation = 0;
  private relaunching: Promise<void> | null = null;
  /** Subagents and background tasks of the current CLI process, by task id. */
  private tasks = new Map<string, TaskInfo>();
  /** `total_cost_usd` after the last turn, to tell each turn's share; unknown for a resumed session until its first turn. */
  private lastTotalCost: number | null;
  /** The agent's own text in the current turn (top level only), for the plan check when it stops. */
  private turnTexts: string[] = [];

  constructor(private opts: ClaudeSessionOptions) {
    this.cwd = opts.cwd;
    this.agentSessionId = opts.resume;
    this.lastTotalCost = opts.resume ? null : 0;
  }

  onEvent(listener: (e: AgentEvent) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(e: AgentEvent) {
    for (const l of this.listeners) l(e);
  }

  start() { this.launch(); }

  private launch() {
    const gen = ++this.generation;
    // Tasks are per process: a relaunch leaves the old ones orphaned.
    if (this.tasks.size) { this.tasks.clear(); this.emit({ kind: 'task.reset' }); }
    const options: Options = {
      cwd: this.opts.cwd,
      pathToClaudeCodeExecutable: this.opts.claudePath,
      resume: this.opts.resume,
      permissionMode: this.opts.permissionMode ?? 'default',
      // Required for switching to bypassPermissions mid-session via setPermissionMode(); the user picks it explicitly in the UI.
      allowDangerouslySkipPermissions: true,
      // Match `claude` CLI behaviour: the SDK's default system prompt is a minimal tool-calling
      // prompt, not Claude Code's. The preset restores the full prompt (coding guidance, safety rules).
      // settingSources is left at its default, which loads user/project/local settings and CLAUDE.md.
      // `append` lands in the system prompt itself, so the custom prompt is sent once per session and cached.
      systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: true, ...(this.opts.instructions ? { append: this.opts.instructions } : {}) },
      model: this.opts.model,
      // Flag settings outrank user / project / local ones, so this turns things off without editing the CLI's config.
      ...(this.opts.settings ? { settings: this.opts.settings } : {}),
      ...(this.opts.mcpServers ? { mcpServers: this.opts.mcpServers } : {}),
      // Backups before each edit, keyed by the user message id we send, so a turn's file changes can be undone.
      enableFileCheckpointing: true,
      includePartialMessages: true,
      // Stream subagent text/thinking too, so the UI can show what a subagent is doing.
      forwardSubagentText: true,
      abortController: this.abort,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'vibrato/0.1.0' },
      stderr: (data) => this.emit({ kind: 'log', text: data }),
      // Vibrato's own browser tools only drive the in-app browser window the user is watching: no prompt for each step.
      canUseTool: (toolName, input, { suggestions, signal }) => toolName.startsWith(`mcp__${MCP_SERVER_NAME}__browser_`)
        ? Promise.resolve({ behavior: 'allow', updatedInput: input })
        : this.handlePermission(toolName, input, suggestions ?? [], signal),
      ...(this.opts.planGuard ? {
        hooks: {
          UserPromptSubmit: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit' as const, additionalContext: PLAN_REMINDER } })] }],
          Stop: [{ hooks: [async (input: HookInput) => this.planStop(input)] }],
        },
      } : {}),
    };
    this.q = query({ prompt: this.input, options });
    this.emit({ kind: 'session.init', sessionId: this.id, agent: 'claude', cwd: this.cwd, permissionMode: options.permissionMode, agentSessionId: this.agentSessionId });
    void this.pump(this.q, gen);
    // The system/init message (and its slash_commands) only arrives with the first turn.
    // Ask over the control channel so "/" autocomplete works before anything is sent.
    void this.q.supportedCommands()
      .then((cmds) => {
        if (this.closed || !cmds.length) return;
        this.emit({ kind: 'session.init', sessionId: this.id, agent: 'claude', cwd: this.cwd, agentSessionId: this.agentSessionId, commands: cmds.map((c) => `/${c.name}`) });
      })
      .catch((err) => this.emit({ kind: 'log', text: `supportedCommands failed: ${(err as Error).message}` }));
  }

  private async pump(q: Query, gen: number) {
    try {
      for await (const m of q) { if (gen !== this.generation) break; this.handleMessage(m); }
    } catch (err) {
      if (!this.closed && gen === this.generation) this.emit({ kind: 'error', message: (err as Error).message ?? String(err) });
    } finally {
      if (gen !== this.generation) return; // superseded by a relaunch; the new pump owns the session
      this.closed = true;
      for (const [id, p] of this.pending) {
        p.resolve({ behavior: 'deny', message: 'Session closed' });
        this.emit({ kind: 'approval.resolved', requestId: id, decision: 'cancelled' });
      }
      this.pending.clear();
      this.emit({ kind: 'status', status: 'closed' });
    }
  }

  /**
   * Restart the CLI process with a different launch-time permission mode, resuming the same
   * conversation. Needed for bypassPermissions, which the CLI only accepts at launch.
   */
  private async relaunch(mode: PermissionModeId) {
    const old = this.q;
    this.generation++; // detach the old pump before tearing the process down
    this.input.close();
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'Permission mode changed; please retry' });
      this.emit({ kind: 'approval.resolved', requestId: id, decision: 'cancelled' });
    }
    this.pending.clear();
    await this.stopQuery(old);
    this.abort.abort();
    try { old?.close(); } catch { /* ignore */ }
    if (this.closed) return;
    this.input = new InputQueue();
    this.abort = new AbortController();
    this.opts = { ...this.opts, permissionMode: mode, resume: this.agentSessionId };
    this.running = false;
    this.closed = false;
    this.launch();
    this.emit({ kind: 'status', status: 'idle', permissionMode: mode });
  }

  private handleMessage(m: SDKMessage) {
    switch (m.type) {
      case 'system': {
        if (m.subtype === 'init') {
          this.agentSessionId = m.session_id;
          this.emit({ kind: 'session.init', sessionId: this.id, agent: 'claude', cwd: m.cwd, model: m.model, permissionMode: m.permissionMode, agentSessionId: m.session_id, tools: m.tools, commands: (m.slash_commands ?? []).map((c) => `/${c}`) });
        } else if (m.subtype === 'status') {
          // SDKStatus is 'compacting' | 'requesting' | null; null just clears a transient status
          // (e.g. after a permission-mode change) and must not look like a running turn.
          const s = (m as { status?: string | null }).status;
          const status = s === 'compacting' ? 'compacting' : s === 'requesting' ? 'running' : this.running ? 'running' : 'idle';
          this.emit({ kind: 'status', status, permissionMode: (m as { permissionMode?: string }).permissionMode });
        } else if (m.subtype === 'task_started' || m.subtype === 'task_progress' || m.subtype === 'task_updated' || m.subtype === 'task_notification' || m.subtype === 'background_tasks_changed') {
          this.handleTask(m);
        }
        return;
      }
      case 'stream_event': {
        const ev = m.event as { type: string; delta?: { type: string; text?: string; thinking?: string } };
        if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta' && ev.delta.text) this.emit({ kind: 'text.delta', text: ev.delta.text, parent: m.parent_tool_use_id });
          else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) this.emit({ kind: 'thinking.delta', text: ev.delta.thinking, parent: m.parent_tool_use_id });
        }
        return;
      }
      case 'assistant': {
        const blocks: AssistantBlock[] = [];
        for (const b of m.message.content as unknown as Array<Record<string, unknown>>) {
          if (b.type === 'text') {
            blocks.push({ type: 'text', text: String(b.text ?? '') });
            if (!m.parent_tool_use_id && String(b.text ?? '').trim()) this.turnTexts.push(String(b.text));
          }
          else if (b.type === 'thinking') blocks.push({ type: 'thinking', text: String(b.thinking ?? '') });
          else if (b.type === 'tool_use') {
            blocks.push({ type: 'tool_use', id: String(b.id), name: String(b.name), input: b.input });
            this.emit({ kind: 'tool.start', toolUseId: String(b.id), name: String(b.name), input: b.input, parent: m.parent_tool_use_id });
          }
        }
        this.emit({ kind: 'assistant.message', id: m.uuid, parent: m.parent_tool_use_id, blocks });
        return;
      }
      case 'user': {
        const content = (m.message as { content?: unknown }).content;
        if (!Array.isArray(content)) return;
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type !== 'tool_result') continue;
          const c = b.content;
          const text = typeof c === 'string' ? c
            : Array.isArray(c) ? c.map((x) => (x as { type?: string; text?: string }).type === 'text' ? (x as { text: string }).text : `[${(x as { type?: string }).type}]`).join('\n')
            : '';
          // Image blocks (Read of a picture, screenshot tools) are written to disk so the card can show them.
          const images = Array.isArray(c) ? (c as Array<{ type?: string; source?: { type?: string; data?: string; media_type?: string } }>)
            .filter((x) => x.type === 'image' && x.source?.type === 'base64').map((x) => saveToolImage(x.source!.data, x.source!.media_type)).filter((p): p is string => !!p) : [];
          this.emit({ kind: 'tool.result', toolUseId: String(b.tool_use_id), content: text, isError: Boolean(b.is_error), parent: m.parent_tool_use_id, ...(images.length ? { images } : {}) });
        }
        return;
      }
      case 'tool_progress':
        this.emit({ kind: 'tool.progress', toolUseId: m.tool_use_id, name: m.tool_name, elapsed: m.elapsed_time_seconds });
        return;
      case 'result': {
        this.agentSessionId = m.session_id;
        const ok = m.subtype === 'success';
        const turnCostUsd = turnCost(m.total_cost_usd, this.lastTotalCost, tokenSum(m.usage),
          Object.values(m.modelUsage ?? {}).reduce((sum, u) => sum + tokenSum(u), 0));
        this.lastTotalCost = m.total_cost_usd;
        this.emit({
          kind: 'result', ok,
          text: ok ? (m as { result: string }).result : (m as { errors?: string[] }).errors?.join('\n') ?? m.subtype,
          costUsd: m.total_cost_usd, turnCostUsd, numTurns: m.num_turns, durationMs: m.duration_ms, agentSessionId: m.session_id,
        });
        this.running = false;
        this.emit({ kind: 'status', status: 'idle' });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Keep one TaskInfo per subagent / background task and push every change to the client.
   * task_started and task_notification bookend a task; task_progress / task_updated patch it;
   * background_tasks_changed is the level signal (REPLACE semantics) and is the only thing that
   * tells us a backgrounded task is gone when its notification was missed.
   */
  /**
   * Stop hook: a reply that misses part of the plan protocol is sent back once with what is missing.
   * Replies with no text at all (slash commands, tool-only turns) and the continuation it asked for pass.
   */
  private async planStop(input: HookInput): Promise<HookJSONOutput> {
    if (input.hook_event_name !== 'Stop' || input.stop_hook_active || !this.turnTexts.length) return {};
    const gap = planGap(this.turnTexts);
    return gap ? { decision: 'block', reason: gap } : {};
  }

  private handleTask(m: Extract<SDKMessage, { type: 'system' }>) {
    const upsert = (t: TaskInfo) => { this.tasks.set(t.id, t); this.emit({ kind: 'task', task: t }); };
    const now = Date.now();
    switch (m.subtype) {
      case 'task_started': {
        const prev = this.tasks.get(m.task_id);
        upsert({
          ...prev,
          id: m.task_id, type: m.task_type ?? prev?.type ?? 'local_agent', subagentType: m.subagent_type ?? prev?.subagentType,
          description: m.description || prev?.description || '', parentId: m.parent_task_id ?? prev?.parentId, toolUseId: m.tool_use_id ?? prev?.toolUseId,
          status: 'running', background: m.is_backgrounded ?? prev?.background, ambient: m.ambient || m.skip_transcript || undefined, startedAt: prev?.startedAt ?? now,
        });
        return;
      }
      case 'task_progress': {
        const prev = this.tasks.get(m.task_id);
        upsert({
          ...prev,
          id: m.task_id, type: prev?.type ?? 'local_agent', subagentType: m.subagent_type ?? prev?.subagentType, description: m.description || prev?.description || '',
          toolUseId: m.tool_use_id ?? prev?.toolUseId, status: prev?.status ?? 'running', startedAt: prev?.startedAt ?? now,
          usage: { totalTokens: m.usage.total_tokens, toolUses: m.usage.tool_uses, durationMs: m.usage.duration_ms }, lastTool: m.last_tool_name ?? prev?.lastTool, summary: m.summary ?? prev?.summary,
        });
        return;
      }
      case 'task_updated': {
        const prev = this.tasks.get(m.task_id);
        if (!prev) return;
        const p = m.patch;
        const status: TaskInfo['status'] = p.status === 'completed' ? 'completed' : p.status === 'failed' ? 'failed' : p.status === 'killed' ? 'stopped' : prev.status;
        upsert({ ...prev, status, description: p.description ?? prev.description, background: p.is_backgrounded ?? prev.background, error: p.error ?? prev.error, endedAt: status === 'running' ? prev.endedAt : prev.endedAt ?? p.end_time ?? now });
        return;
      }
      case 'task_notification': {
        const prev = this.tasks.get(m.task_id);
        upsert({
          ...prev,
          id: m.task_id, type: prev?.type ?? 'local_agent', description: prev?.description ?? m.summary ?? '', toolUseId: m.tool_use_id ?? prev?.toolUseId,
          status: m.status, ambient: prev?.ambient ?? (m.ambient || m.skip_transcript || undefined), startedAt: prev?.startedAt ?? now, endedAt: now,
          usage: m.usage ? { totalTokens: m.usage.total_tokens, toolUses: m.usage.tool_uses, durationMs: m.usage.duration_ms } : prev?.usage, summary: m.summary || prev?.summary,
        });
        return;
      }
      case 'background_tasks_changed': {
        const live = new Set<string>();
        for (const t of m.tasks) {
          live.add(t.task_id);
          const prev = this.tasks.get(t.task_id);
          const next: TaskInfo = {
            ...prev, id: t.task_id, type: t.task_type, subagentType: t.subagent_type ?? prev?.subagentType, description: t.description || prev?.description || '',
            parentId: t.parent_task_id ?? prev?.parentId, status: prev?.status ?? 'running', background: true, ambient: t.ambient || prev?.ambient || undefined, startedAt: prev?.startedAt ?? now,
          };
          if (!prev || prev.parentId !== next.parentId || prev.ambient !== next.ambient || prev.description !== next.description || !prev.background) upsert(next);
        }
        // A backgrounded task that left the set without a notification has ended; foreground tasks are never listed here, so leave them alone.
        for (const t of this.tasks.values()) {
          if (t.background && t.status === 'running' && !live.has(t.id)) upsert({ ...t, status: 'completed', endedAt: now });
        }
        return;
      }
    }
  }

  private handlePermission(toolName: string, input: Record<string, unknown>, suggestions: PermissionUpdate[], signal: AbortSignal): Promise<PermissionResult> {
    const requestId = randomUUID();
    return new Promise<PermissionResult>((resolve) => {
      const kind = toolName === 'AskUserQuestion' ? 'question' : 'approval';
      this.pending.set(requestId, { kind, resolve, input, suggestions });
      signal.addEventListener('abort', () => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        resolve({ behavior: 'deny', message: 'Cancelled' });
        this.emit(kind === 'question' ? { kind: 'question.resolved', requestId } : { kind: 'approval.resolved', requestId, decision: 'cancelled' });
      });
      if (kind === 'question') {
        this.emit({ kind: 'question.request', requestId, questions: (input.questions as Question[] | undefined) ?? [] });
      } else {
        this.emit({ kind: 'approval.request', requestId, toolUseId: null, toolName, input, canAlwaysAllow: suggestions.length > 0 });
      }
    });
  }

  approve(requestId: string, decision: 'allow' | 'allow_always' | 'deny', message?: string) {
    const p = this.pending.get(requestId);
    if (!p || p.kind !== 'approval') return;
    this.pending.delete(requestId);
    if (decision === 'deny') p.resolve({ behavior: 'deny', message: message || 'User denied this action' });
    else if (decision === 'allow_always') p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions: p.suggestions });
    else p.resolve({ behavior: 'allow', updatedInput: p.input });
    this.emit({ kind: 'approval.resolved', requestId, decision });
  }

  answer(requestId: string, answers: Record<string, string>, response?: string) {
    const p = this.pending.get(requestId);
    if (!p || p.kind !== 'question') return;
    this.pending.delete(requestId);
    const updatedInput: Record<string, unknown> = { questions: p.input.questions, answers };
    if (response) updatedInput.response = response;
    p.resolve({ behavior: 'allow', updatedInput });
    this.emit({ kind: 'question.resolved', requestId });
  }

  async send(text: string, attachments: Attachment[], messageId?: string) {
    await this.relaunching;
    if (this.closed) throw new Error('Session closed');
    const content: Array<Record<string, unknown>> = [];
    const mentions: string[] = [];
    for (const a of attachments) {
      if (a.kind === 'image') {
        try {
          const st = await fs.stat(a.path);
          if (st.size <= IMAGE_LIMIT) {
            const data = await fs.readFile(a.path);
            content.push({ type: 'image', source: { type: 'base64', media_type: a.mime ?? mimeOf(path.extname(a.path)), data: data.toString('base64') } });
          }
        } catch { /* fall through to path mention */ }
      }
      mentions.push(a.path);
    }
    let body = text;
    if (mentions.length) body += `\n\nAttached file paths:\n${mentions.map((p) => `- ${p}`).join('\n')}`;
    content.push({ type: 'text', text: body });
    const uuid = messageId && UUID_RE.test(messageId) ? messageId : randomUUID();
    this.emit({ kind: 'user', text, attachments, messageId: uuid });
    await this.relaunching;
    if (this.closed) throw new Error('Session closed');
    // A message sent while the agent works joins the turn in progress.
    if (!this.running) this.turnTexts = [];
    this.running = true;
    this.emit({ kind: 'status', status: 'running' });
    this.input.push({ type: 'user', uuid: uuid as `${string}-${string}-${string}-${string}-${string}`, message: { role: 'user', content: content as never }, parent_tool_use_id: null });
  }

  async rewindFiles(messageId: string, dryRun: boolean): Promise<RewindResult> {
    if (!UUID_RE.test(messageId)) return { canRewind: false, error: 'Invalid message id' };
    if (this.running && !dryRun) return { canRewind: false, error: 'The agent is still working; stop it first.' };
    await this.relaunching;
    if (!this.q || this.closed) return { canRewind: false, error: 'Session closed' };
    const r = await this.q.rewindFiles(messageId, { dryRun });
    return { canRewind: r.canRewind, error: r.error, filesChanged: r.filesChanged, insertions: r.insertions, deletions: r.deletions };
  }

  /**
   * The in-app /mcp manager: the CLI's own /mcp is a terminal dialog, which over the SDK only prints a one-line summary.
   * `mcpAuthenticate` / `mcpClearAuth` exist on the query object but are not in the SDK's public types yet.
   */
  async mcp(action: McpAction, server?: string): Promise<McpResult> {
    await this.relaunching;
    if (!this.q || this.closed) throw new Error('Session closed');
    const q = this.q as Query & {
      mcpAuthenticate?: (name: string, redirectUri?: string) => Promise<{ authUrl?: string } | undefined>;
      mcpClearAuth?: (name: string) => Promise<unknown>;
    };
    let authUrl: string | undefined;
    if (action !== 'status') {
      if (!server) throw new Error('No server named');
      if (action === 'reconnect') await q.reconnectMcpServer(server);
      else if (action === 'enable' || action === 'disable') await q.toggleMcpServer(server, action === 'enable');
      else if (action === 'authenticate') {
        if (!q.mcpAuthenticate) throw new Error('This Claude Code version cannot sign in to MCP servers from the app.');
        authUrl = (await q.mcpAuthenticate(server))?.authUrl;
      } else if (action === 'clearAuth') {
        if (!q.mcpClearAuth) throw new Error('This Claude Code version cannot sign out of MCP servers from the app.');
        await q.mcpClearAuth(server);
      }
    }
    const servers: McpServerInfo[] = (await q.mcpServerStatus()).map((s) => {
      const cfg = s.config as { type?: string; url?: string; command?: string; args?: string[] } | undefined;
      return {
        name: s.name, status: s.status, scope: s.scope ?? s.source, type: cfg?.type ?? (cfg?.command ? 'stdio' : undefined),
        target: cfg?.url ?? (cfg?.command ? [cfg.command, ...(cfg.args ?? [])].join(' ') : undefined),
        error: s.error, tools: (s.tools ?? []).map((t) => t.name),
      };
    });
    return { servers, ...(authUrl ? { authUrl } : {}) };
  }

  async interrupt() {
    try { await this.q?.interrupt(); } catch (err) { this.emit({ kind: 'log', text: `interrupt failed: ${(err as Error).message}` }); }
  }

  async stopTask(taskId: string) {
    await this.relaunching;
    if (!this.q || this.closed) throw new Error('Session closed');
    await this.q.stopTask(taskId);
  }

  async setModel(model: string | null) {
    await this.q?.setModel(model ?? undefined);
    this.emit({ kind: 'session.init', sessionId: this.id, agent: 'claude', cwd: this.cwd, model: model ?? undefined, agentSessionId: this.agentSessionId });
  }

  async setPermissionMode(mode: PermissionModeId) {
    try {
      await this.q?.setPermissionMode(mode);
      this.emit({ kind: 'status', status: this.running ? 'running' : 'idle', permissionMode: mode });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // The CLI only accepts bypassPermissions as a launch-time flag: relaunch and resume.
      if (/dangerously-skip-permissions/i.test(msg) || mode === 'bypassPermissions') {
        if (!this.relaunching) this.relaunching = this.relaunch(mode).finally(() => { this.relaunching = null; });
        await this.relaunching; return;
      }
      this.emit({ kind: 'error', message: `Could not change permission mode: ${msg}` });
    }
  }

  private async stopQuery(q: Query | null) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([q?.interrupt(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); })]);
    } catch { /* shutdown continues even if the CLI is gone */ }
    finally { if (timer) clearTimeout(timer); }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    this.abort.abort();
    await this.stopQuery(this.q);
    try { this.q?.close(); } catch { /* already closed */ }
  }
}

let modelCache: { at: number; list: { id: string; name: string; description?: string }[] } | null = null;

/** Model list as the CLI reports it (cached 10 min so the list does not spawn a CLI per page load). */
export async function listClaudeModels(claudePath: string): Promise<{ id: string; name: string; description?: string }[]> {
  if (modelCache && Date.now() - modelCache.at < 10 * 60 * 1000) return modelCache.list;
  const list = await fetchClaudeModels(claudePath);
  modelCache = { at: Date.now(), list };
  return list;
}

async function fetchClaudeModels(claudePath: string): Promise<{ id: string; name: string; description?: string }[]> {
  const q = query({ prompt: (async function* () { /* never yields */ })(), options: { pathToClaudeCodeExecutable: claudePath, cwd: process.env.HOME, env: process.env as Record<string, string>, persistSession: false } });
  try {
    const models = await Promise.race([
      q.supportedModels(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
    ]);
    return models.map((m) => ({ id: m.value, name: m.displayName, description: (m as { description?: string }).description }));
  } finally {
    try { q.close(); } catch { /* ignore */ }
  }
}
