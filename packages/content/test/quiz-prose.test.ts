/**
 * An explanation that points at another question in its quiz. The questions are asked in order, so a
 * pointer to "the next question" is a promise about one particular question.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quizById } from '../src/index.ts';

test('rule24-q2 points at the question about where the rule goes wrong, which comes after it', () => {
  const quiz = quizById('quiz-rule-of-2-and-4');
  assert.ok(quiz !== null, 'the rule of 2 and 4 quiz is in the bundle');
  const at = quiz.questions.findIndex((question) => question.id === 'rule24-q2');
  const target = quiz.questions.findIndex((question) => /mislead/.test(question.prompt));
  assert.ok(at >= 0 && target >= 0, 'both questions are in the quiz');
  const explanation = quiz.questions[at]?.explanation ?? '';
  const pointer = /(the next|a later) question is about where it goes wrong/.exec(explanation);
  assert.ok(pointer !== null, `rule24-q2 no longer points at a question: ${explanation}`);
  if (pointer[1] === 'the next') assert.equal(target, at + 1, 'the next question is not that one');
  else assert.ok(target > at, 'the question it points at comes before it');
});
