/**
 * The CSPRNG and the deck commitments. They are apart from rng.ts because they need `node:crypto`, and
 * a browser page that only samples would otherwise ship its polyfill (`scripts/client-bundle-audit.mjs`).
 */

import { randomFillSync } from 'node:crypto';
import { type Card, DECK_SIZE } from './cards.ts';
import { type CommittedDeck, commitToDeckOrder, SALT_BYTES } from './commitment.ts';
import { RandomnessError, type RandomSource, shuffledDeck, unbiasedInt } from './rng.ts';

const POOL_WORDS = 256;

/** The production source: Node's CSPRNG, buffered so a hand costs one syscall rather than 52. */
export function createSecureRandom(): RandomSource {
  const pool = new Uint32Array(POOL_WORDS);
  let cursor = POOL_WORDS;

  const nextUint32 = (): number => {
    if (cursor >= POOL_WORDS) {
      randomFillSync(pool);
      cursor = 0;
    }
    const value = pool[cursor];
    cursor += 1;
    if (value === undefined) throw new RandomnessError('random pool read out of range');
    return value >>> 0;
  };

  return {
    kind: 'csprng',
    bytes(count: number): Uint8Array {
      if (!Number.isInteger(count) || count < 0) throw new RandomnessError(`invalid byte count ${count}`);
      const out = new Uint8Array(count);
      if (count > 0) randomFillSync(out);
      return out;
    },
    nextInt(boundExclusive: number): number {
      return unbiasedInt(nextUint32, boundExclusive);
    },
  };
}

/** Shuffles a deck and commits to it. Call before dealing a single card. */
export function commitToDeck(context: string, random: RandomSource): CommittedDeck {
  const deck = shuffledDeck(random);
  return commitToDeckOrder(context, deck, random.bytes(DECK_SIZE * SALT_BYTES));
}

/**
 * Commits to a fixed deck, for Scenario Lab hands that deal the same cards to every learner. Same
 * commitment code as a shuffled hand. The hand is labelled `fixed-deck-scenario`.
 */
export function commitToKnownDeck(
  context: string,
  deck: readonly Card[],
  random: RandomSource,
): CommittedDeck {
  if (deck.length !== DECK_SIZE) {
    throw new RandomnessError(`a committed deck must contain ${DECK_SIZE} cards, received ${deck.length}`);
  }
  if (new Set(deck).size !== DECK_SIZE) {
    throw new RandomnessError('a committed deck must be a permutation of 52 distinct cards');
  }
  return commitToDeckOrder(context, deck, random.bytes(DECK_SIZE * SALT_BYTES));
}
