import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { saveToolImage } from '../attachments.js';
import type { AgentEvent, AgentSession, Attachment, PermissionModeId, Question } from './types.js';

/*
 * Codex app-server adapter. Speaks the JSON-RPC-style protocol over stdio
 * (one JSON object per line, no "jsonrpc" field). Method/param shapes follow
 * `codex app-server generate-ts` output for codex-cli 0.162.
 */

type Json = Record<string, unknown>;
type ThreadItem = Json & { type: string; id: string };

interface RpcPending { resolve: (v: unknown) => void; reject: (e: Error) => void }

class AppServerClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, RpcPending & { timer: NodeJS.Timeout }>();
  exited = false;
  onNotification: (method: string, params: Json) => void = () => {};
  onRequest: (id: number | string, method: string, params: Json) => void = () => {};
  onExit: (code: number | null) => void = () => {};

  constructor(codexPath: string, cwd: string, extraArgs: string[] = []) {
    this.proc = spawn(codexPath, ['app-server', '--listen', 'stdio://', ...extraArgs], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = createInterface({ input: this.proc.stdout! });
    // A codex CLI update can change message shapes; a TypeError in a handler must not take the server down.
    rl.on('line', (line) => {
      try { this.handleLine(line); } catch (err) { this.onStderr(`[vibrato] failed to handle app-server message: ${(err as Error).message}`); }
    });
    this.proc.stderr!.on('data', (d) => this.onStderr(String(d)));
    // EPIPE after the process died would otherwise be an unhandled 'error' event.
    this.proc.stdin!.on('error', (err) => this.onStderr(`stdin error: ${err.message}`));
    this.proc.on('exit', (code) => {
      this.exited = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('codex app-server exited')); }
      this.pending.clear();
      this.onExit(code);
    });
    this.proc.on('error', (err) => { this.exited = true; this.onStderr(`spawn error: ${err.message}`); });
  }
  onStderr: (text: string) => void = () => {};

  private handleLine(line: string) {
    let m: Json;
    try { m = JSON.parse(line); } catch { return; }
    if ('id' in m && ('result' in m || 'error' in m) && !('method' in m)) {
      const p = this.pending.get(Number(m.id));
      if (!p) return;
      this.pending.delete(Number(m.id));
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error((m.error as { message?: string }).message ?? JSON.stringify(m.error)));
      else p.resolve(m.result);
      return;
    }
    if ('method' in m && 'id' in m) { this.onRequest(m.id as number | string, String(m.method), (m.params ?? {}) as Json); return; }
    if ('method' in m) this.onNotification(String(m.method), (m.params ?? {}) as Json);
  }

  private write(obj: Json) {
    if (!this.exited && this.proc.stdin?.writable) this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** Send a request; rejects if the process is gone or no reply arrives within `timeoutMs` (never hangs a caller). */
  request<T = unknown>(method: string, params: Json = {}, timeoutMs = 120000): Promise<T> {
    if (this.exited) return Promise.reject(new Error('codex app-server is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`codex app-server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params: Json = {}) { this.write({ method, params }); }
  respond(id: number | string, result: Json) { this.write({ id, result }); }
  respondError(id: number | string, code: number, message: string) { this.write({ id, error: { code, message } }); }
  kill() { if (!this.exited) this.proc.kill(); }
}

export interface CodexSessionOptions {
  cwd: string;
  codexPath: string;
  resume?: string;
  permissionMode?: PermissionModeId;
  model?: string;
  /** User's standing instructions (Settings > Custom prompt), sent as the thread's developer instructions. */
  instructions?: string;
  /** `-c` overrides for this session's app-server (skills turned off in Settings, see agentExtensions.ts). */
  configArgs?: string[];
}

interface PendingReq {
  rpcId: number | string;
  kind: 'command' | 'fileChange' | 'permissions' | 'question';
  questionIds?: Record<string, string>;
  permissions?: Json;
}

function policyFor(mode: PermissionModeId, cwd: string) {
  // 'auto' is Claude's classifier mode; Codex has no equivalent, so it behaves like default.
  const sandboxMode = mode === 'bypassPermissions' ? 'danger-full-access' : mode === 'plan' ? 'read-only' : 'workspace-write';
  const sandboxPolicy = mode === 'bypassPermissions' ? { type: 'dangerFullAccess' }
    : mode === 'plan' ? { type: 'readOnly', networkAccess: false }
    : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  const approvalPolicy = mode === 'bypassPermissions' ? 'never' : 'on-request';
  return { sandboxMode, sandboxPolicy, approvalPolicy };
}

export class CodexSession implements AgentSession {
  readonly id = randomUUID();
  readonly agent = 'codex' as const;
  readonly cwd: string;
  agentSessionId: string | undefined;

  private listeners = new Set<(e: AgentEvent) => void>();
  private client: AppServerClient | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private mode: PermissionModeId;
  private model: string | null;
  private pending = new Map<string, PendingReq>();
  private items = new Map<string, ThreadItem>();
  private lastAgentText = '';
  private closed = false;
  private ready: Promise<void> = Promise.resolve();
  private skills = new Map<string, string>(); // name -> path
  /** False after the app-server unloads the thread (30 min idle); the next send resumes it. */
  private threadLoaded = false;

  constructor(private opts: CodexSessionOptions) {
    this.cwd = opts.cwd;
    this.agentSessionId = opts.resume;
    this.mode = opts.permissionMode ?? 'default';
    this.model = opts.model ?? null;
  }

  onEvent(listener: (e: AgentEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(e: AgentEvent) { for (const l of this.listeners) l(e); }

  start() {
    this.ready = this.boot().catch((err) => {
      this.emit({ kind: 'error', message: (err as Error).message });
      this.closed = true;
      this.client?.kill(); // never leave a half-initialised app-server behind
      this.emit({ kind: 'status', status: 'closed' });
      throw err;
    });
    this.ready.catch(() => {});
  }

  private async boot() {
    const c = new AppServerClient(this.opts.codexPath, this.cwd, this.opts.configArgs);
    this.client = c;
    c.onNotification = (m, p) => this.handleNotification(m, p);
    c.onRequest = (id, m, p) => this.handleRequest(id, m, p);
    c.onStderr = (t) => this.emit({ kind: 'log', text: t });
    c.onExit = () => { if (!this.closed) { this.closed = true; this.emit({ kind: 'error', message: 'codex app-server process exited' }); this.emit({ kind: 'status', status: 'closed' }); } };
    await c.request('initialize', { clientInfo: { name: 'vibrato', title: 'vibrato', version: '0.1.0' }, capabilities: null });
    c.notify('initialized');
    const pol = policyFor(this.mode, this.cwd);
    const base: Json = { cwd: this.cwd, approvalPolicy: pol.approvalPolicy, sandbox: pol.sandboxMode, model: this.opts.model ?? null };
    const method = this.opts.resume ? 'thread/resume' : 'thread/start';
    if (this.opts.resume) base.threadId = this.opts.resume;
    let res: Json;
    if (this.opts.instructions) {
      // `developerInstructions` is part of the thread, so it is sent once rather than with every turn. An app-server
      // too old to know the field rejects the whole request; fall back to a plain thread rather than failing to start.
      try {
        res = await c.request<Json>(method, { ...base, developerInstructions: this.opts.instructions });
      } catch (err) {
        this.emit({ kind: 'log', text: `custom prompt not applied: ${(err as Error).message}` });
        res = await c.request<Json>(method, base);
      }
    } else {
      res = await c.request<Json>(method, base);
    }
    const thread = res.thread as Json;
    this.threadId = String(thread.id);
    this.agentSessionId = this.threadId;
    this.threadLoaded = true;
    try {
      const sk = await c.request<Json>('skills/list', { cwds: [this.cwd] });
      for (const entry of (sk.data as Json[]) ?? []) {
        for (const s of ((entry.skills as Json[] | undefined) ?? [])) {
          if (s.enabled !== false && s.name) this.skills.set(String(s.name), String(s.path ?? ''));
        }
      }
    } catch { /* skills are optional */ }
    this.emit({ kind: 'session.init', sessionId: this.id, agent: 'codex', cwd: this.cwd, model: String(res.model ?? ''), permissionMode: this.mode, agentSessionId: this.threadId, commands: [...this.skills.keys()].map((n) => `/${n}`) });
    if (this.opts.resume) this.replay((thread.turns as Json[] | undefined) ?? []);
    this.emit({ kind: 'status', status: 'idle' });
  }

  /** Replay stored turns of a resumed thread as events so the UI shows history. */
  private replay(turns: Json[]) {
    for (const t of turns) {
      for (const raw of (t.items as ThreadItem[] | undefined) ?? []) {
        if (raw.type === 'userMessage') {
          const text = ((raw.content as Json[]) ?? []).filter((c) => c.type === 'text').map((c) => String(c.text)).join('\n');
          const atts: Attachment[] = ((raw.content as Json[]) ?? []).filter((c) => c.type === 'localImage').map((c) => ({ path: String(c.path), name: String(c.path).split('/').pop() ?? '', kind: 'image' }));
          this.emit({ kind: 'user', text, attachments: atts });
        } else {
          this.itemStarted(raw, true);
          this.itemCompleted(raw);
        }
      }
    }
  }

  private toolOf(item: ThreadItem): { name: string; input: unknown } | null {
    switch (item.type) {
      case 'commandExecution': return { name: 'Bash', input: { command: item.command, cwd: item.cwd } };
      case 'fileChange': return { name: 'FileChange', input: { changes: item.changes } };
      case 'mcpToolCall': return { name: `mcp:${item.server}/${item.tool}`, input: item.arguments };
      case 'dynamicToolCall': return { name: String(item.tool), input: item.arguments };
      case 'webSearch': return { name: 'WebSearch', input: { query: item.query ?? item.action ?? null } };
      case 'imageView': return { name: 'ImageView', input: { path: item.path } };
      case 'collabAgentToolCall': return { name: 'SubAgent', input: { tool: item.tool, prompt: item.prompt } };
      case 'subAgentActivity': return { name: 'SubAgentActivity', input: { kind: item.kind, agentPath: item.agentPath } };
      case 'imageGeneration': return { name: 'ImageGeneration', input: { prompt: item.revisedPrompt ?? null, status: item.status } };
      default: return null;
    }
  }

  private itemStarted(item: ThreadItem, replay = false) {
    this.items.set(item.id, item);
    const tool = this.toolOf(item);
    if (tool) { this.emit({ kind: 'tool.start', toolUseId: item.id, name: tool.name, input: tool.input, parent: null }); return; }
    if (item.type === 'contextCompaction' && !replay) this.emit({ kind: 'status', status: 'compacting' });
  }

  private itemCompleted(item: ThreadItem) {
    this.items.set(item.id, item);
    switch (item.type) {
      case 'agentMessage': {
        const text = String(item.text ?? '');
        this.lastAgentText = text;
        this.emit({ kind: 'assistant.message', id: item.id, parent: null, blocks: text ? [{ type: 'text', text }] : [] });
        return;
      }
      case 'plan':
        this.emit({ kind: 'assistant.message', id: item.id, parent: null, blocks: [{ type: 'text', text: `**계획**\n\n${String(item.text ?? '')}` }] });
        return;
      case 'reasoning': {
        const text = [...((item.summary as string[]) ?? []), ...((item.content as string[]) ?? [])].join('\n');
        if (text) this.emit({ kind: 'assistant.message', id: item.id, parent: null, blocks: [{ type: 'thinking', text }] });
        return;
      }
      case 'commandExecution': {
        const code = item.exitCode as number | null;
        this.emit({ kind: 'tool.result', toolUseId: item.id, content: String(item.aggregatedOutput ?? '') + (code != null && code !== 0 ? `\n[exit ${code}]` : ''), isError: item.status === 'failed' || (code != null && code !== 0), parent: null });
        return;
      }
      case 'fileChange': {
        const changes = (item.changes as Json[]) ?? [];
        const content = changes.map((c) => `${(c.kind as Json)?.type ?? ''} ${c.path}\n${c.diff ?? ''}`).join('\n\n');
        this.emit({ kind: 'tool.result', toolUseId: item.id, content, isError: item.status === 'failed' || item.status === 'declined', parent: null });
        return;
      }
      case 'mcpToolCall': {
        const r = item.result as Json | null; const e = item.error as Json | null;
        // MCP image content ({ type: 'image', data, mimeType }) is saved for the card and left out of the JSON text.
        const parts = Array.isArray(r?.content) ? (r!.content as Json[]) : [];
        const images = parts.filter((p) => p?.type === 'image').map((p) => saveToolImage(p.data, p.mimeType)).filter((p): p is string => !!p);
        const shown = images.length ? parts.map((p) => (p?.type === 'image' ? { type: 'image' } : p)) : (r?.content ?? r ?? '');
        this.emit({ kind: 'tool.result', toolUseId: item.id, content: e ? JSON.stringify(e) : JSON.stringify(shown), isError: Boolean(e), parent: null, ...(images.length ? { images } : {}) });
        return;
      }
      case 'imageView':
        this.emit({ kind: 'tool.result', toolUseId: item.id, content: String(item.path ?? ''), isError: false, parent: null, ...(item.path ? { images: [String(item.path)] } : {}) });
        return;
      case 'imageGeneration': {
        const saved = typeof item.savedPath === 'string' ? item.savedPath : saveToolImage(item.result, 'image/png');
        const failure = item.failure as Json | null;
        this.emit({ kind: 'tool.result', toolUseId: item.id, content: failure ? JSON.stringify(failure) : String(item.revisedPrompt ?? saved ?? item.status ?? ''), isError: !!failure, parent: null, ...(saved ? { images: [saved] } : {}) });
        return;
      }
      case 'dynamicToolCall': case 'webSearch': case 'collabAgentToolCall': case 'subAgentActivity':
        this.emit({ kind: 'tool.result', toolUseId: item.id, content: JSON.stringify(item.contentItems ?? item.status ?? '', null, 1).slice(0, 4000), isError: item.success === false, parent: null });
        return;
      case 'contextCompaction':
        this.emit({ kind: 'status', status: 'running' });
        return;
      case 'enteredReviewMode': case 'exitedReviewMode':
        this.emit({ kind: 'assistant.message', id: item.id, parent: null, blocks: [{ type: 'text', text: String(item.review ?? '') }] });
        return;
      default:
        return;
    }
  }

  private handleNotification(method: string, p: Json) {
    switch (method) {
      case 'thread/started': return;
      case 'turn/started':
        this.turnId = String((p.turn as Json).id);
        this.emit({ kind: 'status', status: 'running' });
        return;
      case 'item/started': this.itemStarted(p.item as ThreadItem); return;
      case 'item/completed': this.itemCompleted(p.item as ThreadItem); return;
      case 'item/agentMessage/delta': this.emit({ kind: 'text.delta', text: String(p.delta), parent: null }); return;
      case 'item/reasoning/textDelta': case 'item/reasoning/summaryTextDelta': this.emit({ kind: 'thinking.delta', text: String(p.delta), parent: null }); return;
      case 'item/plan/delta': this.emit({ kind: 'text.delta', text: String(p.delta), parent: null }); return;
      case 'turn/plan/updated': {
        const steps = Array.isArray(p.plan) ? (p.plan as Json[]) : [];
        const status = (s: unknown): 'pending' | 'in_progress' | 'completed' => s === 'completed' ? 'completed' : s === 'inProgress' || s === 'in_progress' ? 'in_progress' : 'pending';
        this.emit({ kind: 'todos', items: steps.map((s) => ({ content: String(s.step ?? ''), status: status(s.status) })).filter((s) => s.content) });
        return;
      }
      case 'item/commandExecution/outputDelta': case 'item/fileChange/outputDelta':
        this.emit({ kind: 'tool.output', toolUseId: String(p.itemId), chunk: String(p.delta) }); return;
      case 'turn/completed': {
        const turn = p.turn as Json;
        const status = String(turn.status);
        const err = turn.error as Json | null;
        this.turnId = null;
        this.emit({ kind: 'result', ok: status === 'completed', text: status === 'completed' ? this.lastAgentText : (err?.message as string) ?? status, costUsd: 0, numTurns: 1, durationMs: Number(turn.durationMs ?? 0), agentSessionId: this.threadId ?? undefined });
        this.emit({ kind: 'status', status: 'idle' });
        return;
      }
      case 'error': {
        const err = p.error as Json;
        if (p.willRetry) this.emit({ kind: 'log', text: `retrying: ${err.message}` });
        else this.emit({ kind: 'error', message: String(err.message) });
        return;
      }
      case 'thread/closed':
        // Idle unload by the app-server, not a failure: keep the session; resume lazily on next send.
        if (String(p.threadId ?? this.threadId) === this.threadId) { this.threadLoaded = false; this.turnId = null; this.emit({ kind: 'status', status: 'idle' }); }
        return;
      case 'serverRequest/resolved': return;
      default: return;
    }
  }

  private handleRequest(id: number | string, method: string, p: Json) {
    const requestId = randomUUID();
    switch (method) {
      case 'item/commandExecution/requestApproval':
        this.pending.set(requestId, { rpcId: id, kind: 'command' });
        this.emit({ kind: 'approval.request', requestId, toolUseId: String(p.itemId), toolName: 'Bash', input: { command: p.command, cwd: p.cwd, reason: p.reason, kind: p.kind }, canAlwaysAllow: true });
        return;
      case 'item/fileChange/requestApproval': {
        const item = this.items.get(String(p.itemId));
        this.pending.set(requestId, { rpcId: id, kind: 'fileChange' });
        this.emit({ kind: 'approval.request', requestId, toolUseId: String(p.itemId), toolName: 'FileChange', input: { changes: item?.changes ?? [], reason: p.reason, grantRoot: p.grantRoot }, canAlwaysAllow: true });
        return;
      }
      case 'item/permissions/requestApproval':
        this.pending.set(requestId, { rpcId: id, kind: 'permissions', permissions: p.permissions as Json });
        this.emit({ kind: 'approval.request', requestId, toolUseId: String(p.itemId), toolName: 'Permissions', input: { permissions: p.permissions, reason: p.reason, cwd: p.cwd }, canAlwaysAllow: true });
        return;
      case 'item/tool/requestUserInput': {
        const qs = (p.questions as Json[]) ?? [];
        const ids: Record<string, string> = {};
        const questions: Question[] = qs.map((q) => {
          ids[String(q.question)] = String(q.id);
          return { question: String(q.question), header: String(q.header ?? ''), options: ((q.options as Json[] | null) ?? []).map((o) => ({ label: String(o.label), description: String(o.description ?? '') })), multiSelect: false };
        });
        this.pending.set(requestId, { rpcId: id, kind: 'question', questionIds: ids });
        this.emit({ kind: 'question.request', requestId, questions });
        return;
      }
      case 'mcpServer/elicitation/request':
        this.client?.respond(id, { action: 'decline', content: null, _meta: null });
        return;
      default:
        this.client?.respondError(id, -32601, `Unsupported server request: ${method}`);
        return;
    }
  }

  approve(requestId: string, decision: 'allow' | 'allow_always' | 'deny') {
    const p = this.pending.get(requestId);
    if (!p || p.kind === 'question' || !this.client) return;
    this.pending.delete(requestId);
    if (p.kind === 'permissions') {
      const perms = p.permissions ?? {};
      const granted = decision === 'deny' ? {} : { network: perms.network ?? undefined, fileSystem: perms.fileSystem ?? undefined };
      this.client.respond(p.rpcId, { permissions: granted, scope: decision === 'allow_always' ? 'session' : 'turn' });
    } else {
      this.client.respond(p.rpcId, { decision: decision === 'deny' ? 'decline' : decision === 'allow_always' ? 'acceptForSession' : 'accept' });
    }
    this.emit({ kind: 'approval.resolved', requestId, decision });
  }

  answer(requestId: string, answers: Record<string, string>) {
    const p = this.pending.get(requestId);
    if (!p || p.kind !== 'question' || !this.client) return;
    this.pending.delete(requestId);
    const out: Record<string, { answers: string[] }> = {};
    for (const [q, a] of Object.entries(answers)) {
      const id = p.questionIds?.[q];
      if (id) out[id] = { answers: a.split(', ').filter(Boolean) };
    }
    this.client.respond(p.rpcId, { answers: out });
    this.emit({ kind: 'question.resolved', requestId });
  }

  async send(text: string, attachments: Attachment[]) {
    await this.ready;
    if (!this.client || !this.threadId) throw new Error('Codex thread not ready');
    const input: Json[] = [];
    for (const a of attachments) {
      if (a.kind === 'image') input.push({ type: 'localImage', path: a.path });
      else input.push({ type: 'mention', name: a.name, path: a.path });
    }
    const mentions = attachments.filter((a) => a.kind !== 'image').map((a) => `- ${a.path}`);
    let body = mentions.length ? `${text}\n\nAttached file paths:\n${mentions.join('\n')}` : text;
    // "/skill-name rest" invokes a Codex skill, mirroring the TUI.
    const m = body.match(/^\/([\w.-]+)\s*([\s\S]*)$/);
    if (m && this.skills.has(m[1])) {
      input.unshift({ type: 'skill', name: m[1], path: this.skills.get(m[1]) });
      body = m[2];
    }
    input.unshift({ type: 'text', text: body, text_elements: [] });
    this.emit({ kind: 'user', text, attachments });
    this.emit({ kind: 'status', status: 'running' });
    try {
      if (!this.threadLoaded) {
        const pol0 = policyFor(this.mode, this.cwd);
        await this.client.request('thread/resume', { threadId: this.threadId, cwd: this.cwd, approvalPolicy: pol0.approvalPolicy, sandbox: pol0.sandboxMode, model: this.model });
        this.threadLoaded = true;
      }
      if (this.turnId) {
        // A turn is in flight: steer it instead of starting a new one.
        await this.client.request('turn/steer', { threadId: this.threadId, input, expectedTurnId: this.turnId });
        return;
      }
      const pol = policyFor(this.mode, this.cwd);
      this.lastAgentText = '';
      const res = await this.client.request<Json>('turn/start', { threadId: this.threadId, input, approvalPolicy: pol.approvalPolicy, sandboxPolicy: pol.sandboxPolicy, cwd: this.cwd, model: this.model });
      this.turnId = String((res.turn as Json)?.id ?? this.turnId);
    } catch (err) {
      // Do not leave the UI in a fake "working" state when the request itself failed.
      this.emit({ kind: 'status', status: 'idle' });
      throw err;
    }
  }

  async interrupt() {
    if (!this.client || !this.threadId || !this.turnId) return;
    try { await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }); }
    catch (err) { this.emit({ kind: 'log', text: `interrupt failed: ${(err as Error).message}` }); }
  }

  async setModel(model: string | null) {
    this.model = model;
    this.emit({ kind: 'session.init', sessionId: this.id, agent: 'codex', cwd: this.cwd, model: model ?? undefined, agentSessionId: this.threadId ?? undefined });
  }

  async setPermissionMode(mode: PermissionModeId) {
    this.mode = mode;
    this.emit({ kind: 'status', status: this.turnId ? 'running' : 'idle', permissionMode: mode });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this.pending) {
      if (p.kind === 'question') this.client?.respond(p.rpcId, { answers: {} });
      else if (p.kind === 'permissions') this.client?.respond(p.rpcId, { permissions: {}, scope: 'turn' });
      else this.client?.respond(p.rpcId, { decision: 'cancel' });
      this.emit({ kind: 'approval.resolved', requestId: id, decision: 'cancelled' });
    }
    this.pending.clear();
    this.client?.kill();
  }
}

/** List Codex threads for a directory using a short-lived app-server process. */
export async function listCodexThreads(codexPath: string, cwd: string | null, limit = 30): Promise<{ sessionId: string; summary: string; lastModified: number; firstPrompt?: string; gitBranch?: string; cwd?: string }[]> {
  const c = new AppServerClient(codexPath, cwd ?? process.env.HOME ?? '/');
  try {
    await c.request('initialize', { clientInfo: { name: 'vibrato', title: 'vibrato', version: '0.1.0' }, capabilities: null });
    c.notify('initialized');
    const res = await c.request<Json>('thread/list', { cwd: cwd ?? null, limit, sortKey: 'updated_at', sortDirection: 'desc', archived: false }, 30000);
    return ((res.data as Json[]) ?? []).map((t) => ({
      sessionId: String(t.id),
      summary: String(t.name ?? t.preview ?? ''),
      lastModified: Number(t.updatedAt ?? t.createdAt ?? 0) * 1000,
      firstPrompt: t.preview ? String(t.preview) : undefined,
      gitBranch: (t.gitInfo as Json | null)?.branch ? String((t.gitInfo as Json).branch) : undefined,
      cwd: t.cwd ? String(t.cwd) : undefined,
    }));
  } finally {
    c.kill();
  }
}

export async function listCodexModels(codexPath: string): Promise<{ id: string; name: string; description?: string; isDefault?: boolean }[]> {
  const c = new AppServerClient(codexPath, process.env.HOME ?? '/');
  try {
    await c.request('initialize', { clientInfo: { name: 'vibrato', title: 'vibrato', version: '0.1.0' }, capabilities: null });
    c.notify('initialized');
    const res = await c.request<Json>('model/list', { includeHidden: false }, 30000);
    return ((res.data as Json[]) ?? []).filter((m) => !m.hidden).map((m) => ({ id: String(m.model ?? m.id), name: String(m.displayName ?? m.model), description: m.description ? String(m.description) : undefined, isDefault: Boolean(m.isDefault) }));
  } finally {
    c.kill();
  }
}

/** Installed skills and plugins as the app-server reports them, for Settings > Agent CLIs. */
export async function listCodexExtensions(codexPath: string): Promise<{ skills: { name: string; description: string; source: 'user' | 'system' | 'admin' | 'project'; plugin?: string; enabled: boolean }[]; plugins: { id: string; name: string; description: string; enabled: boolean; toggle: boolean }[] }> {
  const home = process.env.HOME ?? '/';
  const c = new AppServerClient(codexPath, home);
  try {
    await c.request('initialize', { clientInfo: { name: 'vibrato', title: 'vibrato', version: '0.1.0' }, capabilities: null });
    c.notify('initialized');
    const sk = await c.request<Json>('skills/list', { cwds: [home], forceReload: true }, 30000);
    const skills = ((sk.data as Json[]) ?? []).flatMap((e) => (e.skills as Json[] | undefined) ?? []).filter((s) => s.name).map((s) => ({
      name: String(s.name),
      description: String(s.description ?? s.shortDescription ?? ''),
      source: (s.scope === 'repo' ? 'project' : s.scope === 'system' || s.scope === 'admin' ? s.scope : 'user') as 'user' | 'system' | 'admin' | 'project',
      ...(s.pluginId ? { plugin: String(s.pluginId) } : {}),
      enabled: s.enabled !== false,
    }));
    // Plugins are listed only: their on/off state follows the account, and a -c override does not change it.
    const pl = await c.request<Json>('plugin/list', {}, 30000).catch(() => ({} as Json));
    const plugins = ((pl.marketplaces as Json[] | undefined) ?? []).flatMap((m) => (m.plugins as Json[] | undefined) ?? []).filter((p) => p.installed).map((p) => {
      const ui = (p.interface ?? {}) as Json;
      return { id: String(p.id), name: String(ui.displayName ?? p.name ?? p.id), description: String(ui.shortDescription ?? ''), enabled: p.enabled !== false, toggle: false };
    });
    return { skills: [...new Map(skills.map((s) => [s.name, s])).values()], plugins };
  } finally {
    c.kill();
  }
}

/** Rename / archive Codex threads through a short-lived app-server. */
export async function codexThreadOp(codexPath: string, op: 'rename' | 'delete', threadId: string, name?: string): Promise<void> {
  const c = new AppServerClient(codexPath, process.env.HOME ?? '/');
  try {
    await c.request('initialize', { clientInfo: { name: 'vibrato', title: 'vibrato', version: '0.1.0' }, capabilities: null });
    c.notify('initialized');
    if (op === 'rename') await c.request('thread/name/set', { threadId, name: name ?? '' });
    else await c.request('thread/delete', { threadId }); // permanent, unlike thread/archive
  } finally {
    c.kill();
  }
}
