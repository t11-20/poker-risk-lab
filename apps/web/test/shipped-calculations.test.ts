/**
 * Every calculation that ships runs through the calculator a reader's browser uses, so a calculation
 * that loads but cannot be computed fails here rather than on a lesson page. The validator checks each
 * field; only running it shows the whole calculation can be computed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lessons, quizzes } from '@prl/content';
import type { Lesson, LiveCalculation, Quiz } from '@prl/contracts';
import { LEARN_LESSONS } from '../src/fixtures/learn-lessons.ts';
import { LEARN_QUIZZES } from '../src/fixtures/learn-quizzes.ts';
import { computeCalculation, expectedAnswerFor } from '../src/lib/learn-calculations.ts';

interface Shipped {
  readonly where: string;
  readonly calculation: LiveCalculation;
  readonly question?: Extract<Quiz['questions'][number], { kind: 'numeric' }>;
}

function shipped(from: string, lessonList: readonly Lesson[], quizList: readonly Quiz[]): Shipped[] {
  const found: Shipped[] = [];
  for (const lesson of lessonList) {
    for (const [index, block] of lesson.blocks.entries()) {
      if (block.kind !== 'liveCalculation') continue;
      found.push({ where: `${from} lesson ${lesson.id} block ${index}`, calculation: block.calculation });
    }
  }
  for (const quiz of quizList) {
    for (const question of quiz.questions) {
      if (question.kind !== 'numeric') continue;
      found.push({
        where: `${from} quiz ${quiz.id} ${question.id}`,
        calculation: question.calculation,
        question,
      });
    }
  }
  return found;
}

/** The reason a calculation cannot be shown, or null when every figure it shows is a finite number. */
function failure(entry: Shipped): string | null {
  const outcome = computeCalculation(entry.calculation);
  if (!outcome.ok) return outcome.reason;
  const broken = outcome.result.figures.find((figure) => !Number.isFinite(figure.value));
  if (broken !== undefined) return `figure ${broken.key} is ${broken.value}`;
  if (entry.question === undefined) return null;
  const expected = expectedAnswerFor(entry.question);
  if (!expected.ok) return expected.reason;
  return Number.isFinite(expected.expected.value)
    ? null
    : `the expected answer is ${expected.expected.value}`;
}

const SETS = [
  ['content', shipped('content', lessons(), quizzes())],
  ['bundled', shipped('bundled', LEARN_LESSONS, LEARN_QUIZZES)],
] as const;

describe('every shipped calculation, through the browser calculator', () => {
  for (const [name, entries] of SETS) {
    it(`computes every ${name} calculation`, () => {
      const kinds = new Set(entries.map((entry) => entry.calculation.kind));
      assert.ok(entries.length > 0, `premise: ${name} has calculations`);
      for (const kind of ['equity', 'outs'] as const)
        assert.ok(kinds.has(kind), `premise: ${name} has ${kind}`);
      const failed = entries.flatMap((entry) => {
        const reason = failure(entry);
        return reason === null ? [] : [`${entry.where}: ${reason}`];
      });
      assert.deepEqual(failed, []);
    });
  }

  it('control: a calculation the validator accepts but the browser cannot compute is caught', () => {
    // Both load today. The browser takes equity opponents only as exact cards, and outs only against one.
    const range: LiveCalculation = { kind: 'equity', heroCards: 'AhKh', board: 'Qh7h2c', opponents: ['QQ+'] };
    const noOpponent: LiveCalculation = { kind: 'outs', heroCards: 'Th9h', board: 'Ah7h2c4d' };
    assert.notEqual(failure({ where: 'range', calculation: range }), null);
    assert.notEqual(failure({ where: 'no opponent', calculation: noOpponent }), null);
  });
});
