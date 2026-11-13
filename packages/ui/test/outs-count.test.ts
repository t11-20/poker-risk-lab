/**
 * The render boundary's "may this be called an outs count?" guard.
 * `src/outs-count.ts` re-declares `DEFAULT_AHEAD_THRESHOLD` because importing `@prl/poker-math` would
 * link `@prl/poker-engine` into the client bundle. A test ships nowhere, so the first case imports it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_AHEAD_THRESHOLD } from '@prl/poker-math';
import { ALREADY_AHEAD_EQUITY, countsAsOuts } from '../src/outs-count.ts';

test('the re-declared threshold is the producer’s threshold', () => {
  assert.equal(
    ALREADY_AHEAD_EQUITY,
    DEFAULT_AHEAD_THRESHOLD,
    'the panel and @prl/poker-math must agree on the equity at which a hand stops drawing; ' +
      'update src/outs-count.ts, do not change this assertion',
  );
});

test('a hand that is behind has outs; a hand that is in front does not', () => {
  assert.equal(countsAsOuts(0), true);
  assert.equal(countsAsOuts(0.35), true, 'a nine-out flush draw is about 35%');
  assert.equal(countsAsOuts(0.4999999), true);

  // The bar is inclusive, matching `computeOuts`, where a card leaving hero exactly at the bar counts.
  assert.equal(countsAsOuts(0.5), false, 'the bar is inclusive on both sides of the question');
  assert.equal(countsAsOuts(0.645), false, 'the overpair spot in the audit fixture');
  assert.equal(countsAsOuts(0.88), false, 'the flopped two pair that headlined 47 outs');
  assert.equal(countsAsOuts(1), false);
});

test('an equity that is not a probability suppresses nothing', () => {
  // A figure outside 0..1 cannot show hero is ahead, and the panel refuses it separately where the
  // reader sees it. Suppressing here would let one stale field silently blank a second section.
  for (const notAProbability of [1.6, -0.2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      countsAsOuts(notAProbability),
      true,
      `${String(notAProbability)} says nothing about whether hero is ahead`,
    );
  }
});
