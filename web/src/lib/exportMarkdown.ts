import type { ChatItem } from './chatStore';

/**
 * Turns picked conversation blocks into one Markdown document plus the pictures it refers to.
 * Pure: no DOM, no fetch, so the server-side test can run it. Images are returned as references
 * (absolute path or data: URI) with the relative name the document uses; the caller bundles them.
 */

export interface ExportImage { /** Path inside the bundle, e.g. images/003-shot.png. */ name: string; /** Absolute file path or data: URI. */ src: string }
export interface ExportOptions {
  title: string;
  /** Label for the assistant's blocks ("Claude" / "Codex"). */
  agent: string;
  cwd: string;
  /** ISO date or display string put in the header. */
  date?: string;
  includeThinking?: boolean;
  /** Longest tool output kept verbatim; the rest is cut with a marker. */
  toolOutputMax?: number;
}
export interface ExportResult { markdown: string; images: ExportImage[] }

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif|tiff?|ico)$/i;
const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif' };

/** File-system safe base name for the export (no separators, no control characters). */
export function exportFileName(title: string | null | undefined, fallback = 'session'): string {
  const s = (title ?? '').replace(/[\u0000-\u001f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80).trim();
  return s || fallback;
}

/** A code fence longer than any run of backticks inside, so the content cannot close it early. */
function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text.replace(/\n$/, '')}\n${f}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [+${text.length - max} chars]` : text;
}

function inputSummary(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.description ?? i.url ?? i.prompt ?? '';
  return String(v).split('\n')[0].slice(0, 100);
}

/** Pictures a tool block shows: what it returned, else the image file a Read / ImageView opened. */
function toolImageSources(item: Extract<ChatItem, { kind: 'tool' }>): string[] {
  if (item.images?.length) return item.images;
  if (!item.done || item.isError) return [];
  const i = (item.input ?? {}) as Record<string, unknown>;
  const file = item.name === 'Read' ? i.file_path : item.name === 'ImageView' ? i.path : null;
  return typeof file === 'string' && IMAGE_FILE.test(file) ? [file] : [];
}

class ImageBundle {
  readonly list: ExportImage[] = [];
  private byRef = new Map<string, string>();
  /** Relative name for a source, registering it once; the same source always maps to the same file. */
  add(src: string, hint: string): string {
    const known = this.byRef.get(src);
    if (known) return known;
    const n = String(this.list.length + 1).padStart(3, '0');
    let base: string;
    if (src.startsWith('data:')) {
      const mime = src.slice(5, src.indexOf(';')).toLowerCase();
      base = `${exportFileName(hint, 'image').replace(/\s+/g, '-').toLowerCase()}.${MIME_EXT[mime] ?? 'png'}`;
    } else {
      base = exportFileName(src.split('/').pop() ?? 'image', 'image').replace(/\s+/g, '-');
    }
    const name = `images/${n}-${base}`;
    this.byRef.set(src, name);
    this.list.push({ name, src });
    return name;
  }
}

function escapeAlt(s: string): string { return s.replace(/[\[\]]/g, ' ').trim(); }

export function exportMarkdown(items: ChatItem[], selected: Set<string>, opts: ExportOptions): ExportResult {
  const images = new ImageBundle();
  const childrenOf = new Map<string, ChatItem[]>();
  const top: ChatItem[] = [];
  for (const it of items) {
    const parent = (it.kind === 'assistant' || it.kind === 'tool') ? it.parent : null;
    if (parent) { const l = childrenOf.get(parent) ?? []; l.push(it); childrenOf.set(parent, l); } else top.push(it);
  }
  const outputMax = opts.toolOutputMax ?? 6000;

  const render = (it: ChatItem, depth: number): string | null => {
    switch (it.kind) {
      case 'user': {
        const parts = [`**User**`, it.text.trim()];
        for (const a of it.attachments) {
          if (a.kind === 'image') parts.push(`![${escapeAlt(a.name)}](${images.add(a.path, a.name)})`);
          else parts.push(`📎 \`${a.name}\``);
        }
        return parts.filter(Boolean).join('\n\n');
      }
      case 'assistant': {
        if (it.streaming && !it.text) return null;
        const parts = [depth ? `**${opts.agent}** (subagent)` : `**${opts.agent}**`];
        if (opts.includeThinking && it.thinking.trim()) parts.push(`<details>\n<summary>Thinking</summary>\n\n${it.thinking.trim()}\n\n</details>`);
        if (it.text.trim()) parts.push(it.text.trim());
        return parts.join('\n\n');
      }
      case 'tool': {
        const summary = inputSummary(it.input);
        const head = `🔧 ${it.name}${summary ? ` · ${summary}` : ''}${it.isError ? ' · error' : ''}`;
        const body: string[] = [];
        const input = it.input && typeof it.input === 'object' && Object.keys(it.input as object).length ? JSON.stringify(it.input, null, 2) : '';
        if (input) body.push(`**Input**\n\n${fence(clip(input, outputMax), 'json')}`);
        const srcs = toolImageSources(it);
        const output = srcs.length && it.output ? it.output.split('\n').filter((l) => l.trim() !== '[image]').join('\n').trim() : (it.output ?? '').trim();
        if (output) body.push(`**Output**\n\n${fence(clip(output, outputMax))}`);
        for (const s of srcs) body.push(`![${escapeAlt(s.startsWith('data:') ? it.name : s.split('/').pop() ?? it.name)}](${images.add(s, it.name)})`);
        for (const kid of childrenOf.get(it.id) ?? []) { const r = render(kid, depth + 1); if (r) body.push(r); }
        return `<details>\n<summary>${head.replace(/</g, '&lt;')}</summary>\n\n${body.join('\n\n')}\n\n</details>`;
      }
      case 'approval': return `> Approval · ${it.toolName} · ${it.decision ?? 'pending'}`;
      case 'question': return it.questions.map((q) => `> ❓ ${q.header ? `**${q.header}** ` : ''}${q.question}${q.options.length ? `\n> ${q.options.map((o) => `· ${o.label}`).join(' ')}` : ''}`).join('\n>\n');
      case 'result': return `_${it.ok ? 'Done' : 'Failed'} · ${(it.durationMs / 1000).toFixed(1)}s${it.turnCostUsd ? ` · $${it.turnCostUsd.toFixed(3)}` : ''}${it.ok || !it.text ? '' : ` · ${it.text.trim().split('\n')[0]}`}_`;
      case 'error': return `> ⚠️ ${it.message.trim().replace(/\n/g, '\n> ')}`;
      case 'system': return `_${it.text.trim()}_`;
      case 'changes': return it.files.length ? `**Changed files**\n\n${it.files.map((f) => `- ${f.status} \`${f.path}\`${f.binary ? '' : ` (+${f.additions} −${f.deletions})`}`).join('\n')}` : null;
      case 'verify': {
        const status = it.status === 'passed' ? '✅ passed' : it.status === 'failed' ? `❌ failed${it.exitCode != null ? ` (exit ${it.exitCode})` : ''}` : it.status;
        const out = (it.output ?? '').trim();
        return `**Verify** \`${it.command}\` · ${status}${out ? `\n\n${fence(clip(out, outputMax))}` : ''}`;
      }
    }
  };

  const sections: string[] = [];
  for (const it of top) {
    if (!selected.has(it.id)) continue;
    const r = render(it, 0);
    if (r) sections.push(r);
  }
  const header = `# ${opts.title.trim() || 'Session'}\n\n${[opts.agent, opts.cwd, opts.date].filter(Boolean).join(' · ')}`;
  return { markdown: `${header}\n\n---\n\n${sections.join('\n\n---\n\n')}\n`, images: images.list };
}
