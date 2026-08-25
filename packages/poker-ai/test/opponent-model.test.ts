/**
 * Tests for the opponent model.
 *
 * Three of these are not really tests of behaviour, they are tests of a *boundary*, and they
 * are written to fail by observation rather than by inspection:
 *
 *   - **The confidentiality test.** A hand that ends when everybody folds must record no
 *     showdown hands. Asserted from every viewer's angle, including the folder's own view,
 *     which genuinely does contain that seat's cards — so the test also asserts that the view
 *     it was handed was not empty of cards. A guard that passes because there was nothing to
 *     leak proves nothing.
 *   - **The public-information test.** The same completed hand, redacted for three different
 *     seats and for a spectator, must produce *identical* observations. Any dependence on who
 *     is looking is a dependence on private information, whatever the types say. This is a
 *     stronger claim than "the type has no card field", because a caller can hand a
 *     legitimately-shaped object built from privileged data.
 *   - **The empty-`seats` test.** The synthetic views below carry an empty `seats` array and
 *     everything still works, which demonstrates that `observeHandComplete` reads only the
 *     public action log and the showdown list — never `view.seats`, where the observer's own
 *     hole cards always sit.
 *
 * The counter arithmetic is worked out by hand in comments next to each assertion rather than
 * recomputed in the test. A test that recomputes the implementation's arithmetic passes when
 * both are wrong in the same way, which is the exact failure a frequency test exists to catch.
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

// ---------------------------------------------------------------------------
// Driving real hands, so the boundary tests exercise the real redaction
// ---------------------------------------------------------------------------

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

/** Checks when checking is legal, otherwise calls, until the hand is over. */
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

// ---------------------------------------------------------------------------
// Synthetic hands, for the arithmetic
// ---------------------------------------------------------------------------

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
 * A completed view carrying only a handId and an action log.
 *
 * `seats` is empty and `result` is null on purpose: if `observeHandComplete` ever started
 * reading `view.seats` — where the observer's own hole cards always sit — every test built on
 * this helper would break, which is the alarm we want.
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

/** A completed real view, reused as the shape every synthetic view is built from. */
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

/** A stable, order-independent picture of an observations object, for deep comparison. */
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

// ---------------------------------------------------------------------------
// 1. Confidentiality: a fold-out hand records nothing
// ---------------------------------------------------------------------------

test('a hand that ends in a fold records no showdown hands, from any viewer', () => {
  // Heads-up, so one fold ends it: with maxSeats 2 the button posts the small blind and acts
  // first, and folding leaves one player holding cards.
  const dealt = dealHand(2, 'fold-out', 11);
  const state = act({ ...dealt, config: { ...dealt.config, maxSeats: 6 } }, { type: 'fold' });
  assert.equal(state.street, 'complete');
  assert.equal(state.result?.endedByFold, true);
  assert.deepEqual(state.result?.showdowns, [], 'the engine must reveal nothing on a fold-out');

  for (const viewerSeat of [0, 1, null]) {
    const view = redactFor(state, { viewerSeat });

    // The guard must be doing work: the viewer's own cards ARE in this view. A test where
    // there was nothing to leak would pass without proving anything.
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

  // The folder acted preflop, so it was offered a decision and declined to enter.
  assert.equal(seatOf(observations, folder).handsSeen, 1);
  assert.equal(seatOf(observations, folder).handsVoluntarilyEntered, 0);
  // The other seat never got a turn, so it cannot have declined to enter and is not counted.
  // Dividing by hands dealt instead would measure button rotation, not an entry threshold.
  assert.equal(observations.bySeat.get(other), undefined);
  assert.equal(observations.handsObserved, 1);
});

// ---------------------------------------------------------------------------
// 2. Public information only: the observer's identity cannot change the counters
// ---------------------------------------------------------------------------

test('a shown-down hand records exactly the hands that were shown', () => {
  // Three seats, button 0: blinds are seats 1 and 2, and seat 0 acts first preflop.
  const dealt = dealHand(3, 'showdown', 23);
  const folder = currentActor(dealt);
  const state = passiveToCompletion(act(dealt, { type: 'fold' }));

  assert.equal(state.street, 'complete');
  const shownSeats = (state.result?.showdowns ?? []).map((showdown) => showdown.seat).sort();
  assert.equal(shownSeats.length, 2, 'two seats should reach the showdown');
  assert.ok(!shownSeats.includes(folder), 'the folder must not appear in the showdown list');

  const observations = observeHandComplete(emptyObservations(), redactFor(state, { viewerSeat: folder }));

  // The folder's OWN view contains the folder's own cards, and still records none of them.
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

  // Exactly one of the two showdown seats can have driven the betting, and in a hand that was
  // checked down neither did.
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
    // Any dependence on who is looking is a dependence on private information, whatever the
    // input types say.
    assert.deepStrictEqual(other, first);
  }
});

// ---------------------------------------------------------------------------
// 3. Counter arithmetic, worked out by hand
// ---------------------------------------------------------------------------

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
  // No 3-bet spot ever arose, so the rate is 0 over an empty denominator rather than NaN.
  assert.equal(stats.threeBetFrequency, 0);
  // Nothing was shown down in a synthetic hand, so `result` was null and no cards exist here.
  assert.equal(stats.wentToShowdown, 0);
  assert.equal(seat.showdownHands.length, 0);

  // 40 hands is exactly the `indicative` floor.
  assert.equal(stats.reliability, 'indicative');
  assert.equal(stats.reliability, reliabilityFor(40));
});

// ---------------------------------------------------------------------------
// 4. A small sample says little
// ---------------------------------------------------------------------------

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

  // A seat nobody has observed is also unknown, rather than a table of zeroes.
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
    // Strictly shrinking: more hands can only narrow the interval.
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
  // There is no band above `reasonable`: counting public actions never earns certainty.
  assert.equal(at(400).reliability, 'reasonable');
});

// ---------------------------------------------------------------------------
// 5. Bounded memory
// ---------------------------------------------------------------------------

test('the bet-size window never exceeds its cap over 10,000 observations', () => {
  let observations = emptyObservations();
  const total = 10_000;
  for (let index = 0; index < total; index++) {
    // A distinct size each time, so the contents can be checked as well as the length.
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
  // Newest last, oldest dropped: the window holds observations 9937..10000 as pot fractions.
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
    // Same real hand, re-labelled: a genuine showdown list every time.
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
    // The counter is unbounded even though the window is not.
    assert.equal(seatOf(observations, seat).showdownsReached, total);
  }
});

// ---------------------------------------------------------------------------
// 6. Immutability
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 7. Range estimation
// ---------------------------------------------------------------------------

/** Builds `hands` observed hands for one seat, `entered` of them voluntarily by calling. */
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
  // The slice really is around the observed entry rate, not an arbitrary constant.
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

  // Widening can walk back towards the entry range but never past it: a seat's range on a
  // later street is a subset of what it entered with. Preflop is the only place the cap can
  // bite, because there `keep ** 0` is 1 and the check multiplier is above 1.
  assert.equal(combos('preflop', 'check'), combos('preflop', 'none'));
});

/** `hands` observed hands for one seat, every one entered and every flop bet called. */
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
 * An insufficient sample must be ignored on EVERY street, not just the one where it is free.
 *
 * The test this replaces asserted the same rule at `('preflop', 'none')` only, and preflop is
 * the one street where it could not fail: `streetsOfBetting` is 0 there, `keep ** 0` is 1, and
 * the per-street keep factor — the term that was reading the insufficient sample's own
 * fold-to-bet rate — drops out of the arithmetic entirely. A guard that can only be satisfied
 * is not a guard.
 *
 * Measured with this exact 25-hand sample before the fix: preflop 334 combos (correct, and
 * the reason nothing caught it), flop 300 against a neutral 184, turn 272 against 106, and
 * river 244 combos / 18.40% against a neutral 56 / 4.22% — 4.4x wider, from a sample the
 * module's own doc comment says it ignores. After: identical to neutral on all four.
 */
test('an insufficient sample cannot move the range off the baseline assumption, on any street', () => {
  const base = completedBaseView();
  // 25 hands: past the null floor, still `insufficient`. Entered every hand AND called every
  // flop bet, so it pushes both terms — entry width and per-street keep — as far as they go.
  const veryLoose = statsOf(seatThatNeverFolds(base, 1, 25), 1);
  assert.equal(veryLoose.reliability, 'insufficient');
  assert.equal(veryLoose.vpip, 1, 'this seat entered every single observed hand');
  assert.equal(veryLoose.foldToBetFrequency, 0, 'and folded to none of the bets it faced');

  // The baseline vpip is 0.25, so the entry range is the top 25% and not the top 100%.
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

  // The neutral river range really is narrow, so the assertion above is not passing because
  // every street collapsed to the same number. Before the fix this seat's river range was 244.
  assert.equal(estimateRange(neutralStats(1), 'river', 'none', 1).combos.length, 56);
});

/**
 * The gate defect 1 closed: a range is an adaptation, and it has to be scaled like one.
 *
 * `exploitAdjustments` was scaled by `adaptation x RELIABILITY_WEIGHT` and `estimateRange` was
 * scaled by neither, so a profile with adaptation 0 — which is every profile at the
 * `educational` difficulty — still played against a range built from what it had watched.
 * Negative control: at adaptation 0 the station and the rock below produced 300 and 84 combos
 * on the flop respectively; they must now both produce the neutral 184.
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

  // And the gate is a gate, not a mute: at full adaptation the two reads are far apart, so a
  // fix that simply stopped reading the sample would fail here.
  assert.ok(
    estimateRange(station, 'flop', 'none', 1).combos.length >
      estimateRange(rock, 'flop', 'none', 1).combos.length + 100,
  );
  // Half adaptation lands between the two, so the weight is a blend and not a switch.
  const half = estimateRange(station, 'flop', 'none', 0.5).combos.length;
  const neutralFlop = estimateRange(neutralStats(1), 'flop', 'none', 1).combos.length;
  assert.ok(half > neutralFlop && half < estimateRange(station, 'flop', 'none', 1).combos.length);
});

test('estimateRange rejects a street, an action or an adaptation it does not model', () => {
  const stats = neutralStats(2);
  assert.throws(() => estimateRange(stats, 'showdown', 'none', 1), ObservationError);
  assert.throws(() => estimateRange(stats, 'complete', 'none', 1), ObservationError);
  assert.throws(() => estimateRange(stats, 'flop', 'shove', 1), ObservationError);
  // The same validation `exploitAdjustments` applies, for the same reason: a trait quietly
  // clamped from 1.4 makes a profile behave differently from what its card claims.
  assert.throws(() => estimateRange(stats, 'flop', 'none', 1.4), ObservationError);
  assert.throws(() => estimateRange(stats, 'flop', 'none', -0.1), ObservationError);
  assert.throws(() => estimateRange(stats, 'flop', 'none', Number.NaN), ObservationError);
  assert.doesNotThrow(() => estimateRange(stats, 'flop', 'none', 1));
});

// ---------------------------------------------------------------------------
// 8. Exploit adjustments
// ---------------------------------------------------------------------------

/** Frequencies for a station: calls far too much, shows down constantly, limps in wide. */
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

  // No stats at all behaves the same way, and says so.
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

  // Every multiplier sits between neutral and the full adjustment.
  assert.ok(Math.abs(half.valueBetThinner - 1) < Math.abs(full.valueBetThinner - 1));
  assert.ok(Math.abs(half.valueBetThinner - 1) > 0);
  // adaptation 0.5 at `reasonable` and adaptation 1 at `indicative` are the same weight, 0.5.
  assert.ok(Math.abs(indicative.valueBetThinner - half.valueBetThinner) < 1e-12);
});

test('exploitAdjustments rejects an adaptation that is not a trait value', () => {
  const stats = stationStats();
  assert.throws(() => exploitAdjustments(stats, 1.4), ObservationError);
  assert.throws(() => exploitAdjustments(stats, -0.1), ObservationError);
  assert.throws(() => exploitAdjustments(stats, Number.NaN), ObservationError);
});

// ---------------------------------------------------------------------------
// 9. Validation and the double-count guards
// ---------------------------------------------------------------------------

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
  // The unions make these unreachable in typed code; the runtime check is for callers
  // crossing a wire boundary, where the string could be anything.
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
  // A different hand is fine, and the counters carry on.
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

// ---------------------------------------------------------------------------
// 10. No generated string can impersonate anyone
// ---------------------------------------------------------------------------

test('no reachable combination of frequencies produces text the impersonation guard rejects', () => {
  // `assertNoImpersonation` runs at generation time, so a note that would fail it throws
  // rather than being returned. That makes this a sweep for a *generator* bug: if any point
  // in the reachable input space produces rejected text, this test throws where it is built.
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

// ---------------------------------------------------------------------------
// 11. The handle
// ---------------------------------------------------------------------------

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

  // No read yet, so the handle falls back to the neutral assumption rather than to null.
  assert.equal(model.statsFor(1), null);
  assert.equal(model.statsOrNeutralFor(1).reliability, 'insufficient');
  assert.equal(model.adjustmentsFor(1, 1).bluffMore, 1);
  assert.ok(model.rangeFor(1, 'preflop', 'none', 1).combos.length > 0);

  assert.throws(() => createOpponentModel(-1), ObservationError);
});

/**
 * `statsOrNeutralFor` must fall back across the whole `insufficient` band, not just the `null`
 * floor.
 *
 * These are two different thresholds — `derivedStats` returns null below 20 hands, while
 * `insufficient` runs to 40 — and the `?? neutralStats` that used to stand here caught only
 * the first. Negative control: at 25 hands of a seat that entered every pot, this returned the
 * raw vpip of 1 and fold-to-bet of 0. `ObservedSeatTendencies` documents that a caller cannot
 * lean on such a read, and the `opponents` getter is built from this method, so the doc was
 * false for the 20-to-39-hand window.
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
  // And the `opponents` list, which is what the doc comment promises, agrees — while still
  // reporting the true hand count so a caller can see why.
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

  // Seats 1 and 3 entered every observed hand, and their 200-hand sample is reliable.
  assert.equal(opponents[0]?.handsObserved, 200);
  assert.equal(opponents[0]?.vpip, 1);
  // Seat 4 has 5 hands, so the numbers it contributes are the neutral baseline, not 1.0 —
  // a policy that forgets to look at `handsObserved` still cannot act on 5 hands.
  assert.equal(opponents[2]?.handsObserved, 5);
  assert.equal(opponents[2]?.vpip, neutralStats(4).vpip);
  assert.equal(opponents[2]?.foldToBetFrequency, neutralStats(4).foldToBetFrequency);
});
