/**
 * No profile folds a hand it has already won.
 *
 * ## The failure this is written against
 *
 * `policy.ts` mixes a noise floor over the actions it considers plausible:
 *
 *     p_final(a) = (1 - noise) x p_score(a) + noise / plausibleCount
 *
 * and its module comment says why: the floor exists "to keep a style unpredictable, not to make it
 * play worse than any style plays". It excluded exactly one thing — a fold when checking is free.
 *
 * The justification reached further than the exclusion. Facing a BET holding the effective nuts,
 * the score-driven share of a fold is ~0, so the floor became the whole fold probability and every
 * profile folded made hands at `noise / plausibleCount`. Measured before the fix, nut flush
 * (Ah5h on Kh 9h 2h) facing half pot, 40 trials x 12 profiles:
 *
 *     realistic    P(fold) up to 0.075, 10 of 12 profiles folded it at least once
 *     educational  P(fold) up to 0.125, 12 of 12
 *
 * `educational` is the default every Legends page uses and the setting aimed at beginners. The
 * spread across twelve profiles whose `foldToPressure` spans 0.14-0.76 was 0.002 — the trait had no
 * effect and the floor was the number.
 *
 * The second test is the half that stops this becoming a bot that never folds, which would be a
 * worse teaching lie than the first.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROFILES } from '@prl/poker-ai';
import { parseCards } from '@prl/poker-engine';
import { compareProfilesOnSpot } from '../src/rooms/bots.ts';

const PROFILE_IDS = (PROFILES as readonly { readonly naming: { readonly id: string } }[]).map(
  (profile) => profile.naming.id,
);

function foldProbabilities(hero: string, board: string, difficulty: 'realistic' | 'educational') {
  const response = compareProfilesOnSpot({
    spot: {
      heroCards: parseCards(hero),
      board: parseCards(board),
      street: 'flop',
      pot: 300,
      toCall: 100,
      heroStack: 900,
      opponentStack: 900,
      bigBlind: 10,
    },
    profileIds: PROFILE_IDS,
    difficulty,
    trials: 40,
    namingMode: 'attributed',
  });
  return response.entries.map((entry) => ({
    profileId: entry.profileId,
    fold: entry.actionDistribution.find((row) => row.action === 'fold')?.probability ?? 0,
  }));
}

describe('the noise floor does not fund a fold no style would make', () => {
  it('no profile ever folds the effective nuts to a bet (REGRESSION)', () => {
    const offenders: string[] = [];
    let measured = 0;
    for (const difficulty of ['realistic', 'educational'] as const) {
      for (const [hero, board] of [
        ['Ah 5h', 'Kh 9h 2h'],
        ['Kd Kc', 'Ks 9h 2c'],
      ] as const) {
        for (const row of foldProbabilities(hero, board, difficulty)) {
          measured += 1;
          if (row.fold > 0) {
            offenders.push(`${difficulty}/${row.profileId} folds ${hero} on ${board} at ${row.fold}`);
          }
        }
      }
    }
    assert.ok(measured >= 40, `only ${measured} measurement(s); a sweep of nothing is not a pass`);
    assert.deepEqual(offenders, [], offenders.slice(0, 6).join('\n'));
  });

  it('still folds a hand that deserves folding, at both difficulties', () => {
    // Without this, "never folds a lock" is satisfied by a policy that never folds anything.
    for (const difficulty of ['realistic', 'educational'] as const) {
      const rows = foldProbabilities('8c 7d', 'Ah Kd 3s', difficulty);
      const folding = rows.filter((row) => row.fold > 0.2);
      assert.ok(
        folding.length >= rows.length / 2,
        `${difficulty}: only ${folding.length} of ${rows.length} profiles fold 8c7d on a dry ace-king board`,
      );
    }
  });
});
