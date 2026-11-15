/**
 * The render boundary's "may this be called an outs count?" guard.
 * `src/outs-count.ts` re-declares `DEFAULT_AHEAD_THRESHOLD` because importing `@prl/poker-math` would
 * link `@prl/poker-engine` into the client bundle. A test ships nowhere, so the first case imports it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCoachReport, DEFAULT_AHEAD_THRESHOLD, exactRange, type Street } from '@prl/poker-math';
import { parseCardText } from '../src/cards.ts';
import { ALREADY_AHEAD_EQUITY, countsAsOuts, outsWithheldBecause } from '../src/outs-count.ts';

test('the re-declared threshold is the producer’s threshold', () => {
  assert.equal(
    ALREADY_AHEAD_EQUITY,
    DEFAULT_AHEAD_THRESHOLD,
    'the panel and @prl/poker-math must agree on the equity at which a hand stops drawing; ' +
      'update src/outs-count.ts, do not change this assertion',
  );
});

test('a hand that is behind has outs; a hand that is in front does not', () => {
  assert.equal(countsAsOuts(0), true);
  assert.equal(countsAsOuts(0.35), true, 'a nine-out flush draw is about 35%');
  assert.equal(countsAsOuts(0.4999999), true);

  // The bar is inclusive, matching `outsCountRefusalFor`: a hero at an exact chop is not behind.
  assert.equal(countsAsOuts(0.5), false, 'the bar is inclusive on both sides of the question');
  assert.equal(countsAsOuts(0.645), false, 'the overpair spot in the audit fixture');
  assert.equal(countsAsOuts(0.88), false, 'the flopped two pair that headlined 47 outs');
  assert.equal(countsAsOuts(1), false);
});

test('an equity that is not a probability suppresses nothing', () => {
  // A figure outside 0..1 cannot show hero is ahead, and the panel refuses it separately where the
  // reader sees it. Suppressing here would let one stale field silently blank a second section.
  for (const notAProbability of [1.6, -0.2, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      countsAsOuts(notAProbability),
      true,
      `${String(notAProbability)} says nothing about whether hero is ahead`,
    );
  }
});

function cards(text: string): number[] {
  return text.split(' ').map((card) => {
    const value = parseCardText(card);
    assert.notEqual(value, null, card);
    return value ?? -1;
  });
}

test('the panel withholds outs for a reason exactly when the producer withholds them', () => {
  const villains = ['Qs Qd', 'Jc Jd', 'Tc Td', '9c 9d', '8c 8d'];
  const boards: Record<Street, string> = {
    preflop: '',
    flop: 'Kh 7h 2c',
    turn: 'Kh 7h 2c 3s',
    river: 'Kh 7h 2c 3s 4d',
  };
  let withheld = 0;
  let counted = 0;
  for (const [street, board] of Object.entries(boards) as [Street, string][]) {
    for (let opponents = 1; opponents <= villains.length; opponents += 1) {
      const report = buildCoachReport({
        heroCards: cards('Ah Kd'),
        board: board === '' ? [] : cards(board),
        street,
        opponents: villains
          .slice(0, opponents)
          .map((hand, seat) => ({ label: `villain ${seat}`, range: exactRange(cards(hand)) })),
        pot: 100,
        contestablePot: 100,
        toCall: 50,
        heroCommittedThisStreet: 0,
        heroStack: 400,
        opponentStacks: villains.slice(0, opponents).map(() => ({ behind: 400, committedThisStreet: 50 })),
        bigBlind: 10,
        samples: 200,
        seed: 1,
      });
      const reason = outsWithheldBecause(report.street, report.equity.perPlayer.length - 1);
      assert.equal(reason !== null, report.outs === null, `${street} against ${opponents}: ${reason}`);
      if (reason === null) counted += 1;
      else withheld += 1;
    }
  }
  assert.ok(counted > 0 && withheld > 0, 'the sweep reaches both answers');
});
