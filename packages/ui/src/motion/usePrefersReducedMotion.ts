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
 *
 * ## Why the store is a factory the tests can call
 *
 * `node --test` runs no renderer in this repo, by policy, so this hook cannot be mounted. The
 * release audit's finding was not that the preference was ignored — it is consulted here and in
 * both hooks that animate — but that **nothing proved it**, which is the same thing a year later.
 * A guard nobody exercises is a guard nobody notices losing.
 *
 * So the part that can be wrong is separated from the part that needs React. `createReducedMotionStore`
 * takes the `matchMedia` host as an argument instead of reaching for a global, which lets
 * `test/motion.test.ts` hand it a window that reports `(prefers-reduced-motion: reduce)` and assert
 * the answer that comes back — the real query string, the real subscription, the real snapshot,
 * simply not the real browser. `usePrefersReducedMotion` is then the four lines that cannot be
 * tested and have nothing in them to get wrong.
 */

import { useSyncExternalStore } from 'react';
import { REDUCED_MOTION_QUERY } from './reduced-motion.ts';

/**
 * The two members of a `MediaQueryList` this store uses.
 *
 * Declared structurally rather than as the DOM's `MediaQueryList` so a test can supply one
 * without fabricating an entire EventTarget — and so the `addEventListener` guard below is
 * expressible: the members are optional here precisely because they are the ones a very old
 * implementation may not have.
 */
export interface ReducedMotionQuery {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
}

/** The one member of `window` this store uses. `matchMedia` is optional: the server has none. */
export interface MediaQueryHost {
  matchMedia?(query: string): ReducedMotionQuery;
}

/** React's external-store contract, narrowed to this one boolean. */
export interface ReducedMotionStore {
  readonly subscribe: (onStoreChange: () => void) => () => void;
  readonly getSnapshot: () => boolean;
}

/**
 * A store over one host's `prefers-reduced-motion` state.
 *
 * The `MediaQueryList` is created lazily and remembered, including the "there isn't one"
 * answer — `resolved` means "we have already looked", so a missing `matchMedia` is not
 * re-probed on every snapshot read, and a host that gains one later is not picked up mid-session
 * (which would change the answer under React without notifying it).
 */
export function createReducedMotionStore(host: MediaQueryHost | undefined): ReducedMotionStore {
  let query: ReducedMotionQuery | null = null;
  let resolved = false;

  const mediaQuery = (): ReducedMotionQuery | null => {
    if (resolved) return query;
    resolved = true;
    if (host === undefined || typeof host.matchMedia !== 'function') return null;
    query = host.matchMedia(REDUCED_MOTION_QUERY);
    return query;
  };

  return {
    subscribe(onStoreChange: () => void): () => void {
      const list = mediaQuery();
      // No `matchMedia`, or a `MediaQueryList` too old to be an EventTarget: there is nothing
      // to listen to, so the snapshot simply never changes. Returning a no-op unsubscribe keeps
      // React's contract intact rather than throwing in a subscription.
      if (list === null || list.addEventListener === undefined) return () => undefined;
      list.addEventListener('change', onStoreChange);
      return () => list.removeEventListener?.('change', onStoreChange);
    },
    getSnapshot(): boolean {
      return mediaQuery()?.matches ?? false;
    },
  };
}

let shared: ReducedMotionStore | null = null;

/** One store for the whole app, so N components share one listener rather than opening N. */
function sharedStore(): ReducedMotionStore {
  if (shared === null) {
    shared = createReducedMotionStore(typeof window === 'undefined' ? undefined : window);
  }
  return shared;
}

// Module-level constants, so React sees one stable identity for each and never re-subscribes.
// They delegate rather than close over a store built at import time: the store must not be
// constructed until something actually asks, or importing this module on the server would
// probe for a `window` that is not there.
const subscribe = (onStoreChange: () => void): (() => void) => sharedStore().subscribe(onStoreChange);
const getSnapshot = (): boolean => sharedStore().getSnapshot();

function getServerSnapshot(): boolean {
  return false;
}

/** `true` when the reader has asked for reduced motion. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
