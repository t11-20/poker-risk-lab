/**
 * Tests for tournament equity: Malmuth–Harville ICM, the chip-EV comparison, and
 * push/fold chip EV.
 *
 * ## Where the expected values come from
 *
 * Every figure below is derived outside this package, and each test says how:
 *
 *   - symmetry (equal stacks must share the prize pool equally),
 *   - arithmetic worked out by hand from the definition of the model, written into
 *     the comment as fractions so the next reader can redo it,
 *   - probability identities (place probabilities sum to one, so equities sum to the
 *     prize pool),
 *   - structural inequalities that follow from concavity, not from this code,
 *   - and for push/fold, a matchup whose equity is exactly one half by suit symmetry,
 *     which pins the whole EV expression to an exact fraction.
 *
 * ## Floating point
 *
 * `icmEquity` accumulates over subsets of players, so identities that are exact in
 * arithmetic are exact to about 1e-14 in doubles. Where a value happens to be
 * representable — the two-player 3:1 case, winner-take-all — the tests assert exact
 * equality. Where it is not, they assert a tolerance and say what the closed-form
 * answer is. Measured worst case across the random fuzz below: 5e-16 relative.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CardParseError, parseCards } from '@prl/poker-engine';
import { IcmError, icmEquity, icmVsChipEv, MAX_ICM_PLAYERS, pushFoldChipEv } from '../src/icm.ts';
import { RangeParseError } from '../src/ranges.ts';

/** Deterministic xorshift, so a fuzz failure is reproducible. No Math.random. */
function makeRandom(seed: number): (bound: number) => number {
  let state = seed | 0;
  return (bound: number): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return Math.abs(state) % bound;
  };
}

function total(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: got ${actual}, expected ${expected} (tolerance ${tolerance})`,
  );
}

// ---------------------------------------------------------------------------
// icmEquity
// ---------------------------------------------------------------------------

test('equal stacks share the prize pool equally, whatever the payout structure', () => {
  // Ground truth is symmetry, not arithmetic: if every stack is identical then no
  // player is distinguishable from any other, so each must hold exactly 1/n of the
  // pool for ANY ladder. Checked for 2 to 9 players and for three unrelated ladders.
  //
  // Asserted to 1e-9 rather than bit-exactly. The closed-form answer is exactly
  // prizePool/n; the implementation sums hundreds of separately rounded subset terms
  // to get there, and the measured error tops out near 3e-14 at nine players. Claiming
  // bit-equality would be asserting something about double rounding, not about ICM.
  for (let players = 2; players <= MAX_ICM_PLAYERS; players++) {
    const stacks = new Array<number>(players).fill(1500);
    for (const ladder of [[100], [60, 40], [50, 30, 20, 15, 10, 5, 4, 3, 2]]) {
      const payouts = ladder.slice(0, players);
      const result = icmEquity(stacks, payouts);
      const expected = total(payouts) / players;
      for (const [index, value] of result.equities.entries()) {
        assertClose(value, expected, 1e-9, `player ${index} of ${players}, ladder ${payouts.join('/')}`);
      }
    }
  }
});

test('two players at 3:1 with a 70/30 ladder are worth exactly 60 and 40', () => {
  // Hand arithmetic. Stacks 300 and 100, total 400.
  //   P(A first)  = 300/400 = 0.75, so P(A second) = 0.25
  //   P(B first)  = 100/400 = 0.25, so P(B second) = 0.75
  //   equity A = 0.75 x 70 + 0.25 x 30 = 52.5 + 7.5 = 60
  //   equity B = 0.25 x 70 + 0.75 x 30 = 17.5 + 22.5 = 40
  // Every value here is a dyadic fraction, so this one is asserted exactly.
  const result = icmEquity([300, 100], [70, 30]);
  assert.equal(result.equities[0], 60);
  assert.equal(result.equities[1], 40);
  assert.equal(result.totalPrizePool, 100);
  assert.equal(result.method, 'malmuth-harville');
  // The chip leader holds 75% of the chips but only 60% of the prize pool: the gap is
  // the whole lesson, so it is asserted rather than left implied.
  assert.ok((result.equities[0] ?? 0) / result.totalPrizePool < 0.75);
});

test('three players, worked out by hand from the definition', () => {
  // Stacks A 500, B 300, C 200; total 1000; ladder 50/30/20.
  //
  //   P(A 1st) = 1/2
  //   P(A 2nd) = P(B 1st) x A/(T-B) + P(C 1st) x A/(T-C)
  //            = 3/10 x 500/700 + 2/10 x 500/800
  //            = 3/14 + 1/8 = 12/56 + 7/56 = 19/56
  //   P(A 3rd) = 1 - 1/2 - 19/56 = (56 - 28 - 19)/56 = 9/56
  //   equity A = 50/2 + 30 x 19/56 + 20 x 9/56 = 25 + 570/56 + 180/56 = 25 + 750/56
  //
  //   P(B 1st) = 3/10
  //   P(B 2nd) = 1/2 x 300/500 + 2/10 x 300/800 = 3/10 + 3/40 = 15/40 = 3/8
  //   P(B 3rd) = 1 - 3/10 - 3/8 = (40 - 12 - 15)/40 = 13/40
  //   equity B = 3/10 x 50 + 3/8 x 30 + 13/40 x 20 = 15 + 11.25 + 6.5 = 32.75
  //
  //   P(C 1st) = 2/10
  //   P(C 2nd) = 1/2 x 200/500 + 3/10 x 200/700 = 1/5 + 3/35 = 7/35 + 3/35 = 10/35 = 2/7
  //   P(C 3rd) = 1 - 1/5 - 2/7 = (35 - 7 - 10)/35 = 18/35
  //   equity C = 10 + 60/7 + 360/35
  //
  // Sum: 38.392857... + 32.75 + 28.857142... = 100, the whole pool.
  const result = icmEquity([500, 300, 200], [50, 30, 20]);
  assertClose(result.equities[0] ?? 0, 25 + 750 / 56, 1e-12, 'player A');
  assert.equal(result.equities[1], 32.75, 'player B is dyadic, so exact');
  assertClose(result.equities[2] ?? 0, 10 + 60 / 7 + 360 / 35, 1e-12, 'player C');
  assertClose(total([...result.equities]), 100, 1e-12, 'the pool');
});

test('a winner-take-all ladder reduces ICM equity to chip share times the prize', () => {
  // Ground truth: with one paid place, ICM collapses to its first-place rule, which
  // IS chip share. 500/1000 x 1000 = 500, and so on — exact in binary here.
  const result = icmEquity([500, 300, 200], [1000]);
  assert.equal(result.equities[0], 500);
  assert.equal(result.equities[1], 300);
  assert.equal(result.equities[2], 200);

  // Also with awkward numbers, where the values are no longer representable.
  const awkward = icmEquity([777, 333, 111, 1], [90]);
  const chips = 777 + 333 + 111 + 1;
  for (const [index, stack] of [777, 333, 111, 1].entries()) {
    assertClose(awkward.equities[index] ?? 0, (stack / chips) * 90, 1e-12, `player ${index}`);
  }
});

test('equities always sum to the prize pool, over 3000 random tables', () => {
  // Probability identity, independent of the model's details: for each paid place the
  // finish probabilities across players sum to 1, so summing equities recovers exactly
  // the sum of the prizes. If a recursion term were dropped or double-counted this is
  // the check that notices.
  const nextInt = makeRandom(0x2f6e2b1);
  let worstRelativeError = 0;
  let checked = 0;
  for (let iteration = 0; iteration < 3000; iteration++) {
    const players = 2 + nextInt(MAX_ICM_PLAYERS - 1);
    const stacks = Array.from({ length: players }, () => 1 + nextInt(100_000));
    const paidPlaces = 1 + nextInt(players);
    const payouts = Array.from({ length: paidPlaces }, () => nextInt(1000));
    const result = icmEquity(stacks, payouts);
    const pool = total(payouts);
    const summed = total([...result.equities]);
    const relative = pool === 0 ? Math.abs(summed) : Math.abs(summed - pool) / pool;
    worstRelativeError = Math.max(worstRelativeError, relative);
    assert.ok(
      relative < 1e-12,
      `iteration ${iteration}: stacks ${stacks.join('/')} ladder ${payouts.join('/')} summed to ` +
        `${summed} instead of ${pool}`,
    );
    for (const value of result.equities) assert.ok(value >= 0, 'no negative equity');
    assert.equal(result.totalPrizePool, pool);
    checked += 1;
  }
  assert.equal(checked, 3000);
  assert.ok(worstRelativeError < 1e-12, `worst relative error was ${worstRelativeError.toExponential(2)}`);
});

test('more chips never means less equity', () => {
  // Two independent readings of monotonicity, both structural:
  //   (a) inside one table, a player with more chips cannot have less equity than a
  //       player with fewer — anything else would let a learner improve their equity
  //       by giving chips away;
  //   (b) moving chips from one player to another cannot reduce the receiver's equity.
  const nextInt = makeRandom(0x51f3c7d);
  let compared = 0;
  for (let iteration = 0; iteration < 1500; iteration++) {
    const players = 2 + nextInt(MAX_ICM_PLAYERS - 1);
    const stacks = Array.from({ length: players }, () => 1 + nextInt(50_000));
    const paidPlaces = 1 + nextInt(players);
    const payouts = Array.from({ length: paidPlaces }, (_unused, place) => 1000 - place * 100);
    const result = icmEquity(stacks, payouts);

    for (let a = 0; a < players; a++) {
      for (let b = 0; b < players; b++) {
        const stackA = stacks[a] ?? 0;
        const stackB = stacks[b] ?? 0;
        if (stackA <= stackB) continue;
        assert.ok(
          (result.equities[a] ?? 0) >= (result.equities[b] ?? 0) - 1e-9,
          `iteration ${iteration}: ${stackA} chips is worth less than ${stackB} chips`,
        );
        compared += 1;
      }
    }

    const receiver = nextInt(players);
    let donor = nextInt(players);
    if (donor === receiver) donor = (donor + 1) % players;
    const moved = [...stacks];
    const amount = 1 + nextInt(moved[donor] ?? 1);
    moved[receiver] = (moved[receiver] ?? 0) + amount;
    moved[donor] = (moved[donor] ?? 0) - amount;
    const after = icmEquity(moved, payouts);
    assert.ok(
      (after.equities[receiver] ?? 0) >= (result.equities[receiver] ?? 0) - 1e-9,
      `iteration ${iteration}: winning ${amount} chips reduced player ${receiver}'s equity`,
    );
  }
  assert.ok(compared > 1000, `only ${compared} stack pairs were comparable`);
});

test('doubling a short stack gains less than busting it loses', () => {
  // The lesson, made concrete on the bubble: four players, three paid, 50/30/20 and
  // nothing for fourth. Stacks 3000/3000/3000/1000, so 10,000 chips in play and hero
  // is the 1,000.
  //
  // Hand-derived from the definition (T = 10000, hero H = 1000, three big stacks of
  // 3000):
  //   P(H 1st) = 1000/10000 = 1/10
  //   P(H 2nd) = 3 x (3000/10000) x (1000/7000) = 3 x 3/10 x 1/7 = 9/70
  //   P(H 3rd) = [6 ordered pairs of big stacks: (3000/10000) x (3000/7000) each]
  //              x 1000/4000 = 6 x (3/10 x 3/7) x 1/4 = (54/70) x 1/4 = 27/140
  //   equity   = 50/10 + 30 x 9/70 + 20 x 27/140 = 5 + 27/7 + 27/7 = 12.714285...
  const bubblePayouts = [50, 30, 20];
  const base = icmEquity([3000, 3000, 3000, 1000], bubblePayouts);
  const heroNow = base.equities[3] ?? 0;
  assertClose(heroNow, 5 + 27 / 7 + 27 / 7, 1e-12, 'hero on the bubble');

  // Hero doubles through the first big stack: 2000/3000/3000/2000.
  //   P(H 1st) = 2/10
  //   P(H 2nd) = 2/10 x 2000/8000 + 3/10 x 2000/7000 + 3/10 x 2000/7000
  //            = 1/20 + 6/70 + 6/70 = 0.05 + 0.171428... = 0.2214285...
  //   P(H 3rd) = (A,B) 2/10 x 3000/8000 x 2000/5000 = 0.03
  //            + (A,C) 0.03
  //            + (B,A) 3/10 x 2000/7000 x 2000/5000 = 0.0342857...
  //            + (C,A) 0.0342857...
  //            + (B,C) 3/10 x 3000/7000 x 2000/4000 = 0.0642857...
  //            + (C,B) 0.0642857...
  //            = 0.2571428...
  //   equity   = 0.2 x 50 + 0.2214285 x 30 + 0.2571428 x 20 = 21.785714...
  const doubled = icmEquity([2000, 3000, 3000, 2000], bubblePayouts);
  const heroDoubled = doubled.equities[3] ?? 0;
  assertClose(heroDoubled, 10 + 0.2214285714285714 * 30 + 0.2571428571428571 * 20, 1e-9, 'hero doubled');

  // Hero busts: fourth place on the bubble pays nothing, so this needs no model.
  const busted = icmEquity([4000, 3000, 3000, 0], bubblePayouts);
  assert.equal(busted.equities[3], 0, 'the bubble pays nothing');

  const gain = heroDoubled - heroNow;
  const loss = heroNow - (busted.equities[3] ?? 0);
  // Ground truth is concavity, not arithmetic: ICM equity is a concave function of
  // one's own stack, so a symmetric gamble on that stack always gives up more on the
  // downside than it wins on the upside. Direction only — the ratio itself depends on
  // the ladder and would be a fragile thing to pin.
  assert.ok(
    gain < loss,
    `doubling gained ${gain.toFixed(4)} but busting loses ${loss.toFixed(4)}; the gamble must be ` +
      'unfavourable in prize equity',
  );
  assert.ok(gain > 0, 'doubling must still be worth something');
  // Recorded so the size of the effect is visible: about 0.71 here.
  assert.ok(gain / loss < 0.95, `gain/loss ratio was ${(gain / loss).toFixed(4)}, expected well under 1`);
});

test('a busted player takes the lowest place, and simultaneous busts share it', () => {
  // Ground truth: with hero on zero there is nothing to compute for them — they have
  // finished, and the place left is the last one. Three players, ladder 50/30/20:
  // hero busts, so hero takes 20 and the two survivors split 80 by the two-player
  // rule with stacks 600 and 400: P(first) = 0.6/0.4.
  //   survivor A = 0.6 x 50 + 0.4 x 30 = 30 + 12 = 42
  //   survivor B = 0.4 x 50 + 0.6 x 30 = 20 + 18 = 38
  const oneBust = icmEquity([600, 400, 0], [50, 30, 20]);
  assert.equal(oneBust.equities[2], 20);
  assert.equal(oneBust.equities[0], 42);
  assert.equal(oneBust.equities[1], 38);
  assertClose(total([...oneBust.equities]), 100, 1e-12, 'the pool is still conserved');
  assert.ok(
    oneBust.assumptions.some((note) => note.toLowerCase().includes('no chips')),
    'the busted-player convention must appear in the assumptions',
  );

  // Two players on zero at once: places three and four are 20 and 10, so 15 each.
  const twoBusts = icmEquity([600, 400, 0, 0], [50, 30, 20, 10]);
  assert.equal(twoBusts.equities[2], 15);
  assert.equal(twoBusts.equities[3], 15);
  assert.equal(twoBusts.equities[0], 42);
  assert.equal(twoBusts.equities[1], 38);
  assertClose(total([...twoBusts.equities]), 110, 1e-12, 'the pool');
  assert.ok(
    twoBusts.assumptions.some((note) => note.includes('share')),
    'sharing the bottom places must be stated, not silently assumed',
  );

  // One player holds every chip: they finish first by definition.
  const solo = icmEquity([1000, 0, 0], [50, 30, 20]);
  assert.equal(solo.equities[0], 50);
  assert.equal(solo.equities[1], 25, 'second and third, 30 and 20, shared');
  assert.equal(solo.equities[2], 25);
});

test('icmEquity refuses inputs the model cannot describe', () => {
  const ten = new Array<number>(10).fill(1000);
  assert.throws(() => icmEquity(ten, [50, 30, 20]), IcmError, 'over the player cap');
  assert.throws(() => icmEquity(ten, [50, 30, 20]), /capped at 9 players/);
  assert.throws(() => icmEquity([1000], [100]), IcmError, 'one player is not a tournament');
  assert.throws(() => icmEquity([1000, 1000], []), IcmError, 'no paid places');
  assert.throws(
    () => icmEquity([1000, 1000], [50, 30, 20]),
    /already been decided/,
    'more prizes than players',
  );
  assert.throws(() => icmEquity([1000, -50], [100]), IcmError, 'negative stack');
  assert.throws(() => icmEquity([1000, Number.NaN], [100]), IcmError, 'NaN stack');
  assert.throws(() => icmEquity([1000, Number.POSITIVE_INFINITY], [100]), IcmError, 'infinite stack');
  assert.throws(() => icmEquity([1000, 1000], [100, -1]), IcmError, 'negative prize');
  assert.throws(() => icmEquity([0, 0], [100]), IcmError, 'nobody has chips');
  // Exactly at the cap is fine.
  assert.equal(icmEquity(new Array<number>(9).fill(1000), [50, 30, 20]).equities.length, 9);
});

test('the ICM assumptions state the model, its limits, and the consequence', () => {
  // A product guardrail. A learner shown an ICM number without "this is an
  // approximation, and chips won are worth less than chips lost" has been taught
  // something false, so the wording is asserted here.
  const notes = icmEquity([1000, 1000, 1000], [50, 30, 20]).assumptions;
  const joined = notes.join(' ').toLowerCase();
  assert.ok(notes.length >= 6);
  assert.ok(joined.includes('share of the chips'), 'must state the chip-proportional assumption');
  assert.ok(joined.includes('skill'), 'must state that skill is not modelled');
  assert.ok(joined.includes('blind pressure'), 'must state that blind pressure is not modelled');
  assert.ok(joined.includes('approximation'), 'must say the model is an approximation');
  assert.ok(joined.includes('worth less'), 'must state that chips won are worth less than chips lost');
  assert.ok(joined.includes('survival'), 'must state why survival gains value near the money');
  assert.ok(joined.includes('money'), 'must state the units are valueless practice units');
  assert.ok(icmEquity([1000, 1000], [60, 40]).explanation.includes('Malmuth'), 'the method is named');
});

test('the concavity lesson is claimed only where it is true', () => {
  // Ground truth: ICM equity is stack share x prize when a single place pays, which is
  // exactly LINEAR — doubling really does double it. So the "chips won are worth less"
  // note must not appear on a winner-take-all structure, and the linear note must not
  // appear on a ladder. This is the assumption that would be easiest to leave hard-coded
  // and wrong, which is why it is asserted in both directions.
  const winnerTakesAll = icmEquity([600, 400], [100]).assumptions.join(' ');
  assert.ok(winnerTakesAll.includes('exactly proportional to chips'));
  assert.ok(winnerTakesAll.includes('no survival premium'));
  assert.ok(!winnerTakesAll.includes('worth LESS per chip'), 'no ladder means no concavity to claim');

  // A ladder written with explicit zeros beyond first place is still winner-take-all.
  const zeroPadded = icmEquity([600, 400], [100, 0]).assumptions.join(' ');
  assert.ok(zeroPadded.includes('exactly proportional to chips'));

  const ladder = icmEquity([600, 400], [70, 30]).assumptions.join(' ');
  assert.ok(ladder.includes('worth LESS per chip'));
  assert.ok(!ladder.includes('exactly proportional to chips'));

  // And the claim itself, checked numerically rather than taken on trust: under
  // winner-take-all, doubling a stack doubles its equity exactly.
  const small = icmEquity([1800, 200], [100]);
  const doubled = icmEquity([1600, 400], [100]);
  assert.equal(small.equities[1], 10);
  assert.equal(doubled.equities[1], 20, 'exactly double, so no survival premium exists');
});

// ---------------------------------------------------------------------------
// icmVsChipEv
// ---------------------------------------------------------------------------

test('a chip-neutral coinflip on the bubble is an ICM loss', () => {
  // Same bubble table as above: 3000/3000/3000/1000, ladder 50/30/20, hero is the
  // short stack shoving into one big stack at exactly 50%.
  //   chip EV = 0.5 x (2000 - 1000) + 0.5 x (0 - 1000) = +500 - 500 = 0, exactly.
  //   ICM  EV = 0.5 x 21.785714 + 0.5 x 0 - 12.714285 = 10.892857 - 12.714285
  //           = -1.821428 prize units, i.e. 1.8% of the pool given away for nothing.
  const decision = icmVsChipEv({
    stacks: [3000, 3000, 3000, 1000],
    payouts: [50, 30, 20],
    heroIndex: 3,
    outcomeIfWin: [2000, 3000, 3000, 2000],
    outcomeIfLose: [4000, 3000, 3000, 0],
    winProbability: 0.5,
  });
  assert.equal(decision.chipEv, 0, 'a 50/50 for your stack is exactly chip-neutral');
  assertClose(decision.icmEv, 0.5 * 21.785714285714285 - 12.714285714285714, 1e-9, 'ICM EV');
  assert.ok(decision.icmEv < 0, 'chip-neutral is ICM-negative, which is the whole point');
  // With chipEv exactly zero the divergence is exactly the ICM EV.
  assert.equal(decision.divergence, decision.icmEv);
  assert.ok(decision.explanation.includes('prize equity'));
});

test('even a certain double is worth less than treating chips as money predicts', () => {
  // winProbability = 1 removes the gamble entirely, so the two figures are pure
  // differences and can be checked directly:
  //   chip EV = 2000 - 1000 = 1000 chips
  //   ICM  EV = 21.785714 - 12.714285 = +9.071428 prize units
  //   naive conversion: 1000 chips x (100 units / 10000 chips) = 10 units
  //   divergence = 9.071428 - 10 = -0.928571
  const decision = icmVsChipEv({
    stacks: [3000, 3000, 3000, 1000],
    payouts: [50, 30, 20],
    heroIndex: 3,
    outcomeIfWin: [2000, 3000, 3000, 2000],
    outcomeIfLose: [4000, 3000, 3000, 0],
    winProbability: 1,
  });
  assert.equal(decision.chipEv, 1000);
  assertClose(decision.icmEv, 21.785714285714285 - 12.714285714285714, 1e-9, 'ICM EV of a certain double');
  assert.ok(decision.icmEv > 0, 'doubling is still good');
  assertClose(decision.divergence, decision.icmEv - 10, 1e-12, 'divergence against the flat rate');
  assert.ok(decision.divergence < 0, 'chips are worth less than face value on a ladder');
});

test('a coinflip costs BOTH players and pays the two who stayed out of it', () => {
  // The result that surprises people, and the one worth getting right. A chip-neutral
  // all-in is ICM-negative for the short stack AND for the big stack calling it,
  // because ICM equity is concave in each player's own stack. Prize equity is
  // conserved, so the equity both of them give up has to land somewhere: on the two
  // players who folded and watched.
  //
  // Hand-derived on the same bubble table (3000/3000/3000/1000, ladder 50/30/20, and
  // 100 units in the pool):
  //   now:      short stack 12.714285 (derived above), so the three big stacks share
  //             (100 - 12.714285)/3 = 29.095238 each by symmetry
  //   hero wins (4000/3000/3000/0): the buster's equity is
  //             0.4 x 50 + [2 x 0.3 x 4/7] x 30 + [1 - 0.4 - 0.342857] x 20 = 35.428571
  //             and each bystander holds 0.3 x 50 + [0.4 x 1/2 + 0.3 x 3/7] x 30
  //             + 0.371428 x 20 = 32.285714
  //   hero loses (2000/3000/3000/2000): the two 2000 stacks hold 21.785714 each
  //             (derived above), so the two 3000 stacks hold (100 - 43.571428)/2
  //             = 28.214285 each
  // Averaging the two branches at 50/50:
  //   short stack: 10.892857 - 12.714285 = -1.821428
  //   big stack in the hand: 28.607142 - 29.095238 = -0.488095
  //   each bystander: 30.250000 - 29.095238 = +1.154761
  //   total: -1.821428 - 0.488095 + 2 x 1.154761 = 0
  const payouts = [50, 30, 20];
  const now = icmEquity([3000, 3000, 3000, 1000], payouts);
  const ifShortWins = icmEquity([2000, 3000, 3000, 2000], payouts);
  const ifShortBusts = icmEquity([4000, 3000, 3000, 0], payouts);

  const change = (index: number): number =>
    0.5 * (ifShortWins.equities[index] ?? 0) +
    0.5 * (ifShortBusts.equities[index] ?? 0) -
    (now.equities[index] ?? 0);

  assertClose(change(3), -1.8214285714285714, 1e-9, 'the short stack');
  assertClose(change(0), -0.4880952380952381, 1e-9, 'the big stack that called');
  assertClose(change(1), 1.1547619047619047, 1e-9, 'a bystander');
  assertClose(change(2), 1.1547619047619047, 1e-9, 'the other bystander');
  assert.ok(change(3) < 0 && change(0) < 0, 'a chip-neutral flip costs both participants');
  assert.ok(change(1) > 0 && change(2) > 0, 'and pays the players who folded');
  assertClose(change(0) + change(1) + change(2) + change(3), 0, 1e-9, 'prize equity is conserved');

  // The same spot through icmVsChipEv, from the caller's seat: chip-neutral, ICM-negative.
  const callersView = icmVsChipEv({
    stacks: [3000, 3000, 3000, 1000],
    payouts,
    heroIndex: 0,
    outcomeIfWin: [4000, 3000, 3000, 0],
    outcomeIfLose: [2000, 3000, 3000, 2000],
    winProbability: 0.5,
  });
  assert.equal(callersView.chipEv, 0);
  assertClose(callersView.icmEv, change(0), 1e-12, 'icmVsChipEv agrees with the direct calculation');
  assert.ok(callersView.icmEv < 0);
});

test('icmVsChipEv refuses outcomes that create or destroy chips', () => {
  const base = {
    stacks: [3000, 1000],
    payouts: [70, 30],
    heroIndex: 1,
    outcomeIfWin: [2000, 2000],
    outcomeIfLose: [4000, 0],
    winProbability: 0.4,
  };
  assert.doesNotThrow(() => icmVsChipEv(base));
  assert.throws(() => icmVsChipEv({ ...base, outcomeIfWin: [2000, 2500] }), /neither created nor destroyed/);
  assert.throws(() => icmVsChipEv({ ...base, outcomeIfLose: [3999, 0] }), /neither created nor destroyed/);
  assert.throws(() => icmVsChipEv({ ...base, outcomeIfWin: [2000] }), /one stack per player/);
  assert.throws(() => icmVsChipEv({ ...base, heroIndex: 2 }), IcmError);
  assert.throws(() => icmVsChipEv({ ...base, heroIndex: -1 }), IcmError);
  assert.throws(() => icmVsChipEv({ ...base, winProbability: 1.5 }), IcmError);
  assert.throws(() => icmVsChipEv({ ...base, winProbability: Number.NaN }), IcmError);
});

// ---------------------------------------------------------------------------
// pushFoldChipEv
// ---------------------------------------------------------------------------

test('aces against aces pins the whole push/fold expression to an exact fraction', () => {
  // The one push/fold spot with an exact answer, and it checks every part of the
  // calculation at once.
  //
  // Hero holds AsAh and the big blind calls only with AA. Hero's cards block five of
  // the six ace pairs, so the calling range is the single combination AdAc: 1 of the
  // C(50,2) = 1225 hands the caller can hold, hence a fold 1224/1225 of the time.
  //
  // AsAh against AdAc is exactly half the pot: relabelling spades<->diamonds and
  // hearts<->clubs maps the matchup onto its mirror image, so neither side can have an
  // edge. No sampling involved — one matchup is inside the exact-enumeration budget.
  //
  //   folded through (1224/1225): hero wins the 1 big blind posted
  //   called (1/1225):            pot 10, hero's half is 5, against the 5 put in => 0
  //   chip EV of pushing = 1224/1225 x 1 + 1/1225 x 0 = 1224/1225
  //   chip EV of folding = -(0.5 + 0) = -0.5
  const result = pushFoldChipEv({
    heroCards: parseCards('AsAh'),
    stackBb: 5,
    smallBlindBb: 0.5,
    bigBlindBb: 1,
    callerRangeNotation: 'AA',
  });
  assert.equal(result.equityWhenCalled, 0.5, 'suit symmetry makes this exactly half');
  assert.equal(result.foldProbability, 1 - 1 / 1225);
  assert.equal(result.chipEvOfPush, 1224 / 1225);
  assert.equal(result.chipEvOfFold, -0.5);
  assert.equal(result.pushIsBetterInChips, true);
  assert.equal(result.heroCards, 'As Ah');
  assert.equal(result.callerRange, 'AA');
  assert.ok(
    result.assumptions.some((note) => note.includes('enumerating')),
    'an exactly enumerated figure must say so rather than claim a sampling interval',
  );
});

test('fold probability is the share of the range NOT calling, with hero as a blocker', () => {
  // Hand-countable ground truth in both directions.
  //   "random" calls every hand, so the fold probability is exactly 0.
  //   "AA" against a hero with no ace leaves all 6 ace pairs live: 6/1225 call.
  //   "AA" against a hero holding one ace leaves 3: AsAh, AsAd, AsAc are blocked by
  //   the As, so 3 of the 6 remain.
  const callsEverything = pushFoldChipEv({
    heroCards: parseCards('AsKd'),
    stackBb: 5,
    smallBlindBb: 0.5,
    bigBlindBb: 1,
    callerRangeNotation: 'random',
    samples: 5000,
  });
  assert.equal(callsEverything.foldProbability, 0);

  const noAce = pushFoldChipEv({
    heroCards: parseCards('7d2c'),
    stackBb: 5,
    smallBlindBb: 0.5,
    bigBlindBb: 1,
    callerRangeNotation: 'AA',
  });
  assert.equal(noAce.foldProbability, 1 - 6 / 1225);

  const oneAce = pushFoldChipEv({
    heroCards: parseCards('As7d'),
    stackBb: 5,
    smallBlindBb: 0.5,
    bigBlindBb: 1,
    callerRangeNotation: 'AA',
  });
  assert.equal(oneAce.foldProbability, 1 - 3 / 1225);
  assert.ok(
    oneAce.assumptions.some((note) => note.includes('not a read on any person')),
    'the fold frequency is a property of the assumed range and must say so',
  );
});

test('a very short stack shoving any two cards into a narrow caller is +chipEV', () => {
  // Ground truth is the sign, not the figure. At 2 big blinds against a range that
  // folds better than 97% of the time, hero picks up the posted big blind almost
  // always and risks 2 to win 2 on the rare call, so the sum cannot come out negative
  // regardless of what the 72o-versus-TT+ equity turns out to be:
  //   worst case = 0.9722 x 1 + 0.0278 x (0 - 2) = 0.972 - 0.056 > 0
  // even if hero's equity when called were zero. Sampling therefore cannot flip the
  // sign; only a bug in the EV expression could.
  const result = pushFoldChipEv({
    heroCards: parseCards('7d2c'),
    stackBb: 2,
    smallBlindBb: 0.5,
    bigBlindBb: 1,
    callerRangeNotation: 'TT+, AKs',
    samples: 5000,
  });
  assert.ok(result.chipEvOfPush > 0, `expected a positive chip EV, got ${result.chipEvOfPush}`);
  assert.ok(result.chipEvOfPush > result.chipEvOfFold);
  assert.equal(result.pushIsBetterInChips, true);
  assert.ok(result.foldProbability > 0.9, `narrow range should fold often, got ${result.foldProbability}`);
  // Hero's equity when called is sampled; a wide sanity band, not a claim about the
  // exact number. 72o against a range of big pairs is somewhere near a third at most.
  assert.ok(result.equityWhenCalled > 0.05 && result.equityWhenCalled < 0.35);
});

test('a deep stack shoving a weak hand into a caller who never folds is -chipEV', () => {
  // Ground truth: with a range that calls 100% of the time there is no fold equity at
  // all, so the shove is worth 2 x 25 x equity - 25 big blinds. 72o cannot be worth
  // half the pot against a random hand — it is the weakest region of the deck — so
  // the expression must be negative. Sampling error of half a percentage point moves
  // it by a quarter of a big blind against a shortfall of eight, so the sign is safe.
  const result = pushFoldChipEv({
    heroCards: parseCards('7d2c'),
    stackBb: 25,
    smallBlindBb: 0.5,
    bigBlindBb: 1,
    callerRangeNotation: 'random',
    samples: 5000,
  });
  assert.equal(result.foldProbability, 0, 'a random caller never folds');
  assert.ok(result.equityWhenCalled < 0.45, `72o cannot be a favourite, got ${result.equityWhenCalled}`);
  assert.ok(result.chipEvOfPush < 0, `expected a negative chip EV, got ${result.chipEvOfPush}`);
  assert.ok(result.chipEvOfPush < result.chipEvOfFold, 'folding for half a blind is much cheaper');
  assert.equal(result.pushIsBetterInChips, false);
  // The identity the figure has to satisfy when nobody folds, checked directly.
  assertClose(result.chipEvOfPush, 2 * 25 * result.equityWhenCalled - 25, 1e-12, 'no-fold-equity identity');
});

test('an ante makes shoving better and folding worse, by exactly the ante', () => {
  // Hand-derived: the ante is dead money in both branches. Folding costs the small
  // blind plus the ante, and a fold-through wins the big blind plus the ante, so with
  // the same seed and the same cards the two calls differ by known amounts and the
  // equity when called does not move at all.
  const shared = {
    heroCards: parseCards('7d2c'),
    stackBb: 8,
    smallBlindBb: 0.5,
    bigBlindBb: 1,
    callerRangeNotation: '22+, A2s+, KQs',
    samples: 5000,
    seed: 7,
  };
  const withoutAnte = pushFoldChipEv(shared);
  const withAnte = pushFoldChipEv({ ...shared, anteBb: 1 });
  assert.equal(withoutAnte.chipEvOfFold, -0.5);
  assert.equal(withAnte.chipEvOfFold, -1.5, 'the ante is forfeited too');
  assert.equal(withAnte.equityWhenCalled, withoutAnte.equityWhenCalled, 'the cards did not change');
  const foldProbability = withoutAnte.foldProbability;
  assertClose(
    withAnte.chipEvOfPush - withoutAnte.chipEvOfPush,
    foldProbability * 1,
    1e-12,
    'the extra dead money is only collected when the shove goes through',
  );
  assert.ok(withAnte.chipEvOfPush > withoutAnte.chipEvOfPush, 'more dead money favours shoving');
});

test('pushFoldChipEv is deterministic for a given seed and refuses bad inputs', () => {
  const shared = {
    heroCards: parseCards('Th9h'),
    stackBb: 12,
    smallBlindBb: 0.5,
    bigBlindBb: 1,
    callerRangeNotation: '55+, A8s+, KJs+, AJo+',
    samples: 4000,
    seed: 99,
  };
  assert.deepEqual(pushFoldChipEv(shared), pushFoldChipEv(shared), 'same seed, same figure');
  assert.notEqual(
    pushFoldChipEv({ ...shared, seed: 100 }).equityWhenCalled,
    pushFoldChipEv(shared).equityWhenCalled,
    'a different seed must actually draw different run-outs',
  );

  assert.throws(() => pushFoldChipEv({ ...shared, heroCards: parseCards('Th9h8h') }), /exactly 2 cards/);
  // Card validity is delegated to the engine, so it raises the engine's own named
  // error. Documented on the function: its message ("heroCards contains Th twice") is
  // more specific than anything a wrapper here could say.
  assert.throws(() => pushFoldChipEv({ ...shared, heroCards: parseCards('ThTh') }), CardParseError);
  assert.throws(() => pushFoldChipEv({ ...shared, heroCards: parseCards('ThTh') }), /contains Th twice/);
  assert.throws(() => pushFoldChipEv({ ...shared, stackBb: 0.5 }), /at least the big blind/);
  assert.throws(() => pushFoldChipEv({ ...shared, smallBlindBb: 0 }), /blinds must be positive/);
  assert.throws(() => pushFoldChipEv({ ...shared, smallBlindBb: 2 }), /cannot exceed the big blind/);
  assert.throws(() => pushFoldChipEv({ ...shared, anteBb: -1 }), IcmError);
  assert.throws(() => pushFoldChipEv({ ...shared, samples: 10 }), /between 1000 and 200000/);
  assert.throws(() => pushFoldChipEv({ ...shared, samples: 10_000_000 }), IcmError);
  assert.throws(() => pushFoldChipEv({ ...shared, seed: 1.5 }), IcmError);
  // Likewise the range notation: ranges.ts already names the offending token.
  assert.throws(() => pushFoldChipEv({ ...shared, callerRangeNotation: 'ZZ' }), RangeParseError);
  assert.throws(() => pushFoldChipEv({ ...shared, callerRangeNotation: 'T9s+' }), /ambiguous/);
});

test('push/fold assumptions say it is chip EV only and name the opponent model', () => {
  const result = pushFoldChipEv({
    heroCards: parseCards('AhKh'),
    stackBb: 10,
    smallBlindBb: 0.5,
    bigBlindBb: 1,
    callerRangeNotation: '77+, ATs+, AJo+',
    samples: 4000,
  });
  const joined = result.assumptions.join(' ').toLowerCase();
  assert.ok(result.assumptions.length >= 6);
  assert.ok(joined.includes('chip ev only'), 'must say the prize ladder is not in the figure');
  assert.ok(joined.includes('icmvschipev'), 'must point at the ICM-aware function');
  assert.ok(joined.includes('heads-up'), 'must state the heads-up framing');
  assert.ok(joined.includes('covers hero'), 'must state that the big blind covers');
  assert.ok(joined.includes('1225'), 'must state the size of the caller’s hand space');
  assert.ok(joined.includes('no postflop play'), 'must state that an all-in has no postflop play');
  assert.ok(joined.includes('money'), 'must state the units are valueless practice units');
  assert.ok(result.explanation.includes('small blind'));
  assert.ok(result.explanation.includes('%'));
});
