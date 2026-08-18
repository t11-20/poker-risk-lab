/**
 * The evidence behind "twelve distinct styles".
 *
 * Without this file that phrase is a claim on a card. With it, the claim is: play tens of
 * thousands of deterministic hands per profile through the real engine, measure what each one
 * did, and show that the measurements match the declared traits and separate from each other by
 * more than sampling noise.
 *
 * ## What each test establishes, and what it deliberately does not
 *
 * Nothing here says any profile plays *well*. A model can match its card perfectly and be a
 * losing player, and several of these are meant to be — `calling-station` exists to be beaten.
 * Nothing here compares a profile to a person; there is no human data in this package, so no
 * such claim is testable even in principle. What is tested is internal consistency between the
 * numbers on a profile's card and the behaviour a learner will actually face.
 *
 * ## Methodology: why the reference opponent is chosen rather than picked
 *
 * Each profile is measured heads-up against one fixed reference. Heads-up because at a full
 * table a profile's observed VPIP depends on who opened in front of it, so twelve profiles
 * measured at twelve different tables would be comparing the company they kept.
 *
 * The reference is `reading-pressure-specialist`, and the choice follows from a structural bias
 * that the measurement has and the models do not.
 *
 * **Positional opportunity imbalance.** A declared `vpip` is a position-averaged entry
 * frequency, and `positionalVpipMultiplier` swings the threshold by ±`0.45 x
 * positionSensitivity` between the worst seat and the best. Heads-up, a profile gets a preflop
 * turn on the button every hand, but in the big blind only when the opponent in the small blind
 * does not fold. So the button — the widest threshold — supplies a fixed share of the
 * opportunities and the blind supplies a share that depends entirely on how tight the opponent
 * is, and the measured average is pulled towards whichever position is over-represented.
 *
 * Measured, over 4,000 hands per profile at `realistic`, as the button's share of this seat's
 * preflop opportunities and the resulting mean signed VPIP error across all twelve profiles:
 *
 * | reference                     | its vpip | button share | mean signed err | worst | rho    |
 * |-------------------------------|----------|--------------|-----------------|-------|--------|
 * | `fundamentals-coach`          | 0.23     | 76%          | +0.050          | 0.082 | 0.9930 |
 * | `reading-pressure-specialist` | 0.42     | 65%          | +0.026          | 0.046 | 1.0000 |
 * | `calling-station`             | 0.52     | 65%          | +0.027          | 0.046 | 1.0000 |
 *
 * A tight reference doubles the error and puts the worst profile at 0.082, well past the
 * tolerance — measuring the same models, with the same code. That is a property of what a
 * heads-up VPIP measures, not of the models, and it is the reason a reference is chosen on a
 * criterion rather than picked: it wants a high VPIP, so the two positions are offered in more
 * nearly equal numbers.
 *
 * The second candidate criterion is a high `pfrShareOfVpip`, for a smaller effect in the other
 * direction: when the reference limps, the big blind has nothing to call, and checking the
 * option is not a voluntary entry (see the denominator argument in `stats.ts`), so entering
 * requires raising. `reading-pressure-specialist` (vpip 0.42, pfrShareOfVpip 0.80) maximises
 * both jointly; the table above shows the limp effect is small for this policy, since
 * `calling-station` — which limps constantly — measures the same as the aggressive reference.
 * It is also a heads-up-oriented style that raises about a third of all hands, which gives the
 * 3-bet and fold-to-bet denominators enough observations to test.
 *
 * **Every observed figure in this suite is therefore reported next to the reference it was
 * measured against, and none of them should be quoted without it.**
 *
 * ## Where the tolerances come from
 *
 * Sampling first, because it sets the floor. At 8,000 hands a proportion measured over the
 * preflop opportunities has a 95% half-width of at worst `1.96 x 0.5 / sqrt(8000)` = 0.011, and
 * the real half-width is smaller because the rates are well away from 0.5. So a tolerance of
 * 0.05 is roughly four and a half times the sampling error: it is not absorbing noise, it is
 * absorbing the positional imbalance above.
 *
 * It is deliberately **not** absorbing the reduced equity budget, because that turns out to
 * contribute nothing here. Holding the seed fixed over 6,000 hands and varying `equitySamples`
 * across a twentyfold range gives: VPIP and PFR identical to four decimal places at 200, 500,
 * 1,000 and 4,000 samples — the preflop entry gate thresholds a computed percentile rather than
 * a sampled equity, so it does not consume samples at all — and the postflop rates move by at
 * most 0.005 (3-bet 0.0006, aggression 0.0033, bluff 0.0037, fold-to-bet 0.0006, mean size
 * 0.0014, showdown 0.0049). Every one of those is an order of magnitude below the tolerance it
 * feeds. The run at 200 samples took 3.1s and the one at 4,000 took 19.8s, which is the whole
 * reason `SIMULATION_EQUITY_SAMPLES` exists.
 *
 * The VPIP tolerance is not invented here — it is `OBSERVABLE_AXES`, so `stats.ts` and this
 * suite cannot drift apart, and the justification lives on the axis. The PFR tolerance is the
 * same 0.05, and it is the tighter of the two available constraints:
 * `pfr = vpip x pfrShareOfVpip <= vpip`, so PFR inherits VPIP's absolute error and has less
 * room of its own to be wrong in.
 *
 * A profile that misses its tolerance fails this suite. That is the point: the alternative —
 * widening the tolerance until the suite goes green — would turn the evidence into decoration.
 *
 * ## Not in the default suite, and why the directory alone was not enough
 *
 * The sweep plays 96,000 hands and takes about 70 seconds, which is longer than every other test
 * in this package put together. So it lives under `test/simulation/` and runs from its own
 * script:
 *
 *     pnpm --filter @prl/poker-ai test:simulation
 *
 * Putting the file in a subdirectory does not by itself exclude it: `node --test` expands `**`
 * across directories, so the package's `test` script matched this file too and every default run
 * — every `pnpm test`, every pre-commit — paid the 70 seconds and then paid it again under
 * `test:simulation`. The `test` script therefore globs `test/*.test.ts`, one level only. Moving a
 * slow test in here is what excludes it; adding a second pattern to `test` would silently undo
 * that.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeterministicRandomForTests, redactFor, seatAt, startHand } from '@prl/poker-engine';
import { findImpersonation } from '../../src/labelling.ts';
import { createOpponentModel } from '../../src/opponent-model.ts';
import { decide } from '../../src/policy.ts';
import {
  DIFFICULTY_SETTINGS,
  type Difficulty,
  expressTraits,
  PROFILES,
  requireProfile,
  type StrategyProfile,
} from '../../src/profiles.ts';
import {
  deriveSeed,
  type SimulationResult,
  seatStats,
  simulate,
  simulateHeadsUpAgainstReference,
} from '../../src/simulate.ts';
import {
  compareToDeclared,
  describeDivergence,
  normalTwoSidedCriticalValue,
  OBSERVABLE_AXES,
  type SeatSimulationStats,
  spearmanRho,
  twoProportionZTest,
} from '../../src/stats.ts';
import { preflopRaiseFrequency, type TraitKey } from '../../src/traits.ts';

// ---------------------------------------------------------------------------
// The run parameters, in one place, all justified above
// ---------------------------------------------------------------------------

const REFERENCE_PROFILE = 'reading-pressure-specialist';
const DIFFICULTY: Difficulty = 'realistic';

/** Enough that the 95% sampling half-width (0.011) is a fifth of the tightest tolerance. */
const DECLARED_HANDS = 8_000;

/**
 * A second, cheaper sweep at a different seed, for the ordering-stability check. 2,000 hands
 * gives a 95% half-width of 0.022 on each rate, which is far finer than the gaps between the
 * declared VPIPs the ordering has to reproduce.
 */
const SECOND_SEED_HANDS = 2_000;

/**
 * Hands per profile per difficulty in the difficulty test. At 2,000 the half-width is 0.022 and
 * the spreads being compared differ by about 0.13, so the comparison is not measuring noise.
 */
const DIFFICULTY_HANDS = 2_000;

/** Hands for the structural runs — the six-handed table and the carry-forward path. */
const STRUCTURAL_HANDS = 1_500;

const PRIMARY_SEED = 20_260_817;
const SECONDARY_SEED = 991;

/** Alpha for every separation claim. The two-sided normal critical value is 3.2906. */
const ALPHA = 0.001;

/**
 * Rank-correlation floor for the ordering test.
 *
 * A single adjacent transposition among twelve items costs `6 x 2 / (12^3 - 12)` = 0.007 of
 * rho, and the declared VPIPs contain several pairs 0.02 apart (0.30/0.32, 0.34/0.36,
 * 0.38/0.40) — inside the structural slack the tolerances already allow, so adjacent swaps
 * between near-ties are expected rather than a defect. 0.90 permits roughly fourteen of them
 * while still ruling out any gross re-ordering: a random permutation of twelve items has an
 * expected rho of 0 with a standard deviation of `1/sqrt(11)` = 0.30, so 0.90 sits three
 * standard deviations into the tail.
 */
const MINIMUM_RHO = 0.9;

const VPIP_TOLERANCE = (() => {
  const axis = OBSERVABLE_AXES.find((entry) => entry.key === 'vpip');
  if (axis === undefined) throw new Error('stats.ts no longer measures vpip');
  return axis.tolerance;
})();

/** See the module comment: PFR inherits VPIP's absolute error and cannot exceed VPIP. */
const PFR_TOLERANCE = VPIP_TOLERANCE;

// ---------------------------------------------------------------------------
// One sweep, reused by every test that needs it
// ---------------------------------------------------------------------------

interface ProfileRun {
  readonly profile: StrategyProfile;
  readonly stats: SeatSimulationStats;
  readonly run: SimulationResult;
}

function runSweep(hands: number, seed: number): readonly ProfileRun[] {
  return PROFILES.map((profile) => {
    const run = simulateHeadsUpAgainstReference({
      profileId: profile.naming.id,
      referenceProfileId: REFERENCE_PROFILE,
      difficulty: DIFFICULTY,
      hands,
      seed,
    });
    return { profile, stats: seatStats(run, 0), run };
  });
}

let primaryCache: readonly ProfileRun[] | null = null;

/**
 * The main sweep: every profile, seat 0, against the reference.
 *
 * Memoised because five separate tests make claims about the same body of evidence, and running
 * it once per test would multiply the suite's cost by five for no additional information.
 */
function primarySweep(): readonly ProfileRun[] {
  if (primaryCache === null) {
    const startedAt = Date.now();
    primaryCache = runSweep(DECLARED_HANDS, PRIMARY_SEED);
    const hands = primaryCache.reduce((sum, entry) => sum + entry.run.handsCompleted, 0);
    const actions = primaryCache.reduce((sum, entry) => sum + entry.run.actionsApplied, 0);
    console.log(
      `      sweep: ${PROFILES.length} profiles x ${DECLARED_HANDS} hands vs ${REFERENCE_PROFILE} ` +
        `at ${DIFFICULTY}, seed ${PRIMARY_SEED} — ${hands} hands, ${actions} actions, ` +
        `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );
  }
  return primaryCache;
}

function statsFor(sweep: readonly ProfileRun[], profileId: string): SeatSimulationStats {
  const entry = sweep.find((candidate) => candidate.profile.naming.id === profileId);
  if (entry === undefined) throw new Error(`"${profileId}" is not in the sweep`);
  return entry.stats;
}

/** The profiles at the two ends of one declared trait, so the test survives a profile edit. */
function extremesBy(pick: (profile: StrategyProfile) => number): {
  readonly highest: StrategyProfile;
  readonly lowest: StrategyProfile;
} {
  const ordered = [...PROFILES].sort((left, right) => pick(right) - pick(left));
  const highest = ordered[0];
  const lowest = ordered[ordered.length - 1];
  if (highest === undefined || lowest === undefined) throw new Error('the profile set is empty');
  return { highest, lowest };
}

// ---------------------------------------------------------------------------
// 1. Declared versus observed
// ---------------------------------------------------------------------------

test('observed VPIP and PFR match the declared traits within the stated tolerance', () => {
  const sweep = primarySweep();

  console.log(
    '      | profile | declared vpip | observed | delta | declared pfr | observed | delta | opportunities |',
  );
  const failures: string[] = [];
  const vpipDeltas: number[] = [];
  const pfrDeltas: number[] = [];
  for (const { profile, stats } of sweep) {
    const declaredVpip = profile.traits.vpip;
    const declaredPfr = preflopRaiseFrequency(profile.traits);
    const vpipDelta = stats.vpip - declaredVpip;
    const pfrDelta = stats.pfr - declaredPfr;
    vpipDeltas.push(vpipDelta);
    pfrDeltas.push(pfrDelta);
    const sign = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
    console.log(
      `      | ${profile.naming.id} | ${declaredVpip.toFixed(3)} | ${stats.vpip.toFixed(4)} | ` +
        `${sign(vpipDelta)} | ${declaredPfr.toFixed(3)} | ${stats.pfr.toFixed(4)} | ${sign(pfrDelta)} | ` +
        `${stats.counts.preflopOpportunities} |`,
    );
    if (Math.abs(vpipDelta) > VPIP_TOLERANCE) {
      failures.push(
        `${profile.naming.id}: vpip declared ${declaredVpip.toFixed(3)}, observed ` +
          `${stats.vpip.toFixed(4)} (${sign(vpipDelta)}, tolerance ${VPIP_TOLERANCE}), ` +
          `positionSensitivity ${profile.traits.positionSensitivity.toFixed(2)}`,
      );
    }
    if (Math.abs(pfrDelta) > PFR_TOLERANCE) {
      failures.push(
        `${profile.naming.id}: pfr declared ${declaredPfr.toFixed(3)}, observed ` +
          `${stats.pfr.toFixed(4)} (${sign(pfrDelta)}, tolerance ${PFR_TOLERANCE}), ` +
          `threeBetTendency ${profile.traits.threeBetTendency.toFixed(2)}`,
      );
    }
  }

  // The SIGN of the error matters more than its size, and it is printed whether or not the
  // assertion fails. Twelve independent misses scatter around zero; a mean signed error of the
  // same order as the misses themselves is a systematic bias with one cause, and the trait it
  // tracks is the fastest route to that cause. Both extra columns above are printed for that
  // reason: a VPIP error that rises with `positionSensitivity` and a PFR error that rises with
  // `threeBetTendency` are two different defects, and separating them is most of the diagnosis.
  const mean = (values: readonly number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  console.log(
    `      mean signed error: vpip ${mean(vpipDeltas).toFixed(4)}, pfr ${mean(pfrDeltas).toFixed(4)} ` +
      `(sampling half-width at ${DECLARED_HANDS} hands: ` +
      `${((normalTwoSidedCriticalValue(0.05) * 0.5) / Math.sqrt(DECLARED_HANDS)).toFixed(4)})`,
  );

  assert.deepEqual(
    failures,
    [],
    `these profiles did not behave the way their cards claim, measured against ${REFERENCE_PROFILE} ` +
      `at ${DIFFICULTY} over ${DECLARED_HANDS} hands:\n` +
      `${failures.map((entry) => `  - ${entry}`).join('\n')}\n` +
      `  mean signed vpip error ${mean(vpipDeltas).toFixed(4)}, mean signed pfr error ` +
      `${mean(pfrDeltas).toFixed(4)}. A one-sided mean of this size is a systematic bias in the ` +
      'policy or in the measurement, not twelve unrelated misses — check the two extra columns ' +
      'above before touching any tolerance.',
  );
});

test('every run is well formed: full length, no clamps, no early stop', () => {
  for (const { profile, run } of primarySweep()) {
    const where = profile.naming.id;
    assert.equal(run.handsCompleted, DECLARED_HANDS, `${where} did not play every hand`);
    assert.equal(run.stoppedEarly, null, `${where} stopped early: ${run.stoppedEarly}`);
    // Guardrail 5: the policy clamps its own sizes to the engine's bounds. If it did not, the
    // harness would have had to, and would have counted it.
    assert.equal(run.sizeClampsApplied, 0, `${where} proposed ${run.sizeClampsApplied} out-of-range sizes`);
    assert.ok(run.actionsApplied > DECLARED_HANDS, `${where} averaged under one action per hand`);
    // Both seats saw the same flops and the same showdowns, because heads-up they always do.
    // A mismatch would mean the harness attributed a hand outcome to the wrong seat.
    const [tested, reference] = run.bySeat;
    assert.ok(tested !== undefined && reference !== undefined);
    assert.equal(tested.counts.flopsSeen, reference.counts.flopsSeen, `${where}: flop counts disagree`);
    assert.equal(
      tested.counts.showdownsReached,
      reference.counts.showdownsReached,
      `${where}: showdown counts disagree`,
    );
  }
});

test('every remaining measurable axis lands inside its declared tolerance, on all twelve profiles', () => {
  // This test used to report and not assert, and the reason given was that two axes were
  // declared on conditions the measurement did not apply: `aggressionFrequency` is the rate on
  // a NEUTRAL hand assessment while the observed rate was unconditional, and
  // `threeBetTendency` is a multiplier on the flat-calling range rather than a frequency at
  // all. That was a true description of a real mismatch and the wrong conclusion drawn from
  // it. A comparison whose two sides are different quantities does not become safe by going
  // unasserted; it becomes a number on a profile card that nothing can ever contradict.
  //
  // `stats.ts` now measures the quantity each trait declares — see `OBSERVABLE_AXES` — so all
  // seven axes are the same kind of number on both sides and every one of them is asserted.
  // Neither tolerance was widened to get here; the 3-bet one was halved.
  const lines: string[] = [];
  const failures: string[] = [];
  for (const { profile, stats } of primarySweep()) {
    const { divergences } = compareToDeclared(profile.naming.id, stats);
    for (const divergence of divergences) {
      const sentence = describeDivergence(divergence);
      // Every learner-facing string, checked at generation time rather than trusted.
      assert.deepEqual(findImpersonation(sentence), [], sentence);
      lines.push(`      ${profile.naming.id} — ${divergence.key}: ${sentence}`);
      failures.push(`${profile.naming.id} — ${divergence.key}`);
    }
  }
  console.log(`      ${lines.length} divergence(s) across ${PROFILES.length} profiles:`);
  for (const line of lines) console.log(line);

  // Per axis, the MEAN SIGNED error across all twelve, printed whether or not anything failed.
  // The size of a miss is a per-profile question; its direction is a structural one. Twelve
  // independent misses scatter around zero, so a mean of the same order as the misses is one
  // cause with twelve symptoms — which is exactly what the unconditional aggression axis
  // showed (-0.0953, below declared on twelve profiles out of twelve) before it was measured
  // on the condition it is declared on.
  //
  // ## Which axes this asserts on, and the three it does not
  //
  // The band is asserted for `aggressionFrequency` and `threeBetTendency`, the two axes whose
  // definition was corrected, because those are the two a measurement exists for: on the
  // declared condition both come back at 6/12 below declared with a mean inside 0.005, so half
  // the tolerance is a band with two orders of magnitude of headroom rather than a number
  // chosen to fit. `vpip` and `foldToPressure` clear the same band and are asserted with them.
  //
  // Three axes are measured, printed, and deliberately NOT asserted on for direction:
  //
  //   pfrShareOfVpip    mean +0.0422, 0/12 below declared, tolerance 0.08
  //   bluffFrequency    mean +0.0571, 0/12 below declared, tolerance 0.20
  //   betSizingPreference  mean -0.0410, 12/12 below declared, tolerance 0.18
  //
  // Every one is one-sided on all twelve profiles and every one is comfortably inside its own
  // per-profile tolerance. They are not part of the aggression/3-bet correction and no
  // measurement here diagnoses them, so any band written for them today would be a number
  // fitted to the value it has to admit — which is the failure this whole file exists to
  // prevent. `pfrShareOfVpip` is arithmetically downstream of the other two preflop axes
  // (`observed = pfr/vpip`, and this run measures both of those one-sided upward: vpip +0.0132,
  // pfr +0.0250, the positional-opportunity imbalance derived in the module comment), so its
  // direction is explained but its magnitude has never been derived. `bluffFrequency` and
  // `betSizingPreference` have documented one-sided causes on the axis itself — semi-bluffs
  // counted as bluffs, and engine size clamping — with no measurement of how much either is
  // worth. Diagnosing them is a separate piece of work, and leaving the numbers printed and
  // named is how it stays visible until someone does it.
  const DIRECTIONALLY_ASSERTED: readonly TraitKey[] = [
    'vpip',
    'aggressionFrequency',
    'threeBetTendency',
    'foldToPressure',
  ];
  const meanOf = (values: readonly number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const biases: string[] = [];
  const undiagnosed: string[] = [];
  for (const axis of OBSERVABLE_AXES) {
    const deltas = primarySweep().map(
      ({ profile, stats }) => axis.observedFrom(stats) - axis.declaredFrom(profile.traits),
    );
    const below = deltas.filter((delta) => delta < 0).length;
    const mean = meanOf(deltas);
    const asserted = DIRECTIONALLY_ASSERTED.includes(axis.key);
    console.log(
      `      ${axis.key}: mean signed ${mean >= 0 ? '+' : ''}${mean.toFixed(4)}, ` +
        `${below}/${deltas.length} below declared, tolerance ${axis.tolerance}` +
        `${asserted ? '' : ' — direction NOT asserted, see the comment above'}`,
    );
    if (!asserted) {
      if (below === 0 || below === deltas.length) {
        undiagnosed.push(`${axis.key} (${mean.toFixed(4)}, ${below}/${deltas.length} below)`);
      }
      continue;
    }
    // Half the tolerance: a one-sided bias worth half the slack the axis allows is a modelling
    // or measurement error that every profile shares, even when no single profile breaches.
    if (Math.abs(mean) > axis.tolerance / 2) {
      biases.push(
        `${axis.key}: mean signed error ${mean.toFixed(4)} across ${deltas.length} profiles ` +
          `(${below} below declared) is more than half the ${axis.tolerance} this axis allows`,
      );
    }
  }
  if (undiagnosed.length > 0) {
    console.log(`      one-sided but undiagnosed, inside tolerance: ${undiagnosed.join(', ')}`);
  }

  assert.deepEqual(
    failures,
    [],
    `these axes are outside the tolerance their own documentation states:\n${lines.join('\n')}`,
  );
  assert.deepEqual(
    biases,
    [],
    'one-sided error across every profile is a systematic cause, not scatter — do not widen a ' +
      `tolerance to absorb it:\n  ${biases.join('\n  ')}`,
  );
});

// ---------------------------------------------------------------------------
// 2. Pairwise separation
// ---------------------------------------------------------------------------

test('the tightest and loosest profiles separate on VPIP at alpha = 0.001', () => {
  const sweep = primarySweep();
  const { highest, lowest } = extremesBy((profile) => profile.traits.vpip);
  const loose = statsFor(sweep, highest.naming.id);
  const tight = statsFor(sweep, lowest.naming.id);

  const result = twoProportionZTest(
    { successes: loose.counts.voluntaryEntries, trials: loose.counts.preflopOpportunities },
    { successes: tight.counts.voluntaryEntries, trials: tight.counts.preflopOpportunities },
  );
  console.log(`      VPIP  ${highest.naming.id} vs ${lowest.naming.id}: ${result.note}`);
  assert.equal(
    result.significantAt(ALPHA),
    true,
    `z = ${result.z.toFixed(3)} does not clear ${normalTwoSidedCriticalValue(ALPHA).toFixed(4)}`,
  );
  assert.ok(loose.vpip > tight.vpip, 'the looser profile must actually enter more pots');
});

test('the most and least aggressive profiles separate on aggression frequency at alpha = 0.001', () => {
  const sweep = primarySweep();
  const { highest, lowest } = extremesBy((profile) => profile.traits.aggressionFrequency);
  const aggressive = statsFor(sweep, highest.naming.id);
  const passive = statsFor(sweep, lowest.naming.id);

  const result = twoProportionZTest(
    { successes: aggressive.counts.aggressiveActions, trials: aggressive.counts.aggressionOpportunities },
    { successes: passive.counts.aggressiveActions, trials: passive.counts.aggressionOpportunities },
  );
  console.log(`      AF    ${highest.naming.id} vs ${lowest.naming.id}: ${result.note}`);
  assert.equal(result.significantAt(ALPHA), true, `z = ${result.z.toFixed(3)} is not significant`);
  assert.ok(aggressive.aggressionFrequency > passive.aggressionFrequency);
});

test('the highest and lowest threeBetTendency separate on 3-bet frequency at alpha = 0.001', () => {
  const sweep = primarySweep();
  const { highest, lowest } = extremesBy((profile) => profile.traits.threeBetTendency);
  const contester = statsFor(sweep, highest.naming.id);
  const flatter = statsFor(sweep, lowest.naming.id);

  const result = twoProportionZTest(
    { successes: contester.counts.threeBets, trials: contester.counts.threeBetOpportunities },
    { successes: flatter.counts.threeBets, trials: flatter.counts.threeBetOpportunities },
  );
  console.log(`      3bet  ${highest.naming.id} vs ${lowest.naming.id}: ${result.note}`);
  assert.equal(result.significantAt(ALPHA), true, `z = ${result.z.toFixed(3)} is not significant`);
  assert.ok(contester.threeBetFrequency > flatter.threeBetFrequency);
});

test('adjacent profiles are allowed to be indistinguishable, and the suite says which are', () => {
  // Not every pair has to separate — several profiles are deliberately close on any single axis
  // and differ on others (`profileDiversity()` guards the vector distance). What would be a
  // defect is a set where *most* pairs are indistinguishable, so the count is asserted and the
  // indistinguishable pairs are named.
  const sweep = primarySweep();
  const indistinguishable: string[] = [];
  let separated = 0;
  let pairs = 0;
  for (let i = 0; i < sweep.length; i++) {
    for (let j = i + 1; j < sweep.length; j++) {
      const left = sweep[i];
      const right = sweep[j];
      if (left === undefined || right === undefined) continue;
      pairs += 1;
      const result = twoProportionZTest(
        { successes: left.stats.counts.voluntaryEntries, trials: left.stats.counts.preflopOpportunities },
        { successes: right.stats.counts.voluntaryEntries, trials: right.stats.counts.preflopOpportunities },
      );
      if (result.significantAt(ALPHA)) separated += 1;
      else indistinguishable.push(`${left.profile.naming.id} / ${right.profile.naming.id}`);
    }
  }
  console.log(`      VPIP separated ${separated}/${pairs} pairs at alpha = ${ALPHA}`);
  if (indistinguishable.length > 0) {
    console.log(`      indistinguishable on VPIP alone: ${indistinguishable.join(', ')}`);
  }
  assert.ok(
    separated > pairs * 0.6,
    `only ${separated} of ${pairs} pairs separated on VPIP; the set may be variations on one style`,
  );
});

// ---------------------------------------------------------------------------
// 3. Ordering
// ---------------------------------------------------------------------------

test('ranking the profiles by observed VPIP reproduces the ranking by declared VPIP', () => {
  const sweep = primarySweep();
  const declared = sweep.map((entry) => entry.profile.traits.vpip);
  const observed = sweep.map((entry) => entry.stats.vpip);
  const rho = spearmanRho(declared, observed);

  const ordered = [...sweep].sort((left, right) => right.stats.vpip - left.stats.vpip);
  console.log(`      Spearman rho (declared vs observed VPIP) = ${rho.toFixed(4)}`);
  console.log(
    `      observed order: ${ordered
      .map((entry) => `${entry.profile.naming.id}=${entry.stats.vpip.toFixed(3)}`)
      .join(' > ')}`,
  );
  assert.ok(rho >= MINIMUM_RHO, `rho ${rho.toFixed(4)} is below the ${MINIMUM_RHO} floor`);
});

test('the same holds for PFR and for aggression frequency', () => {
  const sweep = primarySweep();
  const pfrRho = spearmanRho(
    sweep.map((entry) => preflopRaiseFrequency(entry.profile.traits)),
    sweep.map((entry) => entry.stats.pfr),
  );
  const aggressionRho = spearmanRho(
    sweep.map((entry) => entry.profile.traits.aggressionFrequency),
    sweep.map((entry) => entry.stats.aggressionFrequency),
  );
  console.log(`      Spearman rho PFR = ${pfrRho.toFixed(4)}, aggression = ${aggressionRho.toFixed(4)}`);
  assert.ok(pfrRho >= MINIMUM_RHO, `PFR rho ${pfrRho.toFixed(4)} is below ${MINIMUM_RHO}`);
  assert.ok(
    aggressionRho >= MINIMUM_RHO,
    `aggression rho ${aggressionRho.toFixed(4)} is below ${MINIMUM_RHO}`,
  );
});

// ---------------------------------------------------------------------------
// 4. Determinism
// ---------------------------------------------------------------------------

test('the same seed reproduces byte-identical statistics', () => {
  const options = {
    profileId: 'volume-grinder',
    referenceProfileId: REFERENCE_PROFILE,
    difficulty: DIFFICULTY,
    hands: 750,
    seed: 4_242,
  } as const;
  const first = simulateHeadsUpAgainstReference(options);
  const second = simulateHeadsUpAgainstReference(options);

  assert.equal(JSON.stringify(first.bySeat), JSON.stringify(second.bySeat));
  // Everything but the wall clock, which is the only field allowed to move.
  assert.deepEqual({ ...first, elapsedMs: 0 }, { ...second, elapsedMs: 0 });
});

test('a different seed gives different numbers but the same profile ordering', () => {
  const primary = primarySweep();
  const secondary = runSweep(SECOND_SEED_HANDS, SECONDARY_SEED);

  const changed = secondary.filter((entry, index) => {
    const other = primary[index];
    return other !== undefined && entry.stats.vpip !== other.stats.vpip;
  });
  assert.ok(
    changed.length > PROFILES.length * 0.8,
    `only ${changed.length} of ${PROFILES.length} profiles moved at all between seeds — that is ` +
      'suspiciously deterministic for a sampled policy',
  );

  const rho = spearmanRho(
    primary.map((entry) => entry.stats.vpip),
    secondary.map((entry) => entry.stats.vpip),
  );
  console.log(`      cross-seed Spearman rho (observed VPIP) = ${rho.toFixed(4)}`);
  assert.ok(rho >= MINIMUM_RHO, `the ordering did not survive a change of seed: rho ${rho.toFixed(4)}`);
});

// ---------------------------------------------------------------------------
// 5. Difficulty
// ---------------------------------------------------------------------------

test('educational play is measurably flatter than expert play across the same profiles', () => {
  // `expressTraits` at `educational` pulls every trait 40% of the way towards the baseline
  // vector, so the *spread across profiles* should compress by roughly that factor. That is the
  // precise sense in which the easier setting is flatter: the styles stay pointed the way they
  // were designed to point, they just lean less far. A setting that merely added noise would
  // leave the spread alone.
  const ids = [
    'disciplined-specialist',
    'patient-technician',
    'fundamentals-coach',
    'vocal-aggressor',
    'range-narrator',
    'calling-station',
  ];
  const spread = (values: readonly number[]): number => Math.max(...values) - Math.min(...values);
  const measured = new Map<Difficulty, { vpip: number[]; aggression: number[] }>();

  for (const difficulty of ['educational', 'expert'] as const) {
    const vpip: number[] = [];
    const aggression: number[] = [];
    for (const profileId of ids) {
      const run = simulateHeadsUpAgainstReference({
        profileId,
        referenceProfileId: REFERENCE_PROFILE,
        difficulty,
        hands: DIFFICULTY_HANDS,
        seed: 8_181,
      });
      const stats = seatStats(run, 0);
      vpip.push(stats.vpip);
      aggression.push(stats.aggressionFrequency);
    }
    measured.set(difficulty, { vpip, aggression });
    console.log(
      `      ${difficulty.padEnd(12)} vpip spread ${spread(vpip).toFixed(4)}, ` +
        `aggression spread ${spread(aggression).toFixed(4)}`,
    );
  }

  const easy = measured.get('educational');
  const hard = measured.get('expert');
  assert.ok(easy !== undefined && hard !== undefined);

  // The declared traits compress by exactly 0.6, so the observed spread should land near that.
  // 0.85 is a loose bound that still rules out "the difficulty setting does nothing".
  assert.ok(
    spread(easy.vpip) < spread(hard.vpip) * 0.85,
    `educational VPIP spread ${spread(easy.vpip).toFixed(4)} is not materially below expert's ` +
      `${spread(hard.vpip).toFixed(4)}`,
  );
  assert.ok(
    spread(easy.aggression) < spread(hard.aggression) * 0.85,
    `educational aggression spread ${spread(easy.aggression).toFixed(4)} is not below expert's ` +
      `${spread(hard.aggression).toFixed(4)}`,
  );

  // And the individual profiles move towards the baseline rather than in random directions.
  const baselineVpip = 0.25;
  for (const [index, profileId] of ids.entries()) {
    const declared = requireProfile(profileId).traits.vpip;
    if (Math.abs(declared - baselineVpip) < 0.08) continue;
    const easyVpip = easy.vpip[index];
    const hardVpip = hard.vpip[index];
    assert.ok(easyVpip !== undefined && hardVpip !== undefined);
    assert.ok(
      Math.abs(easyVpip - baselineVpip) < Math.abs(hardVpip - baselineVpip),
      `${profileId} at educational (${easyVpip.toFixed(3)}) is not closer to the baseline than at ` +
        `expert (${hardVpip.toFixed(3)})`,
    );
  }
});

test('adaptation is switched off entirely at the easiest difficulty', () => {
  // Structural rather than statistical, and cheap: a profile that keeps adapting cannot be
  // characterised, because the thing being observed keeps moving.
  for (const profile of PROFILES) {
    assert.equal(
      expressTraits(profile, 'educational').exploitativeAdaptation,
      0,
      `${profile.naming.id} still adapts at educational`,
    );
  }
  assert.equal(DIFFICULTY_SETTINGS.educational.adaptationEnabled, false);
  assert.equal(DIFFICULTY_SETTINGS.expert.adaptationEnabled, true);
});

// ---------------------------------------------------------------------------
// 6. Not scripted
// ---------------------------------------------------------------------------

/** One real preflop decision point, reached by dealing a real hand. */
function preflopSpot(handIndex: number): {
  readonly seat: number;
  readonly holeCards: readonly [number, number];
  readonly view: ReturnType<typeof redactFor>;
} | null {
  const started = startHand({
    handId: `spot-${handIndex}`,
    roomId: 'spot',
    handNumber: handIndex,
    config: { smallBlind: 50, bigBlind: 100, ante: 0, maxSeats: 2, actionTimeoutSeconds: 30 },
    buttonSeat: 0,
    seats: [0, 1].map((seat) => ({ seat, playerId: `p${seat}`, stack: 10_000 })),
    random: createDeterministicRandomForTests(deriveSeed(1, 777, handIndex)),
  });
  const state = started.state;
  const seat = state.toAct;
  if (seat === null) return null;
  const holeCards = seatAt(state, seat).holeCards;
  if (holeCards === null) return null;
  return { seat, holeCards, view: redactFor(state, { viewerSeat: seat }) };
}

test('a fixed spot produces several different actions, in the proportions the policy declared', () => {
  const traits = expressTraits(requireProfile('adaptive-exploiter'), DIFFICULTY);
  const settings = DIFFICULTY_SETTINGS[DIFFICULTY];
  const ask = (spot: NonNullable<ReturnType<typeof preflopSpot>>, seed: number): ReturnType<typeof decide> =>
    decide({
      view: spot.view,
      holeCards: spot.holeCards,
      seat: spot.seat,
      observations: createOpponentModel(spot.seat),
      traits,
      difficulty: settings,
      random: createDeterministicRandomForTests(seed),
    });

  // Find a genuinely mixed spot rather than asserting on a hand-picked one, so the test keeps
  // working when the policy's thresholds move. A policy with no mixed spot in 400 real deals
  // would be scripted, and this loop failing IS that finding.
  let chosen: NonNullable<ReturnType<typeof preflopSpot>> | null = null;
  for (let handIndex = 0; handIndex < 400 && chosen === null; handIndex++) {
    const spot = preflopSpot(handIndex);
    if (spot === null) continue;
    const sorted = ask(spot, 1)
      .distribution.map((entry) => entry.probability)
      .sort((left, right) => right - left);
    if ((sorted[0] ?? 1) <= 0.85 && (sorted[1] ?? 0) >= 0.12) chosen = spot;
  }
  assert.ok(chosen !== null, 'no mixed spot in 400 deals — this policy is effectively scripted');

  const TRIALS = 3_000;
  const observed = new Map<string, number>();
  const expected = new Map<string, number>();
  for (let trial = 0; trial < TRIALS; trial++) {
    const decision = ask(chosen, deriveSeed(9, trial));
    observed.set(decision.action.type, (observed.get(decision.action.type) ?? 0) + 1);
    // The pre-sampling distribution, averaged over trials: the policy's own hand assessment is
    // sampled, so the distribution it reports can move slightly from trial to trial.
    for (const entry of decision.distribution) {
      expected.set(entry.action.type, (expected.get(entry.action.type) ?? 0) + entry.probability / TRIALS);
    }
  }
  console.log(
    `      mixed spot over ${TRIALS} seeds: ` +
      [...observed.entries()].map(([action, count]) => `${action}=${(count / TRIALS).toFixed(3)}`).join(' ') +
      ' | declared ' +
      [...expected.entries()].map(([action, p]) => `${action}=${p.toFixed(3)}`).join(' '),
  );

  assert.ok(observed.size >= 2, `only one action ever came out of a mixed spot: ${[...observed.keys()]}`);
  assert.ok(expected.size >= 2, 'the declared distribution must show more than one plausible action');

  // Proportion check rather than chi-squared: with at most five actions compared, a 4-sigma
  // band keeps the family-wise false-positive rate near 1e-4, which is the right order for a
  // suite that must not flake, while still catching a sampler that ignores its own weights.
  for (const [action, count] of observed) {
    const declared = expected.get(action) ?? 0;
    const sigmas = Math.abs(count / TRIALS - declared) / Math.sqrt((declared * (1 - declared)) / TRIALS);
    assert.ok(
      sigmas < 4,
      `${action} came out ${(count / TRIALS).toFixed(4)} of the time against a declared ` +
        `${declared.toFixed(4)} — ${sigmas.toFixed(2)} standard errors, so the sampler is not ` +
        'drawing from the distribution it publishes',
    );
  }
});

test('identical inputs with identical seeds produce identical actions', () => {
  // The other half of "probabilistic, not random": reproducibility comes from injecting the
  // generator, not from avoiding randomness.
  const spot = preflopSpot(0);
  assert.ok(spot !== null);
  const traits = expressTraits(requireProfile('patient-technician'), DIFFICULTY);
  const input = {
    view: spot.view,
    holeCards: spot.holeCards,
    seat: spot.seat,
    traits,
    difficulty: DIFFICULTY_SETTINGS[DIFFICULTY],
    random: createDeterministicRandomForTests(31_337),
  } as const;
  const once = decide({ ...input, observations: createOpponentModel(spot.seat) });
  const twice = decide({
    ...input,
    observations: createOpponentModel(spot.seat),
    random: createDeterministicRandomForTests(31_337),
  });
  assert.deepEqual(once.action, twice.action);
});

// ---------------------------------------------------------------------------
// 7. Chip conservation
// ---------------------------------------------------------------------------

test('chips are conserved in every simulated hand, and the check actually ran', () => {
  // The engine guarantees this and `test/invariants.test.ts` proves it across thousands of
  // randomised hands. It is asserted here anyway because a harness bug — attributing a net to
  // the wrong seat, double-counting a pot, resetting a stack at the wrong moment — would
  // silently invalidate every number above while leaving the engine blameless.
  for (const { profile, run } of primarySweep()) {
    assert.equal(
      run.chipConservationChecks,
      run.handsCompleted,
      `${profile.naming.id}: only ${run.chipConservationChecks} of ${run.handsCompleted} hands were checked`,
    );
    assert.equal(
      run.bySeat.reduce((sum, seat) => sum + seat.netChips, 0),
      0,
      `${profile.naming.id}: the seats' net chips do not sum to zero across the run`,
    );
  }
});

test('chips are conserved when stacks carry forward and a seat busts', () => {
  // The reset-each-hand path can never produce a bust, so the carry-forward path is where a
  // stack-bookkeeping bug would hide. Short stacks make busts frequent rather than incidental.
  const startingStack = 1_500;
  const result = simulate({
    profileIds: ['calling-station', 'volume-grinder'],
    difficulty: DIFFICULTY,
    hands: STRUCTURAL_HANDS,
    seed: 606,
    startingStack,
    smallBlind: 50,
    bigBlind: 100,
    resetStacksEachHand: false,
  });
  console.log(
    `      carry-forward: ${result.handsCompleted} hands, stopped because ${String(result.stoppedEarly)}`,
  );
  assert.equal(result.chipConservationChecks, result.handsCompleted);
  assert.equal(
    result.bySeat.reduce((sum, seat) => sum + seat.netChips, 0),
    0,
  );
  assert.equal(result.sizeClampsApplied, 0);
  assert.match(String(result.stoppedEarly), /still had chips/, 'this fixture must reach a bust');

  // The bust is the assertion. One seat holds the whole table and the other holds nothing, so
  // the transfer is exactly one starting stack — no more, no less. A stack-bookkeeping bug in
  // the carry-forward path would land here as an off-by-a-blind rather than an off-by-nothing.
  const nets = [...result.bySeat.map((seat) => seat.netChips)].sort((left, right) => left - right);
  assert.deepEqual(nets, [-startingStack, startingStack]);
});

test('a six-handed table runs the same way, with every seat measured', () => {
  // The differentiation claims are all heads-up for the reasons in the module comment, but the
  // harness must not be heads-up-only: a six-handed run exercises side pots, multiway streets
  // and positions that do not exist with two seats.
  const profileIds = [
    'disciplined-specialist',
    'patient-technician',
    'fundamentals-coach',
    'mixed-game-generalist',
    'reading-pressure-specialist',
    'calling-station',
  ];
  const result = simulate({
    profileIds,
    difficulty: DIFFICULTY,
    hands: STRUCTURAL_HANDS,
    seed: 1_234,
    startingStack: 10_000,
    smallBlind: 50,
    bigBlind: 100,
  });
  assert.equal(result.handsCompleted, STRUCTURAL_HANDS);
  assert.equal(result.chipConservationChecks, STRUCTURAL_HANDS);
  assert.equal(result.stoppedEarly, null);
  assert.equal(result.sizeClampsApplied, 0);
  assert.equal(
    result.bySeat.reduce((sum, seat) => sum + seat.netChips, 0),
    0,
  );

  const ordered = [...result.bySeat].sort((left, right) => right.vpip - left.vpip);
  console.log(
    `      six-max VPIP: ${ordered.map((seat) => `${seat.profileId}=${seat.vpip.toFixed(3)}`).join(' > ')}`,
  );
  const rho = spearmanRho(
    result.bySeat.map((seat) => requireProfile(seat.profileId).traits.vpip),
    result.bySeat.map((seat) => seat.vpip),
  );
  console.log(`      six-max Spearman rho (declared vs observed VPIP) = ${rho.toFixed(4)}`);
  assert.ok(rho >= MINIMUM_RHO, `six-handed ordering rho ${rho.toFixed(4)} is below ${MINIMUM_RHO}`);
  for (const seat of result.bySeat) {
    assert.equal(seat.handsDealt, STRUCTURAL_HANDS);
    assert.ok(seat.counts.preflopOpportunities > 0, `${seat.profileId} never got a preflop turn`);
  }
});
