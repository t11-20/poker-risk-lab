/**
 * Hand evaluation.
 *
 * `evaluate()` takes any 5, 6 or 7 card set and returns a single integer score
 * where a larger score is a strictly better hand, and two equal scores are a
 * genuine tie (a chop). One function serves the 7-card game path, the 5-card
 * enumeration used in tests, and the 6-card case that shows up when a scenario
 * fixes a turn card.
 *
 * ## How the score is packed
 *
 *     bits 20..23   category  (0 high card .. 8 straight flush)
 *     bits 16..19   first  significant rank
 *     bits 12..15   second significant rank
 *     bits  8..11   third
 *     bits  4.. 7   fourth
 *     bits  0.. 3   fifth
 *
 * The five rank nibbles are the hand's ranks in order of significance, so a
 * plain integer comparison implements the full comparison rules including
 * kickers. Unused nibbles are zero, which is safe because rank index 0 means
 * "deuce" and a deuce only ever appears in a nibble that is actually used.
 *
 * ## Why no arrays
 *
 * Rank counts are kept in four 13-bit "lanes" (`atLeast1..atLeast4`) rather than
 * a `count[13]` array. Bit r of `atLeast3` means "rank r appears at least three
 * times". This is both faster in the Monte Carlo inner loop and avoids indexed
 * array reads, which under this repo's `noUncheckedIndexedAccess` would each need
 * an undefined check.
 */

import { type Card, NUM_RANKS, rankIndexOf, rankName, suitIndexOf } from './cards.ts';

export const HAND_CATEGORY = {
  highCard: 0,
  pair: 1,
  twoPair: 2,
  threeOfAKind: 3,
  straight: 4,
  flush: 5,
  fullHouse: 6,
  fourOfAKind: 7,
  straightFlush: 8,
} as const;

export type HandCategory = (typeof HAND_CATEGORY)[keyof typeof HAND_CATEGORY];

export const HAND_CATEGORY_NAMES = [
  'high card',
  'pair',
  'two pair',
  'three of a kind',
  'straight',
  'flush',
  'full house',
  'four of a kind',
  'straight flush',
] as const;

/** A packed hand score. Compare with `<`, `>`, `===`. */
export type HandScore = number;

const CATEGORY_SHIFT = 20;

export class HandEvaluationError extends Error {
  override readonly name = 'HandEvaluationError';
}

/**
 * Number of set bits in a 13-bit rank mask.
 *
 * The canonical 32-bit SWAR popcount, applied to the masked value. Deliberately
 * not a "13-bit optimised" variant with truncated constants — the standard
 * constants are provably correct and the saving would be unmeasurable.
 */
export function popCount13(mask: number): number {
  let m = mask & 0x1fff;
  m = m - ((m >> 1) & 0x55555555);
  m = (m & 0x33333333) + ((m >> 2) & 0x33333333);
  m = (m + (m >> 4)) & 0x0f0f0f0f;
  return Math.imul(m, 0x01010101) >>> 24;
}

/** Index of the highest set bit, or -1 for an empty mask. */
export function highestRank(mask: number): number {
  if ((mask & 0x1fff) === 0) return -1;
  return 31 - Math.clz32(mask & 0x1fff);
}

/**
 * Top rank of the best straight in `mask`, or -1 if there is none.
 *
 * The wheel (A-2-3-4-5) reports a top rank of 3 (the five), which is exactly
 * what makes it compare below every other straight — a 6-high straight reports 4.
 */
export function straightHigh(mask: number): number {
  const m = mask & 0x1fff;
  // Five consecutive ranks, scanning from the top so the first hit is the best.
  for (let high = NUM_RANKS - 1; high >= 4; high--) {
    const window = 0b11111 << (high - 4);
    if ((m & window) === window) return high;
  }
  // Wheel: ace (bit 12) plus 2,3,4,5 (bits 0..3).
  const wheel = (1 << 12) | 0b1111;
  if ((m & wheel) === wheel) return 3;
  return -1;
}

/** Packs up to five rank nibbles, most significant first. */
function pack(category: HandCategory, r1: number, r2 = 0, r3 = 0, r4 = 0, r5 = 0): HandScore {
  return (
    (category << CATEGORY_SHIFT) |
    ((r1 & 0xf) << 16) |
    ((r2 & 0xf) << 12) |
    ((r3 & 0xf) << 8) |
    ((r4 & 0xf) << 4) |
    (r5 & 0xf)
  );
}

/** The `count` highest ranks in `mask`, packed into consecutive nibbles. */
function packTop(category: HandCategory, mask: number, count: number, prefix: number[] = []): HandScore {
  const ranks = [...prefix];
  let remaining = mask & 0x1fff;
  while (ranks.length < 5 && remaining !== 0 && ranks.length - prefix.length < count) {
    const top = 31 - Math.clz32(remaining);
    ranks.push(top);
    remaining &= ~(1 << top);
  }
  return pack(category, ranks[0] ?? 0, ranks[1] ?? 0, ranks[2] ?? 0, ranks[3] ?? 0, ranks[4] ?? 0);
}

/**
 * Evaluates the best five-card hand available in `cards`.
 *
 * @param cards 5, 6 or 7 distinct cards. Duplicates are NOT checked here — that
 *   is enforced at the engine boundary by `assertDistinctCards`, because this
 *   function sits in the Monte Carlo inner loop and must stay allocation-free.
 */
export function evaluate(cards: readonly Card[]): HandScore {
  if (cards.length < 5 || cards.length > 7) {
    throw new HandEvaluationError(`evaluate() needs 5 to 7 cards, received ${cards.length}`);
  }

  // Rank-count lanes: bit r of atLeastN ⇔ rank r appears at least N times.
  let atLeast1 = 0;
  let atLeast2 = 0;
  let atLeast3 = 0;
  let atLeast4 = 0;
  // One 13-bit rank mask per suit.
  let suitC = 0;
  let suitD = 0;
  let suitH = 0;
  let suitS = 0;

  // Iterating (rather than indexing) keeps every read typed as Card.
  for (const card of cards) {
    const bit = 1 << rankIndexOf(card);
    // Order matters: promote from the top lane downwards.
    atLeast4 |= atLeast3 & bit;
    atLeast3 |= atLeast2 & bit;
    atLeast2 |= atLeast1 & bit;
    atLeast1 |= bit;
    switch (suitIndexOf(card)) {
      case 0:
        suitC |= bit;
        break;
      case 1:
        suitD |= bit;
        break;
      case 2:
        suitH |= bit;
        break;
      default:
        suitS |= bit;
        break;
    }
  }

  // --- flush and straight flush ---
  let flushMask = 0;
  if (popCount13(suitC) >= 5) flushMask = suitC;
  else if (popCount13(suitD) >= 5) flushMask = suitD;
  else if (popCount13(suitH) >= 5) flushMask = suitH;
  else if (popCount13(suitS) >= 5) flushMask = suitS;

  if (flushMask !== 0) {
    const sfHigh = straightHigh(flushMask);
    if (sfHigh >= 0) return pack(HAND_CATEGORY.straightFlush, sfHigh);
  }

  // --- four of a kind ---
  if (atLeast4 !== 0) {
    const quad = highestRank(atLeast4);
    const kicker = highestRank(atLeast1 & ~(1 << quad));
    return pack(HAND_CATEGORY.fourOfAKind, quad, kicker < 0 ? 0 : kicker);
  }

  // --- full house ---
  // With seven cards there can be two trips; the lower trip then plays as the pair.
  const trips = atLeast3;
  if (trips !== 0) {
    const topTrip = highestRank(trips);
    const pairCandidates = atLeast2 & ~(1 << topTrip) & 0x1fff;
    if (pairCandidates !== 0) {
      const pair = highestRank(pairCandidates);
      return pack(HAND_CATEGORY.fullHouse, topTrip, pair);
    }
  }

  // --- flush ---
  if (flushMask !== 0) return packTop(HAND_CATEGORY.flush, flushMask, 5);

  // --- straight ---
  const sHigh = straightHigh(atLeast1);
  if (sHigh >= 0) return pack(HAND_CATEGORY.straight, sHigh);

  // --- three of a kind ---
  if (trips !== 0) {
    const trip = highestRank(trips);
    return packTop(HAND_CATEGORY.threeOfAKind, atLeast1 & ~(1 << trip), 2, [trip]);
  }

  // --- two pair ---
  const pairs = atLeast2 & 0x1fff;
  const pairCount = popCount13(pairs);
  if (pairCount >= 2) {
    const high = highestRank(pairs);
    const low = highestRank(pairs & ~(1 << high));
    const kickers = atLeast1 & ~(1 << high) & ~(1 << low);
    return packTop(HAND_CATEGORY.twoPair, kickers, 1, [high, low]);
  }

  // --- one pair ---
  if (pairCount === 1) {
    const pair = highestRank(pairs);
    return packTop(HAND_CATEGORY.pair, atLeast1 & ~(1 << pair), 3, [pair]);
  }

  // --- high card ---
  return packTop(HAND_CATEGORY.highCard, atLeast1, 5);
}

export function categoryOf(score: HandScore): HandCategory {
  return ((score >> CATEGORY_SHIFT) & 0xf) as HandCategory;
}

export function categoryName(score: HandScore): string {
  const name = HAND_CATEGORY_NAMES[categoryOf(score)];
  if (name === undefined) throw new HandEvaluationError(`unknown hand category in score ${score}`);
  return name;
}

/** The five significant rank nibbles, most significant first. */
export function significantRanks(score: HandScore): number[] {
  return [(score >> 16) & 0xf, (score >> 12) & 0xf, (score >> 8) & 0xf, (score >> 4) & 0xf, score & 0xf];
}

/**
 * A readable description, e.g. "flush, ace high" or "two pair, kings and threes".
 * Used in hand review and Coach explanations, so it names the hand the way a
 * player would say it rather than dumping the packed score.
 */
export function describeScore(score: HandScore): string {
  const category = categoryOf(score);
  const [r1 = 0, r2 = 0, r3 = 0] = significantRanks(score);
  switch (category) {
    case HAND_CATEGORY.straightFlush:
      return r1 === 12 ? 'royal flush' : `straight flush, ${rankName(r1)} high`;
    case HAND_CATEGORY.fourOfAKind:
      return `four of a kind, ${rankName(r1, true)}`;
    case HAND_CATEGORY.fullHouse:
      return `full house, ${rankName(r1, true)} full of ${rankName(r2, true)}`;
    case HAND_CATEGORY.flush:
      return `flush, ${rankName(r1)} high`;
    case HAND_CATEGORY.straight:
      return r1 === 3 ? 'straight, five high (the wheel)' : `straight, ${rankName(r1)} high`;
    case HAND_CATEGORY.threeOfAKind:
      return `three of a kind, ${rankName(r1, true)}`;
    case HAND_CATEGORY.twoPair:
      return `two pair, ${rankName(r1, true)} and ${rankName(r2, true)}`;
    case HAND_CATEGORY.pair:
      return `pair of ${rankName(r1, true)}, ${rankName(r2)} kicker`;
    default:
      return `high card ${rankName(r1)}, ${rankName(r2)} ${rankName(r3)} kickers`;
  }
}

/** -1 if `a` loses, 0 on a chop, 1 if `a` wins. */
export function compareHands(a: HandScore, b: HandScore): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
