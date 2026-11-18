/**
 * Each answer is posted as it is given, and responses can arrive in any order. A verdict belongs on
 * screen only while the answer it graded is still the latest one posted for its question, or a slow
 * response for an earlier answer replaces the verdict on the answer showing.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { isLatestPosted, type QuizAnswer, type QuizVerdict } from '../src/lib/quiz-attempts.ts';

const QUESTION = 'q-pot-odds';
const WRONG: QuizAnswer = { kind: 'choice', index: 0 };
const RIGHT: QuizAnswer = { kind: 'choice', index: 2 };
const graded = (correct: boolean): QuizVerdict => ({
  state: 'live',
  correct,
  explanation: '',
  expected: null,
});

describe('a verdict lands only for the latest answer posted', () => {
  it('drops the earlier answer’s response when it arrives after the later one’s', () => {
    const posted = new Map<string, QuizAnswer>();
    const verdicts = new Map<string, QuizVerdict>();
    const land = (sent: QuizAnswer, verdict: QuizVerdict): void => {
      if (isLatestPosted(posted, QUESTION, sent)) verdicts.set(QUESTION, verdict);
    };

    posted.set(QUESTION, WRONG);
    posted.set(QUESTION, RIGHT);
    land(RIGHT, graded(true));
    land(WRONG, graded(false));

    assert.deepEqual(verdicts.get(QUESTION), graded(true));
  });

  it('compares identity, so the same choice pressed again is a new post', () => {
    const again: QuizAnswer = { kind: 'choice', index: 0 };
    const posted = new Map<string, QuizAnswer>([[QUESTION, again]]);
    assert.equal(isLatestPosted(posted, QUESTION, WRONG), false);
    assert.equal(isLatestPosted(posted, QUESTION, again), true);
  });

  it('is asked by the runner before it stores a response', () => {
    const source = readFileSync(new URL('../src/components/QuizRunner.tsx', import.meta.url), 'utf8');
    const landing = source.slice(source.indexOf('await submitQuizAttempt('));
    const guard = landing.indexOf('isLatestPosted(posted.current, questionId, answerSent)');
    assert.ok(guard > 0, 'the response is stored without asking whether its answer is still the latest');
    assert.ok(guard < landing.indexOf('.set(questionId, verdict)'), 'the guard runs after the store');
  });
});
