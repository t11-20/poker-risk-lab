import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lessonById } from '@prl/content';
import type { LiveCalculation } from '@prl/contracts';
import { riskOfRuin } from '@prl/poker-math';
import { type Definition, shownAbove } from '../src/lib/definition-repeats.ts';

/** Which of a lesson's definitions are shown, in order, by the rule the page applies. */
function shown(definitions: readonly Definition[]): readonly boolean[] {
  return definitions.map((definition, index) => !shownAbove(definition, definitions.slice(0, index)));
}

function calculationsOf(lessonId: string, kind: LiveCalculation['kind']): readonly LiveCalculation[] {
  const lesson = lessonById(lessonId);
  assert.ok(lesson !== null, `${lessonId} is in the bundle`);
  return lesson.blocks.flatMap((block) =>
    block.kind === 'liveCalculation' && block.calculation.kind === kind ? [block.calculation] : [],
  );
}

describe('a lesson shows each definition once', () => {
  it('keeps every risk-of-ruin definition, because each carries its own numbers (REGRESSION)', () => {
    // As `resolveRiskOfRuin` builds them. A same-kind rule showed only the first of these three.
    const definitions = calculationsOf('sample-size-and-risk-of-ruin', 'riskOfRuin').map((calculation) => {
      assert.ok(calculation.kind === 'riskOfRuin');
      const result = riskOfRuin(calculation);
      return { expression: result.formula, explanation: result.explanation };
    });
    assert.equal(definitions.length, 3, 'a sweep of nothing is not a pass');
    assert.deepEqual(shown(definitions), [true, true, true]);
  });

  it('shows a fixed definition only the first time', () => {
    const fixed = {
      expression: 'break-even equity = call / (pot + call)',
      explanation: 'The share you need.',
    };
    const count = calculationsOf('pot-odds', 'potOdds').length;
    assert.equal(count, 3, 'the pot-odds lesson shows three calculators');
    assert.deepEqual(shown(Array.from({ length: count }, () => fixed)), [true, false, false]);
  });

  it('treats a changed explanation as a different definition', () => {
    const one = { expression: 'x = a / b', explanation: 'First.' };
    assert.equal(shownAbove({ ...one, explanation: 'Second.' }, [one]), false);
    assert.equal(shownAbove(one, [null, one]), true);
  });
});
