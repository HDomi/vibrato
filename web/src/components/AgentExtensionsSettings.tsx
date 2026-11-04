import { useEffect, useState } from 'react';
import { api, type AgentExtensions, type ExtSkill } from '../lib/api';
import { t, useLang } from '../lib/i18n';

const SOURCE_KEY: Record<ExtSkill['source'], string> = {
  user: 'ext.source.user', plugin: 'ext.source.plugin', 'claude.ai': 'ext.source.claudeai', system: 'ext.source.system', admin: 'ext.source.admin', project: 'ext.source.project', other: 'ext.source.other',
};

function Row({ name, badge, description, on, disabled, note, onToggle }: { name: string; badge?: string; description: string; on: boolean; disabled?: boolean; note?: string; onToggle?: (on: boolean) => void }) {
  return (
    <label className={`flex items-start gap-2.5 rounded-lg px-2 py-1.5 ${disabled ? 'opacity-50' : 'hover:bg-fill cursor-pointer'}`} title={description}>
      <input type="checkbox" className="mt-0.5" checked={on} disabled={disabled || !onToggle} onChange={(e) => onToggle?.(e.target.checked)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="font-mono truncate">{name}</span>
          {badge && <span className="shrink-0 text-[10px] rounded-full bg-fill-2 px-1.5 py-px text-zinc-400">{badge}</span>}
          {note && <span className="shrink-0 text-[11px] text-amber-300/80">{note}</span>}
        </div>
        {description && <div className="text-xs text-zinc-500 truncate">{description}</div>}
      </div>
    </label>
  );
}

/**
 * Settings > Agent CLIs: the skills and plugins one CLI has installed, with a checkbox for whether new Vibrato
 * sessions get them. Unchecking saves at once; the CLI's own config is never touched.
 */
export default function AgentExtensionsSettings({ agent, reload }: { agent: 'claude' | 'codex'; /** Bumped by "Re-detect" to re-read from the CLI. */ reload: number }) {
  useLang();
  const [data, setData] = useState<AgentExtensions | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    setErr('');
    api.extensions(agent, reload > 0).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [agent, reload]);

  const offSkills = new Set(data?.off.skills ?? []);
  const offPlugins = new Set(data?.off.plugins ?? []);
  const save = (skills: Set<string>, plugins: Set<string>) => {
    if (!data) return;
    const prev = data.off;
    setData({ ...data, off: { skills: [...skills], plugins: [...plugins] } });
    api.saveExtensions(agent, [...skills], [...plugins]).then((r) => setData((d) => d && { ...d, off: r.off })).catch((e) => { setErr((e as Error).message); setData((d) => d && { ...d, off: prev }); });
  };
  const toggle = (set: Set<string>, key: string, on: boolean) => { const next = new Set(set); if (on) next.delete(key); else next.add(key); return next; };

  if (err && !data) return <div className="mt-3 text-xs text-amber-300">{err}</div>;
  if (!data) return <div className="mt-3 text-xs text-zinc-500">{t('ext.loading')}</div>;
  const skillsOn = data.skills.filter((s) => s.enabled && !offSkills.has(s.name) && !(s.plugin && offPlugins.has(s.plugin))).length;
  const pluginsOn = data.plugins.filter((p) => p.enabled && !offPlugins.has(p.id)).length;

  return (
    <div className="mt-3 border-t border-white/5 pt-3">
      <button className="flex items-center gap-2 text-xs text-zinc-300 hover:text-white" onClick={() => setOpen(!open)}>
        <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        {t('ext.summary', { skills: `${skillsOn}/${data.skills.length}`, plugins: `${pluginsOn}/${data.plugins.length}` })}
      </button>
      {data.error && <div className="mt-2 text-xs text-amber-300">{t('ext.error', { msg: data.error })}</div>}
      {err && <div className="mt-2 text-xs text-amber-300">{err}</div>}
      {open && (
        <div className="mt-2 space-y-3">
          <div className="text-xs text-zinc-500 leading-relaxed">{t(agent === 'claude' ? 'ext.note.claude' : 'ext.note.codex')}</div>
          {data.plugins.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">{t('ext.plugins')}</div>
              {data.plugins.map((p) => (
                <Row key={p.id} name={p.id} description={p.description} on={p.enabled && !offPlugins.has(p.id)} disabled={!p.enabled}
                  note={!p.enabled ? t('ext.offInCli') : !p.toggle ? t('ext.readOnly') : undefined}
                  onToggle={p.toggle ? (on) => save(offSkills, toggle(offPlugins, p.id, on)) : undefined} />
              ))}
            </div>
          )}
          <div>
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">{t('ext.skills')}</div>
            {data.skills.length === 0 && <div className="text-xs text-zinc-500 px-2">{t('ext.none')}</div>}
            {data.skills.map((s) => {
              const pluginOff = !!s.plugin && offPlugins.has(s.plugin);
              return (
                <Row key={s.name} name={s.name} badge={t(SOURCE_KEY[s.source])} description={s.description}
                  on={s.enabled && !pluginOff && !offSkills.has(s.name)} disabled={!s.enabled || pluginOff}
                  note={!s.enabled ? t('ext.offInCli') : pluginOff ? t('ext.pluginOff') : undefined}
                  onToggle={(on) => save(toggle(offSkills, s.name, on), offPlugins)} />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
