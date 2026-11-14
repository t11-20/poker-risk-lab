/**
 * No profile folds a hand it has already won. `policy.ts` mixes a noise floor over plausible
 * actions, so facing a bet with the nuts the floor can become the whole fold probability: unguarded,
 * `educational` (the Legends default) folds a nut flush up to 0.125 on every profile. The second test
 * keeps the bot from never folding.
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
