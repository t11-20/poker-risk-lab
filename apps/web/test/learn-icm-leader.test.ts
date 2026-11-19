/**
 * "Largest stack's prize share" is the largest stack's, not the first one listed. The API grades the
 * same field the same way, so the offline answer and the graded one agree.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quizById } from '@prl/content';
import type { QuizQuestion } from '@prl/contracts';
import { expectedAnswerFor } from '../src/lib/learn-calculations.ts';

function icmQuestion(): Extract<QuizQuestion, { kind: 'numeric' }> {
  const question = quizById('quiz-tournament-chips-and-icm')?.questions.find(
    (entry) => entry.id === 'icm-q6',
  );
  assert.ok(question !== undefined && question.kind === 'numeric', 'icm-q6 is a numeric question');
  return question;
}

test('the shipped ICM question expects 60', () => {
  const outcome = expectedAnswerFor(icmQuestion());
  assert.ok(outcome.ok, 'the calculation runs');
  assert.equal(outcome.expected.value, 60);
});

test('300 against 100 for 70/30 is 60 to the leader, however the stacks are written', () => {
  for (const stacks of [
    [300, 100],
    [100, 300],
  ]) {
    const outcome = expectedAnswerFor({
      ...icmQuestion(),
      calculation: { kind: 'icm', stacks, payouts: [70, 30] },
    });
    assert.ok(outcome.ok, 'the calculation runs');
    assert.equal(outcome.expected.value, 60, `stacks ${stacks.join(' / ')}`);
  }
});
