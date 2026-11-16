/**
 * Which way the fold rate moves a bet follows from its two branches: a bet that is worth more called
 * than folded to gets better as they fold less.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport } from '../src/coach.ts';
import { expandAssumedRange } from '../src/coach-view.ts';
import { parseRange } from '../src/ranges.ts';

function foldRateLine(report: ReturnType<typeof buildCoachReport>): string {
  const line = report.suggestion.whatWouldChangeIt.find((entry) => entry.startsWith('This assumes'));
  assert.ok(line !== undefined, 'the reading states its fold-rate assumption');
  return line;
}

test('a flop shove worth +441 called and +20 folded to gets better as they fold less', () => {
  // The Legends spot: A♥Q♥ on 4♥ J♠ J♥, 20 in the pot, both 990 deep. Called, the 990 shove is worth
  // 0.7156 x 2,000 - 990 = +441; folded to, it wins the 20.
  const hero = parseCards('Ah Qh');
  const report = buildCoachReport({
    heroCards: hero,
    board: parseCards('4h Js Jh'),
    street: 'flop',
    opponents: [
      { label: 'the big blind', range: expandAssumedRange({ kind: 'topPercent', percent: 40 }, hero) },
    ],
    pot: 20,
    contestablePot: 20,
    toCall: 0,
    heroCommittedThisStreet: 0,
    heroStack: 990,
    opponentStacks: [{ behind: 990, committedThisStreet: 0 }],
    bigBlind: 10,
  });
  assert.equal(report.suggestion.action, 'bet');
  assert.deepEqual(report.suggestion.sizeRange, { min: 990, max: 990 });
  const line = foldRateLine(report);
  assert.match(line, /folds more often makes it worse/);
  assert.doesNotMatch(line, /folds less often makes it worse/);
});

test('a bet worth the same called as folded to says the fold rate makes no difference', () => {
  // A♥K♥ beats the three T9s and loses to K♦K♣, so e = 3/4 exactly. Pot 200, all in for 100:
  // called it is 0.75 x 400 - 100 = 200, folded to it is the 200 in the pot.
  const report = buildCoachReport({
    heroCards: parseCards('Ah Kh'),
    board: parseCards('Ks 9d 5c 2h 3s'),
    street: 'river',
    opponents: [{ label: 'the caller', range: parseRange('KK, T9s', parseCards('Ah Kh Ks 9d 5c 2h 3s')) }],
    pot: 200,
    contestablePot: 200,
    toCall: 0,
    heroCommittedThisStreet: 0,
    heroStack: 100,
    opponentStacks: [{ behind: 500, committedThisStreet: 0 }],
    bigBlind: 10,
  });
  assert.equal(report.equity.heroEquity, 0.75);
  assert.equal(report.suggestion.action, 'bet');
  const line = foldRateLine(report);
  assert.match(line, /how often they fold makes no difference/);
  assert.doesNotMatch(line, /makes it worse/);
});

test('a bet worth less called than folded to still gets worse as they fold less', () => {
  // A♥K♥ beats the three T9s and loses to K♦K♣ and both 32s, so e = 1/2. Pot 100: called, any bet b
  // is worth 0.5 x (100 + 2b) - b = 50, under the 100 it wins folded to.
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
    bigBlind: 10,
  });
  assert.equal(report.equity.heroEquity, 0.5);
  assert.equal(report.suggestion.action, 'bet');
  const line = foldRateLine(report);
  assert.match(line, /An opponent who folds less often makes it worse\./);
});
