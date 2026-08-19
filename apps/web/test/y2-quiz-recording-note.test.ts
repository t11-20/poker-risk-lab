/**
 * The sentence under a quiz verdict may not claim a recording that did not happen.
 *
 * ## What went wrong
 *
 * `POST /content/quizzes/:id/attempt` answers 200 to a caller with no session and stores nothing —
 * deliberately, because the app is guest-first — and a signed-out learner is this product's
 * DEFAULT state, since nothing creates a session until somebody opens a table. The reply carried
 * no signal about attribution, so `submitQuizAttempt` mapped every success to `state: 'live'` and
 * the panel printed the one sentence reserved for a stored answer:
 *
 *   > …and the one it recorded as a question you have answered.
 *
 * `prl.quiz_attempts` held nothing of theirs, and `GET /me/progress` answered them
 * `401 not_authenticated`. The module comment on `quiz-attempts.ts` claimed it "never claims a
 * recording that failed", which was true of an outage and false of the ordinary case.
 *
 * ## What is asserted
 *
 * The mapping, and the sentences. Both matter, and the second is the one a refactor loses: a state
 * union that distinguishes the two outcomes buys nothing if both states print the same string, so
 * the strings are checked for the claim they must not make as well as for the state they must
 * describe. The wording is deliberately NOT pinned word for word — that would make this a
 * change-detector — only the claims are: which sentences may say "recorded" as something that
 * happened, and which must say that nothing was.
 *
 * `lesson-reads.ts` is the sibling that already got this right, and it is read here rather than
 * described, so the two cannot drift into two different answers to the same question.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { QuizAttemptResponse } from '@prl/contracts';
import { lessonReadNote } from '../src/lib/lesson-reads.ts';
import {
  gradedAnswer,
  resolvedVerdict,
  VERDICT_SOURCE_NOTE,
  type VerdictSource,
  verdictFor,
} from '../src/lib/quiz-attempts.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * The real mapping `submitQuizAttempt` uses, driven without the two fetches around it.
 *
 * `verdictFor` is exported for exactly this — the same way `lesson-reads.ts` exports `outcomeFor`
 * — so the conditional that decides what the screen may claim is tested rather than re-described.
 * `y2-quiz-attempt-recording.test.ts` in `apps/api` drives the route that produces the reply.
 */
const GRADED: Omit<QuizAttemptResponse, 'recorded'> = {
  correct: true,
  explanation: 'Because the pot lays 3 to 1.',
  expected: { value: 25, unit: 'percent', tolerance: 2 },
};

describe('a reply that stored nothing becomes a verdict that says so', () => {
  it('is anonymous when the server did not record it, and live when it did', () => {
    assert.equal(verdictFor({ ...GRADED, recorded: false }).state, 'anonymous');
    assert.equal(verdictFor({ ...GRADED, recorded: true }).state, 'live');
  });

  it('keeps the server’s own comparison in both, because both were graded by the server', () => {
    // The defect this guards against is the natural over-correction: treating "not recorded" as a
    // failure and falling back to the browser's comparison. The server graded it either way, and
    // its answer is the one that must be shown.
    const anonymous = verdictFor({ ...GRADED, correct: false, recorded: false });
    assert.deepEqual(resolvedVerdict(anonymous, true), { matched: false, source: 'anonymous' });

    const recorded = verdictFor({ ...GRADED, correct: false, recorded: true });
    assert.deepEqual(resolvedVerdict(recorded, true), { matched: false, source: 'server' });
  });

  it('exposes the graded figure for an anonymous answer, not only for a recorded one', () => {
    // `QuizRunner` shows the value the comparison was made against. A `state === 'live'` test there
    // would silently show a signed-out learner the browser's figure while the server's sat unread.
    for (const recorded of [true, false]) {
      const graded = gradedAnswer(verdictFor({ ...GRADED, recorded }));
      assert.ok(graded !== null, `a graded reply must be readable when recorded=${recorded}`);
      assert.equal(graded.expected?.value, 25);
    }
    assert.equal(gradedAnswer({ state: 'idle' }), null);
    assert.equal(gradedAnswer({ state: 'pending' }), null);
    assert.equal(gradedAnswer({ state: 'unavailable' }), null);
  });
});

describe('the sentence beside the verdict', () => {
  /** Every source has a sentence, and none of them is blank. */
  const SOURCES: readonly VerdictSource[] = ['server', 'anonymous', 'local', 'pending'];

  it('exists for every source a verdict can resolve to', () => {
    for (const source of SOURCES) {
      const note = VERDICT_SOURCE_NOTE[source];
      assert.equal(typeof note, 'string');
      assert.ok(note.trim().length > 0, `${source} has no sentence`);
    }
  });

  it('only claims a recording in the one state where a row exists', () => {
    // The precise failure: before the fix there was no `anonymous` source, so this sentence — the
    // one that says the answer was recorded — was printed for every signed-out learner.
    assert.match(VERDICT_SOURCE_NOTE.server, /it recorded as a question you have answered/u);

    for (const source of ['anonymous', 'local'] as const) {
      assert.match(
        VERDICT_SOURCE_NOTE[source],
        /nothing was recorded|was not recorded/iu,
        `${source} must state that nothing was stored`,
      );
      assert.doesNotMatch(
        VERDICT_SOURCE_NOTE[source],
        /it recorded as a question you have answered/u,
        `${source} must not make the claim reserved for an answer that was stored`,
      );
    }
    assert.doesNotMatch(VERDICT_SOURCE_NOTE.pending, /recorded/u);
  });

  it('tells an anonymous learner what a session would change, without demanding one', () => {
    const note = VERDICT_SOURCE_NOTE.anonymous;
    // Said once, at the point it matters, and it names the remedy rather than only the problem —
    // the same three parts as the sibling sentence in `lesson-reads.ts`.
    assert.match(note, /no session to attach it to/u);
    assert.match(note, /guest session in one request/u);
    assert.match(note, /no email and no password/u);
    // …and it is not a demand. The product is guest-first on purpose.
    assert.doesNotMatch(note, /sign in|log in|create an account|you must|you need to/iu);
  });

  it('says the same thing the lesson-read note says, because it is the same fact', () => {
    // Two endpoints, one rule. If these ever diverge, one of the two screens is describing a
    // different product from the other.
    const lesson = lessonReadNote({ state: 'anonymous' });
    assert.match(lesson, /no session to attach it to/u);
    assert.match(VERDICT_SOURCE_NOTE.anonymous, /no session to attach it to/u);
  });
});

describe('the panel is wired to the state rather than to "the call succeeded"', () => {
  it('never reads the graded reply through a bare state === live test', () => {
    // A source-level guard, and it is here because it is the exact shape of the reintroduction:
    // `'live'` used to be the only graded state, so every `=== 'live'` in the component meant
    // "graded". It now means "graded AND recorded", and each such test would quietly drop a
    // signed-out learner onto the browser's own figures.
    const runner = readFileSync(join(SRC, 'components', 'QuizRunner.tsx'), 'utf8');
    const prose = runner
      .split('\n')
      .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/u.test(line))
      .join('\n');
    assert.doesNotMatch(
      prose,
      /state\s*===\s*'live'/u,
      'read the grading with `gradedAnswer`: `state === "live"` is now "recorded", not "graded"',
    );
    assert.match(prose, /gradedAnswer\(/u, 'the component reads the grading through the helper');
  });
});
