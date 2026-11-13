/**
 * The tolerance a numeric question states is never wider or narrower than the one it applies.
 * The hint once formatted `tolerance: 0.5` with zero decimals as "1", so a learner answering 8 to 9
 * was refused (`counting-outs-q4`, measured in Chrome 151). Separately, `|3.2 - 3.0|` is
 * 0.20000000000000018, so an answer exactly at a 0.2 tolerance was refused. The number the field shows
 * is compared with the number the real grader in `lib/quiz-tolerance.ts` uses, over every shipped
 * question, never a copied sentence.
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
      // Measured across magnitudes rather than from zero, because `100.2 - 100` is 0.20000000000000284.
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
 * The band the quiz accepts has to be the band it states. Narrower refuses a learner who followed the
 * field, and wider marks a wrong answer right.
 */
describe('withinTolerance accepts exactly the band the field states', () => {
  it('accepts an answer at the boundary, at every magnitude', () => {
    // Each pair's difference is not representable, and each was once refused at its stated tolerance.
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
    // The old rule, which must still refuse something, or the cases above are not at the boundary.
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
    // The slack is the arithmetic error and nothing more, so one unit of the last decimal is still out.
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
