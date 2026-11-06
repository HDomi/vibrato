import { memo } from 'react';
import { useWallpaper } from '../lib/wallpaper';
import Starfield from './intro/Starfield';

/**
 * The "space" wallpaper's stars and planets, behind everything in the main window (the nebula itself is the
 * wallpaper CSS). Glass cards cover it with their own copy of the nebula, so the stars show in the gaps and
 * around the title bar. It runs all day, so it redraws at 30 fps and holds still while the window is inactive.
 */
export default memo(function SpaceBackdrop() {
  const w = useWallpaper();
  if (w?.kind !== 'space') return null;
  return (
    <div className="fixed inset-0 -z-10 pointer-events-none" aria-hidden>
      <Starfield fps={30} pauseInactive />
    </div>
  );
});
