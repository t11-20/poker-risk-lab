'use client';

/**
 * The saved spots as React state. Read after hydration, because the server has no storage and a
 * first render that differed from its HTML would be thrown away. Other tabs' writes arrive through the
 * `storage` event.
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { SavedSpot } from './spot.ts';
import {
  readLibrary,
  SPOTS_STORAGE_KEY,
  type SpotLibrary,
  type SpotStore,
  type WriteResult,
  writeLibrary,
} from './spot-storage.ts';

export interface LoadedLibrary extends SpotLibrary {
  /** False on the server and on the first client render. */
  readonly ready: boolean;
}

const PENDING: LoadedLibrary = { spots: [], notice: null, writable: false, ready: false };

/** `localStorage` itself can throw on access where site data is blocked. */
function browserStore(): SpotStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
let cached: { readonly raw: string | null | undefined; readonly library: LoadedLibrary } | null = null;

function rawValue(): string | null | undefined {
  try {
    return browserStore()?.getItem(SPOTS_STORAGE_KEY) ?? null;
  } catch {
    return undefined;
  }
}

/** The same object while the stored text is unchanged, as `useSyncExternalStore` requires. */
function snapshot(): LoadedLibrary {
  const raw = rawValue();
  if (cached !== null && cached.raw === raw) return cached.library;
  const library = { ...readLibrary(raw === undefined ? null : browserStore()), ready: true };
  cached = { raw, library };
  return library;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === SPOTS_STORAGE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useSpotLibrary(): {
  readonly library: LoadedLibrary;
  /** Storage as it is now, so a write is built on what another tab saved, not on the last render. */
  readonly read: () => LoadedLibrary;
  readonly commit: (spots: readonly SavedSpot[]) => WriteResult;
} {
  const library = useSyncExternalStore(subscribe, snapshot, () => PENDING);
  const commit = useCallback((spots: readonly SavedSpot[]): WriteResult => {
    const result = writeLibrary(browserStore(), snapshot(), spots);
    for (const listener of listeners) listener();
    return result;
  }, []);
  return { library, read: snapshot, commit };
}
