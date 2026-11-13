/**
 * The learner's own record from `GET /me/progress`, and what `/record` may claim about it.
 * Counted, never scored (`routes/progress.ts`). Nothing here divides a count into a percentage or
 * compares readings into a trend, and `unitsNetLifetime` keeps its sign. `loadRecord` reports a
 * missing session as its own state, not an outage.
 */

import { API_PATHS, type ProgressResponse } from '@prl/contracts';
import { apiGet, isApiUnavailable, isSignedOut, safeFetch } from './api.ts';

export const RECORD_PATH = '/record';

/** Fixed order, reading to table play. Never sorted by size, which would make a leaderboard of one. */
export type RecordFigureName =
  | 'lessonsCompleted'
  | 'scenariosAttempted'
  | 'quizQuestionsAnswered'
  | 'handsPlayed'
  | 'unitsNetLifetime';

export const RECORD_FIGURES: readonly RecordFigureName[] = [
  'lessonsCompleted',
  'scenariosAttempted',
  'quizQuestionsAnswered',
  'handsPlayed',
  'unitsNetLifetime',
];

export const RECORD_LABELS: Readonly<Record<RecordFigureName, string>> = {
  lessonsCompleted: 'Lessons finished',
  scenariosAttempted: 'Scenarios tried',
  quizQuestionsAnswered: 'Quiz questions answered',
  handsPlayed: 'Hands played',
  unitsNetLifetime: 'Units, net, all time',
};

/** What was actually counted. Each sentence is the definition, not a description of the label. */
export const RECORD_EXPLANATIONS: Readonly<Record<RecordFigureName, string>> = {
  lessonsCompleted:
    'Lessons you reached the end of. Opening one is not finishing it, and finishing one is permanent — re-reading it does not un-finish it.',
  scenariosAttempted:
    'Scenarios you committed an action in, counted once each however many times you went back to them.',
  quizQuestionsAnswered:
    'Different questions you have answered, right or wrong. Answering one question five times is one question answered, and whether it matched does not appear in this figure at all.',
  handsPlayed:
    'Seats you held in hands that finished. A hand still in progress has not been played yet, which is also why it contributes nothing to the figure below.',
  unitsNetLifetime:
    'The sum of your per-hand results in free practice units. This is not a balance — nothing in Poker Risk Lab holds money or a balance — and it is as likely to be negative as positive. That is what variance looks like.',
};

export type RecordState =
  | { readonly state: 'ready'; readonly progress: ProgressResponse }
  /** No session. The page says so and offers the way to get one, rather than showing zeroes. */
  | { readonly state: 'signedOut' }
  /** The service could not be reached. Zeroes here would be a lie about a real record. */
  | { readonly state: 'unavailable'; readonly reason: string };

/**
 * No fixture fallback, unlike every other read here, because a sample record would be invented history
 * under the reader's name. `options` comes from `lib/server-session.ts`.
 */
export async function loadRecord(options: Parameters<typeof apiGet>[1] = {}): Promise<RecordState> {
  const result = await safeFetch<ProgressResponse>(() =>
    apiGet<ProgressResponse>(API_PATHS.progress(), options),
  );
  if (result.ok) return { state: 'ready', progress: result.data };
  if (isSignedOut(result.error)) return { state: 'signedOut' };
  if (isApiUnavailable(result.error)) return { state: 'unavailable', reason: result.error.message };
  // A 404 or 500 is a defect, not a fact about the reader, so it is not folded into a state.
  throw result.error;
}
