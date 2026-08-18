/**
 * An intentionally naive reference evaluator, for cross-checking the fast one.
 *
 * This is written with a deliberately *different* algorithm: sort the ranks,
 * count runs with plain arrays, and compare with tuples of numbers. If both
 * implementations agree across every 5-card hand in the deck, an error would have
 * to exist in both, in the same place, in the same direction — which two
 * unrelated algorithms are very unlikely to do.
 *
 * Test-only. Not exported from the package.
 */

import { type Card, rankIndexOf, suitIndexOf } from '../src/cards.ts';
import { HAND_CATEGORY, type HandCategory } from '../src/evaluate.ts';

export interface ReferenceHand {
  category: HandCategory;
  /** Significant ranks, most significant first. Compared lexicographically. */
  ranks: number[];
}

/** Every k-sized combination of `items`, as arrays. */
export function combinations<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const current: T[] = [];
  const recurse = (start: number): void => {
    if (current.length === k) {
      out.push([...current]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      const item = items[i];
      if (item === undefined) continue;
      current.push(item);
      recurse(i + 1);
      current.pop();
    }
  };
  recurse(0);
  return out;
}

/** Evaluates exactly five cards, the slow readable way. */
export function referenceEvaluate5(cards: readonly Card[]): ReferenceHand {
  if (cards.length !== 5) throw new Error(`referenceEvaluate5 needs 5 cards, got ${cards.length}`);

  const ranks = cards.map(rankIndexOf).sort((a, b) => b - a);
  const suits = cards.map(suitIndexOf);
  const isFlush = suits.every((s) => s === suits[0]);

  // Group ranks by multiplicity, then order by (count desc, rank desc).
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const shape = groups.map((g) => g.count).join('');
  const byShape = groups.map((g) => g.rank);

  // Straight detection on the distinct sorted ranks.
  const distinct = [...new Set(ranks)].sort((a, b) => b - a);
  let straightTop = -1;
  if (distinct.length === 5) {
    const top = distinct[0];
    const bottom = distinct[4];
    if (top !== undefined && bottom !== undefined && top - bottom === 4) straightTop = top;
    // Wheel: A 5 4 3 2 sorts to [12, 3, 2, 1, 0].
    else if (distinct.join(',') === '12,3,2,1,0') straightTop = 3;
  }

  if (isFlush && straightTop >= 0) return { category: HAND_CATEGORY.straightFlush, ranks: [straightTop] };
  if (shape === '41') return { category: HAND_CATEGORY.fourOfAKind, ranks: byShape };
  if (shape === '32') return { category: HAND_CATEGORY.fullHouse, ranks: byShape };
  if (isFlush) return { category: HAND_CATEGORY.flush, ranks };
  if (straightTop >= 0) return { category: HAND_CATEGORY.straight, ranks: [straightTop] };
  if (shape === '311') return { category: HAND_CATEGORY.threeOfAKind, ranks: byShape };
  if (shape === '221') return { category: HAND_CATEGORY.twoPair, ranks: byShape };
  if (shape === '2111') return { category: HAND_CATEGORY.pair, ranks: byShape };
  return { category: HAND_CATEGORY.highCard, ranks };
}

/** Best 5-card hand out of 5, 6 or 7 cards, by brute force over combinations. */
export function referenceEvaluateBest(cards: readonly Card[]): ReferenceHand {
  let best: ReferenceHand | null = null;
  for (const combo of combinations(cards, 5)) {
    const hand = referenceEvaluate5(combo);
    if (best === null || compareReference(hand, best) > 0) best = hand;
  }
  if (best === null) throw new Error('no 5-card combination available');
  return best;
}

/** Lexicographic comparison: category first, then significant ranks. */
export function compareReference(a: ReferenceHand, b: ReferenceHand): number {
  if (a.category !== b.category) return a.category - b.category;
  const length = Math.max(a.ranks.length, b.ranks.length);
  for (let i = 0; i < length; i++) {
    const x = a.ranks[i] ?? -1;
    const y = b.ranks[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}
