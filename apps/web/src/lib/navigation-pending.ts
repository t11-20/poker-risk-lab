/**
 * Whether a press is a navigation slow enough to need saying so, and what to say.
 *
 * ## The defect this exists for
 *
 * The audit at 6b3886e measured a hand replay's document at 1722, 1771 and 1839 ms to first byte,
 * and a router click from `/legends` to `/legends/compare` leaving the old page on screen, unchanged
 * and apparently ignored, for about 750 ms (`shots/m-dark-legcompare-trans-320ms.png`). Nothing said
 * the press had been taken.
 *
 * ## Why not `loading.tsx`
 *
 * It is the obvious fix and this app has deleted it twice: `test/app-shell-streaming.test.ts` refuses
 * any route-level loading file, because the Suspense boundary it creates flushes the headers before
 * the page has decided its status, and leaves a route showing its skeleton for ever without
 * JavaScript. Both shipped. So the feedback is given where the press happened, on the page the
 * reader is still looking at, by `components/NavigationPending.tsx` — and this module is the part
 * of it that can be tested without a browser.
 *
 * A leaf module with no imports, so it loads under `node --test`.
 */

/** Below this a navigation is quick enough that a message would only flash. */
export const PENDING_DELAY_MS = 400;

/**
 * After this the message is withdrawn whatever happened. A navigation the reader cancelled (Escape,
 * the stop button) leaves the page in place with no event this app can hear, and a message saying
 * "loading" over a page that is not is the same lie the frozen page told, in the other direction.
 */
export const PENDING_CEILING_MS = 15_000;

export interface PendingInput {
  /** Where the press goes, resolved against the page. */
  readonly destination: URL;
  /** The page it was pressed on. */
  readonly current: URL;
  /**
   * True when the browser itself will load the destination — a plain anchor, or a GET form — and
   * false when the router took the press (`Link` called `preventDefault`).
   */
  readonly documentLoad: boolean;
}

/**
 * Whether to start the pending message for this press.
 *
 * A router navigation is announced only when it changes the pathname, because the pathname is the
 * one change the shell can see arriving (`usePathname`) and so the one it can withdraw the message
 * on; a search-only router change would leave it standing until the ceiling. A document load is
 * announced whatever it changes, because the page it was said on is about to be replaced.
 */
export function shouldShowPending(input: PendingInput): boolean {
  const { destination, current, documentLoad } = input;
  if (destination.origin !== current.origin) return false;
  // Same page, or a fragment on it: nothing is loaded.
  if (destination.pathname === current.pathname && destination.search === current.search) return false;
  return documentLoad || destination.pathname !== current.pathname;
}

/**
 * Where a GET form goes: its action with the form's fields as the query, as the browser builds it.
 *
 * The action alone is not the destination. The compare picker's action is `/legends/compare`, so on
 * a bare `/legends/compare` the action IS the current URL and the press read as "same page, nothing
 * to load" — the one form the audit timed got no message. Files are skipped: a GET form cannot send
 * one, and the browser sends its name only.
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

/**
 * The sentence, for where the press is going.
 *
 * The two routes the audit timed say why they are slow, because "loading" over a two-second wait
 * reads as a fault and "the server is rebuilding this hand" does not. Everything else gets the
 * plain sentence.
 */
export function pendingMessage(pathname: string): string {
  if (/^\/review\/[^/]+$/u.test(pathname)) {
    return 'Opening the hand. Its replay is rebuilt from the action log, which takes a second or two.';
  }
  if (pathname === '/legends/compare') {
    return 'Comparing the styles. Each one is run many times over the same spot, which takes a moment.';
  }
  return 'Loading the page…';
}
