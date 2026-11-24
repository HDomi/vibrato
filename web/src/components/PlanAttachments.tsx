import { createContext, useContext } from 'react';
import type { Attachment } from '../lib/agent';
import { imageSrc } from '../lib/api';
import { openLightbox } from './Lightbox';

/** The plan view is showing a remote host's session (Remote tab): its files are on the host, not here. */
export const RemotePlan = createContext(false);

/**
 * Pictures (and other files) sent with a request or with a message added to it, under its text. Pictures are
 * thumbnails that open in the lightbox; in the Remote tab the files are on the host, so only their names show.
 */
export function PlanAttachments({ attachments, indent = false, small = false }: { attachments: Attachment[]; indent?: boolean; small?: boolean }) {
  const remote = useContext(RemotePlan);
  if (!attachments.length) return null;
  const ext = (a: Attachment) => a.name.slice(a.name.lastIndexOf('.'));
  return (
    <div className={`mt-1.5 flex flex-wrap items-center gap-1.5 ${indent ? 'pl-[42px]' : ''}`} data-plan-attachments="">
      {attachments.map((a) => a.kind === 'image' && !remote
        ? <img key={a.path} src={imageSrc(a.path, ext(a))} alt={a.name} title={a.name} loading="lazy"
            onClick={(e) => { e.stopPropagation(); openLightbox(imageSrc(a.path, ext(a)), a.name); }}
            className={`${small ? 'h-10' : 'h-16'} max-w-[180px] rounded-md object-cover border border-line cursor-zoom-in hover:opacity-90 transition-opacity`} />
        : <span key={a.path} title={a.path} className="max-w-[220px] truncate rounded-md bg-fill px-2 py-0.5 text-[11px] text-zinc-400">{a.kind === 'image' ? '🖼' : '📎'} {a.name}</span>)}
    </div>
  );
}

