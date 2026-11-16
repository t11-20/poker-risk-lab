/** An exact equity count is showdowns: on a complete board there is one and no run-out left to play. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculate } from '../src/learn.ts';

test('a complete board is counted as one showdown, not a run-out (REGRESSION)', () => {
  const result = calculate({ kind: 'equity', heroCards: 'AcKd', board: 'Th9d8c7s6h', opponents: ['5c4d'] });
  assert.equal(result.method, 'Exact: every showdown was played out (1 showdown).');
  assert.doesNotMatch(result.working, /run-out|remaining board/u);
});

test('control: on a flop every board to come is one showdown', () => {
  const result = calculate({ kind: 'equity', heroCards: 'AcKd', board: 'Th9d2c', opponents: ['5c4d'] });
  assert.equal(result.method, 'Exact: every showdown was played out (990 showdowns).');
});
