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
  /**
   * Describes the source, recorded in each hand's audit trail.
   *
   * `deterministic-sampling` is the one value that may NOT deal: `shuffledDeck` refuses it.
   * See `createSamplingRandom` for why a third value exists at all.
   */
  readonly kind: 'csprng' | 'deterministic-test-only' | 'deterministic-sampling';
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

/**
 * A freshly shuffled 52-card deck.
 *
 * This is the single place a deck order comes into existence, which is why the refusal below
 * is here and not spread across the callers. A `deterministic-sampling` source exists so that
 * Monte Carlo estimation can be reproducible (see `createSamplingRandom`); a deck ordered from
 * one would be a hand whose cards a client could predict from a seed it can guess. The two uses
 * are separated by type, so the mistake is not available rather than merely discouraged.
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
  return splitMix32(seed, 'deterministic-test-only');
}

/**
 * A deterministic generator for STATISTICAL SAMPLING. Legal in production; may never deal.
 *
 * ## The incident this exists to close
 *
 * `monteCarloEquity` used `createDeterministicRandomForTests`. That function throws when
 * `NODE_ENV === 'production'`, so every sampled equity estimate failed on a production server —
 * which meant the Coach could not answer and, worse, a bot whose policy needed a sampled
 * estimate never produced an action, so the hand never completed and the table simply stopped.
 * It was invisible for three reasons worth naming, because each one is a lesson:
 *
 *   - every test suite runs with `NODE_ENV` set to `test` or `development`;
 *   - the *exact* enumeration path is unaffected, so the smoke test's equity check passed
 *     while a real hand did not;
 *   - the source scan that forbids the test-only generator (`server-randomness.test.ts`)
 *     scanned `apps/api/src` only, and the call was in `packages/poker-math`.
 *
 * It was found by playing a hand in a production-configured staging stack, which is the only
 * thing that could have found it.
 *
 * ## Why sampling deserves a deterministic source at all
 *
 * Monte Carlo equity is documented as reproducible for a given seed, and that property is
 * load-bearing rather than cosmetic: the worker pool shards one estimate across threads by
 * seed and combines the results, and a learner who re-opens the same analysis must not be
 * shown a different number. Sampling is estimation over a known distribution — it decides
 * nothing about what cards exist — so a predictable stream is not a weakness there.
 *
 * ## Why it is a separate function rather than a flag
 *
 * The two uses have opposite safety requirements, and a boolean parameter would put them one
 * typo apart. Instead they differ by *type*: this source reports `kind: 'deterministic-sampling'`
 * and `shuffledDeck` refuses that kind outright, so a deck can never be ordered from it. The
 * mistake is unavailable rather than discouraged, and `kind` is recorded in the hand's audit
 * trail, so a hand could not be silently mislabelled either.
 *
 * The algorithm is identical to the test-only generator's — same SplitMix32, same stream for a
 * given seed — so no existing expected value changes.
 */
export function createSamplingRandom(seed: number): RandomSource {
  return splitMix32(seed, 'deterministic-sampling');
}

/**
 * SplitMix32, shared by the two deterministic sources above.
 *
 * Small, well-distributed, counter-based. Not secure, and not claimed to be. Factored out so
 * that the two callers cannot drift into producing different streams for the same seed — which
 * would be a silent change to every recorded equity figure.
 */
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
