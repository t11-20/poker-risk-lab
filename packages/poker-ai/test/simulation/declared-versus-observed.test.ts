/**
 * Declared versus observed on aggression and 3-bet, counted here without `stats.ts`. It drives the
 * real policy through the real engine and derives every frequency from `PlayerView.legalActions` and
 * the returned action, so a denominator mistake in `stats.ts` cannot make both files agree.
 *
 * `aggressionFrequency` is the rate on a neutral hand assessment, with folds out of the denominator
 * (folding is `foldToPressure`). An unconditional rate cannot reach it, because about 60% of turns
 * are air bet at `bluffFrequency`. Solving u = a·b + (1 − a)·r gives r > 1 for six of twelve profiles.
 * `threeBetTendency` is a multiplier on the flat-call range, so the asserted frequency is
 * `threeBetRaiseShare`, re-raises among openings the profile plays back at. Tolerances are 0.18 and
 * 0.15. The unconditional rates are printed beside the conditional ones.
 *
 * A different seed from `profile-differentiation.test.ts`. 6,000 hands puts the smallest denominator
 * at a 95% half-width of about 0.08. About 75 seconds, so it lives under `test/simulation/`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, isNeutralAssessment, threeBetRaiseShare } from '../../src/policy.ts';
import { PROFILES, type StrategyProfile } from '../../src/profiles.ts';
import { seatStats, simulate } from '../../src/simulate.ts';
import {
  compareToDeclared,
  holdingIsAir,
  OBSERVABLE_AXES,
  type SeatSimulationStats,
} from '../../src/stats.ts';

const REFERENCE_PROFILE = 'reading-pressure-specialist';
const DIFFICULTY = 'realistic';
const HANDS = 6_000;
const SEED = 4_180_339;
const BIG_BLIND = 100;

/**
 * Tolerance and declared side come from the package, the observed side is counted here. A package
 * still comparing the old quantity then disagrees with this file.
 */
function axisFor(key: 'aggressionFrequency' | 'threeBetTendency') {
  const axis = OBSERVABLE_AXES.find((entry) => entry.key === key);
  if (axis === undefined) throw new Error(`stats.ts no longer measures ${key}`);
  return axis;
}

/** Recomputed from the view and the returned action, never read off `SeatSimulationStats`. */
interface OwnCounts {
  aggressionOpportunities: number;
  aggressiveActions: number;
  neutralOpportunities: number;
  neutralFolds: number;
  neutralAggressive: number;
  airOpportunities: number;
  airAggressive: number;
  openSpots: number;
  openEntries: number;
  openEntryRaises: number;
  openRaisesOverSpots: number;
}

interface ProfileRun {
  readonly profile: StrategyProfile;
  readonly own: OwnCounts;
  /** For the cross-check only. */
  readonly packageStats: SeatSimulationStats;
}

let cache: readonly ProfileRun[] | null = null;

function sweep(): readonly ProfileRun[] {
  if (cache !== null) return cache;
  const startedAt = Date.now();
  cache = PROFILES.map((profile) => {
    const own: OwnCounts = {
      aggressionOpportunities: 0,
      aggressiveActions: 0,
      neutralOpportunities: 0,
      neutralFolds: 0,
      neutralAggressive: 0,
      airOpportunities: 0,
      airAggressive: 0,
      openSpots: 0,
      openEntries: 0,
      openEntryRaises: 0,
      openRaisesOverSpots: 0,
    };

    const run = simulate(
      {
        profileIds: [profile.naming.id, REFERENCE_PROFILE],
        difficulty: DIFFICULTY,
        hands: HANDS,
        seed: SEED,
        startingStack: BIG_BLIND * 100,
        smallBlind: BIG_BLIND / 2,
        bigBlind: BIG_BLIND,
        resetStacksEachHand: true,
      },
      {
        // The real policy, wrapped so each decision is counted.
        decide: (input) => {
          const decision = decide(input);
          if (input.seat === 0) count(own, input, decision);
          return decision;
        },
      },
    );

    return { profile, own, packageStats: seatStats(run, 0) };
  });
  console.log(
    `      independent sweep: ${PROFILES.length} profiles x ${HANDS} hands vs ${REFERENCE_PROFILE} ` +
      `at ${DIFFICULTY}, seed ${SEED} — ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  return cache;
}

function count(
  own: OwnCounts,
  input: Parameters<typeof decide>[0],
  decision: ReturnType<typeof decide>,
): void {
  const view = input.view;
  const legal = view.legalActions;
  const aggressionAvailable = legal.some((entry) => entry.type === 'bet' || entry.type === 'raise');
  if (!aggressionAvailable) return;
  const chosen = decision.action.type;
  const aggressive = chosen === 'bet' || chosen === 'raise';

  if (view.street !== 'preflop') {
    own.aggressionOpportunities += 1;
    if (aggressive) own.aggressiveActions += 1;
    // "Neutral" is the policy's own band on its own published assessment. The trait is about the
    // model's read, so nothing computed from the cards substitutes for it.
    if (isNeutralAssessment(decision.strength.relativeStrength)) {
      own.neutralOpportunities += 1;
      // Folds leave the denominator because folding is `foldToPressure`. Counting them reads 0.045
      // low on the profile with the highest `foldToPressure`.
      if (chosen === 'fold') own.neutralFolds += 1;
      if (aggressive) own.neutralAggressive += 1;
    }
    // Air is classified from the cards, which nobody at the table may see.
    if (holdingIsAir(input.holeCards, view.board)) {
      own.airOpportunities += 1;
      if (aggressive) own.airAggressive += 1;
    }
    return;
  }

  const raisedThisStreet = view.actions.some(
    (logged) =>
      logged.street === 'preflop' && (logged.action.type === 'bet' || logged.action.type === 'raise'),
  );
  // Only the seat's first voluntary preflop turn is gated by the entry threshold. Later preflop turns
  // are priced on equity.
  const isEntryDecision = !view.actions.some(
    (logged) => logged.seat === input.seat && logged.action.type !== 'fold',
  );
  if (!raisedThisStreet || !isEntryDecision) return;

  own.openSpots += 1;
  if (aggressive) own.openRaisesOverSpots += 1;
  if (chosen === 'call' || aggressive) {
    own.openEntries += 1;
    if (aggressive) own.openEntryRaises += 1;
  }
}

const rate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

test('every profile bets and raises at its declared rate on the hands the trait declares it for', () => {
  const axis = axisFor('aggressionFrequency');
  const tolerance = axis.tolerance;
  const failures: string[] = [];
  const mismeasured: string[] = [];
  const deltas: number[] = [];
  const unconditionalDeltas: number[] = [];

  console.log(
    '      | profile | declared | measured (neutral read) | delta | n | unconditional | delta | n |',
  );
  for (const { profile, own, packageStats } of sweep()) {
    const declared = profile.traits.aggressionFrequency;
    const measured = rate(own.neutralAggressive, own.neutralOpportunities - own.neutralFolds);
    const unconditional = rate(own.aggressiveActions, own.aggressionOpportunities);
    // The package must compare the card against this conditional number.
    if (axis.observedFrom(packageStats) !== measured) {
      mismeasured.push(
        `${profile.naming.id}: stats.ts compares the card against ` +
          `${axis.observedFrom(packageStats).toFixed(4)}, but the rate on the declared condition ` +
          `is ${measured.toFixed(4)} (unconditional ${unconditional.toFixed(4)})`,
      );
    }
    deltas.push(measured - declared);
    unconditionalDeltas.push(unconditional - declared);
    console.log(
      `      | ${profile.naming.id} | ${declared.toFixed(3)} | ${measured.toFixed(4)} | ` +
        `${signed(measured - declared)} | ${own.neutralOpportunities - own.neutralFolds} | ` +
        `${unconditional.toFixed(4)} | ${signed(unconditional - declared)} | ` +
        `${own.aggressionOpportunities} | margin ${(tolerance - Math.abs(measured - declared)).toFixed(4)} ` +
        `| pressure ${profile.traits.pressureTendency.toFixed(2)} ` +
        `barrel ${profile.traits.barrelPersistence.toFixed(2)} |`,
    );
    assert.ok(own.neutralOpportunities > 100, `${profile.naming.id}: only ${own.neutralOpportunities} spots`);
    // Margin is printed for every profile. The residual tracks `pressureTendency` and
    // `barrelPersistence` (neutral at 0.5). `disciplined-specialist` (0.38 and 0.38) is closest.
    if (Math.abs(measured - declared) > tolerance) {
      failures.push(
        `${profile.naming.id}: declared ${declared.toFixed(3)}, measured ${measured.toFixed(4)} over ` +
          `${own.neutralOpportunities} neutral spots (${signed(measured - declared)}, tolerance ${tolerance})`,
      );
    }
  }

  console.log(
    `      mean signed error: on the declared condition ${signed(mean(deltas))}, ` +
      `unconditional ${signed(mean(unconditionalDeltas))} ` +
      `(${unconditionalDeltas.filter((delta) => delta < 0).length}/${unconditionalDeltas.length} below)`,
  );

  assert.deepEqual(
    mismeasured,
    [],
    'the axis that checks the profile card is not reading the quantity the card declares:\n  ' +
      `${mismeasured.join('\n  ')}`,
  );
  assert.deepEqual(failures, [], `measured on the condition the card states:\n  ${failures.join('\n  ')}`);
  // A one-sided mean worth half the allowance is one cause with twelve symptoms.
  assert.ok(
    Math.abs(mean(deltas)) <= tolerance / 2,
    `mean signed error ${signed(mean(deltas))} across ${deltas.length} profiles is a systematic bias`,
  );
});

test('every profile re-raises the declared share of the openings it plays back at', () => {
  const axis = axisFor('threeBetTendency');
  const tolerance = axis.tolerance;
  const failures: string[] = [];
  const mismeasured: string[] = [];
  const deltas: number[] = [];

  console.log(
    '      | profile | tendency | declared share | measured | delta | entries | 3-bet freq | ceiling (vpip) |',
  );
  for (const { profile, own, packageStats } of sweep()) {
    const declared = threeBetRaiseShare(profile.traits);
    const measured = rate(own.openEntryRaises, own.openEntries);
    deltas.push(measured - declared);
    // The fix moved both sides, from the raw multiplier to its share and from the unconditional
    // 3-bet frequency to the share among entries.
    if (axis.declaredFrom(profile.traits) !== declared || axis.observedFrom(packageStats) !== measured) {
      mismeasured.push(
        `${profile.naming.id}: stats.ts compares ${axis.declaredFrom(profile.traits).toFixed(4)} ` +
          `against ${axis.observedFrom(packageStats).toFixed(4)}; the multiplier's own frequency is ` +
          `${declared.toFixed(4)} against a measured ${measured.toFixed(4)}`,
      );
    }
    console.log(
      `      | ${profile.naming.id} | ${profile.traits.threeBetTendency.toFixed(2)} | ` +
        `${declared.toFixed(4)} | ${measured.toFixed(4)} | ${signed(measured - declared)} | ` +
        `${own.openEntries} | ${rate(own.openRaisesOverSpots, own.openSpots).toFixed(4)} | ` +
        `${profile.traits.vpip.toFixed(2)} |`,
    );
    assert.ok(own.openEntries > 100, `${profile.naming.id}: only ${own.openEntries} entries facing an open`);
    if (Math.abs(measured - declared) > tolerance) {
      failures.push(
        `${profile.naming.id}: declared share ${declared.toFixed(4)}, measured ${measured.toFixed(4)} ` +
          `over ${own.openEntries} entries (${signed(measured - declared)}, tolerance ${tolerance})`,
      );
    }
    // The raw 3-bet frequency is capped by the entry rate, a different declared number.
    const threeBetFrequency = rate(own.openRaisesOverSpots, own.openSpots);
    assert.ok(
      threeBetFrequency <= profile.traits.vpip + 0.1,
      `${profile.naming.id}: 3-bet frequency ${threeBetFrequency.toFixed(4)} above its own entry rate`,
    );
  }

  console.log(`      mean signed error: ${signed(mean(deltas))}`);
  assert.deepEqual(
    mismeasured,
    [],
    'the axis that checks the profile card is not reading the quantity the card declares:\n  ' +
      `${mismeasured.join('\n  ')}`,
  );
  assert.deepEqual(
    failures,
    [],
    `measured as the share the multiplier declares:\n  ${failures.join('\n  ')}`,
  );
  assert.ok(
    Math.abs(mean(deltas)) <= tolerance / 2,
    `mean signed error ${signed(mean(deltas))} across ${deltas.length} profiles is a systematic bias`,
  );
});

test('reading aggressionFrequency as an unconditional rate is arithmetically impossible', () => {
  // Computed from this run's air share and the declared bluff frequency. If several profiles need a
  // non-air rate above 1, the unconditional axis was unsatisfiable.
  const impossible: string[] = [];
  for (const { profile, own } of sweep()) {
    const airShare = rate(own.airOpportunities, own.aggressionOpportunities);
    const needed =
      (profile.traits.aggressionFrequency - airShare * profile.traits.bluffFrequency) / (1 - airShare);
    if (needed > 1) {
      impossible.push(
        `${profile.naming.id}: air share ${airShare.toFixed(3)}, declared bluff ` +
          `${profile.traits.bluffFrequency.toFixed(2)}, so an unconditional ` +
          `${profile.traits.aggressionFrequency.toFixed(2)} needs ${needed.toFixed(3)} on every other hand`,
      );
    }
  }
  console.log(`      ${impossible.length}/${PROFILES.length} profiles cannot satisfy the old reading:`);
  for (const line of impossible) console.log(`      ${line}`);
  assert.ok(
    impossible.length >= 4,
    'the unconditional reading is expected to be unsatisfiable for several profiles; if it is now ' +
      'satisfiable for all of them the trait set has changed and this fix should be re-argued',
  );
});

test('the package measures the same numbers this file counted, from its own denominators', () => {
  // `stats.ts` once published the unconditional rate on both axes, which disagrees with this count by
  // 0.10 and 0.30.
  for (const { profile, own, packageStats } of sweep()) {
    const where = profile.naming.id;
    assert.equal(
      packageStats.counts.aggressionOpportunities,
      own.aggressionOpportunities,
      `${where}: aggression denominators disagree`,
    );
    assert.equal(
      packageStats.counts.neutralAggressionOpportunities,
      own.neutralOpportunities,
      `${where}: neutral denominators disagree`,
    );
    assert.equal(
      packageStats.counts.neutralAggressiveActions,
      own.neutralAggressive,
      `${where}: neutral numerators disagree`,
    );
    assert.equal(packageStats.counts.neutralFolds, own.neutralFolds, `${where}: neutral folds disagree`);
    assert.equal(packageStats.counts.threeBetEntries, own.openEntries, `${where}: entries disagree`);
    assert.equal(
      packageStats.counts.threeBetEntryRaises,
      own.openEntryRaises,
      `${where}: entry re-raises disagree`,
    );
    const aggressionAxis = OBSERVABLE_AXES.find((axis) => axis.key === 'aggressionFrequency');
    const threeBetAxis = OBSERVABLE_AXES.find((axis) => axis.key === 'threeBetTendency');
    assert.ok(aggressionAxis !== undefined && threeBetAxis !== undefined);
    assert.equal(
      aggressionAxis.observedFrom(packageStats),
      rate(own.neutralAggressive, own.neutralOpportunities - own.neutralFolds),
      `${where}: the aggression axis does not read the neutral-assessment rate`,
    );
    assert.equal(
      threeBetAxis.observedFrom(packageStats),
      rate(own.openEntryRaises, own.openEntries),
      `${where}: the 3-bet axis does not read the entry re-raise share`,
    );
    assert.deepEqual(
      compareToDeclared(where, packageStats).divergences.map((entry) => entry.key),
      [],
      `${where} does not behave the way its card claims at seed ${SEED}`,
    );
  }
});
