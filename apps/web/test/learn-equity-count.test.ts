/**
 * An exact equity count is showdowns: on a complete board there is one and no run-out left to play.
 * The lesson "playing the board" asks for exactly that spot.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LiveCalculation } from '@prl/contracts';
import { computeCalculation } from '../src/lib/learn-calculations.ts';

function resultOf(board: string) {
  const calculation: LiveCalculation = { kind: 'equity', heroCards: 'AcKd', board, opponents: ['5c4d'] };
  const outcome = computeCalculation(calculation);
  assert.ok(outcome.ok, 'the calculation runs');
  return outcome.result;
}

test('a complete board is counted as one showdown, not a remaining run-out (REGRESSION)', () => {
  const result = resultOf('Th9d8c7s6h');
  assert.equal(
    result.method.note,
    'Every showdown was played out (1 showdown), so there is no sampling error.',
  );
  const said = [result.method.note, ...result.assumptions].join(' ');
  assert.doesNotMatch(said, /run-out|remaining board/u);
});

test('control: on a flop every board to come is one showdown', () => {
  assert.equal(
    resultOf('Th9d2c').method.note,
    'Every showdown was played out (990 showdowns), so there is no sampling error.',
  );
});
