import { useSyncExternalStore } from 'react';
import type { EditorState, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { api, ApiError, type PreviewKind, type TextFile } from '../api';
import { t } from '../i18n';
import { languageOf } from './languages';

/**
 * Open editor tabs and their buffers. Kept outside React: a keystroke updates the buffer here and
 * only re-renders when something on screen changes (dirty dot, conflict banner), never per key.
 * CodeMirror itself is loaded on first use through ./setup.
 */

export type ReadOnlyReason = 'truncated' | 'lossy' | null;
export type Conflict = 'changed' | 'deleted' | null;

export interface Doc {
  path: string;
  name: string;
  kind: PreviewKind | null; // null until stat'ed (restored tabs)
  status: 'idle' | 'loading' | 'ready' | 'binary' | 'error';
  error?: string;
  state?: EditorState;
  saved?: Text;
  mtime: number | null;
  bom: boolean;
  eol: '\n' | '\r\n';
  readOnly: ReadOnlyReason;
  dirty: boolean;
  conflict: Conflict;
  lang: string;
  /** Markdown: rendered or source. */
  mdMode: 'preview' | 'edit';
  /** Bumped when a media file changes on disk, to bust the <img>/<video> cache. */
  rev: number;
  scroll?: unknown;
  /** A disk change arrived while loading; look again once loaded. */
  recheck?: boolean;
  /** Select this range and scroll to it once the editor shows the doc (⇧⌘F results). `line` 1-based, `col` 0-based. */
  reveal?: { line: number; col: number; len: number };
}

export interface Tab { path: string; preview: boolean }

type Setup = typeof import('./setup');
let setupP: Promise<Setup> | null = null;
const setup = () => (setupP ??= import('./setup'));

const MEDIA: PreviewKind[] = ['image', 'video', 'audio', 'pdf'];
const BACKUP = 'vibe.editor.backup:';
const TABS = 'vibe.editor.tabs:';
const BACKUP_MAX = 1024 * 1024;

const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');

interface Backup { content: string; mtime: number | null }
function readBackup(path: string): Backup | null {
  try { const raw = localStorage.getItem(BACKUP + path); return raw ? JSON.parse(raw) as Backup : null; } catch { return null; }
}
function hasBackup(path: string) { try { return localStorage.getItem(BACKUP + path) !== null; } catch { return false; } }
/** The buffer (and base mtime) last written as each path's backup, so an unchanged buffer is not stringified and stored again. */
const lastBackup = new Map<string, { text: Text; mtime: number | null }>();
function dropBackup(path: string) { lastBackup.delete(path); try { localStorage.removeItem(BACKUP + path); } catch { /* ignore */ } }

export type FsChange = string[] | '*';

class EditorStore {
  tabs: Tab[] = [];
  active: string | null = null;
  docs = new Map<string, Doc>();
  root: string | null = null;
  view: EditorView | null = null;
  version = 0;
  private listeners = new Set<() => void>();
  private fsListeners = new Set<(c: FsChange) => void>();
  private watch: { url: string; es: EventSource } | null = null;
  private backupTimers = new Map<string, number>();
  private persistTimer = 0;
  private cm: Setup | null = null;

  subscribe = (f: () => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  snapshot = () => this.version;
  emit() { this.version++; for (const f of this.listeners) f(); }

  /** File-system changes under the project (and around open files), already throttled by the server. */
  onFsChange(f: (c: FsChange) => void) { this.fsListeners.add(f); return () => { this.fsListeners.delete(f); }; }

  /** Cursor/selection moves, at most once a frame (status bar). */
  onCursor(f: () => void) { this.cursorListeners.add(f); return () => { this.cursorListeners.delete(f); }; }
  private cursorListeners = new Set<() => void>();
  private cursorFrame = 0;
  private cursorMoved() {
    if (this.cursorFrame) return;
    this.cursorFrame = requestAnimationFrame(() => { this.cursorFrame = 0; for (const f of this.cursorListeners) f(); });
  }

  get activeDoc() { return this.active ? this.docs.get(this.active) ?? null : null; }

  /* ── project / persistence ─────────────────────────────────────── */

  setRoot(root: string | null) {
    if (root === this.root) return;
    this.persistNow();
    this.flushBackups();
    // Buffers of the project being left stay in memory (an edit too big for a backup must not be
    // lost by switching projects); clean ones are dropped and simply reread when reopened.
    const keep = new Set(this.tabs.map((x) => x.path));
    for (const [p, doc] of this.docs) if (!doc.dirty || !keep.has(p)) this.docs.delete(p);
    this.root = root;
    this.tabs = []; this.active = null;
    try {
      const raw = root ? localStorage.getItem(TABS + root) : null;
      const saved = raw ? JSON.parse(raw) as { tabs: Tab[]; active: string | null } : null;
      if (saved) { this.tabs = saved.tabs.filter((x) => typeof x?.path === 'string'); this.active = saved.active; }
    } catch { /* ignore */ }
    for (const tab of this.tabs) {
      const doc = this.ensureDoc(tab.path);
      // Kept from an earlier visit: nothing was watching it meanwhile.
      if (doc.status === 'ready') void this.checkDisk(doc, true);
    }
    if (this.active && !this.tabs.some((x) => x.path === this.active)) this.active = this.tabs[0]?.path ?? null;
    // Only the visible tab is read now; the rest load when picked.
    const doc = this.activeDoc;
    if (doc?.status === 'idle') void this.load(doc);
    this.syncWatchers();
    this.emit();
  }

  private persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.persistNow(), 300);
  }
  private persistNow() {
    clearTimeout(this.persistTimer);
    if (!this.root) return;
    try { localStorage.setItem(TABS + this.root, JSON.stringify({ tabs: this.tabs, active: this.active })); } catch { /* ignore */ }
  }

  private ensureDoc(path: string, kind: PreviewKind | null = null): Doc {
    let doc = this.docs.get(path);
    if (!doc) {
      doc = {
        path, name: nameOf(path), kind, status: 'idle', mtime: null, bom: false, eol: '\n', readOnly: null,
        dirty: hasBackup(path), conflict: null, lang: languageOf(nameOf(path)).id, mdMode: 'preview', rev: 0,
      };
      this.docs.set(path, doc);
    }
    return doc;
  }

  /* ── tabs ──────────────────────────────────────────────────────── */

  /** Open a file. A preview (single-click) tab is reused by the next preview, VS Code style. `at` selects a range in it. */
  open(path: string, opts: { preview?: boolean; kind?: PreviewKind; at?: Doc['reveal'] } = {}) {
    const preview = opts.preview ?? false;
    const existing = this.tabs.find((x) => x.path === path);
    if (existing) {
      if (!preview) existing.preview = false;
    } else {
      const reuse = preview ? this.tabs.findIndex((x) => x.preview && !this.docs.get(x.path)?.dirty) : -1;
      const tab = { path, preview };
      if (reuse >= 0) { this.forget(this.tabs[reuse].path); this.tabs[reuse] = tab; }
      else {
        const at = this.active ? this.tabs.findIndex((x) => x.path === this.active) + 1 : this.tabs.length;
        this.tabs.splice(at || this.tabs.length, 0, tab);
      }
    }
    const doc = this.ensureDoc(path, opts.kind ?? null);
    if (opts.at) { doc.reveal = opts.at; if (doc.kind === 'markdown' || doc.lang === 'markdown') doc.mdMode = 'edit'; }
    this.activate(path);
    this.syncWatchers();
  }

  activate(path: string) {
    this.active = path;
    const doc = this.docs.get(path);
    if (doc && doc.status === 'idle') void this.load(doc);
    this.persist();
    this.emit();
  }

  pin(path: string) {
    const tab = this.tabs.find((x) => x.path === path);
    if (tab?.preview) { tab.preview = false; this.persist(); this.emit(); }
  }

  /** Close a tab; asks before dropping unsaved changes unless `force`. */
  close(path: string, force = false): boolean {
    const doc = this.docs.get(path);
    if (!force && doc?.dirty && !window.confirm(t('editor.confirmDiscard', { name: doc.name }))) return false;
    const i = this.tabs.findIndex((x) => x.path === path);
    if (i < 0) return true;
    this.tabs.splice(i, 1);
    this.forget(path);
    if (this.active === path) {
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      this.active = next?.path ?? null;
      if (next) { const d = this.docs.get(next.path); if (d?.status === 'idle') void this.load(d); }
    }
    this.syncWatchers();
    this.persist();
    this.emit();
    return true;
  }

  closeOthers(path: string) { for (const x of [...this.tabs]) if (x.path !== path && !this.close(x.path)) return; }
  closeAll() { for (const x of [...this.tabs]) if (!this.close(x.path)) return; }

  private forget(path: string) {
    dropBackup(path);
    clearTimeout(this.backupTimers.get(path));
    this.docs.delete(path);
  }

  move(from: number, to: number) {
    const [tab] = this.tabs.splice(from, 1);
    if (!tab) return;
    this.tabs.splice(to, 0, tab);
    this.persist(); this.emit();
  }

  /** Follow a rename/move made in the explorer: tabs, buffers and backups keep their content. */
  renamed(from: string, to: string) {
    let hit = false;
    for (const [p, doc] of [...this.docs]) {
      if (!within(p, from)) continue;
      const next = to + p.slice(from.length);
      this.docs.delete(p); doc.path = next; doc.name = nameOf(next); this.docs.set(next, doc);
      // Move the backup as stored: a tab that was never loaded has no buffer to rewrite it from.
      try { const raw = localStorage.getItem(BACKUP + p); if (raw !== null) { localStorage.setItem(BACKUP + next, raw); localStorage.removeItem(BACKUP + p); } } catch { /* ignore */ }
      lastBackup.delete(p);
      const timer = this.backupTimers.get(p); if (timer) { clearTimeout(timer); this.backupTimers.delete(p); this.scheduleBackup(doc); }
      for (const tab of this.tabs) if (tab.path === p) tab.path = next;
      if (this.active === p) this.active = next;
      hit = true;
    }
    if (hit) { this.syncWatchers(); this.persist(); this.emit(); }
  }

  /** Files moved to the Trash from the explorer: close their tabs without asking. */
  removed(paths: string[]) {
    for (const p of paths) for (const tab of [...this.tabs]) if (within(tab.path, p)) this.close(tab.path, true);
  }

  /* ── loading / saving ──────────────────────────────────────────── */

  private async load(doc: Doc) {
    doc.status = 'loading'; doc.error = undefined;
    this.emit();
    try {
      if (!doc.kind) doc.kind = (await api.stat(doc.path)).kind;
      if (MEDIA.includes(doc.kind)) { doc.status = 'ready'; this.emit(); return; }
      const [file, cm] = await Promise.all([api.text(doc.path), setup()]);
      this.cm = cm;
      if (!this.docs.has(doc.path) || this.docs.get(doc.path) !== doc) return; // closed meanwhile
      if (file.binary) { doc.status = 'binary'; this.emit(); return; }
      doc.mtime = file.mtime; doc.bom = file.bom;
      doc.eol = file.content.includes('\r\n') ? '\r\n' : '\n';
      doc.readOnly = file.truncated ? 'truncated' : file.lossy ? 'lossy' : null;
      const backup = doc.readOnly ? null : readBackup(doc.path);
      doc.state = await cm.createState(backup?.content ?? file.content, { lang: doc.lang, readOnly: !!doc.readOnly, hooks: this.hooks(doc) });
      doc.saved = cm.textOf(file.content);
      doc.dirty = cm.isDirty(doc.state.doc, doc.saved);
      if (!doc.dirty) dropBackup(doc.path);
      // An unsaved buffer from before a restart whose file has since moved on: same as a live conflict.
      if (doc.dirty && backup && backup.mtime !== null && backup.mtime !== file.mtime) doc.conflict = 'changed';
      if (doc.kind === 'markdown' && doc.dirty) doc.mdMode = 'edit';
      doc.status = 'ready';
    } catch (e) {
      const backup = readBackup(doc.path);
      if (e instanceof ApiError && e.status === 404 && backup) {
        // Deleted or moved while the app was closed, with unsaved text: keep the text, like a live delete.
        const cm = this.cm = await setup();
        doc.kind ??= 'text';
        doc.state = await cm.createState(backup.content, { lang: doc.lang, readOnly: false, hooks: this.hooks(doc) });
        doc.saved = cm.textOf('');
        doc.mtime = backup.mtime;
        doc.dirty = true; doc.conflict = 'deleted'; doc.mdMode = 'edit';
        doc.status = 'ready';
      } else {
        doc.status = 'error';
        doc.error = (e as Error).message;
      }
    }
    this.emit();
    if (doc.recheck && doc.status === 'ready') { doc.recheck = false; void this.checkDisk(doc, true); }
  }

  private hooks(doc: Doc) {
    return {
      onUpdate: (state: EditorState, changed: boolean, remote: boolean) => {
        doc.state = state;
        if (this.active === doc.path) this.cursorMoved();
        if (!changed || !doc.saved || !this.cm) return;
        const dirty = this.cm.isDirty(state.doc, doc.saved);
        if (dirty !== doc.dirty) {
          doc.dirty = dirty;
          if (dirty && !remote) this.pin(doc.path);
          this.emit();
        }
        if (dirty) this.scheduleBackup(doc); else dropBackup(doc.path);
      },
      onSave: () => { void this.save(doc.path); },
    };
  }

  // Hot exit: unsaved buffers survive a crash, an update relaunch or a quit, like VS Code.
  private scheduleBackup(doc: Doc) {
    clearTimeout(this.backupTimers.get(doc.path));
    const path = doc.path;
    // The entry goes once the timer fires, so flushBackups only writes backups that are still pending.
    this.backupTimers.set(path, window.setTimeout(() => { this.backupTimers.delete(path); this.writeBackup(doc); }, 800));
  }
  private writeBackup(doc: Doc) {
    if (!doc.state || !doc.dirty || doc.state.doc.length > BACKUP_MAX) return;
    const text = doc.state.doc, last = lastBackup.get(doc.path);
    if (last && last.text === text && last.mtime === doc.mtime) return;
    try {
      localStorage.setItem(BACKUP + doc.path, JSON.stringify({ content: text.toString(), mtime: doc.mtime } satisfies Backup));
      lastBackup.set(doc.path, { text, mtime: doc.mtime });
    } catch { /* quota: skip */ }
  }
  /** Write pending backups now (project switch, reload, quit, update relaunch). */
  flushBackups() {
    for (const [p, timer] of this.backupTimers) {
      clearTimeout(timer);
      const doc = this.docs.get(p);
      if (doc) this.writeBackup(doc);
    }
    this.backupTimers.clear();
  }

  async save(path: string, force = false) {
    const doc = this.docs.get(path);
    if (!doc?.state || doc.readOnly) return;
    if (doc.conflict && !force) { this.emit(); return; } // the banner asks first
    const state = doc.state;
    try {
      const r = await api.saveText(path, state.doc.sliceString(0, state.doc.length, doc.eol), { baseMtime: doc.mtime, bom: doc.bom, force });
      doc.mtime = r.mtime;
      doc.saved = state.doc;
      doc.conflict = null;
      doc.dirty = doc.state !== state && (await setup()).isDirty(doc.state.doc, state.doc);
      clearTimeout(this.backupTimers.get(path));
      // Keys typed while the save was in flight still need their backup.
      if (doc.dirty) this.scheduleBackup(doc); else dropBackup(path);
      this.pin(path);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) doc.conflict = e.message.startsWith('Deleted') ? 'deleted' : 'changed';
      else window.alert(t('editor.saveFailed', { error: (e as Error).message }));
    }
    this.emit();
  }

  async saveAll() { for (const d of [...this.docs.values()]) if (d.dirty && !d.conflict) await this.save(d.path); }

  /** Throw away the buffer and show what is on disk. */
  async revert(path: string) {
    const doc = this.docs.get(path);
    if (!doc) return;
    dropBackup(path);
    doc.conflict = null;
    try {
      await this.applyDisk(doc, await api.text(path));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { this.close(path, true); return; }
      doc.error = (e as Error).message;
    }
    this.emit();
  }

  private async applyDisk(doc: Doc, file: TextFile) {
    const cm = await setup();
    if (!doc.state) return;
    doc.saved = cm.textOf(file.content);
    doc.mtime = file.mtime; doc.bom = file.bom;
    doc.eol = file.content.includes('\r\n') ? '\r\n' : '\n';
    doc.readOnly = file.truncated ? 'truncated' : file.lossy ? 'lossy' : null;
    // dirty must be false before the dispatch: its update listener compares against `saved`.
    doc.dirty = false;
    dropBackup(doc.path);
    const spec = { ...cm.diskChange(doc.state.doc, file.content), effects: cm.setReadOnly(!!doc.readOnly).effects };
    if (this.view && this.active === doc.path && this.view.state === doc.state) this.view.dispatch(spec);
    else doc.state = doc.state.update(spec).state;
  }

  async setLanguage(path: string, id: string) {
    const doc = this.docs.get(path);
    if (!doc) return;
    doc.lang = id;
    if (doc.state) {
      const spec = await (await setup()).setLanguage(id);
      if (this.view && this.view.state === doc.state) this.view.dispatch(spec);
      else doc.state = doc.state.update(spec).state;
    }
    this.emit();
  }

  setMdMode(path: string, mode: 'preview' | 'edit') {
    const doc = this.docs.get(path);
    if (doc) { doc.mdMode = mode; this.emit(); }
  }

  /* ── watching the disk ─────────────────────────────────────────── */

  /**
   * One SSE stream: a recursive FSEvents watch on the project plus the folder of any open file
   * outside it. A single connection matters — each open EventSource holds one of the six
   * connections the browser allows per host, and every fetch would queue behind them.
   */
  private syncWatchers() {
    const flat = new Set<string>();
    for (const tab of this.tabs) if (!this.root || !within(tab.path, this.root)) flat.add(dirOf(tab.path));
    const url = this.root || flat.size ? api.fsWatchManyUrl(this.root ? [this.root] : [], [...flat].sort()) : '';
    if (this.watch?.url === url) return;
    this.watch?.es.close();
    this.watch = null;
    if (!url) return;
    const es = new EventSource(url);
    let opened = false;
    // After a reconnect (server restart, sleep) changes in the gap were missed: recheck everything.
    es.addEventListener('open', () => { if (opened) this.fsChanged('*'); opened = true; });
    es.addEventListener('change', (ev) => {
      let change: FsChange = '*';
      try { const v = JSON.parse((ev as MessageEvent).data); if (Array.isArray(v)) change = v; } catch { /* "*" */ }
      this.fsChanged(change);
    });
    this.watch = { url, es };
  }

  private fsChanged(change: FsChange) {
    for (const f of this.fsListeners) f(change);
    const hit = change === '*' ? new Set(this.docs.keys()) : new Set(change.filter((p) => this.docs.has(p)));
    for (const p of hit) void this.checkDisk(this.docs.get(p)!, change === '*');
  }

  private async checkDisk(doc: Doc, unsure: boolean) {
    if (doc.status === 'idle') return;
    if (doc.status === 'loading') { doc.recheck = true; return; }
    if (doc.kind && MEDIA.includes(doc.kind)) {
      try { await api.stat(doc.path); doc.rev++; } catch { this.close(doc.path, true); return; }
      this.emit();
      return;
    }
    if (doc.status !== 'ready' || !doc.state) return;
    try {
      if (unsure && (await api.stat(doc.path)).mtime === doc.mtime) return;
      const file = await api.text(doc.path);
      if (file.mtime === doc.mtime) return; // our own save
      if (!doc.dirty) await this.applyDisk(doc, file);
      else doc.conflict = 'changed';
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) return;
      // Gone from disk: a clean tab just closes; an edited one keeps its text and says so.
      if (!doc.dirty) { this.close(doc.path, true); return; }
      doc.conflict = 'deleted';
    }
    this.emit();
  }
}

export const editor = new EditorStore();
// The 800 ms backup debounce must not cost the last keystrokes on ⌘R, ⌘Q or an update relaunch.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => editor.flushBackups());
  window.addEventListener('beforeunload', () => editor.flushBackups());
}

/** Re-render on any store change. Components read `editor` directly. */
export function useEditor() {
  useSyncExternalStore(editor.subscribe, editor.snapshot);
  return editor;
}
