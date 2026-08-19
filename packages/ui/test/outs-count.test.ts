/**
 * The render boundary's "may this be called an outs count?" guard.
 *
 * ## The one test that makes the duplication safe
 *
 * `src/outs-count.ts` re-declares `@prl/poker-math`'s `DEFAULT_AHEAD_THRESHOLD` rather than
 * importing it, because importing it would link `@prl/poker-engine` — the shuffler, the
 * deck commitment, `HandState` — into the client bundle of the most widely rendered
 * component in the app. `src/cards.ts` re-derives the card encoding for the same reason and
 * is pinned the same way, by a test that fails the moment the two definitions disagree.
 *
 * A *test* may import `@prl/poker-math` freely: it ships nowhere. So the first case below
 * is the contract. If the producer ever moves its bar, this file fails and the constant is
 * updated — the drift is caught here rather than by a learner reading a headline that says
 * one thing while the paragraph under it says another.
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
  // Below the bar there is something to draw to, so a count of cards is a count of outs.
  assert.equal(countsAsOuts(0), true);
  assert.equal(countsAsOuts(0.35), true, 'a nine-out flush draw is about 35%');
  assert.equal(countsAsOuts(0.4999999), true);

  // At and above it, no card rescues anything, so nothing may be called an out. The bar is
  // INCLUSIVE, matching `computeOuts`, where a card that leaves hero at exactly the
  // threshold counts. A hand sitting exactly there — a board that chops every river — is
  // not drawing either.
  assert.equal(countsAsOuts(0.5), false, 'the bar is inclusive on both sides of the question');
  assert.equal(countsAsOuts(0.645), false, 'the overpair spot in the audit fixture');
  assert.equal(countsAsOuts(0.88), false, 'the flopped two pair that headlined 47 outs');
  assert.equal(countsAsOuts(1), false);
});

test('an equity that is not a probability suppresses nothing', () => {
  // A figure outside 0..1 is evidence of nothing. It cannot establish that hero is ahead,
  // so it must not be allowed to withhold a count that may be perfectly good — the panel
  // refuses that figure separately, a few lines further up, where the reader will see it.
  // The opposite choice would let one stale field silently blank a second section.
  for (const notAProbability of [1.6, -0.2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      countsAsOuts(notAProbability),
      true,
      `${String(notAProbability)} says nothing about whether hero is ahead`,
    );
  }
});
