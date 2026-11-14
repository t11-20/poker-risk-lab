/**
 * The live table's spoken amounts read exactly as `formatUnits` writes them everywhere else. Literal
 * text, not agreement between two functions, so a change to the shared grouping is seen here.
 * Integers only, because every amount the table speaks is a whole number of chips on the wire.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatUnits } from '@prl/ui/format';
import { spokenDecision } from '../src/lib/use-live-table.ts';

const SPOKEN: readonly (readonly [number, string])[] = [
  [0, '0 units'],
  [1, '1 unit'],
  [2, '2 units'],
  [999, '999 units'],
  [1000, '1,000 units'],
  [1001, '1,001 units'],
  [20_000, '20,000 units'],
  [1_234_567, '1,234,567 units'],
  [10_000_000, '10,000,000 units'],
  [-1, '-1 unit'],
  [-1000, '-1,000 units'],
  [-1_234_567, '-1,234,567 units'],
];

describe('the live table speaks amounts in the shared units format', () => {
  it('reads a non-empty table', () => {
    assert.ok(SPOKEN.length > 10);
  });

  it('is what formatUnits writes', () => {
    for (const [value, text] of SPOKEN) assert.equal(formatUnits(value), text, String(value));
  });

  it('is what a bet or a raise is announced with', () => {
    for (const [value, text] of SPOKEN) {
      assert.equal(spokenDecision({ type: 'bet', to: value }), `You chose to bet to ${text}.`);
      assert.equal(spokenDecision({ type: 'raise', to: value }), `You chose to raise to ${text}.`);
    }
  });
});
