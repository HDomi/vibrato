import { useCallback, useEffect, useState } from 'react';
import { api, type PermissionsSnapshot } from '../lib/api';
import { t, useLang } from '../lib/i18n';
import Icon from './Icon';
import AgentRules from './AgentRules';

/**
 * Settings > Permissions on Windows: the agents' standing allow / deny rules. Windows has no per-app privacy
 * permissions to list (the macOS app shows its TCC grants here).
 */
export default function PermissionsSettings({ active }: { active: boolean }) {
  useLang();
  const [snap, setSnap] = useState<PermissionsSnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setSnap(await api.permissions()); setError(null); }
    catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { if (active) void load(); }, [active, load]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); void load(); }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-line bg-black/15 p-5 space-y-3">
        <div className="flex items-center gap-3">
          <div className="font-medium flex-1">{t('perm.title')}</div>
          <button className="w-7 h-7 flex items-center justify-center rounded-full text-zinc-400 hover:text-white hover:bg-fill-2 transition-colors disabled:opacity-40"
            disabled={loading} onClick={() => void load()} title={t('perm.refresh')}><Icon name="reload" /></button>
        </div>
        {error && <div className="text-xs text-red-300 break-words">{error}</div>}
        {!snap && !error && <div className="text-sm text-zinc-500">{t('settings.detecting')}</div>}
      </div>
      {snap && <AgentRules snap={snap} busy={busy} run={run} />}
    </div>
  );
}
