import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../lib/i18n';
import Icon, { type IconName } from '../Icon';
import { BROWSER_CHANNEL, type BrowserChannelMessage } from '../../lib/browserChannel';
import type { BrowserBridge, BrowserCssDecl, BrowserCssEdit, BrowserCssRule, BrowserInspection, BrowserTab, BrowserTreeNode } from '../../lib/vibe';

/**
 * Elements pane of the browser window: what ⌥+click picked in the page (INSPECTOR in electron/browserScripts.cts).
 * One scroll with everything about the element, top to bottom in the order one usually asks: what is it and where
 * (header, path, badges), what is inside it (structure), how big (box model), why it looks like this (matched rules
 * in cascade order, overridden ones struck through, var()s resolved, inherited and pseudo-element rules), what it
 * ends up as (computed values grouped, each with the rule it came from), and how to point at it (role, locators).
 * One filter narrows styles and computed values together; rows that name an element outline it in the page.
 * Styles are live-editable like DevTools (value and name in place, a box to turn a declaration off, new declarations
 * and rules); the edits stay in this page until a reload and are listed so they can be copied or sent to the chat.
 */

export interface Inspected { tab: number; data: BrowserInspection }

const LS_CLOSED = 'vibe.browser.el.closed';
const COLOR_RE = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*(?:\([^()]*\)[^()]*)*\)/i;
/** Computed values that say "nothing set": hidden from the groups unless a rule set them or "defaults" is on. */
const DEFAULTS = new Set(['none', 'normal', 'auto', '0px', '0s', '0', 'static', 'visible', 'rgba(0, 0, 0, 0)', 'transparent', 'start', 'stretch', 'row', 'nowrap', '1', 'baseline', 'all', 'content-box', '0% 0%', 'repeat', 'auto auto', 'clip']);
const FLEX_PROPS = ['flex-direction', 'flex-wrap', 'justify-content', 'justify-items', 'align-items', 'align-content', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows'];
const ITEM_PROPS = ['flex-grow', 'flex-shrink', 'flex-basis', 'align-self', 'justify-self', 'order', 'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end'];
const GROUPS: { id: string; props: string[] }[] = [
  { id: 'layout', props: ['display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear', 'overflow-x', 'overflow-y', 'box-sizing', 'visibility', 'contain', 'isolation'] },
  { id: 'size', props: ['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'aspect-ratio', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'] },
  { id: 'flex', props: [...FLEX_PROPS, ...ITEM_PROPS] },
  { id: 'text', props: ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'color', 'text-align', 'text-transform', 'text-decoration-line', 'text-decoration-color', 'white-space', 'text-overflow', 'word-break', 'overflow-wrap', '-webkit-line-clamp', 'text-shadow'] },
  { id: 'visual', props: ['background-color', 'background-image', 'background-size', 'background-position', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius', 'box-shadow', 'outline-style', 'outline-width', 'outline-color', 'outline-offset'] },
  { id: 'effects', props: ['opacity', 'transform', 'translate', 'scale', 'rotate', 'filter', 'backdrop-filter', '-webkit-backdrop-filter', 'mix-blend-mode', 'clip-path', 'transition-property', 'transition-duration', 'animation-name', 'animation-duration', 'cursor', 'pointer-events', 'user-select'] },
];

const LS_HEIGHTS = 'vibe.browser.el.heights';
const readClosed = (): string[] => { try { return JSON.parse(localStorage.getItem(LS_CLOSED) || '[]'); } catch { return []; } };
const readHeights = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(LS_HEIGHTS) || '{}'); } catch { return {}; } };
const n2 = (v: number) => (Math.round(v * 100) / 100).toString();

export default function ElementsView({ bridge, tab, inspected, setInspected, toast }: {
  bridge: BrowserBridge; tab: BrowserTab | null; inspected: Inspected | null; setInspected: (v: Inspected | null) => void; toast: (s: string) => void;
}) {
  const [q, setQ] = useState('');
  const [defaults, setDefaults] = useState(false);
  const [closed, setClosed] = useState<string[]>(readClosed);
  const [heights, setHeights] = useState<Record<string, number>>(readHeights);
  const [busy, setBusy] = useState(false);
  const [newRule, setNewRule] = useState<string | null>(null);
  const [autoAdd, setAutoAdd] = useState<string | null>(null);
  const [changes, setChanges] = useState<{ url: string; items: Change[] }>({ url: '', items: [] });
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem(LS_CLOSED, JSON.stringify(closed)); } catch { /* ignore */ } }, [closed]);
  useEffect(() => { try { localStorage.setItem(LS_HEIGHTS, JSON.stringify(heights)); } catch { /* ignore */ } }, [heights]);
  // Never leave an outline behind when the pane goes away.
  useEffect(() => () => bridge.inspectHighlight(null), [bridge]);

  const d = inspected?.data ?? null;
  const otherTab = !!inspected && inspected.tab !== tab?.id;
  const canWalk = !!d && !d.frame && !otherTab;
  const computed = useMemo(() => new Map(d?.computed ?? []), [d]);
  // Live edits belong to the page they were made on; another page starts a new list.
  const items = d && changes.url === d.url ? changes.items : [];

  if (!d) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-8">
        <div className="text-[13px] text-zinc-200">{t('browser.el.empty')}</div>
        <div className="text-[11.5px] text-zinc-400 leading-relaxed max-w-xs">{t('browser.el.emptyNote')}</div>
      </div>
    );
  }

  const go = async (ref?: string) => {
    if (!ref || !canWalk || busy) return;
    setBusy(true);
    bridge.inspectHighlight(null);
    const r = await bridge.inspect(ref).catch(() => null);
    setBusy(false);
    if (r && 'data' in r && r.data) setInspected({ tab: r.tab, data: r.data });
    else toast(t('browser.el.gone'));
  };
  const hl = (ref?: string | null) => { if (canWalk) bridge.inspectHighlight(ref ?? null); };
  const copy = (s: string) => { void navigator.clipboard.writeText(s).then(() => toast(t('browser.el.copied'))).catch(() => {}); };
  const toggle = (id: string) => setClosed((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id]);
  const setHeight = (id: string, h: number | null) => setHeights((m) => { const next = { ...m }; if (h === null) delete next[id]; else next[id] = Math.round(h); return next; });
  const ql = q.trim().toLowerCase();
  const declShown = (x: BrowserCssDecl) => !ql || x.p.toLowerCase().includes(ql) || x.v.toLowerCase().includes(ql);
  // With a filter on, inherited and pseudo-element blocks without a matching rule disappear with their heading.
  const ruleShown = (g: BrowserCssRule) => !ql || g.sel.toLowerCase().includes(ql) || g.decls.some(declShown);

  /** Applies one edit in the page, shows the element as it is now and records the change. */
  const edit = async (op: Omit<BrowserCssEdit, 'ref' | 'inspect'> & { owner?: string }, change?: Omit<Change, 'url'>) => {
    if (!canWalk) return false;
    const { owner, ...rest } = op;
    const r = await bridge.cssEdit({ ...rest, ref: owner ?? d.ref, inspect: d.ref }).catch((e: Error) => ({ error: e.message }));
    if (!r || 'error' in r) { toast(t('browser.el.invalid', { msg: (r && 'error' in r ? r.error : '').replace(/^[A-Z_]+: /, '') })); return false; }
    setInspected({ tab: r.tab, data: r.data });
    if (change) setChanges((c) => {
      const list = c.url === r.data.url ? [...c.items] : [];
      const i = list.findIndex((x) => x.sel === change.sel && x.p === change.p && x.src === change.src);
      if (i >= 0) { list[i] = { ...list[i], to: change.to }; if (list[i].from === list[i].to) list.splice(i, 1); } else list.push(change);
      return { url: r.data.url, items: list };
    });
    if (op.action === 'addRule') {
      if (r.rule) setAutoAdd(r.rule);
      if (r.matches === false) toast(t('browser.el.ruleNoMatch'));
    }
    return true;
  };
  const changesText = () => [
    `Style changes tried live on ${d.url} (not in the source yet):`,
    ...items.map((x) => `- \`${x.sel}\`${x.src ? ` (${x.src})` : ''}: ${x.p ? `${x.p}: ${x.from || '(none)'} → ${x.to || '(removed)'}` : 'new rule'}`),
  ].join('\n');
  const sendChanges = () => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(BROWSER_CHANNEL); ch.postMessage({ kind: 'pick', text: changesText() } satisfies BrowserChannelMessage); ch.close();
    toast(t('browser.picked'));
  };
  const ruleCard = (g: BrowserCssRule, key: string, owner?: string, ownerLabel?: string) => (
    <RuleCard key={key} g={g} shown={declShown} q={ql} editable={canWalk && !!g.id} autoAdd={autoAdd === g.id} onAutoAddDone={() => setAutoAdd(null)}
      onEdit={(op, change) => edit({ ...op, rule: g.id, owner }, change && { ...change, sel: g.inline ? `element.style of ${ownerLabel ?? d.label}` : g.sel, src: g.src ?? '' })} />
  );

  const display = computed.get('display') ?? '';
  const position = computed.get('position') ?? '';
  const z = computed.get('z-index') ?? 'auto';
  const parentLayout = d.info.parentLayout ?? '';
  const c = d.info.contrast;
  const contrastTone = !c ? '' : c.ratio >= 4.5 || (c.large && c.ratio >= 3) ? 'bg-emerald-400/15 text-emerald-200' : c.ratio >= 3 ? 'bg-amber-400/15 text-amber-200' : 'bg-red-400/15 text-red-200';
  const contrastGrade = !c ? '' : c.ratio >= 7 || (c.large && c.ratio >= 4.5) ? 'AAA' : c.ratio >= 4.5 || (c.large && c.ratio >= 3) ? 'AA' : c.large ? '' : c.ratio >= 3 ? 'AA large' : '';
  const section = { closed, toggle, heights, setHeight };

  return (
    <div className="h-full flex flex-col text-[12px]">
      {/* What and where: tag, size, actions, quick facts, one filter for everything below. */}
      <div className="shrink-0 px-3 pt-2.5 pb-2 border-b border-white/10 space-y-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[12.5px] text-sky-200 truncate" title={d.label}>{d.label}</span>
          <span className="shrink-0 font-mono text-[11px] text-zinc-400">{n2(d.size.w)} × {n2(d.size.h)}</span>
          <div className="flex-1" />
          <SmallBtn icon="up" title={t('browser.el.parent')} disabled={!canWalk || !d.path.length} onClick={() => void go(d.path[d.path.length - 1]?.ref)} />
          <SmallBtn icon="reload" title={t('browser.el.refresh')} disabled={!canWalk} onClick={() => void go(d.ref)} />
          <SmallBtn icon="file" title={t('browser.el.copySelector')} onClick={() => copy(d.info.selector)} />
          <SmallBtn icon="send" title={t('browser.el.send')} disabled={!canWalk} onClick={() => void bridge.inspectSend(d.ref).then((ok) => { if (!ok) toast(t('browser.el.gone')); })} />
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge>{display}</Badge>
          {position !== 'static' && <Badge>{position}</Badge>}
          {z !== 'auto' && <Badge>z {z}</Badge>}
          {/flex|grid/.test(parentLayout) && <Badge>{t('browser.el.itemOf', { layout: parentLayout.replace('inline-', '') })}</Badge>}
          {d.childCount > 0 && <Badge>{t('browser.el.children', { n: d.childCount })}</Badge>}
          {d.info.hidden && <Badge tone="bg-red-400/15 text-red-200">{t('browser.el.hidden')}</Badge>}
          {d.info.scroll && <Badge>{t('browser.el.scroll')}</Badge>}
          {d.info.focusable && <Badge>{t('browser.el.focusable')}</Badge>}
          {c && <Badge tone={contrastTone} title={t('browser.el.contrastNote', { bg: c.background }) + (c.imaged ? t('browser.el.contrastImage') : '')}>{t('browser.el.contrast', { r: c.ratio })}{contrastGrade && ` ${contrastGrade}`}</Badge>}
          {d.frame && <Badge tone="bg-amber-400/15 text-amber-200">iframe</Badge>}
        </div>
        {(otherTab || d.frame) && <div className="text-[11px] text-amber-200/90">{otherTab ? t('browser.el.stale') : t('browser.el.frameNote')}</div>}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('browser.el.filter')} spellCheck={false}
          className="w-full h-6 rounded-full px-3 text-[11px] bg-black/25 border border-white/10 focus:border-white/30 outline-none" />
      </div>

      <div ref={scroller} className={`flex-1 min-h-0 overflow-auto select-text ${busy ? 'opacity-60' : ''}`}>
        {/* Where it sits: every ancestor from <html> down, each with its children; the element opened with all it holds. */}
        <Section id="tree" title={t('browser.el.tree')} {...section} resizable defaultHeight={300} flush>
          <DomTree d={d} canWalk={canWalk} go={(r) => void go(r)} hl={hl} />
        </Section>

        <Section id="box" title={t('browser.el.box')} right={d.box.sizing} {...section}>
          <BoxModel box={d.box} position={position !== 'static' ? ['top', 'right', 'bottom', 'left'].map((k) => computed.get(k) ?? 'auto') : null} />
        </Section>

        {/* Why it looks like this: rules in cascade order (winner first), then pseudo-element and inherited rules.
            Names and values are editable in place; the box before a declaration turns it off and on. */}
        <Section id="styles" title={t('browser.el.styles')} {...section} resizable defaultHeight={460} flush
          right={canWalk && <button onClick={(e) => { e.stopPropagation(); setNewRule(suggestSelector(d)); }} title={t('browser.el.addRuleTitle')}
            className="h-5 px-2 rounded-full text-[10.5px] normal-case text-zinc-300 hover:bg-fill hover:text-white">{t('browser.el.addRule')}</button>}>
          {items.length > 0 && (
            <div className="mx-3 mt-2 mb-1 rounded-lg bg-amber-400/10 border border-amber-300/20 px-2.5 py-1.5 text-[11px] text-amber-100">
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{t('browser.el.changes', { n: items.length })}</span>
                <div className="flex-1" />
                <button onClick={() => copy(changesText())} className="h-5 px-2 rounded-full hover:bg-white/10">{t('browser.el.copy')}</button>
                <button onClick={sendChanges} className="h-5 px-2 rounded-full hover:bg-white/10">{t('browser.el.sendChanges')}</button>
                <button onClick={() => setChanges({ url: '', items: [] })} className="h-5 px-2 rounded-full hover:bg-white/10">{t('browser.el.clearChanges')}</button>
              </div>
              <div className="text-amber-200/70">{t('browser.el.changesNote')}</div>
            </div>
          )}
          {newRule !== null && (
            <div className="px-3 py-1.5 border-t border-white/5 font-mono text-[11px] flex items-center gap-1">
              <EditText initial={newRule} placeholder={t('browser.el.selectorPh')} className="text-violet-200"
                onDone={(v) => { setNewRule(null); if (v?.trim()) void edit({ action: 'addRule', sel: v.trim() }, { sel: v.trim(), src: 'vibrato', p: '', from: '', to: 'new rule' }); }} />
              <span className="text-zinc-500">{'{ }'}</span>
            </div>
          )}
          {d.rules.map((g, i) => ruleCard(g, `r${g.id ?? i}`))}
          {d.pseudos.filter((p) => p.groups.some(ruleShown)).map((p) => (
            <div key={p.name}>
              <GroupHead>{p.name}{p.content && p.content !== 'none' && p.content !== 'normal' && <span className="ml-2 text-zinc-400 normal-case">content: {p.content}</span>}</GroupHead>
              {p.groups.map((g, i) => ruleCard(g, `p${g.id ?? i}`))}
            </div>
          ))}
          {d.inherited.filter((a) => a.groups.some(ruleShown)).map((a) => (
            <div key={a.ref}>
              <GroupHead>
                {t('browser.el.inherited')}{' '}
                <button disabled={!canWalk} onClick={() => void go(a.ref)} onMouseEnter={() => hl(a.ref)} onMouseLeave={() => hl(null)} className="font-mono normal-case text-sky-300 hover:underline disabled:no-underline">{a.label}</button>
              </GroupHead>
              {a.groups.map((g, i) => ruleCard(g, `i${a.ref}${g.id ?? i}`, g.inline ? a.ref : undefined, a.label))}
            </div>
          ))}
          {d.unreadable && <div className="px-3 py-2 text-[11px] text-amber-200/80">{t('browser.el.unreadable', { n: d.unreadable.length, list: d.unreadable.join(', ') })}</div>}
        </Section>

        {/* What it ends up as: grouped computed values with the rule each came from; a filter searches all of them. */}
        <Section id="computed" title={t('browser.el.computed')} {...section} resizable defaultHeight={360} flush
          right={<button onClick={(e) => { e.stopPropagation(); setDefaults(!defaults); }} className={`h-5 px-2 rounded-full text-[10.5px] normal-case ${defaults ? 'bg-fill-3 text-white' : 'text-zinc-400 hover:bg-fill hover:text-white'}`}>{t('browser.el.showDefaults')}</button>}>
          <Computed d={d} computed={computed} q={ql} defaults={defaults} />
        </Section>

        <Section id="info" title={t('browser.el.info')} {...section}>
          <div className="grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1.5 items-baseline text-[11.5px]">
            <InfoRow k={t('browser.el.role')} v={d.info.role || '—'} />
            <InfoRow k={t('browser.el.name')} v={d.info.name || '—'} />
            <InfoRow k={t('browser.el.locator')} v={d.info.locator} mono onCopy={() => copy(d.info.locator)} />
            <InfoRow k={t('browser.el.selector')} v={d.info.selector} mono onCopy={() => copy(d.info.selector)} />
            {d.text && <InfoRow k={t('browser.el.text')} v={d.text} />}
            {c && <InfoRow k={t('browser.el.contrastLabel')} v={`${c.ratio}:1 — ${computed.get('color') ?? ''} / ${c.background}${c.imaged ? t('browser.el.contrastImage') : ''}`} />}
          </div>
        </Section>
      </div>
    </div>
  );
}

/** A selector for a new rule: the id, else the tag with its classes, else the element's CSS path. */
function suggestSelector(d: BrowserInspection): string {
  const attr = (k: string) => d.attrs.find(([n]) => n === k)?.[1] ?? '';
  const id = attr('id');
  if (id && /^[A-Za-z_][\w-]*$/.test(id)) return `#${id}`;
  const cls = attr('class').split(/\s+/).filter(Boolean).slice(0, 3).map((c) => `.${CSS.escape(c)}`).join('');
  return cls ? `${d.tag}${cls}` : d.info.selector;
}

function SmallBtn({ icon, title, onClick, disabled }: { icon: IconName; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button title={title} aria-label={title} onClick={onClick} disabled={disabled}
      className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-zinc-400 hover:text-white hover:bg-fill disabled:opacity-30 disabled:hover:bg-transparent">
      <Icon name={icon} size={13} />
    </button>
  );
}

function Badge({ children, tone, title }: { children: React.ReactNode; tone?: string; title?: string }) {
  return <span title={title} className={`h-5 px-2 rounded-full text-[10.5px] leading-5 ${tone ?? 'bg-white/[.07] text-zinc-300'}`}>{children}</span>;
}

/**
 * A collapsible block. Resizable ones cap their body at a height the user drags with the bar under it
 * (double-click resets); a body shorter than that keeps its own height.
 */
function Section({ id, title, right, closed, toggle, heights, setHeight, resizable, defaultHeight = 300, children, flush }: {
  id: string; title: string; right?: React.ReactNode; closed: string[]; toggle: (id: string) => void; heights: Record<string, number>;
  setHeight: (id: string, h: number | null) => void; resizable?: boolean; defaultHeight?: number; children: React.ReactNode; flush?: boolean;
}) {
  const open = !closed.includes(id);
  const body = useRef<HTMLDivElement>(null);
  const max = heights[id] ?? defaultHeight;
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = e.clientY, from = body.current?.getBoundingClientRect().height ?? max;
    const move = (ev: PointerEvent) => setHeight(id, Math.max(60, Math.min(2000, from + ev.clientY - start)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    document.body.style.cursor = 'row-resize';
  };
  return (
    <div className="border-b border-white/10">
      <div role="button" onClick={() => toggle(id)} className="sticky top-0 z-10 h-8 px-3 flex items-center gap-2 cursor-default bg-[#1b1d22]/90 backdrop-blur text-[11px] font-medium text-zinc-300 uppercase tracking-wide select-none">
        <span className={`text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        {title}
        <div className="flex-1" />
        {typeof right === 'string' ? <span className="normal-case font-normal text-zinc-500">{right}</span> : right}
      </div>
      {open && (
        <div ref={body} className={`${resizable ? 'overflow-auto' : ''} ${flush ? 'pb-1' : 'px-3 pb-3 pt-1'}`} style={resizable ? { maxHeight: max } : undefined}>{children}</div>
      )}
      {open && resizable && (
        <div onPointerDown={drag} onDoubleClick={() => setHeight(id, null)} role="separator" title={t('browser.el.resize')}
          className="group h-2 -mt-1 relative cursor-row-resize">
          <div className="absolute inset-x-[42%] top-1/2 h-[3px] -mt-[1.5px] rounded-full bg-white/10 group-hover:bg-white/30 transition-colors" />
        </div>
      )}
    </div>
  );
}

function GroupHead({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pt-2.5 pb-1 text-[10.5px] uppercase tracking-wide text-zinc-500">{children}</div>;
}

function Swatch({ v }: { v: string }) {
  const m = COLOR_RE.exec(v);
  if (!m) return null;
  return <span className="inline-block w-2.5 h-2.5 rounded-sm mr-1 align-[-1px] border border-white/25" style={{ background: m[0] }} />;
}

// ---------- DOM tree ----------

const INDENT = 12;

function OpenTag({ tag, attrs, full }: { tag: string; attrs: [string, string][]; full?: boolean }) {
  return (
    <>
      <span className="text-zinc-500">&lt;</span><span className="text-sky-300">{tag}</span>
      {attrs.map(([k, v]) => k === '…'
        ? <span key={k} className="text-zinc-500"> …{v}</span>
        : <span key={k}> <span className="text-amber-200">{k}</span>{v !== '' && <><span className="text-zinc-500">=&quot;</span><span className={`text-emerald-200 ${full ? 'break-all' : ''}`}>{v}</span><span className="text-zinc-500">&quot;</span></>}</span>)}
      <span className="text-zinc-500">&gt;</span>
    </>
  );
}

/**
 * The element in its tree: each ancestor from <html> with the children around the path (fold with the arrow),
 * the element itself highlighted with every attribute and what it holds. Clicking a line selects it.
 */
function DomTree({ d, canWalk, go, hl }: { d: BrowserInspection; canWalk: boolean; go: (ref: string) => void; hl: (ref?: string | null) => void }) {
  const [folded, setFolded] = useState<string[]>([]);
  const sel = useRef<HTMLDivElement>(null);
  useEffect(() => { sel.current?.scrollIntoView({ block: 'nearest' }); }, [d.ref]);
  const row = (depth: number) => ({ paddingLeft: 8 + depth * INDENT });
  const line = (n: BrowserTreeNode, depth: number) => (
    <div key={n.ref} role="button" style={row(depth)} title={canWalk ? t('browser.el.select') : undefined}
      onClick={() => canWalk && go(n.ref)} onMouseEnter={() => hl(n.ref)} onMouseLeave={() => hl(null)}
      className={`pr-2 whitespace-nowrap rounded-sm ${canWalk ? 'hover:bg-fill cursor-default' : ''} ${n.hidden ? 'opacity-45' : ''}`}>
      <span className="inline-block w-3 text-zinc-600">{n.kids ? '▸' : ''}</span>
      {n.shadow && <span className="text-violet-300 mr-1">#shadow</span>}
      <OpenTag tag={n.tag ?? ''} attrs={n.attrs ?? []} />
      {n.kids ? <span className="text-zinc-500">…{n.kids}</span> : n.text ? <span className="text-zinc-300">{n.text}</span> : null}
    </div>
  );
  const more = (n: number | undefined, depth: number, k: string) => n ? <div key={k} style={row(depth)} className="text-zinc-600 pl-3">{t('browser.el.more', { n })}</div> : null;
  const selected = (depth: number) => (
    <div key="sel">
      <div ref={sel} style={row(depth)} className="pr-2 bg-sky-400/15 border-l-2 border-sky-300 rounded-sm whitespace-normal break-words">
        <span className="inline-block w-3 text-zinc-400">{d.children.length ? '▾' : ''}</span>
        <OpenTag tag={d.tag} attrs={d.attrs} full />
      </div>
      {d.children.map((k, i) => k.ref
        ? line({ ...k, ref: k.ref }, depth + 1)
        : <div key={`t${i}`} style={row(depth + 1)} className="pl-3 text-zinc-400 whitespace-nowrap">&quot;{k.text}&quot;</div>)}
      {d.children.length > 0 && <div style={row(depth)} className="pl-3 text-zinc-500">&lt;/<span className="text-sky-300">{d.tag}</span>&gt;</div>}
    </div>
  );
  const level = (i: number): React.ReactNode => {
    if (i >= d.tree.length) return selected(i);
    const L = d.tree[i];
    const isFolded = folded.includes(L.ref);
    return (
      <div key={L.ref}>
        <div role="button" style={row(i)} onClick={() => canWalk && go(L.ref)} onMouseEnter={() => hl(L.ref)} onMouseLeave={() => hl(null)}
          className={`pr-2 whitespace-nowrap rounded-sm ${canWalk ? 'hover:bg-fill cursor-default' : ''}`}>
          <span role="button" onClick={(e) => { e.stopPropagation(); setFolded((f) => isFolded ? f.filter((x) => x !== L.ref) : [...f, L.ref]); }}
            className="inline-block w-3 text-zinc-400 hover:text-white">{isFolded ? '▸' : '▾'}</span>
          <OpenTag tag={L.tag ?? ''} attrs={L.attrs ?? []} />
          {isFolded && <span className="text-zinc-500">…</span>}
        </div>
        {!isFolded && (
          <>
            {more(L.before, i + 1, 'b')}
            {L.kidsList.map((k) => k.chain ? <div key={k.ref}>{level(i + 1)}</div> : line(k, i + 1))}
            {more(L.after, i + 1, 'a')}
          </>
        )}
      </div>
    );
  };
  return <div className="font-mono text-[11px] leading-[1.6] py-1 min-w-max">{level(0)}</div>;
}

// ---------- editable rules ----------

export interface Change { sel: string; src: string; p: string; from: string; to: string }
type RuleEdit = Omit<BrowserCssEdit, 'ref' | 'inspect' | 'rule'>;

/** Text that turns into an input on click; Enter or leaving commits, Escape cancels (onDone(null)). Tab commits too. */
function EditText({ initial, placeholder, className, onDone, autoFocus = true }: { initial: string; placeholder?: string; className?: string; onDone: (v: string | null, tab?: boolean) => void; autoFocus?: boolean }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (val: string | null, tab?: boolean) => { if (done.current) return; done.current = true; onDone(val, tab); };
  return (
    <input value={v} autoFocus={autoFocus} placeholder={placeholder} spellCheck={false} onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(v); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        else if (e.key === 'Tab') { e.preventDefault(); finish(v, true); }
      }}
      onBlur={() => finish(v)} onClick={(e) => e.stopPropagation()}
      style={{ fieldSizing: 'content', minWidth: '3ch' } as React.CSSProperties}
      className={`max-w-full bg-black/40 border border-sky-300/40 rounded px-1 -mx-1 outline-none font-mono text-[11px] ${className ?? ''}`} />
  );
}

function RuleCard({ g, shown, q, editable, onEdit, autoAdd, onAutoAddDone }: {
  g: BrowserCssRule; shown: (d: BrowserCssDecl) => boolean; q: string; editable: boolean;
  onEdit: (op: RuleEdit, change?: Omit<Change, 'sel' | 'src'>) => Promise<boolean>; autoAdd: boolean; onAutoAddDone: () => void;
}) {
  // Which field is open: an existing declaration's name or value, or the new-declaration row.
  const [open, setOpen] = useState<{ i: number; field: 'p' | 'v'; p?: string } | null>(null);
  useEffect(() => { if (autoAdd) { setOpen({ i: -1, field: 'p' }); onAutoAddDone(); } }, [autoAdd, onAutoAddDone]);
  const all = !!q && g.sel.toLowerCase().includes(q);
  const decls = all || !q ? g.decls : g.decls.filter(shown);
  if (q && !decls.length && !all) return null;

  const commit = async (x: BrowserCssDecl | null, p: string, v: string) => {
    p = p.trim(); v = v.trim();
    if (!p) return;
    const from = x ? `${x.v}${x.imp ? ' !important' : ''}` : '';
    if (x && p === x.p && v === from) return;
    // A rename is recorded as the new property (the old one shows as removed only if it was changed before).
    await onEdit({ action: 'set', p, v, old: x && x.p !== p ? x.p : undefined }, { p, from: x && x.p === p ? from : '', to: v });
  };
  const toggleDecl = (x: BrowserCssDecl) => onEdit({ action: 'toggle', p: x.p, on: !!x.off }, { p: x.p, from: x.off ? '(off)' : x.v, to: x.off ? x.v : '(off)' });

  return (
    <div className="px-3 py-1.5 border-t border-white/5 group/rule">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className={`font-mono text-[11px] break-all ${g.inline ? 'text-zinc-300' : 'text-violet-200'}`}>{g.sel}</span>
        <div className="flex-1" />
        {g.src && <span className="shrink-0 max-w-[45%] truncate text-[10.5px] text-zinc-500" title={g.src}>{g.src}</span>}
        {editable && <button onClick={() => setOpen({ i: -1, field: 'p' })} title={t('browser.el.addDecl')}
          className="shrink-0 w-5 h-5 -my-1 rounded-full text-zinc-500 hover:text-white hover:bg-fill opacity-0 group-hover/rule:opacity-100 focus:opacity-100">+</button>}
      </div>
      {(g.at || g.layer || g.state || g.maybe || (g.spec && !g.inline)) && (
        <div className="flex flex-wrap gap-x-2 text-[10.5px] text-zinc-500">
          {g.at && <span className="text-sky-300/80">{g.at}</span>}
          {g.layer && <span>@layer {g.layer}</span>}
          {g.state && <span className="text-amber-200/80" title={t('browser.el.stateNote')}>{t('browser.el.state')}</span>}
          {g.maybe && <span className="text-amber-200/80">{t('browser.el.maybe')}</span>}
          {g.spec && !g.inline && <span title={t('browser.el.spec')}>({g.spec})</span>}
        </div>
      )}
      <div className="font-mono text-[11px] leading-[1.7]">
        {decls.map((x, i) => {
          const idx = g.decls.indexOf(x);
          const editingP = open?.i === idx && open.field === 'p';
          const editingV = open?.i === idx && open.field === 'v';
          return (
            <div key={`${x.p}${i}`} className="flex items-start gap-1 group/decl">
              {editable
                ? <button onClick={() => void toggleDecl(x)} title={t('browser.el.toggleDecl')}
                    className={`mt-[3px] shrink-0 w-3 h-3 rounded-[3px] border flex items-center justify-center ${x.off ? 'border-zinc-500 opacity-100' : 'border-sky-300/70 bg-sky-400/30 opacity-0 group-hover/decl:opacity-100'}`}>
                    {!x.off && <Icon name="check" size={8} />}
                  </button>
                : <span className="w-3 shrink-0" />}
              <div className={`min-w-0 ${x.off ? 'opacity-40' : x.over ? 'line-through decoration-zinc-500 opacity-45' : ''}`}>
                {editingP
                  ? <EditText initial={x.p} className="text-sky-200" onDone={(v, tab) => { if (v === null) { setOpen(null); return; } if (tab) { setOpen({ i: idx, field: 'v', p: v }); return; } setOpen(null); void commit(x, v, `${x.v}${x.imp ? ' !important' : ''}`); }} />
                  : <span role={editable ? 'button' : undefined} onClick={() => editable && setOpen({ i: idx, field: 'p' })} className={`text-sky-200 ${editable ? 'hover:underline decoration-dotted' : ''}`}>{x.p}</span>}
                <span className="text-zinc-500">: </span>
                {editingV
                  ? <EditText initial={`${x.v}${x.imp ? ' !important' : ''}`} className="text-zinc-100" onDone={(v) => { const p = open?.p ?? x.p; setOpen(null); if (v !== null) void commit(x, p, v); }} />
                  : <span role={editable ? 'button' : undefined} onClick={() => editable && setOpen({ i: idx, field: 'v' })} className={editable ? 'hover:underline decoration-dotted' : ''}>
                      <Swatch v={x.v} /><span className="text-zinc-100 break-all">{x.v}</span>{x.imp && <span className="text-red-300"> !important</span>}
                    </span>}
                <span className="text-zinc-500">;</span>
                {x.vars?.map(([k, v]) => <div key={k} className="pl-3 text-[10.5px] text-zinc-500 no-underline">{k} = <Swatch v={v} />{v || '—'}</div>)}
              </div>
            </div>
          );
        })}
        {open?.i === -1 && (
          <div className="flex items-start gap-1">
            <span className="w-3 shrink-0" />
            {open.field === 'p'
              ? <EditText initial="" placeholder={t('browser.el.propPh')} className="text-sky-200" onDone={(v) => { if (!v?.trim()) { setOpen(null); return; } setOpen({ i: -1, field: 'v', p: v.trim() }); }} />
              : <span className="text-sky-200">{open.p}</span>}
            <span className="text-zinc-500">: </span>
            {open.field === 'v' && <EditText initial="" placeholder={t('browser.el.valuePh')} className="text-zinc-100" onDone={(v) => { const p = open.p ?? ''; setOpen(null); if (v?.trim()) void commit(null, p, v); }} />}
          </div>
        )}
        {!decls.length && open?.i !== -1 && (
          editable
            ? <button onClick={() => setOpen({ i: -1, field: 'p' })} className="pl-4 text-zinc-600 hover:text-zinc-300">{t('browser.el.addDecl')}</button>
            : <div className="pl-4 text-zinc-600">—</div>
        )}
      </div>
    </div>
  );
}

function BoxModel({ box, position }: { box: BrowserInspection['box']; position: string[] | null }) {
  const v = (x: number | string) => typeof x === 'number' ? (x ? n2(x) : <span className="text-zinc-600">–</span>) : x === 'auto' ? <span className="text-zinc-600">auto</span> : x;
  const layer = (name: string, s: (number | string)[], tone: string, inner: React.ReactNode) => (
    <div className={`relative rounded-md border border-dashed px-1 py-0.5 ${tone}`}>
      <div className="absolute left-1.5 top-0.5 text-[9.5px] text-zinc-400">{name}</div>
      <div className="text-center leading-4">{v(s[0])}</div>
      <div className="flex items-center"><span className="w-10 text-center shrink-0">{v(s[3])}</span><div className="flex-1 min-w-0">{inner}</div><span className="w-10 text-center shrink-0">{v(s[1])}</span></div>
      <div className="text-center leading-4">{v(s[2])}</div>
    </div>
  );
  const content = <div className="rounded border border-sky-300/40 bg-sky-400/15 py-1.5 text-center text-sky-100">{n2(box.content.w)} × {n2(box.content.h)}</div>;
  const core = layer('margin', box.margin, 'border-orange-300/40 bg-orange-400/[.08]',
    layer('border', box.border, 'border-yellow-200/40 bg-yellow-300/[.08]',
      layer('padding', box.padding, 'border-emerald-300/40 bg-emerald-400/[.08]', content)));
  return <div className="font-mono text-[10.5px] text-zinc-200 select-none">{position ? layer('position', position, 'border-white/20', core) : core}</div>;
}

function Computed({ d, computed, q, defaults }: { d: BrowserInspection; computed: Map<string, string>; q: string; defaults: boolean }) {
  const display = computed.get('display') ?? '';
  const isBox = /flex|grid/.test(display);
  const isItem = /flex|grid/.test(d.info.parentLayout ?? '');
  const zero = (p: string) => computed.get(p) === '0px';
  const hide = (p: string, v: string) => {
    if (defaults || d.sources[p]) return false;
    if (DEFAULTS.has(v.toLowerCase())) return true;
    // Colours and styles of borders and outlines that are not drawn.
    const side = /^border-(top|right|bottom|left)-(color|style)$/.exec(p);
    if (side) return zero(`border-${side[1]}-width`);
    if (p === 'outline-color' || p === 'outline-offset') return computed.get('outline-style') === 'none';
    if (p === 'text-decoration-color') return computed.get('text-decoration-line') === 'none';
    if (p === 'animation-duration') return computed.get('animation-name') === 'none';
    return false;
  };
  if (q) {
    const rows = d.computed.filter(([p, v]) => p.includes(q) || v.toLowerCase().includes(q));
    return <div className="px-3">{rows.length ? rows.map(([p, v]) => <PropRow key={p} p={p} v={v} src={d.sources[p]} />) : <div className="py-2 text-zinc-500">—</div>}</div>;
  }
  return (
    <div className="px-3">
      {GROUPS.map((g) => {
        let props = g.props;
        if (g.id === 'flex') props = [...(isBox ? FLEX_PROPS : []), ...(isItem ? ITEM_PROPS : [])];
        const rows = props.map((p) => [p, computed.get(p)] as const).filter((r): r is readonly [string, string] => r[1] !== undefined && !hide(r[0], r[1]));
        if (!rows.length) return null;
        return (
          <div key={g.id} className="pt-1.5">
            <div className="text-[10.5px] uppercase tracking-wide text-zinc-500 pb-0.5">{t(`browser.el.group.${g.id}`)}</div>
            {rows.map(([p, v]) => <PropRow key={p} p={p} v={v} src={d.sources[p]} />)}
          </div>
        );
      })}
    </div>
  );
}

function PropRow({ p, v, src }: { p: string; v: string; src?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,40%)_1fr] gap-2 py-[3px] border-b border-white/[.04] font-mono text-[11px]">
      <span className="text-sky-200 truncate" title={p}>{p}</span>
      <span className="min-w-0">
        <span className="text-zinc-100 break-all"><Swatch v={v} />{v}</span>
        {src && <span className="block text-[10px] text-zinc-500 truncate font-sans" title={src}>{src}</span>}
      </span>
    </div>
  );
}

function InfoRow({ k, v, mono, onCopy }: { k: string; v: string; mono?: boolean; onCopy?: () => void }) {
  return (
    <>
      <span className="text-zinc-500 whitespace-nowrap">{k}</span>
      <span className={`min-w-0 break-all text-zinc-100 ${mono ? 'font-mono text-[11px]' : ''}`}>{v}</span>
      {onCopy ? <button onClick={onCopy} title={t('browser.el.copy')} className="w-6 h-6 rounded-full flex items-center justify-center text-zinc-400 hover:text-white hover:bg-fill"><Icon name="file" size={12} /></button> : <span />}
    </>
  );
}
