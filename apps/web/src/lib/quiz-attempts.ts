/**
 * Sends a quiz answer to the server and holds what it said. The verdict shown is the verdict the
 * server graded. A failure is a value, never a throw, so an outage cannot take a lesson down.
 * The route answers 200 to a signed-out learner and stores nothing, so whether anything was recorded
 * comes only from `QuizAttemptResponse.recorded`, in the same shape as `lesson-reads.ts`.
 * A `decision` question has no recorded answer in the contract, so it is never sent.
 */

import type { ContentId, QuizAttemptRequest, QuizAttemptResponse, QuizQuestion } from '@prl/contracts';
import { API_PATHS, apiSend, fetchSession, safeFetch } from './api.ts';

/** `raw` is the text as typed and never leaves the browser. The wire type carries the number. */
export type QuizAnswer =
  | { readonly kind: 'choice'; readonly index: number }
  | { readonly kind: 'number'; readonly value: number; readonly raw: string }
  | { readonly kind: 'revealed' };

/** The server's comparison, identical for a recorded and an anonymous answer. */
export interface GradedAnswer {
  readonly correct: boolean;
  readonly explanation: string;
  readonly expected: { readonly value: number; readonly unit: string; readonly tolerance: number } | null;
}

/**
 * `'idle'` means nothing has been answered, which is distinct from `'pending'`.
 * `'live'` is graded and recorded, `'anonymous'` is graded and stored nowhere. Two states rather
 * than a boolean, so that the recording is the state and the grading is `gradedAnswer`.
 */
export type QuizVerdict =
  | { readonly state: 'idle' }
  | { readonly state: 'pending' }
  | { readonly state: 'unavailable' }
  | ({ readonly state: 'live' } & GradedAnswer)
  | ({ readonly state: 'anonymous' } & GradedAnswer);

/**
 * Use this rather than `state === 'live'`, which now means recorded and would treat a signed-out
 * learner as an outage.
 */
export function gradedAnswer(verdict: QuizVerdict): GradedAnswer | null {
  if (verdict.state === 'live' || verdict.state === 'anonymous') return verdict;
  return null;
}

/**
 * Null for a `decision` question (no recorded answer) and for a `revealed` answer, which would record
 * an answer the learner declined to give. A mismatched question and answer kind is never built.
 */
export function attemptBodyFor(question: QuizQuestion, answer: QuizAnswer): QuizAttemptRequest | null {
  if (question.kind === 'multipleChoice' && answer.kind === 'choice') {
    return { questionId: question.id, answer: { kind: 'choice', index: answer.index } };
  }
  if (question.kind === 'numeric' && answer.kind === 'number') {
    // `JSON.stringify(NaN)` is `null`, which the server refuses with a confusing field error.
    if (!Number.isFinite(answer.value)) return null;
    return { questionId: question.id, answer: { kind: 'number', value: answer.value } };
  }
  return null;
}

/**
 * Exported and pure so the mapping is testable, like `outcomeFor` in `lesson-reads.ts`.
 * The session cookie is `HttpOnly`, so only the server can say whether the row exists.
 */
export function verdictFor(response: QuizAttemptResponse): QuizVerdict {
  return {
    state: response.recorded ? 'live' : 'anonymous',
    correct: response.correct,
    explanation: response.explanation,
    expected: response.expected ?? null,
  };
}

/**
 * The session read comes first because every mutation needs its double-submit CSRF token, which
 * `GET /auth/session` issues to anybody. Sent from the browser only, because a server render holds
 * neither the token nor its paired cookie.
 */
export async function submitQuizAttempt(
  quizId: ContentId,
  body: QuizAttemptRequest,
  signal?: AbortSignal,
): Promise<QuizVerdict> {
  const options = signal === undefined ? {} : { signal };
  const session = await fetchSession(options);
  const token = session.ok ? session.data.csrfToken : null;
  if (token === null) return { state: 'unavailable' };

  const attempt = await safeFetch<QuizAttemptResponse>(() =>
    apiSend<QuizAttemptResponse>('POST', API_PATHS.quizAttempt(quizId), body, {
      ...options,
      csrfToken: token,
    }),
  );
  if (!attempt.ok) return { state: 'unavailable' };
  return verdictFor(attempt.data);
}

/** One function, so the precedence (server first, then the local comparison) cannot be inverted. */
export function resolvedVerdict(
  verdict: QuizVerdict,
  local: boolean,
): { readonly matched: boolean; readonly source: VerdictSource } {
  if (verdict.state === 'live') return { matched: verdict.correct, source: 'server' };
  // Graded exactly as `'live'` was. Only what the sentence beside it may claim differs.
  if (verdict.state === 'anonymous') return { matched: verdict.correct, source: 'anonymous' };
  if (verdict.state === 'pending') return { matched: local, source: 'pending' };
  return { matched: local, source: 'local' };
}

export type VerdictSource = 'server' | 'anonymous' | 'local' | 'pending';

/**
 * Never claims a recording that did not happen. Said once, beside the verdict, with no banner or
 * prompt, because the app is guest-first on purpose.
 */
export const VERDICT_SOURCE_NOTE: Readonly<Record<VerdictSource, string>> = {
  server: 'Recorded on your record as a question you have answered.',
  anonymous:
    'Nothing was recorded, because this browser has no guest session to keep it on. Answers count towards your record once it has one — opening a table starts a guest session straight away, with no email and no password.',
  pending: 'Checking your answer. What is shown was worked out in your browser, the same way.',
  local:
    'Your answer could not be sent, so this was worked out in your browser and nothing was recorded. It is the same comparison either way.',
};
