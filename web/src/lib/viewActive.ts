import { createContext, useContext, useEffect, useRef } from 'react';

/**
 * Views the user has opened stay mounted and are only hidden when another tab is on screen, so switching
 * back is instant. Global shortcuts and events reach every mounted view; components check this to act
 * only in the visible one.
 */
export const ViewActiveContext = createContext(true);

/** A ref that follows whether the surrounding view is on screen (for use inside event handlers). */
export function useViewActiveRef() {
  const active = useContext(ViewActiveContext);
  const ref = useRef(active);
  useEffect(() => { ref.current = active; }, [active]);
  return ref;
}
