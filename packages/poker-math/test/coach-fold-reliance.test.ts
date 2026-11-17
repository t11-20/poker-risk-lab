/**
 * The reading never rests on the assumed fold rate. A bet or raise is the reading only when it beats
 * the best line that reads no fold rate even if it is always called, the rows the Lab's verdict
 * measures a fold against. Expected figures are worked by hand in comments.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport, type CoachInput } from '../src/coach.ts';
import { exactRange, parseRange } from '../src/ranges.ts';

/** One fold rate for every size, the pricing these figures are worked at. */
function spot(input: Omit<CoachInput, 'contestablePot' | 'heroCommittedThisStreet'> & Partial<CoachInput>) {
  return buildCoachReport({
    heroCommittedThisStreet: 0,
    contestablePot: input.pot,
    wholeRangeContinues: true,
    ...input,
  });
}

test('top two pair facing a river bet reads fold, not a raise the opponent gets 7:1 to call', () => {
  // Hero beats only the three A5s of the 18 combos left (3 AA, 1 KK, 1 88, 3 33, 3 22, 1 K8s, 3 K8o),
  // so e = 1/6. Raising all in adds 160, all the opponent has: called it is worth
  // S = (1/6)(900 + 400 + 320) - 560 = -290, and at 35% folds 0.35 x 900 + 0.65 x (-290) = 126.5.
  // It beats folding only above f = 290 / (900 + 290) = 24.4%.
  const report = spot({
    heroCards: parseCards('Ah Kc'),
    board: parseCards('Kd 8s 3h 8c 2d'),
    street: 'river',
    opponents: [{ label: 'the bettor', range: parseRange('AA, KK, 88, 33, 22, K8s, K8o, A5s') }],
    pot: 900,
    toCall: 400,
    heroStack: 560,
    opponentStacks: [{ behind: 160, committedThisStreet: 400 }],
    bigBlind: 20,
  });
  assert.equal(report.equity.heroEquity, 1 / 6);
  const raise = report.candidates.find((candidate) => candidate.action === 'raise');
  assert.ok(raise !== undefined && Math.abs(raise.ev - 126.5) < 1e-9, 'the raise row is still priced');
  assert.equal(report.suggestion.action, 'fold');
  assert.equal(report.suggestion.sizeRange, undefined);
  // Folding is 183.3 ahead of calling, over nine big blinds.
  assert.equal(report.suggestion.confidence, 'reasonable');
  assert.match(
    report.suggestion.reason,
    /by 183\.3 units .* Raising to 560 .* only if they fold more than 24\.4% of the time/,
  );
});

test('a flush draw facing a small bet reads call, and names the raise and the fold rate it needs', () => {
  // Pot 145 facing 25. Calling is 170e - 25. The raise to 50 risks 50 into a final pot of 220, so
  // called it is 220e - 50, and it beats calling only above f = (25 - 50e) / (195 - 220e). Without
  // folds the raise is the runner-up, 25 - 50e behind the call.
  const report = spot({
    heroCards: parseCards('Qh Jh'),
    board: parseCards('Kh 7h 3c 2s'),
    street: 'turn',
    opponents: [
      { label: 'the button', range: parseRange('KK, 77, 33, 22, AK, KQ, KJs, QQ, JJ, TT, 99, A5s, 65s') },
    ],
    pot: 145,
    toCall: 25,
    heroStack: 500,
    opponentStacks: [{ behind: 475, committedThisStreet: 25 }],
    bigBlind: 10,
  });
  const e = report.equity.heroEquity;
  assert.ok(e > 0.25 && e < 0.3, `a one-card flush draw with a few extra outs, got ${e}`);
  assert.equal(report.suggestion.action, 'call');
  assert.deepEqual(report.suggestion.sizeRange, { min: 25, max: 25 }, 'the call is the one size');
  const needed = (((25 - 50 * e) / (195 - 220 * e)) * 100).toFixed(1);
  assert.equal(needed, '8.5');
  const margin = (25 - 50 * e).toFixed(1);
  assert.equal(margin, '11.6');
  assert.match(
    report.suggestion.reason,
    new RegExp(`by ${margin} units .* Raising to 50 .* only if they fold more than ${needed}% `),
  );
});

test('control: top pair against a check-raising range at 70 big blinds stays a raise', () => {
  // At f = 0 a raise by r is worth EV(call) + r(2e - 1), so with e above one half every size beats calling
  // on the range alone. The reading stops at the pot-sized raise to 680, 190 + 490.
  const report = spot({
    heroCards: parseCards('Ah Kd'),
    board: parseCards('Kc 8d 3s'),
    street: 'flop',
    opponents: [
      { label: 'the big blind', range: parseRange('AA, KK, 88, 33, AKs, AKo, KQs, K8s, A5s, A4s, 76s, 65s') },
    ],
    pot: 355,
    toCall: 135,
    heroCommittedThisStreet: 55,
    heroStack: 1345,
    opponentStacks: [{ behind: 1210, committedThisStreet: 190 }],
    bigBlind: 20,
  });
  assert.ok(report.equity.heroEquity > 0.5);
  assert.equal(report.suggestion.action, 'raise');
  assert.equal(report.suggestion.sizeRange?.max, 680);
});

test('control: ace-jack on the button against a defending range stays a raise', () => {
  // The pot-sized raise is to 35, 10 + 25.
  const report = spot({
    heroCards: parseCards('Ah Jc'),
    board: [],
    street: 'preflop',
    opponents: [
      {
        label: 'the blind',
        range: parseRange(
          '22-99, A2s-A9s, KTs, QTs, JTs, T9s, 98s, 87s, 76s, 65s, A9o, KTo, QTo, JTo, KJo, QJo',
        ),
      },
    ],
    pot: 15,
    toCall: 10,
    heroStack: 1000,
    opponentStacks: [{ behind: 990, committedThisStreet: 10 }],
    bigBlind: 10,
    samples: 40_000,
    seed: 20_260_817,
  });
  assert.ok(report.equity.heroEquity > 0.55);
  assert.equal(report.suggestion.action, 'raise');
  assert.equal(report.suggestion.sizeRange?.max, 35);
});

test('control: a set betting into a draw stays a bet, ahead even when always called', () => {
  // e = 37/44. Called, the 370 that can be matched is worth (37/44)(56 + 740) - 370 = 299.4, and
  // checking is worth (37/44) x 56 = 47.1.
  const report = spot({
    heroCards: parseCards('Qs Qd'),
    board: parseCards('Qh 7h 2c 3d'),
    street: 'turn',
    opponents: [{ label: 'the draw', range: exactRange(parseCards('Ah Kh')) }],
    pot: 56,
    toCall: 0,
    heroStack: 2589,
    opponentStacks: [{ behind: 370, committedThisStreet: 0 }],
    bigBlind: 10,
  });
  assert.equal(report.suggestion.action, 'bet');
  assert.doesNotMatch(report.suggestion.reason, /only if they fold/);
});
