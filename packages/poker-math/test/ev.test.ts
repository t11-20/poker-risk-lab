/**
 * Tests for src/ev.ts.
 *
 * ## Where the expected values come from
 *
 * Nothing here compares ev.ts against ev.ts. Every expectation is one of:
 *
 *   * arithmetic done by hand in a comment above the assertion;
 *   * a closed-form identity derived independently in this file — chiefly
 *     `breakEvenEquityByHand` and `breakEvenBluffFrequencyByHand` below, each
 *     re-derived from the definition of EV rather than copied from the source;
 *   * a structural property that must hold whatever the formula is (probabilities
 *     summing to 1, contributions summing to the total, monotonicity, linearity,
 *     round-tripping a solved root back through the function it was solved from).
 *
 * ## The pot-odds cross-check
 *
 * The most valuable test in this file is the break-even identity: at exactly the
 * pot-odds break-even equity, calling is worth exactly nothing. It is run three ways
 * on the same grid — the price as `odds.ts` computes it, the price as derived by hand
 * here, and the EV as `ev.ts` computes it — so the test fails if any one of the three
 * drifts. Pricing lives in odds.ts and EV lives in ev.ts; this is the seam between
 * them, and a seam is exactly where a test earns its keep.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  breakEvenBluffFrequency,
  evOfBet,
  evOfCall,
  evOfCheck,
  evOfFold,
  evOfRaise,
  evOfSemiBluff,
  requiredFoldEquity,
} from '../src/ev.ts';
import { defenceFrequency, potOdds, priceLaidByBet } from '../src/odds.ts';

const TOLERANCE = 1e-9;

function closeTo(actual: number, expected: number, message: string, tolerance = TOLERANCE): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual} (difference ${Math.abs(actual - expected)})`,
  );
}

/**
 * The equity a call needs to break even, derived here from the definition of EV and
 * NOT from ev.ts.
 *
 * You put in `toCall` to play for a pot that will hold `pot + toCall`. Win a share
 * `e` of the time and the average return is `e x (pot + toCall)`; the cost is
 * `toCall` every time. Setting return equal to cost:
 *
 *     e x (pot + toCall) = toCall
 *     e = toCall / (pot + toCall)
 *
 * which is the pot-odds price expressed as a required win frequency.
 */
function breakEvenEquityByHand(pot: number, toCall: number): number {
  return toCall / (pot + toCall);
}

/**
 * How often a pure bluff must work, derived here by balancing the two branches
 * rather than by reusing the source's formula.
 *
 * When it works you are `pot` up; when it does not you are `betSize` down. Balance:
 *
 *     f x pot = (1 - f) x betSize
 *     f x pot + f x betSize = betSize
 *     f = betSize / (pot + betSize)
 */
function breakEvenBluffFrequencyByHand(pot: number, betSize: number): number {
  return betSize / (pot + betSize);
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

// A spread of shapes to run the identities over: tiny pots, huge pots, pots smaller
// than the bet, and the empty pot that is the interesting boundary case.
const POTS = [0, 1, 3, 10, 40, 100, 250, 1000, 7777];
const BETS = [1, 2, 7, 25, 50, 100, 333, 2500];
const EQUITIES = [0, 0.01, 0.1, 0.25, 1 / 3, 0.5, 0.618, 0.75, 0.9, 1];

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

test('folding is exactly the zero point, and says why', () => {
  const fold = evOfFold();
  assert.equal(fold.ev, 0, 'folding must be exactly 0, not approximately 0');
  assert.equal(sum(fold.terms.map((term) => term.contribution)), 0);
  assert.equal(sum(fold.terms.map((term) => term.probability)), 1, 'the single branch is certain');
  assert.ok(fold.assumptions.length > 0, 'even a zero carries its reasoning');
  assert.ok(
    fold.assumptions.some((note) => note.includes('already')),
    'the sunk-cost point is the reason folding is the baseline, so it must be stated',
  );
});

// ---------------------------------------------------------------------------
// Call
// ---------------------------------------------------------------------------

test('calling at exactly the pot-odds break-even equity is worth exactly nothing', () => {
  // The identity this whole file hangs on. Worked by hand for one case first:
  // pot 100, toCall 50 -> break-even equity 50/150 = 1/3, and
  // (1/3) x (100 + 50) - 50 = 50 - 50 = 0.
  closeTo(evOfCall({ pot: 100, toCall: 50, equity: 1 / 3 }).ev, 0, 'the worked case');

  // Then across the grid, tying three things together: odds.ts's price, the hand
  // derivation at the top of this file, and ev.ts's EV. Feeding the price odds.ts
  // quotes into the EV ev.ts computes must land on exactly zero, or the two modules
  // disagree about what break-even means.
  let checked = 0;
  for (const pot of POTS) {
    for (const toCall of BETS) {
      const priced = potOdds(pot, toCall).breakEvenEquity;
      closeTo(priced, breakEvenEquityByHand(pot, toCall), `odds.ts price for pot ${pot}, toCall ${toCall}`);
      const { ev } = evOfCall({ pot, toCall, equity: priced });
      closeTo(ev, 0, `pot ${pot}, toCall ${toCall}, break-even equity ${priced}`);
      checked += 1;
    }
  }
  assert.equal(checked, POTS.length * BETS.length);
  assert.equal(checked, 72, 'the grid is the size it looks');
});

test('a hair above the break-even equity makes the call profitable, a hair below makes it lose', () => {
  // The identity above pins one point on the line; this pins its direction, which is
  // what makes the point meaningful rather than a coincidence.
  //
  // An empty pot is the one shape with no "above": break-even equity is
  // toCall / (0 + toCall) = 1, so there is nothing better than break-even to test
  // and calling into nothing is a wash at best. Asserted rather than skipped.
  for (const pot of POTS) {
    for (const toCall of BETS) {
      const breakEven = breakEvenEquityByHand(pot, toCall);
      if (pot === 0) {
        assert.equal(breakEven, 1, 'with an empty pot only certainty breaks even');
        assert.equal(evOfCall({ pot, toCall, equity: 1 }).ev, 0, 'and it is only ever a wash');
        continue;
      }
      const above = Math.min(1, breakEven + 1e-3);
      const below = Math.max(0, breakEven - 1e-3);
      assert.ok(evOfCall({ pot, toCall, equity: above }).ev > 0, `pot ${pot}, toCall ${toCall}: above`);
      assert.ok(evOfCall({ pot, toCall, equity: below }).ev < 0, `pot ${pot}, toCall ${toCall}: below`);
    }
  }
});

test('calling with no equity loses exactly the call; calling with all of it wins exactly the pot', () => {
  // Integer inputs so these are exact, not approximate: e = 0 leaves -toCall, and
  // e = 1 leaves (pot + toCall) - toCall, which is exact for integers.
  for (const pot of POTS) {
    for (const toCall of BETS) {
      assert.equal(evOfCall({ pot, toCall, equity: 0 }).ev, -toCall, `pot ${pot}, toCall ${toCall}`);
      assert.equal(evOfCall({ pot, toCall, equity: 1 }).ev, pot, `pot ${pot}, toCall ${toCall}`);
    }
  }
});

test('EV of a call rises strictly with equity, by (pot + toCall) per unit', () => {
  // The formula is a straight line in equity with slope (pot + toCall), which is
  // strictly positive whenever there is anything to call. Both facts are checked.
  for (const pot of POTS) {
    for (const toCall of BETS) {
      let previous = Number.NEGATIVE_INFINITY;
      for (let step = 0; step <= 20; step++) {
        const equity = step / 20;
        const { ev } = evOfCall({ pot, toCall, equity });
        assert.ok(ev > previous, `pot ${pot}, toCall ${toCall}, equity ${equity}: not increasing`);
        previous = ev;
      }
      const slope = evOfCall({ pot, toCall, equity: 1 }).ev - evOfCall({ pot, toCall, equity: 0 }).ev;
      closeTo(slope, pot + toCall, `slope for pot ${pot}, toCall ${toCall}`);
    }
  }
});

test('EV of a call matches arithmetic done by hand', () => {
  // 0.5 x (100 + 50) - 50 = 75 - 50 = 25.
  closeTo(evOfCall({ pot: 100, toCall: 50, equity: 0.5 }).ev, 25, 'coin flip for 50 into 100');
  // 0.6 x (30 + 70) - 70 = 60 - 70 = -10. Ahead of the hand, behind the price.
  closeTo(evOfCall({ pot: 30, toCall: 70, equity: 0.6 }).ev, -10, 'favourite at a bad price');
  // 0.25 x (60 + 20) - 20 = 20 - 20 = 0.
  closeTo(evOfCall({ pot: 60, toCall: 20, equity: 0.25 }).ev, 0, '4 to 1 with a 4-to-1 shot');
  // Calling into an empty pot can only lose: 0.5 x (0 + 10) - 10 = -5.
  closeTo(evOfCall({ pot: 0, toCall: 10, equity: 0.5 }).ev, -5, 'nothing to win');
  // A free showdown is worth your share of what is there: 0.4 x (80 + 0) - 0 = 32.
  closeTo(evOfCall({ pot: 80, toCall: 0, equity: 0.4 }).ev, 32, 'checking to a showdown');
});

test("a call's branches are a probability distribution and account for all of its EV", () => {
  for (const pot of POTS) {
    for (const toCall of BETS) {
      for (const equity of EQUITIES) {
        const result = evOfCall({ pot, toCall, equity });
        closeTo(sum(result.terms.map((term) => term.probability)), 1, 'branch probabilities');
        closeTo(sum(result.terms.map((term) => term.contribution)), result.ev, 'contributions');
        for (const term of result.terms) {
          closeTo(term.contribution, term.probability * term.value, `${term.label}: contribution`);
        }
      }
    }
  }
});

test('a call always states the pot it was priced against and that nothing follows it', () => {
  const result = evOfCall({ pot: 100, toCall: 50, equity: 0.4 });
  assert.ok(result.assumptions.length >= 4, 'a figure this loaded needs more than one caveat');
  assert.ok(result.derivation.includes('EV(call)'), 'the derivation names what it is deriving');
  assert.ok(result.derivation.includes('100'), 'and substitutes the actual numbers');
  assert.ok(
    result.assumptions.some((note) => note.includes('showdown')),
    'the no-further-betting assumption is the biggest one and must be visible',
  );
});

// ---------------------------------------------------------------------------
// Bet
// ---------------------------------------------------------------------------

test('a bet they always fold to is worth exactly the pot', () => {
  // f = 1 collapses the formula to 1 x pot: nothing is risked because nothing is
  // ever called. Exact, not approximate.
  for (const pot of POTS) {
    for (const betSize of BETS) {
      for (const equityWhenCalled of EQUITIES) {
        const { ev } = evOfBet({ pot, betSize, foldProbability: 1, equityWhenCalled });
        assert.equal(ev, pot, `pot ${pot}, bet ${betSize}, equity ${equityWhenCalled}`);
      }
    }
  }
});

test('a bet they never fold to is worth exactly what calling that bet into the bigger pot is worth', () => {
  // f = 0 leaves e x (pot + 2b) - b. That is EV(call) for someone facing a bet of b
  // into a pot of (pot + b): e x ((pot + b) + b) - b. Betting and being called costs
  // and pays what calling costs and pays, which is why the two functions must agree
  // here to the last decimal place.
  for (const pot of POTS) {
    for (const betSize of BETS) {
      for (const equityWhenCalled of EQUITIES) {
        const bet = evOfBet({ pot, betSize, foldProbability: 0, equityWhenCalled }).ev;
        const call = evOfCall({ pot: pot + betSize, toCall: betSize, equity: equityWhenCalled }).ev;
        closeTo(bet, call, `pot ${pot}, bet ${betSize}, equity ${equityWhenCalled}`);
        // And against arithmetic that mentions neither function.
        closeTo(bet, equityWhenCalled * (pot + 2 * betSize) - betSize, 'closed form');
      }
    }
  }
});

test('EV of a bet is a straight line in the fold frequency', () => {
  // The two branches do not interact, so the midpoint of the endpoints is the value
  // at the midpoint. That linearity is what makes requiredFoldEquity a closed form,
  // so it is worth pinning independently.
  for (const pot of [0, 25, 100, 900]) {
    for (const betSize of [5, 60, 400]) {
      for (const equityWhenCalled of [0, 0.2, 0.5, 0.95]) {
        const at0 = evOfBet({ pot, betSize, foldProbability: 0, equityWhenCalled }).ev;
        const at1 = evOfBet({ pot, betSize, foldProbability: 1, equityWhenCalled }).ev;
        for (const f of [0.1, 0.25, 0.5, 0.8]) {
          const actual = evOfBet({ pot, betSize, foldProbability: f, equityWhenCalled }).ev;
          closeTo(actual, at0 + f * (at1 - at0), `pot ${pot}, bet ${betSize}, f ${f}`);
        }
      }
    }
  }
});

test('EV of a bet matches arithmetic done by hand', () => {
  // 0.4 x 100 + 0.6 x [0.25 x (100 + 100) - 50] = 40 + 0.6 x 0 = 40.
  closeTo(evOfBet({ pot: 100, betSize: 50, foldProbability: 0.4, equityWhenCalled: 0.25 }).ev, 40, 'A');
  // 0.2 x 100 + 0.8 x [0.1 x 200 - 50] = 20 + 0.8 x (-30) = 20 - 24 = -4.
  closeTo(evOfBet({ pot: 100, betSize: 50, foldProbability: 0.2, equityWhenCalled: 0.1 }).ev, -4, 'B');
  // A pot-sized bet with nothing: 0.5 x 100 + 0.5 x [0 x 300 - 100] = 50 - 50 = 0,
  // which is why a pot-sized bluff has to work half the time.
  closeTo(evOfBet({ pot: 100, betSize: 100, foldProbability: 0.5, equityWhenCalled: 0 }).ev, 0, 'C');
});

test("a bet's branches are a probability distribution and account for all of its EV", () => {
  for (const pot of POTS) {
    for (const betSize of BETS) {
      for (const equityWhenCalled of EQUITIES) {
        for (const foldProbability of [0, 0.15, 0.5, 0.85, 1]) {
          const result = evOfBet({ pot, betSize, foldProbability, equityWhenCalled });
          assert.equal(result.terms.length, 3, 'fold, called-and-won, called-and-lost');
          closeTo(sum(result.terms.map((term) => term.probability)), 1, 'branch probabilities');
          closeTo(sum(result.terms.map((term) => term.contribution)), result.ev, 'contributions');
          for (const term of result.terms) {
            closeTo(term.contribution, term.probability * term.value, `${term.label}: contribution`);
          }
        }
      }
    }
  }
});

test('callerCanRaise changes no number and adds exactly one warning', () => {
  const base = { pot: 120, betSize: 80, foldProbability: 0.45, equityWhenCalled: 0.3 };
  const quiet = evOfBet(base);
  const warned = evOfBet({ ...base, callerCanRaise: true });
  assert.equal(warned.ev, quiet.ev, 'the model is unchanged — only the disclosure changes');
  assert.equal(warned.assumptions.length, quiet.assumptions.length + 1);
  assert.ok(
    warned.assumptions.some((note) => note.includes('optimistic')),
    'the added assumption must say which way the figure is wrong, not merely that it is incomplete',
  );
  assert.ok(
    !quiet.assumptions.some((note) => note.includes('optimistic')),
    'and it must not appear when the caller did not ask for it',
  );
  assert.equal(evOfBet({ ...base, callerCanRaise: false }).assumptions.length, quiet.assumptions.length);
});

// ---------------------------------------------------------------------------
// Required fold equity
// ---------------------------------------------------------------------------

test('the required fold equity, fed back into the bet, gives exactly break-even', () => {
  // The round trip: solve EV(bet) = 0 for f, then evaluate EV(bet) at that f. Any
  // algebra slip in the closed form shows up here immediately.
  let roundTripped = 0;
  // Counted here from the sign of the called branch, which is what decides whether a
  // fold frequency is needed at all. If the two counts ever diverge, the source has
  // started reporting 0 (or something above 1) for a case that really does have a
  // break-even point inside the range, and the round trip above would be quietly
  // skipping it rather than failing.
  let expectedRoundTrips = 0;
  for (const pot of POTS) {
    for (const betSize of BETS) {
      for (const equityWhenCalled of EQUITIES) {
        if (equityWhenCalled * (pot + 2 * betSize) - betSize < 0) expectedRoundTrips += 1;
        const { foldEquityNeeded } = requiredFoldEquity({ pot, betSize, equityWhenCalled });
        if (foldEquityNeeded <= 0 || foldEquityNeeded > 1) continue;
        const { ev } = evOfBet({ pot, betSize, foldProbability: foldEquityNeeded, equityWhenCalled });
        closeTo(ev, 0, `pot ${pot}, bet ${betSize}, equity ${equityWhenCalled}, f* ${foldEquityNeeded}`);
        roundTripped += 1;
      }
    }
  }
  assert.equal(
    roundTripped,
    expectedRoundTrips,
    'every losing-when-called bet has a break-even fold frequency',
  );
  assert.equal(roundTripped, 257, 'and the grid really does reach that many of them');
});

test('required fold equity with no equity is exactly the break-even bluff frequency', () => {
  // Two closed forms reached from opposite ends. `requiredFoldEquity` solves the EV
  // line, f* = -S/(pot - S); with S = -b that collapses to b/(pot + b), which is what
  // alpha is, and alpha comes from odds.ts. So this compares a root solved out of the
  // EV formula against a price computed in a different module, plus the hand
  // derivation at the top of this file — three routes to one number.
  for (const pot of POTS) {
    for (const betSize of BETS) {
      const solved = requiredFoldEquity({ pot, betSize, equityWhenCalled: 0 }).foldEquityNeeded;
      const alpha = breakEvenBluffFrequency(pot, betSize).frequency;
      closeTo(solved, alpha, `pot ${pot}, bet ${betSize}: solved root vs alpha`);
      closeTo(solved, breakEvenBluffFrequencyByHand(pot, betSize), 'and vs the hand derivation');
      closeTo(alpha, defenceFrequency(pot, betSize).alpha, 'and vs alpha straight from odds.ts');
      // Alpha and minimum defence frequency are complements, which is the property
      // that makes "how often must a bluff work" and "how often must they continue"
      // two readings of one number.
      closeTo(alpha + defenceFrequency(pot, betSize).minimumDefenceFrequency, 1, 'alpha + MDF = 1');
    }
  }
});

test('a bet that already breaks even when called needs no fold equity at all', () => {
  // Degenerate branch one. The called branch is worth e x (pot + 2b) - b, which is
  // zero exactly when e = b / (pot + 2b) — the price the bet lays a caller. At or
  // above that equity the answer is 0 folds needed.
  // 50 into 100 lays 50/200 = 0.25, so equity 0.25 is the exact hinge.
  const hinge = requiredFoldEquity({ pot: 100, betSize: 50, equityWhenCalled: 0.25 });
  assert.equal(hinge.foldEquityNeeded, 0, 'at the hinge the bet breaks even with no folds');
  assert.ok(hinge.explanation.includes('no fold equity'));

  const comfortable = requiredFoldEquity({ pot: 100, betSize: 50, equityWhenCalled: 0.5 });
  assert.equal(comfortable.foldEquityNeeded, 0);
  assert.ok(comfortable.explanation.includes('no fold equity'));

  // And across the grid: never negative, and exactly 0 whenever the called branch is
  // not losing. Returning a negative "required" frequency would be nonsense that a
  // UI would happily render.
  for (const pot of POTS) {
    for (const betSize of BETS) {
      for (const equityWhenCalled of EQUITIES) {
        const showdownEv = equityWhenCalled * (pot + 2 * betSize) - betSize;
        const { foldEquityNeeded } = requiredFoldEquity({ pot, betSize, equityWhenCalled });
        assert.ok(foldEquityNeeded >= 0, `pot ${pot}, bet ${betSize}: negative fold equity needed`);
        if (showdownEv >= 0) {
          assert.equal(foldEquityNeeded, 0, `pot ${pot}, bet ${betSize}, equity ${equityWhenCalled}`);
        } else {
          assert.ok(foldEquityNeeded > 0, `pot ${pot}, bet ${betSize}, equity ${equityWhenCalled}`);
        }
      }
    }
  }
});

test('a bet whose called branch beats the pot itself reports 0 and says folds cost value', () => {
  // The other half of degenerate branch one, and the trap in the algebra. With
  // pot 100, b 50, e 0.9 the called branch is worth 0.9 x 200 - 50 = 130, which is
  // more than the 100 a fold wins. The line EV(f) = S + f x (pot - S) then SLOPES
  // DOWN, and the naive root (b - e(pot + 2b)) / (pot + b - e(pot + 2b))
  //   = (50 - 180) / (150 - 180) = -130 / -30 = 4.33
  // is above 1 — for the most profitable bet in the model. Reporting that as
  // "impossible" would be exactly backwards, so the source branches on the sign of
  // the called branch instead, and this test pins that.
  const result = requiredFoldEquity({ pot: 100, betSize: 50, equityWhenCalled: 0.9 });
  assert.equal(result.foldEquityNeeded, 0);
  assert.ok(result.explanation.includes('cost you value'), 'the direction of the effect must be stated');
  assert.ok(evOfBet({ pot: 100, betSize: 50, foldProbability: 0, equityWhenCalled: 0.9 }).ev > 0);
  // Folds really do cost value here: more folding is worse.
  const noFolds = evOfBet({ pot: 100, betSize: 50, foldProbability: 0, equityWhenCalled: 0.9 }).ev;
  const allFolds = evOfBet({ pot: 100, betSize: 50, foldProbability: 1, equityWhenCalled: 0.9 }).ev;
  assert.ok(noFolds > allFolds, 'a call is the branch you want with equity this high');
});

test('with an empty pot the bet needs a certain fold, and even then only breaks even', () => {
  // Degenerate branch two, at its boundary. Pot 0, bet 50, no equity:
  // EV(f) = f x 0 + (1 - f) x (0 - 50) = -50 x (1 - f), which is zero only at f = 1.
  const result = requiredFoldEquity({ pot: 0, betSize: 50, equityWhenCalled: 0 });
  assert.equal(result.foldEquityNeeded, 1, 'exactly 1, not clamped from something larger');
  assert.ok(result.explanation.includes('certainty'), 'the reader must be told this is unachievable');
  closeTo(evOfBet({ pot: 0, betSize: 50, foldProbability: 1, equityWhenCalled: 0 }).ev, 0, 'round trip');

  // And the general statement, which is stronger than the brief asked for: while the
  // pot is not negative, the required fold frequency can never EXCEED 1, because a
  // fold hands you the whole pot at no risk, so EV(f = 1) = pot >= 0 always. It
  // reaches 1 only when the pot is empty. So "this bet cannot break even at any fold
  // frequency" is unreachable here by construction — the honest teaching point is
  // that the question is never whether enough folds would rescue a bet, but whether
  // that many folds are plausible.
  for (const pot of POTS) {
    for (const betSize of BETS) {
      for (const equityWhenCalled of EQUITIES) {
        const { foldEquityNeeded } = requiredFoldEquity({ pot, betSize, equityWhenCalled });
        assert.ok(foldEquityNeeded <= 1, `pot ${pot}, bet ${betSize}, equity ${equityWhenCalled}`);
        if (foldEquityNeeded === 1) {
          assert.equal(pot, 0, 'a required frequency of 1 can only happen with nothing in the pot');
        }
      }
    }
  }
});

test('required fold equity rises with the bet size and falls with equity', () => {
  // Both directions are forced by the formula and are what a learner should take
  // away: bigger bets need more folds, better hands need fewer.
  let previous = -1;
  for (const betSize of [10, 25, 50, 100, 200, 400]) {
    const needed = requiredFoldEquity({ pot: 100, betSize, equityWhenCalled: 0 }).foldEquityNeeded;
    assert.ok(needed > previous, `bet ${betSize}: required fold equity did not rise`);
    previous = needed;
  }
  let last = Number.POSITIVE_INFINITY;
  for (const equityWhenCalled of [0, 0.05, 0.1, 0.15, 0.2]) {
    const needed = requiredFoldEquity({ pot: 100, betSize: 75, equityWhenCalled }).foldEquityNeeded;
    assert.ok(needed < last, `equity ${equityWhenCalled}: required fold equity did not fall`);
    last = needed;
  }
});

// ---------------------------------------------------------------------------
// Break-even bluff frequency
// ---------------------------------------------------------------------------

test('the break-even bluff frequency is the risk over what you end up with', () => {
  // Hand-derived: 50 to win 100 means 50 / 150 = 1/3.
  assert.equal(
    breakEvenBluffFrequency(100, 50).frequency,
    1 / 3,
    '50 into 100 must work a third of the time',
  );
  // A pot-sized bluff risks the pot to win the pot: 100 / 200 = 1/2.
  assert.equal(breakEvenBluffFrequency(100, 100).frequency, 0.5, 'a pot-sized bluff must work half the time');
  // Twice the pot: 200 / 300 = 2/3.
  closeTo(breakEvenBluffFrequency(100, 200).frequency, 2 / 3, 'a double-pot bluff');
  // A quarter pot: 25 / 125 = 0.2.
  closeTo(breakEvenBluffFrequency(100, 25).frequency, 0.2, 'a quarter-pot bluff');

  for (const pot of POTS) {
    for (const betSize of BETS) {
      closeTo(
        breakEvenBluffFrequency(pot, betSize).frequency,
        breakEvenBluffFrequencyByHand(pot, betSize),
        `pot ${pot}, bet ${betSize}`,
      );
    }
  }
});

test('a pure bluff at exactly its break-even frequency is worth exactly nothing', () => {
  // Ties the frequency back to the EV it came from: alpha is meaningless unless
  // betting at alpha with no equity really is a wash.
  for (const pot of POTS) {
    for (const betSize of BETS) {
      const { frequency } = breakEvenBluffFrequency(pot, betSize);
      const { ev } = evOfBet({ pot, betSize, foldProbability: frequency, equityWhenCalled: 0 });
      closeTo(ev, 0, `pot ${pot}, bet ${betSize}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Semi-bluff
// ---------------------------------------------------------------------------

test('the two halves of a semi-bluff sum to its EV', () => {
  // The decomposition is the reason the function exists, so it is checked over the
  // whole grid rather than on one example.
  let checked = 0;
  for (const pot of POTS) {
    for (const betSize of BETS) {
      for (const equityWhenCalled of EQUITIES) {
        for (const foldProbability of [0, 0.1, 0.33, 0.5, 0.9, 1]) {
          const result = evOfSemiBluff({ pot, betSize, foldProbability, equityWhenCalled });
          closeTo(result.foldEquityShare + result.showdownShare, result.ev, 'the split must be exhaustive');
          // And it is the same model as evOfBet, not a second one that could drift.
          closeTo(result.ev, evOfBet({ pot, betSize, foldProbability, equityWhenCalled }).ev, 'same model');
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 4000, `expected a wide sweep, ran ${checked}`);
});

test('the halves of a semi-bluff are the numbers they claim to be', () => {
  // Hand-derived: pot 100, bet 50, folds 40%, equity when called 30%.
  //   fold half     = 0.4 x 100                       = 40
  //   showdown half = 0.6 x [0.3 x (100 + 100) - 50]  = 0.6 x 10 = 6
  //   total                                            = 46
  const result = evOfSemiBluff({ pot: 100, betSize: 50, foldProbability: 0.4, equityWhenCalled: 0.3 });
  closeTo(result.foldEquityShare, 40, 'fold half');
  closeTo(result.showdownShare, 6, 'showdown half');
  closeTo(result.ev, 46, 'total');
});

test('a pure bluff has all of its value in the fold half, and pays for the calls', () => {
  // Equity 0, pot 100, bet 50, folds 50%:
  //   fold half     = 0.5 x 100          = 50
  //   showdown half = 0.5 x (0 - 50)     = -25
  //   total                                = 25
  const bluff = evOfSemiBluff({ pot: 100, betSize: 50, foldProbability: 0.5, equityWhenCalled: 0 });
  closeTo(bluff.foldEquityShare, 50, 'fold half');
  closeTo(bluff.showdownShare, -25, 'the showdown half of a pure bluff is the price of being called');
  closeTo(bluff.ev, 25, 'total');
  assert.ok(bluff.showdownShare < 0, 'a hand with no equity cannot earn at showdown');
});

test('the showdown half turns positive exactly when equity clears the price the bet lays', () => {
  // The called branch is e x (pot + 2b) - b, zero at e = b / (pot + 2b). So the sign
  // of the showdown half is decided by that price and nothing else — which is the
  // link between sizing and how much of a draw you need.
  for (const pot of [40, 100, 333]) {
    for (const betSize of [10, 50, 100, 250]) {
      // The price comes from odds.ts, and is checked against the hand derivation, so
      // this test is also a check that the sign of a semi-bluff's showdown half is
      // governed by the price the app quotes elsewhere.
      const price = priceLaidByBet(pot, betSize).breakEvenEquity;
      closeTo(price, betSize / (pot + 2 * betSize), `pot ${pot}, bet ${betSize}: the price odds.ts quotes`);
      for (const delta of [-0.05, -0.001, 0.001, 0.05]) {
        const equityWhenCalled = Math.min(1, Math.max(0, price + delta));
        const { showdownShare } = evOfSemiBluff({
          pot,
          betSize,
          foldProbability: 0.5,
          equityWhenCalled,
        });
        if (delta < 0) assert.ok(showdownShare < 0, `pot ${pot}, bet ${betSize}: below the price`);
        else assert.ok(showdownShare > 0, `pot ${pot}, bet ${betSize}: above the price`);
      }
      const atPrice = evOfSemiBluff({ pot, betSize, foldProbability: 0.5, equityWhenCalled: price });
      closeTo(atPrice.showdownShare, 0, 'exactly at the price the showdown half is a wash');
      closeTo(atPrice.ev, atPrice.foldEquityShare, 'so the whole bet is worth its fold equity');
    }
  }
});

test('a semi-bluff explains both halves and the draw assumption', () => {
  const result = evOfSemiBluff({ pot: 100, betSize: 50, foldProbability: 0.4, equityWhenCalled: 0.3 });
  assert.ok(result.derivation.includes('fold equity'), 'the split must be visible in the derivation');
  assert.ok(result.derivation.includes('showdown'));
  assert.ok(
    result.assumptions.some((note) => note.includes('not the chance of hitting it on the next card')),
    'confusing equity with the chance of hitting is the classic error and must be headed off',
  );
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('negative chip amounts are rejected, with the expectation stated', () => {
  assert.throws(() => evOfCall({ pot: -1, toCall: 50, equity: 0.5 }), /pot must be 0 or more chips/);
  assert.throws(() => evOfCall({ pot: 100, toCall: -50, equity: 0.5 }), /toCall must be 0 or more chips/);
  assert.throws(
    () => evOfBet({ pot: -100, betSize: 50, foldProbability: 0.5, equityWhenCalled: 0.5 }),
    /pot must be 0 or more chips/,
  );
  assert.throws(
    () => evOfBet({ pot: 100, betSize: -50, foldProbability: 0.5, equityWhenCalled: 0.5 }),
    /betSize must be more than 0 chips/,
  );
  assert.throws(() => requiredFoldEquity({ pot: -1, betSize: 50, equityWhenCalled: 0 }), /0 or more chips/);
  assert.throws(() => breakEvenBluffFrequency(-1, 50), /0 or more chips/);
  assert.throws(() => breakEvenBluffFrequency(100, -50), /more than 0 chips/);
});

test('a bet of nothing is refused, because it is a check', () => {
  assert.throws(
    () => evOfBet({ pot: 100, betSize: 0, foldProbability: 0.5, equityWhenCalled: 0.5 }),
    /a bet of 0 is a check/,
  );
  assert.throws(
    () => requiredFoldEquity({ pot: 100, betSize: 0, equityWhenCalled: 0 }),
    /a bet of 0 is a check/,
  );
  assert.throws(() => breakEvenBluffFrequency(100, 0), /a bet of 0 is a check/);
  assert.throws(
    () => evOfSemiBluff({ pot: 100, betSize: 0, foldProbability: 0.5, equityWhenCalled: 0.5 }),
    /a bet of 0 is a check/,
  );
});

test('probabilities outside 0..1 are rejected rather than clamped', () => {
  assert.throws(() => evOfCall({ pot: 100, toCall: 50, equity: -0.1 }), /equity must be a probability/);
  assert.throws(() => evOfCall({ pot: 100, toCall: 50, equity: 1.1 }), /equity must be a probability/);
  assert.throws(
    () => evOfBet({ pot: 100, betSize: 50, foldProbability: 1.000001, equityWhenCalled: 0.5 }),
    /foldProbability must be a probability/,
  );
  assert.throws(
    () => evOfBet({ pot: 100, betSize: 50, foldProbability: -0.000001, equityWhenCalled: 0.5 }),
    /foldProbability must be a probability/,
  );
  assert.throws(
    () => evOfBet({ pot: 100, betSize: 50, foldProbability: 0.5, equityWhenCalled: 2 }),
    /equityWhenCalled must be a probability/,
  );
  assert.throws(
    () => requiredFoldEquity({ pot: 100, betSize: 50, equityWhenCalled: -1 }),
    /equityWhenCalled must be a probability/,
  );
  // The inclusive ends are legal: certainty in either direction is a real input.
  assert.doesNotThrow(() => evOfCall({ pot: 100, toCall: 50, equity: 0 }));
  assert.doesNotThrow(() => evOfCall({ pot: 100, toCall: 50, equity: 1 }));
  assert.doesNotThrow(() => evOfBet({ pot: 100, betSize: 50, foldProbability: 1, equityWhenCalled: 1 }));
});

test('non-finite inputs are rejected instead of producing NaN', () => {
  // Returning NaN would flow into the Coach report and be rendered as a figure.
  assert.throws(() => evOfCall({ pot: Number.NaN, toCall: 50, equity: 0.5 }), /pot must be a finite number/);
  assert.throws(
    () => evOfCall({ pot: 100, toCall: Number.NaN, equity: 0.5 }),
    /toCall must be a finite number/,
  );
  assert.throws(
    () => evOfCall({ pot: 100, toCall: 50, equity: Number.NaN }),
    /equity must be a finite number/,
  );
  assert.throws(
    () => evOfCall({ pot: Number.POSITIVE_INFINITY, toCall: 50, equity: 0.5 }),
    /pot must be a finite number/,
  );
  assert.throws(
    () =>
      evOfBet({ pot: 100, betSize: Number.POSITIVE_INFINITY, foldProbability: 0.5, equityWhenCalled: 0.5 }),
    /betSize must be a finite number/,
  );
  assert.throws(
    () => evOfBet({ pot: 100, betSize: 50, foldProbability: Number.NaN, equityWhenCalled: 0.5 }),
    /foldProbability must be a finite number/,
  );
  assert.throws(
    () => evOfSemiBluff({ pot: 100, betSize: 50, foldProbability: 0.5, equityWhenCalled: Number.NaN }),
    /equityWhenCalled must be a finite number/,
  );
  assert.throws(() => breakEvenBluffFrequency(Number.NaN, 50), /pot must be a finite number/);
  assert.throws(
    () => requiredFoldEquity({ pot: 100, betSize: Number.NEGATIVE_INFINITY, equityWhenCalled: 0 }),
    /betSize must be a finite number/,
  );
});

test('errors are named so a caller can tell a bad input from a bug', () => {
  assert.throws(
    () => evOfCall({ pot: -1, toCall: 1, equity: 0.5 }),
    (error: unknown) => error instanceof Error && error.name === 'EvError',
  );
});

test('no result ever contains a NaN or an unexplained figure', () => {
  // A sweep over every function, asserting the two things that must never reach the
  // UI: a non-finite number, and a figure with no words attached.
  for (const pot of POTS) {
    for (const betSize of BETS) {
      for (const equityWhenCalled of EQUITIES) {
        const breakdowns = [
          evOfFold(),
          evOfCall({ pot, toCall: betSize, equity: equityWhenCalled }),
          evOfBet({ pot, betSize, foldProbability: 0.37, equityWhenCalled }),
          evOfSemiBluff({ pot, betSize, foldProbability: 0.37, equityWhenCalled }),
        ];
        for (const breakdown of breakdowns) {
          assert.ok(Number.isFinite(breakdown.ev), `non-finite ev at pot ${pot}, bet ${betSize}`);
          assert.ok(breakdown.derivation.length > 0, 'every figure carries its derivation');
          assert.ok(breakdown.assumptions.length > 0, 'every figure carries its assumptions');
          for (const term of breakdown.terms) {
            assert.ok(Number.isFinite(term.probability) && Number.isFinite(term.contribution));
            assert.ok(term.label.length > 0, 'every branch is named');
          }
        }
        const solved = requiredFoldEquity({ pot, betSize, equityWhenCalled });
        assert.ok(Number.isFinite(solved.foldEquityNeeded), 'non-finite required fold equity');
        assert.ok(solved.explanation.length > 0);
        assert.ok(solved.assumptions.length > 0);
        const alpha = breakEvenBluffFrequency(pot, betSize);
        assert.ok(Number.isFinite(alpha.frequency));
        assert.ok(alpha.explanation.length > 0);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Raise
// ---------------------------------------------------------------------------

/**
 * The EV of raising, derived here from the definitions and NOT from `ev.ts`.
 *
 * Facing `c` with `pot` in the middle (the `c` they bet is already part of `pot`) and
 * raising by `r`:
 *
 *   * they fold, probability `f`: you win what is there, `pot`. Your own `c + r` comes
 *     straight back out of the pot you take down, so the net swing is `pot`.
 *   * they call, probability `1 - f`: they add `r` and nothing else, because their `c`
 *     is already in. The pot at showdown is `pot + (c + r) + r`, of which `c + r` was
 *     yours. Win a share `e` of it and the net is `pot + r`; otherwise you are out the
 *     `c + r` you put in.
 *
 * so
 *
 *     EV = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ]
 */
function evOfRaiseByHand(pot: number, toCall: number, raiseBy: number, f: number, e: number): number {
  return f * pot + (1 - f) * (e * (pot + toCall + 2 * raiseBy) - (toCall + raiseBy));
}

test('EV of a raise matches arithmetic done by hand', () => {
  // 400 in the middle, 300 to call, raising by 350. Risk is 300 + 350 = 650 and the pot
  // at showdown is 400 + 300 + 700 = 1400.
  //
  //   EV = 0.35 x 400 + 0.65 x [ 0.2 x 1400 - 650 ]
  //      = 140 + 0.65 x (280 - 650)
  //      = 140 + 0.65 x (-370) = 140 - 240.5 = -100.5
  const raise = evOfRaise({
    pot: 400,
    toCall: 300,
    raiseBy: 350,
    foldProbability: 0.35,
    equityWhenCalled: 0.2,
  });
  closeTo(raise.ev, -100.5, 'EV of raising 300 to 650 with a fifth of the pot');
  assert.equal(raise.risk, 650, 'the risk is the call plus the raise, not the raise alone');
  assert.match(raise.derivation, /Risks 650 to win 400/);
});

test('a raise with nothing to call is exactly a bet, and the two agree everywhere', () => {
  // The reason there is one function per action rather than one function pretending to
  // cover both: with c = 0 the raise formula collapses onto the bet formula, so the
  // difference between them is entirely the call — which is the term that went missing.
  for (const pot of POTS) {
    for (const betSize of BETS) {
      for (const equityWhenCalled of EQUITIES) {
        for (const foldProbability of [0, 0.35, 1]) {
          const asBet = evOfBet({ pot, betSize, foldProbability, equityWhenCalled });
          const asRaise = evOfRaise({
            pot,
            toCall: 0,
            raiseBy: betSize,
            foldProbability,
            equityWhenCalled,
          });
          closeTo(asRaise.ev, asBet.ev, `pot ${pot}, size ${betSize}, e ${equityWhenCalled}`);
          closeTo(asRaise.risk, betSize, 'with nothing to call the risk is the bet');
        }
      }
    }
  }
});

test('charging the call is worth exactly (1 - f) x c x (1 - e), and always costs the raiser', () => {
  // The size of the defect this function exists to remove, as an identity rather than a
  // single number. Pricing a raise with the bet formula overstates it by this much: it is
  // never negative, it grows with the bet faced, and it grows as equity FALLS — so the
  // figure was most wrong exactly where a learner most needs it right.
  for (const pot of POTS) {
    for (const toCall of [1, 25, 100, 333]) {
      for (const raiseBy of [1, 50, 250]) {
        for (const equityWhenCalled of EQUITIES) {
          for (const foldProbability of [0, 0.35, 0.8, 1]) {
            const raise = evOfRaise({ pot, toCall, raiseBy, foldProbability, equityWhenCalled });
            const asOpeningBet = evOfBet({ pot, betSize: raiseBy, foldProbability, equityWhenCalled });
            const overstatement = (1 - foldProbability) * toCall * (1 - equityWhenCalled);

            closeTo(
              raise.ev,
              evOfRaiseByHand(pot, toCall, raiseBy, foldProbability, equityWhenCalled),
              'closed form',
            );
            closeTo(asOpeningBet.ev - raise.ev, overstatement, `pot ${pot}, c ${toCall}, r ${raiseBy}`);
            assert.ok(
              asOpeningBet.ev - raise.ev >= -TOLERANCE,
              'pricing a raise as an opening bet can never understate it',
            );
          }
        }
      }
    }
  }
});

test('a raise is worth less than a bet risking the same chips, by (1 - f) x e x c', () => {
  // Why the two are different actions and not two names for one: part of a raiser's risk
  // is money the opponent does not have to match, so the pot it plays for is smaller than
  // the pot a bet of the same size plays for. The gap vanishes at zero equity — with
  // nothing to win at showdown, only the fold branch matters — and grows with it.
  for (const pot of [40, 100, 1000]) {
    for (const risk of [100, 400]) {
      for (const toCall of [10, 50, 99]) {
        for (const equityWhenCalled of EQUITIES) {
          const foldProbability = 0.4;
          const raise = evOfRaise({
            pot,
            toCall,
            raiseBy: risk - toCall,
            foldProbability,
            equityWhenCalled,
          });
          const bet = evOfBet({ pot, betSize: risk, foldProbability, equityWhenCalled });
          closeTo(
            bet.ev - raise.ev,
            (1 - foldProbability) * equityWhenCalled * toCall,
            `pot ${pot}, risk ${risk}`,
          );
          assert.equal(raise.risk, risk, 'both actions risk the same chips');
        }
      }
    }
  }
});

test('the raise endpoints hold: always folding wins the pot, never folding is a call', () => {
  const pot = 250;
  const toCall = 80;
  const raiseBy = 120;
  const equityWhenCalled = 0.42;

  // f = 1: they always fold. You win what is in the middle and your own chips come back.
  const alwaysFolds = evOfRaise({ pot, toCall, raiseBy, foldProbability: 1, equityWhenCalled });
  closeTo(alwaysFolds.ev, pot, 'a raise nobody ever calls is worth exactly the pot');

  // f = 0: they always call, which is a call of `c + r` into a pot of `pot + r`.
  const neverFolds = evOfRaise({ pot, toCall, raiseBy, foldProbability: 0, equityWhenCalled });
  const asCall = evOfCall({ pot: pot + raiseBy, toCall: toCall + raiseBy, equity: equityWhenCalled });
  closeTo(neverFolds.ev, asCall.ev, 'a raise that always gets called is a call into the bigger pot');
});

test("a raise's branches are a probability distribution and account for all of its EV", () => {
  for (const pot of POTS) {
    for (const toCall of [0, 20, 175]) {
      for (const raiseBy of BETS) {
        for (const equityWhenCalled of EQUITIES) {
          const raise = evOfRaise({
            pot,
            toCall,
            raiseBy,
            foldProbability: 0.31,
            equityWhenCalled,
          });
          closeTo(
            sum(raise.terms.map((term) => term.probability)),
            1,
            `branch probabilities at pot ${pot}, c ${toCall}, r ${raiseBy}`,
          );
          closeTo(
            sum(raise.terms.map((term) => term.contribution)),
            raise.ev,
            `contributions at pot ${pot}, c ${toCall}, r ${raiseBy}`,
          );
          assert.ok(raise.assumptions.length > 0, 'every figure carries its assumptions');
          assert.ok(
            raise.assumptions.some((note) => note.includes('part of the cost of raising')),
            'the assumptions must say that the call is part of the risk',
          );
        }
      }
    }
  }
});

test('a raise rejects the inputs that would make it meaningless', () => {
  const base = { pot: 100, toCall: 50, raiseBy: 100, foldProbability: 0.3, equityWhenCalled: 0.4 };
  assert.throws(() => evOfRaise({ ...base, raiseBy: 0 }), /more than 0 chips/);
  assert.throws(() => evOfRaise({ ...base, raiseBy: -1 }), /more than 0 chips/);
  assert.throws(() => evOfRaise({ ...base, toCall: -1 }), /0 or more chips/);
  assert.throws(() => evOfRaise({ ...base, pot: Number.NaN }), /finite number/);
  assert.throws(() => evOfRaise({ ...base, foldProbability: 1.2 }), /probability from 0 to 1/);
  assert.throws(() => evOfRaise({ ...base, equityWhenCalled: -0.1 }), /probability from 0 to 1/);
});

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

test('a check is worth e x pot, which is never below a fold and only ever ties it at zero', () => {
  // Folding is the zero point. Checking is not: it costs nothing AND keeps the hand, so
  // it keeps a claim on what is already in the middle. Pricing it at a literal 0 — which
  // the Coach did — makes the two look identical and lets a tool recommend giving up a
  // hand it could see for free.
  //
  // Worked by hand: 39.49% of a 100 pot is 39.49 chips. Every figure below is that shape.
  for (const [pot, equity, expected] of [
    [100, 0.3949, 39.49],
    [140, 0, 0],
    [0, 0.9, 0],
    [250, 1, 250],
  ] as const) {
    const check = evOfCheck({ pot, equity });
    closeTo(check.ev, expected, `EV(check) with pot ${pot} at ${equity}`);

    // A check is a call priced at nothing, so the two must agree exactly rather than
    // approximately: there is one formula, and `evOfCheck` delegates to it.
    assert.equal(check.ev, evOfCall({ pot, toCall: 0, equity }).ev, 'a check is a free call');

    // Never worse than folding, and equal only when there is nothing to keep a claim on.
    assert.ok(check.ev >= evOfFold().ev, 'a check is never worth less than a fold');
    assert.equal(check.ev === 0, pot === 0 || equity === 0);

    // The terms regroup into the same figure, and the losing branch costs nothing —
    // which is the whole difference between this and a call.
    const summed = check.terms.reduce((total, term) => total + term.contribution, 0);
    closeTo(summed, check.ev, 'the terms sum to the EV');
    assert.equal(check.terms[1]?.value, 0, 'losing a checked pot costs no further chips');
    assert.ok(check.assumptions.length > 0, 'a figure never travels without its assumptions');
  }
});
