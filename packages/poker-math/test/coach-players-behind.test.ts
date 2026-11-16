/**
 * A call with opponents still to act behind it. The equity counts every opponent to the river and
 * the price counts none of their chips, so the call row is the least a call can be worth if nobody
 * raises. River, board Ks 9d 5c 2h 2s, hero Kc Qh: A holds Jc Th, which hero beats, and B holds
 * one of 9 combinations, 3 of them JJ that hero beats and 6 full houses. Every share is exact.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeterministicRandomForTests, parseCards, redactFor, startHand } from '@prl/poker-engine';
import { buildCoachReport, type CoachInput, type OpponentStack } from '../src/coach.ts';
import { coachInputFor, coachSpotForView, LIVE_COACH_POLICY } from '../src/coach-view.ts';
import { exactRange, parseRange } from '../src/ranges.ts';

const DEAD = parseCards('Kc Qh Jc Th Ks 9d 5c 2h 2s');
const A = { label: 'A', range: exactRange(parseCards('Jc Th')) };
const B = { label: 'B', range: parseRange('JJ,99,55', DEAD) };

/** A overbets 90 into 60. B, to act after hero, owes the whole 90. */
const B_TO_ACT: readonly OpponentStack[] = [
  { behind: 810, committedThisStreet: 90 },
  { behind: 900, committedThisStreet: 0 },
];

function facingOverbet(spot: Partial<CoachInput> = {}) {
  return buildCoachReport({
    heroCards: parseCards('Kc Qh'),
    board: parseCards('Ks 9d 5c 2h 2s'),
    street: 'river',
    opponents: [A, B],
    pot: 150,
    contestablePot: 150,
    toCall: 90,
    heroCommittedThisStreet: 0,
    heroStack: 900,
    opponentStacks: B_TO_ACT,
    bigBlind: 10,
    ...spot,
  });
}

function callEv(report: ReturnType<typeof buildCoachReport>): number {
  const row = report.candidates.find((entry) => entry.action === 'call');
  assert.ok(row !== undefined, 'no call row');
  return row.ev;
}

test('a fold that only the missing chips of the seat behind decide is low confidence, and says so', () => {
  const report = facingOverbet();
  // 3 of 9: 1/3 against both. Price 90 / 240 = 37.5%, so the call is 240/3 - 90 = -10. If B calls
  // too, the pot is 330 and the call needs 90 / 330 = 27.3%, worth 330/3 - 90 = +20.
  assert.ok(Math.abs(report.equity.heroEquity - 1 / 3) < 1e-12);
  assert.ok(Math.abs(callEv(report) - -10) < 1e-9, 'the call row keeps its figure');
  assert.equal(report.potOdds.breakEvenEquity, 90 / 240);
  assert.equal(report.suggestion.action, 'fold');
  assert.equal(report.suggestion.confidence, 'low');
  assert.match(report.potOdds.explanation, /There is 1 player still to act after you/);
  assert.match(
    report.potOdds.explanation,
    /If they call too, the pot you play for is 330 and a call needs 27\.3%/,
  );
  assert.match(report.suggestion.reason, /leaves out what the player still to act would put in/);
  assert.ok(
    report.suggestion.whatWouldChangeIt.some((line) => /27\.3%, which your 33\.3% clears/.test(line)),
    report.suggestion.whatWouldChangeIt.join('\n'),
  );
  assert.ok(
    report.uncertainty.limitations.some((line) =>
      /the price leaves out what the player still to act would put in/.test(line),
    ),
    report.uncertainty.limitations.join('\n'),
  );
});

test('a call with a seat still to act names the raise it does not model, and keeps its confidence', () => {
  // B holds JJ or 99, so hero wins half: 240/2 - 90 = +30, three big blinds over folding.
  const report = facingOverbet({
    opponents: [A, { label: 'B', range: parseRange('JJ,99', DEAD) }],
    legalActions: ['fold', 'call'],
  });
  assert.ok(Math.abs(callEv(report) - 30) < 1e-9);
  assert.equal(report.suggestion.action, 'call');
  assert.equal(report.suggestion.confidence, 'reasonable');
  assert.ok(
    report.suggestion.whatWouldChangeIt.some((line) =>
      /A raise from the player still to act is not modelled\. A call that is raised and then folded loses the 90/.test(
        line,
      ),
    ),
    report.suggestion.whatWouldChangeIt.join('\n'),
  );
});

test('control: the same figures with B already in for the bet keep the reading and its confidence', () => {
  // B has called 90 already, so the pot is 240 and the price 90 / 330: +20, a call, nothing owed.
  const report = facingOverbet({
    pot: 240,
    contestablePot: 240,
    opponentStacks: [
      { behind: 810, committedThisStreet: 90 },
      { behind: 810, committedThisStreet: 90 },
    ],
  });
  assert.ok(Math.abs(callEv(report) - 20) < 1e-9);
  assert.equal(report.suggestion.action, 'call');
  assert.doesNotMatch(report.potOdds.explanation, /still to act/);
  assert.ok(report.uncertainty.limitations.some((line) => /all of them see the river/.test(line)));
});

test('control: a fold that stays a fold when the seat behind calls keeps its confidence', () => {
  // B holds only full houses, so hero never wins and the call loses 90 whatever B does.
  const report = facingOverbet({ opponents: [A, { label: 'B', range: parseRange('99,55', DEAD) }] });
  assert.equal(report.equity.heroEquity, 0);
  assert.equal(report.suggestion.action, 'fold');
  assert.equal(report.suggestion.confidence, 'reasonable');
  assert.match(
    report.potOdds.explanation,
    /There is 1 player still to act after you/,
    'the price still names the gap',
  );
  assert.ok(!report.suggestion.whatWouldChangeIt.some((line) => /clears/.test(line)));
});

test('control: a Lab spot with one range for several seats names no seat behind', () => {
  // The Lab sends one continuing range and every seat's stack, so seats cannot be matched to ranges.
  const report = facingOverbet({ opponents: [B] });
  assert.doesNotMatch(report.potOdds.explanation, /still to act/);
  assert.notEqual(report.suggestion.confidence, 'low');
});

test('live table: first to act five-handed, the price names the three seats still to act', () => {
  const { state } = startHand({
    handId: 'h',
    roomId: 'r',
    handNumber: 1,
    config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 6, actionTimeoutSeconds: 60 },
    buttonSeat: 4,
    seats: [0, 1, 2, 3, 4].map((seat) => ({ seat, playerId: `p${seat}`, stack: 1000 })),
    random: createDeterministicRandomForTests(3),
  });
  assert.equal(state.toAct, 2, 'seat 2 is first to act');
  const reading = coachSpotForView(redactFor(state, { viewerSeat: 2 }), LIVE_COACH_POLICY);
  assert.equal(reading.kind, 'spot');
  if (reading.kind !== 'spot') return;
  const report = buildCoachReport(coachInputFor(reading.spot));
  // 15 in, 10 to call. Two seats owe 10 and the small blind 5: 15 + 10 + 25 = 50, so 10 / 50 = 20%.
  assert.equal(report.potOdds.breakEvenEquity, 0.4);
  assert.match(report.potOdds.explanation, /There are 3 players still to act after you/);
  assert.match(report.potOdds.explanation, /the pot you play for is 50 and a call needs 20%/);
});
