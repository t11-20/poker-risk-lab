/**
 * Where the AI Legends screens get their data, and where they get their links.
 *
 * ## The fixture is a fallback, never a disguise
 *
 * Every function here tries the API and falls back to a typed fixture, returning **which of the
 * two it used** alongside the data. That last part is the whole design. A screen that quietly
 * rendered sample numbers as though they were live would be fabrication, in a product whose
 * subject is how much confidence a number deserves. So the source is part of the return type,
 * the screens render a visible notice when it is `fixture`, and there is no way to read the data
 * without having been handed the source next to it.
 *
 * The fallback is not defensive programming for its own sake either: the legends endpoints are
 * being written in parallel with these screens, so "the API is not there yet" is the normal case
 * during the build-out and the case CI renders in.
 *
 * ## Where the paths live
 *
 * Not here. `API_PATHS` in `@prl/contracts` is the one table both sides of the wire compile
 * against; this file used to carry its own `LEGEND_API_PATHS`, written before the routes were
 * named, and every entry in it was wrong — the version segment was missing, the profile detail
 * route was invented as `/legends/:id/learn` rather than the real `/legends/profiles/:id`, and
 * one entry named a route that does not exist at all. `PLAY_PATH` below is still local, because
 * that one is a *web* route and belongs to the play screen.
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

/** The play screen's route. A legend match runs as an ordinary private room once it starts. */
const PLAY_PATH = '/play';

export type LegendDataSource = 'api' | 'fixture';

/** Data, plus which of the two sources produced it. Never one without the other. */
export interface LegendData<T> {
  readonly data: T;
  readonly source: LegendDataSource;
  /** One sentence a screen can show a reader. Null when the data is live. */
  readonly fallbackReason: string | null;
}

function live<T>(data: T): LegendData<T> {
  return { data, source: 'api', fallbackReason: null };
}

function sampled<T>(data: T, reason: string): LegendData<T> {
  return { data, source: 'fixture', fallbackReason: reason };
}

// ---------------------------------------------------------------------------
// Reading query parameters
// ---------------------------------------------------------------------------

/** What Next hands a page as `searchParams`, once awaited. */
export type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

const DIFFICULTIES: readonly LegendDifficulty[] = ['educational', 'realistic', 'expert'];

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

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

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

export const LEGENDS_PATH = '/legends';
export const LEGENDS_COMPARE_PATH = '/legends/compare';
export const LEGENDS_HAND_REVIEW_PATH = '/legends/hand-review';

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

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

/** Null when no such profile exists in either source — the page turns that into a 404. */
export function findProfile(
  profiles: readonly LegendProfileCardDto[],
  profileId: string,
): LegendProfileCardDto | null {
  return profiles.find((profile) => profile.id === profileId) ?? null;
}

const LEARN_FALLBACK =
  'The profile service is not reachable, so the observed statistics and the contrast section below ' +
  'come from bundled sample data rather than from your own session.';

/**
 * The "what can I learn from this style" payload.
 *
 * Returns `null` only when the profile does not exist in the fixture either, which is the
 * signal for a 404 rather than for an empty section.
 */
export async function loadLearnFromProfile(
  profileId: string,
): Promise<LegendData<LearnFromProfileResponse> | null> {
  const result = await safeFetch<LearnFromProfileResponse>(() =>
    apiGet<LearnFromProfileResponse>(API_PATHS.legendProfile(profileId)),
  );
  if (result.ok) return live(result.data);
  // The reader supplied this id in the URL, so an answer of "no such profile" is data, not a fault.
  if (isMissingResource(result.error)) return null;
  if (!isApiUnavailable(result.error)) throw result.error;
  const fixture = learnFromFixture(profileId);
  if (fixture === null) return null;
  return sampled(fixture, `${LEARN_FALLBACK} (${result.error.message})`);
}

const COMPARE_FALLBACK =
  'The comparison service is not reachable, so this page is rendering a bundled sample spot. The ' +
  'arithmetic in it is internally consistent, but it was not computed for the profiles you picked.';

/** The situation the comparison is about. Sent to the API, and rendered beside the maths. */
export type CompareSituation = NonNullable<CompareProfilesRequest['situation']>;

export const COMPARE_SITUATION: CompareSituation = COMPARE_SITUATION_FIXTURE;

/**
 * Trials per profile.
 *
 * `MAX_COMPARE_TRIALS` on the server, not a number chosen here. This used to be 400 against a
 * schema whose maximum is 40, so every request would have been rejected `invalid_request` even
 * with a valid token — a second, independent reason this screen could never have shown a live
 * comparison, hidden behind the first one.
 *
 * Forty trials is a coarse sample and the page says so: the widest 95% interval on a proportion
 * over forty trials is about 15 points, which is wider than most of the differences between two
 * columns. That is a real limit of the measurement and printing it is the point.
 */
const COMPARE_TRIALS = MAX_COMPARE_TRIALS;

/**
 * The same spot, played by several profiles.
 *
 * This is a `POST` because the request carries a whole situation rather than an identifier — but
 * it is a *read*: a pure function of the situation, computed from a seeded generator, touching
 * nothing about the caller. So a server render can and does call it.
 *
 * It could not before. The API checks CSRF on every state-changing method, a server render holds
 * no token, and this loader treated `csrf_failed` as an expected answer and rendered a bundled
 * sample instead — a page whose whole subject is "watch four styles disagree about YOUR spot",
 * permanently showing one prepared spot with an explanation attached.
 *
 * `serverCsrfHandshake()` resolves it without relaxing the check and without touching the reader's
 * credentials: the render completes the double-submit handshake for itself and makes an anonymous
 * POST. See that function for why an unauthenticated, side-effect-free POST from our own server is
 * not the request CSRF exists to stop.
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
 * The measurement, or the reason there is not one. Never a stand-in for one.
 *
 * Deliberately not a `LegendData<T>` like everything else in this module, because the fallback
 * this type refuses is the point. The other loaders fall back to bundled sample data because what
 * they carry is *authored material* — trait vectors, disclaimers, counter-strategy — which is
 * equally true offline. A measurement is not authored material: there is no honest bundled value
 * for "what this model did over four thousand hands", and a plausible-looking one is precisely the
 * defect this review raised. So the shape has room for an absence and none for an invention.
 */
export interface ProfileStatsData {
  readonly stats: ProfileStatsResponse | null;
  /** One sentence for the reader. Null exactly when `stats` is present. */
  readonly unavailableReason: string | null;
}

/** What a large deterministic simulation of this model actually did, or why that is not available. */
export async function loadProfileStats(profileId: string): Promise<ProfileStatsData> {
  const result = await safeFetch<ProfileStatsResponse>(() =>
    apiGet<ProfileStatsResponse>(API_PATHS.legendProfileStats(profileId)),
  );
  if (result.ok) return { stats: result.data, unavailableReason: null };
  // A 404 here means the id is not a profile, which the page has already turned into its own
  // not-found screen by this point; anything else that is not an outage is a real fault.
  if (!isMissingResource(result.error) && !isApiUnavailable(result.error)) throw result.error;
  return { stats: null, unavailableReason: `${STATS_FALLBACK} (${result.error.message})` };
}

/**
 * Why one of the reader's own hands could not be shown. Never a reason to show somebody else's.
 *
 * ## The defect this replaced
 *
 * `loadHandComparison(_handId)` used to ignore its argument and return `HAND_COMPARISON_FIXTURE`
 * for every hand id anybody asked for. Its comment said the API "has never registered" a per-hand
 * comparison route, which was true — `buildHandComparison` existed in `@prl/poker-ai` with nothing
 * in front of it. The screen was honest about being a sample and was not the feature.
 *
 * `GET /legends/hands/:handId/comparison` now exists. So this loader makes the request, and every
 * way it can fail is a distinct sentence rather than a fall back to the worked example. The sample
 * still exists and is still worth reading — it is reachable at `/legends/hand-review/demo`, which
 * says demo in the URL. What must never happen again is a reader seeing somebody else's hand while
 * believing they are looking at their own.
 */
export type HandComparisonProblem =
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-comparable'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly detail: string };

export type HandComparisonResult =
  | { readonly ok: true; readonly comparison: HandComparison }
  | { readonly ok: false; readonly problem: HandComparisonProblem };

/** The three states `hand_not_comparable` distinguishes, as sentences. */
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
 * One of the reader's own finished hands, or the reason it cannot be shown.
 *
 * The session travels with the request on a server render — `readerCallOptions` — because the
 * route is scoped to a seat the caller held. Without it the API answers `not_authenticated`, which
 * this reports as `signed-out` rather than as "no such hand": telling a reader their hand does not
 * exist when the truth is that this render had no session is the failure `src/lib/server-session.ts`
 * was written to end.
 */
export async function loadHandComparison(
  handId: string,
  options: ApiCallOptions = {},
): Promise<HandComparisonResult> {
  const result = await safeFetch<HandComparison>(() =>
    apiGet<HandComparison>(API_PATHS.legendHandComparison(handId), {
      ...options,
      // The route prices every action that was not taken, so it is one of the expensive reads.
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

/**
 * The bundled worked example, for the explicit demo route and for nothing else.
 *
 * Reachable only from `/legends/hand-review/demo`. It is not a fallback and must not become one:
 * a reader who asked for their own hand and got this one would have no way to tell.
 */
export function demoHandComparison(): HandComparison {
  return HAND_COMPARISON_FIXTURE;
}

/**
 * Which profiles the compare page opens with when the URL names none.
 *
 * Three styles that genuinely disagree, not the first three in the list: a comparison whose
 * columns all say the same thing teaches the opposite of what this page is for.
 */
export const DEFAULT_COMPARE_PROFILE_IDS: readonly string[] = [
  'reading-pressure-specialist',
  'patient-technician',
  'disciplined-specialist',
];

/** Kept for the compare page's picker, which offers only profiles it can actually name. */
export function profileLabel(profileId: string): string {
  return profileFixtureById(profileId)?.disclosure.archetypeName ?? profileId;
}
