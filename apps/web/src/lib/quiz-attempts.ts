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
 * ## …and "recorded" is a fact the server has to send, not one this client may assume
 *
 * A second defect, found in a browser-level journey verification and fixed here. The route answers
 * 200 to a signed-out learner and stores nothing — which is the product's DEFAULT state, since
 * nothing creates a session until a table is opened — and the reply carried no signal at all about
 * whether a row had been written. So `state: 'live'` meant only "the call succeeded", the panel
 * read that as "recorded", and every anonymous learner was told the server had recorded a question
 * they had answered while `prl.quiz_attempts` held nothing of theirs and `GET /me/progress`
 * answered them `401 not_authenticated`.
 *
 * `QuizAttemptResponse.recorded` is that signal, and it splits the graded outcome into `'live'` and
 * `'anonymous'` below. `lesson-reads.ts` already used exactly this shape for exactly this problem
 * on the sibling route, and the two are deliberately the same shape: two different answers to "was
 * anything stored?" would be two places to get the honesty wrong.
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
 * The server's comparison, on its own — everything that is true of the answer whether or not it
 * was kept.
 *
 * Split out because both graded states below carry exactly this and nothing about the grading
 * differs between them. A signed-out learner's answer is graded by the same code, against the same
 * figure, and the explanation they read is the same one; the only difference is that no row exists
 * afterwards, and that belongs in the state rather than in the grading.
 */
export interface GradedAnswer {
  readonly correct: boolean;
  readonly explanation: string;
  /** Numeric questions only: the value the server computed and graded against. */
  readonly expected: { readonly value: number; readonly unit: string; readonly tolerance: number } | null;
}

/**
 * What the server said about one answer, and whether it kept it.
 *
 * `'idle'` is "nothing has been answered yet", which is distinct from `'pending'` — a screen that
 * showed "asking the server" before the learner had answered anything would be describing a request
 * that does not exist.
 *
 * `'live'` and `'anonymous'` are the same two states `lesson-reads.ts` calls `'recorded'` and
 * `'anonymous'`, and they exist here for the same reason: the route answers 200 and stores nothing
 * for a signed-out learner — which is the product's default state, since nothing creates a session
 * until a table is opened — and until `QuizAttemptResponse.recorded` existed this client could not
 * tell the two apart. It said the server had recorded the question either way. Two states rather
 * than a boolean on one, so that no screen can read `state === 'live'` and mean "graded": the
 * grading is `gradedAnswer`, and the recording is the state.
 */
export type QuizVerdict =
  | { readonly state: 'idle' }
  | { readonly state: 'pending' }
  /** The call could not be made or was refused. Nothing was recorded. */
  | { readonly state: 'unavailable' }
  /** Graded by the server, and stored as one of the questions this learner has answered. */
  | ({ readonly state: 'live' } & GradedAnswer)
  /** Graded by the server, and stored nowhere: there is no session to attach an attempt to. */
  | ({ readonly state: 'anonymous' } & GradedAnswer);

/**
 * The server's comparison when there was one, whichever graded state it arrived in.
 *
 * The reason this is a function and not two `state ===` checks at each call site: a reader who
 * wants "did the server answer?" writes `state === 'live'`, which was the only graded state until
 * now and is now the *recorded* one. Every such check would silently start treating a signed-out
 * learner as an outage — falling back to the browser's own figure while the server's sat unread.
 */
export function gradedAnswer(verdict: QuizVerdict): GradedAnswer | null {
  if (verdict.state === 'live' || verdict.state === 'anonymous') return verdict;
  return null;
}

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
 * The server's reply, as a state this screen can render.
 *
 * Exported, and a function of the reply alone, for the same reason `outcomeFor` is in
 * `lesson-reads.ts`: it is the whole of the honesty in this file, and a mapping buried inside a
 * function that needs `fetch`, a CSRF round trip and a running API is a mapping nothing tests.
 *
 * The `recorded` branch is the point. This client cannot see the session cookie — it is
 * `HttpOnly` — so "am I signed in?" is not a question it can answer, and inferring it from a
 * `GET /auth/session` read a moment earlier would be describing a different request than the one
 * that was just graded. The server says whether the row exists, and this reads what it said.
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
  return verdictFor(attempt.data);
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
): { readonly matched: boolean; readonly source: VerdictSource } {
  if (verdict.state === 'live') return { matched: verdict.correct, source: 'server' };
  // Graded by the server exactly as `'live'` was, so its comparison is still the one shown — the
  // difference is only what the sentence beside it is allowed to claim.
  if (verdict.state === 'anonymous') return { matched: verdict.correct, source: 'anonymous' };
  if (verdict.state === 'pending') return { matched: local, source: 'pending' };
  return { matched: local, source: 'local' };
}

/** Who made the comparison on screen, and what became of it. One sentence each, below. */
export type VerdictSource = 'server' | 'anonymous' | 'local' | 'pending';

/**
 * What the screen says about where its verdict came from. Never claims a recording that failed.
 *
 * `anonymous` is the sentence this table was missing. The server graded the answer and stored
 * nothing, and for the whole of that case the screen said what `server` says — "the one it recorded
 * as a question you have answered" — about a row that was never written. It is the sibling
 * sentence in `lessonReadNote`, phrased for an answer rather than a lesson: what happened, why
 * nothing was kept, and what a learner who wants it kept would do, in that order.
 *
 * It says it once, where it matters, and only when it applies. There is no banner, no badge on the
 * question and no prompt before answering: the app is guest-first on purpose, a quiz is worth
 * doing without an account, and a standing reminder that answers do not count is a nag that
 * teaches nothing.
 */
export const VERDICT_SOURCE_NOTE: Readonly<Record<VerdictSource, string>> = {
  server:
    'This is the server’s own comparison, made against a figure it computed when you answered — and the one it recorded as a question you have answered.',
  anonymous:
    'This is the server’s own comparison, made against a figure it computed when you answered. Nothing was recorded, because there is no session to attach it to — answers count towards your record once this browser is carrying one, and opening a table creates a guest session in one request, with no email and no password.',
  pending: 'Asking the server for its comparison. What is shown is the same comparison made in your browser.',
  local:
    'The server could not be reached, so this comparison was made in your browser and nothing was recorded. It is the same comparison the server makes.',
};
