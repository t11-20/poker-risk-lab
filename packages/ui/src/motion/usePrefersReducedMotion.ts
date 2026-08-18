'use client';

/**
 * Subscribes to `prefers-reduced-motion` and reports it as a boolean.
 *
 * The CSS side of this preference is already handled globally (`tokens.css` collapses every
 * duration to 1ms). This hook exists for the parts CSS cannot reach: whether to run a
 * `requestAnimationFrame` loop at all, and whether a reveal should resolve on mount instead
 * of on scroll.
 *
 * ## Why `useSyncExternalStore` rather than `useState` + `useEffect`
 *
 * The `useState(false)` + `useEffect(read once)` spelling of this hook has a real bug in a
 * server-rendered app: the first client render always says "motion is fine", so a reader who
 * asked for no motion gets one frame of animation before the effect corrects it. React's
 * external-store hook is built for exactly this shape — it reads the live value during
 * render on the client, uses `getServerSnapshot` for the server and for hydration, and owns
 * the subscription's lifetime so there is no cleanup to forget.
 *
 * ## Why the server snapshot is `false`
 *
 * The server cannot know. Of the two guesses, `false` (assume motion is allowed) is the one
 * that fails safely: the client's first render corrects it before paint, and the visible
 * consequence is at worst a reveal that resolves instantly. Guessing `true` would render
 * every reveal as already-arrived and then take it away again on hydration, which is both a
 * flash of content and a mismatch in the direction that actually looks broken.
 *
 * ## Why the media query list is module-level
 *
 * `subscribe` and `getSnapshot` must be stable function identities or React re-subscribes on
 * every render. Keeping them at module scope, over one lazily created `MediaQueryList`, gives
 * the whole app a single listener no matter how many components ask.
 */

import { useSyncExternalStore } from 'react';
import { REDUCED_MOTION_QUERY } from './reduced-motion.ts';

let queryList: MediaQueryList | null = null;
let queryResolved = false;

/**
 * The shared `MediaQueryList`, or `null` where there is no `matchMedia` — the server, and
 * any test environment without a DOM. `queryResolved` means "we have already looked", so a
 * missing `matchMedia` is not re-probed on every snapshot read.
 */
function mediaQuery(): MediaQueryList | null {
  if (queryResolved) return queryList;
  queryResolved = true;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  queryList = window.matchMedia(REDUCED_MOTION_QUERY);
  return queryList;
}

function subscribe(onStoreChange: () => void): () => void {
  const list = mediaQuery();
  // No `matchMedia`, or a `MediaQueryList` too old to be an EventTarget: there is nothing
  // to listen to, so the snapshot simply never changes. Returning a no-op unsubscribe keeps
  // React's contract intact rather than throwing in a subscription.
  if (list === null || typeof list.addEventListener !== 'function') return () => undefined;
  list.addEventListener('change', onStoreChange);
  return () => list.removeEventListener('change', onStoreChange);
}

function getSnapshot(): boolean {
  return mediaQuery()?.matches ?? false;
}

function getServerSnapshot(): boolean {
  return false;
}

/** `true` when the reader has asked for reduced motion. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
