/**
 * Tests for the computed starting-hand strength table. Every check is a counting fact (169 classes,
 * 1326 combinations, 6/4/12 per class), a closed form (the combination-weighted mean is 0.5), a
 * structural inequality (suited beats its offsuit twin), or seeded determinism.
 * The shared table uses 2,000 samples per class, not the 20,000 default, and builds in about a third
 * of a second. Every class shares an identically seeded stream, so the noise cancels out of the
 * differences and the tightest suited-versus-offsuit gap is still over a point wide.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeStrengthTable,
  HandRankingError,
  strengthOf,
  strengthTable,
  topPercentRange,
} from '../src/hand-ranking.ts';
import { allHandClasses } from '../src/ranges.ts';

/** Reduced sample count, see the header. */
const TEST_SAMPLES = 2000;

const table = computeStrengthTable({ samplesPerClass: TEST_SAMPLES });
const byLabel = new Map(table.entries.map((entry) => [entry.label, entry]));
const classes = allHandClasses();

function entryFor(label: string): { equityVsRandom: number; rank: number; cumulativePercent: number } {
  const entry = byLabel.get(label);
  assert.ok(entry !== undefined, `the table is missing ${label}`);
  return entry;
}

test('the table holds exactly the 169 starting-hand classes, once each', () => {
  assert.equal(table.entries.length, 169, '13 pairs + 78 suited + 78 offsuit');
  assert.equal(new Set(table.entries.map((entry) => entry.label)).size, 169, 'no label appears twice');
  assert.deepEqual(
    new Set(table.entries.map((entry) => entry.label)),
    new Set(classes.map((handClass) => handClass.label)),
    'the same labels ranges.ts enumerates, no more and no fewer',
  );
  assert.equal(table.method, 'monte-carlo-vs-random');
  assert.equal(table.samplesPerClass, TEST_SAMPLES);
});

test('ranks run 1..169 with no gaps, strongest first', () => {
  assert.deepEqual(
    table.entries.map((entry) => entry.rank),
    Array.from({ length: 169 }, (_unused, index) => index + 1),
  );
  for (const [index, entry] of table.entries.entries()) {
    if (index === 0) continue;
    const previous = table.entries[index - 1];
    assert.ok(previous !== undefined);
    assert.ok(
      previous.equityVsRandom >= entry.equityVsRandom,
      `rank ${index} (${previous.label}) must not be weaker than rank ${index + 1} (${entry.label})`,
    );
  }
});

test('AA ranks first', () => {
  // AA is the only class never behind before the flop.
  assert.equal(table.entries[0]?.label, 'AA');
  assert.equal(entryFor('AA').rank, 1);
});

test('the ends of the table hold the hands they have to hold', () => {
  // 72o and 32o make nothing without help and must be in the tail. Membership, not exact rank, because
  // tail classes sit within half a point of each other. 32s is not asserted absent.
  const worstTen = new Set(table.entries.slice(-10).map((entry) => entry.label));
  const tail = [...worstTen].join(',');
  assert.ok(worstTen.has('72o'), `72o should be in the worst ten, tail was ${tail}`);
  assert.ok(worstTen.has('32o'), `32o should be in the worst ten, tail was ${tail}`);
  for (const label of worstTen) {
    // 22 wins about half of all-ins against a random hand, about fifteen points clear of the tail.
    assert.notEqual(label[0], label[1], `${label} is a pair and cannot be in the worst ten`);
  }

  // The five biggest pairs lead every unpaired hand and every smaller pair by two to three points,
  // far outside sampling noise.
  const topTen = new Set(table.entries.slice(0, 10).map((entry) => entry.label));
  for (const label of ['AA', 'KK', 'QQ', 'JJ', 'TT']) {
    assert.ok(topTen.has(label), `${label} should be in the top ten, head was ${[...topTen].join(',')}`);
  }
});

test('every pair beats the offsuit class of the same top rank', () => {
  // A pair starts as a made hand, so 88 beats 87o. All 78 offsuit classes are checked.
  let checked = 0;
  for (const handClass of classes) {
    if (handClass.shape !== 'offsuit') continue;
    const topRankChar = handClass.label.slice(0, 1);
    const pair = entryFor(`${topRankChar}${topRankChar}`);
    const offsuit = entryFor(handClass.label);
    assert.ok(
      pair.equityVsRandom > offsuit.equityVsRandom,
      `${topRankChar}${topRankChar} (${pair.equityVsRandom.toFixed(4)}) must beat ` +
        `${handClass.label} (${offsuit.equityVsRandom.toFixed(4)})`,
    );
    checked += 1;
  }
  assert.equal(checked, 78, 'there are 78 offsuit classes');
});

test('suited beats the identical offsuit class, for all 78 pairs of classes', () => {
  // A suited class holds the same ranks as its offsuit twin plus flushes, so the inequality must hold
  // 78 times out of 78.
  let checked = 0;
  let tightestGapPoints = Number.POSITIVE_INFINITY;
  let tightestPair = '';
  for (const handClass of classes) {
    if (handClass.shape !== 'suited') continue;
    const ranks = handClass.label.slice(0, 2);
    const suited = entryFor(`${ranks}s`);
    const offsuit = entryFor(`${ranks}o`);
    const gapPoints = (suited.equityVsRandom - offsuit.equityVsRandom) * 100;
    if (gapPoints < tightestGapPoints) {
      tightestGapPoints = gapPoints;
      tightestPair = ranks;
    }
    assert.ok(
      gapPoints > 0,
      `${ranks}s (${suited.equityVsRandom.toFixed(4)}) must beat ${ranks}o (${offsuit.equityVsRandom.toFixed(4)})`,
    );
    checked += 1;
  }
  assert.equal(checked, 78, 'there are 78 suited classes');
  // The margin is what makes the check above meaningful at this sample count.
  assert.ok(
    tightestGapPoints > 0.5,
    `tightest suited/offsuit gap was ${tightestGapPoints.toFixed(3)} points at ${tightestPair}, which is ` +
      'too close to the sampling noise for the ordering to mean anything',
  );
});

test('the combination-weighted mean equity is a half', () => {
  // equity(A vs B) + equity(B vs A) = 1, so the combination-weighted mean of `equityVsRandom` is
  // exactly 0.5. The 1.5-point tolerance is loose because the shared seed correlates the per-class
  // errors, so they do not cancel across classes.
  const comboCountOfLabel = new Map(classes.map((handClass) => [handClass.label, handClass.comboCount]));
  let weightedTotal = 0;
  let combos = 0;
  for (const entry of table.entries) {
    const count = comboCountOfLabel.get(entry.label) ?? 0;
    weightedTotal += count * entry.equityVsRandom;
    combos += count;
  }
  assert.equal(combos, 1326, 'the classes must cover all 1326 combinations');
  const mean = weightedTotal / combos;
  assert.ok(
    Math.abs(mean - 0.5) < 0.015,
    `combination-weighted mean equity was ${mean.toFixed(6)}, which is ${((mean - 0.5) * 100).toFixed(3)} ` +
      'points from the required 0.5',
  );
});

test('cumulativePercent is non-decreasing, weighted by combinations, and ends at 100', () => {
  // Recomputed from the 6/4/12 combination counts in ranges.ts, in rank order.
  const comboCountOfLabel = new Map(classes.map((handClass) => [handClass.label, handClass.comboCount]));
  let running = 0;
  let previous = 0;
  for (const entry of table.entries) {
    running += comboCountOfLabel.get(entry.label) ?? 0;
    const expected = (running / 1326) * 100;
    assert.ok(
      Math.abs(entry.cumulativePercent - expected) < 1e-12,
      `${entry.label}: cumulativePercent ${entry.cumulativePercent} should be ${expected}`,
    );
    assert.ok(entry.cumulativePercent >= previous, 'cumulativePercent must never decrease');
    previous = entry.cumulativePercent;
  }
  const last = table.entries[table.entries.length - 1]?.cumulativePercent ?? 0;
  assert.ok(Math.abs(last - 100) < 0.01, `the last cumulativePercent was ${last}, expected 100`);

  // AA is 6 of 1326 combinations = 0.4525%. Equal weighting of labels would give 1/169 = 0.5917%.
  assert.ok(Math.abs((table.entries[0]?.cumulativePercent ?? 0) - (6 / 1326) * 100) < 1e-12);
});

test('the same seed and sample count reproduce the table exactly', () => {
  // A learner must see the same figures as the next learner.
  const first = computeStrengthTable({ samplesPerClass: 600, seed: 4242 });
  const second = computeStrengthTable({ samplesPerClass: 600, seed: 4242 });
  assert.deepEqual(first, second);
  const different = computeStrengthTable({ samplesPerClass: 600, seed: 4243 });
  assert.notDeepEqual(
    first.entries.map((entry) => entry.equityVsRandom),
    different.entries.map((entry) => entry.equityVsRandom),
    'a different seed must actually draw different run-outs',
  );
});

test('computeStrengthTable rejects sample counts and seeds it cannot honour', () => {
  assert.throws(() => computeStrengthTable({ samplesPerClass: 0 }), HandRankingError);
  assert.throws(() => computeStrengthTable({ samplesPerClass: -100 }), HandRankingError);
  assert.throws(() => computeStrengthTable({ samplesPerClass: 1.5 }), HandRankingError);
  assert.throws(() => computeStrengthTable({ samplesPerClass: 10_000_000 }), HandRankingError);
  assert.throws(() => computeStrengthTable({ seed: 1.5 }), HandRankingError);
  assert.throws(() => computeStrengthTable({ seed: Number.NaN }), HandRankingError);
  assert.throws(
    () => computeStrengthTable({ samplesPerClass: 10 }),
    /between 200 and 200000/,
    'the message must say what was expected',
  );
});

test('the assumptions name the sampling, the framing, and what is NOT modelled', () => {
  // The equity figure must ship with "this is all-in equity, not playability".
  const joined = table.assumptions.join(' ').toLowerCase();
  assert.ok(table.assumptions.length >= 5);
  assert.ok(joined.includes('sampl'), 'must say the figures are sampled');
  assert.ok(joined.includes('all-in'), 'must say the figures are all-in equities');
  assert.ok(joined.includes('heads-up'), 'must say the comparison is heads-up');
  assert.ok(joined.includes('playability'), 'must say all-in equity is not playability');
  assert.ok(joined.includes('position'), 'must say position is not modelled');
  assert.ok(joined.includes('1,326') || joined.includes('1326'), 'must explain the combination weighting');
  assert.ok(joined.includes('chart'), 'must say the ordering is computed rather than copied');
});

test('strengthOf finds a class and returns null for anything else', () => {
  assert.equal(strengthOf('AA', table)?.rank, 1);
  assert.equal(strengthOf('AKs', table)?.label, 'AKs');
  assert.equal(strengthOf('AKx', table), null);
  assert.equal(strengthOf('', table), null);
});

// topPercentRange uses the memoised default table. These tests share the cost of building it.

test('the default table is memoised, and uses the documented defaults', () => {
  const first = strengthTable();
  const second = strengthTable();
  assert.equal(first, second, 'the memo must hand back the same object, not an equal one');
  assert.equal(first.samplesPerClass, 20_000);
  assert.equal(first.seed, 20_260_817);
  assert.equal(first.entries.length, 169);
  assert.equal(first.entries[0]?.label, 'AA', 'AA still ranks first at the default sample count');
});

test('topPercentRange(100) is every class, and topPercentRange(1) is a handful led by AA', () => {
  const everything = topPercentRange(100);
  assert.equal(everything.classes.length, 169);
  assert.equal(everything.combos.length, 1326);
  assert.ok(Math.abs(everything.fractionOfAllHands - 1) < 1e-12);

  const tightest = topPercentRange(1);
  const labels = tightest.classes.map((handClass) => handClass.label);
  assert.ok(labels.includes('AA'), `the top 1% must include AA, got ${labels.join(',')}`);
  assert.ok(labels.length <= 6, `the top 1% should be a handful of classes, got ${labels.length}`);
  // The range must cover at least 1% of 1326 = 13.26 combinations.
  assert.ok(
    tightest.fractionOfAllHands >= 0.01,
    `the top 1% covered only ${(tightest.fractionOfAllHands * 100).toFixed(3)}% of hands`,
  );
});

test('topPercentRange grows monotonically and always covers at least what was asked', () => {
  let previousCombos = 0;
  for (const percent of [1, 5, 10, 15, 20, 40, 75, 100]) {
    const range = topPercentRange(percent);
    assert.ok(
      range.fractionOfAllHands >= percent / 100 - 1e-12,
      `top ${percent}% covered ${(range.fractionOfAllHands * 100).toFixed(3)}%, which is less than asked`,
    );
    assert.ok(
      range.combos.length >= previousCombos,
      `top ${percent}% must not be smaller than the tighter range before it`,
    );
    previousCombos = range.combos.length;
    assert.ok(range.notation.includes('AA'));
  }
});

test('topPercentRange rejects percentages outside (0, 100]', () => {
  assert.throws(() => topPercentRange(0), HandRankingError);
  assert.throws(() => topPercentRange(-5), HandRankingError);
  assert.throws(() => topPercentRange(100.0001), HandRankingError);
  assert.throws(() => topPercentRange(Number.NaN), HandRankingError);
  assert.throws(() => topPercentRange(Number.POSITIVE_INFINITY), HandRankingError);
  assert.throws(() => topPercentRange(0), /greater than 0 and at most 100/);
});
