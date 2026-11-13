/**
 * Everything the Coach publishes must survive JSON, which has no `Infinity` (`JSON.stringify`
 * turns it into `null`). A free call's `oddsRatio` once reached the browser as `null` and crashed
 * `/play`. The walk covers the whole report, so the next unserialisable member fails too. Three claims:
 *
 *  1. `JSON.parse(JSON.stringify(x))` deep-strict-equals `x`.
 *  2. Nothing in the tree is a non-finite number.
 *  3. Nothing in the tree is `undefined`. Optional members must be absent under
 *     `exactOptionalPropertyTypes`.
 *
 * Both a priced spot and a free-call spot are checked.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CoachReport } from '@prl/contracts';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport, type CoachInput } from '../src/coach.ts';
import { type PotOdds, potOdds, priceLaidByBet } from '../src/odds.ts';
import { exactRange } from '../src/ranges.ts';

/** A flop spot: nut flush draw against a set. `toCall` is what each test varies. */
function spot(toCall: number): CoachInput {
  return {
    heroCards: parseCards('Ah Kh'),
    board: parseCards('Qh 7h 2c'),
    street: 'flop',
    opponents: [{ label: 'the big blind', range: exactRange(parseCards('Qs Qd')) }],
    pot: 100,
    // Hero covers the bet out of 400 behind.
    contestablePot: 100,
    toCall,
    heroCommittedThisStreet: 0,
    heroStack: 400,
    opponentStacks: [400],
    bigBlind: 10,
  };
}

/** Every leaf of a value, with the path that reaches it, so a failure names the member. */
function* leaves(value: unknown, path: string): Generator<readonly [string, unknown]> {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) yield* leaves(entry, `${path}[${index}]`);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) yield* leaves(entry, `${path}.${key}`);
    return;
  }
  yield [path, value];
}

/** Claims 2 and 3: the two kinds of value that do not make the trip, named at their path. */
function assertWireSafe(value: unknown, label: string, minimumLeaves: number): void {
  let counted = 0;
  for (const [path, leaf] of leaves(value, label)) {
    counted += 1;
    assert.notEqual(leaf, undefined, `${path} is undefined, which JSON drops entirely`);
    if (typeof leaf === 'number') {
      assert.equal(
        Number.isFinite(leaf),
        true,
        `${path} is ${String(leaf)}, which JSON.stringify turns into null — the exact defect this ` +
          'file exists for. Use null as the "there is no figure" value, or a finite number.',
      );
    }
  }
  // The walk must have found something. The floor is passed in because a `PotOdds` has five members
  // and a `CoachReport` hundreds.
  assert.ok(
    counted >= minimumLeaves,
    `${label}: expected at least ${minimumLeaves} leaves, walked ${counted}`,
  );
}

/** Claim 1, plus the walk, for one value. Returns the parsed copy so callers can read it. */
function roundTrip<T>(value: T, label: string, minimumLeaves: number): unknown {
  assertWireSafe(value, label, minimumLeaves);
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  assert.deepEqual(parsed, value, `${label} did not survive JSON.parse(JSON.stringify(x)) unchanged`);
  return parsed;
}

test('PotOdds survives the wire, priced and free alike', () => {
  const priced = potOdds(100, 50);
  const free = potOdds(120, 0);
  const laid = priceLaidByBet(100, 100);

  roundTrip(priced, 'potOdds(100, 50)', 5);
  roundTrip(free, 'potOdds(120, 0)', 5);
  roundTrip(laid, 'priceLaidByBet(100, 100)', 5);

  // The free spot keeps a null that is distinguishable from a price of 0.
  assert.equal(priced.oddsRatio, 2);
  assert.equal(free.oddsRatio, null);
  assert.notEqual(free.oddsRatio, 0);

  const parsedFree: PotOdds = JSON.parse(JSON.stringify(free)) as PotOdds;
  assert.equal(parsedFree.oddsRatio, null);
  assert.equal(typeof parsedFree.breakEvenEquity, 'number');
});

test('a whole CoachReport survives the wire, on a priced spot and on a check spot', () => {
  for (const [label, toCall] of [
    ['a priced spot', 50],
    ['a check spot', 0],
  ] as const) {
    const report: CoachReport = buildCoachReport(spot(toCall));
    const parsed = roundTrip(report, `CoachReport for ${label}`, 40) as CoachReport;

    // Checked on both sides of the trip, not left to the deep comparison.
    assert.equal(parsed.potOdds.oddsRatio, report.potOdds.oddsRatio, `${label}: oddsRatio drifted`);
    assert.equal(
      typeof parsed.potOdds.oddsRatio,
      typeof report.potOdds.oddsRatio,
      `${label}: oddsRatio changed type in transit`,
    );
    if (toCall === 0) {
      assert.equal(parsed.potOdds.oddsRatio, null, 'a check spot has no price, and null is how it says so');
    } else {
      assert.equal(typeof parsed.potOdds.oddsRatio, 'number');
    }
  }
});

test('a check spot says "there is no price" in words a learner can read', () => {
  // No learner-facing string may leak the representation: "Infinity to 1", "0 to 1" or "null to 1".
  const report = buildCoachReport(spot(0));
  const prose = [
    report.potOdds.explanation,
    ...report.teachingNotes,
    ...report.assumptions,
    report.suggestion.reason,
    report.uncertainty.summary,
    potOdds(120, 0).explanation,
  ];

  for (const text of prose) {
    assert.equal(text.includes('Infinity'), false, `an implementation sentinel reached the reader: ${text}`);
    assert.equal(text.includes('null'), false, `an implementation sentinel reached the reader: ${text}`);
    assert.equal(text.includes('NaN'), false, `an implementation sentinel reached the reader: ${text}`);
    // No numeric price on a free spot. The pattern needs a digit, so `There is no "X to 1" price` passes.
    assert.equal(/\d(\.\d+)? to 1\b/.test(text), false, `a free call quoted a numeric price: ${text}`);
  }

  assert.match(report.potOdds.explanation, /nothing to call/i);
  assert.match(potOdds(120, 0).explanation, /free/i);
});
