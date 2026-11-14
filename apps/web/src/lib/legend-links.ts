/**
 * The AI Legends screens' query parameters and links, apart from `legends-data.ts` because that module
 * pulls the fixtures into a client bundle and imports through `@/`, which `node --test` cannot resolve.
 */

import type { LegendDifficulty } from '@prl/contracts';

export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** A legend match runs as an ordinary private room once it starts. */
export const PLAY_PATH = '/play';

/**
 * Named once, because both `legendMatchHref` and the "Start a match" form build this URL, and a renamed
 * field would silently deal the bot table. `test/legend-quick-start.test.ts` pins all three.
 */
export const MATCH_PROFILE_PARAM = 'profile';
export const MATCH_DIFFICULTY_PARAM = 'difficulty';

export const LEGENDS_PATH = '/legends';
export const LEGENDS_COMPARE_PATH = '/legends/compare';
export const LEGENDS_HAND_REVIEW_PATH = '/legends/hand-review';

export const DIFFICULTIES: readonly LegendDifficulty[] = ['educational', 'realistic', 'expert'];

/** Defaults to `educational`, where the style is most legible, and never throws on a hand-edited URL. */
export function parseDifficulty(raw: string | string[] | undefined): LegendDifficulty {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = DIFFICULTIES.find((difficulty) => difficulty === value);
  return match ?? 'educational';
}

/** De-duplicated in order, from a repeated or comma-separated `profiles` parameter. */
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
 * `PROFILE_IDS_SCHEMA.maxItems` in `apps/api/src/routes/rooms.ts`, which
 * `test/legend-compare-selection.test.ts` holds this to. Six or more was refused and rendered a 500.
 */
export const MAX_COMPARE_PROFILES = 5;

/** One column has nothing to disagree with. */
export const MIN_COMPARE_PROFILES = 2;

export interface CompareSelection {
  /** At most `MAX_COMPARE_PROFILES`, in the reader's order. Empty means use the default. */
  readonly ids: readonly string[];
  readonly unknown: readonly string[];
  readonly dropped: readonly string[];
  /** One known style was named. It is shown, with a sentence saying why it is thin. */
  readonly tooFew: boolean;
}

/**
 * Every id that does not reach the request is returned so the page can name it. Unknown ids are
 * removed, because the API's refusal would read as an outage. Past five, the reader's first five are kept.
 * One style passes with `tooFew`, because its column is real.
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

/**
 * Shown above the comparison, because each changes how the columns read. Over the bundled sample
 * (`live` false) the clauses about which picked styles are shown would contradict the page, so they
 * go. Unknown and dropped ids are still named, and the one-style sentence is skipped.
 */
export function selectionNotices(
  selection: CompareSelection,
  shown: readonly string[],
  nameOf: (id: string) => string,
  live: boolean,
): readonly string[] {
  const notices: string[] = [];
  if (selection.dropped.length > 0) {
    const picked = String(shown.length + selection.dropped.length);
    const first = String(MAX_COMPARE_PROFILES);
    const leftOut =
      `${selection.dropped.map(nameOf).join(', ')} ` +
      `${selection.dropped.length === 1 ? 'was' : 'were'} left out`;
    notices.push(
      `This page compares two to five styles at a time, and ${picked} were picked. ` +
        (live
          ? `It is showing the first ${first} in the order they were named; ${leftOut}. `
          : `Only the first ${first} in the order they were named were asked for; ${leftOut}. `) +
        'Untick some below to choose which five.',
    );
  }
  if (selection.unknown.length > 0) {
    notices.push(
      `${selection.unknown.map((id) => `"${id}"`).join(', ')} ${selection.unknown.length === 1 ? 'is not one of' : 'are not among'} ` +
        `the profiles, so ${selection.unknown.length === 1 ? 'it was' : 'they were'} left out` +
        (live && selection.ids.length === 0
          ? ' and the page is showing its default three styles instead.'
          : '.'),
    );
  }
  if (live && selection.tooFew) {
    notices.push(
      `Only one style was picked. Its column is below, but a comparison needs at least ${String(MIN_COMPARE_PROFILES)}: ` +
        'with one there is nothing for it to disagree with, so there is no takeaway. Tick another below.',
    );
  }
  return notices;
}

export function profileHref(profileId: string, difficulty?: LegendDifficulty): string {
  const path = `/legends/${encodeURIComponent(profileId)}`;
  return difficulty === undefined ? path : `${path}?difficulty=${difficulty}`;
}

/** A query on `/play`, which owns its URL shape, rather than a nested route. */
export function legendMatchHref(profileId: string, difficulty: LegendDifficulty): string {
  return `${PLAY_PATH}?${MATCH_PROFILE_PARAM}=${encodeURIComponent(profileId)}&${MATCH_DIFFICULTY_PARAM}=${difficulty}`;
}

export function compareHref(profileIds: readonly string[], difficulty: LegendDifficulty): string {
  const profiles = profileIds.map((id) => encodeURIComponent(id)).join(',');
  const query = profiles === '' ? '' : `profiles=${profiles}&`;
  return `/legends/compare?${query}difficulty=${difficulty}`;
}
