/**
 * Randomness and shuffling.
 *
 * Two rules hold everywhere in this package:
 *
 *   1. Cards are only ever dealt from a CSPRNG. `Math.random` is not used, and
 *      `test/rng.test.ts` asserts the call does not appear in `src/`.
 *   2. Index selection is unbiased. Taking `x % n` of a uniform 32-bit draw is
 *      *not* uniform unless n divides 2^32 — for a 52-card deck the low indices
 *      would be very slightly favoured. Rejection sampling removes the bias
 *      exactly rather than approximately.
 *
 * The deck commitment itself lives in commitment.ts.
 *
 * The deterministic generator at the bottom exists for tests and for reproducible
 * teaching scenarios. It refuses to run in production and no dealing path reaches it.
 */

import { randomFillSync } from 'node:crypto';
import { type Card, DECK_SIZE, orderedDeck } from './cards.ts';
import { type CommittedDeck, commitToDeckOrder, SALT_BYTES } from './commitment.ts';

export class RandomnessError extends Error {
  override readonly name = 'RandomnessError';
}

export interface RandomSource {
  /** A uniformly distributed integer in [0, boundExclusive). */
  nextInt(boundExclusive: number): number;
  /** `count` random bytes. */
  bytes(count: number): Uint8Array;
  /** Describes the source, recorded in each hand's audit trail. */
  readonly kind: 'csprng' | 'deterministic-test-only';
}

const POOL_WORDS = 256;

/**
 * The production random source: Node's CSPRNG, buffered so that dealing a hand
 * costs one syscall rather than fifty-two.
 */
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

/**
 * Rejection sampling: discard draws that fall in the final, short "wrap" region of
 * the 32-bit range, so every residue class is equally likely.
 *
 * With bound 52 the rejection probability is (2^32 mod 52) / 2^32 ≈ 1.1e-8, so the
 * loop effectively never iterates — but the guarantee is exact rather than
 * approximate, which is the entire point of doing it this way.
 */
export function unbiasedInt(nextUint32: () => number, boundExclusive: number): number {
  if (!Number.isInteger(boundExclusive) || boundExclusive <= 0) {
    throw new RandomnessError(`bound must be a positive integer, received ${boundExclusive}`);
  }
  if (boundExclusive === 1) return 0;
  const range = 2 ** 32;
  const limit = Math.floor(range / boundExclusive) * boundExclusive;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const draw = nextUint32();
    if (draw < limit) return draw % boundExclusive;
  }
  // Reaching here means the generator is broken (e.g. stuck in the rejection
  // region). Failing loudly beats dealing a biased deck.
  throw new RandomnessError('rejection sampling failed 1000 times — the random source is not uniform');
}

/**
 * Fisher–Yates, descending.
 *
 * Each iteration picks uniformly from the *unshuffled* prefix `[0, i]` inclusive,
 * which is what makes every one of the n! orderings equally likely. Picking from
 * `[0, n)` instead — the classic bug — does not, and biases the result measurably.
 */
export function shuffleInPlace<T>(items: T[], random: RandomSource): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = random.nextInt(i + 1);
    const a = items[i];
    const b = items[j];
    if (a === undefined || b === undefined) throw new RandomnessError('shuffle index out of range');
    items[i] = b;
    items[j] = a;
  }
}

/** A freshly shuffled 52-card deck. */
export function shuffledDeck(random: RandomSource): Card[] {
  const deck = orderedDeck();
  shuffleInPlace(deck, random);
  return deck;
}

/** Shuffles a deck and commits to it. Call before dealing a single card. */
export function commitToDeck(context: string, random: RandomSource): CommittedDeck {
  const deck = shuffledDeck(random);
  return commitToDeckOrder(context, deck, random.bytes(DECK_SIZE * SALT_BYTES));
}

/**
 * Commits to a deck that is already fixed, rather than shuffling one.
 *
 * Used by the Scenario Lab, where a teaching hand must deal identical cards to
 * every learner. The commitment is produced by the same code as a shuffled hand,
 * so the verification a player runs is identical — there is no second, weaker path
 * for scenario hands. The hand is separately labelled `fixed-deck-scenario` so it
 * cannot be mistaken for a fairly dealt one.
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

/**
 * A deterministic generator, for tests and for Scenario Lab hands that must
 * reproduce identically for every learner.
 *
 * NOT for dealing a real hand. It throws if `NODE_ENV === 'production'`, and
 * `apps/api/test/server-randomness.test.ts` asserts that no server source file
 * imports it. Its `kind` is recorded in the hand's audit record, so a hand dealt
 * this way is permanently and visibly labelled.
 */
export function createDeterministicRandomForTests(seed: number): RandomSource {
  if (process.env['NODE_ENV'] === 'production') {
    throw new RandomnessError('createDeterministicRandomForTests must never be used in production');
  }
  if (!Number.isInteger(seed)) throw new RandomnessError('seed must be an integer');
  // SplitMix32: small, well-distributed, counter-based. Not secure, and not
  // claimed to be.
  let state = seed >>> 0;
  const nextUint32 = (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
  return {
    kind: 'deterministic-test-only',
    nextInt(boundExclusive: number): number {
      return unbiasedInt(nextUint32, boundExclusive);
    },
    bytes(count: number): Uint8Array {
      const out = new Uint8Array(count);
      for (let i = 0; i < count; i++) out[i] = nextUint32() & 0xff;
      return out;
    },
  };
}
