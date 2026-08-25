/**
 * A learner all-in for less than the bet is priced against the pot they can win.
 *
 * ## The defect, measured through the real engine before it was fixed
 *
 * Heads-up, 5/10, hero holding 40 and villain shoving 310. The engine's own view:
 *
 *     PlayerView          potTotal 320   amountToCall 30   legalActions fold, call
 *     pot layers (post-call)             80 chips eligible [0,1]   270 chips eligible [1]
 *
 * Hero can win 80, of which 30 is hero's own call, so the price is 30 into 50 — 1.67 to 1,
 * 37.5% to break even. What the Coach published:
 *
 *     "The pot is laying you 10.7 to 1, so you need 8.6% to break even on a call"
 *     EV(call) = +82.76        suggestion: call        (at 32.2% equity)
 *
 * The requirement was understated 4.4x and a call worth **-4.23 chips** was headlined as the
 * recommendation. `toCall` was already capped at hero's stack — the bug was never the price hero
 * pays, it was the pot hero was told they were paying it into.
 *
 * It corrupted grading with it. `judgeConsistency` on that same report, for a learner who folds —
 * the correct action — returned `consistent: false` with `shortfallUnits: 82.76` and
 * `supportedActions: ['call']`, and `matched_expected: false` went to `scenario_attempts`. A
 * learner who played correctly was recorded as wrong, which is the exact failure `consistency.ts`
 * says in its own header that it exists to prevent.
 *
 * Over 4,000 fuzzed hands at mixed depths and 2-6 seats, 5,793 decision points had a call the
 * engine capped and 5,650 of those left chips beyond hero's reach; the worst understated the
 * equity a call needs by 271x. `packages/poker-engine/test/invariants.test.ts` is where that
 * sweep lives and where it is asserted to be non-empty.
 *
 * ## Why these tests build hands rather than object literals
 *
 * Every figure below comes from `startHand` / `applyAction` / `redactFor`, because the defect was
 * a disagreement between what the engine knew and what the Coach was told. A test that hand-writes
 * both sides of that boundary can only ever confirm its own arithmetic. The one thing written by
 * hand is the price — `30 / (50 + 30) = 37.5%` is arithmetic a reader can check without running
 * anything, and it is asserted as a literal.
 *
 * ## The old behaviour is exercised here, not just described
 *
 * `contestablePot` is a required input, and in a capped spot `toCall === heroStack`, so passing
 * the whole middle is a thing a caller could still do. Each case below builds the same report
 * both ways and asserts the pair, so the defect is a live comparison rather than a comment about
 * one. (`validate` refuses that same substitution wherever hero *can* cover the bet — see the last
 * test, which is the guard against a caller subtracting a side pot that does not exist.)
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyAction,
  contestablePotFor,
  createDeterministicRandomForTests,
  type PlayerView,
  redactFor,
  type SeatView,
  startHand,
} from '@prl/poker-engine';
import { buildCoachReport, type CoachInput } from '../src/coach.ts';
import { judgeConsistency } from '../src/consistency.ts';
import { topPercentRange } from '../src/hand-ranking.ts';
import { parseRange } from '../src/ranges.ts';

const SAMPLES = 20_000;
const SEED = 1;
const BIG_BLIND = 10;

/** The range the live Coach assumes when nobody names one. */
const ASSUMED_RANGE_PERCENT = 40;

interface Spot {
  readonly view: PlayerView;
  readonly own: SeatView;
  readonly opponents: readonly SeatView[];
}

/**
 * Deals one hand, applies the given actions, and returns hero's own redacted view.
 *
 * The view is the boundary the live Coach reads: `potTotal`, `amountToCall`, every seat's street
 * commitment and status, and the engine's own `legalActions`.
 */
function spotFrom(
  stacks: readonly number[],
  actions: readonly {
    readonly seat: number;
    readonly action: 'call' | 'fold' | 'raise';
    readonly to?: number;
  }[],
  heroPlayerId: string,
  seed: number,
): Spot {
  const started = startHand({
    handId: `side-pot-${seed}`,
    roomId: 'side-pot',
    handNumber: 1,
    config: {
      smallBlind: 5,
      bigBlind: BIG_BLIND,
      ante: 0,
      maxSeats: stacks.length,
      actionTimeoutSeconds: 30,
    },
    buttonSeat: 0,
    seats: stacks.map((stack, seat) => ({
      seat,
      playerId: seat === stacks.length - 1 ? 'hero' : `v${seat}`,
      stack,
    })),
    random: createDeterministicRandomForTests(seed),
  });
  let state = started.state;
  for (const step of actions) {
    state =
      step.action === 'raise'
        ? applyAction(state, step.seat, { type: 'raise', to: step.to ?? 0 }).state
        : applyAction(state, step.seat, { type: step.action }).state;
  }
  const view = redactFor(state, { viewerPlayerId: heroPlayerId });
  const own = view.seats.find((seat) => seat.isSelf);
  assert.ok(own !== undefined && own.holeCards !== null, 'hero has no cards in this view');
  const opponents = view.seats.filter(
    (seat) => !seat.isSelf && (seat.status === 'active' || seat.status === 'allIn'),
  );
  return { view, own, opponents };
}

/**
 * The Coach input the socket builds from a view, with the contestable pot as a parameter.
 *
 * `contestablePot` is passed in rather than computed here so that one call site can produce both
 * the honest report and the one the defect produced, from the same view and the same seed.
 */
function inputFor(spot: Spot, contestablePot: number): CoachInput {
  const blockers = [...(spot.own.holeCards ?? []), ...spot.view.board];
  const range = parseRange(topPercentRange(ASSUMED_RANGE_PERCENT).notation, blockers);
  const street = spot.view.street;
  assert.ok(street !== 'showdown' && street !== 'complete', 'no decision to analyse');
  return {
    heroCards: spot.own.holeCards ?? [],
    board: spot.view.board,
    street,
    opponents: spot.opponents.map((seat) => ({ label: `seat ${seat.seat}`, range })),
    pot: spot.view.potTotal,
    contestablePot,
    toCall: spot.view.amountToCall,
    heroCommittedThisStreet: spot.own.committedThisStreet,
    heroStack: spot.own.stack,
    opponentStacks: spot.opponents.map((seat) => seat.stack),
    bigBlind: spot.view.config.bigBlind,
    minimumRaiseTo: spot.view.minimumRaiseTo,
    legalActions: spot.view.legalActions.map((entry) => entry.type),
    samples: SAMPLES,
    seed: SEED,
  };
}

function shareOf(spot: Spot): { readonly contestable: number; readonly uncontestable: number } {
  const share = contestablePotFor({
    seats: spot.view.seats,
    heroSeat: spot.own.seat,
    callAmount: spot.view.amountToCall,
    potTotal: spot.view.potTotal,
  });
  return { contestable: share.contestable, uncontestable: share.uncontestable };
}

function evOf(
  report: { readonly candidates: readonly { readonly action: string; readonly ev: number }[] },
  action: string,
): number {
  const candidate = report.candidates.find((entry) => entry.action === action);
  assert.ok(candidate !== undefined, `the report priced no ${action}`);
  return candidate.ev;
}

// ---------------------------------------------------------------------------
// Heads-up: the spot the defect was reproduced on
// ---------------------------------------------------------------------------

/** Hero 40 in the big blind, villain shoving 310. The reproduction, rebuilt. */
function headsUpAllInForLess(): Spot {
  // Heads-up the button is the small blind and acts first, so seat 0 shoves into hero's blind.
  return spotFrom([310, 40], [{ seat: 0, action: 'raise', to: 310 }], 'hero', SEED);
}

test('a hero all-in for less is priced against the pot they can win, not the whole middle', () => {
  const spot = headsUpAllInForLess();

  // What the engine says, first, so the rest is a claim about a real spot rather than about
  // numbers this file invented.
  assert.equal(spot.view.potTotal, 320, 'the middle');
  assert.equal(spot.view.amountToCall, 30, 'the call, already capped at the stack by the engine');
  assert.deepEqual(
    spot.view.legalActions.map((entry) => entry.type),
    ['fold', 'call'],
    'the engine offers exactly fold and call',
  );

  const share = shareOf(spot);
  assert.equal(share.contestable, 50, 'hero can win an 80-chip main pot, 30 of which is the call itself');
  assert.equal(share.uncontestable, 270, 'the side pot only villain is in');

  const report = buildCoachReport(inputFor(spot, share.contestable));

  // 30 to win 50. Worked out by hand: 50 / 30 = 1.666..., and 30 / (50 + 30) = 0.375.
  assert.equal(report.potOdds.pot, 50, 'the price is quoted against the pot hero can win');
  assert.equal(report.potOdds.breakEvenEquity, 0.375);
  assert.equal(report.potOdds.oddsRatio, 5 / 3);
  assert.equal(report.potTotal, 320, 'the whole middle is still published, so both figures are available');

  // EV(call) = equity x contestable - (1 - equity) x toCall, longhand from the report's own equity.
  const equity = report.equity.heroEquity;
  assert.ok(Math.abs(evOf(report, 'call') - (equity * 50 - (1 - equity) * 30)) < 1e-9);

  // The prose moves with the number, and names the side pot rather than leaving a reader to
  // reconcile "50 in the middle" with the 320 in front of them.
  const prose = [report.potOdds.explanation, ...report.teachingNotes].join(' ');
  assert.match(prose, /1\.67 to 1/);
  assert.match(prose, /37\.5%/);
  assert.match(prose, /side pot/);
  assert.match(prose, /270/);
  assert.match(prose, /320/);

  // ---- and the same report built the old way, which is what the numbers above replace ----
  const asItWas = buildCoachReport(inputFor(spot, spot.view.potTotal));
  assert.equal(asItWas.potOdds.pot, 320);
  assert.equal(asItWas.potOdds.breakEvenEquity, 30 / 350, 'the defect: 8.57%, understating 37.5% by 4.4x');
  assert.ok(
    report.potOdds.breakEvenEquity / asItWas.potOdds.breakEvenEquity > 4,
    'the two prices must not be within rounding of each other, or this test proves nothing',
  );
  assert.ok(evOf(asItWas, 'call') > 80, 'the defect priced this call at about +83 chips');
  assert.ok(evOf(report, 'call') < 0, 'it is a losing call');
  assert.equal(asItWas.suggestion.action, 'call', 'the defect headlined the losing call');
  assert.equal(report.suggestion.action, 'fold');
});

test('a correct fold is no longer graded as a large error', () => {
  // `judgeConsistency` is what writes `scenario_attempts.matched_expected`. Its verdict is a
  // function of the report's candidate table, so a mispriced call becomes a wrong answer recorded
  // against a learner who played correctly.
  const spot = headsUpAllInForLess();
  const share = shareOf(spot);

  const honest = judgeConsistency({
    report: buildCoachReport(inputFor(spot, share.contestable)),
    action: 'fold',
    bigBlind: BIG_BLIND,
  });
  assert.equal(honest.consistent, true, 'folding here is correct and must be recorded as consistent');
  assert.equal(honest.shortfallUnits, 0);
  assert.ok(honest.supportedActions.includes('fold'));

  const asItWas = judgeConsistency({
    report: buildCoachReport(inputFor(spot, spot.view.potTotal)),
    action: 'fold',
    bigBlind: BIG_BLIND,
  });
  assert.equal(asItWas.consistent, false, 'the defect marked the correct fold inconsistent');
  assert.ok(asItWas.shortfallUnits > 80, `the defect scored it ${asItWas.shortfallUnits} chips behind`);
  assert.deepEqual(asItWas.supportedActions, ['call']);
});

// ---------------------------------------------------------------------------
// Multiway: the excess is a sum over opponents, not one subtraction
// ---------------------------------------------------------------------------

test('multiway, every opponent beyond reach is subtracted, not just the largest', () => {
  // Three-handed, 5/10. Seat 0 has 300 and shoves, seat 1 has 100 and calls all-in, hero has 40 in
  // the big blind. That is two side pots: 120 for seats 0 and 1, and 200 for seat 0 alone.
  //
  // Subtracting only seat 0's excess above hero's 40 would leave seat 1's 60 in the pot and quote
  // a price against 150 rather than 90 — which is why this case exists and why the arithmetic is
  // a sum rather than one `pot - (toCall - heroStack)`.
  const spot = spotFrom(
    [300, 100, 40],
    [
      { seat: 0, action: 'raise', to: 300 },
      { seat: 1, action: 'call' },
    ],
    'hero',
    9,
  );

  assert.equal(spot.view.potTotal, 410);
  assert.equal(spot.view.amountToCall, 30);

  const share = shareOf(spot);
  // Hero's cap is 40. min(300,40) + min(100,40) + min(40,40) = 120, less hero's own 30 = 90.
  assert.equal(share.contestable, 90);
  assert.equal(share.uncontestable, 320, 'a 120-chip side pot and a 200-chip one, added');

  const report = buildCoachReport(inputFor(spot, share.contestable));
  // 30 to win 90. 90 / 30 = 3, and 30 / (90 + 30) = 0.25.
  assert.equal(report.potOdds.pot, 90);
  assert.equal(report.potOdds.oddsRatio, 3);
  assert.equal(report.potOdds.breakEvenEquity, 0.25);
  assert.match([report.potOdds.explanation, ...report.teachingNotes].join(' '), /320/);

  const asItWas = buildCoachReport(inputFor(spot, spot.view.potTotal));
  assert.equal(asItWas.potOdds.breakEvenEquity, 30 / 440, 'the defect: 6.8%, understating 25% by 3.7x');

  // The "one subtraction" answer a heads-up-only fix would have produced, stated so that a future
  // simplification to `pot - (toCall - heroStack)` fails here instead of shipping. Hero's stack is
  // 30 and the bet is 300, so that reading leaves 110 in the pot, not 90.
  const singleSubtraction = spot.view.potTotal - (300 - spot.own.committedThisStreet - spot.own.stack);
  assert.notEqual(singleSubtraction, share.contestable);
});

// ---------------------------------------------------------------------------
// The ordinary spot: nothing moves
// ---------------------------------------------------------------------------

test('a hero who covers the bet sees no change at all, and none can be introduced', () => {
  // Heads-up, both 1000 deep, seat 0 raising to 100 preflop. Hero owes 90 out of 990 behind, so
  // every chip in the middle is one hero can win and every figure is what it always was.
  const spot = spotFrom([1_000, 1_000], [{ seat: 0, action: 'raise', to: 100 }], 'hero', 3);
  assert.equal(spot.view.potTotal, 110);
  assert.equal(spot.view.amountToCall, 90);

  const share = shareOf(spot);
  assert.equal(share.contestable, 110, 'the whole middle');
  assert.equal(share.uncontestable, 0);

  const report = buildCoachReport(inputFor(spot, share.contestable));
  assert.equal(report.potOdds.pot, report.potTotal, 'the two pots are the same pot here');
  // 90 / (110 + 90) = 0.45, and 110 / 90 = 1.222...
  assert.equal(report.potOdds.breakEvenEquity, 0.45);
  assert.equal(report.potOdds.oddsRatio, 110 / 90);
  const equity = report.equity.heroEquity;
  assert.ok(Math.abs(evOf(report, 'call') - (equity * 110 - (1 - equity) * 90)) < 1e-9);
  assert.doesNotMatch(
    [report.potOdds.explanation, ...report.teachingNotes].join(' '),
    /side pot/,
    'there is no side pot here, so nothing may say there is',
  );

  // The guard: a caller that subtracts a side pot in a spot that has none is refused rather than
  // quietly publishing a price against a smaller pot. This is the direction the fix could have
  // gone wrong in, and it is the one nothing else would have caught — a too-small pot overstates
  // the equity a call needs, and looks conservative rather than broken.
  assert.throws(
    () => buildCoachReport(inputFor(spot, share.contestable - 1)),
    /cover the 90 owed out of 990 behind/,
  );
});
