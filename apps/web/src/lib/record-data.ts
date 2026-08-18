/**
 * The learner's own record: what `GET /me/progress` says, and what `/record` may claim about it.
 *
 * ## Why this exists
 *
 * `GET /me/progress` has always worked. It was in no client: not in `API_PATHS`, not called from
 * anywhere in `apps/web`, so no figure it produces had ever been shown to the learner it was about.
 * Two of its figures were structurally incapable of being non-zero as well — nothing submitted a
 * quiz attempt and nothing wrote lesson completion — so the endpoint was a query nobody ran over
 * tables nobody filled.
 *
 * ## Counted, never scored — and that constrains this module, not just the page
 *
 * The API's own header on `routes/progress.ts` sets the rule: every figure answers "how much have
 * you looked at", never "how well did you do". There is no rank, no streak, no level, no percentage
 * complete, and the response type has no field capable of expressing one. This module must not
 * manufacture what the wire refuses to carry, so:
 *
 *  - nothing here divides a count by a total to produce a percentage;
 *  - nothing here compares two readings of the same figure to produce a trend;
 *  - `unitsNetLifetime` is passed through with its sign intact and is never rendered as a "score".
 *    It is as likely to be negative as positive, which is the honest shape of a variance lesson.
 *
 * `LABELS` and `EXPLANATIONS` below are the whole of what this module adds: a sentence per figure
 * saying exactly what was counted. A number a reader cannot interpret is a number they will
 * interpret wrongly, and "hands played" in particular means something specific — seats held in
 * hands that FINISHED.
 *
 * ## Signed out is not an error
 *
 * The endpoint answers `not_authenticated` to an anonymous reader, correctly: progress belongs to
 * one learner and there is no anonymous view of it. `loadRecord` reports that as its own state so
 * the page can explain it, rather than as an outage or a crash.
 */

import type { ProgressResponse } from '@prl/contracts';
import { apiGet, isApiUnavailable, isSignedOut, safeFetch } from './api.ts';
import { UNPUBLISHED_API_PATHS } from './unpublished-api-paths.ts';

export const RECORD_PATH = '/record';

/**
 * The four figures, plus the two lists, in the order the page shows them.
 *
 * Ordered from "what you read" to "what happened at a table", which is the order the product's own
 * argument runs in. Not ordered by size, and not sorted at render time: a list that reorders itself
 * as the figures change is a leaderboard of one.
 */
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
    'The sum of your per-hand results in free practice units. This is not a balance — there is no balance column anywhere in this product — and it is as likely to be negative as positive. That is what variance looks like.',
};

/** The record, as a value, with the reasons it might not be here. */
export type RecordState =
  | { readonly state: 'ready'; readonly progress: ProgressResponse }
  /** No session. The page says so and offers the way to get one, rather than showing zeroes. */
  | { readonly state: 'signedOut' }
  /** The service could not be reached. Zeroes here would be a lie about a real record. */
  | { readonly state: 'unavailable'; readonly reason: string };

/**
 * Reads the record for whoever this request is from.
 *
 * Deliberately has no fixture fallback, which every other read in this client has. A bundled
 * "sample record" would be somebody's invented history rendered on a page headed with the reader's
 * own name for it, and there is no notice loud enough to make that a good idea. The three states
 * above are the whole set: it is here, you are not signed in, or it could not be fetched.
 *
 * `options` carries the reader's session cookie on a server render — see `lib/server-session.ts`,
 * which is the only supported producer of it.
 */
export async function loadRecord(options: Parameters<typeof apiGet>[1] = {}): Promise<RecordState> {
  const result = await safeFetch<ProgressResponse>(() =>
    apiGet<ProgressResponse>(UNPUBLISHED_API_PATHS.progress(), options),
  );
  if (result.ok) return { state: 'ready', progress: result.data };
  if (isSignedOut(result.error)) return { state: 'signedOut' };
  if (isApiUnavailable(result.error)) return { state: 'unavailable', reason: result.error.message };
  // Anything else — a 404 on a path this client built, a 500 — is a defect rather than a fact about
  // the reader, and `isApiUnavailable` deliberately does not swallow a 404 into a quiet fallback.
  throw result.error;
}
