/**
 * Records that a learner finished a lesson, and says only what was recorded. Mirrors
 * `quiz-attempts.ts` in shape and in its failure-as-a-value rule. Only a press on the control at the
 * end of a lesson posts, never a page load. The route answers 200 and stores nothing without a
 * session, so a null `completedAt` in the reply means `'anonymous'`.
 */

import type { ContentId, LessonReadRequest, LessonReadResponse } from '@prl/contracts';
import { API_PATHS, apiSend, fetchSession, safeFetch } from './api.ts';

/** `'idle'` (not claimed) is distinct from `'anonymous'` (claimed but not stored). */
export type LessonReadOutcome =
  | { readonly state: 'idle' }
  | { readonly state: 'pending' }
  /** `completedAt` is the server's timestamp, not this browser's clock. */
  | { readonly state: 'recorded'; readonly completedAt: string }
  /** There is no session to attach a read to. */
  | { readonly state: 'anonymous' }
  | { readonly state: 'unavailable' };

export type LessonReadState = LessonReadOutcome['state'];

/** `completed: false` is valid on the wire, and this client never sends it. */
export const LESSON_READ_BODY: LessonReadRequest = Object.freeze({ completed: true });

/** This client only posts `completed: true`, so a null completion means no user to write a row for. */
export function outcomeFor(response: LessonReadResponse): LessonReadOutcome {
  if (response.completedAt === null) return { state: 'anonymous' };
  return { state: 'recorded', completedAt: response.completedAt };
}

/**
 * The session read comes first because every mutation needs its double-submit CSRF token, which a
 * signed-out reader is issued too. Sent from the browser only, because a server render holds
 * neither the token nor its paired cookie.
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
 * A function so each failure sentence keeps "nothing was recorded". `'idle'` is empty because the
 * live region is in the DOM from the first render.
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
        'Nothing was recorded, because this browser has no guest session to keep it on. A record ' +
        'belongs to one learner — opening a table starts a guest session straight away, with no email ' +
        'and no password, and everything you do from then on is counted.'
      );
    case 'unavailable':
      return (
        'That could not be sent, so nothing was recorded. Nothing else about this lesson ' +
        'changed, and pressing the button again is safe.'
      );
  }
}
