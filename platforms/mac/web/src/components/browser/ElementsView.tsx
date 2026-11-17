import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../lib/i18n';
import Icon, { type IconName } from '../Icon';
import type { BrowserBridge, BrowserCssDecl, BrowserCssRule, BrowserInspection, BrowserTab } from '../../lib/vibe';

/**
 * Elements pane of the browser window: what ⌥+click picked in the page (INSPECTOR in electron/browserScripts.cts).
 * One scroll with everything about the element, top to bottom in the order one usually asks: what is it and where
 * (header, path, badges), what is inside it (structure), how big (box model), why it looks like this (matched rules
 * in cascade order, overridden ones struck through, var()s resolved, inherited and pseudo-element rules), what it
 * ends up as (computed values grouped, each with the rule it came from), and how to point at it (role, locators).
 * One filter narrows styles and computed values together; rows that name an element outline it in the page.
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

const readClosed = (): string[] => { try { return JSON.parse(localStorage.getItem(LS_CLOSED) || '[]'); } catch { return []; } };
const n2 = (v: number) => (Math.round(v * 100) / 100).toString();

export default function ElementsView({ bridge, tab, inspected, setInspected, toast }: {
  bridge: BrowserBridge; tab: BrowserTab | null; inspected: Inspected | null; setInspected: (v: Inspected | null) => void; toast: (s: string) => void;
}) {
  const [q, setQ] = useState('');
  const [defaults, setDefaults] = useState(false);
  const [closed, setClosed] = useState<string[]>(readClosed);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem(LS_CLOSED, JSON.stringify(closed)); } catch { /* ignore */ } }, [closed]);
  // Never leave an outline behind when the pane goes away.
  useEffect(() => () => bridge.inspectHighlight(null), [bridge]);

  const d = inspected?.data ?? null;
  const otherTab = !!inspected && inspected.tab !== tab?.id;
  const canWalk = !!d && !d.frame && !otherTab;
  const computed = useMemo(() => new Map(d?.computed ?? []), [d]);

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
    if (r && 'data' in r && r.data) { setInspected({ tab: r.tab, data: r.data }); scroller.current?.scrollTo({ top: 0 }); }
    else toast(t('browser.el.gone'));
  };
  const hl = (ref?: string | null) => { if (canWalk) bridge.inspectHighlight(ref ?? null); };
  const copy = (s: string) => { void navigator.clipboard.writeText(s).then(() => toast(t('browser.el.copied'))).catch(() => {}); };
  const toggle = (id: string) => setClosed((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id]);
  const ql = q.trim().toLowerCase();
  const declShown = (x: BrowserCssDecl) => !ql || x.p.toLowerCase().includes(ql) || x.v.toLowerCase().includes(ql);
  // With a filter on, inherited and pseudo-element blocks without a matching rule disappear with their heading.
  const ruleShown = (g: BrowserCssRule) => !ql || g.sel.toLowerCase().includes(ql) || g.decls.some(declShown);

  const display = computed.get('display') ?? '';
  const position = computed.get('position') ?? '';
  const z = computed.get('z-index') ?? 'auto';
  const parentLayout = d.info.parentLayout ?? '';
  const c = d.info.contrast;
  const contrastTone = !c ? '' : c.ratio >= 4.5 || (c.large && c.ratio >= 3) ? 'bg-emerald-400/15 text-emerald-200' : c.ratio >= 3 ? 'bg-amber-400/15 text-amber-200' : 'bg-red-400/15 text-red-200';
  const contrastGrade = !c ? '' : c.ratio >= 7 || (c.large && c.ratio >= 4.5) ? 'AAA' : c.ratio >= 4.5 || (c.large && c.ratio >= 3) ? 'AA' : c.large ? '' : c.ratio >= 3 ? 'AA large' : '';

  return (
    <div className="h-full flex flex-col text-[12px]">
      {/* What and where: tag, size, actions, the path up to <html>, quick facts, one filter for everything below. */}
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
        <div className="flex items-center gap-0.5 overflow-x-auto whitespace-nowrap font-mono text-[11px] pb-0.5" ref={(el) => { if (el) el.scrollLeft = el.scrollWidth; }}>
          {d.path.map((p) => (
            <span key={p.ref} className="flex items-center gap-0.5">
              <button disabled={!canWalk} onClick={() => void go(p.ref)} onMouseEnter={() => hl(p.ref)} onMouseLeave={() => hl(null)}
                className="px-1 rounded text-zinc-400 hover:text-white hover:bg-fill disabled:hover:bg-transparent disabled:hover:text-zinc-400">{p.label}</button>
              <span className="text-zinc-600">›</span>
            </span>
          ))}
          <span className="px-1 rounded bg-fill-3 text-white">{d.label}</span>
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
        {/* What is inside: the opening tag with every attribute, then the children (click to go in). */}
        <Section id="tree" title={t('browser.el.tree')} closed={closed} toggle={toggle}>
          <div className="font-mono text-[11px] leading-[1.55] break-all">
            <span className="text-zinc-500">&lt;</span><span className="text-sky-300">{d.tag}</span>
            {d.attrs.map(([k, v]) => <span key={k}> <span className="text-amber-200">{k}</span>{v !== '' && <><span className="text-zinc-500">=&quot;</span><span className="text-emerald-200">{v}</span><span className="text-zinc-500">&quot;</span></>}</span>)}
            <span className="text-zinc-500">&gt;</span>
            <div className="pl-3 border-l border-white/10 ml-1 my-0.5">
              {d.children.map((k, i) => k.ref ? (
                <button key={k.ref} disabled={!canWalk} onClick={() => void go(k.ref)} onMouseEnter={() => hl(k.ref)} onMouseLeave={() => hl(null)}
                  className={`block w-full text-left px-1 rounded hover:bg-fill disabled:hover:bg-transparent truncate ${k.hidden ? 'opacity-45' : ''}`}>
                  {k.shadow && <span className="text-violet-300 mr-1">#shadow</span>}
                  <span className="text-sky-300">{k.label}</span>
                  {k.kids ? <span className="text-zinc-500"> ({k.kids})</span> : k.text ? <span className="text-zinc-300"> &quot;{k.text}&quot;</span> : null}
                </button>
              ) : <div key={`t${i}`} className="px-1 text-zinc-400 truncate">&quot;{k.text}&quot;</div>)}
              {d.children.length === 0 && !d.text && <div className="px-1 text-zinc-600">—</div>}
            </div>
            <span className="text-zinc-500">&lt;/</span><span className="text-sky-300">{d.tag}</span><span className="text-zinc-500">&gt;</span>
          </div>
          {d.sibling.total > 1 && (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-400">
              <button disabled={!canWalk || !d.sibling.prev} onClick={() => void go(d.sibling.prev)} onMouseEnter={() => hl(d.sibling.prev)} onMouseLeave={() => hl(null)} className="px-2 h-6 rounded-full hover:bg-fill hover:text-white disabled:opacity-30">← {t('browser.el.prev')}</button>
              <span className="flex-1 text-center">{t('browser.el.siblings', { i: d.sibling.index + 1, n: d.sibling.total })}</span>
              <button disabled={!canWalk || !d.sibling.next} onClick={() => void go(d.sibling.next)} onMouseEnter={() => hl(d.sibling.next)} onMouseLeave={() => hl(null)} className="px-2 h-6 rounded-full hover:bg-fill hover:text-white disabled:opacity-30">{t('browser.el.next')} →</button>
            </div>
          )}
        </Section>

        <Section id="box" title={t('browser.el.box')} right={d.box.sizing} closed={closed} toggle={toggle}>
          <BoxModel box={d.box} position={position !== 'static' ? ['top', 'right', 'bottom', 'left'].map((k) => computed.get(k) ?? 'auto') : null} />
        </Section>

        {/* Why it looks like this: rules in cascade order (winner first), then inherited and pseudo-element rules. */}
        <Section id="styles" title={t('browser.el.styles')} closed={closed} toggle={toggle} flush>
          {d.rules.length === 0 && <div className="px-3 py-2 text-zinc-500">{t('browser.el.noRules')}</div>}
          {d.rules.map((g, i) => <RuleCard key={`r${i}`} g={g} shown={declShown} q={ql} />)}
          {d.pseudos.filter((p) => p.groups.some(ruleShown)).map((p) => (
            <div key={p.name}>
              <GroupHead>{p.name}{p.content && p.content !== 'none' && p.content !== 'normal' && <span className="ml-2 text-zinc-400 normal-case">content: {p.content}</span>}</GroupHead>
              {p.groups.map((g, i) => <RuleCard key={i} g={g} shown={declShown} q={ql} />)}
            </div>
          ))}
          {d.inherited.filter((a) => a.groups.some(ruleShown)).map((a) => (
            <div key={a.ref}>
              <GroupHead>
                {t('browser.el.inherited')}{' '}
                <button disabled={!canWalk} onClick={() => void go(a.ref)} onMouseEnter={() => hl(a.ref)} onMouseLeave={() => hl(null)} className="font-mono normal-case text-sky-300 hover:underline disabled:no-underline">{a.label}</button>
              </GroupHead>
              {a.groups.map((g, i) => <RuleCard key={i} g={g} shown={declShown} q={ql} />)}
            </div>
          ))}
          {d.unreadable && <div className="px-3 py-2 text-[11px] text-amber-200/80">{t('browser.el.unreadable', { n: d.unreadable.length, list: d.unreadable.join(', ') })}</div>}
        </Section>

        {/* What it ends up as: grouped computed values with the rule each came from; a filter searches all of them. */}
        <Section id="computed" title={t('browser.el.computed')} closed={closed} toggle={toggle} flush
          right={<button onClick={(e) => { e.stopPropagation(); setDefaults(!defaults); }} className={`h-5 px-2 rounded-full text-[10.5px] normal-case ${defaults ? 'bg-fill-3 text-white' : 'text-zinc-400 hover:bg-fill hover:text-white'}`}>{t('browser.el.showDefaults')}</button>}>
          <Computed d={d} computed={computed} q={ql} defaults={defaults} />
        </Section>

        <Section id="info" title={t('browser.el.info')} closed={closed} toggle={toggle}>
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

function Section({ id, title, right, closed, toggle, children, flush }: { id: string; title: string; right?: React.ReactNode; closed: string[]; toggle: (id: string) => void; children: React.ReactNode; flush?: boolean }) {
  const open = !closed.includes(id);
  return (
    <div className="border-b border-white/10">
      <div role="button" onClick={() => toggle(id)} className="sticky top-0 z-10 h-8 px-3 flex items-center gap-2 cursor-default bg-[#1b1d22]/90 backdrop-blur text-[11px] font-medium text-zinc-300 uppercase tracking-wide select-none">
        <span className={`text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        {title}
        <div className="flex-1" />
        {typeof right === 'string' ? <span className="normal-case font-normal text-zinc-500">{right}</span> : right}
      </div>
      {open && <div className={flush ? 'pb-1' : 'px-3 pb-3 pt-1'}>{children}</div>}
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

function RuleCard({ g, shown, q }: { g: BrowserCssRule; shown: (d: BrowserCssDecl) => boolean; q: string }) {
  const all = !!q && g.sel.toLowerCase().includes(q);
  const decls = all ? g.decls : g.decls.filter(shown);
  if (q && !decls.length) return null;
  return (
    <div className="px-3 py-1.5 border-t border-white/5">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className={`font-mono text-[11px] break-all ${g.inline ? 'text-zinc-300' : 'text-violet-200'}`}>{g.sel}</span>
        <div className="flex-1" />
        {g.src && <span className="shrink-0 max-w-[45%] truncate text-[10.5px] text-zinc-500" title={g.src}>{g.src}</span>}
      </div>
      {(g.at || g.layer || g.state || g.maybe || g.spec) && (
        <div className="flex flex-wrap gap-x-2 text-[10.5px] text-zinc-500">
          {g.at && <span className="text-sky-300/80">{g.at}</span>}
          {g.layer && <span>@layer {g.layer}</span>}
          {g.state && <span className="text-amber-200/80" title={t('browser.el.stateNote')}>{t('browser.el.state')}</span>}
          {g.maybe && <span className="text-amber-200/80">{t('browser.el.maybe')}</span>}
          {g.spec && !g.inline && <span title={t('browser.el.spec')}>({g.spec})</span>}
        </div>
      )}
      <div className="font-mono text-[11px] leading-[1.6] pl-3">
        {decls.map((x, i) => (
          <div key={i} className={x.over ? 'line-through decoration-zinc-500 opacity-45' : ''}>
            <span className="text-sky-200">{x.p}</span><span className="text-zinc-500">: </span>
            <Swatch v={x.v} /><span className="text-zinc-100 break-all">{x.v}</span>{x.imp && <span className="text-red-300"> !important</span>}<span className="text-zinc-500">;</span>
            {x.vars?.map(([k, v]) => <div key={k} className="pl-3 text-[10.5px] text-zinc-500 no-underline">{k} = <Swatch v={v} />{v || '—'}</div>)}
          </div>
        ))}
        {!decls.length && <div className="text-zinc-600">—</div>}
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
