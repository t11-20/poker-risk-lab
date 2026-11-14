/**
 * Randomness and shuffling. Cards are dealt only from a CSPRNG, and `test/rng.test.ts` asserts
 * `Math.random` does not appear in `src/`. Index selection uses rejection sampling, because
 * `x % n` of a 32-bit draw favours low indices unless n divides 2^32. The deck commitment lives in
 * commitment.ts. The deterministic generators below never deal.
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
  bytes(count: number): Uint8Array;
  /** Recorded in each hand's audit trail. `shuffledDeck` refuses `deterministic-sampling`. */
  readonly kind: 'csprng' | 'deterministic-test-only' | 'deterministic-sampling';
}

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

/**
 * Rejection sampling over the 32-bit range, so every residue is equally likely. For bound 52 the
 * rejection chance is about 1.1e-8, but the guarantee is exact.
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
  // A generator stuck in the rejection region is broken. Failing beats dealing a biased deck.
  throw new RandomnessError('rejection sampling failed 1000 times — the random source is not uniform');
}

/**
 * Fisher-Yates, descending. Each step picks from the unshuffled prefix `[0, i]`. Picking from
 * `[0, n)` is the classic bug and biases the result.
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

/**
 * A freshly shuffled 52-card deck, the one place a deck order is created. A `deterministic-sampling`
 * deck would be predictable from a guessable seed, so it is refused here.
 */
export function shuffledDeck(random: RandomSource): Card[] {
  if (random.kind === 'deterministic-sampling') {
    throw new RandomnessError(
      'a deterministic-sampling source must never order a deck; it exists for Monte Carlo ' +
        'estimation only, and a hand dealt from it would be predictable from its seed',
    );
  }
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

/**
 * A deterministic generator for tests and reproducible scenarios. Never deals a real hand. It throws
 * when `NODE_ENV === 'production'`, and `apps/api/test/server-randomness.test.ts` asserts no server
 * source imports it.
 */
export function createDeterministicRandomForTests(seed: number): RandomSource {
  if (process.env['NODE_ENV'] === 'production') {
    throw new RandomnessError('createDeterministicRandomForTests must never be used in production');
  }
  return splitMix32(seed, 'deterministic-test-only');
}

/**
 * A deterministic generator for Monte Carlo sampling. Legal in production, never deals.
 *
 * The test-only generator throws in production, and tests never run with `NODE_ENV=production`.
 * Sampling needs a seeded stream because the worker pool shards one estimate by seed and a reopened
 * analysis must show the same number. It is a separate `kind` rather than a flag, so `shuffledDeck`
 * can refuse it by type. Same SplitMix32 stream as the test-only generator.
 */
export function createSamplingRandom(seed: number): RandomSource {
  return splitMix32(seed, 'deterministic-sampling');
}

/** SplitMix32, shared so the two deterministic sources cannot drift apart. Not secure. */
function splitMix32(seed: number, kind: RandomSource['kind']): RandomSource {
  if (!Number.isInteger(seed)) throw new RandomnessError('seed must be an integer');
  let state = seed >>> 0;
  const nextUint32 = (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
  return {
    kind,
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
