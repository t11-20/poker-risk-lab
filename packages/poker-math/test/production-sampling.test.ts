/**
 * Regression test: the sampled equity path must work when `NODE_ENV` is `production`.
 *
 * ## The defect
 *
 * `monteCarloEquity` created its generator with `createDeterministicRandomForTests`, and that
 * function throws outright when `NODE_ENV === 'production'` — correctly, because a hand dealt
 * from a seeded stream would be predictable. The consequence was that on a production server
 * every sampled equity estimate threw. The Coach could not answer, and a bot whose policy needed
 * a sampled estimate never produced an action, so the hand never completed and the table stopped.
 *
 * ## Why nothing caught it, which is the part worth keeping
 *
 * Three independent reasons, each of which this file is built to defeat:
 *
 *   1. Every suite in this repository runs with `NODE_ENV` set to `test` or `development`, so
 *      the guard that fired in production never fired anywhere it could be seen. **This file
 *      therefore sets `NODE_ENV` to `production` for the duration of each case.**
 *   2. The *exact* enumeration path is unaffected, and `equity()` chooses exact for small
 *      matchups. So the smoke test's equity check passed while a real hand did not. **The cases
 *      below call `monteCarloEquity` directly rather than through `equity()`**, so the choice
 *      cannot route around the thing under test.
 *   3. The source scan that forbids the test-only generator on a request path
 *      (`apps/api/test/server-randomness.test.ts`) scanned `apps/api/src` only, and the call was
 *      in `packages/poker-math`. That scan has since been widened; this file is the behavioural
 *      half of the same fix, and the behavioural half is the one that would have failed.
 *
 * It was found by playing a hand in a production-configured staging stack — the only thing that
 * could have found it — which is why a production-shaped assertion now lives in the unit suite.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Yes. Reverting `equity.ts` to `createDeterministicRandomForTests` fails 4 of the 6 cases below
 * with `RandomnessError: createDeterministicRandomForTests must never be used in production`.
 * That was run, not assumed.
 *
 * ## Why `NODE_ENV` is restored in a `finally`
 *
 * The runner shares one process across files (`--test-concurrency=1`), and a leaked
 * `NODE_ENV=production` would silently change the behaviour of every later file — including
 * config parsing, which refuses several development settings in production. A test that breaks
 * unrelated tests is worse than the bug it guards.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSamplingRandom, parseCards, RandomnessError, shuffledDeck } from '@prl/poker-engine';
import { type EquitySpec, monteCarloEquity } from '../src/equity.ts';
import { exactRange, parseRange } from '../src/ranges.ts';

/** Runs `fn` with `NODE_ENV` set to `value`, restoring whatever was there before. */
function withNodeEnv<T>(value: string, fn: () => T): T {
  const previous = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previous;
  }
}

/**
 * A matchup wide enough that nobody could mistake it for the exact path.
 *
 * A known hand against a wide pre-flop range, with no board — far past the point where
 * enumeration is practical, which is exactly the case a live bot hits and the case that was
 * broken. Built fresh per call, matching `equity.test.ts`, so no case can mutate another's spec.
 */
function spec(): EquitySpec {
  const hero = parseCards('Ah Kh');
  return {
    players: [
      { label: 'hero', range: exactRange(hero) },
      { label: 'villain', range: parseRange('22+, A2s+, KTs+, QJs, A9o+, KQo', hero) },
    ],
    board: [],
  };
}

describe('sampled equity under a production NODE_ENV', () => {
  it('produces an estimate instead of throwing', () => {
    const result = withNodeEnv('production', () => monteCarloEquity(spec(), { samples: 2_000, seed: 7 }));

    assert.equal(result.players.length, 2, 'one entry per player');
    for (const player of result.players) {
      assert.ok(
        player.equity >= 0 && player.equity <= 1,
        `equity must be a probability, got ${player.equity}`,
      );
    }
    const total = result.players.reduce((sum, player) => sum + player.equity, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `equities must sum to 1, got ${total}`);
  });

  it('gives the same answer in production as it does in development, for the same seed', () => {
    // The two generators share one SplitMix32 implementation, so the fix must not have moved any
    // number. If this ever diverges, every recorded equity figure and every fixture built from
    // one has silently changed.
    const development = withNodeEnv('development', () =>
      monteCarloEquity(spec(), { samples: 2_000, seed: 7 }),
    );
    const production = withNodeEnv('production', () => monteCarloEquity(spec(), { samples: 2_000, seed: 7 }));

    assert.deepEqual(
      production.players.map((player) => player.equity),
      development.players.map((player) => player.equity),
      'the same seed must produce the same estimate whatever NODE_ENV says',
    );
  });

  it('is still reproducible for a seed, which is what the worker pool shards on', () => {
    const first = withNodeEnv('production', () => monteCarloEquity(spec(), { samples: 1_000, seed: 11 }));
    const second = withNodeEnv('production', () => monteCarloEquity(spec(), { samples: 1_000, seed: 11 }));
    // The numbers, not the whole result: `elapsedMs` is wall-clock and differs between two
    // identical runs, so comparing the objects would assert that the machine is deterministic
    // rather than that the sampler is.
    assert.deepEqual(
      second.players.map((player) => [player.label, player.win, player.tie, player.equity]),
      first.players.map((player) => [player.label, player.win, player.tie, player.equity]),
      'a seeded estimate must be repeatable',
    );
    assert.equal(second.trials, first.trials);
  });

  it('and a different seed genuinely moves the estimate, so the seed is not being ignored', () => {
    // Without this, a generator that returned a constant stream would pass every case above.
    const a = withNodeEnv('production', () => monteCarloEquity(spec(), { samples: 1_000, seed: 11 }));
    const b = withNodeEnv('production', () => monteCarloEquity(spec(), { samples: 1_000, seed: 12 }));
    assert.notDeepEqual(b.players[0]?.equity, a.players[0]?.equity, 'the seed must be used');
  });
});

describe('a sampling source may estimate but may never deal', () => {
  it('refuses to order a deck, in every environment', () => {
    for (const environment of ['development', 'test', 'production']) {
      assert.throws(
        () => withNodeEnv(environment, () => shuffledDeck(createSamplingRandom(1))),
        RandomnessError,
        `a sampling source must not be able to order a deck under NODE_ENV=${environment}`,
      );
    }
  });

  it('labels itself, so a hand could never be silently mislabelled', () => {
    assert.equal(createSamplingRandom(1).kind, 'deterministic-sampling');
  });
});
