/**
 * A learner all-in for less than the bet is priced against the pot they can win, not the whole
 * middle. Heads-up 5/10, hero 40, villain shoving 310: hero can win 80, 30 of it hero's own call,
 * so the price is 30 into 50 (37.5% to break even). Priced against the whole middle the Coach
 * published 8.6% and recommended a call worth -4.23 chips, and `judgeConsistency` graded the
 * correct fold as wrong. `packages/poker-engine/test/invariants.test.ts` holds the fuzz sweep.
 * Spots are built through `startHand` / `applyAction` / `redactFor`, because the defect sat at the
 * engine-to-Coach boundary. Each case also builds the whole-middle report and asserts the pair.
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
import { LIVE_COACH_POLICY } from '../src/coach-view.ts';
import { judgeConsistency } from '../src/consistency.ts';
import { topPercentRange } from '../src/hand-ranking.ts';
import { parseRange } from '../src/ranges.ts';

const SAMPLES = 20_000;
const SEED = 1;
const BIG_BLIND = 10;

/** The range the live Coach assumes when nobody names one. */
const ASSUMED_RANGE_PERCENT = LIVE_COACH_POLICY.range.percent;

interface Spot {
  readonly view: PlayerView;
  readonly own: SeatView;
  readonly opponents: readonly SeatView[];
}

/**
 * Deals one hand, applies the actions, and returns hero's redacted view, the boundary the live
 * Coach reads.
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
 * The Coach input the socket builds from a view. `contestablePot` is a parameter so one view can
 * produce both the honest report and the whole-middle one.
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

/** Hero 40 in the big blind, villain shoving 310. The reproduction, rebuilt. */
function headsUpAllInForLess(): Spot {
  // Heads-up the button is the small blind and acts first, so seat 0 shoves into hero's blind.
  return spotFrom([310, 40], [{ seat: 0, action: 'raise', to: 310 }], 'hero', SEED);
}

test('a hero all-in for less is priced against the pot they can win, not the whole middle', () => {
  const spot = headsUpAllInForLess();

  // What the engine says first, so the rest is about a real spot.
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

  // 30 to win 50: 50 / 30 = 1.666..., and 30 / (50 + 30) = 0.375.
  assert.equal(report.potOdds.pot, 50, 'the price is quoted against the pot hero can win');
  assert.equal(report.potOdds.breakEvenEquity, 0.375);
  assert.equal(report.potOdds.oddsRatio, 5 / 3);
  assert.equal(report.potTotal, 320, 'the whole middle is still published, so both figures are available');

  // EV(call) = equity x contestable - (1 - equity) x toCall, longhand from the report's own equity.
  const equity = report.equity.heroEquity;
  assert.ok(Math.abs(evOf(report, 'call') - (equity * 50 - (1 - equity) * 30)) < 1e-9);

  // The prose names the side pot, so a reader can reconcile 50 with the 320 in front of them.
  const prose = [report.potOdds.explanation, ...report.teachingNotes].join(' ');
  assert.match(prose, /1\.67 to 1/);
  assert.match(prose, /37\.5%/);
  assert.match(prose, /side pot/);
  assert.match(prose, /270/);
  assert.match(prose, /320/);

  // The same report built against the whole middle, for comparison.
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
  // `judgeConsistency` writes `scenario_attempts.matched_expected` from the candidate table, so a
  // mispriced call records a correct fold as wrong.
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

test('multiway, every opponent beyond reach is subtracted, not just the largest', () => {
  // Three-handed, 5/10. Seat 0 shoves 300, seat 1 calls all-in for 100, hero has 40 in the big blind.
  // Side pots of 120 (seats 0, 1) and 200 (seat 0). Subtracting only seat 0's excess would quote the
  // price against 150, not 90, so the excess is a sum over opponents.
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

  // The single-subtraction reading, `pot - (toCall - heroStack)`, leaves 110, not 90.
  const singleSubtraction = spot.view.potTotal - (300 - spot.own.committedThisStreet - spot.own.stack);
  assert.notEqual(singleSubtraction, share.contestable);
});

test('a hero who covers the bet sees no change at all, and none can be introduced', () => {
  // Heads-up, both 1000 deep, seat 0 raising to 100. Hero covers, so every chip in the middle is
  // winnable.
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

  // A caller that subtracts a side pot where there is none is refused. A too-small pot overstates
  // the equity a call needs and looks conservative, so nothing else would catch it.
  assert.throws(
    () => buildCoachReport(inputFor(spot, share.contestable - 1)),
    /cover the 90 owed out of 990 behind/,
  );
});
