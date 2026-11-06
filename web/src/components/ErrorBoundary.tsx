import { Component, type ReactNode } from 'react';
import { t } from '../lib/i18n';

/**
 * Last line of defence for the main window: an error thrown while rendering would otherwise unmount the whole
 * tree and leave an empty window. Shows what broke and a reload button instead.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('[vibrato] render failed', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="h-full flex items-center justify-center px-8">
        <div className="titlebar-drag absolute inset-x-0 top-0 h-14" />
        <div className="glass w-full max-w-[520px] px-9 py-8">
          <h2 className="text-xl font-semibold text-white">{t('crash.title')}</h2>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">{t('crash.body')}</p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-xl bg-black/30 px-3 py-2.5 text-xs text-red-200 whitespace-pre-wrap break-words select-text">{error.message || String(error)}</pre>
          <div className="mt-6 flex justify-end">
            <button className="h-10 px-5 rounded-full bg-zinc-100 text-zinc-900 text-sm font-medium hover:bg-white transition-colors" onClick={() => location.reload()}>{t('crash.reload')}</button>
          </div>
        </div>
      </div>
    );
  }
}
