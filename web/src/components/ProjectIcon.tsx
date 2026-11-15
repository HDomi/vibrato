import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { lastSegment } from '../lib/paths';

/** Auto-detected project icon with a lettered fallback chip. Hides the image on 404. */
export default function ProjectIcon({ path, name, size = 20, className = '' }: { path: string; name: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [path]);
  const letters = (name || lastSegment(path) || '?').slice(0, 2).toUpperCase();
  if (failed) {
    return (
      <span className={`inline-flex items-center justify-center rounded-md bg-white/10 text-zinc-300 font-medium shrink-0 ${className}`}
        style={{ width: size, height: size, fontSize: Math.max(9, size * 0.42) }}>{letters}</span>
    );
  }
  return (
    <img src={api.projectIconUrl(path)} alt="" draggable={false} onError={() => setFailed(true)}
      className={`rounded-md object-contain shrink-0 bg-white/5 ${className}`} style={{ width: size, height: size }} />
  );
}
