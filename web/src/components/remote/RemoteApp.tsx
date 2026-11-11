import { ContextMenuProvider } from '../ContextMenu';
import Toaster from '../Toast';
import Lightbox from '../Lightbox';
import SpaceBackdrop from '../SpaceBackdrop';
import { t, useLang } from '../../lib/i18n';
import RemoteView from './RemoteView';

/** The remote-only app (Windows build): no local server, so only the Remote tab, under a plain title row. */
export default function RemoteApp() {
  useLang();
  const mac = (window.vibe as { platform?: string } | undefined)?.platform === 'darwin';
  return (
    <ContextMenuProvider>
      <div className="app-wall isolate h-full flex flex-col overflow-hidden">
        <SpaceBackdrop />
        <Lightbox />
        <Toaster />
        <div className={`titlebar-drag shrink-0 flex items-center ${mac ? 'h-[60px] pl-[84px]' : 'h-12 pl-[42px]'} text-xs select-none`}>
          <span className="font-semibold text-zinc-200">Vibrato</span>
          <span className="ml-2 text-zinc-400">{t('usage.remote')}</span>
        </div>
        {/* min-h-0: without it this column grows with the chat and nothing inside can scroll. */}
        <div className="flex-1 min-h-0 flex"><RemoteView /></div>
      </div>
    </ContextMenuProvider>
  );
}
