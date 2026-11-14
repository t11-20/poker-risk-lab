/**
 * Opponent model tests. The boundary tests fail by observation. A fold-out hand records no cards from
 * any viewer's angle, the same hand redacted for different viewers yields identical observations, and
 * synthetic views with empty `seats` prove the model reads only the action log and showdown list.
 * Counter arithmetic is worked by hand in comments, not recomputed, so a shared error cannot pass.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Action,
  applyAction,
  createDeterministicRandomForTests,
  type HandState,
  type LoggedAction,
  legalActions,
  type PlayerView,
  redactFor,
  type SeatIndex,
  type SeatSetup,
  startHand,
  type TableConfig,
} from '@prl/poker-engine';
import { findImpersonation } from '../src/labelling.ts';
import {
  BET_SIZE_SAMPLE_CAP,
  createOpponentModel,
  type DerivedSeatStats,
  derivedStats,
  emptyObservations,
  estimateRange,
  exploitAdjustments,
  INDICATIVE_MINIMUM_HANDS,
  MINIMUM_HANDS_FOR_STATS,
  neutralStats,
  ObservationError,
  type OpponentObservations,
  observeAction,
  observeHandComplete,
  type PublicActionEvent,
  RANGE_STREETS,
  REASONABLE_MINIMUM_HANDS,
  reliabilityFor,
  type SeatObservations,
  SHOWDOWN_HAND_CAP,
} from '../src/opponent-model.ts';

const tableConfig: TableConfig = {
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  maxSeats: 6,
  actionTimeoutSeconds: 30,
};

function seatSetups(count: number, stack = 200): SeatSetup[] {
  return Array.from({ length: count }, (_, seat) => ({ seat, playerId: `p${seat}`, stack }));
}

function dealHand(seatCount: number, handId = 'hand-1', seed = 7): HandState {
  return startHand({
    handId,
    roomId: 'room-1',
    handNumber: 1,
    config: tableConfig,
    buttonSeat: 0,
    seats: seatSetups(seatCount),
    random: createDeterministicRandomForTests(seed),
  }).state;
}

function currentActor(state: HandState): SeatIndex {
  const seat = state.toAct;
  if (seat === null) throw new Error('nobody is to act');
  return seat;
}

function act(state: HandState, action: Action): HandState {
  return applyAction(state, currentActor(state), action).state;
}

function passiveToCompletion(state: HandState): HandState {
  let current = state;
  for (let guard = 0; guard < 200; guard++) {
    if (current.street === 'complete' || current.toAct === null) return current;
    const seat = currentActor(current);
    const canCheck = legalActions(current, seat).some((entry) => entry.type === 'check');
    current = applyAction(current, seat, canCheck ? { type: 'check' } : { type: 'call' }).state;
  }
  throw new Error('the hand did not complete within 200 actions');
}

type ScriptedEvent = Omit<PublicActionEvent, 'handId'>;

function preflop(seat: number, action: ScriptedEvent['action'], toCall: number, paid: number): ScriptedEvent {
  return {
    seat,
    street: 'preflop',
    action,
    toCall,
    potBefore: 3,
    amountPaid: paid,
    facingPreflopRaise: false,
    raiseWasAvailable: true,
  };
}

function postflop(
  seat: number,
  action: ScriptedEvent['action'],
  toCall: number,
  potBefore: number,
  paid: number,
): ScriptedEvent {
  return {
    seat,
    street: 'flop',
    action,
    toCall,
    potBefore,
    amountPaid: paid,
    facingPreflopRaise: false,
    raiseWasAvailable: true,
  };
}

function toLoggedAction(event: ScriptedEvent, index: number): LoggedAction {
  const total = Math.max(1, Math.round(event.potBefore + event.amountPaid));
  const action: Action =
    event.action === 'bet' || event.action === 'raise'
      ? { type: event.action, to: total }
      : { type: event.action };
  return {
    sequence: index + 1,
    street: event.street,
    seat: event.seat,
    playerId: `p${event.seat}`,
    action,
    amountPaid: event.amountPaid,
    betLevelAfter: total,
    potAfter: event.potBefore + event.amountPaid,
    wasAutomatic: false,
    actionId: null,
  };
}

/**
 * `seats` is empty and `result` is null on purpose. If `observeHandComplete` read `view.seats`, where
 * the observer's own hole cards sit, every test built on this would break.
 */
function scriptedView(base: PlayerView, handId: string, events: readonly ScriptedEvent[]): PlayerView {
  return {
    ...base,
    handId,
    seats: [],
    actions: events.map(toLoggedAction),
    result: null,
  };
}

function feedHand(
  observations: OpponentObservations,
  base: PlayerView,
  handId: string,
  events: readonly ScriptedEvent[],
): OpponentObservations {
  let next = observations;
  for (const event of events) next = observeAction(next, { handId, ...event });
  return observeHandComplete(next, scriptedView(base, handId, events));
}

function completedBaseView(): PlayerView {
  const state = passiveToCompletion(dealHand(3));
  assert.equal(state.street, 'complete', 'the base hand must complete');
  return redactFor(state, { viewerSeat: null });
}

function seatOf(observations: OpponentObservations, seat: number): SeatObservations {
  const found = observations.bySeat.get(seat);
  if (found === undefined) throw new Error(`no observations recorded for seat ${seat}`);
  return found;
}

function statsOf(observations: OpponentObservations, seat: number): DerivedSeatStats {
  const found = derivedStats(observations, seat);
  if (found === null) throw new Error(`derivedStats returned null for seat ${seat}`);
  return found;
}

function snapshot(observations: OpponentObservations): unknown {
  return {
    handsObserved: observations.handsObserved,
    currentHand: observations.currentHand,
    bySeat: [...observations.bySeat.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, seat]) => seat),
  };
}

function deepFreeze(observations: OpponentObservations): OpponentObservations {
  for (const seat of observations.bySeat.values()) {
    Object.freeze(seat.betSizeSamples);
    for (const shown of seat.showdownHands) {
      Object.freeze(shown.cards);
      Object.freeze(shown);
    }
    Object.freeze(seat.showdownHands);
    Object.freeze(seat);
  }
  Object.freeze(observations.bySeat);
  if (observations.currentHand !== null) Object.freeze(observations.currentHand);
  return Object.freeze(observations);
}

test('a hand that ends in a fold records no showdown hands, from any viewer', () => {
  // Heads-up, the button posts the small blind and acts first, so one fold ends it.
  const dealt = dealHand(2, 'fold-out', 11);
  const state = act({ ...dealt, config: { ...dealt.config, maxSeats: 6 } }, { type: 'fold' });
  assert.equal(state.street, 'complete');
  assert.equal(state.result?.endedByFold, true);
  assert.deepEqual(state.result?.showdowns, [], 'the engine must reveal nothing on a fold-out');

  for (const viewerSeat of [0, 1, null]) {
    const view = redactFor(state, { viewerSeat });

    // The viewer's own cards are in this view, so the guard has something to leak.
    if (viewerSeat !== null) {
      const own = view.seats.find((seat) => seat.seat === viewerSeat);
      assert.notEqual(own?.holeCards, null, `seat ${viewerSeat} should see its own cards`);
    }

    const observations = observeHandComplete(emptyObservations(), view);
    for (const seat of observations.bySeat.values()) {
      assert.deepEqual(seat.showdownHands, [], `seat ${seat.seat} recorded a hand nobody showed`);
      assert.equal(seat.showdownsReached, 0, `seat ${seat.seat} recorded a showdown that never happened`);
    }
  }
});

test('the folder is counted as having seen the hand, and the seat that never acted is not', () => {
  const dealt = dealHand(2, 'fold-out', 11);
  const folder = currentActor(dealt);
  const other = folder === 0 ? 1 : 0;
  const state = act(dealt, { type: 'fold' });

  const observations = observeHandComplete(emptyObservations(), redactFor(state, { viewerSeat: null }));

  assert.equal(seatOf(observations, folder).handsSeen, 1);
  assert.equal(seatOf(observations, folder).handsVoluntarilyEntered, 0);
  // The other seat never got a turn, so it is not counted. Dividing by hands dealt would measure
  // button rotation.
  assert.equal(observations.bySeat.get(other), undefined);
  assert.equal(observations.handsObserved, 1);
});

test('a shown-down hand records exactly the hands that were shown', () => {
  // Button 0: blinds are seats 1 and 2, and seat 0 acts first preflop.
  const dealt = dealHand(3, 'showdown', 23);
  const folder = currentActor(dealt);
  const state = passiveToCompletion(act(dealt, { type: 'fold' }));

  assert.equal(state.street, 'complete');
  const shownSeats = (state.result?.showdowns ?? []).map((showdown) => showdown.seat).sort();
  assert.equal(shownSeats.length, 2, 'two seats should reach the showdown');
  assert.ok(!shownSeats.includes(folder), 'the folder must not appear in the showdown list');

  const observations = observeHandComplete(emptyObservations(), redactFor(state, { viewerSeat: folder }));

  const ownView = redactFor(state, { viewerSeat: folder });
  assert.notEqual(
    ownView.seats.find((seat) => seat.seat === folder)?.holeCards,
    null,
    'the folder should see its own cards in its own view',
  );
  assert.deepEqual(seatOf(observations, folder).showdownHands, []);

  for (const seat of shownSeats) {
    const shown = seatOf(observations, seat).showdownHands;
    assert.equal(shown.length, 1, `seat ${seat} should have one shown hand`);
    assert.equal(shown[0]?.cards.length, 2);
    assert.equal(seatOf(observations, seat).showdownsReached, 1);
  }

  const aggressors = shownSeats.filter((seat) => seatOf(observations, seat).showdownHands[0]?.wasAggressor);
  assert.ok(aggressors.length <= 1, 'at most one seat can have made the last bet or raise');
});

test('the same hand seen from different seats produces identical observations', () => {
  const dealt = dealHand(3, 'identical', 23);
  const state = passiveToCompletion(act(dealt, { type: 'fold' }));

  const snapshots = [0, 1, 2, null].map((viewerSeat) =>
    snapshot(observeHandComplete(emptyObservations(), redactFor(state, { viewerSeat }))),
  );
  const [first] = snapshots;
  for (const other of snapshots) {
    assert.deepStrictEqual(other, first);
  }
});

test('per-action counters follow a scripted sequence exactly', () => {
  const base = completedBaseView();

  // Seat 5's turns in one hand, in order. `paid / potBefore` is the sizing sample.
  //
  //  # | street  | action | toCall | potBefore | paid | facing a preflop raise
  // ---+---------+--------+--------+-----------+------+-----------------------
  //  1 | preflop | raise  |      2 |         3 |    6 | no   -> opens
  //  2 | preflop | call   |     12 |        21 |   12 | yes  -> a 3-bet spot it declined
  //  3 | flop    | bet    |      0 |        40 |   20 | -
  //  4 | flop    | call   |     30 |        90 |   30 | -
  //  5 | turn    | check  |      0 |       120 |    0 | -
  //  6 | turn    | fold   |     60 |       180 |    0 | -
  const script: readonly ScriptedEvent[] = [
    { ...preflop(5, 'raise', 2, 6) },
    { ...preflop(5, 'call', 12, 12), potBefore: 21, facingPreflopRaise: true },
    { ...postflop(5, 'bet', 0, 40, 20) },
    { ...postflop(5, 'call', 30, 90, 30) },
    { ...postflop(5, 'check', 0, 120, 0), street: 'turn' },
    { ...postflop(5, 'fold', 60, 180, 0), street: 'turn' },
  ];

  const observations = feedHand(emptyObservations(), base, 'scripted-1', script);
  const seat = seatOf(observations, 5);

  assert.equal(seat.raises, 1, 'one raise: #1');
  assert.equal(seat.bets, 1, 'one bet: #3');
  assert.equal(seat.calls, 2, 'two calls: #2 and #4');
  assert.equal(seat.checks, 1, 'one check: #5');
  assert.equal(seat.folds, 1, 'one fold: #6');

  // toCall > 0 on #1 (2), #2 (12), #4 (30) and #6 (60) = 4 turns facing a bet, one folded.
  assert.equal(seat.timesFacingBet, 4);
  assert.equal(seat.foldsFacingBet, 1);

  // A 3-bet spot needs preflop + facing a raise + a re-raise legal, which is #2 alone. It
  // called, so the opportunity is counted and the 3-bet is not.
  assert.equal(seat.threeBetOpportunities, 1);
  assert.equal(seat.threeBets, 0);

  // Sizing samples come from bets and raises only: 6/3 = 2 from #1, 20/40 = 0.5 from #3.
  assert.deepEqual(seat.betSizeSamples, [2, 0.5]);

  // Per-hand latches: it acted preflop, it entered voluntarily, and it raised.
  assert.equal(seat.handsSeen, 1);
  assert.equal(seat.handsVoluntarilyEntered, 1);
  assert.equal(seat.preflopRaises, 1);
  assert.equal(observations.handsObserved, 1);
});

test('frequencies over 40 scripted hands match the arithmetic', () => {
  const base = completedBaseView();
  let observations = emptyObservations();

  // Seat 1 plays 40 hands in three shapes:
  //
  //   10 x "raise":  preflop raise (toCall 2, pot 3, paid 6), then flop call (toCall 10)
  //    6 x "call":   preflop call (toCall 2, paid 2), flop check, then flop fold (toCall 15)
  //   24 x "fold":   preflop fold (toCall 2, paid 0)
  //
  // Per-hand latches:  handsSeen 40, entered 10 + 6 = 16, raised 10
  //   vpip = 16/40 = 0.400          pfr = 10/40 = 0.250        tightness = 1 - 0.4 = 0.600
  //
  // Per-action counters:
  //   raises 10, bets 0, calls 10 + 6 = 16, checks 6, folds 6 + 24 = 30  -> 62 actions
  //   facing a bet: 10x2 + 6x2 + 24x1 = 56          folds facing a bet: 0 + 6 + 24 = 30
  //   aggression = 10 / (10 + 16 + 30) = 10/56 = 0.178571…
  //   fold-to-bet = 30/56 = 0.535714…
  //   sizing samples: 10 x (6/3) = 10 samples of 2.0, so the average is 2.0
  for (let index = 0; index < 10; index++) {
    observations = feedHand(observations, base, `raise-${index}`, [
      preflop(1, 'raise', 2, 6),
      postflop(1, 'call', 10, 20, 10),
    ]);
  }
  for (let index = 0; index < 6; index++) {
    observations = feedHand(observations, base, `call-${index}`, [
      preflop(1, 'call', 2, 2),
      postflop(1, 'check', 0, 20, 0),
      postflop(1, 'fold', 15, 30, 0),
    ]);
  }
  for (let index = 0; index < 24; index++) {
    observations = feedHand(observations, base, `fold-${index}`, [preflop(1, 'fold', 2, 0)]);
  }

  const seat = seatOf(observations, 1);
  assert.equal(seat.handsSeen, 40);
  assert.equal(seat.handsVoluntarilyEntered, 16);
  assert.equal(seat.preflopRaises, 10);
  assert.equal(seat.raises, 10);
  assert.equal(seat.bets, 0);
  assert.equal(seat.calls, 16);
  assert.equal(seat.checks, 6);
  assert.equal(seat.folds, 30);
  assert.equal(seat.timesFacingBet, 56);
  assert.equal(seat.foldsFacingBet, 30);

  const stats = statsOf(observations, 1);
  assert.equal(stats.handsSeen, 40);
  assert.equal(stats.actionsObserved, 62);
  assert.equal(stats.vpip, 0.4);
  assert.equal(stats.pfr, 0.25);
  assert.ok(Math.abs(stats.tightness - 0.6) < 1e-12);
  assert.ok(Math.abs(stats.aggressionFrequency - 10 / 56) < 1e-12);
  assert.ok(Math.abs(stats.foldToBetFrequency - 30 / 56) < 1e-12);
  assert.equal(stats.averageBetSizeAsPotFraction, 2);
  // An empty denominator gives 0, not NaN.
  assert.equal(stats.threeBetFrequency, 0);
  assert.equal(stats.wentToShowdown, 0);
  assert.equal(seat.showdownHands.length, 0);

  assert.equal(stats.reliability, 'indicative');
  assert.equal(stats.reliability, reliabilityFor(40));
});

test('derivedStats returns null below the minimum and a value at it', () => {
  const base = completedBaseView();
  let observations = emptyObservations();

  for (let hand = 1; hand < MINIMUM_HANDS_FOR_STATS; hand++) {
    observations = feedHand(observations, base, `h${hand}`, [preflop(2, 'call', 2, 2)]);
    assert.equal(
      derivedStats(observations, 2),
      null,
      `${hand} hands is below the ${MINIMUM_HANDS_FOR_STATS}-hand floor and must not produce a read`,
    );
  }
  observations = feedHand(observations, base, 'h20', [preflop(2, 'call', 2, 2)]);
  assert.equal(statsOf(observations, 2).handsSeen, MINIMUM_HANDS_FOR_STATS);

  assert.equal(derivedStats(observations, 4), null);
});

test('the confidence interval shrinks as hands accumulate, through the documented bands', () => {
  const base = completedBaseView();
  let observations = emptyObservations();
  const measured: { hands: number; halfWidth: number; reliability: string }[] = [];

  for (let hand = 1; hand <= 400; hand++) {
    observations = feedHand(observations, base, `h${hand}`, [preflop(3, 'call', 2, 2)]);
    const stats = derivedStats(observations, 3);
    if (stats !== null)
      measured.push({ hands: hand, halfWidth: stats.confidenceHalfWidth, reliability: stats.reliability });
  }

  assert.ok(measured.length > 0);
  for (let index = 1; index < measured.length; index++) {
    const previous = measured[index - 1];
    const current = measured[index];
    if (previous === undefined || current === undefined) continue;
    assert.ok(
      current.halfWidth < previous.halfWidth,
      `interval grew from ${previous.halfWidth} at ${previous.hands} hands to ${current.halfWidth} at ${current.hands}`,
    );
  }

  const at = (hands: number): { halfWidth: number; reliability: string } => {
    const found = measured.find((entry) => entry.hands === hands);
    if (found === undefined) throw new Error(`no measurement at ${hands} hands`);
    return found;
  };

  // 1.959964 x 0.5 / sqrt(n): 0.2191 at 20, 0.1549 at 40, 0.0800 at 150, 0.0490 at 400.
  assert.ok(Math.abs(at(20).halfWidth - 0.2191) < 5e-4);
  assert.ok(Math.abs(at(INDICATIVE_MINIMUM_HANDS).halfWidth - 0.1549) < 5e-4);
  assert.ok(Math.abs(at(REASONABLE_MINIMUM_HANDS).halfWidth - 0.08) < 5e-4);
  assert.ok(Math.abs(at(400).halfWidth - 0.049) < 5e-4);

  assert.equal(at(20).reliability, 'insufficient');
  assert.equal(at(INDICATIVE_MINIMUM_HANDS - 1).reliability, 'insufficient');
  assert.equal(at(INDICATIVE_MINIMUM_HANDS).reliability, 'indicative');
  assert.equal(at(REASONABLE_MINIMUM_HANDS - 1).reliability, 'indicative');
  assert.equal(at(REASONABLE_MINIMUM_HANDS).reliability, 'reasonable');
  // Counting public actions never earns a band above `reasonable`.
  assert.equal(at(400).reliability, 'reasonable');
});

test('the bet-size window never exceeds its cap over 10,000 observations', () => {
  let observations = emptyObservations();
  const total = 10_000;
  for (let index = 0; index < total; index++) {
    observations = observeAction(observations, {
      handId: 'long-hand',
      seat: 0,
      street: 'flop',
      action: 'bet',
      toCall: 0,
      potBefore: 100,
      amountPaid: index + 1,
      facingPreflopRaise: false,
      raiseWasAvailable: true,
    });
    assert.ok(
      seatOf(observations, 0).betSizeSamples.length <= BET_SIZE_SAMPLE_CAP,
      `window reached ${seatOf(observations, 0).betSizeSamples.length} at observation ${index}`,
    );
  }

  const samples = seatOf(observations, 0).betSizeSamples;
  assert.equal(samples.length, BET_SIZE_SAMPLE_CAP);
  assert.equal(seatOf(observations, 0).bets, total, 'the counter itself is not capped');
  // The window holds observations 9937..10000 as pot fractions.
  assert.equal(samples[0], (total - BET_SIZE_SAMPLE_CAP + 1) / 100);
  assert.equal(samples[BET_SIZE_SAMPLE_CAP - 1], total / 100);
});

test('the showdown window never exceeds its cap over 10,000 completed hands', () => {
  const dealt = dealHand(3, 'showdown-cap', 23);
  const state = passiveToCompletion(act(dealt, { type: 'fold' }));
  const realView = redactFor(state, { viewerSeat: null });
  const shownSeats = (state.result?.showdowns ?? []).map((showdown) => showdown.seat);
  assert.ok(shownSeats.length >= 1);

  let observations = emptyObservations();
  const total = 10_000;
  for (let index = 0; index < total; index++) {
    observations = observeHandComplete(observations, { ...realView, handId: `h${index}` });
  }

  assert.equal(observations.handsObserved, total);
  for (const seat of observations.bySeat.values()) {
    assert.ok(
      seat.showdownHands.length <= SHOWDOWN_HAND_CAP,
      `seat ${seat.seat} kept ${seat.showdownHands.length} shown hands`,
    );
  }
  for (const seat of shownSeats) {
    assert.equal(seatOf(observations, seat).showdownHands.length, SHOWDOWN_HAND_CAP);
    assert.equal(seatOf(observations, seat).showdownsReached, total);
  }
});

test('observing never mutates the input, even when it is deep-frozen', () => {
  const base = completedBaseView();
  let observations = emptyObservations();
  for (let hand = 1; hand <= 3; hand++) {
    observations = feedHand(observations, base, `h${hand}`, [
      preflop(1, 'raise', 2, 6),
      postflop(1, 'bet', 0, 20, 10),
    ]);
  }

  const frozen = deepFreeze(observations);
  const before = snapshot(frozen);

  assert.doesNotThrow(() => {
    observeAction(frozen, { handId: 'h4', ...postflop(1, 'call', 10, 40, 10) });
  });
  assert.doesNotThrow(() => {
    observeHandComplete(frozen, scriptedView(base, 'h4', [preflop(1, 'fold', 2, 0)]));
  });

  assert.deepStrictEqual(snapshot(frozen), before, 'the input object changed');

  const next = observeHandComplete(frozen, scriptedView(base, 'h4', [preflop(1, 'fold', 2, 0)]));
  assert.notStrictEqual(next, frozen);
  assert.notStrictEqual(next.bySeat, frozen.bySeat, 'the Map must be rebuilt, not reused');
  assert.equal(frozen.handsObserved, 3);
  assert.equal(next.handsObserved, 4);
});

test('what the module returns is frozen, so a shared window cannot be pushed onto', () => {
  const base = completedBaseView();
  const observations = feedHand(emptyObservations(), base, 'h1', [preflop(1, 'raise', 2, 6)]);
  const seat = seatOf(observations, 1);

  assert.ok(Object.isFrozen(observations));
  assert.ok(Object.isFrozen(seat));
  assert.ok(Object.isFrozen(seat.betSizeSamples));
  assert.throws(() => {
    (seat.betSizeSamples as number[]).push(0.5);
  }, TypeError);
});

function seatWithVpip(base: PlayerView, seat: number, hands: number, entered: number): OpponentObservations {
  let observations = emptyObservations();
  for (let index = 0; index < hands; index++) {
    const script: readonly ScriptedEvent[] =
      index < entered
        ? [preflop(seat, 'call', 2, 2), postflop(seat, 'fold', 10, 20, 0)]
        : [preflop(seat, 'fold', 2, 0)];
    observations = feedHand(observations, base, `h${index}`, script);
  }
  return observations;
}

test('a tight seat is given a narrower range than a loose one', () => {
  const base = completedBaseView();
  // 200 hands each, so both samples are `reasonable` and the difference is the style.
  //   tight: 24/200 entered  -> vpip 0.12, tightness 0.88, entry range 12% of hands
  //   loose: 110/200 entered -> vpip 0.55, tightness 0.45, entry range 55% of hands
  const tight = statsOf(seatWithVpip(base, 1, 200, 24), 1);
  const loose = statsOf(seatWithVpip(base, 1, 200, 110), 1);

  assert.equal(tight.reliability, 'reasonable');
  assert.equal(loose.reliability, 'reasonable');
  assert.ok(Math.abs(tight.vpip - 0.12) < 1e-12);
  assert.ok(Math.abs(loose.vpip - 0.55) < 1e-12);

  const tightRange = estimateRange(tight, 'preflop', 'none', 1);
  const looseRange = estimateRange(loose, 'preflop', 'none', 1);
  assert.ok(
    tightRange.combos.length < looseRange.combos.length,
    `tight ${tightRange.combos.length} combos should be fewer than loose ${looseRange.combos.length}`,
  );
  assert.ok(tightRange.fractionOfAllHands >= 0.12 && tightRange.fractionOfAllHands < 0.16);
  assert.ok(looseRange.fractionOfAllHands >= 0.55 && looseRange.fractionOfAllHands < 0.6);
});

test('a range narrows with each street of betting and with the strength of the action faced', () => {
  const base = completedBaseView();
  const stats = statsOf(seatWithVpip(base, 1, 200, 110), 1);

  const combos = (street: string, facing: string): number =>
    estimateRange(stats, street, facing, 1).combos.length;

  assert.ok(combos('flop', 'none') < combos('preflop', 'none'));
  assert.ok(combos('turn', 'none') < combos('flop', 'none'));
  assert.ok(combos('river', 'none') < combos('turn', 'none'));

  assert.ok(combos('flop', 'threeBet') < combos('flop', 'raise'));
  assert.ok(combos('flop', 'raise') < combos('flop', 'bet'));
  assert.ok(combos('flop', 'bet') < combos('flop', 'check'));

  // A later-street range is a subset of the entry range. Only preflop can hit the cap, because
  // `keep ** 0` is 1 there and the check multiplier is above 1.
  assert.equal(combos('preflop', 'check'), combos('preflop', 'none'));
});

function seatThatNeverFolds(base: PlayerView, seat: number, hands: number): OpponentObservations {
  let observations = emptyObservations();
  for (let index = 0; index < hands; index++) {
    observations = feedHand(observations, base, `nf${index}`, [
      preflop(seat, 'call', 2, 2),
      postflop(seat, 'call', 10, 20, 10),
    ]);
  }
  return observations;
}

/**
 * Preflop alone cannot catch this, because `keep ** 0` is 1 and the per-street keep factor drops out.
 * Unneutralised, this 25-hand sample gives 244 river combos against a neutral 56.
 */
test('an insufficient sample cannot move the range off the baseline assumption, on any street', () => {
  const base = completedBaseView();
  // 25 hands is past the null floor and still `insufficient`. Entering every hand and calling every
  // flop bet pushes both entry width and per-street keep to their limits.
  const veryLoose = statsOf(seatThatNeverFolds(base, 1, 25), 1);
  assert.equal(veryLoose.reliability, 'insufficient');
  assert.equal(veryLoose.vpip, 1, 'this seat entered every single observed hand');
  assert.equal(veryLoose.foldToBetFrequency, 0, 'and folded to none of the bets it faced');

  // The baseline vpip is 0.25.
  const preflop = estimateRange(veryLoose, 'preflop', 'none', 1);
  assert.ok(preflop.fractionOfAllHands >= 0.25 && preflop.fractionOfAllHands < 0.3);

  for (const street of RANGE_STREETS) {
    const observed = estimateRange(veryLoose, street, 'none', 1);
    const neutral = estimateRange(neutralStats(1), street, 'none', 1);
    assert.equal(
      observed.combos.length,
      neutral.combos.length,
      `${street}: a 25-hand sample moved the range to ${observed.combos.length} combos from the ` +
        `neutral ${neutral.combos.length}`,
    );
  }

  // The neutral river range is narrow, so the streets did not all collapse to one number.
  assert.equal(estimateRange(neutralStats(1), 'river', 'none', 1).combos.length, 56);
});

/**
 * `estimateRange` must scale by adaptation like `exploitAdjustments`, because every profile has
 * adaptation 0 at `educational`. Unscaled, the station and the rock give 300 and 84 flop combos.
 */
test('estimateRange returns the neutral baseline at adaptation 0, whatever it has counted', () => {
  const station: DerivedSeatStats = {
    ...neutralStats(1),
    handsSeen: 400,
    vpip: 0.9,
    tightness: 0.1,
    foldToBetFrequency: 0,
    reliability: 'reasonable',
  };
  const rock: DerivedSeatStats = {
    ...neutralStats(1),
    handsSeen: 400,
    vpip: 0.08,
    tightness: 0.92,
    foldToBetFrequency: 0.85,
    reliability: 'reasonable',
  };

  for (const street of RANGE_STREETS) {
    const neutral = estimateRange(neutralStats(1), street, 'none', 0).combos.length;
    assert.equal(estimateRange(station, street, 'none', 0).combos.length, neutral, `${street}: station`);
    assert.equal(estimateRange(rock, street, 'none', 0).combos.length, neutral, `${street}: rock`);
  }

  // At full adaptation the reads differ, so a fix that stopped reading the sample fails here.
  assert.ok(
    estimateRange(station, 'flop', 'none', 1).combos.length >
      estimateRange(rock, 'flop', 'none', 1).combos.length + 100,
  );
  // Half adaptation lands between, so the weight is a blend.
  const half = estimateRange(station, 'flop', 'none', 0.5).combos.length;
  const neutralFlop = estimateRange(neutralStats(1), 'flop', 'none', 1).combos.length;
  assert.ok(half > neutralFlop && half < estimateRange(station, 'flop', 'none', 1).combos.length);
});

test('estimateRange rejects a street, an action or an adaptation it does not model', () => {
  const stats = neutralStats(2);
  assert.throws(() => estimateRange(stats, 'showdown', 'none', 1), ObservationError);
  assert.throws(() => estimateRange(stats, 'complete', 'none', 1), ObservationError);
  assert.throws(() => estimateRange(stats, 'flop', 'shove', 1), ObservationError);
  // A trait silently clamped from 1.4 would make a profile differ from its card.
  assert.throws(() => estimateRange(stats, 'flop', 'none', 1.4), ObservationError);
  assert.throws(() => estimateRange(stats, 'flop', 'none', -0.1), ObservationError);
  assert.throws(() => estimateRange(stats, 'flop', 'none', Number.NaN), ObservationError);
  assert.doesNotThrow(() => estimateRange(stats, 'flop', 'none', 1));
});

/** Calls far too much, shows down constantly, limps in wide. */
function stationStats(): DerivedSeatStats {
  return {
    ...neutralStats(6),
    handsSeen: 300,
    actionsObserved: 900,
    vpip: 0.62,
    pfr: 0.08,
    aggressionFrequency: 0.2,
    foldToBetFrequency: 0.12,
    wentToShowdown: 0.52,
    tightness: 0.38,
    confidenceHalfWidth: 0.0566,
    reliability: 'reasonable',
  };
}

test('adaptation 0 returns exactly neutral multipliers', () => {
  const adjustments = exploitAdjustments(stationStats(), 0);
  assert.strictEqual(adjustments.bluffMore, 1);
  assert.strictEqual(adjustments.valueBetThinner, 1);
  assert.strictEqual(adjustments.foldMore, 1);
  assert.strictEqual(adjustments.sizeUp, 1);
  assert.strictEqual(adjustments.isolateMore, 1);
  assert.deepEqual(findImpersonation(adjustments.note), []);
});

test('an insufficient sample returns exactly neutral multipliers however adaptive the profile', () => {
  const insufficient: DerivedSeatStats = { ...stationStats(), handsSeen: 25, reliability: 'insufficient' };
  const adjustments = exploitAdjustments(insufficient, 1);
  assert.strictEqual(adjustments.bluffMore, 1);
  assert.strictEqual(adjustments.valueBetThinner, 1);
  assert.strictEqual(adjustments.foldMore, 1);
  assert.strictEqual(adjustments.sizeUp, 1);
  assert.strictEqual(adjustments.isolateMore, 1);

  const unknown = exploitAdjustments(null, 1);
  assert.strictEqual(unknown.bluffMore, 1);
  assert.strictEqual(unknown.isolateMore, 1);
  assert.deepEqual(findImpersonation(unknown.note), []);
});

test('a station moves the multipliers in the directions the poker says', () => {
  const stats = stationStats();
  const adjustments = exploitAdjustments(stats, 1);

  // Folds to only 12% of bets, against a 45% reference: bluff less, value-bet thinner.
  assert.ok(adjustments.bluffMore < 1, `bluffMore was ${adjustments.bluffMore}`);
  assert.ok(adjustments.valueBetThinner > 1, `valueBetThinner was ${adjustments.valueBetThinner}`);
  // Shows down 52% of the hands it plays: size up.
  assert.ok(adjustments.sizeUp > 1, `sizeUp was ${adjustments.sizeUp}`);
  // Enters 62% and raises 8%, so it limps 54%: isolate.
  assert.ok(adjustments.isolateMore > 1, `isolateMore was ${adjustments.isolateMore}`);
  // Loose and passive, so its aggression means less: fold less, not more.
  assert.ok(adjustments.foldMore < 1, `foldMore was ${adjustments.foldMore}`);

  assert.deepEqual(findImpersonation(adjustments.note), []);
  assert.ok(adjustments.note.startsWith('This model'), adjustments.note);
  assert.ok(adjustments.note.includes('public actions only'), adjustments.note);
});

test('adaptation scales the adjustment monotonically, and an indicative sample halves it', () => {
  const stats = stationStats();
  const full = exploitAdjustments(stats, 1);
  const half = exploitAdjustments(stats, 0.5);
  const indicative = exploitAdjustments({ ...stats, handsSeen: 60, reliability: 'indicative' }, 1);

  assert.ok(Math.abs(half.valueBetThinner - 1) < Math.abs(full.valueBetThinner - 1));
  assert.ok(Math.abs(half.valueBetThinner - 1) > 0);
  // adaptation 0.5 at `reasonable` and 1 at `indicative` are the same weight, 0.5.
  assert.ok(Math.abs(indicative.valueBetThinner - half.valueBetThinner) < 1e-12);
});

test('exploitAdjustments rejects an adaptation that is not a trait value', () => {
  const stats = stationStats();
  assert.throws(() => exploitAdjustments(stats, 1.4), ObservationError);
  assert.throws(() => exploitAdjustments(stats, -0.1), ObservationError);
  assert.throws(() => exploitAdjustments(stats, Number.NaN), ObservationError);
});

test('observeAction rejects anything that is not a public action', () => {
  const observations = emptyObservations();
  const valid: PublicActionEvent = { handId: 'h1', ...preflop(1, 'call', 2, 2) };

  assert.throws(() => observeAction(observations, { ...valid, handId: '' }), ObservationError);
  assert.throws(() => observeAction(observations, { ...valid, seat: -1 }), ObservationError);
  assert.throws(() => observeAction(observations, { ...valid, seat: 1.5 }), ObservationError);
  assert.throws(() => observeAction(observations, { ...valid, toCall: -1 }), ObservationError);
  assert.throws(
    () => observeAction(observations, { ...valid, potBefore: Number.POSITIVE_INFINITY }),
    ObservationError,
  );
  // The unions block these in typed code. The runtime check is for callers across a wire boundary.
  assert.throws(
    () => observeAction(observations, { ...valid, street: 'showdown' as PublicActionEvent['street'] }),
    ObservationError,
  );
  assert.throws(
    () => observeAction(observations, { ...valid, action: 'shove' as PublicActionEvent['action'] }),
    ObservationError,
  );
});

test('a hand cannot be counted twice', () => {
  const base = completedBaseView();
  const view = scriptedView(base, 'h1', [preflop(1, 'call', 2, 2)]);
  const once = observeHandComplete(emptyObservations(), view);

  assert.throws(() => observeHandComplete(once, view), ObservationError);
  assert.throws(
    () => observeAction(once, { handId: 'h1', ...postflop(1, 'bet', 0, 20, 10) }),
    ObservationError,
  );
  const twice = observeHandComplete(once, scriptedView(base, 'h2', [preflop(1, 'call', 2, 2)]));
  assert.equal(twice.handsObserved, 2);
  assert.equal(seatOf(twice, 1).handsSeen, 2);
});

test('observeHandComplete refuses a hand that is not over', () => {
  const state = dealHand(3, 'unfinished', 5);
  assert.notEqual(state.street, 'complete');
  assert.throws(
    () => observeHandComplete(emptyObservations(), redactFor(state, { viewerSeat: 0 })),
    ObservationError,
  );
});

test('no reachable combination of frequencies produces text the impersonation guard rejects', () => {
  // `assertNoImpersonation` throws at generation time, so this sweeps for a generator bug.
  const axis = [0, 0.33, 0.67, 1];
  const bands = ['insufficient', 'indicative', 'reasonable'] as const;
  let checked = 0;

  for (const vpip of axis) {
    for (const pfr of axis) {
      for (const aggression of axis) {
        for (const foldToBet of axis) {
          for (const showdown of axis) {
            for (const band of bands) {
              const stats: DerivedSeatStats = {
                ...neutralStats(0),
                handsSeen: band === 'insufficient' ? 20 : band === 'indicative' ? 40 : 400,
                vpip,
                pfr,
                aggressionFrequency: aggression,
                foldToBetFrequency: foldToBet,
                wentToShowdown: showdown,
                tightness: 1 - vpip,
                reliability: band,
              };
              for (const adaptation of [0, 0.5, 1]) {
                const note = exploitAdjustments(stats, adaptation).note;
                assert.deepEqual(findImpersonation(note), [], note);
                checked += 1;
              }
              assert.deepEqual(findImpersonation(stats.sampleNote), []);
              for (const assumption of stats.assumptions) {
                assert.deepEqual(findImpersonation(assumption), []);
              }
            }
          }
        }
      }
    }
  }
  assert.equal(checked, axis.length ** 5 * bands.length * 3);
  assert.deepEqual(findImpersonation(exploitAdjustments(null, 1).note), []);
});

test('the OpponentModel handle swaps snapshots without mutating the one already handed out', () => {
  const base = completedBaseView();
  const model = createOpponentModel(2);
  assert.equal(model.ownSeat, 2);

  const first = model.snapshot;
  model.observe(scriptedView(base, 'h1', [preflop(1, 'raise', 2, 6)]));
  const second = model.snapshot;

  assert.notStrictEqual(first, second);
  assert.equal(first.handsObserved, 0, 'the snapshot a policy already holds must not change');
  assert.equal(second.handsObserved, 1);

  assert.equal(model.statsFor(1), null);
  assert.equal(model.statsOrNeutralFor(1).reliability, 'insufficient');
  assert.equal(model.adjustmentsFor(1, 1).bluffMore, 1);
  assert.ok(model.rangeFor(1, 'preflop', 'none', 1).combos.length > 0);

  assert.throws(() => createOpponentModel(-1), ObservationError);
});

/**
 * `derivedStats` returns null below 20 hands, but `insufficient` runs to 40. Unneutralised, a 25-hand
 * seat that entered every pot returns vpip 1 and fold-to-bet 0.
 */
test('statsOrNeutralFor neutralises the whole insufficient band, not just the null floor', () => {
  const base = completedBaseView();
  const model = createOpponentModel(2);
  for (let hand = 0; hand < 25; hand++) {
    model.observe(scriptedView(base, `h${hand}`, [preflop(1, 'call', 2, 2)]));
  }

  const raw = model.statsFor(1);
  assert.ok(raw !== null, '25 hands is past the null floor, so the raw read exists');
  assert.equal(raw.reliability, 'insufficient', 'and is still below the indicative minimum of 40');
  assert.equal(raw.vpip, 1, 'the raw read really is extreme — a neutral answer is not a no-op');

  const guarded = model.statsOrNeutralFor(1);
  assert.equal(guarded.vpip, neutralStats(1).vpip);
  assert.equal(guarded.foldToBetFrequency, neutralStats(1).foldToBetFrequency);
  assert.equal(guarded.tightness, neutralStats(1).tightness);
  // The `opponents` list agrees, and still reports the true hand count.
  const seen = model.opponents.find((entry) => entry.seat === 1);
  assert.equal(seen?.handsObserved, 25);
  assert.equal(seen?.vpip, neutralStats(1).vpip);
});

test('the opponents list excludes the model own seat, is sorted, and is neutral until reliable', () => {
  const base = completedBaseView();
  const model = createOpponentModel(2);

  // Seats 3, 1 and 2 act, in that order, so an unsorted list would come back 3, 1, 2.
  for (let hand = 0; hand < 200; hand++) {
    model.observe(
      scriptedView(base, `h${hand}`, [
        preflop(3, 'call', 2, 2),
        preflop(1, 'raise', 2, 6),
        preflop(2, 'fold', 6, 0),
      ]),
    );
  }
  // Seat 4 shows up late, so its sample stays below the floor while the others are past it.
  for (let hand = 0; hand < 5; hand++) {
    model.observe(scriptedView(base, `late-${hand}`, [preflop(4, 'call', 2, 2)]));
  }

  const opponents = model.opponents;
  assert.deepEqual(
    opponents.map((entry) => entry.seat),
    [1, 3, 4],
    'own seat 2 must be absent, and the rest sorted',
  );

  assert.equal(opponents[0]?.handsObserved, 200);
  assert.equal(opponents[0]?.vpip, 1);
  // Seat 4 contributes the neutral baseline, so a policy that ignores `handsObserved` cannot act on
  // 5 hands.
  assert.equal(opponents[2]?.handsObserved, 5);
  assert.equal(opponents[2]?.vpip, neutralStats(4).vpip);
  assert.equal(opponents[2]?.foldToBetFrequency, neutralStats(4).foldToBetFrequency);
});
