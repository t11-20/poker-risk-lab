/**
 * The reading's margin is measured to the best other action, with a row that rests on the assumed
 * fold rate counted as if always called. The sentence names that line, so the figure can be found on
 * the table. Expected figures are worked by hand in comments.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport } from '../src/coach.ts';
import { parseRange } from '../src/ranges.ts';

test('a fold names calling as its runner-up when a fold-rate raise reads closer on the table', () => {
  // K♣Q♥ loses to every AA, 99 and 55, so e = 0. Facing 44 into 84, calling is -44. The minimum raise
  // to 88 shows 0.35 x 84 + 0.65 x (-88) = -27.8, but always called it is -88, so calling is the line
  // the fold is measured against.
  const report = buildCoachReport({
    heroCards: parseCards('Kc Qh'),
    board: parseCards('Ks 9d 5c 2h 2s'),
    street: 'river',
    opponents: [{ label: 'the bettor', range: parseRange('AA,99,55', parseCards('Kc Qh Ks 9d 5c 2h 2s')) }],
    pot: 84,
    contestablePot: 84,
    toCall: 44,
    heroCommittedThisStreet: 0,
    heroStack: 990,
    opponentStacks: [{ behind: 946, committedThisStreet: 44 }],
    bigBlind: 10,
  });
  assert.equal(report.equity.heroEquity, 0);
  const shown = (action: string, to: number) =>
    report.candidates.find((c) => c.action === action && c.to === to)?.ev.toFixed(1);
  assert.equal(shown('call', 44), '-44.0');
  assert.equal(shown('raise', 88), '-27.8');
  assert.equal(report.suggestion.action, 'fold');
  assert.equal(
    report.suggestion.reason,
    'Fold has the highest expected value against the stated range, by 44.0 units over calling. ' +
      'Raising to 88 reads closer on the table only because it assumes they fold 35% of the time.',
  );
});

test('a call measured against a raise set aside on the fold rate says the raise is counted as always called', () => {
  // The flush draw of `coach-fold-reliance.test.ts`: without folds the raise to 50 is the runner-up,
  // 25 - 50e = 11.6 behind the call, while the table shows it ahead.
  const report = buildCoachReport({
    heroCards: parseCards('Qh Jh'),
    board: parseCards('Kh 7h 3c 2s'),
    street: 'turn',
    opponents: [
      { label: 'the button', range: parseRange('KK, 77, 33, 22, AK, KQ, KJs, QQ, JJ, TT, 99, A5s, 65s') },
    ],
    pot: 145,
    contestablePot: 145,
    toCall: 25,
    heroCommittedThisStreet: 0,
    heroStack: 500,
    opponentStacks: [{ behind: 475, committedThisStreet: 25 }],
    bigBlind: 10,
  });
  assert.equal(report.suggestion.action, 'call');
  assert.match(
    report.suggestion.reason,
    /^Call has the highest expected value of the lines that do not rely on an assumed fold rate, by 11\.6 units over raising to 50 \(counted as always called\)\. Raising to 50 shows a higher figure/u,
  );
});
