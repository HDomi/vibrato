import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t, useLang } from '../lib/i18n';

/**
 * A question with Cancel / Confirm over the whole app (portaled to <body>, like the other dialogs). `danger` paints
 * Confirm red. Escape and Cancel close it; Confirm waits for `onConfirm` before closing and shows it is working.
 */
export default function ConfirmDialog({ title, message, confirmLabel, danger = false, onConfirm, onClose }: {
  title?: string; message: string; confirmLabel?: string; danger?: boolean;
  onConfirm: () => Promise<void> | void; onClose: () => void;
}) {
  useLang();
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [busy, onClose]);
  const confirm = async () => {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); onClose(); }
  };
  return createPortal(
    <div className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-confirm-dialog=""
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="alertdialog" aria-modal="true" aria-label={title ?? message} className="glass-pop pop-in w-[420px] max-w-[92vw] !rounded-[20px] text-sm">
        <div className="px-5 pt-5 pb-4 space-y-2">
          {title && <div className="font-semibold text-zinc-100">{title}</div>}
          <div className="text-zinc-300 leading-relaxed whitespace-pre-wrap">{message}</div>
        </div>
        <div className="flex justify-end gap-2 px-5 pb-4">
          <button ref={cancel} type="button" disabled={busy} onClick={onClose}
            className="rounded-full bg-fill hover:bg-fill-2 px-4 py-1.5 text-xs text-zinc-200 transition-colors disabled:opacity-40">{t('common.cancel')}</button>
          <button type="button" disabled={busy} onClick={() => void confirm()} data-confirm-ok=""
            className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${danger ? 'bg-red-500/80 hover:bg-red-500 text-white' : 'bg-selected hover:bg-white text-on-selected'}`}>
            {busy ? t('common.working') : confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
