/**
 * Does the model actually do what its card says, on the two axes the card was wrong about?
 *
 * `profile-differentiation.test.ts` asserts the same property through `stats.ts`. This file
 * asserts it **without** `stats.ts`: it drives the real policy through the real engine, keeps
 * its own counters from the raw `PlayerView.legalActions` and the action the policy returned,
 * and derives every frequency here. A shared mistake in a denominator cannot make both files
 * agree, because only one of them has the denominators.
 *
 * ## What went wrong, and why the fix was definitional rather than a retune
 *
 * Every one of the twelve profiles measured LESS aggressive and LESS 3-bet-happy than its own
 * card, on both axes, by 0.03 to 0.19 — mean signed error -0.0953 on aggression, twelve out of
 * twelve below declared. A one-sided miss on that scale is one cause with twelve symptoms.
 *
 * The cause is that the two sides of the comparison were different quantities.
 *
 * **Aggression.** `traits.aggressionFrequency` is defined as the rate "when aggression is
 * available **and its hand assessment is neutral**". The measurement averaged over every
 * postflop turn on which a bet or raise was legal. About 60% of those turns are air, and on
 * air the model bets at `bluffFrequency`, which every profile declares far below its
 * `aggressionFrequency` — so the unconditional average has to land between the two. It cannot
 * land on the higher one. Writing `u` for the unconditional rate, `a` for the air share, `b`
 * for the declared bluff frequency and `r` for the rate on everything else:
 *
 *     u = a·b + (1 − a)·r   ⟹   r = (u − a·b) / (1 − a)
 *
 * Ask for `u` equal to the declared aggression frequency at the measured air share and `r`
 * comes out above 1 for six of the twelve profiles — `reading-pressure-specialist` needs 1.19.
 * The old comparison was not a target the model missed. It was unsatisfiable, against a
 * `bluffFrequency` axis in the same list that passes. The last test in this file recomputes
 * that from the measured air share rather than taking it on trust.
 *
 * The same argument then applies once more inside the condition. The aggressive line's
 * alternative is the PASSIVE line — check or call. Folding is neither, and how readily this
 * model folds is `foldToPressure`, a separate declared trait with its own axis. Counting folds
 * in the aggression denominator measures a blend of two traits and reads low exactly where the
 * other trait is high: worth 0.03 of the rate on average and 0.045 on `disciplined-specialist`,
 * whose `foldToPressure` of 0.76 is the highest in the set. So folds leave the denominator, and
 * the fold count is asserted against the package's own separately.
 *
 * **Three-bet.** `traits.threeBetTendency` is documented as a multiplier on the range the
 * model would merely flat-call with, not as a frequency. Reading it as one compares a knob
 * against a rate whose ceiling is a *different* number on the same card: a re-raise requires
 * entering the pot, so the realised 3-bet frequency is bounded above by the entry rate.
 * `disciplined-specialist` declares `vpip` 0.15 and `threeBetTendency` 0.44, and re-raising
 * 44% of the openings it faces would mean abandoning the first figure. The multiplier's only
 * frequency is `threeBetRaiseShare` — the share of the openings it plays back at that it
 * re-raises rather than flat-calls — and that is what is asserted here.
 *
 * So the fix moved neither a constant nor a tolerance. It moved which quantity is placed next
 * to which. The aggression tolerance is the same 0.18 it always was; the 3-bet tolerance was
 * **narrowed** from 0.30 to 0.15, because a like-for-like comparison does not need the slack
 * that a knob-against-a-rate comparison did.
 *
 * ## Both readings are reported, always
 *
 * The unconditional rates are printed next to the conditional ones on every row. They are real
 * numbers about real behaviour — they are what a hand-history tracker would show a learner —
 * and hiding them would replace one dishonesty with another. What they are not is comparable
 * to the card, and the table says which column is which.
 *
 * ## Run parameters
 *
 * A different seed from `profile-differentiation.test.ts` on purpose: a definitional fix that
 * only held at one seed would be a coincidence. 6,000 hands per profile puts a few hundred
 * turns in the neutral band and a few hundred entries facing an open, which is the tightest
 * denominator here — the 95% half-width on the smallest of them is about 0.08, well inside
 * both tolerances. About 75 seconds, which is why this lives under `test/simulation/`.
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
 * The axis under test, read off `stats.ts` rather than restated here.
 *
 * The TOLERANCE and the DECLARED side come from the package; the OBSERVED side is counted in
 * this file and never read from `stats.ts` except to cross-check it. That split is what makes
 * each test below fail on the unfixed source rather than quietly passing: the fix changed what
 * the package declares and measures on these two axes, so a test that derives its own
 * measurement and then asks the package what it is comparing against will disagree with a
 * package still comparing the old quantity.
 */
function axisFor(key: 'aggressionFrequency' | 'threeBetTendency') {
  const axis = OBSERVABLE_AXES.find((entry) => entry.key === key);
  if (axis === undefined) throw new Error(`stats.ts no longer measures ${key}`);
  return axis;
}

/**
 * One profile's behaviour, counted here rather than read off `SeatSimulationStats`.
 *
 * `aggressionOpportunities` and the rest are deliberately recomputed from the view the engine
 * handed the policy and the action the policy returned. The point of this file is that a
 * denominator error in `stats.ts` cannot hide behind agreement with itself.
 */
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
  /** The package's own measurement of the same run, for the cross-check only. */
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
        // The REAL policy, wrapped so the decision can be counted on the way past. A claim
        // about the profiles has to be a claim about the code a learner plays against.
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

/** The whole measurement, in one function, reading only the view and the returned decision. */
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
    // "Neutral" is the policy's own band, applied to the policy's own published assessment.
    // The condition the trait states is about the model's read of its hand, so nothing the
    // observer could compute from the cards is a substitute for it.
    if (isNeutralAssessment(decision.strength.relativeStrength)) {
      own.neutralOpportunities += 1;
      // Folds leave the denominator: the aggressive line's alternative is the passive line, and
      // how readily this model folds is `foldToPressure`, a different declared trait with its
      // own axis. Keeping folds here makes this axis read low in proportion to that other
      // trait — 0.045 on the profile whose `foldToPressure` is highest.
      if (chosen === 'fold') own.neutralFolds += 1;
      if (aggressive) own.neutralAggressive += 1;
    }
    // Air is the observer's classification, from cards nobody at the table may see, and it is
    // what makes the impossibility argument in the module comment a measurement rather than an
    // assumption.
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
  // The entry decision is the turn on which this seat has not yet acted voluntarily. A later
  // preflop turn is priced on equity rather than gated by the entry threshold, so pooling it in
  // would measure a blend of what the trait controls and what it does not.
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

// ---------------------------------------------------------------------------

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
    // The package must be comparing the card against THIS number, not against the
    // unconditional one below it. Checked here rather than only in the cross-check test, so a
    // package that reverted to the unconditional rate fails the test that reads like the claim.
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
    // Headroom, printed for every profile whether or not it fails. The residual on this axis is
    // not uniform: it tracks `pressureTendency` and `barrelPersistence`, both of which multiply
    // the aggressive weight and are neutral only at 0.5, so a profile whose vector sits far
    // below 0.5 on both spends a real share of the allowance. `disciplined-specialist` (0.38 and
    // 0.38, the lowest pair in the set) is the one to watch, and the margin column is how anyone
    // reading a future failure sees whether it drifted or was always close.
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
  // Direction, separately from size. Twelve independent misses scatter; a one-sided mean worth
  // half the allowance is one cause with twelve symptoms, and that is what the unconditional
  // reading showed. Widening the tolerance would hide exactly this.
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
    // Both sides, because this axis's fix moved both: the declared side from the raw
    // multiplier to the share it produces, and the observed side from the unconditional 3-bet
    // frequency to the share among entries.
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
    // The reason the raw 3-bet frequency was never the right column: it cannot exceed the rate
    // at which the profile enters a pot at all, so it is capped by a different declared number.
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
  // Not an argument, a calculation, from this run's own measured air share and the declared
  // bluff frequency the same suite asserts on. If several profiles need a rate above 1 on
  // every non-air hand, the old axis could not have been satisfied by any model that also
  // honoured its declared bluff frequency — which is the difference between a defect and a
  // definition, and the reason the fix is not a retune.
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
  // The cross-check that makes the two files evidence rather than one file twice. It is also
  // the assertion that fails on the unfixed source: `stats.ts` used to publish the
  // unconditional rate on both axes, which disagrees with the counting above by 0.10 and 0.30.
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
    // And the axis accessors read those counts, so `compareToDeclared` is checking the same
    // thing the two tests above assert by hand.
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
