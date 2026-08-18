/**
 * Sending a quiz answer to the server, and holding on to what it said.
 *
 * ## Why this exists
 *
 * `QuizRunner` graded every answer in the browser and sent nothing. `API_PATHS.quizAttempt` was the
 * only entry in the whole path table with no call site anywhere in this client, so
 * `prl.quiz_attempts` stayed empty and `quizQuestionsAnswered` in `GET /me/progress` was structurally
 * incapable of being anything but zero. A learner could work through all seventeen quizzes and the
 * product would have no idea they had been here.
 *
 * ## The verdict shown is the verdict recorded
 *
 * The same rule `ScenarioStage` follows, for the same reason: the server grades and stores, so if
 * the screen showed its own answer instead, the two could disagree and the learner would be looking
 * at the one that was thrown away. When the call succeeds, `state: 'live'` carries the server's
 * boolean and the screen uses it. When it does not, the screen keeps its local comparison and says
 * so — an outage is not a reason to replace a working quiz with an error, and it is not a reason to
 * pretend something was recorded either.
 *
 * That is also why a failure is a value here rather than a throw. Every failure mode of this call is
 * an ordinary state of the screen: signed out, offline, rate limited, a quiz id the deployment does
 * not carry. None of them should take a lesson down with them.
 *
 * ## What is deliberately not sent
 *
 * A `decision` question. It has no recorded answer anywhere in the contract — see the note on
 * `DecisionQuestion` in `QuizRunner.tsx` — so there is nothing to grade and `attemptBodyFor`
 * returns null rather than inventing an action the learner never chose. Revealing the reasoning is
 * not an attempt.
 *
 * ## Nothing here counts anything
 *
 * No tally, no score, no streak. The server stores one append-only row per answered question and
 * derives a count of DISTINCT questions from it; this module posts one row and reads back one
 * boolean about one answer. See `docs/PRODUCT-GUARDRAILS.md`.
 */

import type { ContentId, QuizAttemptRequest, QuizAttemptResponse, QuizQuestion } from '@prl/contracts';
import { API_PATHS, apiSend, fetchSession, safeFetch } from './api.ts';

/**
 * What the learner did, as this client models it.
 *
 * Defined here rather than in the component because it is half of the mapping below, and a shape
 * that lives next to the component that renders it drifts away from the wire type it has to become.
 * `raw` is the text as typed and never leaves the browser: the wire type carries a number, and
 * sending the string as well would be sending the same fact twice in two formats.
 */
export type QuizAnswer =
  | { readonly kind: 'choice'; readonly index: number }
  | { readonly kind: 'number'; readonly value: number; readonly raw: string }
  | { readonly kind: 'revealed' };

/**
 * What the server said about one answer.
 *
 * `'idle'` is "nothing has been answered yet", which is distinct from `'pending'` — a screen that
 * showed "asking the server" before the learner had answered anything would be describing a request
 * that does not exist.
 */
export type QuizVerdict =
  | { readonly state: 'idle' }
  | { readonly state: 'pending' }
  /** The call could not be made or was refused. Nothing was recorded. */
  | { readonly state: 'unavailable' }
  | {
      readonly state: 'live';
      readonly correct: boolean;
      readonly explanation: string;
      /** Numeric questions only: the value the server computed and graded against. */
      readonly expected: { readonly value: number; readonly unit: string; readonly tolerance: number } | null;
    };

/**
 * The request body for an answer, or null when this answer is not something the server grades.
 *
 * Null has exactly two causes and both are correct outcomes rather than errors:
 *
 *  - a `decision` question, which has no recorded answer (see the module comment);
 *  - a `revealed` answer, which records that the learner asked to see the reasoning. That is not an
 *    attempt at anything and posting it would put a row in `prl.quiz_attempts` claiming the learner
 *    answered a question they explicitly declined to answer.
 *
 * The question is passed as well as the answer so the two are checked against each other: a
 * `choice` answer against a `numeric` question is a bug in the caller, and sending it would be
 * answered `invalid_request` by the server after the fact instead of never being built.
 */
export function attemptBodyFor(question: QuizQuestion, answer: QuizAnswer): QuizAttemptRequest | null {
  if (question.kind === 'multipleChoice' && answer.kind === 'choice') {
    return { questionId: question.id, answer: { kind: 'choice', index: answer.index } };
  }
  if (question.kind === 'numeric' && answer.kind === 'number') {
    // Guarded here rather than at the input, because this is the last place the value is a number
    // before it becomes JSON: `JSON.stringify(NaN)` is `null`, which the server's schema refuses
    // with a field error about a type the learner never typed.
    if (!Number.isFinite(answer.value)) return null;
    return { questionId: question.id, answer: { kind: 'number', value: answer.value } };
  }
  return null;
}

/**
 * Posts one answer and returns what came back.
 *
 * Two calls, in this order, and the first one is not optional: the API requires the double-submit
 * CSRF token on every mutation and the token comes from the session read. A signed-out reader gets
 * a token too — `GET /auth/session` issues one to anybody — so an anonymous learner's answer is
 * still graded; it is simply not attributed to a user, which is what `callerUserId` in the API's
 * content routes already handles.
 *
 * Sent from the browser, never from a render: a server render holds neither the token nor the
 * cookie paired with it, and forwarding a reader's CSRF secret into a server-side POST is the
 * forgery the check exists to stop.
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
  return {
    state: 'live',
    correct: attempt.data.correct,
    explanation: attempt.data.explanation,
    expected: attempt.data.expected ?? null,
  };
}

/**
 * Whether the answer matched, and who says so.
 *
 * One function rather than a ternary at each of the two call sites, because the rule — the server
 * wins when it answered, the local comparison stands in when it did not — is the same rule for
 * multiple choice and for numeric, and two copies of it is two places for the precedence to be got
 * backwards. `source` is returned rather than inferred by the caller so the sentence beside the
 * verdict cannot claim the server said something it did not.
 */
export function resolvedVerdict(
  verdict: QuizVerdict,
  local: boolean,
): { readonly matched: boolean; readonly source: 'server' | 'local' | 'pending' } {
  if (verdict.state === 'live') return { matched: verdict.correct, source: 'server' };
  if (verdict.state === 'pending') return { matched: local, source: 'pending' };
  return { matched: local, source: 'local' };
}

/** What the screen says about where its verdict came from. Never claims a recording that failed. */
export const VERDICT_SOURCE_NOTE: Readonly<Record<'server' | 'local' | 'pending', string>> = {
  server:
    'This is the server’s own comparison, made against a figure it computed when you answered — and the one it recorded as a question you have answered.',
  pending: 'Asking the server for its comparison. What is shown is the same comparison made in your browser.',
  local:
    'The server could not be reached, so this comparison was made in your browser and nothing was recorded. It is the same comparison the server makes.',
};
