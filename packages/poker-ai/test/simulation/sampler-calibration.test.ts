/**
 * The sampler draws from the distribution it publishes, for all twelve profiles at all three
 * difficulties. `profile-differentiation.test.ts` checks one combination in depth. This adds breadth
 * because the difficulty noise mixture is renormalised per difficulty, and a regression there leaves
 * the panel showing a distribution the bot does not play.
 *
 * The expected frequencies are `decide`'s own published probabilities, and the z-score is written
 * out here rather than taken from `stats.ts`, which is part of the package under test.
 *
 * Measured over 108 compared actions, the worst deviation is 2.24 standard errors
 * (`adaptive-exploiter` @ `realistic`, `fold`). Lowering `SIGMA_LIMIT` to 2 fails the sweep, so the
 * band is live. Method from `docs/reviews/agent-f-ai-education.md` §3.
 * About four seconds, so it lives under `test/simulation/`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeterministicRandomForTests, redactFor, seatAt, startHand } from '@prl/poker-engine';
import { createOpponentModel } from '../../src/opponent-model.ts';
import { decide } from '../../src/policy.ts';
import { DIFFICULTY_SETTINGS, type Difficulty, expressTraits, PROFILES } from '../../src/profiles.ts';
import { deriveSeed } from '../../src/simulate.ts';

/** Every shipped difficulty. A fourth one fails to compile here. */
const DIFFICULTIES: readonly Difficulty[] = ['educational', 'realistic', 'expert'];

/** Dealt once and shared by all 36 sweeps. */
const SPOT_POOL = 400;

/** Puts the standard error near 0.011. */
const TRIALS = 2_000;

/** The same four-sigma band as the depth test. Seeds are fixed, so the run is deterministic. */
const SIGMA_LIMIT = 4;

/** Calibration at a spot the policy treats as trivial compares 1.000 against 1.000. */
const MIXED_TOP_AT_MOST = 0.85;
const MIXED_SECOND_AT_LEAST = 0.12;

interface Spot {
  readonly seat: number;
  readonly holeCards: readonly [number, number];
  readonly view: ReturnType<typeof redactFor>;
}

/** Its own seed base, so these spots are not the ones the depth test covers. */
function dealSpot(handIndex: number): Spot | null {
  const started = startHand({
    handId: `calibration-${handIndex}`,
    roomId: 'calibration',
    handNumber: handIndex,
    config: { smallBlind: 50, bigBlind: 100, ante: 0, maxSeats: 2, actionTimeoutSeconds: 30 },
    buttonSeat: 0,
    seats: [0, 1].map((seat) => ({ seat, playerId: `p${seat}`, stack: 10_000 })),
    random: createDeterministicRandomForTests(deriveSeed(2, 4_409, handIndex)),
  });
  const state = started.state;
  const seat = state.toAct;
  if (seat === null) return null;
  const holeCards = seatAt(state, seat).holeCards;
  if (holeCards === null) return null;
  return { seat, holeCards, view: redactFor(state, { viewerSeat: seat }) };
}

type Ask = (spot: Spot, seed: number) => ReturnType<typeof decide>;

function firstMixedSpot(spots: readonly Spot[], ask: Ask): Spot | null {
  for (const spot of spots) {
    const sorted = ask(spot, 1)
      .distribution.map((entry) => entry.probability)
      .sort((left, right) => right - left);
    const top = sorted[0] ?? 1;
    const second = sorted[1] ?? 0;
    if (top <= MIXED_TOP_AT_MOST && second >= MIXED_SECOND_AT_LEAST) return spot;
  }
  return null;
}

/**
 * Written out rather than taken from `stats.ts`. A declared 0 or 1 has no standard error, so any
 * discrepancy is infinite, which is correct.
 */
function standardErrors(observed: number, declared: number, trials: number): number {
  const variance = (declared * (1 - declared)) / trials;
  if (variance === 0) return observed === declared ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(observed - declared) / Math.sqrt(variance);
}

test('every profile at every difficulty samples the distribution it publishes', () => {
  const spots: Spot[] = [];
  for (let handIndex = 0; handIndex < SPOT_POOL; handIndex += 1) {
    const spot = dealSpot(handIndex);
    if (spot !== null) spots.push(spot);
  }
  assert.ok(spots.length > 0, 'the fixture deal produced no spot with a seat to act');

  let combinations = 0;
  let comparisons = 0;
  let mixedOutcomes = 0;

  for (const profile of PROFILES) {
    for (const difficulty of DIFFICULTIES) {
      const traits = expressTraits(profile, difficulty);
      const settings = DIFFICULTY_SETTINGS[difficulty];
      const ask: Ask = (spot, seed) =>
        decide({
          view: spot.view,
          holeCards: spot.holeCards,
          seat: spot.seat,
          observations: createOpponentModel(spot.seat),
          traits,
          difficulty: settings,
          random: createDeterministicRandomForTests(seed),
        });

      const where = `${profile.naming.id} @ ${difficulty}`;
      const spot = firstMixedSpot(spots, ask);
      assert.ok(
        spot !== null,
        `${where}: no spot in ${spots.length} deals produced a mixed distribution, so this profile ` +
          'is effectively scripted at this difficulty — which is itself the finding',
      );
      combinations += 1;

      // Averaged over the trials because the policy samples its own equity, so the published
      // probabilities vary slightly by seed.
      const drawn = new Map<string, number>();
      const declared = new Map<string, number>();
      for (let trial = 0; trial < TRIALS; trial += 1) {
        const decision = ask(spot, deriveSeed(3, 8_812, trial));
        drawn.set(decision.action.type, (drawn.get(decision.action.type) ?? 0) + 1);
        for (const entry of decision.distribution) {
          const key = entry.action.type;
          declared.set(key, (declared.get(key) ?? 0) + entry.probability / TRIALS);
        }
      }

      if (drawn.size >= 2) mixedOutcomes += 1;
      assert.ok(
        declared.size >= 2,
        `${where}: the spot was selected for being mixed, so the published distribution must still ` +
          'name more than one action when it is re-asked',
      );

      for (const [action, count] of drawn) {
        const published = declared.get(action) ?? 0;
        const sigmas = standardErrors(count / TRIALS, published, TRIALS);
        comparisons += 1;
        assert.ok(
          sigmas < SIGMA_LIMIT,
          `${where}: ${action} was drawn ${(count / TRIALS).toFixed(4)} of the time against a ` +
            `published ${published.toFixed(4)} — ${sigmas.toFixed(2)} standard errors over ` +
            `${TRIALS} seeds, so the sampler is not drawing from the distribution it reports`,
        );
      }

      // An action the policy published but never played is the other half of the failure.
      for (const [action, published] of declared) {
        if (drawn.has(action)) continue;
        const sigmas = standardErrors(0, published, TRIALS);
        comparisons += 1;
        assert.ok(
          sigmas < SIGMA_LIMIT,
          `${where}: ${action} was published at ${published.toFixed(4)} and drawn zero times in ` +
            `${TRIALS} seeds — ${sigmas.toFixed(2)} standard errors, so the panel offers a line ` +
            'the sampler will never take',
        );
      }
    }
  }

  // A sweep that skipped a profile, or found no mixed spot, would pass by doing nothing.
  assert.equal(
    combinations,
    PROFILES.length * DIFFICULTIES.length,
    'every profile must be measured at every difficulty',
  );
  assert.ok(
    comparisons >= combinations * 2,
    `each of the ${combinations} combinations must contribute at least two compared actions; ` +
      `only ${comparisons} comparisons ran`,
  );
  assert.ok(
    mixedOutcomes === combinations,
    `${combinations - mixedOutcomes} combinations drew a single action across all ${TRIALS} seeds ` +
      'at a spot whose published distribution was mixed, which is a sampler that ignores its weights',
  );
});
