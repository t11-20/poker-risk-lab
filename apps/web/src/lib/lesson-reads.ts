/**
 * Recording that a learner finished a lesson, and saying only what was actually recorded.
 *
 * ## Why this exists
 *
 * The release audit's PROD-028: `upsertLessonProgress` had no caller outside its own test, so
 * `lessonsCompleted` in `GET /me/progress` was structurally incapable of being anything but zero
 * and `/record` rendered a column of noughts that no action in the product could move. The route
 * (`POST /content/lessons/:id/read`) exists now; this module is the client half, and
 * `API_PATHS.lessonRead` is called from here and nowhere else.
 *
 * This mirrors `quiz-attempts.ts` deliberately — same shape of outcome union, same "the server's
 * answer is the one displayed" rule, same failure-as-a-value — because the two are the same job on
 * two endpoints and two different shapes of it would be two places to get the honesty wrong.
 *
 * ## Completion is claimed by the learner, never inferred from a fetch
 *
 * Nothing here runs on page load. `GET /content/lessons/:id` cannot tell a genuine read from a
 * prefetch, a crawler or a back-button, and progress that fills itself in describes nobody — so the
 * only thing that produces this call is a press on the control at the end of the lesson. See
 * `components/LessonRead.tsx` for what "the end" means on that screen.
 *
 * ## `completedAt: null` means nothing was stored, and the screen has to say so
 *
 * The route answers 200 to a reader with no session and stores nothing, exactly like the
 * quiz-attempt route: the app is guest-first and a client's success path must not depend on whether
 * somebody happens to be signed in. The reply is the server's own state rather than an echo of the
 * request, so the difference is visible — this module always posts `completed: true`, and after
 * that a null `completedAt` can only mean there was no row to write it to. `outcomeFor` turns that
 * into `'anonymous'`, which is a distinct state from `'recorded'` precisely so no sentence on the
 * screen can claim a record the learner does not have.
 *
 * ## Nothing here counts anything
 *
 * No tally, no streak, no "3 of 17". One lesson, one boolean, one row. The only figure derived from
 * those rows is a count of distinct finished lessons, and it is derived in the database, shown on
 * `/record`, and never computed here. See `docs/PRODUCT-GUARDRAILS.md`.
 */

import type { ContentId, LessonReadRequest, LessonReadResponse } from '@prl/contracts';
import { API_PATHS, apiSend, fetchSession, safeFetch } from './api.ts';

/**
 * What the server holds for this lesson, as far as this screen knows.
 *
 * `'idle'` is "the learner has not said they finished it", which is distinct from `'anonymous'` —
 * one is a read that has not been claimed, the other is a claim that could not be stored, and a
 * screen that ran them together would either nag a learner who already pressed the button or thank
 * one whose press went nowhere.
 */
export type LessonReadOutcome =
  | { readonly state: 'idle' }
  | { readonly state: 'pending' }
  /** Stored. `completedAt` is the server's timestamp, not this browser's clock. */
  | { readonly state: 'recorded'; readonly completedAt: string }
  /** The call succeeded and stored nothing: there is no session to attach a read to. */
  | { readonly state: 'anonymous' }
  /** The call could not be made or was refused. Nothing was stored. */
  | { readonly state: 'unavailable' };

/** Every state the note below has a sentence for. */
export type LessonReadState = LessonReadOutcome['state'];

/**
 * The one body this client ever sends.
 *
 * `completed: false` is a legitimate value on the wire — it records a lesson opened without
 * claiming it was finished — and this client deliberately never sends it. The only act that
 * produces a request is the learner saying they reached the end, and posting `false` on page load
 * would be inferring a view from a fetch, which is the defect the route's own doc comment refuses.
 * Frozen because it is shared by every call rather than rebuilt per press.
 */
export const LESSON_READ_BODY: LessonReadRequest = Object.freeze({ completed: true });

/**
 * The server's reply, as a state this screen can render.
 *
 * The whole function is the `completedAt === null` branch, and it is the honesty of this feature:
 * this client only ever posts `completed: true`, so a null completion in the reply cannot mean "not
 * finished yet" — it can only mean the route had no user to write a row for. Returning `'recorded'`
 * regardless would put a tick on the screen for every signed-out reader and a zero on `/record`.
 */
export function outcomeFor(response: LessonReadResponse): LessonReadOutcome {
  if (response.completedAt === null) return { state: 'anonymous' };
  return { state: 'recorded', completedAt: response.completedAt };
}

/**
 * Posts one finished lesson and returns what the server holds afterwards.
 *
 * Two calls, in this order, and the first is not optional: the API requires the double-submit CSRF
 * token on every mutation and the token comes from the session read. A signed-out reader is issued
 * one too, so their press still reaches the route and still gets an honest answer back — it is
 * simply not attributed to anybody, which `callerUserId` in the API's content routes already
 * handles.
 *
 * Sent from the browser, never from a render: a server render holds neither the token nor the
 * cookie paired with it, and forwarding a reader's CSRF secret into a server-side POST is the
 * forgery the check exists to stop.
 *
 * A failure is a value rather than a throw, for the same reason as in `quiz-attempts.ts`: every
 * failure mode here — signed out, offline, rate limited, a lesson id this deployment does not carry
 * — is an ordinary state of the screen, and none of them should take a lesson someone is reading
 * down with them.
 */
export async function submitLessonRead(
  lessonId: ContentId,
  signal?: AbortSignal,
): Promise<LessonReadOutcome> {
  const options = signal === undefined ? {} : { signal };
  const session = await fetchSession(options);
  const token = session.ok ? session.data.csrfToken : null;
  if (token === null) return { state: 'unavailable' };

  const recorded = await safeFetch<LessonReadResponse>(() =>
    apiSend<LessonReadResponse>('POST', API_PATHS.lessonRead(lessonId), LESSON_READ_BODY, {
      ...options,
      csrfToken: token,
    }),
  );
  if (!recorded.ok) return { state: 'unavailable' };
  return outcomeFor(recorded.data);
}

/**
 * What the screen says about the press, and it never says more than happened.
 *
 * A function rather than a lookup table because the sentence for a failure has to name the failure
 * — "nothing was recorded" is the load-bearing half of it — and a table of five strings that three
 * screens interpolate differently is three chances to drop that half. `'idle'` is the empty string
 * on purpose: the live region is in the DOM from the first render (see `LessonRead.tsx`) and there
 * is nothing to announce until the learner has done something.
 */
export function lessonReadNote(outcome: LessonReadOutcome): string {
  switch (outcome.state) {
    case 'idle':
      return '';
    case 'pending':
      return 'Recording that you finished this lesson…';
    case 'recorded':
      return (
        'Recorded. This lesson is now one of the lessons finished on your record. Marking it again ' +
        'changes nothing — finishing a lesson is permanent, and re-reading it does not un-finish it.'
      );
    case 'anonymous':
      return (
        'Nothing was recorded, because there is no session to attach it to. A record belongs to one ' +
        'learner, and this browser is not carrying one — opening a table creates a guest session in ' +
        'one request, with no email and no password, and everything you do from then on is counted.'
      );
    case 'unavailable':
      return (
        'The server could not be reached, so nothing was recorded. Nothing else about this lesson ' +
        'changed, and pressing the button again is safe.'
      );
  }
}
