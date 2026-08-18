/**
 * The sampler draws from the distribution it publishes — for every profile, at every difficulty.
 *
 * ## What this adds that `profile-differentiation.test.ts` does not
 *
 * That file already asserts this invariant, and asserts it well: 'a fixed spot produces several
 * different actions, in the proportions the policy declared' takes 3,000 seeds at one spot and holds
 * every sampled frequency inside four standard errors of the distribution `decide` reported for the
 * same spot. What it covers is one profile (`adaptive-exploiter`) at one difficulty (`realistic`) —
 * one of the thirty-six combinations the app actually ships.
 *
 * Depth there, breadth here. `PolicyDecision.distribution` is normalised *after* the difficulty
 * noise mixture (`policy.ts:1307` mixes the scores with the uniform distribution over plausible
 * actions, weighted by `DifficultySettings.noise`), and that mixture is the one step in the sampling
 * path that differs across difficulties: 0.18 at `educational`, 0.10 at `realistic`. A regression in
 * how the mixed weights are renormalised, or in how one profile's trait expression feeds them, is
 * invisible to a single-combination test and is exactly the kind of error a learner cannot detect —
 * the panel would still report a distribution, and the bot would simply not be playing it.
 *
 * So this sweeps all twelve profiles across all three difficulties, and asserts the same thing at
 * each: what came out matches what was published, within the same four-sigma band the depth test
 * uses. The band is deliberately identical so the two cannot drift apart in strictness.
 *
 * ## The independent ground truth, and why it is independent
 *
 * The expected frequencies are not a table of numbers written here, and they are not read from
 * `traits.ts` or any other source constant. They are `decide`'s own published
 * `distribution[].probability`, averaged over the same trials — so the claim under test is purely
 * internal consistency between what the policy *says* it will do and what it *does*. Nothing about
 * poker correctness is asserted, and nothing needs to be: a policy is free to publish any
 * distribution it likes, and this file only insists that it then obeys it.
 *
 * The comparison itself is a two-proportion normal deviate recomputed from the formula in this
 * file — `|p_observed - p_declared| / sqrt(p_declared (1 - p_declared) / n)` — rather than through
 * `stats.ts`'s `zStatistic` or `deviationInStandardErrors`. That independence is the point of the
 * file. `stats.ts` is itself part of the package under test, and a test that measured
 * `poker-ai`'s sampler with `poker-ai`'s own statistics would agree with a shared error in both.
 *
 * ## Provenance
 *
 * This is the surviving invariant from one of four throwaway probe suites written by the release
 * review's AI/education reviewer and since deleted by them (see `docs/reviews/agent-e-testing.md`
 * §0 for the contamination they caused, and `docs/reviews/agent-f-ai-education.md` §3 for the
 * method and the measured result: twelve profiles across three difficulties, sampled against the
 * policy's own pre-sampling distribution, worst deviation 2.57 standard errors and nothing beyond
 * four). The probe files themselves are gone; what is reconstructed here is that method, at this
 * file's own seeds and its own fixture deal, and re-measured over all 108 compared actions — worst
 * deviation **2.24 standard errors** (`adaptive-exploiter` @ `realistic`, `fold` drawn 0.1340 of the
 * time against a published 0.1179).
 *
 * The band was confirmed to be a live threshold rather than a decoration by lowering `SIGMA_LIMIT`
 * to 2 and re-running: the sweep fails, on the first comparison past the lowered band
 * (`vocal-aggressor` @ `realistic`, `fold` 0.1220 against 0.1079, 2.03 standard errors). So the
 * assertion is reached with real measurements on every combination, and the four-sigma band is
 * roughly 1.8x the largest deviation this sampler actually produces.
 *
 * The reviewer's other three probes are not reconstructed, because the permanent suite already
 * covers what they asserted: whole-`PolicyInput` read instrumentation (`no-hidden-information.test.ts`
 * checks the serialised input for hidden fields and instruments the view's read set, and
 * `opponent-model.test.ts` proves `observations` never carries an unshown hand); a two-proportion
 * z-test over a profile sweep (`stats.test.ts` recomputes the pooled statistic from first principles
 * and `profile-differentiation.test.ts` separates the extremes on VPIP, aggression and 3-bet
 * frequency at alpha = 0.001); and decision-quality outcome independence (`comparison.test.ts`,
 * 'decision quality is identical against two different outcomes').
 *
 * ## Why it lives in `test/simulation/`
 *
 * The sweep is 36 combinations x 2,000 decisions and takes about four seconds — comparable to the
 * whole of the rest of this package's default suite. `profile-differentiation.test.ts` explains the
 * rule this follows: the package's `test` script globs `test/*.test.ts`, one level only, so putting
 * a slow test in this directory is what keeps it out of every default run. It runs from
 * `pnpm --filter @prl/poker-ai test:simulation`, alongside the depth test it complements.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeterministicRandomForTests, redactFor, seatAt, startHand } from '@prl/poker-engine';
import { createOpponentModel } from '../../src/opponent-model.ts';
import { decide } from '../../src/policy.ts';
import { DIFFICULTY_SETTINGS, type Difficulty, expressTraits, PROFILES } from '../../src/profiles.ts';
import { deriveSeed } from '../../src/simulate.ts';

/** Every difficulty the app ships, so a fourth one cannot be added without this list failing to compile. */
const DIFFICULTIES: readonly Difficulty[] = ['educational', 'realistic', 'expert'];

/** How many heads-up deals to draw the fixture spots from. Dealt once and shared by all 36 sweeps. */
const SPOT_POOL = 400;

/** Seeds per combination. 2,000 is the reviewer's figure, and puts the standard error near 0.011. */
const TRIALS = 2_000;

/**
 * The same band as the depth test in `profile-differentiation.test.ts`, for the same reason: with at
 * most five actions compared a four-sigma band catches a sampler that ignores its own weights while
 * leaving a suite that must not flake far from its threshold. Every seed here is fixed, so the run
 * is deterministic rather than merely unlikely to fail; the band sizes how wrong "wrong" has to be,
 * and the headroom is recorded in this file's header.
 */
const SIGMA_LIMIT = 4;

/**
 * A spot is "mixed" when the policy itself published a real choice there. Asserting calibration at a
 * spot the policy considers trivial would compare 1.000 against 1.000 and prove nothing.
 */
const MIXED_TOP_AT_MOST = 0.85;
const MIXED_SECOND_AT_LEAST = 0.12;

interface Spot {
  readonly seat: number;
  readonly holeCards: readonly [number, number];
  readonly view: ReturnType<typeof redactFor>;
}

/**
 * One heads-up preflop spot, seen by the seat that has to act.
 *
 * Its own seed base, so the spots swept here are not the ones the depth test already covers — two
 * tests of the same invariant over the same deal would share any blind spot in the fixture.
 */
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

/** The first spot in the pool where this profile at this difficulty publishes a genuine mixture. */
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
 * |p_observed - p_declared| in units of the standard error of p_declared over `TRIALS` draws.
 *
 * Written out here rather than taken from `stats.ts` so that the measurement does not share code
 * with the package it is measuring. A declared probability of exactly 0 or 1 has no standard error,
 * so any discrepancy at all is infinitely many of them — which is the right answer: an action the
 * policy said was impossible must never be drawn, and one it said was certain must always be.
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

      // The published distribution is averaged over the same trials rather than read once: the
      // policy samples its own equity assessment, so the probabilities it reports move slightly
      // from seed to seed and a single reading would be one draw of the expectation, not the
      // expectation.
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

      // The loop above cannot see an action the policy promised and then never played, which is the
      // other half of the same failure and the more damaging half: the panel shows a line the bot
      // will not take.
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

  // Coverage counters, asserted rather than logged: a sweep that silently skipped a profile, or one
  // where every spot resolved to a single action, would otherwise pass by doing nothing.
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
