/**
 * Tests for src/stacks.ts.
 *
 * ## Where the expected values come from
 *
 * Every expectation is hand arithmetic shown in a comment, a closed-form identity
 * re-derived in this file rather than copied from the source, or a structural
 * property that holds whatever the implementation is (monotonicity across the sizing
 * ladder, band boundaries, the SPR-4 commitment identity).
 *
 * The ladder's two prices are checked twice over. `src/stacks.ts` gets them from
 * `src/odds.ts` rather than working them out itself, so the ladder is cross-checked
 * against `priceLaidByBet` and `defenceFrequency` to pin that wiring; and both are
 * ALSO checked against `priceByHand` and `mdfByHand` below, re-derived here from the
 * definition of a call. The second check is what makes the first mean anything —
 * agreement between two modules that share a formula only proves they share it.
 *
 * ## The guardrail test
 *
 * `no SPR implication tells the reader what to do` is not a maths test. It is a
 * product guardrail with teeth: SPR describes the shape of a decision and nothing
 * more, and the moment one of those strings starts giving instructions the app is
 * claiming an authority it does not have. Cheaper to catch here than in review.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defenceFrequency, priceLaidByBet } from '../src/odds.ts';
import {
  commitmentThreshold,
  effectiveStack,
  mRatio,
  sizingLadder,
  stackInBigBlinds,
  stackToPotRatio,
} from '../src/stacks.ts';

const TOLERANCE = 1e-9;

function closeTo(actual: number, expected: number, message: string, tolerance = TOLERANCE): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual} (difference ${Math.abs(actual - expected)})`,
  );
}

/**
 * The equity a caller needs against a bet of `b` into a pot of `pot`, derived here
 * from the definition of a call and not from the source.
 *
 * They put in `b` to play for a pot that will hold `pot + b + b`. Break-even is where
 * the average return equals the cost:
 *
 *     e x (pot + 2b) = b
 *     e = b / (pot + 2b)
 */
function priceByHand(pot: number, betSize: number): number {
  return betSize / (pot + 2 * betSize);
}

/**
 * Minimum defence frequency, derived from the bluffer's side.
 *
 * A bluff of `b` into `pot` breaks even when it works `b / (pot + b)` of the time —
 * risk over the eventual total. So the defender has to continue with the complement
 * of that for bluffs not to be free money:
 *
 *     MDF = 1 - b / (pot + b) = pot / (pot + b)
 */
function mdfByHand(pot: number, betSize: number): number {
  return pot / (pot + betSize);
}

// Language that would turn a description of the situation into an instruction about
// how to play it. Checked against every SPR implication string.
const PRESCRIPTIVE_PHRASES = [
  'you should',
  'always',
  'never ',
  'must call',
  'must fold',
  'must bet',
  'correct play',
  'the right play',
  'optimal',
  'best play',
  'you have to call',
  'you have to fold',
];

// ---------------------------------------------------------------------------
// Effective stack
// ---------------------------------------------------------------------------

test('the effective stack is the smaller of yours and the deepest opponent', () => {
  // Hand-worked, one opponent up to five, mixed sizes. The rule is
  // min(hero, max(opponents)), so the deepest opponent sets the ceiling and hero's
  // own stack caps it.
  const cases: { hero: number; opponents: number[]; expected: number; why: string }[] = [
    { hero: 100, opponents: [100], expected: 100, why: 'equal stacks' },
    { hero: 100, opponents: [40], expected: 40, why: 'one short opponent caps it' },
    { hero: 40, opponents: [100], expected: 40, why: 'hero is the short one' },
    { hero: 200, opponents: [80, 150], expected: 150, why: 'the deepest of two opponents' },
    { hero: 120, opponents: [80, 150], expected: 120, why: 'hero caps the deepest opponent' },
    { hero: 500, opponents: [10, 20, 30], expected: 30, why: 'three shallow opponents' },
    { hero: 25, opponents: [10, 20, 30, 40], expected: 25, why: 'four opponents, hero shortest but one' },
    { hero: 900, opponents: [100, 250, 75, 250, 610], expected: 610, why: 'five opponents, duplicate sizes' },
    { hero: 0, opponents: [100], expected: 0, why: 'a hero with nothing risks nothing' },
    { hero: 100, opponents: [0], expected: 0, why: 'an opponent with nothing can pay nothing' },
  ];
  for (const { hero, opponents, expected, why } of cases) {
    const result = effectiveStack(hero, opponents);
    assert.equal(result.effective, expected, `${why} (hero ${hero} vs ${opponents.join('/')})`);
    assert.ok(result.explanation.length > 0, 'the figure carries its reasoning');
  }
});

test('the effective stack explanation names the stack doing the limiting', () => {
  const heroIsShort = effectiveStack(40, [100]);
  assert.ok(heroIsShort.explanation.includes('40'), 'hero cannot lose more than 40');
  assert.ok(heroIsShort.explanation.includes('shorter stack'));

  const opponentIsShort = effectiveStack(200, [80]);
  assert.ok(opponentIsShort.explanation.includes('80'));
  assert.ok(opponentIsShort.explanation.includes('120'), 'the 120 that is not in play must be named');

  // Multiway, one figure is not the whole story and the string has to say so.
  const multiway = effectiveStack(200, [80, 150]);
  assert.ok(multiway.explanation.includes('its own effective stack'), 'the per-opponent caveat');
});

test('the effective stack never exceeds either side, over a wide sweep', () => {
  // The property that makes the figure safe to use: it can never claim more can
  // change hands than one of the two players can actually pay.
  for (const hero of [0, 1, 17, 100, 999]) {
    for (const a of [0, 1, 17, 100, 999]) {
      for (const b of [0, 1, 17, 100, 999]) {
        const { effective } = effectiveStack(hero, [a, b]);
        assert.ok(effective <= hero, `hero ${hero}, opponents ${a}/${b}`);
        assert.ok(effective <= Math.max(a, b), `hero ${hero}, opponents ${a}/${b}`);
        assert.equal(effective, Math.min(hero, Math.max(a, b)));
      }
    }
  }
});

test('an effective stack with nobody to play against is refused', () => {
  assert.throws(() => effectiveStack(100, []), /at least 1 opponent stack/);
  assert.throws(() => effectiveStack(-1, [100]), /heroStack must be 0 or more chips/);
  assert.throws(() => effectiveStack(100, [50, -1]), /opponentStacks\[1\] must be 0 or more chips/);
  assert.throws(() => effectiveStack(100, [Number.NaN]), /must be a finite number/);
  assert.throws(() => effectiveStack(Number.POSITIVE_INFINITY, [100]), /must be a finite number/);
});

// ---------------------------------------------------------------------------
// Stack-to-pot ratio
// ---------------------------------------------------------------------------

test('SPR is the effective stack divided by the pot', () => {
  // 400 / 100 = 4. 150 / 200 = 0.75. 2600 / 200 = 13.
  closeTo(stackToPotRatio(400, 100).spr, 4, 'four pots behind');
  closeTo(stackToPotRatio(150, 200).spr, 0.75, 'less than a pot behind');
  closeTo(stackToPotRatio(2600, 200).spr, 13, 'thirteen pots behind');
  const result = stackToPotRatio(400, 100);
  assert.equal(result.effectiveStack, 400, 'the inputs come back with the figure');
  assert.equal(result.pot, 100);
  assert.ok(result.explanation.includes('400'));
  assert.ok(result.explanation.includes('100'));
});

test('the SPR bands land exactly where they are documented', () => {
  // Documented convention: lower-inclusive, upper-exclusive, with the top band
  // opening strictly above 13. Every edge is pinned from both sides, using a pot of
  // 100 so the effective stack IS the SPR x 100 and the arithmetic is obvious.
  const edges: { stack: number; band: string; why: string }[] = [
    { stack: 0, band: 'very-low', why: 'nothing behind' },
    { stack: 99.9, band: 'very-low', why: 'just under 1' },
    { stack: 100, band: 'low', why: 'exactly 1 is the bottom of low' },
    { stack: 299.9, band: 'low', why: 'just under 3' },
    { stack: 300, band: 'medium', why: 'exactly 3 is the bottom of medium' },
    { stack: 599.9, band: 'medium', why: 'just under 6' },
    { stack: 600, band: 'high', why: 'exactly 6 is the bottom of high' },
    { stack: 1300, band: 'high', why: 'exactly 13 is still high — the top band opens ABOVE 13' },
    { stack: 1300.1, band: 'very-high', why: 'just over 13' },
    { stack: 100_000, band: 'very-high', why: 'absurdly deep' },
  ];
  for (const { stack, band, why } of edges) {
    assert.equal(stackToPotRatio(stack, 100).band, band, `SPR ${stack / 100}: ${why}`);
  }
});

test('every SPR lands in exactly one band, and the bands only ever climb', () => {
  // A sweep across the whole range: the band must be a non-decreasing function of
  // the ratio, and every ratio must get one. A gap or an overlap in the chain of
  // comparisons would show up as a band going backwards or as an undefined band.
  const order = ['very-low', 'low', 'medium', 'high', 'very-high'];
  let lowestSeen = 0;
  for (let stack = 0; stack <= 3000; stack += 7) {
    const { band } = stackToPotRatio(stack, 100);
    const index = order.indexOf(band);
    assert.ok(index >= 0, `stack ${stack} produced an unknown band "${band}"`);
    assert.ok(index >= lowestSeen, `stack ${stack}: band went backwards to ${band}`);
    lowestSeen = index;
  }
  assert.equal(lowestSeen, order.length - 1, 'the sweep reaches the top band');
});

test('an SPR against an empty pot throws instead of dividing by zero', () => {
  // Without this the function returns Infinity for a stack over nothing, and a UI
  // renders "Infinity pots behind" as though it were a measurement.
  assert.throws(() => stackToPotRatio(100, 0), /pot must be more than 0 chips/);
  assert.throws(() => stackToPotRatio(100, -50), /pot must be more than 0 chips/);
  assert.throws(() => stackToPotRatio(-1, 100), /effectiveStack must be 0 or more chips/);
  assert.throws(() => stackToPotRatio(Number.NaN, 100), /must be a finite number/);
  assert.throws(() => stackToPotRatio(100, Number.POSITIVE_INFINITY), /must be a finite number/);
});

test('no SPR implication tells the reader what to do', () => {
  // The product guardrail. Each implication must describe the situation — when the
  // commitment decision arrives, what room is left — without naming an action or
  // claiming a universally right answer.
  for (let stack = 0; stack <= 4000; stack += 13) {
    const { band, implication } = stackToPotRatio(stack, 100);
    assert.ok(implication.length > 40, `band ${band}: an implication this short says nothing concrete`);
    const lower = implication.toLowerCase();
    for (const phrase of PRESCRIPTIVE_PHRASES) {
      assert.ok(!lower.includes(phrase), `band ${band} prescribes: "${phrase}" in "${implication}"`);
    }
    assert.ok(
      lower.includes('spr describes the shape of the decision'),
      `band ${band}: the "this is not the answer" caveat must travel with every band`,
    );
  }
});

test('each SPR band says something different and concrete about the depth', () => {
  // Five bands, five distinct strings. Identical text across bands would mean the
  // band is decorative.
  const texts = new Set<string>();
  for (const stack of [50, 200, 400, 900, 5000]) {
    const result = stackToPotRatio(stack, 100);
    texts.add(result.implication);
  }
  assert.equal(texts.size, 5, 'each band has its own implication');
});

// ---------------------------------------------------------------------------
// Sizing ladder
// ---------------------------------------------------------------------------

test('a pot-sized bet lays the caller exactly one third and demands exactly half', () => {
  // The two anchor identities. Bet b = pot: the caller pays b to play for pot + 2b =
  // 3b, so they need b/3b = 1/3. And MDF = pot / (pot + pot) = 1/2.
  const ladder = sizingLadder(100, 1000);
  const potSized = ladder.find((option) => option.label === 'pot');
  assert.ok(potSized !== undefined, 'a pot-sized bet is on the ladder');
  assert.equal(potSized.amount, 100);
  closeTo(potSized.priceLaidToCaller, 1 / 3, 'a pot-sized bet lays 1/3');
  closeTo(potSized.minimumDefenceFrequency, 0.5, 'and demands half the range');

  // Hand-worked second anchor: half pot. b = 50 into 100 gives 50/200 = 1/4, and
  // MDF = 100/150 = 2/3.
  const halfPot = ladder.find((option) => option.label === 'half pot');
  assert.ok(halfPot !== undefined);
  closeTo(halfPot.priceLaidToCaller, 0.25, 'a half-pot bet lays 1/4');
  closeTo(halfPot.minimumDefenceFrequency, 2 / 3, 'and demands two thirds');
});

test("every rung's price and defence frequency agree with odds.ts and with hand arithmetic", () => {
  // The cross-check the brief asks for, run against both odds.ts (which is where
  // stacks.ts gets these figures, so this pins the wiring) and the derivations at the
  // top of this file (which is what makes the agreement evidence rather than
  // tautology). Also pins the two prices to each other: MDF is the complement of the
  // break-even bluff frequency, so MDF + alpha must be exactly 1.
  let rungs = 0;
  for (const pot of [1, 7, 40, 100, 333, 5000]) {
    for (const maxBet of [1, 9, 50, 100, 400, 10_000]) {
      for (const option of sizingLadder(pot, maxBet)) {
        closeTo(option.priceLaidToCaller, priceByHand(pot, option.amount), `${option.label}: price`);
        closeTo(option.minimumDefenceFrequency, mdfByHand(pot, option.amount), `${option.label}: MDF`);
        closeTo(
          option.priceLaidToCaller,
          priceLaidByBet(pot, option.amount).breakEvenEquity,
          `${option.label}: price vs odds.ts`,
        );
        const fromOdds = defenceFrequency(pot, option.amount);
        closeTo(
          option.minimumDefenceFrequency,
          fromOdds.minimumDefenceFrequency,
          `${option.label}: MDF vs odds.ts`,
        );
        const alpha = option.amount / (pot + option.amount);
        closeTo(fromOdds.alpha, alpha, `${option.label}: alpha vs the hand derivation`);
        closeTo(option.minimumDefenceFrequency + alpha, 1, `${option.label}: MDF is 1 - alpha`);
        // Whole chips only: the engine rejects a fractional bet, so a rung that is not
        // an integer is not an action anybody could submit.
        assert.ok(Number.isInteger(option.amount), `${option.label}: ${option.amount} is not whole chips`);
        // A caller can never need more than half the pot's worth of equity: even an
        // enormous bet approaches 1/2 from below, because their own call inflates
        // the pot they are buying into.
        assert.ok(
          option.priceLaidToCaller > 0 && option.priceLaidToCaller < 0.5,
          `${option.label}: price range`,
        );
        assert.ok(option.minimumDefenceFrequency > 0 && option.minimumDefenceFrequency <= 1);
        // The stated fraction and the stated amount must describe the same bet.
        closeTo(option.fractionOfPot * pot, option.amount, `${option.label}: fraction matches amount`);
        assert.ok(option.note.length > 0, 'every rung carries its reasoning');
        rungs += 1;
      }
    }
  }
  assert.ok(rungs > 100, `expected a broad sweep of rungs, checked ${rungs}`);
});

test('the ladder holds the sizes it should, skips what the stack cannot pay, and always offers the all-in', () => {
  // Deep: all seven fractions of a 100 pot fit under a 1000 cap, then the all-in.
  // Rounded down to whole chips: 25, 33, 50, 66, 75, 100, 150.
  const deep = sizingLadder(100, 1000);
  assert.deepEqual(
    deep.map((option) => option.label),
    [
      'one quarter pot',
      'one third pot',
      'half pot',
      'two thirds pot',
      'three quarters pot',
      'pot',
      'one and a half times pot',
      'all-in',
    ],
  );
  assert.deepEqual(
    deep.map((option) => option.amount),
    [25, 33, 50, 66, 75, 100, 150, 1000],
    'floor(100/3) is 33 and floor(200/3) is 66 — whole chips, rounded down',
  );
  assert.equal(deep[7]?.amount, 1000, 'the all-in is the cap itself');
  closeTo(deep[7]?.fractionOfPot ?? Number.NaN, 10, 'a 1000 all-in into 100 is ten times pot');

  // Capped at 40: half pot (50) and everything above it is unavailable.
  const capped = sizingLadder(100, 40);
  assert.deepEqual(
    capped.map((option) => option.label),
    ['one quarter pot', 'one third pot', 'all-in'],
  );
  assert.deepEqual(
    capped.map((option) => option.amount),
    [25, 33, 40],
  );

  // Capped below every fraction: the all-in is the only size, which is itself the
  // useful message — there is no sizing decision left.
  const shove = sizingLadder(100, 10);
  assert.equal(shove.length, 1);
  assert.equal(shove[0]?.label, 'all-in');
  assert.equal(shove[0]?.amount, 10);

  // No rung ever exceeds the cap.
  for (const pot of [3, 100, 777]) {
    for (const maxBet of [1, 4, 60, 250, 9000]) {
      for (const option of sizingLadder(pot, maxBet)) {
        assert.ok(option.amount <= maxBet, `pot ${pot}, cap ${maxBet}: ${option.label} exceeds the stack`);
        assert.ok(option.amount > 0, 'a rung of nothing is not a bet');
      }
    }
  }
});

test('an all-in that lands on a fraction is listed once, with a note that it is all-in', () => {
  // Exactly one pot behind: the pot-sized rung and the all-in are the same bet, so
  // the ladder must not offer it twice. The learner still needs to know the size is
  // a shove, so it goes in the note.
  const ladder = sizingLadder(100, 100);
  assert.deepEqual(
    ladder.map((option) => option.label),
    ['one quarter pot', 'one third pot', 'half pot', 'two thirds pot', 'three quarters pot', 'pot'],
  );
  const last = ladder[ladder.length - 1];
  assert.equal(last?.amount, 100);
  assert.ok(last?.note.includes('also an all-in'), 'the coincidence has to be stated somewhere');

  // Amounts are distinct throughout, at every cap that could collide with a rung and
  // in the small pots where two fractions round onto the same whole number.
  for (const maxBet of [25, 33, 50, 66, 75, 100, 150, 1000]) {
    const amounts = sizingLadder(100, maxBet).map((option) => option.amount);
    assert.equal(new Set(amounts).size, amounts.length, `cap ${maxBet} produced a duplicated size`);
  }
  for (let pot = 1; pot <= 60; pot++) {
    for (const maxBet of [1, 2, 5, 13, 40, 1000]) {
      const amounts = sizingLadder(pot, maxBet).map((option) => option.amount);
      assert.equal(new Set(amounts).size, amounts.length, `pot ${pot}, cap ${maxBet}: duplicated size`);
      assert.ok(amounts.length > 0, `pot ${pot}, cap ${maxBet}: a ladder is never empty`);
    }
  }
});

test('a pot too small to split still offers the sizes that exist', () => {
  // A 3-chip pot, walked through by hand: a quarter is floor(0.75) = 0 and is not a
  // bet; a third is floor(1) = 1; a half is floor(1.5) = 1, the same bet again, so it
  // is dropped; two thirds is floor(2) = 2; three quarters is floor(2.25) = 2, dropped
  // as a duplicate; the pot is 3; and one and a half pots is floor(4.5) = 4. Nothing
  // here is a fractional chip and nothing is a bet of nothing.
  const tiny = sizingLadder(3, 100);
  assert.deepEqual(
    tiny.map((option) => [option.label, option.amount]),
    [
      ['one third pot', 1],
      ['two thirds pot', 2],
      ['pot', 3],
      ['one and a half times pot', 4],
      ['all-in', 100],
    ],
  );

  // A 1-chip pot has exactly one fraction that survives rounding.
  const single = sizingLadder(1, 50);
  assert.deepEqual(
    single.map((option) => [option.label, option.amount]),
    [
      ['pot', 1],
      ['all-in', 50],
    ],
  );
});

test('a bigger bet lays the caller a better price and demands less defence', () => {
  // Monotonicity across the ladder, which is the relationship the whole table exists
  // to show: b/(pot + 2b) climbs with b, pot/(pot + b) falls with it.
  for (const pot of [10, 100, 2500]) {
    const ladder = sizingLadder(pot, pot * 20);
    let previousAmount = 0;
    let previousPrice = 0;
    let previousMdf = Number.POSITIVE_INFINITY;
    for (const option of ladder) {
      assert.ok(option.amount > previousAmount, `${option.label}: the ladder must climb`);
      assert.ok(option.priceLaidToCaller > previousPrice, `${option.label}: price must climb with size`);
      assert.ok(option.minimumDefenceFrequency < previousMdf, `${option.label}: MDF must fall with size`);
      previousAmount = option.amount;
      previousPrice = option.priceLaidToCaller;
      previousMdf = option.minimumDefenceFrequency;
    }
  }
});

test('a sizing ladder needs a real pot and a real stack', () => {
  assert.throws(() => sizingLadder(0, 100), /pot must be more than 0 chips/);
  assert.throws(() => sizingLadder(-100, 100), /pot must be more than 0 chips/);
  assert.throws(() => sizingLadder(100, 0), /maxBet must be more than 0 chips/);
  assert.throws(() => sizingLadder(100, -1), /maxBet must be more than 0 chips/);
  assert.throws(() => sizingLadder(Number.NaN, 100), /must be a finite number/);
  assert.throws(() => sizingLadder(100, Number.POSITIVE_INFINITY), /must be a finite number/);
});

// ---------------------------------------------------------------------------
// Commitment
// ---------------------------------------------------------------------------

test('after a pot-sized bet is called, the pot has trebled and the rest is behind', () => {
  // Hand-worked. Bet the pot and get called: pot becomes 3 x pot, behind becomes
  // stack - pot, so SPR after = (stack - pot) / (3 x pot).
  //   stack 400, pot 100 -> 300 / 300 = 1
  //   stack 700, pot 100 -> 600 / 300 = 2
  //   stack 250, pot 100 -> 150 / 300 = 0.5
  //   stack 1000, pot 50 -> 950 / 150 = 6.333...
  closeTo(commitmentThreshold({ effectiveStack: 400, pot: 100 }).sprAfterPotSizedBet, 1, 'SPR 4');
  closeTo(commitmentThreshold({ effectiveStack: 700, pot: 100 }).sprAfterPotSizedBet, 2, 'SPR 7');
  closeTo(commitmentThreshold({ effectiveStack: 250, pot: 100 }).sprAfterPotSizedBet, 0.5, 'SPR 2.5');
  closeTo(commitmentThreshold({ effectiveStack: 1000, pot: 50 }).sprAfterPotSizedBet, 19 / 3, 'SPR 20');
});

test('an SPR of 4 is exactly the depth where two called pot-sized bets commit the stack', () => {
  // The identity, at any pot: starting at SPR 4 the stack is 4 x pot, so after one
  // pot-sized bet and call it is (4p - p) / 3p = 1 — and an SPR of 1 is precisely
  // the depth at which the next pot-sized bet IS the whole stack. That is where the
  // "SPR 4 is a commitment threshold" idea comes from, and it is arithmetic rather
  // than received wisdom.
  for (const pot of [1, 5, 40, 100, 999, 12_345]) {
    const first = commitmentThreshold({ effectiveStack: 4 * pot, pot });
    closeTo(first.sprAfterPotSizedBet, 1, `pot ${pot}: SPR 4 leaves exactly SPR 1`);

    // And the next street confirms it: with SPR 1 the pot-sized bet is the stack.
    const behind = 4 * pot - pot;
    const potAfter = 3 * pot;
    closeTo(behind, potAfter, `pot ${pot}: at SPR 1 the pot-sized bet is the whole stack`);
    const second = commitmentThreshold({ effectiveStack: behind, pot: potAfter });
    assert.equal(second.sprAfterPotSizedBet, 0, 'so there is nothing behind after it');
    assert.ok(second.note.includes('betting everything'));
  }
});

test('when a pot-sized bet is more than the stack, nothing is behind and the note says why', () => {
  // Not a silent clamp: a negative SPR would be nonsense, so the figure is 0 and the
  // reason travels with it.
  const short = commitmentThreshold({ effectiveStack: 80, pot: 100 });
  assert.equal(short.sprAfterPotSizedBet, 0);
  assert.ok(short.note.includes('80'), 'the stack that could not cover the bet is named');
  assert.ok(short.note.includes('100'), 'and the bet it could not cover');
  assert.ok(short.note.includes('betting everything'));

  // The boundary: stack exactly equal to the pot is still an all-in, not an SPR of 0
  // that happens to be arrived at by division.
  const exact = commitmentThreshold({ effectiveStack: 100, pot: 100 });
  assert.equal(exact.sprAfterPotSizedBet, 0);
  assert.ok(exact.note.includes('betting everything'));

  // Just above it is a real ratio again: (100.01 - 100) / 300.
  const justOver = commitmentThreshold({ effectiveStack: 100.01, pot: 100 });
  closeTo(justOver.sprAfterPotSizedBet, 0.01 / 300, 'a sliver behind');
});

test('the commitment figure never goes negative and always states its assumptions', () => {
  for (const stack of [0, 1, 50, 100, 400, 10_000]) {
    for (const pot of [1, 7, 100, 5000]) {
      const result = commitmentThreshold({ effectiveStack: stack, pot });
      assert.ok(result.sprAfterPotSizedBet >= 0, `stack ${stack}, pot ${pot}: negative SPR`);
      assert.ok(Number.isFinite(result.sprAfterPotSizedBet), `stack ${stack}, pot ${pot}: non-finite SPR`);
      assert.ok(result.note.length > 0);
      assert.ok(result.assumptions.length >= 3, 'one bet, one call, and no raise are all assumptions');
      assert.ok(
        result.assumptions.some((note) => note.includes('raise')),
        'the missing raise is the assumption most likely to bite',
      );
    }
  }
  assert.throws(() => commitmentThreshold({ effectiveStack: 100, pot: 0 }), /pot must be more than 0 chips/);
  assert.throws(() => commitmentThreshold({ effectiveStack: -1, pot: 100 }), /0 or more chips/);
  assert.throws(() => commitmentThreshold({ effectiveStack: 100, pot: Number.NaN }), /finite number/);
});

// ---------------------------------------------------------------------------
// Big blinds
// ---------------------------------------------------------------------------

test('stack depth in big blinds is the stack over the big blind', () => {
  // 2000 / 50 = 40. 1500 / 100 = 15. 75 / 50 = 1.5.
  closeTo(stackInBigBlinds(2000, 50).bb, 40, '40 big blinds');
  closeTo(stackInBigBlinds(1500, 100).bb, 15, '15 big blinds');
  closeTo(stackInBigBlinds(75, 50).bb, 1.5, 'a stack and a half');
  closeTo(stackInBigBlinds(0, 50).bb, 0, 'no chips is no big blinds');
  assert.ok(stackInBigBlinds(2000, 50).note.includes('40'));

  // The same chips get shallower as the blinds climb — the reason the unit exists.
  let previous = Number.POSITIVE_INFINITY;
  for (const bigBlind of [20, 50, 100, 400]) {
    const { bb } = stackInBigBlinds(2000, bigBlind);
    assert.ok(bb < previous, `big blind ${bigBlind}: depth did not fall`);
    previous = bb;
  }
});

test('a big blind of nothing is refused rather than dividing by zero', () => {
  assert.throws(() => stackInBigBlinds(2000, 0), /bigBlind must be more than 0 chips/);
  assert.throws(() => stackInBigBlinds(2000, -50), /bigBlind must be more than 0 chips/);
  assert.throws(() => stackInBigBlinds(-1, 50), /stack must be 0 or more chips/);
  assert.throws(() => stackInBigBlinds(Number.NaN, 50), /finite number/);
});

// ---------------------------------------------------------------------------
// M-ratio
// ---------------------------------------------------------------------------

test('M is the stack over one orbit of forced bets', () => {
  // Hand-worked, no ante: one orbit costs 25 + 50 = 75, so 3000 / 75 = 40.
  closeTo(mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50 }).m, 40, 'no ante');
  // Traditional ante, nine-handed: 25 + 50 + 9 x 5 = 120, so 3000 / 120 = 25.
  closeTo(
    mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50, ante: 5, playersAtTable: 9 }).m,
    25,
    'nine antes',
  );
  // Big-blind ante entered as a single total: 25 + 50 + 50 = 125, so 3000 / 125 = 24.
  closeTo(
    mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50, ante: 50, playersAtTable: 1 }).m,
    24,
    'bb ante',
  );
  // An explicit zero ante is the same as none: 1000 / (10 + 20) = 33.33...
  closeTo(mRatio({ stack: 1000, smallBlind: 10, bigBlind: 20, ante: 0 }).m, 100 / 3, 'zero ante');
  // A short stack: 600 / (100 + 200) = 2 orbits left.
  closeTo(mRatio({ stack: 600, smallBlind: 100, bigBlind: 200 }).m, 2, 'two orbits from nothing');
});

test('M explains the arithmetic and which ante convention it used', () => {
  const plain = mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50 });
  assert.ok(plain.explanation.includes('no ante'), 'the absent ante is stated, not left implied');
  assert.ok(plain.explanation.includes('40'));
  assert.ok(plain.explanation.includes('orbit'), 'M is a count of orbits and should say so');

  const traditional = mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50, ante: 5, playersAtTable: 9 });
  assert.ok(traditional.explanation.includes('45'), 'the antes per orbit are shown, not just the total');
  assert.ok(traditional.explanation.includes('9 players'));

  const bigBlindAnte = mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50, ante: 50, playersAtTable: 1 });
  assert.ok(bigBlindAnte.explanation.includes('big-blind ante'), 'the convention in force is named');
});

test('an ante with no player count is refused instead of guessed', () => {
  // The two conventions differ by a factor of the table size. Picking one silently
  // would move every M in the app by up to 9x, so this is a hard error with the
  // reason in the message.
  assert.throws(
    () => mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50, ante: 5 }),
    /an ante of 5 was given without playersAtTable/,
  );
  assert.throws(
    () => mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50, ante: 5 }),
    /big-blind ante by one player for the table/,
  );
  // And the difference it would have made, so the refusal is obviously worth it:
  // 3000 / (75 + 5) = 37.5 one way, 3000 / (75 + 45) = 25 the other.
  closeTo(
    mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50, ante: 5, playersAtTable: 1 }).m,
    37.5,
    'one poster',
  );
  closeTo(
    mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50, ante: 5, playersAtTable: 9 }).m,
    25,
    'nine posters',
  );
});

test('M falls as the blinds rise even though the stack has not moved', () => {
  // The whole point of the measure: the same chips buy less time at every level.
  let previous = Number.POSITIVE_INFINITY;
  for (const [smallBlind, bigBlind] of [
    [25, 50],
    [50, 100],
    [100, 200],
    [200, 400],
    [400, 800],
  ] as const) {
    const { m } = mRatio({ stack: 3000, smallBlind, bigBlind });
    assert.ok(m < previous, `level ${smallBlind}/${bigBlind}: M did not fall`);
    previous = m;
  }
  // And it falls when an ante is added at the same level: 3000/75 = 40 down to 25.
  const withoutAnte = mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50 }).m;
  const withAnte = mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50, ante: 5, playersAtTable: 9 }).m;
  assert.ok(withAnte < withoutAnte, 'antes cost time too');
});

test('M rejects inputs that would make it meaningless', () => {
  assert.throws(
    () => mRatio({ stack: 3000, smallBlind: 25, bigBlind: 0 }),
    /bigBlind must be more than 0 chips/,
  );
  assert.throws(
    () => mRatio({ stack: 3000, smallBlind: -1, bigBlind: 50 }),
    /smallBlind must be 0 or more chips/,
  );
  assert.throws(() => mRatio({ stack: -1, smallBlind: 25, bigBlind: 50 }), /stack must be 0 or more chips/);
  assert.throws(
    () => mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50, ante: -5, playersAtTable: 9 }),
    /ante must be 0 or more chips/,
  );
  assert.throws(
    () => mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50, ante: 5, playersAtTable: 0 }),
    /playersAtTable must be a whole number of 1 or more/,
  );
  assert.throws(
    () => mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50, ante: 5, playersAtTable: 2.5 }),
    /playersAtTable must be a whole number of 1 or more/,
  );
  assert.throws(
    () => mRatio({ stack: 3000, smallBlind: 25, bigBlind: 50, ante: 5, playersAtTable: -9 }),
    /playersAtTable must be a whole number of 1 or more/,
  );
  assert.throws(() => mRatio({ stack: Number.NaN, smallBlind: 25, bigBlind: 50 }), /finite number/);
  assert.throws(
    () =>
      mRatio({
        stack: 3000,
        smallBlind: 25,
        bigBlind: 50,
        ante: Number.POSITIVE_INFINITY,
        playersAtTable: 9,
      }),
    /finite number/,
  );
  // A zero stack is legal and gives M = 0: there is no orbit left, which is a real
  // thing to be able to say.
  assert.equal(mRatio({ stack: 0, smallBlind: 25, bigBlind: 50 }).m, 0);
});

test('an all-in opponent does not make the Coach say nothing can change hands (REGRESSION)', () => {
  // With every opponent all in, `deepest` is 0 and the general sentence rendered "at most 0 can
  // change hands even though you have 260. The 260 above that is not in play this hand — nobody
  // can pay you for it and nobody can take it." The Coach printed that while pricing a call of 170
  // out of that same 260, and on one Lab scenario where the call was hero's whole stack. What is
  // finished is the betting, not the movement of chips, and those are different claims.
  const { effective, explanation } = effectiveStack(260, [0]);

  // The NUMBER is still zero and deliberately so: there is no future street to size against, and
  // SPR is computed from it. Only the sentence was wrong.
  assert.equal(effective, 0);

  assert.ok(
    !/can change hands/u.test(explanation),
    `the all-in case still claims chips cannot change hands: "${explanation}"`,
  );
  assert.ok(
    !/not in play this hand/u.test(explanation),
    `the all-in case still calls hero's callable chips out of play: "${explanation}"`,
  );
  assert.match(explanation, /no more betting/u);

  // And the ordinary shallow-opponent case must keep its sentence, so the branch above has not
  // swallowed the one it sits in front of.
  const shallow = effectiveStack(260, [90]);
  assert.equal(shallow.effective, 90);
  assert.match(shallow.explanation, /at most .* can change hands/u);
});
