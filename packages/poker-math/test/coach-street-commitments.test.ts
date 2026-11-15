/**
 * What an opponent has already put in this street still counts: it caps what a raise can be called
 * for, and it is part of what can change hands. Expected figures are worked by hand in comments.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport, type CoachInput, type OpponentStack } from '../src/coach.ts';
import { exactRange } from '../src/ranges.ts';

function assertChips(actual: number | undefined, expected: number, what: string): void {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 1e-6,
    `${what}: expected ${expected}, got ${actual}`,
  );
}

/**
 * Hero's set of queens on Qh 7h 2c 3d. Against the nut flush draw alone hero wins 37 of 44 rivers.
 * With a set of sevens as well, the seven non-pairing hearts and the 7d beat hero: 34/42 = 17/21.
 */
function setOfQueens(opponentStacks: readonly OpponentStack[], spot: Partial<CoachInput>): CoachInput {
  const draw = { label: 'the draw', range: exactRange(parseCards('Ah Kh')) };
  const sevens = { label: 'the sevens', range: exactRange(parseCards('7s 7c')) };
  const pot = spot.pot ?? 0;
  return {
    heroCards: parseCards('Qs Qd'),
    board: parseCards('Qh 7h 2c 3d'),
    street: 'turn',
    opponents: opponentStacks.length === 1 ? [draw] : [draw, sevens],
    pot,
    contestablePot: pot,
    toCall: 0,
    heroCommittedThisStreet: 0,
    heroStack: 1000,
    opponentStacks,
    bigBlind: 10,
    assumedFoldEquity: 0.35,
    ...spot,
  };
}

test('multiway, a raise is capped by what a seat can add above the bet, not by its chips behind', () => {
  // The draw bet 100 with 400 behind. The sevens have not acted and hold 450, so to call a raise to
  // 1000 they pay 100 to match the bet and can add only 350 above it. The draw can add 400.
  //   EV = 0.35 x 300 + 0.65 x [ (17/21) x (300 + 100 + 2 x 400) - 500 ] = 105 + 0.65 x 471.4285714
  //      = 411.4285714.
  // Capped at the 450 behind it read 105 + 0.65 x [ (17/21) x 1300 - 550 ] = 431.55.
  const input = setOfQueens(
    [
      { behind: 400, committedThisStreet: 100 },
      { behind: 450, committedThisStreet: 0 },
    ],
    { pot: 300, toCall: 100 },
  );
  const report = buildCoachReport(input);
  const shove = report.candidates.find((candidate) => candidate.to === 1000);
  assert.ok(shove !== undefined, 'the all-in raise is offered');
  assertChips(report.equity.heroEquity, 17 / 21, 'hero equity');
  assertChips(shove.ev, 411.42857143, 'EV of the all-in raise');
  assert.equal(shove.cost, 500, 'the call plus the 400 the draw can match');
  assert.match(shove.derivation, /only 400 of the 900 raise can be called/);
  assert.doesNotMatch(shove.derivation, /more than 400 behind/, 'the sevens have 450 behind');
});

test('a raise no opponent can call any of is not priced as if one could', () => {
  // The draw is all in for 300 and the sevens hold 200 in all, short of the bet. The engine still
  // offers a raise, but every chip above 300 comes back, so the call row is the whole story:
  //   EV(call) = (17/21) x (400 + 300) - 300 = 266.6666667.
  const report = buildCoachReport(
    setOfQueens(
      [
        { behind: 0, committedThisStreet: 300 },
        { behind: 200, committedThisStreet: 0 },
      ],
      { pot: 400, toCall: 300 },
    ),
  );
  assert.deepEqual(
    report.candidates.filter((candidate) => candidate.action === 'raise'),
    [],
    'a raise priced on chips nobody can match',
  );
  const call = report.candidates.find((candidate) => candidate.action === 'call');
  assertChips(call?.ev, 266.66666667, 'call');
  // The table still offers a raise, so the call row says why none is priced beside it.
  assert.match(call?.derivation ?? '', /a raise plays exactly as a call/u);
});

test('heads-up facing a bet, the bettor’s chips in front of them are still in play', () => {
  // The draw bet 25 with 475 behind, so it started the street with 500, as hero did. All 500 of
  // hero's can change hands: SPR = 500 / 145 = 3.45. Main counted 475 and called hero's 25 "not in
  // play", though it is the call. The raise is priced exactly as before:
  //   EV = 0.35 x 145 + 0.65 x [ (37/44) x (145 + 25 + 950) - 500 ] = 50.75 + 0.65 x 441.8181818
  //      = 337.9318182.
  const report = buildCoachReport(
    setOfQueens([{ behind: 475, committedThisStreet: 25 }], { pot: 145, toCall: 25, heroStack: 500 }),
  );
  assert.equal(report.stackContext.effectiveStack, 500);
  assertChips(report.stackContext.spr, 500 / 145, 'SPR');
  assert.doesNotMatch(report.stackContext.explanation, /not in play/);
  assert.match(report.stackContext.explanation, /475 behind and 25 more than you in front of them/);
  const shove = report.candidates.find((candidate) => candidate.to === 500);
  assertChips(shove?.ev, 337.93181818, 'EV of the all-in raise');
  assert.equal(shove?.cost, 500);
});

test('the AJ spot: the blinds are each 1000 deep this street, so none of hero’s 1000 is out of play', () => {
  // On the button with 1000 facing the big blind. The small blind has 5 in and 995 behind, the big
  // blind 10 and 990, so either can take all 1000: SPR = 1000 / 15 = 66.67. Main said 995 and "The 5
  // above that is not in play".
  const report = buildCoachReport({
    heroCards: parseCards('Ah Jc'),
    board: [],
    street: 'preflop',
    opponents: [
      { label: 'SB', range: exactRange(parseCards('Ks Kd')) },
      { label: 'BB', range: exactRange(parseCards('9s 9d')) },
    ],
    pot: 15,
    contestablePot: 15,
    toCall: 10,
    heroCommittedThisStreet: 0,
    heroStack: 1000,
    opponentStacks: [
      { behind: 995, committedThisStreet: 5 },
      { behind: 990, committedThisStreet: 10 },
    ],
    bigBlind: 10,
    samples: 2_000,
    seed: 1,
  });
  assert.equal(report.stackContext.effectiveStack, 1000);
  assertChips(report.stackContext.spr, 1000 / 15, 'SPR');
  assert.doesNotMatch(report.stackContext.explanation, /not in play/);
  assert.match(report.stackContext.explanation, /^Chips already bet this street are still in play/);
});

test('multiway, a seat still to match hero’s own bet can put less against hero than it has behind', () => {
  // Hero bet 100 and has 900 behind. The draw raised to 300 with 200 behind, 400 more against hero.
  // The sevens have 600 behind but need 100 of it to match hero's bet, so 500. Main said 600.
  const report = buildCoachReport(
    setOfQueens(
      [
        { behind: 200, committedThisStreet: 300 },
        { behind: 600, committedThisStreet: 0 },
      ],
      { pot: 600, toCall: 200, heroCommittedThisStreet: 100, heroStack: 900 },
    ),
  );
  assert.equal(report.stackContext.effectiveStack, 500);
  assert.match(
    report.stackContext.explanation,
    /^The deepest opponent has 600 behind but must put 100 of it in just to match you, so 500 can still come against you\. /,
  );
});

test('control: heads-up and checked to, every figure and sentence is what it was', () => {
  // Nothing is in front of anyone, so the 370 behind is the whole of it and the sentence is true.
  //   EV = 0.35 x 56 + 0.65 x [ (37/44) x (56 + 2 x 370) - 370 ] = 214.1863636.
  const report = buildCoachReport(
    setOfQueens([{ behind: 370, committedThisStreet: 0 }], { pot: 56, heroStack: 2589 }),
  );
  assert.equal(report.stackContext.effectiveStack, 370);
  assertChips(report.stackContext.spr, 370 / 56, 'SPR');
  assert.match(
    report.stackContext.explanation,
    /^The deepest opponent has only 370, so at most 370 can change hands even though you have 2589\. The 2219 above that is not in play this hand/,
  );
  const shove = report.candidates.find((candidate) => candidate.to === 2589);
  assertChips(shove?.ev, 214.18636364, 'EV of the all-in bet');
  assert.equal(shove?.cost, 370);
});

test('control: with every opponent all in there is no more betting, and the effective stack stays 0', () => {
  const report = buildCoachReport(
    setOfQueens([{ behind: 0, committedThisStreet: 170 }], { pot: 230, toCall: 170, heroStack: 260 }),
  );
  assert.equal(report.stackContext.effectiveStack, 0);
  assert.match(
    report.stackContext.explanation,
    /^Every opponent is already all in, so there is no more betting/,
  );
});
