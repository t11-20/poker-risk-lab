/**
 * AI Legends data loaders. Each tries the API and falls back to a typed fixture, and returns which
 * source it used, so a screen cannot show sample numbers as live. API paths come from `API_PATHS` in
 * `@prl/contracts`, and web routes and query parameters from `legend-links.ts`.
 */

import type {
  CompareProfilesRequest,
  CompareProfilesResponse,
  HandComparison,
  LearnFromProfileResponse,
  LegendDifficulty,
  LegendProfileCardDto,
  LegendProfilesResponse,
  ProfileStatsResponse,
} from '@prl/contracts';
import { MAX_COMPARE_TRIALS } from '@prl/contracts';
import {
  COMPARE_FIXTURE,
  COMPARE_SITUATION_FIXTURE,
  HAND_COMPARISON_FIXTURE,
  LEGEND_PROFILES_FIXTURE,
  learnFromFixture,
  profileFixtureById,
} from '@/fixtures/legends.ts';
import {
  API_PATHS,
  type ApiCallOptions,
  ApiRequestError,
  apiGet,
  apiSend,
  EXPENSIVE_READ_TIMEOUT_MS,
  isApiUnavailable,
  isMissingResource,
  isSignedOut,
  safeFetch,
  serverCsrfHandshake,
} from './api.ts';

export type LegendDataSource = 'api' | 'fixture';

/** Never data without its source. */
export interface LegendData<T> {
  readonly data: T;
  readonly source: LegendDataSource;
  readonly fallbackReason: string | null;
}

function live<T>(data: T): LegendData<T> {
  return { data, source: 'api', fallbackReason: null };
}

function sampled<T>(data: T, reason: string): LegendData<T> {
  return { data, source: 'fixture', fallbackReason: reason };
}

// Re-exported from `legend-links.ts`, so no screen's imports changed.

export {
  type CompareSelection,
  compareHref,
  DIFFICULTIES,
  LEGENDS_COMPARE_PATH,
  LEGENDS_HAND_REVIEW_PATH,
  LEGENDS_PATH,
  legendMatchHref,
  MATCH_DIFFICULTY_PARAM,
  MATCH_PROFILE_PARAM,
  MAX_COMPARE_PROFILES,
  MIN_COMPARE_PROFILES,
  PLAY_PATH,
  parseCompareSelection,
  parseDifficulty,
  parseProfileIds,
  profileHref,
  type SearchParams,
  selectionNotices,
} from './legend-links.ts';

const PROFILES_FALLBACK =
  'The profile service is not reachable, so this page is rendering the bundled sample profiles. ' +
  'The trait values and the disclaimers are real; treat nothing here as a live figure.';

export async function loadLegendProfiles(): Promise<LegendData<LegendProfilesResponse>> {
  const result = await safeFetch<LegendProfilesResponse>(() =>
    apiGet<LegendProfilesResponse>(API_PATHS.legendProfiles()),
  );
  if (result.ok) return live(result.data);
  if (!isApiUnavailable(result.error)) throw result.error;
  return sampled(LEGEND_PROFILES_FIXTURE, `${PROFILES_FALLBACK} (${result.error.message})`);
}

/** Null turns into a 404. */
export function findProfile(
  profiles: readonly LegendProfileCardDto[],
  profileId: string,
): LegendProfileCardDto | null {
  return profiles.find((profile) => profile.id === profileId) ?? null;
}

const LEARN_FALLBACK =
  'The profile service is not reachable, so the observed statistics and the contrast section below ' +
  'come from bundled sample data rather than from your own session.';

/** Null only when the profile is missing from the fixture too, which the page turns into a 404. */
export async function loadLearnFromProfile(
  profileId: string,
): Promise<LegendData<LearnFromProfileResponse> | null> {
  const result = await safeFetch<LearnFromProfileResponse>(() =>
    apiGet<LearnFromProfileResponse>(API_PATHS.legendProfile(profileId)),
  );
  if (result.ok) return live(result.data);
  // The reader typed this id, so "no such profile" is data, not a fault.
  if (isMissingResource(result.error)) return null;
  if (!isApiUnavailable(result.error)) throw result.error;
  const fixture = learnFromFixture(profileId);
  if (fixture === null) return null;
  return sampled(fixture, `${LEARN_FALLBACK} (${result.error.message})`);
}

const COMPARE_FALLBACK =
  'The comparison service is not reachable, so this page is rendering a bundled sample spot. The ' +
  'arithmetic in it is internally consistent, but it was not computed for the profiles you picked.';

export type CompareSituation = NonNullable<CompareProfilesRequest['situation']>;

export const COMPARE_SITUATION: CompareSituation = COMPARE_SITUATION_FIXTURE;

/**
 * The server's maximum, 40. A larger value is rejected as `invalid_request`. The page states that the
 * widest 95% interval over forty trials is about 15 points.
 */
const COMPARE_TRIALS = MAX_COMPARE_TRIALS;

/**
 * A `POST` because it carries a whole situation, but a pure read, so a server render calls it.
 * `serverCsrfHandshake()` completes the double-submit for the render itself, anonymously, without
 * relaxing the check or touching the reader's credentials.
 */
export async function loadProfileComparison(input: {
  readonly profileIds: readonly string[];
  readonly difficulty: LegendDifficulty;
  readonly situation: CompareSituation;
}): Promise<LegendData<CompareProfilesResponse>> {
  const request: CompareProfilesRequest = {
    situation: input.situation,
    profileIds: input.profileIds,
    difficulty: input.difficulty,
    trials: COMPARE_TRIALS,
  };
  const handshake = await serverCsrfHandshake();
  if (handshake === null) {
    return sampled(
      COMPARE_FIXTURE,
      `${COMPARE_FALLBACK} (the API did not issue a CSRF token, so the comparison could not be requested)`,
    );
  }
  const result = await safeFetch<CompareProfilesResponse>(() =>
    apiSend<CompareProfilesResponse>('POST', API_PATHS.legendCompare(), request, {
      csrfToken: handshake.csrfToken,
      cookie: handshake.cookie,
    }),
  );
  if (result.ok) return live(result.data);
  if (!isApiUnavailable(result.error)) throw result.error;
  return sampled(COMPARE_FIXTURE, `${COMPARE_FALLBACK} (${result.error.message})`);
}

const STATS_FALLBACK =
  'The measurement service is not reachable, so there is nothing to show here. What this section ' +
  'carries is a simulation of the model, and there is no offline copy of one: a bundled figure ' +
  'would be a number nobody measured.';

/**
 * Not a `LegendData<T>`, because a measurement has no honest bundled stand-in, unlike the authored
 * material the other loaders fall back to. The shape has room for an absence and none for an invention.
 */
export interface ProfileStatsData {
  readonly stats: ProfileStatsResponse | null;
  readonly unavailableReason: string | null;
}

export async function loadProfileStats(profileId: string): Promise<ProfileStatsData> {
  const result = await safeFetch<ProfileStatsResponse>(() =>
    apiGet<ProfileStatsResponse>(API_PATHS.legendProfileStats(profileId)),
  );
  if (result.ok) return { stats: result.data, unavailableReason: null };
  // A 404 has already become the page's not-found screen. Anything else that is not an outage is a fault.
  if (!isMissingResource(result.error) && !isApiUnavailable(result.error)) throw result.error;
  return { stats: null, unavailableReason: `${STATS_FALLBACK} (${result.error.message})` };
}

/**
 * Every failure is its own sentence and never falls back to the worked example, so a reader never sees
 * somebody else's hand as their own. The sample lives only at `/legends/hand-review/demo`.
 */
export type HandComparisonProblem =
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-comparable'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly detail: string };

export type HandComparisonResult =
  | { readonly ok: true; readonly comparison: HandComparison }
  | { readonly ok: false; readonly problem: HandComparisonProblem };

const NOT_COMPARABLE_REASONS: Readonly<Record<string, string>> = {
  'hand-in-progress':
    'This hand is still being played. A comparison shows what every seat could see at each ' +
    'decision, so it can only be built once the hand is over.',
  'no-legend-in-hand':
    'No seat in this hand was played by one of the modelled styles, so there is nothing to compare ' +
    'your decisions against. Start a table from an AI Legends profile and this page will have a ' +
    'hand to review.',
  'not-reproducible':
    'The stored record of this hand cannot be replayed into the situations each seat acted on, so ' +
    'no figure on this page could be trusted. Nothing is shown rather than something approximate.',
};

/**
 * The session travels via `readerCallOptions`, because the route is scoped to a seat the caller held.
 * Without it the API answers `not_authenticated`, reported as `signed-out`, never as "no such hand".
 */
export async function loadHandComparison(
  handId: string,
  options: ApiCallOptions = {},
): Promise<HandComparisonResult> {
  const result = await safeFetch<HandComparison>(() =>
    apiGet<HandComparison>(API_PATHS.legendHandComparison(handId), {
      ...options,
      // It prices every action not taken, so it is an expensive read.
      timeoutMs: EXPENSIVE_READ_TIMEOUT_MS,
    }),
  );
  if (result.ok) return { ok: true, comparison: result.data };

  const error = result.error;
  if (isSignedOut(error)) return { ok: false, problem: { kind: 'signed-out' } };
  if (isMissingResource(error)) return { ok: false, problem: { kind: 'not-found' } };
  if (error instanceof ApiRequestError && error.code === 'hand_not_comparable') {
    const named = error.fields?.['hand'];
    const reason =
      typeof named === 'string' ? (NOT_COMPARABLE_REASONS[named] ?? error.message) : error.message;
    return { ok: false, problem: { kind: 'not-comparable', reason } };
  }
  return { ok: false, problem: { kind: 'unavailable', detail: error.message } };
}

/** Only for `/legends/hand-review/demo`. Never a fallback, because a reader could not tell. */
export function demoHandComparison(): HandComparison {
  return HAND_COMPARISON_FIXTURE;
}

/** Three styles that disagree, because columns that agree teach the opposite of what the page is for. */
export const DEFAULT_COMPARE_PROFILE_IDS: readonly string[] = [
  'reading-pressure-specialist',
  'patient-technician',
  'disciplined-specialist',
];

export function profileLabel(profileId: string): string {
  return profileFixtureById(profileId)?.disclosure.archetypeName ?? profileId;
}
