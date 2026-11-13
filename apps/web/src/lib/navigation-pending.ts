/**
 * Whether a press is a navigation slow enough to announce, and what to say. Not `loading.tsx`, which
 * `test/app-shell-streaming.test.ts` refuses because its Suspense boundary flushes headers before the
 * status is decided. Its one import is the leaf `age-gate.ts`, so it loads under `node --test`.
 */

import { ageCheckLocation } from './age-gate.ts';

/** Below this a navigation is quick enough that a message would only flash. */
export const PENDING_DELAY_MS = 400;

/** Withdrawn after this whatever happened, because a cancelled navigation fires no event this app hears. */
export const PENDING_CEILING_MS = 15_000;

export interface PendingInput {
  readonly destination: URL;
  readonly current: URL;
  /** True when the browser loads the destination itself, false when the router took the press. */
  readonly documentLoad: boolean;
}

/**
 * A document load is always announced. A router navigation is announced only when it changes the
 * pathname and will not land on the URL already shown, because the shell withdraws the message only
 * when its URL changes, and otherwise it would stand until `PENDING_CEILING_MS`.
 */
export function shouldShowPending(input: PendingInput): boolean {
  const { destination, current, documentLoad } = input;
  if (destination.origin !== current.origin) return false;
  if (destination.pathname === current.pathname && destination.search === current.search) return false;
  if (documentLoad) return true;
  if (destination.pathname === current.pathname) return false;
  return !landsWhereItWasPressed(destination, current);
}

/**
 * On `/age-check?next=/play` a router press to `/play` bounces back to the same URL, so the message
 * could never be withdrawn. Asks the gate's own `ageCheckLocation` and compares parsed parameters.
 * The destination is assumed gated, because silence is the safe direction.
 */
function landsWhereItWasPressed(destination: URL, current: URL): boolean {
  const bounce = new URL(ageCheckLocation(destination.pathname, destination.search), current);
  return (
    bounce.pathname === current.pathname && bounce.searchParams.toString() === current.searchParams.toString()
  );
}

/**
 * The action alone is not the destination, because the compare picker's action is its own URL.
 * Files are skipped, because a GET form sends only a file's name.
 */
export function formDestination(
  action: string,
  base: string,
  fields: Iterable<readonly [string, unknown]>,
): URL {
  const destination = new URL(action, base);
  const query = new URLSearchParams();
  for (const [name, value] of fields) {
    if (typeof value === 'string') query.append(name, value);
  }
  destination.search = query.toString();
  return destination;
}

/** The two slow routes say why they are slow, because a bare "loading" over two seconds reads as a fault. */
export function pendingMessage(pathname: string): string {
  if (/^\/review\/[^/]+$/u.test(pathname)) {
    return 'Opening the hand. Its replay is rebuilt from the action log, which takes a second or two.';
  }
  if (pathname === '/legends/compare') {
    return 'Comparing the styles. Each one is run many times over the same spot, which takes a moment.';
  }
  return 'Loading the page…';
}
