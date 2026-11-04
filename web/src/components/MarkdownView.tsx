import React, { createContext, useContext, useEffect, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { api } from '../lib/api';
import { t, useLang } from '../lib/i18n';
import { codePathCandidate, resolveLocal } from '../lib/localPath';
import { openLightbox } from './Lightbox';

interface Props {
  text: string;
  /** Directory used to resolve relative image/link paths (the .md file's folder or the session cwd). */
  baseDir?: string | null;
  className?: string;
}

export const markdownSchema = {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, '*': [...(defaultSchema.attributes?.['*'] ?? []), 'align'], img: [...(defaultSchema.attributes?.img ?? []), 'width', 'height'] },
  protocols: { ...defaultSchema.protocols, href: ['http', 'https', 'mailto', 'file'], src: ['http', 'https', 'data'] },
};

function MarkdownImage({ url, label, alt, title }: { url: string; label: string; alt: string; title?: string }) {
  useLang();
  const [loaded, setLoaded] = useState(false);
  // Remote images in agent output may encode conversation data in their URL. Fetch only on click.
  if (/^(https?:)?\/\//i.test(url) && !loaded) return <button className="text-xs underline text-zinc-400" title={url} onClick={() => setLoaded(true)}>{t('preview.loadRemoteImage')}: {alt || label}</button>;
  return <img src={url || undefined} alt={alt} title={title} className="max-w-full rounded-md cursor-zoom-in" onClick={() => openLightbox(url, label)} />;
}



// Existence checks for inline code paths, shared by every message. Kept briefly: agents often mention a
// file just before creating it.
const statCache = new Map<string, { at: number; found: Promise<boolean> }>();
function pathExists(p: string): Promise<boolean> {
  const hit = statCache.get(p);
  if (hit && Date.now() - hit.at < 15000) return hit.found;
  const found = api.stat(p).then(() => true, () => false);
  statCache.set(p, { at: Date.now(), found });
  if (statCache.size > 2000) statCache.delete(statCache.keys().next().value!);
  return found;
}

const InPre = createContext(false);

function CodePath({ text, baseDir, children }: { text: string; baseDir?: string | null; children: React.ReactNode }) {
  const local = resolveLocal(text, baseDir);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    setOk(false);
    if (!local) return;
    let alive = true;
    void pathExists(local).then((v) => { if (alive) setOk(v); });
    return () => { alive = false; };
  }, [local]);
  const open = useContext(LocalLinkContext) ?? openLocalFile;
  if (!local || !ok) return <code>{children}</code>;
  return <code className="cursor-pointer underline decoration-dotted decoration-zinc-500 underline-offset-2 hover:decoration-zinc-200" title={local} onClick={() => open(local)}>{children}</code>;
}

/** Ask the app to show a local file in the Preview tab. */
export function openLocalFile(path: string) {
  window.dispatchEvent(new CustomEvent('vibe:open-file', { detail: { path } }));
}

/** Overrides where local links open (the Preview stacks them as layers instead of replacing itself). */
export const LocalLinkContext = createContext<((path: string) => void) | null>(null);

export function CopyButton({ text, className }: { text: string; className?: string }) {
  useLang();
  const [done, setDone] = useState(false);
  return (
    <button className={`text-[10px] rounded px-1.5 py-0.5 bg-white/10 hover:bg-white/20 text-zinc-300 ${className ?? ''}`}
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }); }}>
      {done ? t('common.copied') : t('common.copy')}
    </button>
  );
}

function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: React.ReactNode } }).props.children);
  return '';
}

export default function MarkdownView({ text, baseDir, className }: Props) {
  return (
    <div className={className}>
      <ReactMarkdown
        // "~" alone is a range in prose (#10~105, 23:59~03:26), not strikethrough; "~~x~~" still is.
        remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSchema], [rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        urlTransform={(url, key) => key === 'src' && /^data:image\/(?:png|jpeg|gif|webp|avif);/i.test(url) || /^file:\/\//i.test(url) ? url : defaultUrlTransform(url)}
        components={{
          pre: ({ children }) => (
            <div className="relative group/code">
              <CopyButton text={textOf(children)} className="absolute top-1.5 right-1.5 opacity-0 group-hover/code:opacity-100" />
              <InPre.Provider value><pre>{children}</pre></InPre.Provider>
            </div>
          ),
          code: function Code({ className, children }) {
            const inPre = useContext(InPre);
            if (inPre) return <code className={className}>{children}</code>;
            const candidate = codePathCandidate(textOf(children));
            return candidate ? <CodePath text={candidate} baseDir={baseDir}>{children}</CodePath> : <code className={className}>{children}</code>;
          },
          img: ({ src, alt, title }) => {
            const local = resolveLocal(String(src ?? ''), baseDir);
            const url = local ? api.rawUrl(local) : String(src ?? '');
            return <MarkdownImage key={url} url={url} label={local ?? alt ?? ''} alt={alt ?? ''} title={title ?? local ?? undefined} />;
          },
          a: function Link({ href, children, title }) {
            const open = useContext(LocalLinkContext) ?? openLocalFile;
            const h = String(href ?? '');
            const local = resolveLocal(h, baseDir);
            if (local) {
              return <a href="#" title={local} onClick={(e) => { e.preventDefault(); open(local); }}>{children}</a>;
            }
            if (h.startsWith('#')) return <a href={h} title={title}>{children}</a>;
            // External: let Electron's window-open handler send it to the default browser.
            return <a href={h} title={title} target="_blank" rel="noreferrer noopener">{children}</a>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
