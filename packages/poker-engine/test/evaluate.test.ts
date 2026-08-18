import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Card, cardToString, DECK_SIZE, orderedDeck, parseCards } from '../src/cards.ts';
import {
  categoryName,
  categoryOf,
  compareHands,
  describeScore,
  evaluate,
  HAND_CATEGORY,
  highestRank,
  popCount13,
  straightHigh,
} from '../src/evaluate.ts';
import { combinations, compareReference, referenceEvaluate5 } from './reference-evaluator.ts';

const hand = (text: string): Card[] => parseCards(text);
const score = (text: string): number => evaluate(hand(text));

test('popCount13 counts bits in every 13-bit mask', () => {
  for (let mask = 0; mask < 1 << 13; mask++) {
    let expected = 0;
    for (let bit = 0; bit < 13; bit++) if (mask & (1 << bit)) expected++;
    assert.equal(popCount13(mask), expected, `mask ${mask}`);
  }
});

test('highestRank finds the top set bit, -1 when empty', () => {
  assert.equal(highestRank(0), -1);
  for (let bit = 0; bit < 13; bit++) {
    assert.equal(highestRank(1 << bit), bit);
    assert.equal(highestRank((1 << bit) | 1), bit);
  }
});

test('straightHigh: exhaustive over all 13-bit masks, checked against a naive scan', () => {
  const naive = (mask: number): number => {
    // Ace-high down to six-high, then the wheel.
    for (let high = 12; high >= 4; high--) {
      let ok = true;
      for (let offset = 0; offset < 5; offset++) {
        if ((mask & (1 << (high - offset))) === 0) ok = false;
      }
      if (ok) return high;
    }
    const wheelRanks = [12, 3, 2, 1, 0];
    if (wheelRanks.every((r) => mask & (1 << r))) return 3;
    return -1;
  };
  for (let mask = 0; mask < 1 << 13; mask++) {
    assert.equal(straightHigh(mask), naive(mask), `mask ${mask.toString(2)}`);
  }
});

test('the wheel is the weakest straight and a six-high straight beats it', () => {
  const wheel = score('Ah 2c 3d 4s 5h');
  const sixHigh = score('2c 3d 4s 5h 6c');
  assert.equal(categoryOf(wheel), HAND_CATEGORY.straight);
  assert.equal(categoryOf(sixHigh), HAND_CATEGORY.straight);
  assert.ok(sixHigh > wheel, 'six-high straight must beat the wheel');
  assert.equal(describeScore(wheel), 'straight, five high (the wheel)');
});

test('the wheel does not let an ace also count as high', () => {
  // A-2-3-4-5 is a straight, but A-K-Q-J-T-2-3-4-5 style wrap-around is not.
  const wrap = score('Jh Qc Kd Ah 2s');
  assert.notEqual(categoryOf(wrap), HAND_CATEGORY.straight);
  assert.equal(categoryOf(wrap), HAND_CATEGORY.highCard);
});

test('steel wheel is a straight flush, five high', () => {
  const steelWheel = score('Ah 2h 3h 4h 5h');
  assert.equal(categoryOf(steelWheel), HAND_CATEGORY.straightFlush);
  const royal = score('Th Jh Qh Kh Ah');
  assert.equal(categoryOf(royal), HAND_CATEGORY.straightFlush);
  assert.ok(royal > steelWheel);
  assert.equal(describeScore(royal), 'royal flush');
});

test('category ordering is strictly increasing', () => {
  const examples: [string, string][] = [
    ['high card', 'Ah Kd 9c 7s 5h'],
    ['pair', '2h 2d 9c 7s 5h'],
    ['two pair', '2h 2d 3c 3s 5h'],
    ['three of a kind', '2h 2d 2c 7s 5h'],
    ['straight', '2h 3d 4c 5s 6h'],
    ['flush', '2h 4h 6h 8h Th'],
    ['full house', '2h 2d 2c 3s 3h'],
    ['four of a kind', '2h 2d 2c 2s 5h'],
    ['straight flush', '2h 3h 4h 5h 6h'],
  ];
  const scores = examples.map(([, cards]) => score(cards));
  for (let i = 1; i < scores.length; i++) {
    const prev = scores[i - 1];
    const current = scores[i];
    assert.ok(prev !== undefined && current !== undefined);
    assert.ok(
      current > prev,
      `${examples[i]?.[0]} (${current}) should beat ${examples[i - 1]?.[0]} (${prev})`,
    );
  }
  for (const [index, [name]] of examples.entries()) {
    const s = scores[index];
    assert.ok(s !== undefined);
    assert.equal(categoryName(s), name);
  }
});

test('kickers decide within a category', () => {
  assert.ok(score('Ah Ad Kc Qs Jh') > score('Ah Ad Kc Qs Th'), 'better fifth card wins');
  assert.ok(score('Ah Ad Kc Qs Jh') === score('As Ac Kd Qh Jd'), 'suits are irrelevant');
  assert.ok(score('Kh Kd Ac Qs Jh') < score('Ah Ad 3c 2s 4h'), 'aces up beats kings with an ace kicker');
  // Two pair: high pair, then low pair, then the single kicker.
  assert.ok(score('Kh Kd 3c 3s Ah') > score('Qh Qd Jc Js Ah'));
  assert.ok(score('Kh Kd 3c 3s Ah') > score('Kh Kd 2c 2s Ah'));
  assert.ok(score('Kh Kd 3c 3s Ah') > score('Kh Kd 3c 3s Qh'));
});

test('7-card hands pick the best five', () => {
  // Board pairs but the flush is better.
  const s = evaluate(hand('Ah Kh 2h 7h 9h 2c 2d'));
  assert.equal(categoryOf(s), HAND_CATEGORY.flush);
  assert.equal(describeScore(s), 'flush, ace high');

  // Two trips in seven cards → the lower trip plays as the pair.
  const boat = evaluate(hand('7h 7d 7c 5s 5h 5d 2c'));
  assert.equal(categoryOf(boat), HAND_CATEGORY.fullHouse);
  assert.equal(describeScore(boat), 'full house, sevens full of fives');

  // Quads plus a pair → quads with the best kicker, not a full house.
  const quads = evaluate(hand('9h 9d 9c 9s Ah Ad 2c'));
  assert.equal(categoryOf(quads), HAND_CATEGORY.fourOfAKind);
  assert.equal(describeScore(quads), 'four of a kind, nines');
});

test('six-card evaluation works (a scenario with a fixed turn)', () => {
  const s = evaluate(hand('Ah Kd Qc Js Th 2c'));
  assert.equal(categoryOf(s), HAND_CATEGORY.straight);
  assert.equal(describeScore(s), 'straight, ace high');
});

test('evaluate rejects card counts it cannot handle', () => {
  assert.throws(() => evaluate(hand('Ah Kd Qc Js')), /needs 5 to 7 cards/);
  assert.throws(() => evaluate(hand('Ah Kd Qc Js Th 9c 8d 7s')), /needs 5 to 7 cards/);
});

test('compareHands reports chops as 0', () => {
  assert.equal(compareHands(score('Ah Kh Qh Jh Th'), score('As Ks Qs Js Ts')), 0);
  assert.equal(compareHands(score('2h 2d 3c 4s 5h'), score('Ah Kd Qc Js 9h')), 1);
  assert.equal(compareHands(score('Ah Kd Qc Js 9h'), score('2h 2d 3c 4s 5h')), -1);
});

test('EXHAUSTIVE: all 2,598,960 five-card hands match the reference evaluator', () => {
  const deck = orderedDeck();
  // Category frequencies for 5 cards from 52 are a published, independently
  // known result. Matching them proves the classifier, not just self-consistency.
  const expectedCounts = new Map<number, number>([
    [HAND_CATEGORY.highCard, 1_302_540],
    [HAND_CATEGORY.pair, 1_098_240],
    [HAND_CATEGORY.twoPair, 123_552],
    [HAND_CATEGORY.threeOfAKind, 54_912],
    [HAND_CATEGORY.straight, 10_200],
    [HAND_CATEGORY.flush, 5_108],
    [HAND_CATEGORY.fullHouse, 3_744],
    [HAND_CATEGORY.fourOfAKind, 624],
    [HAND_CATEGORY.straightFlush, 40],
  ]);

  const actualCounts = new Map<number, number>();
  let total = 0;
  let disagreements = 0;
  const firstFailures: string[] = [];

  // Iterate combinations inline rather than materialising 2.6M arrays.
  for (let a = 0; a < DECK_SIZE; a++) {
    for (let b = a + 1; b < DECK_SIZE; b++) {
      for (let c = b + 1; c < DECK_SIZE; c++) {
        for (let d = c + 1; d < DECK_SIZE; d++) {
          for (let e = d + 1; e < DECK_SIZE; e++) {
            const cards = [a, b, c, d, e];
            const fast = evaluate(cards);
            const reference = referenceEvaluate5(cards);
            total++;
            const category = categoryOf(fast);
            actualCounts.set(category, (actualCounts.get(category) ?? 0) + 1);
            if (category !== reference.category) {
              disagreements++;
              if (firstFailures.length < 5) {
                firstFailures.push(
                  `${cards.map(cardToString).join(' ')}: fast=${categoryName(fast)} reference=${reference.category}`,
                );
              }
            }
          }
        }
      }
    }
  }

  assert.equal(total, 2_598_960, 'combination count');
  assert.equal(disagreements, 0, `category disagreements:\n${firstFailures.join('\n')}`);
  for (const [category, expected] of expectedCounts) {
    assert.equal(
      actualCounts.get(category),
      expected,
      `frequency of category ${category} (${categoryName(category << 20)})`,
    );
  }
  assert.ok(deck.length === DECK_SIZE);
});

test('EXHAUSTIVE: full ordering agrees with the reference on a large random sample', () => {
  // Category agreement above does not prove kicker ordering, so compare the full
  // relative ordering of random pairs of hands.
  const deck = orderedDeck();
  let seed = 0x2f6e2b1;
  const nextInt = (bound: number): number => {
    // xorshift32 — test-only determinism, never used for dealing.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed |= 0;
    return Math.abs(seed) % bound;
  };
  const draw = (count: number): Card[] => {
    const pool = [...deck];
    const out: Card[] = [];
    for (let i = 0; i < count; i++) {
      const index = nextInt(pool.length);
      const [card] = pool.splice(index, 1);
      if (card === undefined) throw new Error('pool exhausted');
      out.push(card);
    }
    return out;
  };

  for (let iteration = 0; iteration < 200_000; iteration++) {
    const left = draw(5);
    const right = draw(5);
    const fastOrder = Math.sign(evaluate(left) - evaluate(right));
    const referenceOrder = Math.sign(compareReference(referenceEvaluate5(left), referenceEvaluate5(right)));
    assert.equal(
      fastOrder,
      referenceOrder,
      `ordering mismatch:\n  ${left.map(cardToString).join(' ')}\n  ${right.map(cardToString).join(' ')}`,
    );
  }
});

test('7-card best-five agrees with brute force over combinations on a random sample', () => {
  let seed = 0x51a3c7d;
  const nextInt = (bound: number): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed |= 0;
    return Math.abs(seed) % bound;
  };
  for (let iteration = 0; iteration < 20_000; iteration++) {
    const pool = orderedDeck();
    const seven: Card[] = [];
    for (let i = 0; i < 7; i++) {
      const [card] = pool.splice(nextInt(pool.length), 1);
      if (card === undefined) throw new Error('pool exhausted');
      seven.push(card);
    }
    const fast = evaluate(seven);
    // Brute force: evaluate every 5-card subset with the fast evaluator and take
    // the max. This checks "picks the best five", independent of the reference.
    let bruteBest = -1;
    for (const combo of combinations(seven, 5)) {
      const s = evaluate(combo);
      if (s > bruteBest) bruteBest = s;
    }
    assert.equal(fast, bruteBest, `7-card best-five mismatch: ${seven.map(cardToString).join(' ')}`);
  }
});
