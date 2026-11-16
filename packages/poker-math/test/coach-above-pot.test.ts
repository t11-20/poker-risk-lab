/**
 * With the whole range assumed to call any size, the largest size would always rank first, so the reading
 * stops at pot or a twice-pot all-in. Hero holds the nut straight, so e = 1 and a bet of B into P shows
 * 0.35P + 0.65(P + 2B - B).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport, type CoachInput } from '../src/coach.ts';
import { parseRange } from '../src/ranges.ts';

const BOARD = '9c 8d 7h 2s Kd';
const spot = (heroStack: number, toCall: number): CoachInput => ({
  heroCards: parseCards('Jh Tc'),
  board: parseCards(BOARD),
  street: 'river',
  opponents: [{ label: 'the big blind', range: parseRange('KK, 99', parseCards(`Jh Tc ${BOARD}`)) }],
  pot: 100 + toCall,
  contestablePot: 100 + toCall,
  toCall,
  heroCommittedThisStreet: 0,
  heroStack,
  opponentStacks: [{ behind: 1000 - toCall, committedThisStreet: toCall }],
  bigBlind: 10,
});
const ev = (report: ReturnType<typeof buildCoachReport>, to: number) =>
  report.candidates.find((c) => c.to === to && (c.action === 'bet' || c.action === 'raise'))?.ev.toFixed(1);

test('a bet reading stops at pot, though the all-in row reads higher on the table', () => {
  // Pot-sized: 0.35 x 100 + 0.65 x 200 = 165. All in for 1000: 0.35 x 100 + 0.65 x 1,100 = 750.
  // Checking is e x P = 100, so the margin is 65.
  const report = buildCoachReport(spot(1000, 0));
  assert.equal(report.equity.heroEquity, 1);
  assert.equal(ev(report, 100), '165.0');
  assert.equal(ev(report, 1000), '750.0');
  assert.equal(report.suggestion.action, 'bet');
  assert.deepEqual(report.suggestion.sizeRange, { min: 100, max: 100 });
  assert.equal(
    report.suggestion.reason,
    'Bet has the highest expected value against the stated range, by 65.0 units over checking. ' +
      'Betting 1000 shows a higher figure only because every figure here assumes the whole range calls ' +
      'any size, so past a pot-sized bet each extra unit reads as profit. A real opponent folds more of ' +
      'the hands you beat as the size grows, so the reading goes no higher than a pot-sized bet, or all ' +
      'in when that is at most twice the pot.',
  );
});

test('a raise reading stops at the pot after the call', () => {
  // Facing 50 into 100 the pot after the call is 200, so pot-sized is a raise by 200 to 250:
  // 0.35 x 150 + 0.65 x (600 - 250) = 280. Calling is 200 - 50 = 150, so the margin is 130.
  const report = buildCoachReport(spot(1000, 50));
  assert.equal(ev(report, 250), '280.0');
  assert.equal(report.suggestion.action, 'raise');
  assert.deepEqual(report.suggestion.sizeRange, { min: 250, max: 250 });
  assert.match(
    report.suggestion.reason,
    /^Raise has the highest expected value .* by 130\.0 units over calling\. /,
  );
  assert.match(
    report.suggestion.reason,
    /Raising to 1000 shows a higher figure .* no higher than a pot-sized raise, or all in when/,
  );
});

test('an all-in no larger than the pot is still the reading, and says nothing about larger sizes', () => {
  // With 100 behind, all in is the pot-sized bet itself: 165, as above.
  const report = buildCoachReport(spot(100, 0));
  assert.equal(ev(report, 100), '165.0');
  assert.equal(report.suggestion.action, 'bet');
  assert.deepEqual(report.suggestion.sizeRange, { min: 100, max: 100 });
  assert.doesNotMatch(report.suggestion.reason, /whole range calls/);
});

test('an all-in of up to twice the pot is the reading, because a pot-sized bet would commit the stack', () => {
  // All in for 200 shows 0.35 x 100 + 0.65 x 300 = 230, and a pot-sized bet would leave 100 behind
  // in a pot of 300.
  for (const [stack, figure] of [
    [150, '197.5'],
    [200, '230.0'],
  ] as const) {
    const report = buildCoachReport(spot(stack, 0));
    assert.equal(ev(report, stack), figure);
    assert.deepEqual(report.suggestion.sizeRange, { min: stack, max: stack }, `all in for ${stack}`);
    assert.match(
      report.suggestion.reason,
      new RegExp(`Betting ${stack} is more than the pot\\. .* assumes the whole range calls any size`),
    );
  }
});

test('an all-in just over twice the pot is set aside like any larger one', () => {
  // All in for 201 shows 0.35 x 100 + 0.65 x 301 = 230.65, ahead of the pot-sized 165.
  const report = buildCoachReport(spot(201, 0));
  assert.equal(ev(report, 201), '230.7');
  assert.deepEqual(report.suggestion.sizeRange, { min: 100, max: 100 });
  assert.match(report.suggestion.reason, /Betting 201 shows a higher figure/);
});
