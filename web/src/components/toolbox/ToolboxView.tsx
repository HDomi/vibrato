import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { t, useLang } from '../../lib/i18n';
import { usePersisted } from './ui';

type Group = 'data' | 'web' | 'security' | 'time' | 'image' | 'system';
const GROUPS: Group[] = ['data', 'web', 'security', 'time', 'image', 'system'];

/** Each tool is its own chunk, so opening the tab loads only the one on screen. */
const TOOLS: { id: string; group: Group; badge: string; Comp: ComponentType }[] = [
  { id: 'json', group: 'data', badge: '{ }', Comp: lazy(() => import('./JsonTool')) },
  { id: 'formats', group: 'data', badge: 'YML', Comp: lazy(() => import('./FormatsTool')) },
  { id: 'sql', group: 'data', badge: 'SQL', Comp: lazy(() => import('./SqlTool')) },
  { id: 'regex', group: 'data', badge: '.*', Comp: lazy(() => import('./RegexTool')) },
  { id: 'diff', group: 'data', badge: '±', Comp: lazy(() => import('./DiffTool')) },
  { id: 'text', group: 'data', badge: 'Aa', Comp: lazy(() => import('./TextTool')) },
  { id: 'http', group: 'web', badge: 'HTTP', Comp: lazy(() => import('./HttpTool')) },
  { id: 'curl', group: 'web', badge: 'cURL', Comp: lazy(() => import('./CurlTool')) },
  { id: 'jwt', group: 'web', badge: 'JWT', Comp: lazy(() => import('./JwtTool')) },
  { id: 'encode', group: 'web', badge: 'b64', Comp: lazy(() => import('./EncodeTool')) },
  { id: 'escape', group: 'web', badge: '\\n', Comp: lazy(() => import('./EscapeTool')) },
  { id: 'crypto', group: 'security', badge: 'AES', Comp: lazy(() => import('./CryptoTool')) },
  { id: 'random', group: 'security', badge: '#', Comp: lazy(() => import('./RandomTool')) },
  { id: 'time', group: 'time', badge: 'UTC', Comp: lazy(() => import('./TimeTool')) },
  { id: 'cron', group: 'time', badge: '* * *', Comp: lazy(() => import('./CronTool')) },
  { id: 'color', group: 'image', badge: 'RGB', Comp: lazy(() => import('./ColorTool')) },
  { id: 'svg', group: 'image', badge: 'SVG', Comp: lazy(() => import('./SvgTool')) },
  { id: 'qr', group: 'image', badge: 'QR', Comp: lazy(() => import('./QrTool')) },
  { id: 'datauri', group: 'image', badge: 'URI', Comp: lazy(() => import('./DataUriTool')) },
  { id: 'favicon', group: 'image', badge: 'ICO', Comp: lazy(() => import('./FaviconTool')) },
  { id: 'net', group: 'system', badge: 'IP', Comp: lazy(() => import('./NetTool')) },
  { id: 'env', group: 'system', badge: '.env', Comp: lazy(() => import('./EnvTool')) },
  { id: 'chmod', group: 'system', badge: '755', Comp: lazy(() => import('./ChmodTool')) },
  { id: 'calc', group: 'system', badge: '=', Comp: lazy(() => import('./CalcTool')) },
];

/** Tools mode: local utilities grouped by kind, with a filter box. */
export default function ToolboxView() {
  useLang();
  const [active, setActive] = usePersisted<string>('tool', 'json');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const tool = TOOLS.find((x) => x.id === active) ?? TOOLS[0];
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => (q ? TOOLS.filter((x) => `${x.id} ${x.badge} ${t(`tb.${x.id}.name`)} ${t(`tb.${x.id}.desc`)}`.toLowerCase().includes(q)) : TOOLS), [q]);
  // Shortcuts number the tools in list order (unfiltered): ⌘1-9, ⌘0 for the tenth.
  const order = useMemo(() => GROUPS.flatMap((g) => TOOLS.filter((x) => x.group === g)), []);
  useEffect(() => { setCursor(0); }, [q]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === 'k') { e.preventDefault(); search.current?.focus(); search.current?.select(); return; }
      const i = e.key === '0' ? 9 : Number(e.key) - 1;
      if (!/^[0-9]$/.test(e.key) || !order[i]) return;
      e.preventDefault(); setActive(order[i].id);
    };
    const open = (e: Event) => { const id = (e as CustomEvent<{ id: string }>).detail?.id; if (TOOLS.some((x) => x.id === id)) setActive(id); };
    window.addEventListener('keydown', h);
    window.addEventListener('vibe:toolbox-open', open);
    return () => { window.removeEventListener('keydown', h); window.removeEventListener('vibe:toolbox-open', open); };
  }, [setActive, order]);

  const pick = (id: string) => { setActive(id); setQuery(''); };
  return (
    <div className="flex-1 flex min-h-0">
      <aside className="w-56 shrink-0 h-full flex flex-col border-r border-white/10 bg-[#0e1117]">
        <div className="h-10 shrink-0 flex items-center gap-2 px-3">
          <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('tb.search')} spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(visible.length - 1, c + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
              else if (e.key === 'Enter' && visible[cursor]) { pick(visible[cursor].id); (e.target as HTMLInputElement).blur(); }
              else if (e.key === 'Escape') { setQuery(''); (e.target as HTMLInputElement).blur(); }
            }}
            className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-md px-2 py-1 text-[12px] text-zinc-200 outline-none focus:border-blue-400/50 placeholder:text-zinc-600" />
          <span className="text-[10px] text-zinc-600 shrink-0">⌘K</span>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {q ? visible.map((x, i) => <Item key={x.id} x={x} active={active === x.id} hot={i === cursor} n={order.indexOf(x)} onClick={() => pick(x.id)} />)
            : GROUPS.map((g) => {
              const items = TOOLS.filter((x) => x.group === g);
              if (!items.length) return null;
              return (
                <div key={g} className="mb-1">
                  <div className="px-2 pt-2.5 pb-1 text-[10.5px] uppercase tracking-wider text-zinc-600">{t(`tb.group.${g}`)}</div>
                  {items.map((x) => <Item key={x.id} x={x} active={active === x.id} n={order.indexOf(x)} onClick={() => pick(x.id)} />)}
                </div>
              );
            })}
          {q && !visible.length && <div className="px-2 py-2 text-[12px] text-zinc-600">{t('tb.noMatch')}</div>}
        </div>
        <div className="h-px shrink-0 bg-white/10 mb-4" />
      </aside>
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="h-10 shrink-0 flex items-center gap-3 px-4 border-b border-white/10 text-xs">
          <span className="font-medium text-zinc-200">{t(`tb.${tool.id}.name`)}</span>
          <span className="text-zinc-500 truncate">{t(`tb.${tool.id}.desc`)}</span>
          <div className="flex-1" />
          <span className="text-[10.5px] text-zinc-600">{t(tool.id === 'http' || tool.id === 'net' ? 'tb.viaServer' : 'tb.offline')}</span>
        </div>
        <div className="flex-1 min-h-0 p-4">
          <Suspense fallback={<div className="text-sm text-zinc-500">{t('common.loading')}</div>}>
            <tool.Comp key={tool.id} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

function Item({ x, active, hot, n, onClick }: { x: (typeof TOOLS)[number]; active: boolean; hot?: boolean; n: number; onClick: () => void }) {
  return (
    <button onClick={onClick} title={t(`tb.${x.id}.desc`)}
      className={`w-full flex items-center gap-2.5 rounded-md px-2 py-1 text-left text-[13px] ${active ? 'bg-white/10 text-white' : hot ? 'bg-white/5 text-zinc-200' : 'text-zinc-300 hover:bg-white/5'}`}>
      <span className={`w-9 h-5 shrink-0 flex items-center justify-center rounded font-mono text-[9.5px] ${active ? 'bg-blue-500/30 text-blue-200' : 'bg-white/5 text-zinc-500'}`}>{x.badge}</span>
      <span className="flex-1 min-w-0 truncate">{t(`tb.${x.id}.name`)}</span>
      {n < 10 && <span className="text-[10px] text-zinc-600 shrink-0">⌘{(n + 1) % 10}</span>}
    </button>
  );
}
