/**
 * A low-confidence reading names its cause: a margin under a quarter of a big blind, or a sampled
 * equity whose interval could move the margin by more than its size. A wide interval that cannot
 * close the margin does not lower confidence. Expected figures are worked by hand in comments.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport } from '../src/coach.ts';
import { expandAssumedRange } from '../src/coach-view.ts';
import { parseRange } from '../src/ranges.ts';

const top40 = (hand: string) => expandAssumedRange({ kind: 'topPercent', percent: 40 }, parseCards(hand));

test('a Legends shove 18 big blinds ahead is not called marginal because its equity is sampled', () => {
  // A♥Q♥ in the small blind, 5/10, 1,000 deep. Calling plays for 20, so it moves 20 units per unit
  // of equity; the shove is called for 2,000 at 65% of the time, 1,300 per unit. A ±2.07-point
  // interval moves the gap by 0.02066 x 1,280 = 26.4 units, far under the 182.4 it is ahead by.
  const report = buildCoachReport({
    heroCards: parseCards('Ah Qh'),
    board: [],
    street: 'preflop',
    opponents: [{ label: 'the big blind', range: top40('Ah Qh') }],
    pot: 15,
    contestablePot: 15,
    toCall: 5,
    heroCommittedThisStreet: 5,
    heroStack: 995,
    opponentStacks: [{ behind: 990, committedThisStreet: 10 }],
    bigBlind: 10,
    minimumRaiseTo: 20,
    samples: 2000,
    seed: 1,
  });
  assert.ok((report.equity.confidenceHalfWidthPoints ?? 0) > 2, 'the interval is over 2 points');
  assert.equal(report.suggestion.action, 'raise');
  assert.equal(report.suggestion.confidence, 'reasonable');
  assert.match(
    report.suggestion.reason,
    /^Raise has the highest expected value against the stated range, by 182\.4 units over calling\./u,
  );
  assert.doesNotMatch(report.suggestion.reason, /marginally|only just/u);
});

test('an interval that could close the gap says so, with the gap and how far it could move', () => {
  // A♥5♦ facing a shove of 990 into 1,010: calling is 2,000e - 990, so the gap to folding moves 2,000
  // units per unit of equity, and a ±2.95-point interval moves it by 59.0, more than it is.
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
  const swing = ((2000 * points) / 100).toFixed(1);
  assert.equal(gap, '18.0');
  assert.equal(swing, '59.0');
  assert.equal(report.suggestion.action, 'fold');
  assert.equal(report.suggestion.confidence, 'low');
  assert.equal(
    report.suggestion.reason,
    `Fold has the highest expected value against the stated range, by ${gap} units over calling, but the ` +
      `equity is sampled to ±${points.toFixed(2)} points, which could move that gap by up to ${swing} units — ` +
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
  });
  assert.equal(report.suggestion.action, 'bet');
  assert.equal(report.suggestion.confidence, 'low');
  assert.equal(
    report.suggestion.reason,
    'Bet comes out ahead of checking by only 17.5 units, under a quarter of a big blind — treat this ' +
      'as close to indifferent rather than as a recommendation.',
  );
});
