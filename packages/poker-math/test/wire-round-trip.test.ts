/**
 * Everything the Coach publishes has to survive JSON, and this is the test whose absence
 * let that stop being true.
 *
 * ## The defect this exists for
 *
 * `potOdds` reported `Infinity` for `oddsRatio` when the call was free — a deliberate
 * sentinel, argued for at length in `src/odds.ts`, and correct about everything except
 * the one thing that decided it: **JSON has no `Infinity`**. `JSON.stringify(Infinity)`
 * is the string `"null"`. So a member the contract declared as `number` reached the
 * browser as `null` on every check spot, the UI's formatter threw on it, and the error
 * boundary replaced the whole `/play` route.
 *
 * Every unit test in this package passed throughout, because every one of them called
 * the function and read the property in the same process. The wire was never in the
 * test. That is the hole this file closes, and it closes it structurally rather than
 * for `oddsRatio` alone: the assertions below walk the entire report and would fail the
 * same way for the next member that acquires a value JSON cannot carry.
 *
 * ## What "survives with its type intact" means here
 *
 * Three separate claims, because the obvious one is not enough on its own:
 *
 *  1. `JSON.parse(JSON.stringify(x))` deep-equals `x`. Under `node:assert/strict` that
 *     is `deepStrictEqual`, so a member that vanishes (an explicit `undefined`) or
 *     changes type (`Infinity` → `null`, a `Map` → `{}`) fails.
 *  2. Nothing in the tree is a non-finite number. `Infinity` and `NaN` are the values
 *     that make claim 1 fail, and naming them directly is what turns a confusing
 *     structural diff into a sentence.
 *  3. Nothing in the tree is `undefined`. An optional member is meant to be *absent*
 *     under `exactOptionalPropertyTypes`, and an explicit `undefined` is the other way
 *     a field silently disappears in transit.
 *
 * Both a priced spot and a free-call spot are checked. Only the second exercises the
 * case that broke, and it is the case no other test in this package sends over a wire.
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
  // The walk has to have found something, or every assertion above is vacuous. The floor is
  // passed in rather than fixed, because a `PotOdds` has five members and a `CoachReport` has
  // hundreds, and "at least one" would not catch a walker that stopped at the first branch.
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

  // Five members: pot, toCall, breakEvenEquity, oddsRatio, explanation.
  roundTrip(priced, 'potOdds(100, 50)', 5);
  roundTrip(free, 'potOdds(120, 0)', 5);
  roundTrip(laid, 'priceLaidByBet(100, 100)', 5);

  // Named explicitly, because "deep-equals itself" is true of a nonsense value too. The
  // priced spot keeps its number; the free spot keeps a null that is distinguishable from
  // a price of 0, which is the whole point of the representation.
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

    // The member that broke, checked on both sides of the trip rather than trusting the
    // deep comparison to have looked at it.
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
  // Requirement stated the other way round: whatever the representation, none of the
  // *strings* a learner sees may leak it. "Infinity to 1" was shipped; "0 to 1" is the
  // reading the sentinel was chosen to avoid; "null to 1" would be the new way to fail.
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
    // No numeric price may be quoted at all on a spot that has none. The pattern needs a
    // digit, so the free explanation's own `There is no "X to 1" price` is left alone —
    // that sentence is the point, not a violation of it.
    assert.equal(/\d(\.\d+)? to 1\b/.test(text), false, `a free call quoted a numeric price: ${text}`);
  }

  // And it says something rather than nothing: the free case is explained, not omitted.
  assert.match(report.potOdds.explanation, /nothing to call/i);
  assert.match(potOdds(120, 0).explanation, /free/i);
});
