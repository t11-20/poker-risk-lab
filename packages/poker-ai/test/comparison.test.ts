/**
 * Comparison tests. Two comparisons of the same decisions that differ only in run-out and chip result
 * must have byte-identical quality figures. Band boundaries are asserted at the threshold and either
 * side, in chips and in big blinds. The serialised comparison is scanned for the model's hole cards.
 * Reports are built here, not by `@prl/poker-math`, because a boundary test needs an EV of exactly
 * 0.5 big blinds. The hands are real engine hands.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionCandidate, CoachReport } from '@prl/contracts';
import {
  type Action,
  applyAction,
  type Card,
  cardsToString,
  cardToString,
  createDeterministicRandomForTests,
  type HandState,
  type PlayerView,
  redactFor,
  startHand,
  type TableConfig,
} from '@prl/poker-engine';
import type { PolicyDecisionSummary } from '../src/commentary.ts';
import {
  analysisEvaluatedAction,
  bandForShortfall,
  buildHandComparison,
  ComparisonError,
  QUALITY_BANDS_IN_BIG_BLINDS,
  type RecordedDecision,
  scoreDecisionQuality,
} from '../src/comparison.ts';
import { findImpersonation, profileDisclosure } from '../src/labelling.ts';
import { expressTraits, requireProfile } from '../src/profiles.ts';
import type { Traits } from '../src/traits.ts';

const BIG_BLIND = 2;

// The report and candidate factories are duplicated from `test/commentary.test.ts` on purpose.

function table(): TableConfig {
  return { smallBlind: 1, bigBlind: BIG_BLIND, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 };
}

function candidate(action: ActionCandidate['action'], ev: number, to?: number): ActionCandidate {
  return {
    action,
    ...(to === undefined ? {} : { to }),
    cost: to ?? 0,
    ev,
    derivation: 'A test derivation.',
  };
}

function coachReport(options: {
  readonly candidates: readonly ActionCandidate[];
  readonly toCall?: number;
  readonly pot?: number;
  readonly outsCards?: readonly string[];
}): CoachReport {
  const pot = options.pot ?? 60;
  const toCall = options.toCall ?? 20;
  const best = [...options.candidates].sort((left, right) => right.ev - left.ev)[0];
  if (best === undefined) throw new Error('a test report needs at least one candidate');
  return {
    street: 'flop',
    potTotal: pot,
    toCall,
    outs:
      options.outsCards === undefined
        ? null
        : {
            clean: options.outsCards.length,
            dirty: 0,
            total: options.outsCards.length,
            cleanCards: options.outsCards,
            dirtyCards: [],
            explanation: 'A test outs breakdown, listing cards the learner already holds or can see.',
          },
    equity: {
      heroEquity: 0.42,
      method: 'exact-enumeration',
      trials: 1_070_190,
      confidenceHalfWidthPoints: null,
      ruleOfThumb: null,
      perPlayer: [
        { label: 'you', equity: 0.42, win: 0.4, tie: 0.02 },
        { label: 'an opponent', equity: 0.58, win: 0.56, tie: 0.02 },
      ],
    },
    potOdds: {
      pot,
      toCall,
      breakEvenEquity: toCall === 0 ? 0 : toCall / (pot + toCall),
      // `null`, not `0`. A free call has no price, and 0 would be the worst one.
      oddsRatio: toCall === 0 ? null : pot / toCall,
      equitySurplus: 0,
      explanation: 'A test price.',
    },
    candidates: options.candidates,
    suggestion: {
      action: best.action,
      confidence: 'moderate',
      reason: 'A test suggestion, with a confidence that is not certainty.',
      whatWouldChangeIt: ['A different range assumption would move every figure here.'],
    },
    stackContext: {
      effectiveStack: 200,
      spr: 3.3,
      potOddsOfferedByPotSizedBet: 0.33,
      explanation: 'A test stack context.',
    },
    assumptions: ['Every figure here was chosen by the test so the arithmetic is the assertion.'],
    uncertainty: {
      method: 'exact-enumeration',
      summary: 'A test uncertainty note.',
      confidenceInterval: null,
      limitations: ['This report exists to pin band boundaries.'],
    },
    teachingNotes: [],
  };
}

interface RecordedHand {
  readonly decisions: readonly RecordedDecision[];
  readonly board: readonly Card[];
  readonly modelCards: readonly Card[];
  readonly userCards: readonly Card[];
}

/** Model seats get a decision summary over the actions the engine offered in that view. */
function recordHand(options: {
  readonly stacks: readonly number[];
  readonly script: readonly Action[];
  readonly userSeat: number;
  readonly seed: number;
  readonly profileId?: string;
}): RecordedHand {
  const profile = requireProfile(options.profileId ?? 'patient-technician');
  const traits = expressTraits(profile, 'realistic');
  let { state } = startHand({
    handId: 'hand-under-review',
    roomId: 'room-1',
    handNumber: 4,
    config: table(),
    buttonSeat: 0,
    seats: options.stacks.map((stack, index) => ({ seat: index, playerId: `p${index}`, stack })),
    random: createDeterministicRandomForTests(options.seed),
  });

  const decisions: RecordedDecision[] = [];
  for (const action of options.script) {
    const seat = state.toAct;
    if (seat === null) throw new Error('the scripted hand ended before the script did');
    const view = redactFor(state, { viewerSeat: seat });
    const isUser = seat === options.userSeat;
    decisions.push({
      sequence: state.actionSequence + 1,
      seat,
      action,
      view,
      decision: isUser ? null : modelDecision(view, action, traits),
    });
    state = applyAction(state, seat, action).state;
  }

  return {
    decisions,
    board: state.board,
    modelCards: cardsOf(state, options.userSeat === 0 ? 1 : 0),
    userCards: cardsOf(state, options.userSeat),
  };
}

function cardsOf(state: HandState, seat: number): readonly Card[] {
  const found = state.seats.find((candidateSeat) => candidateSeat.seat === seat);
  return found?.holeCards ?? [];
}

function modelDecision(view: PlayerView, action: Action, traits: Traits): PolicyDecisionSummary {
  const offered: Action[] = [];
  for (const legal of view.legalActions) {
    if (legal.type === 'fold' || legal.type === 'check' || legal.type === 'call')
      offered.push({ type: legal.type });
    else offered.push({ type: legal.type, to: legal.minTo ?? 0 });
  }
  const chosenTotal = action.type === 'bet' || action.type === 'raise' ? action.to : null;
  const pool = offered.some(
    (entry) =>
      entry.type === action.type &&
      (entry.type === 'bet' || entry.type === 'raise' ? entry.to === chosenTotal : true),
  )
    ? offered
    : [...offered, action];
  const weights = pool.map((entry) => (entry.type === action.type ? 3 : 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return {
    action,
    distribution: pool.map((entry, index) => ({ action: entry, probability: (weights[index] ?? 0) / total })),
    traits,
  };
}

/** Seat 1 is the learner and seats 0 and 2 are the model. */
function standardHand(): RecordedHand {
  return recordHand({
    stacks: [200, 200, 200],
    userSeat: 1,
    seed: 37,
    script: [
      { type: 'raise', to: 6 }, // seat 0, model
      { type: 'call' }, // seat 1, learner
      { type: 'fold' }, // seat 2, model
      { type: 'bet', to: 10 }, // flop, model
      { type: 'call' }, // learner
    ],
  });
}

const PROFILE = requireProfile('patient-technician');
const DISCLOSURE = profileDisclosure(PROFILE.naming, 'attributed');

/**
 * Built around the recorded action, because an unpriced taken action is reported unscored. The best
 * candidate is always a different action type, so the gap is a real comparison.
 */
function analyseWithGap(gapUnits: number): (decision: RecordedDecision) => CoachReport {
  return (decision) => {
    const taken = decision.action;
    const toCall = decision.view.amountToCall;
    const takenTo = taken.type === 'bet' || taken.type === 'raise' ? taken.to : undefined;
    const bestType: ActionCandidate['action'] =
      toCall === 0 ? (taken.type === 'check' ? 'bet' : 'check') : taken.type === 'call' ? 'raise' : 'call';
    const bestTo =
      bestType === 'bet' || bestType === 'raise' ? Math.max(1, decision.view.betLevel * 3) : undefined;
    const candidates: ActionCandidate[] =
      taken.type === 'fold'
        ? [candidate('fold', 0), candidate(bestType, gapUnits, bestTo)]
        : [
            candidate('fold', 0),
            candidate(taken.type, 4 - gapUnits, takenTo),
            candidate(bestType, 4, bestTo),
          ];
    return coachReport({ pot: decision.view.potTotal, toCall, candidates });
  };
}

test('the band thresholds are exactly where they are documented', () => {
  assert.equal(QUALITY_BANDS_IN_BIG_BLINDS.consistentWithAnalysis, 0.5);
  assert.equal(QUALITY_BANDS_IN_BIG_BLINDS.slightlyOff, 2);

  assert.equal(bandForShortfall(0), 'consistent-with-analysis');
  assert.equal(bandForShortfall(0.49), 'consistent-with-analysis');
  // Exactly at the boundary belongs to the tighter band.
  assert.equal(bandForShortfall(0.5), 'consistent-with-analysis');
  assert.equal(bandForShortfall(0.500001), 'slightly-off');
  assert.equal(bandForShortfall(1.999999), 'slightly-off');
  assert.equal(bandForShortfall(2), 'slightly-off');
  assert.equal(bandForShortfall(2.000001), 'materially-off');
  assert.equal(bandForShortfall(50), 'materially-off');

  // Floating-point drift must not decide a band. 0.1 + 0.4 is 0.5000000000000001.
  assert.equal(bandForShortfall(0.1 + 0.4), 'consistent-with-analysis');

  assert.throws(() => bandForShortfall(-0.1), ComparisonError);
  assert.throws(() => bandForShortfall(Number.NaN), ComparisonError);
});

test('scoreDecisionQuality converts chips to big blinds at the same boundaries', () => {
  const at = (chosenEv: number): CoachReport =>
    coachReport({
      candidates: [candidate('fold', 0), candidate('call', chosenEv, 20), candidate('raise', 5, 60)],
    });

  // Best is 5 units, the big blind is 2, so a 1-unit gap is exactly 0.5 big blinds.
  assert.equal(
    scoreDecisionQuality({ analysis: at(4), chosenAction: { type: 'call' }, bigBlind: BIG_BLIND }).band,
    'consistent-with-analysis',
  );
  assert.equal(
    scoreDecisionQuality({ analysis: at(3.999), chosenAction: { type: 'call' }, bigBlind: BIG_BLIND }).band,
    'slightly-off',
  );
  // A 4-unit gap is exactly 2 big blinds.
  assert.equal(
    scoreDecisionQuality({ analysis: at(1), chosenAction: { type: 'call' }, bigBlind: BIG_BLIND }).band,
    'slightly-off',
  );
  assert.equal(
    scoreDecisionQuality({ analysis: at(0.999), chosenAction: { type: 'call' }, bigBlind: BIG_BLIND }).band,
    'materially-off',
  );

  assert.equal(
    scoreDecisionQuality({ analysis: at(1), chosenAction: { type: 'call' }, bigBlind: 20 }).band,
    'consistent-with-analysis',
  );

  const quality = scoreDecisionQuality({
    analysis: at(4),
    chosenAction: { type: 'call' },
    bigBlind: BIG_BLIND,
  });
  assert.equal(quality.bestAvailableEv, 5);
  assert.equal(quality.chosenEv, 4);
  assert.equal(quality.evGivenUp, -1);
  assert.deepEqual(findImpersonation(quality.note), []);
  assert.match(quality.note, /0\.50 big blinds/);

  // The best action gives up exactly nothing, never a positive number.
  const bestChosen = scoreDecisionQuality({
    analysis: at(4),
    chosenAction: { type: 'raise', to: 60 },
    bigBlind: BIG_BLIND,
  });
  assert.equal(bestChosen.evGivenUp, 0);
  assert.equal(bestChosen.band, 'consistent-with-analysis');

  assert.throws(
    () => scoreDecisionQuality({ analysis: at(4), chosenAction: { type: 'call' }, bigBlind: 0 }),
    /bigBlind/,
  );
});

test('scoreDecisionQuality matches a size to the nearest one the analysis priced, and says so', () => {
  const analysis = coachReport({
    candidates: [
      candidate('fold', 0),
      candidate('raise', 1, 30),
      candidate('raise', 4, 60),
      candidate('raise', 2, 120),
    ],
  });
  const quality = scoreDecisionQuality({
    analysis,
    chosenAction: { type: 'raise', to: 70 },
    bigBlind: BIG_BLIND,
  });
  assert.equal(quality.chosenEv, 4, 'a raise to 70 is nearest the priced 60');
  assert.match(quality.note, /nearest to the 70 taken was 60/);

  const exact = scoreDecisionQuality({
    analysis,
    chosenAction: { type: 'raise', to: 60 },
    bigBlind: BIG_BLIND,
  });
  assert.ok(!exact.note.includes('nearest to the'), 'an exact size needs no caveat');
});

test('an action the analysis never priced is reported as unscored rather than scored', () => {
  const analysis = coachReport({ candidates: [candidate('fold', 0), candidate('call', 4, 20)] });
  assert.equal(analysisEvaluatedAction(analysis, { type: 'call' }), true);
  assert.equal(analysisEvaluatedAction(analysis, { type: 'check' }), false);
  assert.equal(analysisEvaluatedAction(analysis, { type: 'bet', to: 30 }), false);
  assert.throws(
    () => scoreDecisionQuality({ analysis, chosenAction: { type: 'check' }, bigBlind: BIG_BLIND }),
    /priced no "check" action/,
  );
  // A bet and a raise are different actions, and are not matched across.
  const raiseOnly = coachReport({ candidates: [candidate('fold', 0), candidate('raise', 3, 40)] });
  assert.equal(analysisEvaluatedAction(raiseOnly, { type: 'bet', to: 40 }), false);
});

test('decision quality is identical against two different outcomes', () => {
  const hand = standardHand();
  const base = {
    handId: 'hand-under-review',
    handNumber: 4,
    decisions: hand.decisions,
    userSeat: 1,
    profile: PROFILE,
    disclosure: DISCLOSURE,
    analyse: analyseWithGap(1),
  };

  const won = buildHandComparison({ ...base, board: hand.board, chipResult: 240 });
  const lost = buildHandComparison({
    ...base,
    board: hand.board.slice(0, 3),
    chipResult: -240,
  });

  assert.deepEqual(
    won.decisions.map((decision) => decision.userDecisionQuality),
    lost.decisions.map((decision) => decision.userDecisionQuality),
    'a per-decision quality that moves with the result is reading the run-out',
  );
  assert.deepEqual(won.decisionQuality, lost.decisionQuality);
  assert.deepEqual(
    won.decisions.map((decision) => decision.alternatives),
    lost.decisions.map((decision) => decision.alternatives),
  );
  assert.deepEqual(
    won.decisions.map((decision) => decision.commentary),
    lost.decisions.map((decision) => decision.commentary),
  );

  assert.notEqual(won.chipResult, lost.chipResult);
  assert.notDeepEqual(won.board, lost.board);
});

test('the two scored decisions are summed rather than averaged', () => {
  const hand = standardHand();
  const comparison = buildHandComparison({
    handId: 'hand-under-review',
    handNumber: 4,
    board: hand.board,
    decisions: hand.decisions,
    userSeat: 1,
    profile: PROFILE,
    disclosure: DISCLOSURE,
    chipResult: 0,
    analyse: analyseWithGap(0.8),
  });
  const scored = comparison.decisions.filter((decision) => decision.userDecisionQuality !== null);
  assert.equal(scored.length, 2, 'the learner acted twice in this hand');
  for (const decision of scored) {
    assert.equal(
      decision.userDecisionQuality?.band,
      'consistent-with-analysis',
      '0.4 big blinds each, on its own',
    );
  }
  // 1.6 units is 0.8 big blinds, past the closest band. A tolerance because the float sum is
  // -1.5999999999999996.
  assert.ok(Math.abs(comparison.decisionQuality.evGivenUp + 1.6) < 1e-9);
  assert.equal(comparison.decisionQuality.band, 'slightly-off');
  assert.match(comparison.decisionQuality.note, /summed rather than averaged/);
  assert.deepEqual(findImpersonation(comparison.decisionQuality.note), []);
});

test('a hand with nothing scored says so, and produces no outcome-versus-quality note', () => {
  const hand = standardHand();
  const comparison = buildHandComparison({
    handId: 'hand-under-review',
    handNumber: 4,
    board: hand.board,
    decisions: hand.decisions,
    userSeat: 1,
    profile: PROFILE,
    disclosure: DISCLOSURE,
    chipResult: -180,
    analyse: () => null,
  });
  assert.equal(comparison.decisionQuality.evGivenUp, 0);
  assert.equal(comparison.decisionQuality.band, 'consistent-with-analysis');
  assert.match(comparison.decisionQuality.note, /carries no information about the hand/);
  // A loss plus an unmeasured "consistent" band would otherwise congratulate the learner for nothing.
  assert.equal(comparison.outcomeVersusQualityNote, null);
  for (const decision of comparison.decisions) {
    assert.equal(decision.userDecisionQuality, null);
    assert.deepEqual(decision.alternatives, []);
  }
});

test('the outcome-versus-quality note appears on a scored hand where the two disagree', () => {
  const hand = standardHand();
  const base = {
    handId: 'hand-under-review',
    handNumber: 4,
    board: hand.board,
    decisions: hand.decisions,
    userSeat: 1,
    profile: PROFILE,
    disclosure: DISCLOSURE,
  };
  const wellPlayedLoss = buildHandComparison({ ...base, chipResult: -180, analyse: analyseWithGap(0) });
  assert.equal(wellPlayedLoss.decisionQuality.band, 'consistent-with-analysis');
  assert.ok(wellPlayedLoss.outcomeVersusQualityNote !== null);
  assert.match(wellPlayedLoss.outcomeVersusQualityNote, /Both of those are true at the same time/);

  const badlyPlayedWin = buildHandComparison({ ...base, chipResult: 180, analyse: analyseWithGap(4) });
  assert.equal(badlyPlayedWin.decisionQuality.band, 'materially-off');
  assert.ok(badlyPlayedWin.outcomeVersusQualityNote !== null);
  assert.match(badlyPlayedWin.outcomeVersusQualityNote, /does not settle that/);

  const agreeing = buildHandComparison({ ...base, chipResult: 180, analyse: analyseWithGap(0) });
  assert.equal(agreeing.outcomeVersusQualityNote, null);
});

test('only the learner’s own decisions are analysed', () => {
  const hand = standardHand();
  const asked: number[] = [];
  const comparison = buildHandComparison({
    handId: 'hand-under-review',
    handNumber: 4,
    board: hand.board,
    decisions: hand.decisions,
    userSeat: 1,
    profile: PROFILE,
    disclosure: DISCLOSURE,
    chipResult: 12,
    analyse: (decision) => {
      asked.push(decision.seat);
      return analyseWithGap(1)(decision);
    },
  });
  assert.deepEqual(new Set(asked), new Set([1]), 'a model seat must never be handed to the analyser');

  for (const decision of comparison.decisions) {
    const isUser = decision.userAction !== null;
    assert.equal(decision.modelAction === null, isUser);
    assert.equal(decision.analysis === null, !isUser, 'a model decision carries no analysis');
    if (isUser) {
      assert.equal(decision.modelReasoning, null);
    } else {
      assert.ok(decision.modelReasoning !== null, 'a model decision carries its reasoning instead');
      assert.deepEqual(findImpersonation(decision.modelReasoning.modelPreference), []);
    }
    assert.deepEqual(findImpersonation(decision.commentary), []);
    for (const alternative of decision.alternatives)
      assert.deepEqual(findImpersonation(alternative.note), []);
  }
});

test('no card the learner could not see appears anywhere in the comparison', () => {
  const hand = standardHand();
  // The learner's own analysis lists their own outs, which they may see.
  const comparison = buildHandComparison({
    handId: 'hand-under-review',
    handNumber: 4,
    board: hand.board,
    decisions: hand.decisions,
    userSeat: 1,
    profile: PROFILE,
    disclosure: DISCLOSURE,
    chipResult: 12,
    analyse: (decision) =>
      coachReport({
        pot: decision.view.potTotal,
        toCall: decision.view.amountToCall,
        candidates: [candidate('fold', 0), candidate('call', 3, decision.view.betLevel)],
        outsCards: hand.userCards.map(cardToString),
      }),
  });

  const serialised = JSON.stringify(comparison);
  for (const card of hand.modelCards) {
    const token = cardToString(card);
    assert.ok(
      !new RegExp(`(?:^|[^\\p{L}])${token}(?:[^\\p{L}]|$)`, 'u').test(serialised),
      `the model's card ${token} reached the learner's review (model held ${cardsToString(hand.modelCards)})`,
    );
  }
  // The public board is present, so this test cannot pass on an empty object.
  for (const card of hand.board) assert.ok(comparison.board.includes(cardToString(card)));
  assert.ok(hand.modelCards.length === 2 && hand.userCards.length === 2);
});

test('a recorded decision must carry the acting seat’s own view of the right hand', () => {
  const hand = standardHand();
  const first = hand.decisions[0];
  assert.ok(first !== undefined);
  const base = {
    handId: 'hand-under-review',
    handNumber: 4,
    board: hand.board,
    userSeat: 1,
    profile: PROFILE,
    disclosure: DISCLOSURE,
    chipResult: 0,
    analyse: () => null,
  };

  const foreignView: PlayerView = { ...first.view, viewerSeat: 2 };
  assert.throws(
    () => buildHandComparison({ ...base, decisions: [{ ...first, view: foreignView }] }),
    /own view/,
  );
  assert.throws(
    () =>
      buildHandComparison({ ...base, decisions: [{ ...first, view: { ...first.view, handId: 'other' } }] }),
    /belongs to hand other/,
  );
  assert.throws(
    () => buildHandComparison({ ...base, decisions: [{ ...first, view: { ...first.view, toAct: 2 } }] }),
    /the view has seat 2 to act/,
  );
  assert.throws(
    () => buildHandComparison({ ...base, decisions: [{ ...first, action: { type: 'check' } }] }),
    /did not offer "check"/,
  );
  const second = hand.decisions[1];
  assert.ok(second !== undefined);
  assert.throws(
    () => buildHandComparison({ ...base, decisions: [second, first] }),
    /sequences must strictly increase/,
  );
});

test('a comparison refuses inputs that cannot describe a hand', () => {
  const hand = standardHand();
  const base = {
    handId: 'hand-under-review',
    handNumber: 4,
    board: hand.board,
    decisions: hand.decisions,
    userSeat: 1,
    profile: PROFILE,
    disclosure: DISCLOSURE,
    chipResult: 0,
    analyse: () => null,
  };
  assert.throws(() => buildHandComparison({ ...base, decisions: [] }), /at least one recorded decision/);
  assert.throws(() => buildHandComparison({ ...base, board: hand.board.slice(0, 2) }), /0, 3, 4 or 5 cards/);
  assert.throws(() => buildHandComparison({ ...base, chipResult: Number.NaN }), /chipResult must be finite/);

  const first = hand.decisions[0];
  const rest = hand.decisions.slice(1);
  assert.ok(first !== undefined);
  const shifted = rest.map((decision) => ({
    ...decision,
    view: { ...decision.view, config: { ...decision.view.config, bigBlind: 10 } },
  }));
  assert.throws(
    () => buildHandComparison({ ...base, decisions: [first, ...shifted] }),
    /disagree on the big blind/,
  );
});

test('alternatives list the other priced actions, including the other sizes', () => {
  const hand = standardHand();
  const analysis = coachReport({
    candidates: [
      candidate('fold', 0),
      candidate('call', 3, 6),
      candidate('raise', 1, 18),
      candidate('raise', 4, 40),
    ],
  });
  const comparison = buildHandComparison({
    handId: 'hand-under-review',
    handNumber: 4,
    board: hand.board,
    decisions: hand.decisions,
    userSeat: 1,
    profile: PROFILE,
    disclosure: DISCLOSURE,
    chipResult: 0,
    analyse: () => analysis,
  });
  const userDecision = comparison.decisions.find((decision) => decision.userAction !== null);
  assert.ok(userDecision !== undefined);
  assert.equal(userDecision.userAction?.action, 'call');
  assert.equal(userDecision.alternatives.length, 3, 'the action taken is excluded, the other sizes are not');
  assert.deepEqual(userDecision.alternatives.map((alternative) => alternative.action).sort(), [
    'fold',
    'raise',
    'raise',
  ]);
  const fold = userDecision.alternatives.find((alternative) => alternative.action === 'fold');
  assert.match(fold?.note ?? '', /zero point/);
  const ahead = userDecision.alternatives.find((alternative) => alternative.ev === 4);
  assert.match(ahead?.note ?? '', /1\.0 units ahead of the action taken/);
});

test('the comparison carries the profile identity as data and never in prose', () => {
  const hand = standardHand();
  const comparison = buildHandComparison({
    handId: 'hand-under-review',
    handNumber: 4,
    board: hand.board,
    decisions: hand.decisions,
    userSeat: 1,
    profile: PROFILE,
    disclosure: DISCLOSURE,
    chipResult: 0,
    analyse: analyseWithGap(1),
  });
  assert.equal(comparison.profileId, PROFILE.naming.id);
  assert.equal(comparison.disclosure.displayName, DISCLOSURE.displayName);
  assert.ok(comparison.disclosure.disclaimers.length >= 2, 'an attributed profile carries both disclaimers');
  assert.equal(comparison.handNumber, 4);
  assert.deepEqual(comparison.board, hand.board.map(cardToString));

  // The attributed name is in the disclosure and nowhere else.
  const attributed = PROFILE.naming.attributedName;
  assert.ok(attributed !== undefined);
  for (const decision of comparison.decisions) {
    assert.ok(!decision.commentary.includes(attributed));
    assert.ok(!(decision.modelReasoning?.modelPreference ?? '').includes(attributed));
    for (const line of decision.modelReasoning?.whatChangedIt ?? []) assert.ok(!line.includes(attributed));
  }
});

test('a per-seat profile override drives the reasoning for that seat', () => {
  const hand = standardHand();
  const other = requireProfile('calling-station');
  const otherDisclosure = profileDisclosure(other.naming, 'archetype');
  const decisions = hand.decisions.map((decision) =>
    decision.seat === 2 && decision.decision !== null
      ? {
          ...decision,
          profile: other,
          disclosure: otherDisclosure,
          decision: { ...decision.decision, traits: expressTraits(other, 'realistic') },
        }
      : decision,
  );
  const comparison = buildHandComparison({
    handId: 'hand-under-review',
    handNumber: 4,
    board: hand.board,
    decisions,
    userSeat: 1,
    profile: PROFILE,
    disclosure: DISCLOSURE,
    chipResult: 0,
    analyse: () => null,
  });
  const seatTwo = comparison.decisions[2];
  assert.ok(seatTwo !== undefined);
  const reasoning = seatTwo.modelReasoning;
  assert.ok(reasoning !== null);
  const overridden = expressTraits(other, 'realistic');
  const fallback = expressTraits(PROFILE, 'realistic');
  let differed = false;
  for (const driving of reasoning.drivingTraits) {
    assert.equal(
      driving.value,
      overridden[driving.key],
      'the seat’s own profile must supply the values quoted',
    );
    if (overridden[driving.key] !== fallback[driving.key]) differed = true;
  }
  assert.ok(differed, 'the override should quote values the default profile would not have produced');
});
