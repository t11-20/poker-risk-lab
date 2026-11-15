/**
 * An opponent who is all in cannot fold, and wins only the chips its stack reached. River, board
 * Ks 9d 5c 2h 2s, so every share below is 0 or 1 and every figure is worked by hand: A holds aces,
 * B queens, and hero either 76 (worst) or KQ (beats B, loses to A). The assumed fold rate is 0.35.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyAction,
  createDeterministicRandomForTests,
  type HandState,
  parseCards,
  redactFor,
  startHand,
} from '@prl/poker-engine';
import { buildCoachReport, type CoachInput, type OpponentStack } from '../src/coach.ts';
import { coachInputFor, coachSpotForView, LIVE_COACH_POLICY } from '../src/coach-view.ts';
import { exactRange, parseRange } from '../src/ranges.ts';
import { repriceAtFoldEquity } from '../src/reprice.ts';

const ACES = { label: 'A', range: exactRange(parseCards('As Ah')) };
const QUEENS = { label: 'B', range: exactRange(parseCards('Qc Qd')) };
// Against KcQh on this board: JJ (6 combos) and QQ (3) lose, 99 (3) and 55 (3) make a full house. 9/15.
const SIXTY = { label: 'B', range: parseRange('JJ,QQ,99,55', parseCards('Kc Qh Ks 9d 5c 2h 2s')) };

function river(hero: string, spot: Partial<CoachInput> & { opponentStacks: readonly OpponentStack[] }) {
  const pot = spot.pot ?? 300;
  return buildCoachReport({
    heroCards: parseCards(hero),
    board: parseCards('Ks 9d 5c 2h 2s'),
    street: 'river',
    opponents: [ACES, QUEENS],
    pot,
    contestablePot: pot,
    toCall: 0,
    heroCommittedThisStreet: 0,
    heroStack: 900,
    bigBlind: 10,
    ...spot,
  });
}

/** A all in preflop for 100, B and hero matched it, and nobody has bet since. */
const ALL_IN_PREFLOP: readonly OpponentStack[] = [
  { behind: 0, committedThisStreet: 0, winnable: 300 },
  { behind: 900, committedThisStreet: 0, winnable: 300 },
];

function evAt(report: ReturnType<typeof buildCoachReport>, action: string, to?: number): number {
  const row = report.candidates.find(
    (entry) => entry.action === action && (to === undefined || entry.to === to),
  );
  assert.ok(row !== undefined, `no ${action} ${to ?? ''} row`);
  return row.ev;
}

function near(actual: number, expected: number, what: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: expected ${expected}, got ${actual}`);
}

test('worst hand: a fold by B still leaves the main pot to A, so a bet has no fold equity', () => {
  // B folds: hero shows down with A for 300 and loses, worth 0. Called: main 300 and side 2b, both
  // lost, so -b. EV = 0.35 x 0 + 0.65 x (-b) = -0.65b. The whole-field reading was 105 - 0.65b.
  const report = river('7c 6c', { opponentStacks: ALL_IN_PREFLOP });
  near(evAt(report, 'bet', 150), -97.5, 'bet 150');
  near(evAt(report, 'bet', 900), -585, 'all in');
  near(evAt(report, 'bet', 10), -6.5, 'minimum bet');
  near(evAt(report, 'check'), 0, 'check');
  assert.equal(report.suggestion.action, 'check');
  const prose = [report.suggestion.reason, ...report.assumptions].join(' ');
  assert.doesNotMatch(prose, /wins uncontested/, 'the main pot can never be won uncontested here');
  assert.doesNotMatch(prose, /fold more than/, 'no bet is set aside on the fold rate');
  // Folding everyone who can gains nothing, so the ½-pot bet cannot break even at any rate.
  assert.match(prose, /cannot break even at any fold frequency/);
  assert.match(prose, /all in and cannot fold/);
});

test('hero beats only B: a call is worth the side pot, and a fold by B gives it up', () => {
  // B folds: hero loses the 300 main pot to A, worth 0. Called: main lost, side 2b won, less b, so +b.
  // EV = 0.65b, highest at the all-in, 585. Always called it is +900, so it is not a fold-rate line.
  const report = river('Kc Qh', { opponentStacks: ALL_IN_PREFLOP });
  near(evAt(report, 'bet', 900), 585, 'all in');
  near(evAt(report, 'bet', 150), 97.5, 'bet 150');
  near(evAt(report, 'check'), 0, 'check: the 300 main pot goes to A');
  assert.equal(report.suggestion.action, 'bet');
  assert.deepEqual(report.suggestion.sizeRange, { min: 900, max: 900 });
  assert.match(report.suggestion.whatWouldChangeIt.join(' '), /folds more often makes it worse/);
  assert.doesNotMatch(report.suggestion.whatWouldChangeIt.join(' '), /folds less often makes it worse/);
  // The Lab's fold slider rebuilds a row from one share, which two pots do not have.
  assert.equal(repriceAtFoldEquity(report, 0.5).kind, 'unavailable');
});

test('a side pot already in the middle is priced against the players in it', () => {
  // A all in preflop for 50: main pot 150. B and hero then put 100 each on the flop: side pot 200.
  // KQ loses the main pot to A and wins the side pot from B.
  const stacks: readonly OpponentStack[] = [
    { behind: 0, committedThisStreet: 0, winnable: 150 },
    { behind: 850, committedThisStreet: 0, winnable: 350 },
  ];
  const checked = river('Kc Qh', { pot: 350, heroStack: 850, opponentStacks: stacks });
  near(evAt(checked, 'check'), 200, 'check wins the side pot');
  // B folds: main lost, side 200 won uncontested. Called: 200 + 2b won, less b. 0.35 x 200 +
  // 0.65 x (200 + 850) = 752.5 for the 850 all in.
  near(evAt(checked, 'bet', 850), 752.5, 'all in');

  // Facing B's 100, hero's call joins the side pot, because A is capped at 50: 200 + 100 + 100 won,
  // less the 100 put in, +300. The whole-field reading was 0 x 550 - 100 = -100.
  const facing = river('Kc Qh', {
    pot: 450,
    toCall: 100,
    heroStack: 850,
    opponentStacks: [
      { behind: 0, committedThisStreet: 0, winnable: 150 },
      { behind: 750, committedThisStreet: 100, winnable: 450 },
    ],
  });
  near(evAt(facing, 'call'), 300, 'call');
  const call = facing.candidates.find((entry) => entry.action === 'call');
  assert.equal(call?.potShareIfCalled, undefined, 'no single share describes two pots');
  // 0% against the whole table is 18.2 points short of the price, beside a +300 call.
  assert.doesNotMatch(facing.potOdds.explanation, /You do not clear that/);
  assert.match(facing.potOdds.explanation, /does not price this call/);
});

test('the whole-field model stands when nobody is all in, three-way, one seat yet to act', () => {
  // Button raises to 30, the small blind (hero) is to act with 5 in, the big blind has 10 in. The
  // engine's layers cut the big blind out of the top 20 until it calls, so a seat with chips behind
  // is never read off them. Every raise is f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ].
  const view = viewAfter([1_000, 1_000, 1_000], [{ seat: 0, to: 30 }], 'v1', 4);
  const reading = coachSpotForView(view, LIVE_COACH_POLICY);
  assert.ok(reading.kind === 'spot');
  assert.deepEqual(reading.spot.opponentStacks, [
    { behind: 970, committedThisStreet: 30 },
    { behind: 990, committedThisStreet: 10 },
  ]);
  const report = buildCoachReport({ ...coachInputFor(reading.spot), samples: 4_000 });
  const e = report.equity.heroEquity;
  const raises = report.candidates.filter((row) => row.action === 'raise');
  assert.ok(raises.length > 0, 'a sweep of nothing is not a pass');
  for (const row of raises) {
    const r = row.cost - 25;
    near(row.ev, 0.35 * 45 + 0.65 * (e * (45 + 25 + 2 * r) - (25 + r)), `raise to ${row.to}`);
    assert.equal(row.potShareIfCalled, e);
    assert.match(row.derivation, /^EV\(raise\) = f x pot/);
  }
  assert.match(report.assumptions.join(' '), /wins uncontested 35% of the time/);
});

test('heads-up against an all-in, nothing is priced on a fold', () => {
  // Seat 0 shoves 500 into hero's big blind. A shove cannot fold, so no row reads a fold rate.
  const view = viewAfter([500, 2_000], [{ seat: 0, to: 500 }], 'v1', 6);
  const reading = coachSpotForView(view, LIVE_COACH_POLICY);
  assert.ok(reading.kind === 'spot');
  assert.deepEqual(reading.spot.opponentStacks, [{ behind: 0, committedThisStreet: 500, winnable: 510 }]);
  const report = buildCoachReport(coachInputFor(reading.spot));
  assert.ok(report.candidates.every((row) => row.foldEquityAssumed === undefined));
  assert.doesNotMatch(report.assumptions.join(' '), /uncontested|fold rate|folds? \d/);
  const e = report.equity.heroEquity;
  near(evAt(report, 'call'), e * (510 + 490) - 490, 'call');
});

test('the live table reads an all-in seat off the engine layers, folded chips included', () => {
  // Seat 3 shoves 50 and three seats call: a 200 main pot. Flop: seat 0 bets 100, seats 1 and 2 call.
  // Turn: seat 1 bets 200, hero (seat 2) calls, seat 0 folds, its 100 left in the side pot. River:
  // hero to act with 900 in the middle, 200 of it the pot seat 3 can win. Reading this street alone
  // would have given it all 900.
  let state = handAt([1_000, 1_000, 1_000, 50], 7);
  state = act(state, 3, { type: 'raise', to: 50 });
  for (const seat of [0, 1, 2]) state = act(state, seat, { type: 'call' });
  state = act(state, 1, { type: 'check' });
  state = act(state, 2, { type: 'check' });
  state = act(state, 0, { type: 'bet', to: 100 });
  state = act(state, 1, { type: 'call' });
  state = act(state, 2, { type: 'call' });
  state = act(state, 1, { type: 'bet', to: 200 });
  state = act(state, 2, { type: 'call' });
  state = act(state, 0, { type: 'fold' });
  state = act(state, 1, { type: 'check' });
  const reading = coachSpotForView(redactFor(state, { viewerPlayerId: 'v2' }), LIVE_COACH_POLICY);
  assert.ok(reading.kind === 'spot');
  assert.equal(reading.spot.pot, 900);
  assert.deepEqual(reading.spot.opponentStacks, [
    { behind: 650, committedThisStreet: 0 },
    { behind: 0, committedThisStreet: 0, winnable: 200 },
  ]);
});

test('refused: a seat with chips behind that cannot win the whole pot, and stacks with no ranges', () => {
  assert.throws(
    () =>
      river('Kc Qh', {
        opponentStacks: [
          { behind: 0, committedThisStreet: 0, winnable: 300 },
          { behind: 900, committedThisStreet: 0, winnable: 200 },
        ],
      }),
    /can match any bet/,
  );
  assert.throws(
    () =>
      river('Kc Qh', {
        opponentStacks: [
          { behind: 0, committedThisStreet: 0, winnable: 301 },
          ALL_IN_PREFLOP[1] as OpponentStack,
        ],
      }),
    /above the 300/,
  );
  assert.throws(
    () => river('Kc Qh', { opponents: [ACES], opponentStacks: ALL_IN_PREFLOP }),
    /one range per opponent/,
  );
});

/** Prior 300 three ways, then A jams 100 with aces and B calls. */
function facingAJam() {
  return river('Kc Qh', {
    opponents: [ACES, SIXTY],
    pot: 500,
    toCall: 100,
    opponentStacks: [
      { behind: 0, committedThisStreet: 100, winnable: 500 },
      { behind: 800, committedThisStreet: 100 },
    ],
  });
}

test('a raise that loses called and loses more when B folds cannot break even at any fold rate', () => {
  // Raise to 400, called: the 600 main pot goes to A and hero wins 0.6 of the 600 side pot, less 400:
  // -40. B folds: the main pot goes to A, less the 100 hero matched: -100. 0.35 x -100 + 0.65 x -40.
  const report = facingAJam();
  near(evAt(report, 'raise', 400), -61, 'raise to 400');
  const half = report.assumptions.find((line) => line.startsWith('The ½-pot raise to 400'));
  assert.match(half ?? '', /cannot break even at any fold frequency/);
  assert.doesNotMatch(half ?? '', /already break-even/);
});

test('the fold branch of a raise names the chips hero puts in to match the all-in', () => {
  const raise = facingAJam().candidates.find((row) => row.action === 'raise' && row.to === 400);
  assert.match(
    raise?.derivation ?? '',
    /a fold still leaves the 600 main pot at 0%, less your 100: worth -100/,
  );
});

test('a raise that wins called and loses when B folds breaks even only below a fold rate', () => {
  // Prior 900. Raise to 700, called: 1200 main pot lost, 0.6 of the 1200 side pot won, less 700: +20.
  // B folds: -100. EV = 20 - 120f, zero at f = 1/6, and 0.35 x -100 + 0.65 x 20 = -22 at the default.
  const report = river('Kc Qh', {
    opponents: [ACES, SIXTY],
    pot: 1_100,
    toCall: 100,
    opponentStacks: [
      { behind: 0, committedThisStreet: 100, winnable: 1_100 },
      { behind: 800, committedThisStreet: 100 },
    ],
  });
  near(evAt(report, 'raise', 700), -22, 'raise to 700');
  const half = report.assumptions.find((line) => line.startsWith('The ½-pot raise to 700'));
  assert.match(half ?? '', /fold more than 17% of the time/);
  assert.doesNotMatch(half ?? '', /does not need anyone to fold/);
});

test('chips a fold hands back too are no gain of a call', () => {
  // Hero has 5 in, the all-in opponent 1 and 4 of antes: a 6-chip pot it can win. A fold hands back
  // hero's 4 unmatched chips, and a call hands back those 4 and the 5 it adds. So the call is worth the
  // 6-chip pot at hero's share: 0 against aces, 6 against queens.
  const spot = {
    pot: 10,
    toCall: 5,
    heroCommittedThisStreet: 5,
    opponentStacks: [{ behind: 0, committedThisStreet: 1, winnable: 6 }],
  };
  near(evAt(river('Kc Qh', { ...spot, opponents: [ACES] }), 'call'), 0, 'call against aces');
  near(evAt(river('Kc Qh', { ...spot, opponents: [QUEENS] }), 'call'), 6, 'call against queens');
});

test('heads-up, a big blind all in for less than the small blind costs a fold only the matched chips', () => {
  // Ante 2 and 3 chips: the big blind posts 2 and 1, so it can win 6. The engine hands hero's other 4
  // back on a fold, so the call is worth that pot at hero's equity and nothing more.
  const short = handAt([100, 3], 3, 2);
  const hero = short.toAct ?? -1;
  assert.equal(short.seats[hero]?.stack, 93);
  assert.equal(act(short, hero, { type: 'fold' }).seats[hero]?.stack, 97);
  const reading = coachSpotForView(redactFor(short, { viewerPlayerId: `v${hero}` }), LIVE_COACH_POLICY);
  assert.ok(reading.kind === 'spot');
  const report = buildCoachReport(coachInputFor(reading.spot));
  near(evAt(report, 'call'), 6 * report.equity.heroEquity, 'call');

  // Without an ante a 6-chip big blind is over the small blind, so nothing comes back on a fold. The
  // call adds 5, 1 of it matched: the 12-chip pot at hero's equity, less the 1.
  const covered = handAt([100, 6], 3);
  const view = redactFor(covered, { viewerPlayerId: `v${covered.toAct}` });
  const coveredReading = coachSpotForView(view, LIVE_COACH_POLICY);
  assert.ok(coveredReading.kind === 'spot');
  const coveredReport = buildCoachReport(coachInputFor(coveredReading.spot));
  near(evAt(coveredReport, 'call'), 12 * coveredReport.equity.heroEquity - 1, 'call over a 6-chip blind');
});

function handAt(stacks: readonly number[], seed: number, ante = 0): HandState {
  return startHand({
    handId: `all-in-opponent-${seed}`,
    roomId: 'all-in-opponent',
    handNumber: 1,
    config: { smallBlind: 5, bigBlind: 10, ante, maxSeats: stacks.length, actionTimeoutSeconds: 30 },
    buttonSeat: 0,
    seats: stacks.map((stack, seat) => ({ seat, playerId: `v${seat}`, stack })),
    random: createDeterministicRandomForTests(seed),
  }).state;
}

function act(state: HandState, seat: number, action: Parameters<typeof applyAction>[2]): HandState {
  return applyAction(state, seat, action).state;
}

function viewAfter(
  stacks: readonly number[],
  raises: readonly { readonly seat: number; readonly to: number }[],
  viewer: string,
  seed: number,
) {
  let state = handAt(stacks, seed);
  for (const raise of raises) state = act(state, raise.seat, { type: 'raise', to: raise.to });
  return redactFor(state, { viewerPlayerId: viewer });
}
