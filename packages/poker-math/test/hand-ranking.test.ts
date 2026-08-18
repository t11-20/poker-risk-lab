/**
 * Tests for the computed starting-hand strength table.
 *
 * ## Where the expected values come from
 *
 * Nothing here is compared against a published chart or against a figure this
 * package produced earlier. Every check is one of:
 *
 *   - a counting fact (169 classes, 1326 combinations, 6/4/12 per class),
 *   - a closed-form identity (a random hand against a random hand is worth exactly
 *     half the pot, so the combination-weighted mean of the table must be 0.5),
 *   - a structural inequality that holds for reasons independent of this code (a
 *     suited hand strictly dominates its offsuit twin: identical ranks, plus flushes),
 *   - or a determinism property of the seeded generator.
 *
 * ## Sample counts
 *
 * The shared table below uses 2,000 samples per class, NOT the 20,000 default, and
 * builds in roughly a third of a second instead of three seconds. 2,000 is enough for
 * every structural check here — the tightest of the 78 suited-versus-offsuit gaps is
 * still over a percentage point wide at that count, because every class is sampled
 * from an identically seeded stream and the shared noise cancels out of the
 * differences. The tests that must exercise the real default (`topPercentRange`, the
 * memo) pay for one full-precision table between them, once.
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
  // Ground truth: AA is the unique class that is never behind before the flop. It
  // holds the two best cards, dominates every other pair, and no other class can
  // start ahead of it, so no ordering by all-in equity can put anything above it.
  assert.equal(table.entries[0]?.label, 'AA');
  assert.equal(entryFor('AA').rank, 1);
});

test('the ends of the table hold the hands they have to hold', () => {
  // Ground truth for the tail: a hand of two low, unconnected, unsuited cards can
  // make nothing without help — no pair, no flush, and the gap removes most
  // straights. 72o and 32o are the canonical examples and must be down there.
  //
  // Membership, not exact rank: several offsuit tail classes sit within half a point
  // of each other in truth, so sampling reorders them freely and an exact-rank
  // assertion would be asserting noise. (32s is not asserted absent — the weakest
  // suited hand genuinely sits among the weakest offsuit ones.)
  const worstTen = new Set(table.entries.slice(-10).map((entry) => entry.label));
  const tail = [...worstTen].join(',');
  assert.ok(worstTen.has('72o'), `72o should be in the worst ten, tail was ${tail}`);
  assert.ok(worstTen.has('32o'), `32o should be in the worst ten, tail was ${tail}`);
  for (const label of worstTen) {
    // A pair cannot reach the tail: the weakest of them, 22, is a made hand and wins
    // about half of all-ins against a random holding, roughly fifteen points clear of
    // anything down here.
    assert.notEqual(label[0], label[1], `${label} is a pair and cannot be in the worst ten`);
  }

  // Ground truth for the head: the five biggest pairs each start ahead of every
  // unpaired hand and ahead of every smaller pair, with gaps of two to three points
  // between them — far outside the sampling noise.
  const topTen = new Set(table.entries.slice(0, 10).map((entry) => entry.label));
  for (const label of ['AA', 'KK', 'QQ', 'JJ', 'TT']) {
    assert.ok(topTen.has(label), `${label} should be in the top ten, head was ${[...topTen].join(',')}`);
  }
});

test('every pair beats the offsuit class of the same top rank', () => {
  // Ground truth: 88 versus 87o is not a matter of taste. The pair starts as a made
  // hand; the offsuit holding needs to improve, and every eight in the deck it could
  // pair is already accounted for. All 78 offsuit classes are checked.
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
  // The strongest structural check in this file. A suited class and its offsuit twin
  // hold the SAME two ranks; the suited version can additionally make a flush and can
  // never do worse for it. So the inequality must hold 78 times out of 78 — one
  // failure means the table is wrong or too noisy to use, not that the sample was
  // unlucky.
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
  // Recorded rather than asserted tightly: the margin is what makes the check above
  // meaningful at this sample count, and a future change that shrinks it towards zero
  // should be noticed here first.
  assert.ok(
    tightestGapPoints > 0.5,
    `tightest suited/offsuit gap was ${tightestGapPoints.toFixed(3)} points at ${tightestPair}, which is ` +
      'too close to the sampling noise for the ordering to mean anything',
  );
});

test('the combination-weighted mean equity is a half', () => {
  // Closed-form ground truth, independent of every number in the table: for any two
  // hands, equity(A vs B) + equity(B vs A) = 1. Average over B uniform and you get
  // this table's `equityVsRandom` for A; average that over A uniform — which means
  // weighting each class by its 6, 4 or 12 combinations — and the answer must be
  // exactly 0.5.
  //
  // The tolerance is 1.5 percentage points and that looseness is deliberate rather
  // than sloppy: every class is sampled from an identically seeded stream, so the
  // per-class errors are strongly correlated and do NOT cancel across the 169 classes
  // the way independent errors would. That correlation is what makes the ordering
  // trustworthy at 2,000 samples; the price is a weaker check on the absolute level.
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
  // Ground truth: recomputed here from the 6/4/12 combination counts in ranges.ts,
  // in rank order, with no reference to the values the table reported.
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

  // AA alone is 6 of 1326 combinations = 0.4525%. If the table had weighted the 169
  // labels equally instead, the first entry would read 1/169 = 0.5917%, so this one
  // number distinguishes the two.
  assert.ok(Math.abs((table.entries[0]?.cumulativePercent ?? 0) - (6 / 1326) * 100) < 1e-12);
});

test('the same seed and sample count reproduce the table exactly', () => {
  // Sampling is only defensible in a teaching tool if the figures a learner sees are
  // the figures the next learner sees.
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
  // A product guardrail, not a formatting check: an equity figure shipped without
  // "this is all-in equity, not playability" teaches the wrong lesson, and this file
  // is where that regression would be caught.
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

// ---------------------------------------------------------------------------
// topPercentRange, which deliberately uses the memoised DEFAULT table. The three
// tests below share the cost of building it once.
// ---------------------------------------------------------------------------

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
  // Ground truth for "at least": the range must cover the requested share, so its
  // combination count cannot be below 1% of 1326 = 13.26 combinations.
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
    // Built through parseRange, so it must round-trip as ordinary notation.
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
