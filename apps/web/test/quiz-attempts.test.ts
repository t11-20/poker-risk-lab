/**
 * Turning an answer into a request, and deciding whose verdict the learner sees.
 *
 * Driven against real shipped questions rather than hand-built objects. A fabricated `QuizQuestion`
 * would prove the mapping compiles; the shipped ones prove it works on every question kind a
 * learner can actually reach — a kind the mapping silently declined to send would show up here as
 * a whole quiz nobody's answers are recorded for.
 *
 * The questions come from `src/fixtures/learn-quizzes.ts` rather than from `@prl/content`, and only
 * their SHAPE is used — `kind` and `id`, never a number. The fixtures carry stale figures that are
 * being regenerated separately, and reading a value out of them here would make this file fail for
 * a reason that has nothing to do with what it is asserting.
 *
 * The defect being fixed is that no answer was ever sent at all. See `quiz-attempts.ts` and the
 * call-site gate in `api-paths.test.ts`, which is the assertion that would have caught it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { QuizQuestion } from '@prl/contracts';
import { LEARN_QUIZZES } from '../src/fixtures/learn-quizzes.ts';
import { attemptBodyFor, resolvedVerdict, VERDICT_SOURCE_NOTE } from '../src/lib/quiz-attempts.ts';

const ALL_QUESTIONS: readonly QuizQuestion[] = LEARN_QUIZZES.flatMap((quiz) => quiz.questions);

const firstOfKind = <K extends QuizQuestion['kind']>(kind: K): Extract<QuizQuestion, { kind: K }> => {
  const found = ALL_QUESTIONS.find((question) => question.kind === kind);
  assert.ok(found !== undefined, `the content bundle carries no ${kind} question`);
  return found as Extract<QuizQuestion, { kind: K }>;
};

describe('an answer becomes a request the server will accept', () => {
  it('sends a multiple-choice answer as the index that was chosen', () => {
    const question = firstOfKind('multipleChoice');
    assert.deepEqual(attemptBodyFor(question, { kind: 'choice', index: 2 }), {
      questionId: question.id,
      answer: { kind: 'choice', index: 2 },
    });
  });

  it('sends a numeric answer as a number, dropping the text it was typed as', () => {
    const question = firstOfKind('numeric');
    // `raw` is the string in the field and never leaves the browser: the wire type carries a
    // number, and sending both would be the same fact twice in two formats.
    assert.deepEqual(attemptBodyFor(question, { kind: 'number', value: 33.3, raw: '33.30' }), {
      questionId: question.id,
      answer: { kind: 'number', value: 33.3 },
    });
  });

  it('sends nothing for a decision question, which has no recorded answer', () => {
    // There is no `correctAction` field in the contract and the product declines to invent one, so
    // "show me the reasoning" is not an attempt at anything. Posting it would put a row in
    // `prl.quiz_attempts` claiming a question was answered that the learner explicitly declined.
    assert.equal(attemptBodyFor(firstOfKind('decision'), { kind: 'revealed' }), null);
  });

  it('sends nothing when the answer does not match the question it is for', () => {
    assert.equal(attemptBodyFor(firstOfKind('numeric'), { kind: 'choice', index: 0 }), null);
    assert.equal(attemptBodyFor(firstOfKind('multipleChoice'), { kind: 'number', value: 1, raw: '1' }), null);
  });

  it('sends nothing for a value that is not a finite number', () => {
    // `JSON.stringify(NaN)` is `null`, so this would reach the server as a field error about a type
    // the learner never typed. Caught at the last place the value is still a number.
    const question = firstOfKind('numeric');
    assert.equal(attemptBodyFor(question, { kind: 'number', value: Number.NaN, raw: 'x' }), null);
    assert.equal(
      attemptBodyFor(question, { kind: 'number', value: Number.POSITIVE_INFINITY, raw: '1e999' }),
      null,
    );
  });

  it('can send every gradeable question in the shipped content', () => {
    const gradeable = ALL_QUESTIONS.filter((question) => question.kind !== 'decision');
    assert.ok(gradeable.length > 0, 'the content bundle carries no gradeable questions');
    for (const question of gradeable) {
      const answer =
        question.kind === 'multipleChoice'
          ? ({ kind: 'choice', index: 0 } as const)
          : ({ kind: 'number', value: 1, raw: '1' } as const);
      assert.notEqual(
        attemptBodyFor(question, answer),
        null,
        `${question.id} (${question.kind}) produced no request body, so answering it would record nothing`,
      );
    }
  });
});

describe('whose verdict the learner is shown', () => {
  it('is the server’s whenever the server answered', () => {
    // The server grades AND stores. A screen showing its own answer instead could disagree with the
    // one that was recorded, and the learner would be looking at the one that was thrown away.
    const live = resolvedVerdict(
      { state: 'live', correct: true, explanation: 'because', expected: null },
      false,
    );
    assert.deepEqual(live, { matched: true, source: 'server' });

    const refused = resolvedVerdict(
      { state: 'live', correct: false, explanation: 'because', expected: null },
      true,
    );
    assert.deepEqual(refused, { matched: false, source: 'server' });
  });

  it('falls back to the local comparison, and says which it is', () => {
    assert.deepEqual(resolvedVerdict({ state: 'unavailable' }, true), { matched: true, source: 'local' });
    assert.deepEqual(resolvedVerdict({ state: 'pending' }, true), { matched: true, source: 'pending' });
    assert.deepEqual(resolvedVerdict({ state: 'idle' }, false), { matched: false, source: 'local' });
  });

  it('never claims a recording that did not happen', () => {
    // The failure note is the one that has to be exactly right: an outage means nothing was written,
    // and a sentence implying otherwise is a lie about the learner's own record.
    assert.match(VERDICT_SOURCE_NOTE.local, /nothing was recorded/u);
    assert.doesNotMatch(VERDICT_SOURCE_NOTE.pending, /recorded/u);
    assert.match(VERDICT_SOURCE_NOTE.server, /recorded/u);
  });
});
