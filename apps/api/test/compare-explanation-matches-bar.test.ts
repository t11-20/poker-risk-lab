/**
 * The compare page's explanation must describe the action its bar marks. `reasoning` came from the
 * last trial while the bar aggregates all of them, and they disagreed in 161 of 396 columns
 * (12 profiles x 33 spots).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROFILES } from '@prl/poker-ai';
import { parseCards } from '@prl/poker-engine';
import { compareProfilesOnSpot } from '../src/rooms/bots.ts';

const PROFILE_IDS = (PROFILES as readonly { readonly naming: { readonly id: string } }[]).map(
  (profile) => profile.naming.id,
);

/** No shared cards, because the builder refuses a duplicate. */
const SPOTS: readonly (readonly [string, string])[] = [
  ['Kd 7h 2h', 'Ah Jh'],
  ['Kd 7h 2h', '7s 7d'],
  ['As 9c 4d', 'Kh Qh'],
];

describe('the compare page explains the action it marks', () => {
  it('never names an action other than the modal one (REGRESSION)', () => {
    const disagreements: string[] = [];
    let columns = 0;

    for (const [board, hero] of SPOTS) {
      for (const pot of [210, 90]) {
        const response = compareProfilesOnSpot({
          spot: {
            heroCards: parseCards(hero),
            board: parseCards(board),
            street: 'flop',
            pot,
            toCall: Math.round(pot * 0.4),
            heroStack: 900,
            opponentStack: 900,
            bigBlind: 10,
          },
          profileIds: PROFILE_IDS,
          difficulty: 'realistic',
          trials: 40,
          namingMode: 'attributed',
        });

        for (const entry of response.entries) {
          columns += 1;
          const named = /prefers to (\w+)/u.exec(entry.reasoning.modelPreference)?.[1];
          if (named !== undefined && named !== entry.modalAction) {
            disagreements.push(
              `${entry.profileId} ${hero} on ${board}, pot ${pot}: the bar marks ` +
                `"${entry.modalAction}" and the sentence says "${named}"`,
            );
          }
        }
      }
    }

    // At the measured 40.7% defect rate, 72 columns expect about 29 failures on the old code.
    assert.ok(columns >= 60, `only ${columns} column(s) compared; a sweep of nothing is not a pass`);
    assert.deepEqual(
      disagreements,
      [],
      `${disagreements.length} of ${columns}:\n${disagreements.slice(0, 6).join('\n')}`,
    );
  });

  it('still reports a real distribution, so the fix did not collapse the page to one action', () => {
    // Columns must stay probabilistic, or the check above passes while the page loses its point.
    const response = compareProfilesOnSpot({
      spot: {
        heroCards: parseCards('Ah Jh'),
        board: parseCards('Kd 7h 2h'),
        street: 'flop',
        pot: 210,
        toCall: 84,
        heroStack: 900,
        opponentStack: 900,
        bigBlind: 10,
      },
      profileIds: PROFILE_IDS,
      difficulty: 'realistic',
      trials: 40,
      namingMode: 'attributed',
    });
    const spread = response.entries.filter((entry) => entry.actionDistribution.length > 1);
    assert.ok(
      spread.length >= response.entries.length / 2,
      `only ${spread.length} of ${response.entries.length} profiles showed more than one action`,
    );
  });
});
