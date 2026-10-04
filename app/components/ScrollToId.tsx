'use client';

import { useEffect } from 'react';

/**
 * Jumps to a section on mount — used to open the fixtures page at the
 * upcoming matchday. Skipped when the URL already carries a fragment, so
 * explicit #md-N links keep their native anchor behavior. Deferred past
 * hydration because the App Router resets scroll to top on mount.
 */
export function ScrollToId({ id }: { id: string }) {
  useEffect(() => {
    if (window.location.hash) return;
    const timer = window.setTimeout(() => {
      const reduced = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      document
        .getElementById(id)
        ?.scrollIntoView({
          block: 'start',
          behavior: reduced ? 'auto' : 'smooth',
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [id]);
  return null;
}
