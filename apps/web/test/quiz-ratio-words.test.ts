// A "to 1" answer is asked for as the X in "X to 1", its band is a plain number, and the working shown
// after a price question defines the price, not only the break-even equity beside it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LEARN_QUIZZES } from '../src/fixtures/learn-quizzes.ts';
import { computeCalculation } from '../src/lib/learn-calculations.ts';
import { quizAnswerLabel, quizBandWords } from '../src/lib/quiz-tolerance.ts';

const ratio = LEARN_QUIZZES.flatMap((quiz) => quiz.questions).flatMap((question) =>
  question.kind === 'numeric' && question.unit === 'ratio' ? [question] : [],
);

describe('a "to 1" question', () => {
  it('ships, so this cannot pass by finding nothing', () => {
    assert.ok(ratio.some((question) => question.field === 'oddsRatio'));
  });

  it('labels the field in English', () => {
    assert.equal(quizAnswerLabel('ratio'), 'Your answer, the X in “X to 1”');
    assert.equal(quizAnswerLabel('percent'), 'Your answer, in %');
  });

  it('states its band as a plain number, because "within 0.2 to 1" reads as a range', () => {
    assert.equal(quizBandWords('ratio'), '');
    assert.equal(quizBandWords('count'), ' cards');
  });

  it('shows working that defines the price it asked for', () => {
    for (const question of ratio.filter((candidate) => candidate.field === 'oddsRatio')) {
      const outcome = computeCalculation(question.calculation);
      assert.ok(outcome.ok, `${question.id} computes`);
      assert.match(outcome.result.formula?.expression ?? '', /^price = /mu, question.id);
    }
  });

  it('defines no price for a free call, which has no "X to 1" to quote', () => {
    const outcome = computeCalculation({ kind: 'potOdds', pot: 60, toCall: 0 });
    assert.ok(outcome.ok);
    assert.doesNotMatch(outcome.result.formula?.expression ?? '', /price/u);
  });
});
