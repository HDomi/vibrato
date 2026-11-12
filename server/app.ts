import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createFile, duplicate, findEnvFiles, FsError, grepFiles, homeInfo, listDir, mkdir, rawFile, readText, rename, resolvePath, searchFiles, statPath, transfer, trash, writeText } from './fs.js';
import { CUSTOM_PROMPT_MAX, loadConfig, PORT, saveConfig, withConfigLock } from './config.js';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { detectTools, INSTALL_COMMANDS, UPDATE_COMMANDS, type InstallMethod, type ToolId } from './tools.js';
import { forgetCommandPaths, streamShell } from './shell.js';
import { getUsage } from './usage.js';
import { saveAttachment } from './attachments.js';
import { listSessions, getSessionMessages, renameSession, deleteSession } from '@anthropic-ai/claude-agent-sdk';
import type { SessionRegistry } from './sessions.js';
import { previewKind } from './mime.js';
import { codexThreadOp, listCodexModels } from './agents/codex.js';
import { listClaudeModels } from './agents/claude.js';
import { which, run } from './shell.js';
import { applyUpdate, checkUpdate, isUpdating, readBuildInfo, REPO_ROOT, RESTART_EXIT_CODE, UPDATE_SOURCE } from './updater.js';
import { rejectReason } from './guard.js';
import { readPasteboardFiles, writePasteboardFiles } from './pasteboard.js';
import { watch } from 'node:fs';
import { requestShutdown } from './lifecycle.js';
import { lockBeat, type LockBeat } from './lockWatch.js';
import { gitBranches, gitCheckout, gitCommit, gitCommitDiff, gitCommitFiles, gitDiff, gitLog, gitRemoteOp, gitStage, gitStatus } from './git.js';
import { displayableIcon, findProjectIcon } from './icons.js';
import { convertImage, imageInfo, renderPng, writeImageBytes } from './image.js';
import { allBacklogs, cleanBacklog, projectSettings, suggestVerifyCommands, updateProjectSettings } from './verify.js';
import { revertTurn, turnDiff } from './turns.js';
import { agentContext } from './agentContext.js';
import { browserSession, handleMcpBody, toolGroupsOf } from './browserMcp.js';
import { listExtensions, sanitizeExtensions } from './agentExtensions.js';
import { suggestCommitMessage } from './commitMessage.js';
import { exportZip } from './exportZip.js';
import { searchHistory } from './historySearch.js';
import { codexThreads, forgetCodexThreads, isCompactSummary, listHistory } from './history.js';
import { loadWallpaper, saveWallpaperImages, updateWallpaper, WALL_MAX_BYTES, wallpaperPath, WallpaperError, type Wallpaper } from './wallpaper.js';
import { checkWorktree, createWorktree, listWorktrees, mergeWorktree, removeWorktree, worktreeStatus } from './worktree.js';
import { listRuns, projectScripts, removeRun, startRun, stopRun, subscribeRun, type RunInfo, type RunLine } from './runner.js';
import { killProcess, listeningPorts, netInfo, proxyHttp, type ProxyRequest } from './net.js';
import type { Scheduler } from './scheduler.js';
import type { RemoteHost } from './remote/host.js';
import { openSettingsPane, PermissionsError, permissionsSnapshot, removeClaudeRule, removeCodexRule, requestPermission, resetPermission, type ClaudeList } from './permissions.js';
import { ScheduleError } from './schedule.js';
import { cleanFormTypes, FormTypeError } from '../web/src/lib/promptForm.js';

const WEB_DIST = path.join(REPO_ROOT, 'web', 'dist');

// Version/commit of the running build (dist/build-info.json), not of the checkout.
const BUILD = readBuildInfo();

export function createApp(registry?: SessionRegistry, port = PORT, scheduler?: Scheduler, remote?: RemoteHost) {
  const app = new Hono();

  // Reject requests that a web page in the user's browser could forge (see guard.ts).
  app.use('*', async (c, next) => {
    const reason = rejectReason({ host: c.req.header('host'), origin: c.req.header('origin'), secFetchSite: c.req.header('sec-fetch-site') }, port);
    if (reason) return c.json({ error: `Forbidden (${reason})`, code: 'FORBIDDEN' }, 403);
    if (['POST', 'PATCH', 'PUT'].includes(c.req.method) && c.req.path !== '/api/attach' && c.req.path !== '/api/wallpaper/image' && !/^application\/json(?:;|$)/i.test(c.req.header('content-type') ?? '')) return c.json({ error: 'JSON body required', code: 'BAD_REQUEST' }, 415);
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
    if (c.res.headers.get('content-type')?.includes('text/html') && !c.res.headers.has('content-security-policy')) c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http: https:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  });
  app.use('/api/attach', bodyLimit({ maxSize: 32 * 1024 * 1024 }));
  app.use('/api/fs/text', bodyLimit({ maxSize: 16 * 1024 * 1024 }));
  app.use('/api/export/zip', bodyLimit({ maxSize: 96 * 1024 * 1024 }));
  app.use('/api/image/write', bodyLimit({ maxSize: 128 * 1024 * 1024 }));
  app.use('/api/net/http', bodyLimit({ maxSize: 64 * 1024 * 1024 }));
  app.use('/api/wallpaper/image', bodyLimit({ maxSize: 2 * WALL_MAX_BYTES + 1024 * 1024 }));
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && /^(\/api\/favorites(?:\/|$)|\/api\/recent$|\/api\/custom-prompt$|\/api\/settings\/always-plan$|\/api\/settings\/browser-tools$|\/api\/history\/pin$|\/api\/history\/[^/]+$)/.test(c.req.path)) return withConfigLock(next);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof SyntaxError) return c.json({ error: 'Invalid JSON', code: 'BAD_REQUEST' }, 400);
    if (err instanceof ScheduleError || err instanceof FormTypeError || err instanceof PermissionsError) return c.json({ error: err.message, code: 'BAD_REQUEST' }, 400);
    if (err instanceof FsError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    console.error(err);
    return c.json({ error: err.message ?? 'Internal error', code: 'INTERNAL' }, 500);
  });

  // pid / appOwned let an app that adopts an already running server (after the lock watchdog restarted it) stop it on quit.
  app.get('/api/health', (c) => c.json({ ok: true, repo: REPO_ROOT, version: BUILD.version, commit: BUILD.commit, builtAt: BUILD.builtAt, pid: process.pid, appOwned: !!process.env.VIBRATO_ELECTRON_EXEC_PATH }));
  app.get('/api/home', async (c) => c.json(await homeInfo()));

  app.get('/api/fs/list', async (c) => c.json(await listDir(c.req.query('path') ?? '~')));
  app.get('/api/fs/stat', async (c) => c.json(await statPath(c.req.query('path') ?? '~')));
  app.get('/api/fs/text', async (c) => {
    const p = c.req.query('path');
    if (!p) return c.json({ error: 'path required', code: 'BAD_REQUEST' }, 400);
    return c.json(await readText(p));
  });
  app.get('/api/fs/raw', async (c) => {
    const p = c.req.query('path');
    if (!p) return c.json({ error: 'path required', code: 'BAD_REQUEST' }, 400);
    const res = await rawFile(p, c.req.header('range'));
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  app.put('/api/fs/text', async (c) => {
    const b = await c.req.json<{ path: string; content: string; baseMtime?: number | null; bom?: boolean; force?: boolean }>();
    if (!b.path) return c.json({ error: 'path required', code: 'BAD_REQUEST' }, 400);
    return c.json(await writeText(b.path, b.content, { baseMtime: b.baseMtime, bom: !!b.bom, force: !!b.force }));
  });
  app.get('/api/image/info', async (c) => c.json(await imageInfo(c.req.query('path') ?? '')));
  app.get('/api/image/png', async (c) => {
    const n = (k: string) => { const v = Number(c.req.query(k)); return Number.isInteger(v) && v > 0 && v <= 30000 ? v : undefined; };
    const png = await renderPng(c.req.query('path') ?? '', { width: n('width'), height: n('height'), fit: n('fit') });
    return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' } });
  });
  app.post('/api/image/convert', async (c) => {
    const b = await c.req.json<{ path: string; dest: string; format: string; width?: number; height?: number; quality?: number; overwrite?: boolean }>();
    return c.json({ path: await convertImage(b) });
  });
  app.post('/api/image/write', async (c) => {
    const b = await c.req.json<{ dest: string; data: string; overwrite?: boolean }>();
    return c.json({ path: await writeImageBytes(b.dest, Buffer.from(String(b.data ?? ''), 'base64'), !!b.overwrite) });
  });
  // Tools > HTTP and Network. The renderer's CSP only allows its own origin, so outside requests go through here.
  app.post('/api/net/http', async (c) => c.json(await proxyHttp(await c.req.json<ProxyRequest>())));
  app.get('/api/net/info', (c) => c.json(netInfo()));
  app.get('/api/net/ports', async (c) => c.json(await listeningPorts()));
  app.post('/api/net/kill', async (c) => {
    const b = await c.req.json<{ pid: number; force?: boolean }>();
    try { killProcess(Number(b.pid), !!b.force); return c.json({ ok: true }); }
    catch (err) {
      const e = err as NodeJS.ErrnoException & { status?: number };
      const status = e.status ?? (e.code === 'ESRCH' ? 404 : e.code === 'EPERM' ? 403 : 500);
      return c.json({ error: e.code === 'EPERM' ? 'Not permitted (process belongs to another user)' : e.code === 'ESRCH' ? 'No such process' : e.message, code: e.code ?? 'ERR' }, status as 400);
    }
  });
  app.post('/api/fs/create', async (c) => { const b = await c.req.json<{ dir: string; name: string }>(); return c.json({ path: await createFile(b.dir, b.name) }); });
  app.post('/api/fs/mkdir', async (c) => { const b = await c.req.json<{ dir: string; name: string }>(); return c.json({ path: await mkdir(b.dir, b.name) }); });
  app.post('/api/fs/rename', async (c) => { const b = await c.req.json<{ path: string; name: string }>(); return c.json({ path: await rename(b.path, b.name) }); });
  app.post('/api/fs/copy', async (c) => { const b = await c.req.json<{ paths: string[]; dest: string }>(); return c.json({ paths: await transfer(b.paths, b.dest, false) }); });
  app.post('/api/fs/move', async (c) => { const b = await c.req.json<{ paths: string[]; dest: string }>(); return c.json({ paths: await transfer(b.paths, b.dest, true) }); });
  app.post('/api/fs/duplicate', async (c) => { const b = await c.req.json<{ path: string }>(); return c.json({ path: await duplicate(b.path) }); });
  app.post('/api/fs/trash', async (c) => { const b = await c.req.json<{ paths: string[] }>(); await trash(b.paths); return c.json({ ok: true }); });
  app.get('/api/clipboard/files', async (c) => c.json(await readPasteboardFiles()));
  app.post('/api/clipboard/files', async (c) => { const b = await c.req.json<{ paths: string[] }>(); return c.json(await writePasteboardFiles(b.paths)); });
  // Pushes a "change" event whenever a watched folder's contents change (agent edits, Finder,
  // a terminal), so the file browser stays current without ⌘R. Throttled: a burst of writes
  // (npm install, git checkout) becomes one event every 300ms instead of hundreds. The data is a
  // JSON list of the changed paths, or "*" when the burst was too big to list.
  // `path` (repeatable) watches a folder's direct children; `rpath` (repeatable) a whole tree
  // (FSEvents on macOS, one handle however deep), where .git internals are dropped because they
  // churn on every git command. One stream carries them all: browsers allow only six connections
  // per host, and each open SSE holds one. A folder that cannot be watched (deleted, no access)
  // is skipped and the stream stays open, so the client does not reconnect in a loop.
  app.get('/api/fs/watch', (c) => {
    const flat = (c.req.queries('path') ?? []).map((p) => resolvePath(p));
    const deep = (c.req.queries('rpath') ?? []).map((p) => resolvePath(p));
    if (!flat.length && !deep.length) flat.push(resolvePath('~'));
    return streamSSE(c, async (stream) => {
      let timer: NodeJS.Timeout | null = null;
      let changed = new Set<string>();
      let overflow = false;
      const fire = () => {
        timer = null;
        const data = overflow ? '"*"' : JSON.stringify([...changed]);
        changed = new Set(); overflow = false;
        void stream.writeSSE({ event: 'change', data }).catch(() => {});
      };
      const watchers: ReturnType<typeof watch>[] = [];
      const add = (dir: string, recursive: boolean) => {
        try {
          const w = watch(dir, { recursive }, (_event, name) => {
            const rel = name ? String(name) : '';
            if (recursive && /(^|\/)\.git(\/|$)/.test(rel)) return;
            if (!rel) overflow = true;
            else if (!overflow) { changed.add(path.join(dir, rel)); if (changed.size > 500) overflow = true; }
            timer ??= setTimeout(fire, 300);
          });
          w.on('error', () => {});
          watchers.push(w);
        } catch { /* skipped */ }
      };
      for (const d of new Set(deep)) add(d, true);
      for (const d of new Set(flat)) if (!deep.some((r) => d === r || d.startsWith(r + '/'))) add(d, false);
      // Comment pings keep idle connections from being reaped and surface a dead client as an abort.
      const ping = setInterval(() => { void stream.write(': ping\n\n').catch(() => {}); }, 30000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    });
  });

  const favPayload = (cfg: { favorites: unknown; groups: unknown }) => ({ favorites: cfg.favorites, groups: cfg.groups });
  // Project icon auto-detected from common locations; 404 when none.
  app.get('/api/project-icon', async (c) => {
    const p = c.req.query('path');
    if (!p) return c.json({ error: 'path required', code: 'BAD_REQUEST' }, 400);
    const file = await findProjectIcon(p);
    if (!file) return c.body(null, 404);
    const shown = await displayableIcon(file).catch(() => file);
    const res = await rawFile(shown, undefined);
    return new Response(res.body, { status: res.status, headers: { ...res.headers, 'Cache-Control': 'private, max-age=300' } });
  });

  // Conversation export: markdown + its images as one zip (exportZip.ts). `dest` is the user's Save As choice;
  // without it (plain browser tab) the zip comes back as the response body for a download.
  app.post('/api/export/zip', async (c) => {
    const b = await c.req.json<{ dest?: unknown; name?: unknown; markdown?: unknown; images?: unknown }>();
    const images = Array.isArray(b.images)
      ? b.images.filter((i): i is { name: string; src: string } => !!i && typeof i === 'object' && typeof (i as { name?: unknown }).name === 'string' && typeof (i as { src?: unknown }).src === 'string')
      : [];
    const dest = typeof b.dest === 'string' && b.dest ? b.dest : null;
    const out = await exportZip({ name: String(b.name ?? ''), markdown: typeof b.markdown === 'string' ? b.markdown : '', images }, dest);
    if (dest) return c.json({ path: out.path, missing: out.missing });
    return c.body(new Uint8Array(out.bytes!), 200, { 'content-type': 'application/zip', 'x-missing': String(out.missing.length) });
  });
  // "Send as form" types (web/src/lib/promptForm.ts). null = the built-in set; PUT null goes back to it.
  app.get('/api/form-types', async (c) => c.json({ types: (await loadConfig()).formTypes ?? null }));
  app.put('/api/form-types', async (c) => {
    const body = await c.req.json<{ types?: unknown }>();
    const types = body.types === null ? null : cleanFormTypes(body.types);
    return c.json({ types: await withConfigLock(async () => {
      const cfg = await loadConfig();
      if (types) cfg.formTypes = types; else delete cfg.formTypes;
      await saveConfig(cfg);
      return types;
    }) });
  });
  app.get('/api/settings/always-plan', async (c) => c.json({ on: (await loadConfig()).alwaysPlan !== false }));
  app.get('/api/settings/browser-tools', async (c) => c.json({ on: (await loadConfig()).browserTools !== false }));
  app.put('/api/settings/browser-tools', async (c) => {
    const body = await c.req.json<{ on?: unknown }>().catch(() => null);
    if (!body || typeof body.on !== 'boolean') return c.json({ error: 'Expected { on }' }, 400);
    const cfg = await loadConfig();
    if (body.on) delete cfg.browserTools; else cfg.browserTools = false;
    await saveConfig(cfg);
    return c.json({ on: body.on });
  });
  // Vibrato browser tools for agent sessions (server/browserMcp.ts): MCP Streamable HTTP, JSON replies, no SSE stream.
  app.post('/mcp/browser', async (c) => {
    const reply = await handleMcpBody(await c.req.json(), undefined, browserSession(c.req.query('s')), toolGroupsOf({ b: c.req.query('b'), p: c.req.query('p') }));
    return reply === null ? c.body(null, 202) : c.json(reply);
  });
  app.get('/mcp/browser', (c) => c.body(null, 405));
  app.delete('/mcp/browser', (c) => c.body(null, 200));
  app.put('/api/settings/always-plan', async (c) => {
    const body = await c.req.json<{ on?: unknown }>().catch(() => null);
    if (!body || typeof body.on !== 'boolean') return c.json({ error: 'Expected { on }' }, 400);
    const cfg = await loadConfig();
    if (body.on) delete cfg.alwaysPlan; else cfg.alwaysPlan = false;
    await saveConfig(cfg);
    return c.json({ on: body.on });
  });
  app.get('/api/custom-prompt', async (c) => c.json({ text: (await loadConfig()).customPrompt ?? '' }));
  app.put('/api/custom-prompt', async (c) => {
    const body = await c.req.json<{ text?: unknown }>().catch(() => null);
    if (!body || typeof body.text !== 'string') return c.json({ error: 'Expected { text }' }, 400);
    const text = body.text.replace(/\r\n/g, '\n').trim().slice(0, CUSTOM_PROMPT_MAX);
    const cfg = await loadConfig();
    if (text) cfg.customPrompt = text; else delete cfg.customPrompt;
    await saveConfig(cfg);
    return c.json({ text });
  });
  app.get('/api/favorites', async (c) => c.json(favPayload(await loadConfig())));
  app.patch('/api/favorites', async (c) => {
    const body = await c.req.json<{ path: string; name?: string; group?: string | null }>();
    const abs = resolvePath(body.path);
    const cfg = await loadConfig();
    cfg.favorites = cfg.favorites.map((f) => {
      if (f.path !== abs) return f;
      const next = { ...f };
      if (typeof body.name === 'string' && body.name.trim()) next.name = body.name.trim();
      if (body.group === null) delete next.group;
      else if (typeof body.group === 'string' && cfg.groups.some((g) => g.id === body.group)) next.group = body.group;
      return next;
    });
    await saveConfig(cfg);
    return c.json(favPayload(cfg));
  });
  app.post('/api/favorites/groups', async (c) => {
    const body = await c.req.json<{ name: string }>();
    const cfg = await loadConfig();
    const id = `g${Date.now().toString(36)}`;
    cfg.groups.push({ id, name: body.name.trim() || 'Group' });
    await saveConfig(cfg);
    return c.json(favPayload(cfg));
  });
  app.patch('/api/favorites/groups', async (c) => {
    const body = await c.req.json<{ id: string; name?: string; collapsed?: boolean }>();
    const cfg = await loadConfig();
    cfg.groups = cfg.groups.map((g) => (g.id === body.id ? { ...g, ...(body.name?.trim() ? { name: body.name.trim() } : {}), ...(typeof body.collapsed === 'boolean' ? { collapsed: body.collapsed } : {}) } : g));
    await saveConfig(cfg);
    return c.json(favPayload(cfg));
  });
  app.delete('/api/favorites/groups', async (c) => {
    const id = c.req.query('id') ?? '';
    const cfg = await loadConfig();
    cfg.groups = cfg.groups.filter((g) => g.id !== id);
    cfg.favorites = cfg.favorites.map((f) => (f.group === id ? { path: f.path, name: f.name } : f));
    await saveConfig(cfg);
    return c.json(favPayload(cfg));
  });
  app.post('/api/favorites', async (c) => {
    const body = await c.req.json<{ path: string; name?: string }>();
    const abs = resolvePath(body.path);
    const st = await statPath(abs);
    if (!st.isDir) return c.json({ error: 'Not a directory', code: 'ENOTDIR' }, 400);
    const cfg = await loadConfig();
    if (!cfg.favorites.some((f) => f.path === abs)) {
      cfg.favorites.push({ path: abs, name: body.name?.trim() || path.basename(abs) || abs });
      await saveConfig(cfg);
    }
    return c.json(favPayload(cfg));
  });
  app.delete('/api/favorites', async (c) => {
    const p = resolvePath(c.req.query('path') ?? '');
    const cfg = await loadConfig();
    cfg.favorites = cfg.favorites.filter((f) => f.path !== p);
    await saveConfig(cfg);
    return c.json(favPayload(cfg));
  });

  app.get('/api/recent', async (c) => c.json((await loadConfig()).recent));
  app.delete('/api/recent', async (c) => {
    const p = resolvePath(c.req.query('path') ?? '');
    const cfg = await loadConfig();
    cfg.recent = cfg.recent.filter((r) => r !== p);
    await saveConfig(cfg);
    return c.json(cfg.recent);
  });
  app.post('/api/recent', async (c) => {
    const body = await c.req.json<{ path: string }>();
    const abs = resolvePath(body.path);
    const cfg = await loadConfig();
    cfg.recent = [abs, ...cfg.recent.filter((r) => r !== abs)].slice(0, 20);
    await saveConfig(cfg);
    return c.json(cfg.recent);
  });

  app.get('/api/tools', async (c) => c.json(await detectTools(c.req.query('force') === '1')));
  app.get('/api/tools/install', (c) => {
    const tool = c.req.query('tool') as ToolId;
    const method = c.req.query('method') as InstallMethod | 'update';
    const cmd = method === 'update' ? UPDATE_COMMANDS[tool] : INSTALL_COMMANDS[tool]?.[method];
    if (!cmd) return c.json({ error: 'unknown tool/method', code: 'BAD_REQUEST' }, 400);
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'start', data: cmd });
      const code = await streamShell(cmd, (line, src) => {
        void stream.writeSSE({ event: src, data: line });
      });
      forgetCommandPaths();
      await stream.writeSSE({ event: 'done', data: String(code) });
    });
  });

  app.get('/api/usage', async (c) => c.json(await getUsage(c.req.query('force') === '1')));

  // App wallpaper (Settings > Appearance). Images are made in the renderer; see server/wallpaper.ts.
  app.get('/api/wallpaper', async (c) => c.json(await loadWallpaper()));
  app.put('/api/wallpaper', async (c) => {
    try { return c.json(await updateWallpaper(await c.req.json<Partial<Wallpaper>>())); }
    catch (e) { if (e instanceof WallpaperError) return c.json({ error: e.message, code: 'BAD_REQUEST' }, 400); throw e; }
  });
  app.post('/api/wallpaper/image', async (c) => {
    const body = await c.req.parseBody();
    const original = body['original'] instanceof File ? body['original'] : undefined;
    const blur = body['blur'] instanceof File ? body['blur'] : undefined;
    if (!blur) return c.json({ error: 'blurred image required', code: 'BAD_REQUEST' }, 400);
    try { return c.json(await saveWallpaperImages({ original, blur }, Number(body['radius']))); }
    catch (e) { if (e instanceof WallpaperError) return c.json({ error: e.message, code: 'BAD_REQUEST' }, 400); throw e; }
  });
  app.get('/api/wallpaper/:which{original|blur}', async (c) => {
    try {
      const data = await fs.readFile(wallpaperPath(c.req.param('which') as 'original' | 'blur'));
      // URLs carry ?v=<version>, so a cached copy is never stale.
      return new Response(data, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' } });
    } catch { return c.json({ error: 'no wallpaper', code: 'NOT_FOUND' }, 404); }
  });

  app.post('/api/attach', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const files = ([] as unknown[]).concat(body['files'] ?? body['file'] ?? []).filter((f): f is File => f instanceof File);
    const saved = [];
    for (const f of files) {
      const p = await saveAttachment(f);
      const ext = path.extname(p);
      saved.push({ path: p, name: f.name, kind: previewKind(ext, f.name) === 'image' ? 'image' : 'file', mime: f.type || undefined });
    }
    return c.json(saved);
  });

  // Claude Code transcript history for a project directory.
  app.get('/api/history', async (c) => {
    const dir = resolvePath(c.req.query('cwd') ?? '~');
    const q = c.req.query('agent');
    const agent = q === 'claude' || q === 'codex' ? q : 'all';
    const limit = Math.min(300, Math.max(1, Number(c.req.query('limit')) || 30));
    return c.json(await listHistory(dir, agent, limit));
  });
  app.post('/api/history/rename', async (c) => {
    const b = await c.req.json<{ agent: 'claude' | 'codex'; id: string; title: string; cwd?: string }>();
    if (b.agent === 'codex') { const p = await which('codex'); if (p) { await codexThreadOp(p, 'rename', b.id, b.title); forgetCodexThreads(); } }
    else await renameSession(b.id, b.title, b.cwd ? { dir: resolvePath(b.cwd) } : undefined);
    return c.json({ ok: true });
  });
  // Pinned conversations ("agent:cliSessionId"); tabs and the history lists share this one list.
  // Every saved conversation (both CLIs), by what was said in it. Before /api/history/:id, which would take it.
  app.get('/api/history/search', async (c) => c.json(await searchHistory((c.req.query('q') ?? '').slice(0, 200), Math.max(1, Math.min(60, Number(c.req.query('limit')) || 30)))));
  app.get('/api/history/pins', async (c) => c.json((await loadConfig()).pinnedSessions));
  app.post('/api/history/pin', async (c) => {
    const b = await c.req.json<{ agent: 'claude' | 'codex'; id: string; pinned: boolean }>();
    const key = `${b.agent}:${b.id}`;
    const cfg = await loadConfig();
    cfg.pinnedSessions = b.pinned ? [...new Set([...cfg.pinnedSessions, key])] : cfg.pinnedSessions.filter((k) => k !== key);
    await saveConfig(cfg);
    return c.json({ ok: true, pinned: b.pinned });
  });
  app.delete('/api/history/:id', async (c) => {
    const agent = c.req.query('agent') ?? 'claude';
    const cwd = c.req.query('cwd');
    const cfg = await loadConfig();
    if (cfg.pinnedSessions.includes(`${agent}:${c.req.param('id')}`)) return c.json({ error: 'Session is pinned. Unpin it first.', code: 'PINNED' }, 409);
    if (agent === 'codex') { const p = await which('codex'); if (p) { await codexThreadOp(p, 'delete', c.req.param('id')); forgetCodexThreads(); } }
    else await deleteSession(c.req.param('id'), cwd ? { dir: resolvePath(cwd) } : undefined);
    return c.json({ ok: true });
  });
  app.get('/api/fs/env-files', async (c) => c.json(await findEnvFiles(c.req.query('cwd') ?? '~')));
  app.get('/api/fs/grep', async (c) => {
    const q = c.req.query('q') ?? '';
    const opts = { caseSensitive: c.req.query('case') === '1', regex: c.req.query('regex') === '1', limit: Math.max(1, Math.min(5000, Number(c.req.query('limit')) || 1000)) };
    try { new RegExp(opts.regex ? q : ''); } catch (e) { return c.json({ error: (e as Error).message, code: 'BAD_REGEX' }, 400); }
    return c.json(await grepFiles(c.req.query('cwd') ?? '~', q, opts));
  });
  app.get('/api/fs/search', async (c) => c.json(await searchFiles(c.req.query('cwd') ?? '~', c.req.query('q') ?? '', Math.max(1, Math.min(500, Number(c.req.query('limit')) || 200)))));
  app.get('/api/history/:id', async (c) => {
    const dir = resolvePath(c.req.query('cwd') ?? '~');
    const messages = await getSessionMessages(c.req.param('id'), { dir });
    return c.json(messages);
  });

  // Recent sessions across every project (sidebar).
  app.get('/api/history-all', async (c) => {
    const limit = Math.max(1, Math.min(300, Number(c.req.query('limit')) || 20));
    const [claude, codexPath] = await Promise.all([listSessions({ limit }).catch(() => []), which('codex')]);
    const codex = codexPath ? await codexThreads(codexPath, null, limit).catch(() => []) : [];
    const pinned = new Set((await loadConfig()).pinnedSessions);
    const rows = [
      ...claude.map((s) => ({ agent: 'claude' as const, sessionId: s.sessionId, title: s.customTitle || s.summary || (isCompactSummary(s.firstPrompt) ? '' : s.firstPrompt) || s.sessionId, cwd: (s as { cwd?: string }).cwd ?? null, lastModified: s.lastModified })),
      ...codex.map((s) => ({ agent: 'codex' as const, sessionId: s.sessionId, title: s.summary || s.sessionId, cwd: s.cwd ?? null, lastModified: s.lastModified })),
    ].map((s) => ({ ...s, pinned: pinned.has(`${s.agent}:${s.sessionId}`) }))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastModified - a.lastModified).slice(0, limit);
    return c.json(rows);
  });

  app.get('/api/models', async (c) => {
    if (c.req.query('agent') === 'codex') {
      const codexPath = await which('codex');
      return c.json(codexPath ? await listCodexModels(codexPath).catch(() => []) : []);
    }
    const claudePath = await which('claude');
    return c.json(claudePath ? await listClaudeModels(claudePath).catch(() => []) : []);
  });

  // Installed skills / plugins per CLI, and the ones turned off for new sessions (agentExtensions.ts).
  app.get('/api/extensions', async (c) => {
    const agent = c.req.query('agent') === 'codex' ? 'codex' : 'claude';
    const [list, cfg] = await Promise.all([listExtensions(agent, await which(agent), c.req.query('force') === '1'), loadConfig()]);
    return c.json({ ...list, off: sanitizeExtensions(cfg.extensionsOff)[agent] ?? {} });
  });
  app.put('/api/extensions', async (c) => {
    const body = await c.req.json<{ agent?: unknown; skills?: unknown; plugins?: unknown }>().catch(() => null);
    if (!body || (body.agent !== 'claude' && body.agent !== 'codex')) return c.json({ error: 'Expected { agent, skills, plugins }' }, 400);
    const agent = body.agent;
    const off = await withConfigLock(async () => {
      const cfg = await loadConfig();
      const next = sanitizeExtensions({ ...sanitizeExtensions(cfg.extensionsOff), [agent]: { skills: body.skills, plugins: body.plugins } });
      if (Object.keys(next).length) cfg.extensionsOff = next; else delete cfg.extensionsOff;
      await saveConfig(cfg);
      return next[agent] ?? {};
    });
    return c.json({ off });
  });

  app.get('/api/sessions', (c) => c.json(registry?.list() ?? []));

  // Instruction files, skills, hooks and MCP servers the agents see in a project (agentContext.ts).
  app.get('/api/agent-context', async (c) => c.json(await agentContext(c.req.query('cwd') ?? '~')));

  // Scheduled skill / prompt runs (scheduler.ts). Every change answers with the fresh snapshot.
  const sched = () => { if (!scheduler) throw new ScheduleError('Scheduling is not available on this server'); return scheduler; };
  app.get('/api/schedules', async (c) => c.json(await sched().snapshot()));
  app.post('/api/schedules', async (c) => { await sched().create(await c.req.json()); return c.json(await sched().snapshot()); });
  app.patch('/api/schedules/:id', async (c) => { await sched().update(c.req.param('id'), await c.req.json()); return c.json(await sched().snapshot()); });
  app.delete('/api/schedules/:id', async (c) => { await sched().remove(c.req.param('id')); return c.json(await sched().snapshot()); });
  app.post('/api/schedules/:id/run', async (c) => { await sched().runNow(c.req.param('id')); return c.json(await sched().snapshot()); });
  app.delete('/api/schedule-runs', async (c) => { sched().clearRuns(); return c.json(await sched().snapshot()); });
  // Installs or removes the wake helper (schedulePower.ts) behind the system's admin password prompt.
  // Remote sessions host (server/remote/host.ts): local settings only; the remote side never reaches these routes.
  const remoteHost = () => { if (!remote) throw new Error('Remote host unavailable'); return remote; };
  app.get('/api/remote/host', async (c) => c.json(await remoteHost().status()));
  // Cheap poll for the title bar's "remote connected" dot: no config read.
  app.get('/api/remote/host/clients', (c) => c.json({ clients: remoteHost().authedCount() }));
  app.put('/api/remote/host', async (c) => {
    const b = await c.req.json<{ enabled?: unknown; port?: unknown; keepAwake?: unknown; wakeOnConnect?: unknown }>();
    const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    try {
      const { code } = await remoteHost().configure({ enabled: bool(b.enabled), port: b.port === undefined ? undefined : Number(b.port), keepAwake: bool(b.keepAwake), wakeOnConnect: bool(b.wakeOnConnect) });
      return c.json({ code, ...(await remoteHost().status()) });
    } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });
  app.put('/api/remote/host/password', async (c) => {
    const b = await c.req.json<{ password?: unknown }>();
    try {
      await remoteHost().setPassword(typeof b.password === 'string' ? b.password : null);
      return c.json(await remoteHost().status());
    } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });
  app.put('/api/remote/host/webhook', async (c) => {
    const b = await c.req.json<{ url?: unknown }>();
    try {
      await remoteHost().setWebhook(typeof b.url === 'string' ? b.url : null);
      return c.json(await remoteHost().status());
    } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });
  app.post('/api/remote/host/webhook/test', async (c) => {
    try { await remoteHost().testWebhook(); return c.json({ ok: true }); }
    catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });
  app.post('/api/remote/host/code', async (c) => c.json({ code: await remoteHost().newCode(), ...(await remoteHost().status()) }));
  app.post('/api/remote/host/disconnect', async (c) => { remoteHost().disconnectAll(); return c.json(await remoteHost().status()); });
  app.post('/api/schedules/wake-helper', async (c) => {
    const b = await c.req.json<{ install?: unknown; prompt?: unknown }>();
    const result = await sched().power.setHelper(b.install === true, typeof b.prompt === 'string' && b.prompt ? b.prompt.slice(0, 300) : 'Vibrato wants to wake this Mac for scheduled runs.');
    await sched().tick();
    return c.json({ result, ...(await sched().snapshot()) });
  });

  // Settings > Permissions (permissions.ts): macOS privacy grants, past and present, and the agents' rules.
  app.get('/api/permissions', async (c) => c.json(await permissionsSnapshot({
    bundlePath: c.req.query('bundlePath'),
    wakeHelper: scheduler ? () => scheduler.power.helperInstalled(true) : undefined,
  })));
  app.post('/api/permissions/request', async (c) => c.json({ state: await requestPermission(String((await c.req.json<{ id?: unknown }>()).id ?? '')) }));
  app.post('/api/permissions/reset', async (c) => {
    const b = await c.req.json<{ service?: unknown; bundlePath?: unknown }>();
    await resetPermission(String(b.service ?? ''), typeof b.bundlePath === 'string' ? b.bundlePath : undefined);
    return c.json({ ok: true });
  });
  app.post('/api/permissions/open', async (c) => { await openSettingsPane(String((await c.req.json<{ pane?: unknown }>()).pane ?? '')); return c.json({ ok: true }); });
  app.post('/api/permissions/claude-rule/remove', async (c) => {
    const b = await c.req.json<{ file?: unknown; list?: unknown; rule?: unknown }>();
    await removeClaudeRule(String(b.file ?? ''), String(b.list ?? '') as ClaudeList, String(b.rule ?? ''));
    return c.json({ ok: true });
  });
  app.post('/api/permissions/codex-rule/remove', async (c) => {
    const b = await c.req.json<{ file?: unknown; text?: unknown }>();
    await removeCodexRule(String(b.file ?? ''), String(b.text ?? ''));
    return c.json({ ok: true });
  });

  // Task backlog per project; the client runs it (see web/src/lib/backlog.ts).
  app.get('/api/backlog/all', async (c) => c.json(await allBacklogs()));
  app.get('/api/backlog', async (c) => c.json((await projectSettings(c.req.query('cwd') ?? '~')).backlog ?? cleanBacklog({})));
  app.put('/api/backlog', async (c) => {
    const b = await c.req.json<{ cwd: string; backlog: unknown }>();
    if (!b.cwd) return c.json({ error: 'cwd required', code: 'BAD_REQUEST' }, 400);
    const backlog = cleanBacklog(b.backlog);
    await updateProjectSettings(b.cwd, (p) => ({ ...p, backlog: backlog.items.length || backlog.auto ? backlog : undefined }));
    return c.json(backlog);
  });

  // Worktree sessions (worktree.ts).
  app.get('/api/worktree/list', async (c) => c.json(await listWorktrees(c.req.query('cwd') ?? '~')));
  app.post('/api/worktree/create', async (c) => { const b = await c.req.json<{ cwd: string; branch?: string }>(); return c.json(await createWorktree(b.cwd, b.branch)); });
  app.post('/api/worktree/status', async (c) => c.json(await worktreeStatus(checkWorktree((await c.req.json<{ info: unknown }>()).info))));
  app.post('/api/worktree/merge', async (c) => { const b = await c.req.json<{ info: unknown; commitMessage?: string }>(); return c.json(await mergeWorktree(checkWorktree(b.info), typeof b.commitMessage === 'string' ? b.commitMessage : undefined)); });
  app.post('/api/worktree/remove', async (c) => { const b = await c.req.json<{ info: unknown; force?: boolean }>(); return c.json(await removeWorktree(checkWorktree(b.info), !!b.force)); });

  // Run panel (runner.ts): project scripts and long-running dev servers owned by the server.
  app.get('/api/run/scripts', async (c) => c.json(await projectScripts(c.req.query('cwd') ?? '~')));
  app.get('/api/run/list', (c) => c.json(listRuns(c.req.query('cwd'))));
  app.post('/api/run/start', async (c) => {
    const b = await c.req.json<{ cwd: string; name?: string; command: string }>();
    const command = String(b.command ?? '').trim();
    if (!b.cwd || !command) return c.json({ error: 'cwd and command required', code: 'BAD_REQUEST' }, 400);
    return c.json(await startRun(b.cwd, String(b.name || command).slice(0, 120), command.slice(0, 4000)));
  });
  app.post('/api/run/stop', async (c) => { const b = await c.req.json<{ id: string }>(); return c.json({ ok: stopRun(String(b.id)) }); });
  app.post('/api/run/remove', async (c) => { const b = await c.req.json<{ id: string }>(); void removeRun(String(b.id)); return c.json({ ok: true }); });
  app.get('/api/run/stream', (c) => streamSSE(c, async (stream) => {
    const id = c.req.query('id') ?? '';
    const after = Number(c.req.query('after') ?? -1);
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => { resolveDone = r; });
    // Lines are batched per tick: a chatty build would otherwise send thousands of tiny SSE frames.
    let batch: RunLine[] = [];
    let timer: NodeJS.Timeout | null = null;
    const flush = () => { timer = null; if (batch.length) { void stream.writeSSE({ event: 'lines', data: JSON.stringify(batch) }).catch(() => {}); batch = []; } };
    const off = subscribeRun(id, Number.isFinite(after) ? after : -1, {
      line: (l) => { batch.push(l); timer ??= setTimeout(flush, 50); },
      info: (i: RunInfo) => { flush(); void stream.writeSSE({ event: 'info', data: JSON.stringify(i) }).catch(() => {}); },
      removed: () => { flush(); void stream.writeSSE({ event: 'removed', data: '1' }).catch(() => {}); resolveDone(); },
    });
    if (!off) { await stream.writeSSE({ event: 'removed', data: '1' }); return; }
    const ping = setInterval(() => { void stream.write(': ping\n\n').catch(() => {}); }, 30000);
    stream.onAbort(resolveDone);
    await done;
    clearInterval(ping); if (timer) clearTimeout(timer); off();
  }));

  // Turn change cards (snapshots from turns.ts): one file's diff, and putting files or hunks back.
  app.get('/api/turns/diff', async (c) => c.text(await turnDiff(c.req.query('root') ?? '', c.req.query('from') ?? '', c.req.query('to') ?? '', c.req.query('path') ?? '')));
  app.post('/api/turns/revert', async (c) => {
    const b = await c.req.json<{ root: string; from: string; to: string; files?: string[]; hunk?: { file: string; index: number }; force?: boolean }>();
    return c.json(await revertTurn(b.root, b.from, b.to, { files: Array.isArray(b.files) ? b.files.map(String) : undefined, hunk: b.hunk && typeof b.hunk.file === 'string' ? { file: b.hunk.file, index: Number(b.hunk.index) || 0 } : undefined, force: !!b.force }));
  });

  // Per-project verification command (run after agent turns that changed files, see verify.ts).
  app.get('/api/project/verify', async (c) => {
    const cwd = c.req.query('cwd') ?? '~';
    const [settings, suggestions] = await Promise.all([projectSettings(cwd), suggestVerifyCommands(cwd)]);
    return c.json({ command: settings.verify?.command ?? '', auto: settings.verify?.auto ?? false, suggestions });
  });
  app.put('/api/project/verify', async (c) => {
    const b = await c.req.json<{ cwd: string; command: string; auto: boolean }>();
    if (!b.cwd) return c.json({ error: 'cwd required', code: 'BAD_REQUEST' }, 400);
    const command = String(b.command ?? '').trim().slice(0, 2000);
    const next = await updateProjectSettings(b.cwd, (p) => ({ ...p, verify: command ? { command, auto: !!b.auto } : undefined }));
    return c.json({ command: next.verify?.command ?? '', auto: next.verify?.auto ?? false });
  });

  // Open a folder in the native Terminal / iTerm / Finder / VS Code.
  // The path is passed to AppleScript as argv and shell-quoted with `quoted form of`, so folder names
  // containing quotes, backslashes or $(...) cannot inject commands.
  app.post('/api/open', async (c) => {
    const body = await c.req.json<{ path: string; app?: 'terminal' | 'iterm' | 'finder' | 'vscode' | 'cursor' }>();
    const abs = resolvePath(body.path);
    const target = body.app ?? 'terminal';
    const osa = (lines: string[]) => run('osascript', [...lines.flatMap((l) => ['-e', l]), '--', abs]);
    let r;
    if (target === 'finder') r = await run('open', [abs]);
    else if (target === 'vscode') r = await run('open', ['-a', 'Visual Studio Code', abs]);
    else if (target === 'cursor') r = await run('open', ['-a', 'Cursor', abs]);
    else if (target === 'iterm') {
      r = await osa(['on run argv', 'tell application "iTerm"', 'activate', 'set w to (create window with default profile)',
        'tell current session of w to write text ("cd " & quoted form of (item 1 of argv))', 'end tell', 'end run']);
    } else {
      r = await osa(['on run argv', 'tell application "Terminal"', 'activate', 'do script ("cd " & quoted form of (item 1 of argv))', 'end tell', 'end run']);
    }
    if (!r.ok) return c.json({ error: r.stderr, code: 'OPEN_FAILED' }, 500);
    return c.json({ ok: true });
  });

  // Git panel.
  app.get('/api/git/status', async (c) => c.json(await gitStatus(c.req.query('cwd') ?? '~')));
  app.get('/api/git/diff', async (c) => c.text(await gitDiff(c.req.query('cwd') ?? '~', c.req.query('path') ?? '', c.req.query('staged') === '1')));
  app.get('/api/git/log', async (c) => c.json(await gitLog(c.req.query('cwd') ?? '~', Number(c.req.query('skip') ?? 0) || 0, Number(c.req.query('limit') ?? 30) || 30)));
  app.get('/api/git/show', async (c) => c.json(await gitCommitFiles(c.req.query('cwd') ?? '~', c.req.query('hash') ?? '')));
  app.get('/api/git/show-diff', async (c) => c.text(await gitCommitDiff(c.req.query('cwd') ?? '~', c.req.query('hash') ?? '', c.req.query('path') ?? '')));
  app.post('/api/git/stage', async (c) => {
    const b = await c.req.json<{ cwd: string; paths: string[]; action: 'add' | 'reset' | 'discard' }>();
    await gitStage(b.cwd, b.paths, b.action);
    return c.json({ ok: true });
  });
  app.get('/api/git/branches', async (c) => c.json(await gitBranches(c.req.query('cwd') ?? '~')));
  app.post('/api/git/checkout', async (c) => {
    const b = await c.req.json<{ cwd: string; branch: string; create?: boolean }>();
    return c.json(await gitCheckout(b.cwd, b.branch, Boolean(b.create)));
  });
  app.post('/api/git/remote', async (c) => {
    const b = await c.req.json<{ cwd: string; op: 'fetch' | 'pull' | 'push' }>();
    return c.json(await gitRemoteOp(b.cwd, b.op));
  });
  app.post('/api/git/suggest-message', async (c) => {
    const b = await c.req.json<{ cwd: string }>();
    try { return c.json(await suggestCommitMessage(b.cwd)); }
    catch (err) { const e = err as Error & { code?: string }; return c.json({ error: e.message, code: e.code ?? 'SUGGEST_FAILED' }, e.code === 'NOTHING_STAGED' ? 400 : 500); }
  });
  app.post('/api/git/commit', async (c) => {
    const b = await c.req.json<{ cwd: string; message: string }>();
    return c.json(await gitCommit(b.cwd, b.message));
  });

  // Self-update: GitHub releases for the standalone app, the git remote for a source checkout (updater.ts).
  app.get('/api/update/status', async (c) => c.json(await checkUpdate(c.req.query('force') === '1')));
  app.get('/api/update/apply', (c) => streamSSE(c, async (stream) => {
    if (isUpdating()) {
      await stream.writeSSE({ event: 'stderr', data: 'An update is already running.' });
      await stream.writeSSE({ event: 'done', data: '1' });
      return;
    }
    // Idle sessions are closed on restart and the client resumes them; only an in-flight turn would be lost.
    if (registry && registry.runningCount() > 0 && c.req.query('force') !== '1') {
      await stream.writeSSE({ event: 'stderr', data: 'A session is still working; update deferred. Wait for it to finish or force.' });
      await stream.writeSSE({ event: 'done', data: '1' });
      return;
    }
    const version = c.req.query('version');
    if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
      await stream.writeSSE({ event: 'stderr', data: 'Invalid version.' });
      await stream.writeSSE({ event: 'done', data: '1' });
      return;
    }
    await stream.writeSSE({ event: 'start', data: UPDATE_SOURCE === 'release'
      ? (version ? `Download release v${version}, verify it, and install it when the app restarts` : 'Download the latest release, verify it, and install it when the app restarts')
      : 'Clone, install and build in a temporary directory, then replace the installed build' });
    const code = await applyUpdate((line, src) => { stream.writeSSE({ event: src, data: line }).catch(() => {}); }, version || undefined).catch((e) => { stream.writeSSE({ event: 'stderr', data: String((e as Error).message) }).catch(() => {}); return 1; });
    await stream.writeSSE({ event: 'done', data: String(code) });
    if (code === 0) {
      await stream.writeSSE({ event: 'restart', data: String(RESTART_EXIT_CODE) });
      setTimeout(() => requestShutdown('update applied', RESTART_EXIT_CODE), 800);
    }
  }));
  // Lock screen failsafe (see lockWatch.ts). Only the Electron main process calls this; pages always send an Origin.
  app.post('/api/lock-watch', async (c) => {
    if (c.req.header('origin')) return c.json({ ok: false }, 403);
    return c.json(lockBeat(await c.req.json<LockBeat>().catch(() => ({ active: false }))));
  });
  app.post('/api/restart', (c) => { setTimeout(() => requestShutdown('restart requested', RESTART_EXIT_CODE), 300); return c.json({ ok: true }); });

  // Static SPA (production build)
  const root = path.relative(process.cwd(), WEB_DIST) || '.';
  app.use('/*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: 'index.html' }));

  return app;
}
