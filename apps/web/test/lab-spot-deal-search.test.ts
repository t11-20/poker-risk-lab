/**
 * The dealability search's budget: everything it does is counted, it stops at the budget rather than
 * hold a keystroke, and an answer is kept so a render that changes no range does not search again.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRange } from '@prl/poker-math';
import { blankDraft, cardsFromText, type OpponentDraft } from '../src/lib/spot.ts';
import { DEAL_SEARCH_BUDGET, dealSearch, validateDraft } from '../src/lib/spot-validate.ts';

function cards(text: string): number[] {
  const parsed = cardsFromText(text);
  assert.ok(parsed !== null, text);
  return parsed;
}

const seats = (dead: string, range: string, count: number) => {
  const { combos } = parseRange(range, cards(dead));
  assert.ok(combos.length > 0, range);
  return Array.from({ length: count }, () => combos);
};

describe('the deal search budget', () => {
  it('stops within one step of its budget on ranges no bound can refuse', () => {
    // At most four of five seats can hold a hand here, and neither bound proves it.
    const hands = seats('Ad Ac Kh Qs 7d', 'A2s+, A2o+, KK, QQ', 5);
    const total = hands.flat().length;
    const step = total + hands.length * (2 * total + 52);
    const { answer, work } = dealSearch(hands);
    assert.equal(answer, null);
    assert.ok(work > DEAL_SEARCH_BUDGET && work <= DEAL_SEARCH_BUDGET + step, `${work} combos looked at`);
  });

  it('counts the cover bound as well as the walk', () => {
    // Refused by the cover bound before any hand is dealt: the four aces cover every combo.
    const hands = seats('2c 3d', 'A2s+, A2o+', 5);
    const total = hands.flat().length;
    const { answer, work } = dealSearch(hands);
    assert.equal(answer, false);
    assert.ok(work >= 3 * total, `${work} counted for ${total} combos: the bound's own passes are missing`);
  });

  it('counts each combo the walk looks at, as well as each pass of the cover bound', () => {
    // One seat holding 4h4s: the walk looks at 1 combo and the cover bound makes one pass of 2 * 1 + 52.
    assert.deepEqual(dealSearch([[[10, 11]]]), { answer: true, work: 1 + 54 });
  });

  it('keys an answer on the combos themselves, not on how many each seat has', () => {
    // Seven and five combos a seat both times; the second pair all need the 2c, so only one seat is dealt.
    const twos = (from: number, count: number) =>
      Array.from({ length: count }, (_, index): [number, number] => [0, from + index]);
    const apart = dealSearch([twos(13, 7), twos(30, 5).map(([, b]): [number, number] => [b, b + 7])]);
    assert.equal(apart.answer, true);
    const shared = dealSearch([twos(13, 7), twos(30, 5)]);
    assert.equal(shared.answer, false, 'the same counts with other combos is another question');
    assert.ok(shared.work > 0, 'searched, not read from the cache');
  });

  it('keeps an answer, so validating the same ranges again searches nothing', () => {
    const base = blankDraft();
    const hole = cards('Ah As');
    const board = cards('Kc Qd 7h');
    const range = 'A2s+, A2o+, KK, QQ';
    const draft = {
      ...base,
      cards: {
        ...base.cards,
        hole1: hole[0] ?? null,
        hole2: hole[1] ?? null,
        flop1: board[0] ?? null,
        flop2: board[1] ?? null,
        flop3: board[2] ?? null,
      },
      opponents: [0, 1, 2, 3, 4].map(
        (index): OpponentDraft => ({ ...(base.opponents[0] as OpponentDraft), key: `o${index}`, range }),
      ),
    };
    const first = validateDraft(draft);
    assert.ok(first.ok && !first.dealChecked);
    const again = dealSearch(seats('Ah As Kc Qd 7h', range, 5));
    assert.deepEqual(again, { answer: null, work: 0 });
  });
});
