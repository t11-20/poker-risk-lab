/**
 * Where "Next scenario" goes.
 *
 * ## The defect this replaces
 *
 * The scenario page used to look the current id up in `LAB_SCENARIO_SUMMARIES`, the bundled
 * fixture's six scenarios, whose ids (`flop-flush-draw-price`, …) are not ids the API serves. Every
 * one of the thirty-six real scenarios missed, the lookup returned null, and the button never
 * rendered — measured on the running app at commit 308fadf, zero "Next scenario" links after
 * committing on `fl-small-straight-beats-trips` at 360 and at 1440.
 *
 * ## Which list, and in what order
 *
 * The live list from `GET /content/scenarios`, in the order it arrives, because that is the order
 * the Lab index prints and numbers the cards in — "next" after card 14 is card 15. When that list
 * cannot be had, the content bundle this app was built with: it is the same thirty-six in the same
 * order (the API serves `content().scenarios`), it is what `generateStaticParams` already builds the
 * routes from, and so every id it can name is a page that exists.
 *
 * Server-only: `@prl/content` is the whole bundle and has no business in a client chunk.
 */

import { scenarios } from '@prl/content';
import type { ScenarioSummary } from '@prl/contracts';

/**
 * The scenario after `id` in `live`, or in the bundle when `live` is null.
 *
 * Null for the last one, for an id the list does not carry and for an empty list — a missing button
 * rather than a guessed destination.
 */
export function nextScenarioHref(
  id: string,
  live: readonly Pick<ScenarioSummary, 'id'>[] | null,
): string | null {
  const ordered = live ?? scenarios();
  const at = ordered.findIndex((candidate) => candidate.id === id);
  if (at < 0) return null;
  const next = ordered[at + 1];
  return next === undefined ? null : `/lab/${encodeURIComponent(next.id)}`;
}
