// Shared overlay dismissal hook — closes an open overlay when the user presses
// Escape. Bound at the document level only while `active` is true; cleaned up on
// unmount / deactivation so multiple overlays don't leak listeners.

import { useEffect } from 'react';

const ESCAPE_KEY = 'Escape';

/** Call `onClose` when Escape is pressed while `active`. */
export function useOverlayDismiss(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === ESCAPE_KEY) onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [active, onClose]);
}
