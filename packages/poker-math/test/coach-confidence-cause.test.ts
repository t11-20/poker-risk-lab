/**
 * A low-confidence reading names its cause: a margin under a quarter of a big blind, or a sampled
 * equity at one end of whose interval another line comes out ahead, named. A wide interval that no
 * line can overtake the reading across does not lower confidence. Figures are worked by hand.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionCandidate } from '@prl/contracts';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport, type CoachInput } from '../src/coach.ts';
import { expandAssumedRange } from '../src/coach-view.ts';
import { parseRange } from '../src/ranges.ts';

const top40 = (hand: string) => expandAssumedRange({ kind: 'topPercent', percent: 40 }, parseCards(hand));

test('a call of a shove 28 big blinds ahead is not called marginal because its equity is sampled', () => {
  // A♥Q♥ in the small blind, 5/10, calling the big blind's shove to 1,000 with the last 995. Calling is
  // 2,000e - 995 = 2,000 x 0.63975 - 995 = 284.5, so a ±2.07-point interval moves the gap to folding
  // by 0.02066 x 2,000 = 41.3 units, far under the 284.5 it is ahead by.
  const report = buildCoachReport({
    heroCards: parseCards('Ah Qh'),
    board: [],
    street: 'preflop',
    opponents: [{ label: 'the big blind', range: top40('Ah Qh') }],
    pot: 1005,
    contestablePot: 1005,
    toCall: 995,
    heroCommittedThisStreet: 5,
    heroStack: 995,
    opponentStacks: [{ behind: 0, committedThisStreet: 1000 }],
    bigBlind: 10,
    samples: 2000,
    seed: 1,
  });
  assert.ok((report.equity.confidenceHalfWidthPoints ?? 0) > 2, 'the interval is over 2 points');
  assert.equal(report.suggestion.action, 'call');
  assert.equal(report.suggestion.confidence, 'reasonable');
  assert.match(
    report.suggestion.reason,
    /^Call has the highest expected value against the stated range, by 284\.5 units over folding\./u,
  );
  assert.doesNotMatch(report.suggestion.reason, /marginally|only just/u);
});

test('an interval that could close the gap says so, naming the line ahead at its end and by how much', () => {
  // A♥5♦ facing a shove of 990 into 1,010: calling is 2,000e - 990, so the gap to folding moves 2,000
  // units per unit of equity. At the high end of ±2.95 points calling gains 59.0 and is 41.0 ahead.
  const report = buildCoachReport({
    heroCards: parseCards('Ah 5d'),
    board: [],
    street: 'preflop',
    opponents: [{ label: 'the shover', range: top40('Ah 5d') }],
    pot: 1010,
    contestablePot: 1010,
    toCall: 990,
    heroCommittedThisStreet: 10,
    heroStack: 990,
    opponentStacks: [{ behind: 0, committedThisStreet: 1000 }],
    bigBlind: 10,
    samples: 1000,
    seed: 7,
  });
  const e = report.equity.heroEquity;
  const points = report.equity.confidenceHalfWidthPoints ?? 0;
  const gap = (990 - 2000 * e).toFixed(1);
  const ahead = ((2000 * points) / 100 - (990 - 2000 * e)).toFixed(1);
  assert.equal(gap, '18.0');
  assert.equal(ahead, '41.0');
  assert.equal(report.suggestion.action, 'fold');
  assert.equal(report.suggestion.confidence, 'low');
  assert.equal(
    report.suggestion.reason,
    `Fold has the highest expected value against the stated range, by ${gap} units over calling, but the ` +
      `equity is sampled to ±${points.toFixed(2)} points, and at the high end calling comes out ahead by ${ahead} units — ` +
      'treat this as close rather than as a recommendation.',
  );
});

test('a margin under a quarter of a big blind says it is small, not that it is sampled', () => {
  // A♥K♥ beats the three T9s and loses to K♦K♣ and both 32s, so e = 1/2, exactly. Checking is
  // worth 50; any bet is 0.35 x 100 + 0.65 x 50 = 67.5, 17.5 ahead, under a quarter of a 100 blind.
  const report = buildCoachReport({
    heroCards: parseCards('Ah Kh'),
    board: parseCards('Ks 9d 5c 2h 3s'),
    street: 'river',
    opponents: [
      { label: 'the caller', range: parseRange('KK, T9s, 32s', parseCards('Ah Kh Ks 9d 5c 2h 3s')) },
    ],
    pot: 100,
    contestablePot: 100,
    toCall: 0,
    heroCommittedThisStreet: 0,
    heroStack: 1000,
    opponentStacks: [{ behind: 1000, committedThisStreet: 0 }],
    bigBlind: 100,
    wholeRangeContinues: true,
  });
  assert.equal(report.suggestion.action, 'bet');
  assert.equal(report.suggestion.confidence, 'low');
  assert.equal(
    report.suggestion.reason,
    'Bet comes out ahead of checking by only 17.5 units, under a quarter of a big blind — treat this ' +
      'as close to indifferent rather than as a recommendation.',
  );
});

const ANY = parseRange('random');

/** Facing 40 into 114 at 5/10 with 7♣2♦, 100 samples: e = 0.35 ± 9.08 points. */
const SEVEN_TWO: CoachInput = {
  heroCards: parseCards('7c 2d'),
  board: [],
  street: 'preflop',
  opponents: [{ label: 'any hand', range: ANY }],
  pot: 114,
  contestablePot: 114,
  toCall: 40,
  heroCommittedThisStreet: 0,
  heroStack: 1000,
  opponentStacks: [{ behind: 960, committedThisStreet: 40 }],
  bigBlind: 10,
  samples: 100,
  seed: 1,
};

/** 7♣2♦ with 100 behind facing a 1,000 shove: the call is capped at 100, for a 300 pot. */
const SHORT_CALL: CoachInput = {
  ...SEVEN_TWO,
  pot: 1100,
  contestablePot: 200,
  toCall: 1000,
  heroStack: 100,
  opponentStacks: [{ behind: 0, committedThisStreet: 1000 }],
  bigBlind: 1,
  samples: 1000,
};

test('a line other than the runner-up that overtakes at the end of the interval lowers it, named', () => {
  // Calling is 154e - 40 = 13.9; raising to 80 always called is 234e - 80 = 1.9, the runner-up. Both
  // lose at the low end, but the call falls to 154 x 0.2592 - 40 = -0.08, behind folding's 0.
  const report = buildCoachReport(SEVEN_TWO);
  assert.equal(report.equity.heroEquity, 0.35);
  assert.equal(report.equity.confidenceHalfWidthPoints?.toFixed(2), '9.08');
  assert.equal(report.suggestion.action, 'call');
  assert.equal(report.suggestion.confidence, 'low');
  assert.match(
    report.suggestion.reason,
    /^Call has the highest expected value of the lines that do not rely on an assumed fold rate, by 12\.0 units over raising to 80 \(counted as always called\), but the equity is sampled to ±9\.08 points, and at the low end folding comes out ahead by 0\.1 units — treat this as close rather than as a recommendation\. /u,
  );
});

test('a call capped at hero stack is repriced on the pot it plays for, so its interval counts', () => {
  // Calling 100 for a 300 pot is 300e - 100 = 3.05. At the low end of ±2.82 points it is
  // 300 x 0.3153 - 100 = -5.4, behind folding.
  const report = buildCoachReport(SHORT_CALL);
  assert.equal(report.equity.heroEquity, 0.3435);
  assert.equal(report.suggestion.action, 'call');
  assert.equal(report.suggestion.confidence, 'low');
  assert.equal(
    report.suggestion.reason,
    'Call has the highest expected value against the stated range, by 3.1 units over folding, but the ' +
      'equity is sampled to ±2.82 points, and at the low end folding comes out ahead by 5.4 units — ' +
      'treat this as close rather than as a recommendation.',
  );
});

test('a free check is never overtaken by folding, even where the interval runs below zero equity', () => {
  // 1 of 10 samples: e = 0.1 ± 19.6 points. A share below 0 would price the check under folding.
  const report = buildCoachReport({
    heroCards: parseCards('2c 7d'),
    board: [],
    street: 'preflop',
    opponents: [{ label: 'a tight range', range: parseRange('QQ+, AKs', parseCards('2c 7d')) }],
    pot: 1000,
    contestablePot: 1000,
    toCall: 0,
    heroCommittedThisStreet: 10,
    heroStack: 1000,
    opponentStacks: [{ behind: 1000, committedThisStreet: 10 }],
    bigBlind: 10,
    samples: 10,
    seed: 1,
  });
  assert.equal(report.equity.heroEquity, 0.1);
  assert.equal(report.suggestion.action, 'check');
  assert.equal(report.suggestion.confidence, 'moderate');
  assert.doesNotMatch(report.suggestion.reason, /folding comes out ahead/u);
});

test('every row type is repriced at the measured equity exactly as it was priced, or the report refuses', () => {
  // `buildCoachReport` throws when a row reprices to anything but its own EV; these spots hold each kind.
  const river = (hero: string, spot: Partial<CoachInput>): CoachInput => ({
    heroCards: parseCards(hero),
    board: parseCards('Ks 9d 5c 2h 2s'),
    street: 'river',
    opponents: [
      { label: 'A', range: parseRange('AA', parseCards(`${hero} Ks 9d 5c 2h 2s`)) },
      { label: 'B', range: parseRange('QQ', parseCards(`${hero} Ks 9d 5c 2h 2s`)) },
    ],
    pot: 300,
    contestablePot: 300,
    toCall: 0,
    heroCommittedThisStreet: 0,
    heroStack: 900,
    opponentStacks: [
      { behind: 0, committedThisStreet: 0, winnable: 300 },
      { behind: 900, committedThisStreet: 0, winnable: 300 },
    ],
    bigBlind: 10,
    ...spot,
  });
  const has = (action: string, rows: readonly ActionCandidate[], kind: (row: ActionCandidate) => boolean) =>
    rows.some((row) => row.action === action && kind(row));
  const spots: readonly (readonly [string, CoachInput, (rows: readonly ActionCandidate[]) => boolean])[] = [
    [
      'one pot, facing a bet',
      SEVEN_TWO,
      (rows) =>
        has('fold', rows, () => true) &&
        has('call', rows, (row) => row.potShareIfCalled !== undefined) &&
        has('raise', rows, (row) => row.potShareIfCalled !== undefined),
    ],
    [
      'a raise capped at what can be called',
      { ...SEVEN_TWO, opponentStacks: [{ behind: 300, committedThisStreet: 40 }] },
      (rows) => has('raise', rows, (row) => row.cost < (row.to ?? 0)),
    ],
    [
      'a call capped at hero stack',
      SHORT_CALL,
      (rows) => has('call', rows, (row) => row.cost < SHORT_CALL.toCall),
    ],
    [
      'one pot, checked to',
      { ...SEVEN_TWO, toCall: 0, heroCommittedThisStreet: 40 },
      (rows) => has('check', rows, (row) => row.derivation.startsWith('EV(check) = equity x pot')),
    ],
    [
      'a side pot already in, checked to',
      river('Kc Qh', {
        pot: 350,
        contestablePot: 350,
        heroStack: 850,
        opponentStacks: [
          { behind: 0, committedThisStreet: 0, winnable: 150 },
          { behind: 850, committedThisStreet: 0, winnable: 350 },
        ],
      }),
      (rows) =>
        has('check', rows, (row) => row.derivation.includes('you play for')) &&
        has('bet', rows, (row) => row.derivation.includes('cannot fold')),
    ],
    [
      'a side pot, facing a bet',
      river('Kc Qh', {
        pot: 450,
        contestablePot: 450,
        toCall: 100,
        heroStack: 850,
        opponentStacks: [
          { behind: 0, committedThisStreet: 0, winnable: 150 },
          { behind: 750, committedThisStreet: 100, winnable: 450 },
        ],
      }),
      (rows) =>
        has('call', rows, (row) => row.derivation.includes('you play for')) &&
        has('raise', rows, (row) => row.derivation.includes('cannot fold')),
    ],
    [
      'chips a fold hands back',
      river('Kc Qh', {
        pot: 10,
        contestablePot: 10,
        toCall: 5,
        heroCommittedThisStreet: 5,
        opponents: [{ label: 'A', range: parseRange('QQ', parseCards('Kc Qh Ks 9d 5c 2h 2s')) }],
        opponentStacks: [{ behind: 0, committedThisStreet: 1, winnable: 6 }],
      }),
      (rows) => has('call', rows, (row) => row.derivation.includes('a fold hands back too')),
    ],
  ];
  for (const [name, input, holds] of spots) {
    assert.ok(holds(buildCoachReport(input).candidates), `${name}: the spot no longer holds that row`);
  }
});
