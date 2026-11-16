/**
 * Two edges of the side-pot pricing: sampled shards keep the share of each contested pot when they are
 * pooled, and a bet that folding only brings to zero breaks even only if everyone folds.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { combineMonteCarlo, monteCarloEquity } from '../src/equity.ts';
import { breakEvenFoldRate } from '../src/ev.ts';
import { exactRange } from '../src/ranges.ts';

// Hero's queens against aces and a lower pair on the turn: hero loses to the aces most of the time
// but beats the sevens, so the pot only the sevens contest is worth far more to hero than the whole.
const spec = {
  players: [
    { label: 'you', range: exactRange(parseCards('Qs Qd')) },
    { label: 'aces', range: exactRange(parseCards('Ac Ad')) },
    { label: 'sevens', range: exactRange(parseCards('7s 7d')) },
  ],
  board: parseCards('2h 5c 9d Jh'),
  contests: [[2]],
} as const;

test('pooled shards keep the share of a pot only some opponents contest, weighted by trials', () => {
  const small = monteCarloEquity(spec, { samples: 2_000, seed: 3 });
  const large = monteCarloEquity(spec, { samples: 6_000, seed: 7 });
  const one = small.contestShares?.[0];
  const two = large.contestShares?.[0];
  assert.ok(one !== undefined && two !== undefined, 'each shard reports the contested share');
  assert.deepEqual(combineMonteCarlo([small]).contestShares, small.contestShares, 'one shard is itself');
  const pooled = combineMonteCarlo([small, large]).contestShares?.[0];
  assert.ok(pooled !== undefined, 'the pooled result keeps the contested share');
  assert.ok(Math.abs(pooled - (one * 2_000 + two * 6_000) / 8_000) < 1e-12, `pooled ${pooled}`);
});

test('shards that disagree on contests are refused rather than silently pooled', () => {
  const withContests = monteCarloEquity(spec, { samples: 500, seed: 1 });
  const { contests: _dropped, ...plain } = spec;
  const without = monteCarloEquity(plain, { samples: 500, seed: 2 });
  assert.throws(() => combineMonteCarlo([withContests, without]), /contest/u);
});

test('a bet that a fold only brings to zero breaks even only if everyone folds', () => {
  assert.deepEqual(breakEvenFoldRate(0, -10), { kind: 'at-least', rate: 1 });
  // Control: a fold that still loses can never be enough.
  assert.equal(breakEvenFoldRate(-5, -10).kind, 'never');
});
