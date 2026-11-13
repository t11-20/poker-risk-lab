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
 * Its one import is `age-gate.ts`, itself a leaf, so this still loads under `node --test`.
 */

import { ageCheckLocation } from './age-gate.ts';

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
 * A document load is announced whatever it changes, because the page it was said on is about to be
 * replaced. A router navigation is announced only when it changes the pathname and will not land on
 * the URL already shown: the shell withdraws the message when the URL it renders changes
 * (`NavigationPending` keys on pathname and query), so a router landing that changes nothing is one
 * nothing could withdraw it on, and it would stand over an idle page until `PENDING_CEILING_MS`.
 *
 * A router change of the query alone is still not announced. None of the presses the audit timed is
 * one; the landing key that could now withdraw it arrived for the age gate below, not for them.
 */
export function shouldShowPending(input: PendingInput): boolean {
  const { destination, current, documentLoad } = input;
  if (destination.origin !== current.origin) return false;
  // Same page, or a fragment on it: nothing is loaded.
  if (destination.pathname === current.pathname && destination.search === current.search) return false;
  if (documentLoad) return true;
  if (destination.pathname === current.pathname) return false;
  return !landsWhereItWasPressed(destination, current);
}

/**
 * Whether the age gate would send this router press back to the URL it was pressed on.
 *
 * Devin on PR #35: on `/age-check?next=/play`, the header's Play link is a router navigation to
 * `/play`, which `proxy.ts` answers with a 303 to `/age-check?next=/play` — the URL already on
 * screen. The press started the message, the pathname never changed, and "Loading the page…" stood
 * over the gate for the full fifteen seconds. Nothing on the page changes when that navigation
 * lands, so no landing signal the shell has could withdraw it; the fix is not to say it.
 *
 * The bounce is predictable because it is the gate's own `ageCheckLocation`, so this asks the gate
 * rather than restating its URL. Compared as parsed parameters, so `next=%2Fplay` and `next=/play`
 * are the same page. Whether the destination is gated at all is not knowable here (scope, mode and
 * the minimum age are server configuration), so it is assumed gated. The safe direction is silence:
 * a reader who has passed the gate and is still sitting on it gets no message for a Play press,
 * where the other direction leaves a false "loading" up for everybody who has not.
 */
function landsWhereItWasPressed(destination: URL, current: URL): boolean {
  const bounce = new URL(ageCheckLocation(destination.pathname, destination.search), current);
  return (
    bounce.pathname === current.pathname && bounce.searchParams.toString() === current.searchParams.toString()
  );
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
