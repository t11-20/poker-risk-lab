/**
 * The sampled equity path must work under `NODE_ENV=production`, where
 * `createDeterministicRandomForTests` throws. Every other suite runs as `test` or `development`, so
 * each case here sets `production`. The cases call `monteCarloEquity` directly, because `equity()`
 * picks the exact path for small matchups. Reverting `equity.ts` to the test generator fails 4 of 6.
 * `NODE_ENV` is restored in a `finally` because the runner shares one process across files.
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
 * A known hand against a wide pre-flop range with no board, far past where enumeration is
 * practical. Built fresh per call so no case can mutate another's spec.
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
    // Both generators share one SplitMix32, so no number may move. A divergence would change every
    // recorded equity figure and fixture.
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
    // `elapsedMs` is wall-clock, so only the numbers are compared.
    assert.deepEqual(
      second.players.map((player) => [player.label, player.win, player.tie, player.equity]),
      first.players.map((player) => [player.label, player.win, player.tie, player.equity]),
      'a seeded estimate must be repeatable',
    );
    assert.equal(second.trials, first.trials);
  });

  it('and a different seed genuinely moves the estimate, so the seed is not being ignored', () => {
    // Without this, a constant stream would pass every case above.
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
