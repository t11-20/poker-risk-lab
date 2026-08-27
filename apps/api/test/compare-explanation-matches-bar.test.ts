/**
 * The compare page's explanation must describe the action its own bar marks.
 *
 * ## The failure this is written against
 *
 * `compareProfilesOnSpot` runs each profile through the same spot `trials` times and reports the
 * DISTRIBUTION — that is the point of the page, because these styles are probabilistic. But
 * `reasoning` was taken from `last`, whatever the final trial happened to draw, while
 * `modalAction` and `actionDistribution` aggregate all forty. They disagree constantly.
 *
 * `/legends/compare` renders the bar and then, directly beneath it, the heading "Why this model
 * prefers that" over `reasoning.modelPreference`. So a reader saw a bar marked `raise` above a
 * sentence beginning "This model prefers to fold here, with 3.3% of its weight" — about a set of
 * sevens. Measured over 12 profiles x 33 spots: 161 of 396 columns. On the page's own default
 * spot, 6 of 12.
 *
 * `drivingTraits` and `whatChangedIt` came from the same trial, so the three parts of the
 * explanation agreed with each other and only the bar was left contradicting them, which is why
 * reading the page did not reveal it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROFILES } from '@prl/poker-ai';
import { parseCards } from '@prl/poker-engine';
import { compareProfilesOnSpot } from '../src/rooms/bots.ts';

const PROFILE_IDS = (PROFILES as readonly { readonly naming: { readonly id: string } }[]).map(
  (profile) => profile.naming.id,
);

/** Boards and hands chosen to share no card, because the builder refuses a duplicate. */
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

    // 72 columns at a measured 40.7% defect rate is ~29 expected disagreements, so the trimmed
    // grid still fails loudly against the old code. Kept small on purpose: this runs 2,880 policy
    // decisions and the `test` gate is already the longest in `verify`.
    assert.ok(columns >= 60, `only ${columns} column(s) compared; a sweep of nothing is not a pass`);
    assert.deepEqual(
      disagreements,
      [],
      `${disagreements.length} of ${columns}:\n${disagreements.slice(0, 6).join('\n')}`,
    );
  });

  it('still reports a real distribution, so the fix did not collapse the page to one action', () => {
    // A `reasoning` block that always matched because every column had become deterministic would
    // satisfy the check above and destroy what the page is for.
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
