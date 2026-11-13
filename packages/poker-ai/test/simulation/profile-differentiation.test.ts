/**
 * The evidence behind "twelve distinct styles". Tens of thousands of deterministic hands per profile
 * through the real engine show each profile's observed rates match its declared traits and separate
 * from the others by more than sampling noise. Nothing here says a profile plays well.
 *
 * Each profile plays heads-up against `reading-pressure-specialist`. A heads-up VPIP over-weights the
 * button, and a tight reference makes that worse (over 4,000 hands `fundamentals-coach` gave mean signed
 * VPIP error +0.050, worst 0.082, and this reference gives +0.026, worst 0.046). Quote every observed
 * figure with its reference.
 *
 * At 8,000 hands the 95% half-width is at most 0.011, so the 0.05 tolerance absorbs the positional
 * imbalance, not noise. The equity budget contributes nothing. 200 to 4,000 samples moved postflop
 * rates by at most 0.005 and preflop rates not at all. The VPIP tolerance is `OBSERVABLE_AXES`.
 *
 * The sweep takes about 70 seconds, so it runs only under `test:simulation`. The package `test`
 * script globs `test/*.test.ts` one level deep because `node --test` expands `**` across directories.
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

const REFERENCE_PROFILE = 'reading-pressure-specialist';
const DIFFICULTY: Difficulty = 'realistic';

/** The 95% sampling half-width (0.011) is a fifth of the tightest tolerance. */
const DECLARED_HANDS = 8_000;

/** Ordering-stability sweep at another seed. The 0.022 half-width is finer than the declared VPIP gaps. */
const SECOND_SEED_HANDS = 2_000;

/** Half-width 0.022 against spreads that differ by about 0.13. */
const DIFFICULTY_HANDS = 2_000;

/** Hands for the structural runs — the six-handed table and the carry-forward path. */
const STRUCTURAL_HANDS = 1_500;

const PRIMARY_SEED = 20_260_817;
const SECONDARY_SEED = 991;

/** Alpha for every separation claim. The two-sided normal critical value is 3.2906. */
const ALPHA = 0.001;

/**
 * One adjacent swap among twelve costs 0.007 of rho, and several declared VPIPs are 0.02 apart, so
 * near-tie swaps are expected. A random permutation has rho 0 with SD 0.30, so 0.90 is 3 SD out.
 */
const MINIMUM_RHO = 0.9;

const VPIP_TOLERANCE = (() => {
  const axis = OBSERVABLE_AXES.find((entry) => entry.key === 'vpip');
  if (axis === undefined) throw new Error('stats.ts no longer measures vpip');
  return axis.tolerance;
})();

/** PFR inherits VPIP's absolute error and cannot exceed VPIP. */
const PFR_TOLERANCE = VPIP_TOLERANCE;

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

/** Memoised because five tests make claims about the same sweep. */
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

  // The mean signed error is printed whether or not the assertion fails. A mean of the same order as
  // the misses is one systematic bias, and the trait it tracks points at the cause.
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
    // The policy clamps its own sizes to the engine's bounds.
    assert.equal(run.sizeClampsApplied, 0, `${where} proposed ${run.sizeClampsApplied} out-of-range sizes`);
    assert.ok(run.actionsApplied > DECLARED_HANDS, `${where} averaged under one action per hand`);
    // Heads-up, both seats see the same flops and showdowns. A mismatch is a harness attribution bug.
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
  // `stats.ts` measures the quantity each trait declares (`OBSERVABLE_AXES`), so all seven axes are
  // asserted.
  const lines: string[] = [];
  const failures: string[] = [];
  for (const { profile, stats } of primarySweep()) {
    const { divergences } = compareToDeclared(profile.naming.id, stats);
    for (const divergence of divergences) {
      const sentence = describeDivergence(divergence);
      assert.deepEqual(findImpersonation(sentence), [], sentence);
      lines.push(`      ${profile.naming.id} — ${divergence.key}: ${sentence}`);
      failures.push(`${profile.naming.id} — ${divergence.key}`);
    }
  }
  console.log(`      ${lines.length} divergence(s) across ${PROFILES.length} profiles:`);
  for (const line of lines) console.log(line);

  // The mean signed error per axis is printed every run. A mean of the same order as the misses is one
  // cause with twelve symptoms.
  //
  // `pfrShareOfVpip`, `bluffFrequency` and `betSizingPreference` are one-sided on all twelve profiles
  // but inside their per-profile tolerances. Nothing here diagnoses how large the bias should be, so
  // a direction band for them would be fitted to today's value. They stay printed, not asserted.
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
    // A one-sided bias worth half the axis slack is an error every profile shares.
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
  // Some profiles are close on any one axis by design, so only the count of separated pairs is asserted.
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

test('foldToPressure is printed against the turns it acts on, and its ordering is not asserted', () => {
  // Not asserted. `foldToBetFrequency` counts the preflop entry decision, which `vpip` decides, so its
  // ordering measures hand selection. A floor on rho would be fitted to today's value.
  const sweep = primarySweep();
  assert.equal(sweep.length, PROFILES.length, 'a sweep of nothing is not a pass');
  for (const { profile, stats } of sweep) {
    assert.ok(
      stats.counts.pricedFacingBetDecisions > 0,
      `${profile.naming.id} faced no priced bet, so its priced fold rate is not a measurement`,
    );
  }
  const declared = sweep.map((entry) => entry.profile.traits.foldToPressure);
  const allTurns = spearmanRho(
    declared,
    sweep.map((entry) => entry.stats.foldToBetFrequency),
  );
  const priced = spearmanRho(
    declared,
    sweep.map((entry) => entry.stats.pricedFoldToBetFrequency),
  );
  const handSelection = spearmanRho(
    sweep.map((entry) => entry.stats.vpip),
    sweep.map((entry) => entry.stats.foldToBetFrequency),
  );
  console.log(
    `      Spearman rho foldToPressure vs fold-to-bet = ${allTurns.toFixed(4)}, ` +
      `vs priced fold-to-bet = ${priced.toFixed(4)}; observed vpip vs fold-to-bet = ${handSelection.toFixed(4)}`,
  );
  for (const { profile, stats } of [...sweep].sort(
    (left, right) => left.stats.pricedFoldToBetFrequency - right.stats.pricedFoldToBetFrequency,
  )) {
    console.log(
      `      | ${profile.naming.id} | declared ${profile.traits.foldToPressure.toFixed(2)} | ` +
        `fold-to-bet ${stats.foldToBetFrequency.toFixed(3)} | priced ${stats.pricedFoldToBetFrequency.toFixed(3)} ` +
        `of ${stats.counts.pricedFacingBetDecisions} | vpip ${stats.vpip.toFixed(3)} |`,
    );
  }
});

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
  // `elapsedMs` is the only field allowed to differ.
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

test('educational play is measurably flatter than expert play across the same profiles', () => {
  // `educational` pulls every trait 40% toward the baseline, so the spread across profiles should
  // compress by about that factor. Added noise would leave the spread alone.
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

  // The declared traits compress by 0.6. 0.85 still rules out a difficulty setting that does nothing.
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
  // Structural only. This asserts the trait reaches the policy as 0. That a 0 trait stops the read
  // from moving a decision is asserted in `test/policy.test.ts`.
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

  // Search for a mixed spot rather than hard-coding one, so the test survives threshold changes.
  // No mixed spot in 400 real deals means the policy is scripted.
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
    // The policy samples its own hand assessment, so the reported distribution varies slightly by trial.
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

  // With at most five actions, a 4-sigma band per action keeps the family-wise false-positive rate
  // near 1e-4.
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

test('chips are conserved in every simulated hand, and the check actually ran', () => {
  // `test/invariants.test.ts` proves this for the engine. A harness bug would still invalidate every
  // number above.
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
  // Only the carry-forward path can bust. Short stacks make busts frequent.
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

  // One seat holds the whole table, so the transfer is exactly one starting stack.
  const nets = [...result.bySeat.map((seat) => seat.netChips)].sort((left, right) => left - right);
  assert.deepEqual(nets, [-startingStack, startingStack]);
});

test('a six-handed table runs the same way, with every seat measured', () => {
  // Six-handed exercises side pots, multiway streets and positions that heads-up does not.
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
