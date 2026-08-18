/**
 * The fast half of the statistical evidence: the arithmetic, and the harness's bookkeeping.
 *
 * ## Why the harness is tested here rather than in the simulation suite
 *
 * `test/simulation/profile-differentiation.test.ts` runs tens of thousands of hands through the
 * real policies and asks whether the profiles differ. Every one of its numbers is a ratio
 * computed by `stats.ts` out of counters incremented by `simulate.ts`, so a bug in either would
 * not make that suite fail — it would make it report something confident and wrong. That is the
 * worst failure mode available to a measurement harness, and it is the one this file exists to
 * close.
 *
 * So the tests below run `simulate` with a **stub policy** injected through
 * `SimulationHooks.decide`. A stub that always folds, or always calls, produces hand shapes
 * whose correct statistics can be worked out on paper — and then asserted exactly, with no
 * tolerance and no sampling error. "Every seat that folds its small blind ends the run at
 * exactly zero net chips" is a statement about the harness that is either true or false.
 *
 * ## Every number pinned here is pinned against something external
 *
 * The normal critical values are checked against published tables (1.9600, 2.5758, 3.2905). The
 * z-statistic is checked against the pooled-standard-error formula recomputed inline from
 * first principles, so the test would survive a rewrite of `stats.ts` and fail a change to its
 * maths. Spearman's rho is checked against hand-computed values including the tied case, which
 * is precisely where the textbook shortcut formula that `stats.ts` deliberately does not use
 * would give the wrong answer.
 *
 * Nothing here takes minutes. The heavy runs live in `test/simulation/`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEGEND_TRAIT_KEYS } from '@prl/contracts';
import { type Card, parseCards } from '@prl/poker-engine';
import { normalQuantile } from '@prl/poker-math';
import { findImpersonation } from '../src/labelling.ts';
import { isNeutralAssessment, NEUTRAL_ASSESSMENT_BAND, threeBetRaiseShare } from '../src/policy.ts';
import { DIFFICULTY_SETTINGS, requireProfile } from '../src/profiles.ts';
import {
  deriveSeed,
  SIMULATION_EQUITY_SAMPLES,
  type SimulationConfig,
  SimulationError,
  seatStats,
  simulate,
  simulationDifficultySettings,
} from '../src/simulate.ts';
import {
  averageRanks,
  combineCounts,
  compareToDeclared,
  compareToDeclaredTraits,
  describeDivergence,
  holdingIsAir,
  inversePreferredPotFraction,
  normalTwoSidedCriticalValue,
  OBSERVABLE_AXES,
  observedTraitEstimates,
  proportionDeviationInSigmas,
  radarAxes,
  rankByObserved,
  SeatObservations,
  StatsError,
  spearmanRho,
  toObservedStats,
  twoProportionZTest,
} from '../src/stats.ts';
import { baselineTraits, preferredPotFraction, TRAIT_KEYS, type Traits } from '../src/traits.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Two cards, as a tuple, because `holdingIsAir` takes exactly two. */
function hole(text: string): readonly [Card, Card] {
  const cards = parseCards(text);
  const [first, second] = cards;
  if (first === undefined || second === undefined || cards.length !== 2) {
    throw new Error(`"${text}" is not exactly two cards`);
  }
  return [first, second];
}

/** A heads-up run configuration with everything but the policy fixed. */
function headsUp(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return {
    profileIds: ['fundamentals-coach', 'calling-station'],
    difficulty: 'realistic',
    hands: 400,
    seed: 4242,
    startingStack: 10_000,
    smallBlind: 50,
    bigBlind: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The normal critical value
// ---------------------------------------------------------------------------

test('the two-sided critical value matches published normal tables', () => {
  // Standard published values, to four decimal places.
  assert.equal(normalTwoSidedCriticalValue(0.05).toFixed(4), '1.9600');
  assert.equal(normalTwoSidedCriticalValue(0.01).toFixed(4), '2.5758');
  assert.equal(normalTwoSidedCriticalValue(0.001).toFixed(4), '3.2905');
  assert.equal(normalTwoSidedCriticalValue(0.1).toFixed(4), '1.6449');
  // The interquartile point, which is a different part of the curve entirely, so it catches a
  // tail formula that happens to be calibrated only where the conventional alphas sit.
  assert.equal(normalTwoSidedCriticalValue(0.5).toFixed(4), '0.6745');
});

test('the critical value is two-sided, which is the thing the wrapper exists to get right', () => {
  // The one-sided value at alpha is the two-sided value at 2 x alpha. Asserting the relation
  // rather than a number is what would catch `normalQuantile(1 - alpha)` at the call site.
  for (const alpha of [0.05, 0.01, 0.001]) {
    assert.equal(
      normalTwoSidedCriticalValue(alpha).toFixed(9),
      normalQuantile(1 - alpha / 2).toFixed(9),
      `alpha ${alpha} must be split across both tails`,
    );
    assert.ok(
      normalTwoSidedCriticalValue(alpha) > normalQuantile(1 - alpha),
      `the two-sided value at ${alpha} must exceed the one-sided value`,
    );
  }
});

test('the critical value is monotone decreasing in alpha', () => {
  let previous = Number.POSITIVE_INFINITY;
  for (const alpha of [1e-6, 1e-4, 0.001, 0.01, 0.05, 0.1, 0.3, 0.6, 0.9]) {
    const critical = normalTwoSidedCriticalValue(alpha);
    assert.ok(critical < previous, `alpha ${alpha} gave ${critical}, not below ${previous}`);
    previous = critical;
  }
});

test('the critical value rejects an alpha that is not a probability', () => {
  for (const alpha of [0, 1, -0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => normalTwoSidedCriticalValue(alpha), StatsError, `alpha ${alpha} should be rejected`);
  }
});

// ---------------------------------------------------------------------------
// Two-proportion z-test
// ---------------------------------------------------------------------------

test('the z-statistic uses the POOLED standard error, recomputed here from first principles', () => {
  const a = { successes: 300, trials: 1000 };
  const b = { successes: 250, trials: 1000 };
  const p1 = 0.3;
  const p2 = 0.25;
  const pooled = (300 + 250) / 2000;
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / 1000 + 1 / 1000));
  const expected = (p1 - p2) / standardError;

  const result = twoProportionZTest(a, b);
  assert.ok(Math.abs(result.z - expected) < 1e-12, `z was ${result.z}, expected ${expected}`);
  // The unpooled interval formula would give a materially different answer here, which is the
  // mistake the pooled form exists to avoid.
  const unpooled = Math.sqrt((p1 * (1 - p1)) / 1000 + (p2 * (1 - p2)) / 1000);
  assert.ok(Math.abs(standardError - unpooled) > 1e-5, 'this fixture must distinguish the two formulas');
});

test('significance is decided against the critical value, in both directions', () => {
  const result = twoProportionZTest({ successes: 300, trials: 1000 }, { successes: 250, trials: 1000 });
  assert.equal(result.significantAt(0.05), true);
  assert.equal(result.significantAt(0.001), false);

  // Swapping the samples flips the sign and changes nothing about significance: the test is
  // two-sided, and a one-sided implementation would fail here.
  const swapped = twoProportionZTest({ successes: 250, trials: 1000 }, { successes: 300, trials: 1000 });
  assert.ok(Math.abs(swapped.z + result.z) < 1e-12);
  assert.equal(swapped.significantAt(0.05), true);
});

test('two identical proportions produce z = 0 and no significance at any level', () => {
  const result = twoProportionZTest({ successes: 400, trials: 1000 }, { successes: 400, trials: 1000 });
  assert.equal(result.z, 0);
  assert.equal(result.significantAt(0.5), false);
});

test('the degenerate all-successes and all-failures cases report zero rather than Infinity', () => {
  for (const successes of [0, 10]) {
    const result = twoProportionZTest({ successes, trials: 10 }, { successes, trials: 10 });
    assert.equal(result.z, 0, 'a zero pooled variance has no difference to test');
    assert.equal(result.significantAt(0.5), false);
    assert.match(result.note, /pooled variance is zero/);
  }
});

test('the z-test note describes the samples and never impersonates', () => {
  const result = twoProportionZTest({ successes: 123, trials: 456 }, { successes: 78, trials: 456 });
  assert.match(result.note, /123\/456/);
  assert.match(result.note, /pooled/);
  assert.match(result.note, /independent/);
  assert.deepEqual(findImpersonation(result.note), []);
});

test('the z-test rejects impossible samples rather than returning a number', () => {
  assert.throws(
    () => twoProportionZTest({ successes: 5, trials: 0 }, { successes: 1, trials: 10 }),
    StatsError,
  );
  assert.throws(
    () => twoProportionZTest({ successes: 11, trials: 10 }, { successes: 1, trials: 10 }),
    StatsError,
  );
  assert.throws(
    () => twoProportionZTest({ successes: -1, trials: 10 }, { successes: 1, trials: 10 }),
    StatsError,
  );
  assert.throws(
    () => twoProportionZTest({ successes: 1, trials: 10 }, { successes: 1.5, trials: 10 }),
    StatsError,
  );
});

// ---------------------------------------------------------------------------
// Goodness of fit against a declared probability
// ---------------------------------------------------------------------------

test('deviation from an expected proportion is measured in its own standard errors', () => {
  // 520/1000 against an expectation of 0.5: se = sqrt(0.25/1000) = 0.0158, so 0.02 is 1.2649 se.
  assert.equal(proportionDeviationInSigmas(520, 1000, 0.5).toFixed(4), '1.2649');
  assert.equal(proportionDeviationInSigmas(500, 1000, 0.5), 0);
});

test('a degenerate expectation reports 0 or Infinity, never NaN', () => {
  assert.equal(proportionDeviationInSigmas(0, 10, 0), 0);
  assert.equal(proportionDeviationInSigmas(1, 10, 0), Number.POSITIVE_INFINITY);
  assert.equal(proportionDeviationInSigmas(10, 10, 1), 0);
  assert.equal(proportionDeviationInSigmas(9, 10, 1), Number.POSITIVE_INFINITY);
  assert.throws(() => proportionDeviationInSigmas(1, 10, 1.2), StatsError);
});

// ---------------------------------------------------------------------------
// Spearman's rho and ranks
// ---------------------------------------------------------------------------

test('ranks are 1-based and tied values share the average of the ranks they span', () => {
  assert.deepEqual(averageRanks([5, 1, 3, 1]), [4, 1.5, 3, 1.5]);
  assert.deepEqual(averageRanks([7, 7, 7]), [2, 2, 2]);
  assert.deepEqual(averageRanks([1, 2, 3]), [1, 2, 3]);
});

test('rho is +1 for a monotone increasing relation and -1 for a decreasing one', () => {
  assert.equal(spearmanRho([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearmanRho([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  // Monotone but wildly non-linear: rank correlation does not care, and Pearson would.
  assert.equal(spearmanRho([1, 2, 3, 4], [1, 2, 4, 1e9]), 1);
});

test('rho handles ties correctly, where the textbook shortcut formula does not', () => {
  const first = [1, 2, 2, 3];
  const second = [1, 2, 3, 4];
  // Pearson on the rank vectors [1, 2.5, 2.5, 4] and [1, 2, 3, 4] gives 0.948683…
  assert.equal(spearmanRho(first, second).toFixed(6), '0.948683');
  // The shortcut `1 - 6 Σd² / (n³ - n)` gives 0.95 here, so this fixture would catch a
  // regression to it.
  const shortcut = 1 - (6 * (0 + 0.25 + 0.25 + 0)) / (4 ** 3 - 4);
  assert.ok(Math.abs(shortcut - spearmanRho(first, second)) > 1e-4);
});

test('a constant vector has no ordering to correlate, so rho is 0 rather than NaN', () => {
  assert.equal(spearmanRho([1, 1, 1], [1, 2, 3]), 0);
  assert.equal(spearmanRho([1, 2, 3], [4, 4, 4]), 0);
});

test('rho rejects mismatched or degenerate inputs', () => {
  assert.throws(() => spearmanRho([1, 2], [1]), StatsError);
  assert.throws(() => spearmanRho([1], [1]), StatsError);
});

// ---------------------------------------------------------------------------
// Air detection: what makes an aggressive action a bluff
// ---------------------------------------------------------------------------

test('air detection follows its documented rules exactly', () => {
  // Not air: a pocket pair, and a hole card that pairs the board.
  assert.equal(holdingIsAir(hole('AsAd'), parseCards('2c7h9d')), false);
  assert.equal(holdingIsAir(hole('As7d'), parseCards('2c7h9d')), false);
  // Air: two overcards with no pair and no completed hand.
  assert.equal(holdingIsAir(hole('AsKd'), parseCards('2c7h9d')), true);
  // Not air: a flush that uses a hole card.
  assert.equal(holdingIsAir(hole('AsKs'), parseCards('2s7s9s')), false);
  // Not air: a straight that uses a hole card.
  assert.equal(holdingIsAir(hole('AsKd'), parseCards('QcJhTh')), false);
});

test('a hand the board makes for everybody is not showdown value, so it still counts as air', () => {
  // The board itself is a flush. This seat holds no part of it.
  assert.equal(holdingIsAir(hole('Ad2h'), parseCards('3s7s9sTsJs')), true);
  // The board itself is a straight, and neither hole card improves on it or pairs it.
  assert.equal(holdingIsAir(hole('Ks2h'), parseCards('4c5d6h7s8c')), true);
});

test('a draw that has not got there is air, which is what bluffFrequency means', () => {
  // Nut flush draw on the flop: two of the suit held, three on the board.
  assert.equal(holdingIsAir(hole('AsKs'), parseCards('2s7s9d')), true);
  // Open-ended straight draw with no pair.
  assert.equal(holdingIsAir(hole('9h8h'), parseCards('7c6d2s')), true);
});

// ---------------------------------------------------------------------------
// SeatObservations: the denominators
// ---------------------------------------------------------------------------

function decision(
  overrides: Partial<Parameters<SeatObservations['noteDecision']>[0]>,
): Parameters<SeatObservations['noteDecision']>[0] {
  return {
    street: 'preflop',
    toCall: 0,
    potBefore: 150,
    aggressionAvailable: true,
    facingPreflopRaise: false,
    action: 'check',
    cost: 0,
    holdingIsAir: false,
    // Null by default, which is what a harness driven by a stand-in policy supplies: the
    // neutral-assessment denominator then stays empty rather than being filled with a guess.
    assessedRelativeStrength: null,
    ...overrides,
  };
}

test('a hand in which the seat never acted preflop is not a declined entry', () => {
  const seat = new SeatObservations(0, 'fundamentals-coach');
  // Hand one: dealt in, folded to before the turn came round. No preflop decision at all.
  seat.beginHand();
  seat.endHand({ sawFlop: false, showedDown: false, netChips: -100 });
  // Hand two: acted, and folded.
  seat.beginHand();
  seat.noteDecision(decision({ toCall: 50, action: 'fold' }));
  seat.endHand({ sawFlop: false, showedDown: false, netChips: -50 });

  const stats = seat.finalise(100);
  assert.equal(stats.handsDealt, 2, 'both hands were dealt');
  assert.equal(stats.counts.preflopOpportunities, 1, 'only one hand offered a preflop decision');
  assert.equal(stats.vpip, 0);
});

test('checking the big blind option is not a voluntary entry; calling and raising are', () => {
  const build = (action: 'check' | 'call' | 'raise', toCall: number): number => {
    const seat = new SeatObservations(0, 'fundamentals-coach');
    seat.beginHand();
    seat.noteDecision(decision({ action, toCall, ...(action === 'raise' ? { cost: 300 } : {}) }));
    seat.endHand({ sawFlop: true, showedDown: false, netChips: 0 });
    return seat.finalise(100).vpip;
  };
  assert.equal(build('check', 0), 0, 'the chips were already forced in — no choice was made');
  assert.equal(build('call', 50), 1);
  assert.equal(build('raise', 50), 1);
});

test('pfr counts hands, not turns, so raising twice preflop is still one raised hand', () => {
  const seat = new SeatObservations(0, 'volume-grinder');
  seat.beginHand();
  seat.noteDecision(decision({ action: 'raise', toCall: 50, cost: 300 }));
  seat.noteDecision(decision({ action: 'raise', toCall: 600, cost: 900, facingPreflopRaise: true }));
  seat.endHand({ sawFlop: true, showedDown: true, netChips: 500 });
  const stats = seat.finalise(100);
  assert.equal(stats.counts.preflopRaiseHands, 1);
  assert.equal(stats.pfr, 1);
  assert.equal(stats.counts.threeBetOpportunities, 1, 'only the second turn faced a raise');
  // The raw tally lives on `counts` and the top level carries the RATE, under its own name. Asserted
  // as key absence rather than as `stats.threeBets === undefined`: the latter does not typecheck
  // against `SeatSimulationStats` (which is the compiler making the same point), and it would also
  // pass if the key existed holding `undefined`, which is the case worth ruling out.
  assert.equal('threeBets' in stats, false, 'threeBets lives on counts, not on the top level');
  assert.equal(stats.counts.threeBets, 1);
  assert.equal(stats.threeBetFrequency, 1, 'the top level carries the frequency, over the one turn');
});

test('aggression and bluff frequencies are postflop only, over turns where aggression was legal', () => {
  const seat = new SeatObservations(0, 'reading-pressure-specialist');
  seat.beginHand();
  // Preflop aggression must not land in the postflop aggression denominator.
  seat.noteDecision(decision({ action: 'raise', toCall: 50, cost: 300 }));
  // Flop: bet with air.
  seat.noteDecision(
    decision({ street: 'flop', action: 'bet', potBefore: 600, cost: 300, holdingIsAir: true }),
  );
  // Turn: checked with air.
  seat.noteDecision(decision({ street: 'turn', action: 'check', potBefore: 1200, holdingIsAir: true }));
  // River: aggression not available, so this turn is in no aggression denominator at all.
  seat.noteDecision(
    decision({ street: 'river', action: 'call', toCall: 500, potBefore: 1200, aggressionAvailable: false }),
  );
  seat.endHand({ sawFlop: true, showedDown: true, netChips: -800 });

  const stats = seat.finalise(100);
  assert.equal(stats.counts.aggressionOpportunities, 2, 'flop and turn only');
  assert.equal(stats.counts.aggressiveActions, 1);
  assert.equal(stats.aggressionFrequency, 0.5);
  assert.equal(stats.counts.airAggressionOpportunities, 2);
  assert.equal(stats.bluffFrequency, 0.5);
  // 300 into a pot of 600.
  assert.equal(stats.averageBetSizeAsPotFraction, 0.5);
  assert.equal(stats.counts.openingBets, 1, 'the flop action was a bet, not a raise');
  assert.equal(stats.averageOpeningBetAsPotFraction, 0.5);
  assert.equal(stats.counts.facingBetDecisions, 2, 'the preflop raise and the river call, both facing a bet');
  assert.equal(stats.counts.foldsFacingBet, 0);
});

test('the neutral-assessment denominator counts only the band the trait is declared on', () => {
  const seat = new SeatObservations(0, 'patient-technician');
  const { low, high } = NEUTRAL_ASSESSMENT_BAND;
  seat.beginHand();
  // Air by the model's own read: outside the band, so in neither neutral counter.
  seat.noteDecision(
    decision({ street: 'flop', action: 'bet', potBefore: 400, cost: 200, assessedRelativeStrength: 0.1 }),
  );
  // Both edges of the band are inside it — the band is closed, because the policy's own
  // `handFactor` is exactly 1 at both ends.
  seat.noteDecision(
    decision({ street: 'turn', action: 'bet', potBefore: 800, cost: 400, assessedRelativeStrength: low }),
  );
  seat.noteDecision(
    decision({ street: 'river', action: 'check', potBefore: 1600, assessedRelativeStrength: high }),
  );
  seat.endHand({ sawFlop: true, showedDown: true, netChips: 0 });

  const stats = seat.finalise(100);
  assert.equal(stats.counts.aggressionOpportunities, 3, 'all three turns offered aggression');
  assert.equal(stats.aggressionFrequency, 2 / 3, 'the unconditional rate counts every turn');
  assert.equal(stats.counts.neutralAggressionOpportunities, 2, 'only the two inside the band');
  assert.equal(stats.counts.neutralAggressiveActions, 1);
  assert.equal(stats.counts.neutralFolds, 0);
  assert.equal(stats.neutralAggressionFrequency, 0.5);
  assert.equal(isNeutralAssessment(low), true);
  assert.equal(isNeutralAssessment(high), true);
  assert.equal(isNeutralAssessment(low - 1e-9), false);
  assert.equal(isNeutralAssessment(high + 1e-9), false);
  assert.equal(isNeutralAssessment(Number.NaN), false);
});

test('a fold on a neutral read leaves the aggression denominator, because folding is another axis', () => {
  // `foldToPressure` owns folding and has its own row in `OBSERVABLE_AXES`. Leaving folds in
  // this denominator makes the aggression axis read low in proportion to a DIFFERENT declared
  // trait — measured at 0.045 on the profile whose `foldToPressure` is highest — which is the
  // same class of error as comparing a conditional trait against an unconditional rate.
  const seat = new SeatObservations(0, 'disciplined-specialist');
  seat.beginHand();
  const neutral = { assessedRelativeStrength: 0.5, street: 'flop' as const, potBefore: 400 };
  seat.noteDecision(decision({ ...neutral, action: 'bet', cost: 200 }));
  seat.noteDecision(decision({ ...neutral, action: 'call', toCall: 200, cost: 200 }));
  seat.noteDecision(decision({ ...neutral, action: 'fold', toCall: 200 }));
  seat.noteDecision(decision({ ...neutral, action: 'fold', toCall: 200 }));
  seat.endHand({ sawFlop: true, showedDown: false, netChips: -400 });

  const stats = seat.finalise(100);
  assert.equal(stats.counts.neutralAggressionOpportunities, 4);
  assert.equal(stats.counts.neutralFolds, 2);
  assert.equal(stats.counts.neutralAggressiveActions, 1);
  // One bet against one call — the aggressive line against the passive one, folds removed.
  assert.equal(stats.neutralAggressionFrequency, 0.5);
  // Had the folds stayed in, the same behaviour would have read 0.25 and looked like a model
  // half as aggressive as its card.
  assert.equal(stats.counts.neutralAggressiveActions / stats.counts.neutralAggressionOpportunities, 0.25);
});

test('a run with no published assessment reports an empty neutral denominator, not a guess', () => {
  // What a harness driven by a stand-in policy produces. Zero over zero has to read as "no
  // observations", because the alternative — quietly treating an unknown read as neutral —
  // would fill the axis that checks the profile card with numbers from a different model.
  const seat = new SeatObservations(0, 'calling-station');
  seat.beginHand();
  seat.noteDecision(decision({ street: 'flop', action: 'bet', potBefore: 400, cost: 200 }));
  seat.noteDecision(decision({ street: 'turn', action: 'check', potBefore: 800 }));
  seat.endHand({ sawFlop: true, showedDown: false, netChips: -200 });

  const stats = seat.finalise(100);
  assert.equal(stats.counts.aggressionOpportunities, 2);
  assert.equal(stats.counts.neutralAggressionOpportunities, 0);
  assert.equal(stats.neutralAggressionFrequency, 0);
});

test('the 3-bet share is measured over ENTRIES on the entry decision, not over every preflop turn', () => {
  const seat = new SeatObservations(0, 'volume-grinder');

  // Hand one: faces an open on its first voluntary decision and re-raises.
  seat.beginHand();
  seat.noteDecision(decision({ action: 'raise', toCall: 200, cost: 600, facingPreflopRaise: true }));
  // A later preflop turn — a four-bet spot — also faces a raise, but the entry threshold has
  // already been passed, so `threeBetTendency` does not gate it and it must not be pooled in.
  seat.noteDecision(decision({ action: 'call', toCall: 900, cost: 900, facingPreflopRaise: true }));
  seat.endHand({ sawFlop: true, showedDown: true, netChips: 400 });

  // Hand two: faces an open and flat-calls. An entry, not a re-raise.
  seat.beginHand();
  seat.noteDecision(decision({ action: 'call', toCall: 200, cost: 200, facingPreflopRaise: true }));
  seat.endHand({ sawFlop: true, showedDown: false, netChips: -200 });

  // Hand three: faces an open and folds. An opportunity, but not an entry — the entry
  // threshold declined it, which is `vpip`'s business and not this axis's.
  seat.beginHand();
  seat.noteDecision(decision({ action: 'fold', toCall: 200, facingPreflopRaise: true }));
  seat.endHand({ sawFlop: false, showedDown: false, netChips: 0 });

  const stats = seat.finalise(100);
  assert.equal(stats.counts.threeBetOpportunities, 4, 'every preflop turn that faced a raise');
  assert.equal(stats.counts.threeBetEntryOpportunities, 3, 'one per hand: the first voluntary decision');
  assert.equal(stats.counts.threeBetEntries, 2, 'the re-raise and the flat call; the fold entered nothing');
  assert.equal(stats.counts.threeBetEntryRaises, 1);
  assert.equal(stats.threeBetShareOfEntries, 0.5);
  // The unconditional frequency is a different, smaller number over a different denominator,
  // and both are reported.
  assert.equal(stats.counts.threeBets, 1);
  assert.equal(stats.threeBetFrequency, 0.25);
});

test('a raise is pooled into the sizing average but kept out of the opening-bet average', () => {
  // The whole reason the two exist. A raise to 900 on a pot of 600 moves 900 chips (600 of it
  // the call), so it scores 1.5 pot fractions — far above any size a profile would *choose* to
  // bet. Pooling the two is how `betSizingPreference` stops being comparable to its own trait.
  const seat = new SeatObservations(0, 'old-school-pressure');
  seat.beginHand();
  seat.noteDecision(decision({ street: 'flop', action: 'bet', potBefore: 400, cost: 300 }));
  seat.noteDecision(decision({ street: 'turn', action: 'raise', toCall: 600, potBefore: 600, cost: 900 }));
  seat.endHand({ sawFlop: true, showedDown: true, netChips: 0 });

  const stats = seat.finalise(100);
  assert.equal(stats.counts.sizedActions, 2);
  assert.equal(stats.counts.openingBets, 1);
  // (300/400 + 900/600) / 2 = (0.75 + 1.5) / 2
  assert.equal(stats.averageBetSizeAsPotFraction, 1.125);
  assert.equal(stats.averageOpeningBetAsPotFraction, 0.75);
  // And the axis reads the one the trait is about: 0.75 inverts to (0.75 - 0.25) / 1.25 = 0.4.
  const axis = OBSERVABLE_AXES.find((entry) => entry.key === 'betSizingPreference');
  assert.ok(axis !== undefined);
  assert.equal(axis.observedFrom(stats).toFixed(6), '0.400000');
});

test('showdown frequency is measured over hands that saw a flop, not over hands dealt', () => {
  const seat = new SeatObservations(0, 'patient-technician');
  for (const [sawFlop, showedDown] of [
    [false, false],
    [true, false],
    [true, true],
  ] as const) {
    seat.beginHand();
    seat.noteDecision(decision({ toCall: 50, action: 'call', cost: 50 }));
    seat.endHand({ sawFlop, showedDown, netChips: 0 });
  }
  const stats = seat.finalise(100);
  assert.equal(stats.handsDealt, 3);
  assert.equal(stats.counts.flopsSeen, 2);
  assert.equal(stats.wentToShowdown, 0.5);
});

test('bbPer100 and the confidence half-width are computed from the counts they claim', () => {
  const seat = new SeatObservations(3, 'volume-grinder');
  for (let hand = 0; hand < 100; hand++) {
    seat.beginHand();
    seat.noteDecision(decision({ toCall: 50, action: 'call', cost: 50 }));
    seat.endHand({ sawFlop: true, showedDown: true, netChips: hand === 0 ? 500 : 0 });
  }
  const stats = seat.finalise(100);
  assert.equal(stats.netChips, 500);
  // 500 chips at a big blind of 100 is 5 big blinds over 100 hands.
  assert.equal(stats.bbPer100.toFixed(6), '5.000000');
  // 1.959963… x 0.5 / sqrt(100).
  assert.equal(stats.confidenceHalfWidth.toFixed(6), '0.097998');
});

test('a rate with an empty denominator is 0, not NaN', () => {
  const stats = new SeatObservations(0, 'calling-station').finalise(100);
  for (const value of [
    stats.vpip,
    stats.pfr,
    stats.threeBetFrequency,
    stats.aggressionFrequency,
    stats.bluffFrequency,
    stats.wentToShowdown,
    stats.foldToBetFrequency,
    stats.averageBetSizeAsPotFraction,
    stats.averageOpeningBetAsPotFraction,
    stats.bbPer100,
  ]) {
    assert.equal(Number.isNaN(value), false);
    assert.equal(value, 0);
  }
  assert.equal(stats.confidenceHalfWidth, 1, 'no observations means the interval is the whole range');
});

test('the accumulator refuses to be driven out of order', () => {
  const seat = new SeatObservations(0, 'fundamentals-coach');
  assert.throws(() => seat.noteDecision(decision({})), StatsError, 'a decision outside a hand');
  assert.throws(() => seat.endHand({ sawFlop: false, showedDown: false, netChips: 0 }), StatsError);
  seat.beginHand();
  assert.throws(() => seat.beginHand(), StatsError, 'two beginHand calls without an endHand');
  assert.throws(() => seat.finalise(100), StatsError, 'finalise mid-hand');
  assert.throws(() => new SeatObservations(0, 'x').finalise(0), StatsError, 'a big blind of zero');
});

// ---------------------------------------------------------------------------
// Declared versus observed
// ---------------------------------------------------------------------------

/** A finalised stats object with chosen rates, for testing the comparison logic only. */
function statsWith(overrides: Record<string, number>): ReturnType<SeatObservations['finalise']> {
  const seat = new SeatObservations(0, 'fundamentals-coach');
  const base = seat.finalise(100);
  return { ...base, ...overrides };
}

test('toObservedStats carries every wire field and nothing else', () => {
  const observed = toObservedStats(statsWith({ vpip: 0.3, pfr: 0.2, handsDealt: 8000 }));
  assert.deepEqual(Object.keys(observed).sort(), [
    'aggressionFrequency',
    'averageBetSizeAsPotFraction',
    'bluffFrequency',
    'confidenceHalfWidth',
    'foldToBetFrequency',
    'handsObserved',
    'pfr',
    'threeBetFrequency',
    'vpip',
    'wentToShowdown',
  ]);
  assert.equal(observed.handsObserved, 8000);
  assert.equal(observed.vpip, 0.3);
  // The opening-bet average is a measurement detail, not a wire field: `ProfileObservedStats`
  // carries the pooled figure a tracker would show, and the trait comparison uses the other one.
  assert.equal('averageOpeningBetAsPotFraction' in observed, false);
});

test('a profile that behaves exactly as declared has no divergences', () => {
  const traits = requireProfile('fundamentals-coach').traits;
  const stats = statsWith({
    vpip: traits.vpip,
    pfr: traits.vpip * traits.pfrShareOfVpip,
    // The CONDITIONAL rate, because that is the quantity `aggressionFrequency` declares. A
    // model matching its card exactly is not required to bet this often unconditionally — with
    // air it bets at `bluffFrequency` instead, and no vector can satisfy both readings.
    neutralAggressionFrequency: traits.aggressionFrequency,
    bluffFrequency: traits.bluffFrequency,
    // Likewise: the multiplier's own frequency, not the unconditional 3-bet rate, which is
    // capped by how often this profile enters a pot at all.
    threeBetShareOfEntries: threeBetRaiseShare(traits),
    foldToBetFrequency: traits.foldToPressure,
    averageOpeningBetAsPotFraction: preferredPotFraction(traits),
  });
  assert.deepEqual(compareToDeclared('fundamentals-coach', stats).divergences, []);
});

test('the unconditional rates a tracker reports are NOT what the two conditional axes compare', () => {
  // The defect this pair of axes was fixed for, locked as a test: a model that hits its
  // declared value on the condition the trait states, while its unconditional rate sits far
  // below, must report no divergence. Before the fix the same numbers reported two.
  const traits = requireProfile('disciplined-specialist').traits;
  const stats = statsWith({
    vpip: traits.vpip,
    pfr: traits.vpip * traits.pfrShareOfVpip,
    neutralAggressionFrequency: traits.aggressionFrequency,
    aggressionFrequency: 0.331,
    bluffFrequency: traits.bluffFrequency,
    threeBetShareOfEntries: threeBetRaiseShare(traits),
    threeBetFrequency: 0.083,
    foldToBetFrequency: traits.foldToPressure,
    averageOpeningBetAsPotFraction: preferredPotFraction(traits),
  });
  assert.deepEqual(compareToDeclared('disciplined-specialist', stats).divergences, []);
  // And the arithmetic that makes the unconditional reading unsatisfiable is real: at the
  // measured air share, reaching the declared rate unconditionally while honouring the
  // declared bluff frequency would need a rate above 1 on every remaining hand.
  const airShare = 0.6;
  const needed = (traits.aggressionFrequency - airShare * traits.bluffFrequency) / (1 - airShare);
  assert.ok(
    needed > 1,
    `reading this trait as an unconditional rate needs ${needed.toFixed(3)} of the non-air hands bet, ` +
      'which is not a frequency; the old axis definition was unsatisfiable, not merely missed',
  );
});

test('a divergence beyond the documented tolerance is reported, with both numbers', () => {
  const traits = requireProfile('disciplined-specialist').traits;
  const stats = statsWith({ vpip: traits.vpip + 0.4 });
  const { divergences } = compareToDeclared('disciplined-specialist', stats);
  const vpipDivergence = divergences.find((entry) => entry.key === 'vpip');
  assert.ok(vpipDivergence !== undefined, 'a 0.4 gap on vpip must be reported');
  assert.equal(vpipDivergence.declared, traits.vpip);
  assert.equal(vpipDivergence.observed, traits.vpip + 0.4);
});

test('a gap exactly at the tolerance is not a divergence; one past it is', () => {
  const axis = OBSERVABLE_AXES.find((entry) => entry.key === 'vpip');
  assert.ok(axis !== undefined);
  const traits: Traits = baselineTraits();
  const atTolerance = compareToDeclaredTraits(traits, statsWith({ vpip: traits.vpip + axis.tolerance }));
  assert.deepEqual(
    atTolerance.divergences.filter((entry) => entry.key === 'vpip'),
    [],
  );
  const pastTolerance = compareToDeclaredTraits(
    traits,
    statsWith({ vpip: traits.vpip + axis.tolerance + 1e-9 }),
  );
  assert.equal(
    pastTolerance.divergences.some((entry) => entry.key === 'vpip'),
    true,
  );
});

test('every tolerance is wider than the sampling noise it has to absorb at 8,000 hands', () => {
  // 1.959963… x 0.5 / sqrt(8000) = 0.01096. A tolerance below that would be measuring noise.
  const samplingHalfWidth = (normalTwoSidedCriticalValue(0.05) * 0.5) / Math.sqrt(8000);
  for (const axis of OBSERVABLE_AXES) {
    assert.ok(
      axis.tolerance > samplingHalfWidth,
      `${axis.key} allows ${axis.tolerance}, which is inside the ${samplingHalfWidth.toFixed(5)} sampling error`,
    );
    assert.ok(axis.why.length > 40, `${axis.key} must justify its tolerance in prose`);
  }
});

test('every measurable axis names a real trait key and reads back on its own scale', () => {
  for (const axis of OBSERVABLE_AXES) {
    assert.ok(TRAIT_KEYS.includes(axis.key), `${axis.key} is not a trait`);
    const declared = axis.declaredFrom(baselineTraits());
    assert.ok(declared >= 0 && declared <= 1, `${axis.key} declared ${declared} is off the 0..1 scale`);
  }
  const keys = observedTraitEstimates(statsWith({})).map((entry) => entry.key);
  assert.deepEqual(
    keys,
    OBSERVABLE_AXES.map((axis) => axis.key),
  );
});

test('the sizing axis inverts preferredPotFraction exactly, and clamps outside its band', () => {
  for (const value of [0, 0.25, 0.5, 0.75, 1]) {
    const traits: Traits = { ...baselineTraits(), betSizingPreference: value };
    assert.equal(inversePreferredPotFraction(preferredPotFraction(traits)).toFixed(10), value.toFixed(10));
  }
  assert.equal(inversePreferredPotFraction(0.1), 0, 'below the band');
  assert.equal(inversePreferredPotFraction(9), 1, 'above the band');
});

test('a divergence sentence names the axis, both numbers and the reason, and never impersonates', () => {
  const text = describeDivergence({ key: 'vpip', declared: 0.15, observed: 0.4 });
  assert.match(text, /0\.150/);
  assert.match(text, /0\.400/);
  assert.match(text, /this model declares/);
  assert.deepEqual(findImpersonation(text), []);
  assert.throws(() => describeDivergence({ key: 'sizingVariance', declared: 0, observed: 1 }), StatsError);
});

// ---------------------------------------------------------------------------
// The radar view
// ---------------------------------------------------------------------------

test('the radar carries all sixteen axes, in the wire order, with labels and descriptions', () => {
  const axes = radarAxes(requireProfile('adaptive-exploiter').traits);
  assert.equal(axes.length, 16);
  assert.deepEqual(
    axes.map((axis) => axis.key),
    [...LEGEND_TRAIT_KEYS],
  );
  for (const axis of axes) {
    assert.ok(axis.label.length > 0, `${axis.key} has no label`);
    assert.ok(axis.description.length > 20, `${axis.key} has no plain-language description`);
    assert.ok(axis.value >= 0 && axis.value <= 1);
    assert.deepEqual(findImpersonation(axis.description), []);
  }
});

// ---------------------------------------------------------------------------
// Count arithmetic
// ---------------------------------------------------------------------------

test('combining shards of a run adds every counter and invents none', () => {
  const shard = new SeatObservations(0, 'volume-grinder');
  shard.beginHand();
  shard.noteDecision(decision({ toCall: 50, action: 'call', cost: 50 }));
  shard.endHand({ sawFlop: true, showedDown: true, netChips: 10 });
  const counts = shard.finalise(100).counts;

  const combined = combineCounts([counts, counts, counts]);
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
    assert.equal(combined[key], counts[key] * 3, `${key} did not add`);
  }
  assert.equal(combineCounts([]).decisions, 0, 'no shards is zero, not NaN');
});

test('ranking by an observed statistic is strongest first and keeps the ids attached', () => {
  const ranked = rankByObserved(
    [
      { ...statsWith({ vpip: 0.2 }), profileId: 'tight' },
      { ...statsWith({ vpip: 0.5 }), profileId: 'loose' },
      { ...statsWith({ vpip: 0.35 }), profileId: 'middle' },
    ],
    (entry) => entry.vpip,
  );
  assert.deepEqual(
    ranked.map((entry) => entry.profileId),
    ['loose', 'middle', 'tight'],
  );
  assert.equal(ranked[0]?.value, 0.5);
});

// ---------------------------------------------------------------------------
// The harness's bookkeeping, with a stub policy
// ---------------------------------------------------------------------------

test('deriveSeed is order-sensitive, reproducible, and refuses non-integers', () => {
  assert.equal(deriveSeed(1, 2, 3), deriveSeed(1, 2, 3));
  assert.notEqual(deriveSeed(1, 2, 3), deriveSeed(3, 2, 1));
  assert.notEqual(deriveSeed(1, 2, 3), deriveSeed(1, 2, 4));
  assert.throws(() => deriveSeed(1.5), SimulationError);
  assert.throws(() => deriveSeed(Number.NaN), SimulationError);

  // No collisions across a whole 20,000-hand heads-up run's decision streams. A collision
  // would make two seats share a generator, which is the failure the derivation prevents.
  const seen = new Set<number>();
  for (let hand = 0; hand < 20_000; hand++) {
    for (const seat of [0, 1]) seen.add(deriveSeed(2, 12_345, hand, seat));
    seen.add(deriveSeed(1, 12_345, hand));
  }
  assert.equal(seen.size, 60_000, `${60_000 - seen.size} seed collisions in one run`);
});

test('the simulation difficulty settings change the equity budget and nothing else', () => {
  const config = headsUp({ difficulty: 'expert' });
  const settings = simulationDifficultySettings(config);
  const live = DIFFICULTY_SETTINGS.expert;
  assert.equal(settings.equitySamples, SIMULATION_EQUITY_SAMPLES);
  assert.notEqual(settings.equitySamples, live.equitySamples);
  assert.deepEqual({ ...settings, equitySamples: live.equitySamples }, live);
  assert.equal(simulationDifficultySettings({ ...config, equitySamples: 12 }).equitySamples, 12);
});

test('a simulation validates its configuration rather than producing meaningless numbers', () => {
  const bad: Partial<SimulationConfig>[] = [
    { profileIds: ['fundamentals-coach'] },
    { profileIds: new Array(7).fill('fundamentals-coach') },
    { profileIds: ['fundamentals-coach', 'no-such-profile'] },
    { hands: 0 },
    { hands: 1.5 },
    { seed: 0.5 },
    { smallBlind: 0 },
    { bigBlind: 0 },
    { smallBlind: 200, bigBlind: 100 },
    { startingStack: 0 },
    { startingStack: 50, bigBlind: 100 },
    { ante: -1 },
    { equitySamples: 0 },
  ];
  for (const overrides of bad) {
    assert.throws(
      () => simulate(headsUp(overrides)),
      Error,
      `${JSON.stringify(overrides)} should be rejected`,
    );
  }
});

/** A stub that folds whenever folding is legal, and otherwise checks. */
const alwaysFold = { decide: (): { action: { type: 'fold' } } => ({ action: { type: 'fold' } }) };

test('the button rotates, so a seat that folds its small blind ends the run at exactly zero', () => {
  // Heads-up the button posts the small blind and acts first preflop. With both seats folding
  // on sight, every hand is decided by that one action: the button loses 50 and the big blind
  // never acts at all. Over an even number of hands with the button rotating, both seats fold
  // exactly half of them and both end level. Any rotation bug shows up as a non-zero net.
  const hands = 1000;
  const result = simulate(headsUp({ hands }), alwaysFold);

  assert.equal(result.handsCompleted, hands);
  assert.equal(result.actionsApplied, hands, 'one action per hand');
  assert.equal(result.chipConservationChecks, hands, 'every hand was checked');
  assert.equal(result.stoppedEarly, null);
  assert.equal(result.sizeClampsApplied, 0);

  for (const seat of result.bySeat) {
    assert.equal(seat.handsDealt, hands);
    assert.equal(seat.counts.preflopOpportunities, hands / 2, 'the button acts, the big blind does not');
    assert.equal(seat.counts.decisions, hands / 2);
    assert.equal(seat.vpip, 0);
    assert.equal(seat.pfr, 0);
    assert.equal(seat.counts.flopsSeen, 0, 'no hand reached a flop');
    assert.equal(seat.netChips, 0, 'rotation makes the blinds cancel exactly');
    assert.equal(seat.bbPer100, 0);
  }
});

/** A stub that never folds and never raises: check when free, call when not. */
const alwaysCallOrCheck = {
  decide: (input: {
    view: { legalActions: readonly { type: string }[] };
  }): { action: { type: 'check' | 'call' } } =>
    input.view.legalActions.some((entry) => entry.type === 'check')
      ? { action: { type: 'check' } }
      : { action: { type: 'call' } },
};

test('with nobody folding, every hand is played out and both seats are offered every street', () => {
  const hands = 300;
  const result = simulate(headsUp({ hands }), alwaysCallOrCheck);

  assert.equal(result.handsCompleted, hands);
  assert.equal(result.chipConservationChecks, hands);
  for (const seat of result.bySeat) {
    assert.equal(seat.counts.preflopOpportunities, hands, 'both seats always act preflop');
    assert.equal(seat.counts.flopsSeen, hands);
    assert.equal(seat.counts.showdownsReached, hands, 'nobody folded, so everybody showed');
    assert.equal(seat.wentToShowdown, 1);
    // Exactly 0.5, and the reason is the whole denominator argument in `stats.ts`. Heads-up the
    // button posts the small blind and completes — a voluntary call. The big blind then has
    // nothing to call and checks its option, which is not an entry, because the chips were
    // already forced in. With the button rotating, each seat is the entering one on half the
    // hands. A harness that counted the big blind's check as VPIP would report 1.0 here.
    assert.equal(seat.vpip, 0.5, 'the big blind checking its option is not a voluntary entry');
    assert.equal(seat.pfr, 0, 'this stub never raises');
    assert.equal(seat.counts.aggressiveActions, 0);
    assert.equal(seat.aggressionFrequency, 0);
    assert.equal(seat.averageBetSizeAsPotFraction, 0, 'no sized action ever happened');
  }
  // Chips are conserved across the whole run, not merely within each hand.
  assert.equal(
    result.bySeat.reduce((sum, seat) => sum + seat.netChips, 0),
    0,
  );
});

test('a size the policy did not clamp is clamped by the harness and counted', () => {
  const overshoot = {
    decide: (input: {
      view: { legalActions: readonly { type: string; maxTo?: number }[] };
    }): { action: { type: 'bet' | 'raise'; to: number } | { type: 'check' | 'call' } } => {
      const aggressive = input.view.legalActions.find(
        (entry) => entry.type === 'bet' || entry.type === 'raise',
      );
      if (aggressive !== undefined) {
        // Deliberately far above the engine's maximum, and deliberately not an integer.
        return { action: { type: aggressive.type === 'bet' ? 'bet' : 'raise', to: 1e9 + 0.5 } };
      }
      return input.view.legalActions.some((entry) => entry.type === 'check')
        ? { action: { type: 'check' } }
        : { action: { type: 'call' } };
    },
  };
  const result = simulate(headsUp({ hands: 40 }), overshoot);
  assert.ok(result.sizeClampsApplied > 0, 'the clamps must be counted, not hidden');
  assert.equal(result.handsCompleted, 40, 'and the clamped action must still be legal');
  assert.equal(result.chipConservationChecks, 40);
});

test('a proposal the engine did not offer fails the run instead of being repaired', () => {
  const alwaysCheck = { decide: (): { action: { type: 'check' } } => ({ action: { type: 'check' } }) };
  assert.throws(
    () => simulate(headsUp({ hands: 5 }), alwaysCheck),
    (error: unknown) =>
      error instanceof SimulationError && /did not offer/.test(error.message) && /check/.test(error.message),
    'checking facing the big blind is illegal preflop and must be refused',
  );
});

test('the same seed reproduces a run exactly; a different seed does not', () => {
  const first = simulate(headsUp({ hands: 200, seed: 11 }), alwaysCallOrCheck);
  const again = simulate(headsUp({ hands: 200, seed: 11 }), alwaysCallOrCheck);
  const other = simulate(headsUp({ hands: 200, seed: 12 }), alwaysCallOrCheck);

  assert.equal(JSON.stringify(first.bySeat), JSON.stringify(again.bySeat));
  assert.notEqual(JSON.stringify(first.bySeat), JSON.stringify(other.bySeat));
  // Only the wall clock may differ between two runs of the same seed.
  assert.deepEqual({ ...first, elapsedMs: 0 }, { ...again, elapsedMs: 0 });
});

test('carrying stacks forward stops the run when only one seat has chips, and says so', () => {
  const shove = {
    decide: (input: {
      view: { legalActions: readonly { type: string; maxTo?: number }[] };
    }): { action: { type: 'bet' | 'raise'; to: number } | { type: 'call' } } => {
      const aggressive = input.view.legalActions.find(
        (entry) => entry.type === 'bet' || entry.type === 'raise',
      );
      if (aggressive !== undefined) {
        return { action: { type: aggressive.type === 'bet' ? 'bet' : 'raise', to: aggressive.maxTo ?? 0 } };
      }
      return { action: { type: 'call' } };
    },
  };
  const result = simulate(headsUp({ hands: 5000, startingStack: 1000, resetStacksEachHand: false }), shove);
  assert.ok(result.handsCompleted < 5000, 'somebody must have busted');
  assert.match(String(result.stoppedEarly), /still had chips/);
  assert.equal(result.chipConservationChecks, result.handsCompleted);
  // The whole table's chips are conserved across the run, however they moved.
  assert.equal(
    result.bySeat.reduce((sum, seat) => sum + seat.netChips, 0),
    0,
  );
});

test('resetting stacks each hand is the default, and it never stops early', () => {
  const result = simulate(headsUp({ hands: 500, startingStack: 300 }), alwaysCallOrCheck);
  assert.equal(result.handsCompleted, 500);
  assert.equal(result.stoppedEarly, null);
  assert.equal(result.config.resetStacksEachHand, undefined, 'the default is not written into the config');
});

test('seatStats refuses a seat the run does not have', () => {
  const result = simulate(headsUp({ hands: 2 }), alwaysFold);
  assert.equal(seatStats(result, 0).profileId, 'fundamentals-coach');
  assert.equal(seatStats(result, 1).profileId, 'calling-station');
  assert.throws(() => seatStats(result, 2), SimulationError);
});

test('a six-handed run seats every profile it was given and deals every seat in', () => {
  const profileIds = [
    'disciplined-specialist',
    'patient-technician',
    'fundamentals-coach',
    'range-narrator',
    'reading-pressure-specialist',
    'calling-station',
  ];
  const result = simulate({ ...headsUp({ hands: 120 }), profileIds }, alwaysCallOrCheck);
  assert.equal(result.bySeat.length, 6);
  assert.deepEqual(
    result.bySeat.map((seat) => seat.profileId),
    profileIds,
  );
  for (const seat of result.bySeat) {
    assert.equal(seat.handsDealt, 120);
    assert.equal(seat.counts.preflopOpportunities, 120, 'nobody folded, so everybody acted');
  }
  assert.equal(
    result.bySeat.reduce((sum, seat) => sum + seat.netChips, 0),
    0,
  );
});
