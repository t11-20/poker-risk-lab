/**
 * The tolerance a numeric question STATES is never wider than the one it applies.
 *
 * ## The defect these exist for
 *
 * The hint under the numeric field rendered `question.tolerance` with `QUIZ_UNIT_DECIMALS`, which
 * is how many decimals a *figure* in that unit is worth showing. For `count` and `hands` that is
 * zero, and `(0.5).toFixed(0)` is `"1"`.
 *
 * Measured on `/learn/counting-outs` in Chrome 151, stepped through to the numeric question with
 * the API up. The field's hint read, in full:
 *
 *     "Anything within 1 cards of the computed figure is accepted."
 *
 * `counting-outs-q4` declares `tolerance: 0.5`, and the grader is
 * `Math.abs(answer - expected.value) <= Math.abs(expected.tolerance)`, so only the exact integer is
 * accepted. A learner who answered 8 to an answer of 9 did exactly what the hint said was allowed
 * and was told "8 cards is outside the tolerance of 9 cards".
 *
 * ## Why the third test is written the way it is
 *
 * It does not compare one string with another — a test carrying its own copy of the sentence passes
 * the moment somebody edits the sentence and the rule apart. It compares the NUMBER the field shows
 * with the number the grader uses, over every numeric question that actually ships. A sweep of
 * nothing is not a pass, so it asserts it read a non-empty set first.
 *
 * `withinTolerance` used to live in `lib/learn-calculations.ts`, which cannot be imported here: it
 * pulls runtime values from `@prl/ui`, whose entry point re-exports `.tsx`, and Node's type
 * stripping refuses that under `node --test`. So this file restated its rule in one line — and the
 * restatement is exactly why nobody noticed that the real one had a defect of its own.
 *
 * ## The second defect: the accepted band was narrower than the stated one
 *
 * `Math.abs(answer - expected.value) <= tolerance` is not the rule the field describes, because the
 * subtraction is not exact. For a stated tolerance of 0.2:
 *
 *     |3.2 − 3.0| = 0.20000000000000018   >  0.2   →  REFUSED
 *     |2.2 − 2.0| = 0.20000000000000018   >  0.2   →  REFUSED
 *     |8.2 − 8.0| = 0.1999999999999993    <= 0.2   →  accepted
 *
 * So an answer at exactly the tolerance the field promised was refused, or not, depending on the
 * binary representation of the expected value. The previous pass through this file recorded that
 * as "a separate, much smaller defect" and worked around it by measuring the sweep below from
 * zero. `withinTolerance` has moved into `lib/quiz-tolerance.ts` and is now driven directly, so the
 * sweep measures from a real magnitude and the workaround is gone.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LEARN_QUIZZES } from '../src/fixtures/learn-quizzes.ts';
import {
  QUIZ_UNIT_DECIMALS,
  QUIZ_UNIT_WORDS,
  statedTolerance,
  toleranceDecimals,
  withinTolerance,
} from '../src/lib/quiz-tolerance.ts';

/** The REAL grader, driven directly. See the header for why it can be imported now. */
const graderAccepts = (answer: number, expected: number, tolerance: number): boolean =>
  withinTolerance(answer, { value: expected, tolerance });

describe('the tolerance a numeric question states', () => {
  it('is not rounded outwards past the band the grader accepts', () => {
    assert.equal(statedTolerance(0.5, QUIZ_UNIT_DECIMALS.count), 0.5);
    assert.equal(toleranceDecimals(0.5, QUIZ_UNIT_DECIMALS.count), 1);
  });

  it('keeps the unit’s own precision when that precision can express it', () => {
    assert.equal(toleranceDecimals(1, QUIZ_UNIT_DECIMALS.count), 0);
    assert.equal(toleranceDecimals(3, QUIZ_UNIT_DECIMALS.chips), 1);
    assert.equal(toleranceDecimals(0.2, QUIZ_UNIT_DECIMALS.ratio), 1);
    assert.equal(statedTolerance(2.5, QUIZ_UNIT_DECIMALS.percent), 2.5);
  });

  it('is a band the grader agrees with, for every numeric question that ships', () => {
    const numeric = LEARN_QUIZZES.flatMap((quiz) =>
      quiz.questions.filter((question) => question.kind === 'numeric'),
    );
    assert.ok(numeric.length > 0, 'there are numeric questions to check');

    for (const question of numeric) {
      const stated = statedTolerance(question.tolerance, QUIZ_UNIT_DECIMALS[question.unit]);
      assert.ok(Number.isFinite(stated), `${question.id}: the stated tolerance is a number`);
      // An answer exactly `stated` away from the truth is what the field promises will be accepted.
      // Measured across a spread of magnitudes rather than from zero: the previous version of this
      // sweep used a base of 0 precisely because `100.2 - 100` is 0.20000000000000284 and the
      // grader refused it. That was the grader's defect, not the test's, and it is fixed — so the
      // sweep now asks the question a learner's actual figures ask.
      for (const base of [0, 1, 2, 3, 4, 8, 12.5, 33.3, 100, 120, 1_000, 1_250.5]) {
        assert.equal(
          graderAccepts(base + stated, base, question.tolerance),
          true,
          `${question.id}: the field says "within ${String(stated)} ${QUIZ_UNIT_WORDS[question.unit]}" ` +
            `and the grader refuses ${String(base + stated)} against ${String(base)} — its tolerance ` +
            `is ${String(question.tolerance)}`,
        );
        assert.equal(
          graderAccepts(base - stated, base, question.tolerance),
          true,
          `${question.id}: the same answer on the low side of ${String(base)} was refused`,
        );
      }
    }
  });
});

/**
 * The grader itself, at the boundary it advertises.
 *
 * The band the quiz ACCEPTS has to be the band the quiz STATES. Anything narrower refuses a learner
 * who did exactly what the field told them to; anything wider marks a wrong answer right.
 */
describe('withinTolerance accepts exactly the band the field states', () => {
  it('accepts an answer at the boundary, at every magnitude', () => {
    // Each of these is a real `(answer, expected)` pair whose difference is not representable:
    // `3.2 - 3.0` is 0.20000000000000018 and was refused against a stated tolerance of 0.2.
    for (const [answer, expected] of [
      [3.2, 3.0],
      [2.2, 2.0],
      [4.2, 4.0],
      [100.2, 100],
      [8.2, 8.0],
      [1.2, 1.0],
      [0.3, 0.1],
    ] as const) {
      assert.ok(
        Math.abs(answer - expected) !== 0.2 || withinTolerance(answer, { value: expected, tolerance: 0.2 }),
        'the pair chosen is not actually at the boundary',
      );
      assert.equal(
        withinTolerance(answer, { value: expected, tolerance: 0.2 }),
        true,
        `${String(answer)} against ${String(expected)} is exactly 0.2 out and the field says 0.2 is accepted`,
      );
    }
  });

  it('NEGATIVE CONTROL: the old comparison refuses several of those', () => {
    // The rule this replaced, restated. If it ever stops refusing anything, the cases above have
    // stopped being at the boundary and prove nothing.
    const old = (answer: number, expected: number, tolerance: number): boolean =>
      Math.abs(answer - expected) <= Math.abs(tolerance);
    const refused = (
      [
        [3.2, 3.0],
        [2.2, 2.0],
        [4.2, 4.0],
        [100.2, 100],
      ] as const
    ).filter(([answer, expected]) => !old(answer, expected, 0.2));
    assert.ok(refused.length > 0, 'the old comparison accepted every boundary case in this list');
    assert.equal(refused.length, 4, `expected all four to be refused, got ${String(refused.length)}`);
  });

  it('still refuses an answer outside the band, which is the half that must not move', () => {
    // The slack is the size of the arithmetic error and nothing more. A learner one whole unit of
    // the last decimal outside the band is still outside it.
    assert.equal(withinTolerance(3.21, { value: 3, tolerance: 0.2 }), false);
    assert.equal(withinTolerance(3.2000000001, { value: 3, tolerance: 0.2 }), false);
    assert.equal(withinTolerance(9, { value: 8, tolerance: 0.5 }), false);
    assert.equal(withinTolerance(8, { value: 9, tolerance: 0.5 }), false);
    assert.equal(withinTolerance(1_001, { value: 1_000, tolerance: 0.5 }), false);
  });

  it('refuses an answer that is not a number at all', () => {
    for (const answer of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(withinTolerance(answer, { value: 3, tolerance: 0.2 }), false);
    }
  });

  it('accepts the exact answer, and a zero tolerance means exactly that', () => {
    assert.equal(withinTolerance(9, { value: 9, tolerance: 0 }), true);
    assert.equal(withinTolerance(9.0000001, { value: 9, tolerance: 0 }), false);
  });
});
