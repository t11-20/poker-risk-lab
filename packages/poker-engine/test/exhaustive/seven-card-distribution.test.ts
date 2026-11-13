/**
 * Enumerates all 133,784,560 seven-card hands and checks category counts against the published
 * combinatorial result. One misclassified hand moves at least two counters.
 *
 * Run with `pnpm run test:exhaustive`. It stays out of `pnpm test` only because that script's glob
 * is one level deep (`test/*.test.ts`). A recursive glob would run it on every test run, and twice
 * under `test:all`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECK_SIZE } from '../../src/cards.ts';
import { categoryOf, evaluate, HAND_CATEGORY, HAND_CATEGORY_NAMES } from '../../src/evaluate.ts';

/** Published 7-card frequencies, out of C(52,7) = 133,784,560. Their sum is checked too. */
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
