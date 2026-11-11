/**
 * The AI Legends screens' query parameters and links, with nothing else in the module.
 *
 * ## Why this is not in `legends-data.ts` any more
 *
 * Two reasons, both about what a module drags in with it. `legends-data.ts` imports the bundled
 * fixtures, so a CLIENT component that wanted `legendMatchHref` from there would ship every sample
 * profile, comparison and hand to the browser to build one URL — and the Play links now have to be
 * client components (see `LegendPlayLink.tsx`). And it imports them through the `@/` alias, which
 * `node --test` cannot resolve, so nothing in it could be tested directly; the compare page's
 * selection rules below are exactly the logic that shipped a 500 for want of a test.
 *
 * `legends-data.ts` re-exports everything here, so no screen's imports changed.
 */

import type { LegendDifficulty } from '@prl/contracts';

/** What Next hands a page as `searchParams`, once awaited. */
export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** The play screen's route. A legend match runs as an ordinary private room once it starts. */
const PLAY_PATH = '/play';

export const LEGENDS_PATH = '/legends';
export const LEGENDS_COMPARE_PATH = '/legends/compare';
export const LEGENDS_HAND_REVIEW_PATH = '/legends/hand-review';

export const DIFFICULTIES: readonly LegendDifficulty[] = ['educational', 'realistic', 'expert'];

/**
 * The difficulty a page was asked for.
 *
 * Defaults to `educational` rather than to the middle setting. `educational` is the one where
 * the style is most legible and the Coach stays available while playing, which is the right
 * place for someone who has not chosen yet — and an unrecognised value falls back to it rather
 * than throwing, because a hand-edited URL should not be able to produce an error page.
 */
export function parseDifficulty(raw: string | string[] | undefined): LegendDifficulty {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = DIFFICULTIES.find((difficulty) => difficulty === value);
  return match ?? 'educational';
}

/** Profile ids from a repeated or comma-separated `profiles` parameter, de-duplicated in order. */
export function parseProfileIds(raw: string | string[] | undefined): readonly string[] {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const ids: string[] = [];
  for (const value of values) {
    for (const part of value.split(',')) {
      const id = part.trim();
      if (id !== '' && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * The most styles `POST /legends/compare` accepts in one request.
 *
 * The authority is `PROFILE_IDS_SCHEMA.maxItems` in `apps/api/src/routes/rooms.ts`, which this
 * client cannot import; `test/legend-compare-selection.test.ts` reads that file and fails if the
 * two disagree. The number was not written down on this side at all, and the compare form offers
 * twelve checkboxes: measured against the running build, ticking all twelve — or any six — sent a
 * request the schema refused, `loadProfileComparison` rethrew the `invalid_request`, and the reader
 * got HTTP 500 and "This screen did not load". Two to five answered 200.
 */
export const MAX_COMPARE_PROFILES = 5;

/** Fewer than two is one column with nothing to disagree with, which is the page's whole subject. */
export const MIN_COMPARE_PROFILES = 2;

/** What the compare page will actually put side by side, and everything it had to leave out. */
export interface CompareSelection {
  /** Known profile ids in the reader's order, at most `MAX_COMPARE_PROFILES`. Empty: use the default. */
  readonly ids: readonly string[];
  /** Ids the URL named that are not profiles. */
  readonly unknown: readonly string[];
  /** Known ids past the fifth, in the order they were named. */
  readonly dropped: readonly string[];
  /** Exactly one known style was named. It is still shown, with a sentence saying why it is thin. */
  readonly tooFew: boolean;
}

/**
 * The reader's `profiles` parameter, reduced to a request the API will accept.
 *
 * Fail in the safe direction, and say so: every id that does not reach the request is returned
 * beside the ones that do, so the page can name it. Nothing here is silent —
 *
 *  - **Unknown ids are removed** rather than sent. Sent, the API refused them and the loader
 *    reported the refusal as an outage: `?profiles=nope,calling-station` rendered the bundled
 *    four-column sample under "The comparison service is not reachable", against a server that
 *    was up, for a pair the reader never asked for.
 *  - **More than five keeps the first five.** The reader's own order, because it is the only one
 *    they chose; a page that silently compared some other five would be answering a question
 *    nobody asked.
 *  - **One is allowed through** with `tooFew`, because the column is real and worth reading — it
 *    is only the takeaway, a sentence about a disagreement, that has nothing to say.
 */
export function parseCompareSelection(
  raw: string | string[] | undefined,
  knownIds: readonly string[],
): CompareSelection {
  const requested = parseProfileIds(raw);
  const known = requested.filter((id) => knownIds.includes(id));
  const unknown = requested.filter((id) => !knownIds.includes(id));
  return {
    ids: known.slice(0, MAX_COMPARE_PROFILES),
    unknown,
    dropped: known.slice(MAX_COMPARE_PROFILES),
    tooFew: known.length === 1,
  };
}

export function profileHref(profileId: string, difficulty?: LegendDifficulty): string {
  const path = `/legends/${encodeURIComponent(profileId)}`;
  return difficulty === undefined ? path : `${path}?difficulty=${difficulty}`;
}

/**
 * The link that starts a match against one style.
 *
 * A query on `/play` rather than a nested route: the play screen exists and owns its own URL
 * shape, and a link into a path it has not defined would be a broken link on every card.
 */
export function legendMatchHref(profileId: string, difficulty: LegendDifficulty): string {
  return `${PLAY_PATH}?profile=${encodeURIComponent(profileId)}&difficulty=${difficulty}`;
}

export function compareHref(profileIds: readonly string[], difficulty: LegendDifficulty): string {
  const profiles = profileIds.map((id) => encodeURIComponent(id)).join(',');
  const query = profiles === '' ? '' : `profiles=${profiles}&`;
  return `/legends/compare?${query}difficulty=${difficulty}`;
}
