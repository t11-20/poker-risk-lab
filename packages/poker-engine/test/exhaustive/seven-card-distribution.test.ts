/**
 * The strongest single check on the hand evaluator: enumerate every one of the
 * 133,784,560 seven-card hands in a 52-card deck and confirm that the resulting
 * category frequencies match the published combinatorial result exactly.
 *
 * This is not a self-consistency test. The expected numbers below are a known
 * mathematical result about 7-card poker hands, derived independently of this
 * code. A single misclassified hand — one straight counted as a flush, one wheel
 * missed, one kicker mis-ranked in a way that changes the category — moves at
 * least two of these nine counters and fails the test.
 *
 * It is kept out of the default suite because it takes seconds rather than milliseconds:
 *
 *     pnpm run test:exhaustive
 *
 * HOW the exclusion actually works, because this is easy to break: the package's `test`
 * script globs `test/*.test.ts` — ONE level deep. Node's `--test` expands a doubled star
 * across directories, so a recursive glob would match this file and run 133 million hands on
 * every `pnpm test`. Living in a subdirectory is NOT by itself what excludes it; the one-level
 * glob is. If someone "fixes" that glob to be recursive, this test silently rejoins the
 * default suite and `pnpm run test:all` runs it twice.
 *
 * (The recursive glob is described in words rather than written out because the character pair
 * it needs would close this very comment. That is not a joke at the reader's expense — it is
 * how this file came to have a parse error the first time the note was added.)
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECK_SIZE } from '../../src/cards.ts';
import { categoryOf, evaluate, HAND_CATEGORY, HAND_CATEGORY_NAMES } from '../../src/evaluate.ts';

/**
 * Published frequencies for 7-card hands (best five of seven), out of
 * C(52,7) = 133,784,560. These sum exactly to C(52,7), which is itself checked.
 */
const EXPECTED: ReadonlyArray<readonly [number, number]> = [
  [HAND_CATEGORY.highCard, 23_294_460],
  [HAND_CATEGORY.pair, 58_627_800],
  [HAND_CATEGORY.twoPair, 31_433_400],
  [HAND_CATEGORY.threeOfAKind, 6_461_620],
  [HAND_CATEGORY.straight, 6_180_020],
  [HAND_CATEGORY.flush, 4_047_644],
  [HAND_CATEGORY.fullHouse, 3_473_184],
  [HAND_CATEGORY.fourOfAKind, 224_848],
  [HAND_CATEGORY.straightFlush, 41_584],
];

const TOTAL_SEVEN_CARD_HANDS = 133_784_560;

test('the expected frequencies sum to C(52,7)', () => {
  const sum = EXPECTED.reduce((accumulator, [, count]) => accumulator + count, 0);
  assert.equal(sum, TOTAL_SEVEN_CARD_HANDS);
});

test('EXHAUSTIVE: all 133,784,560 seven-card hands classify to the published frequencies', () => {
  const counts = new Float64Array(9);
  const hand = [0, 0, 0, 0, 0, 0, 0];
  let total = 0;
  const started = process.hrtime.bigint();

  for (let a = 0; a < DECK_SIZE; a++) {
    hand[0] = a;
    for (let b = a + 1; b < DECK_SIZE; b++) {
      hand[1] = b;
      for (let c = b + 1; c < DECK_SIZE; c++) {
        hand[2] = c;
        for (let d = c + 1; d < DECK_SIZE; d++) {
          hand[3] = d;
          for (let e = d + 1; e < DECK_SIZE; e++) {
            hand[4] = e;
            for (let f = e + 1; f < DECK_SIZE; f++) {
              hand[5] = f;
              for (let g = f + 1; g < DECK_SIZE; g++) {
                hand[6] = g;
                const category = categoryOf(evaluate(hand));
                counts[category] = (counts[category] ?? 0) + 1;
                total++;
              }
            }
          }
        }
      }
    }
  }

  const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
  const rate = Math.round(total / elapsedSeconds / 1000);
  console.log(
    `      enumerated ${total.toLocaleString('en-US')} hands in ${elapsedSeconds.toFixed(1)}s (${rate}k hands/s)`,
  );

  assert.equal(total, TOTAL_SEVEN_CARD_HANDS, 'combination count');
  for (const [category, expected] of EXPECTED) {
    assert.equal(
      counts[category],
      expected,
      `${HAND_CATEGORY_NAMES[category]}: expected ${expected.toLocaleString('en-US')}, got ${counts[category]?.toLocaleString('en-US')}`,
    );
  }
});
