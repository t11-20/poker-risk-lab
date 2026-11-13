'use client';

/**
 * `prefers-reduced-motion` as a boolean, for what CSS cannot reach (rAF loops, reveal on mount).
 * `useSyncExternalStore`, because `useState` plus an effect animates one frame before correcting.
 * The server snapshot is `false`, because guessing `true` flashes content away on hydration.
 * `createReducedMotionStore` takes the host as an argument so `test/motion.test.ts` can drive it.
 */

import { useSyncExternalStore } from 'react';
import { REDUCED_MOTION_QUERY } from './reduced-motion.ts';

/** Structural, so a test needs no EventTarget. The listeners are optional for very old implementations. */
export interface ReducedMotionQuery {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
}

/** `matchMedia` is optional because the server has none. */
export interface MediaQueryHost {
  matchMedia?(query: string): ReducedMotionQuery;
}

export interface ReducedMotionStore {
  readonly subscribe: (onStoreChange: () => void) => () => void;
  readonly getSnapshot: () => boolean;
}

/**
 * The query is looked up once, including a missing one. A host that gains `matchMedia` later is not
 * picked up, because that would change the answer under React without notifying it.
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
      // Nothing to listen to, so the snapshot never changes. A no-op unsubscribe keeps React's contract.
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

/** One store, so N components share one listener. */
function sharedStore(): ReducedMotionStore {
  if (shared === null) {
    shared = createReducedMotionStore(typeof window === 'undefined' ? undefined : window);
  }
  return shared;
}

// Stable identities so React never re-subscribes. They delegate so no store is built at import time
// on the server.
const subscribe = (onStoreChange: () => void): (() => void) => sharedStore().subscribe(onStoreChange);
const getSnapshot = (): boolean => sharedStore().getSnapshot();

function getServerSnapshot(): boolean {
  return false;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
