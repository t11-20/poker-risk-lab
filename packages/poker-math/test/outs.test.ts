/**
 * Every expected number is derived by hand from card counting, never pasted from a run.
 * Most spots are on the turn against a known hand, so equity after a card is 1, 0.5 or 0 and the
 * result is a count of the 44 rivers. The flop spots state exact fractions with the losing rivers.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardToString, parseCards, remainingDeck } from '@prl/poker-engine';
import type { CardOutcome, OutsResult } from '../src/outs.ts';
import { computeOuts, OutsError, outsSummaryFor } from '../src/outs.ts';
import { exactRange, parseRange } from '../src/ranges.ts';

/** Labels in result order, best equity first, then card id. */
function labelsInOrder(outcomes: readonly CardOutcome[]): string[] {
  return outcomes.map((outcome) => outcome.label);
}

function labelSet(outcomes: readonly CardOutcome[]): string[] {
  return [...outcomes.map((outcome) => outcome.label)].sort();
}

function outcomeFor(result: OutsResult, label: string): CardOutcome {
  const all = [...result.clean, ...result.dirty, ...result.neutral];
  const found = all.find((outcome) => outcome.label === label);
  if (found === undefined) throw new Error(`no outcome for ${label} in this result`);
  return found;
}

function closeTo(actual: number, expected: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `${what}: expected ${expected} (${expected.toFixed(6)}), got ${actual} (${actual.toFixed(6)})`,
  );
}

function assertInvariants(result: OutsResult): void {
  assert.equal(
    result.clean.length + result.dirty.length + result.neutral.length,
    result.cardsConsidered,
    'clean + dirty + neutral must account for every card considered',
  );
  assert.equal(result.cleanCount, result.clean.length);
  assert.equal(result.dirtyCount, result.dirty.length);
  assert.equal(result.totalOuts, result.cleanCount + result.dirtyCount);
  assert.equal(result.method, 'exact-per-card');

  // A result says "N outs in total" or carries a refusal, never both and never neither.
  const refused = result.refusal !== null;
  assert.equal(
    /outs in total/.test(result.explanation),
    !refused,
    refused
      ? `a refused result still called its count outs: ${result.explanation}`
      : `a drawing spot lost its outs count: ${result.explanation}`,
  );
  if (result.refusal !== null) {
    assert.equal(result.refusal.kind, 'already-ahead');
    assert.equal(result.refusal.equityNow, result.equityNow, 'the refusal quotes the equity it refused on');
    assert.ok(
      result.equityNow >= result.refusal.threshold,
      'a refusal has to be justified by the threshold it names',
    );
    assert.match(
      result.explanation,
      /no outs count here/,
      'a refused result has to say so, not merely omit the number',
    );
  }
  for (const outcome of [...result.clean, ...result.dirty, ...result.neutral]) {
    assert.ok(outcome.equityAfter >= 0 && outcome.equityAfter <= 1, `${outcome.label} equity out of range`);
    closeTo(outcome.equityBefore, result.equityNow, `${outcome.label} equityBefore`);
    assert.equal(outcome.label, cardToString(outcome.card));
    assert.ok(outcome.note.length > 0, `${outcome.label} has no note`);
  }
  assert.ok(result.assumptions.length > 0, 'assumptions must never be empty');
  assert.ok(
    result.assumptions.every((note) => !note.startsWith('0 ')),
    'no assumption should be generated for a count of zero',
  );
}

test('a bare nut flush draw against a hand it dominates has exactly 9 clean outs', () => {
  // Hero Ah 6h on Kh 9h 4s 2c against Kd 9c (two pair, kings and nines).
  // 13 hearts less 4 visible (Ah, 6h, Kh, 9h) = 9, none held by the opponent. Each makes an
  // ace-high flush, and the unpaired board gives them no full house, so each wins.
  // Pairing the ace or the six still loses to two pair, and A-6 with K-9-4-2 makes no straight.
  // Hero wins on exactly 9 of 44, so equityNow = 9/44.
  const result = computeOuts({
    heroCards: parseCards('Ah 6h'),
    board: parseCards('Kh 9h 4s 2c'),
    opponent: exactRange(parseCards('Kd 9c')),
  });
  assertInvariants(result);

  assert.equal(result.cardsConsidered, 44, '52 - 2 hero - 4 board - 2 the opponent is known to hold');
  assert.equal(result.cleanCount, 9);
  assert.equal(result.dirtyCount, 0);
  assert.equal(result.totalOuts, 9);
  assert.deepEqual(labelsInOrder(result.clean), ['2h', '3h', '4h', '5h', '7h', '8h', 'Th', 'Jh', 'Qh']);
  closeTo(result.equityNow, 9 / 44, 'equityNow');

  for (const outcome of result.clean) closeTo(outcome.equityAfter, 1, `${outcome.label} after`);
  for (const outcome of result.neutral) closeTo(outcome.equityAfter, 0, `${outcome.label} after`);

  assert.match(outcomeFor(result, 'Qh').note, /flush/);
  assert.match(result.explanation, /9 are clean and 0 are dirty/);
});

test('flush cards that complete a straight flush for the opponent are not outs at all', () => {
  // Hero Ah Kh on 8h 9h 6c 2d against 7h 6h (pair of sixes, straight and flush draws).
  // 13 hearts less Ah, Kh, 8h, 9h, 7h, 6h leaves 7 (2h, 3h, 4h, 5h, Th, Jh, Qh).
  // Two of those make them a straight flush, which beats hero's flush:
  //   5h  ->  5h 6h 7h 8h 9h
  //   Th  ->  6h 7h 8h 9h Th
  // The other five give them only a nine-high flush.
  // Three aces and three kings each pair hero above their sixes on the unpaired board.
  // Winners: 5 hearts + 3 aces + 3 kings = 11 of 44, so equityNow = 11/44 = 0.25.
  const result = computeOuts({
    heroCards: parseCards('Ah Kh'),
    board: parseCards('8h 9h 6c 2d'),
    opponent: exactRange(parseCards('7h 6h')),
  });
  assertInvariants(result);

  assert.equal(result.cleanCount, 11);
  assert.equal(result.dirtyCount, 0);
  assert.equal(result.totalOuts, 11);
  closeTo(result.equityNow, 0.25, 'equityNow');
  assert.deepEqual(labelSet(result.clean), [
    '2h',
    '3h',
    '4h',
    'Ac',
    'Ad',
    'As',
    'Jh',
    'Kc',
    'Kd',
    'Ks',
    'Qh',
  ]);

  const flushCards = ['2h', '3h', '4h', '5h', 'Th', 'Jh', 'Qh'];
  const good = flushCards.filter((label) => outcomeFor(result, label).classification === 'clean');
  const bad = flushCards.filter((label) => outcomeFor(result, label).classification === 'neutral');
  assert.deepEqual(good, ['2h', '3h', '4h', 'Jh', 'Qh']);
  assert.deepEqual(bad, ['5h', 'Th'], 'these two make them a straight flush');
  for (const label of bad) {
    closeTo(outcomeFor(result, label).equityAfter, 0, `${label} after`);
    assert.match(outcomeFor(result, label).note, /straight flush/);
  }
  assert.equal(result.dirty.length, 0);
});

test('nine flush cards can be worth zero clean outs and eight dirty ones', () => {
  // Hero Ah Qh on Kh 7h 2c against Kd Kc, a set of kings.
  // Nine hearts remain (13 less Ah, Qh, Kh, 7h). Eight make an ace-high flush on the turn, but the
  // set is live for a full house on the river. After 3h (board Kh 7h 2c 3h) they win with
  //   the last king (Ks)         1 card   -> four of a kind
  //   any seven (7c 7d 7s)       3 cards  -> kings full
  //   any deuce (2d 2h 2s)       3 cards  -> kings full
  //   any three (3c 3d 3s)       3 cards  -> kings full
  // = 10 of the 44 remaining cards, so hero's equity after 3h is 34/44 = 0.7727.
  // That is under 0.90, a dirty out.
  // 2h pairs the board, giving them kings full of deuces, so it is not an out.
  // An ace or a queen pairs into a set, and A-Q with K-7-2 makes no straight.
  const result = computeOuts({
    heroCards: parseCards('Ah Qh'),
    board: parseCards('Kh 7h 2c'),
    opponent: exactRange(parseCards('Kd Kc')),
  });
  assertInvariants(result);

  assert.equal(result.cleanCount, 0, 'not one clean out, against the "nine outs" that gets taught');
  assert.equal(result.dirtyCount, 8);
  assert.equal(result.totalOuts, 8);
  assert.deepEqual(labelSet(result.dirty), ['3h', '4h', '5h', '6h', '8h', '9h', 'Jh', 'Th']);
  for (const outcome of result.dirty) closeTo(outcome.equityAfter, 34 / 44, `${outcome.label} after`);
  assert.equal(outcomeFor(result, '2h').classification, 'neutral');
  closeTo(outcomeFor(result, '2h').equityAfter, 0, '2h after');
  assert.match(outcomeFor(result, '4h').note, /full house/, 'the note must say what still beats the flush');
});

test('an open-ended straight draw has 8 outs, all clean against a set it beats', () => {
  // Hero 9c 8d on 7s 6h 2c 3d against 7d 7c (a set of sevens). Hero has 9-8-7-6 and needs a five
  // or a ten, 4 + 4 = 8 cards, none held by the opponent.
  // Neither pairs the 7-6-2-3 board, so the set cannot fill up, and a straight beats a set.
  // Pairing the nine or eight loses to the set, and the rainbow board allows no flush.
  // equityNow = 8/44.
  const result = computeOuts({
    heroCards: parseCards('9c 8d'),
    board: parseCards('7s 6h 2c 3d'),
    opponent: exactRange(parseCards('7d 7c')),
  });
  assertInvariants(result);

  assert.equal(result.cleanCount, 8);
  assert.equal(result.dirtyCount, 0);
  assert.deepEqual(labelSet(result.clean), ['5c', '5d', '5h', '5s', 'Tc', 'Td', 'Th', 'Ts']);
  closeTo(result.equityNow, 8 / 44, 'equityNow');
  for (const outcome of result.clean) closeTo(outcome.equityAfter, 1, `${outcome.label} after`);
  assert.match(outcomeFor(result, '5c').note, /straight/);

  // The fourth seven gives them four of a kind.
  assert.equal(outcomeFor(result, '7h').classification, 'neutral');
});

test('a gutshot has 4 outs', () => {
  // Hero Jc Tc on 9h 7d 2c 5s against 9c 9s (a set of nines). Only the 4 eights fill J-T-9-7.
  // Each makes 7-8-9-T-J, and no eight pairs the 9-7-2-5 board, so the set cannot fill up.
  // Three clubs (Jc, Tc, 2c) cannot flush. Pairing a jack or a ten loses to the set.
  // equityNow = 4/44.
  const result = computeOuts({
    heroCards: parseCards('Jc Tc'),
    board: parseCards('9h 7d 2c 5s'),
    opponent: exactRange(parseCards('9c 9s')),
  });
  assertInvariants(result);

  assert.equal(result.cleanCount, 4);
  assert.equal(result.dirtyCount, 0);
  assert.equal(result.totalOuts, 4);
  assert.deepEqual(labelSet(result.clean), ['8c', '8d', '8h', '8s']);
  closeTo(result.equityNow, 4 / 44, 'equityNow');

  // 4/44 is 9.1%, not a flat "9%".
  assert.match(result.explanation, /9\.1% equity/);
});

test('a hand that is already ahead is reported as such, not as a 43-out draw', () => {
  // Hero Kh Kd on Kc 7h 2c 3d against 7c 7d, set over set on an unpaired board.
  // Only 7s beats hero (four sevens over kings full). The other 43 of 44 leave hero in front, so
  // equityNow = 43/44 and 43 cards are clean.
  const result = computeOuts({
    heroCards: parseCards('Kh Kd'),
    board: parseCards('Kc 7h 2c 3d'),
    opponent: exactRange(parseCards('7c 7d')),
  });
  assertInvariants(result);

  closeTo(result.equityNow, 43 / 44, 'equityNow');
  assert.equal(result.cleanCount, 43);
  assert.equal(result.dirtyCount, 0);
  assert.deepEqual(labelSet(result.neutral), ['7s'], 'the only card that beats hero');
  closeTo(outcomeFor(result, '7s').equityAfter, 0, '7s after');

  assert.match(result.explanation, /not a drawing spot/);
  assert.ok(
    result.assumptions.some((note) => note.includes('not a drawing spot')),
    'the assumptions must carry the same warning as the explanation',
  );

  // A deuce makes kings full, and the note does not call it a rescue.
  const boat = outcomeFor(result, '2d');
  assert.equal(boat.classification, 'clean');
  closeTo(boat.equityAfter, 1, '2d after');
  assert.match(boat.note, /full house/);
});

test('two pair on the flop reports no outs count at all, and still reports the cards', () => {
  // Hero Ac 5d on Ah 5s 2c, two pair against a wide range. Every one of the 52 - 5 = 47 unseen
  // cards leaves hero above 50%, and the panel once called that 47 outs.
  const heroCards = parseCards('Ac 5d');
  const board = parseCards('Ah 5s 2c');
  const result = computeOuts({
    heroCards,
    board,
    opponent: parseRange('22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo', [...heroCards, ...board]),
  });
  assertInvariants(result);

  assert.equal(result.cardsConsidered, 47, '52 less hero two and the flop three');
  assert.ok(result.equityNow > 0.5, 'hero is in front before any card arrives');
  assert.equal(
    result.cleanCount + result.dirtyCount,
    47,
    'every card clears the bar, which is what makes the count meaningless as outs',
  );

  assert.notEqual(result.refusal, null, 'a made hand must not carry an outs count');
  assert.ok(!result.explanation.includes('47 outs'), `"47 outs" is back: ${result.explanation}`);
  assert.match(result.explanation, /none of them is an out/);
  assert.match(result.explanation, /rescues a hand that is behind/);

  // The explanation still says what the counts are.
  assert.match(result.explanation, /already in front/);
  assert.ok(
    result.assumptions.some((note) => note.includes('cards that keep you ahead')),
    'the assumptions still say what the counts are',
  );

  assert.equal(result.clean.length + result.dirty.length + result.neutral.length, 47);
  assert.ok(result.cleanCount > 0 && result.dirtyCount > 0, 'both buckets still hold cards');
});

test('a hand that is genuinely behind still gets its textbook count', () => {
  // The control. Hero 9h 8h on Ah 5h 2c against the same range, the flush-draw spot from
  // `apps/web/src/fixtures/review.ts`. Hero is behind at 43%.
  // 15 = 9 unseen hearts + 3 nines + 3 eights. The 8/7 clean-dirty split is the thresholds' work.
  const heroCards = parseCards('9h 8h');
  const board = parseCards('Ah 5h 2c');
  const result = computeOuts({
    heroCards,
    board,
    opponent: parseRange('22+, A2s+, K9s+, Q9s+, J9s+, T9s, 98s, A9o+, KTo+, QJo', [...heroCards, ...board]),
  });
  assertInvariants(result);

  assert.ok(result.equityNow < 0.5, 'hero is behind, which is the precondition for an out');
  assert.equal(result.refusal, null, 'a real draw must keep its count');
  assert.equal(result.totalOuts, 15, 'eight clean and seven dirty');
  assert.equal(result.cleanCount, 8);
  assert.equal(result.dirtyCount, 7);
  assert.match(result.explanation, /which is 15 outs in total/);
});

test('the refusal moves with the threshold it is defined against', () => {
  // Hero 9c 8d against 9h 8s on 7s 6h 2c 3d chops every river, so equityNow is exactly 0.5, on the
  // inclusive default bar, so this is refused.
  const spot = {
    heroCards: parseCards('9c 8d'),
    board: parseCards('7s 6h 2c 3d'),
    opponent: exactRange(parseCards('9h 8s')),
  };
  const atTheBar = computeOuts(spot);
  assertInvariants(atTheBar);
  closeTo(atTheBar.equityNow, 0.5, 'equityNow');
  assert.notEqual(atTheBar.refusal, null, 'the bar is inclusive at the bottom, for cards and for hero');
  assert.equal(atTheBar.refusal?.threshold, 0.5);

  // Above a chop the same 44 cards are a countable, empty set of outs. A hard-coded 0.5 fails here.
  const raised = computeOuts({ ...spot, aheadThreshold: 0.51 });
  assertInvariants(raised);
  assert.equal(raised.refusal, null, 'hero is behind the raised bar, so outs are countable again');
  assert.equal(raised.totalOuts, 0);
  assert.match(raised.explanation, /which is 0 outs in total/);
});

test('two overcards to a pair are 6 outs, clean on the turn and dirty if the bar is raised', () => {
  // Hero Ac Kd on Qh 7s 2c 3d against 9h 9c. Three aces and three kings pair hero, 6 cards.
  // On the unpaired rainbow board nines cannot improve on the river, so all six are clean.
  // No straight (A-K needs J and T) and no flush. equityNow = 6/44.
  const turn = computeOuts({
    heroCards: parseCards('Ac Kd'),
    board: parseCards('Qh 7s 2c 3d'),
    opponent: exactRange(parseCards('9h 9c')),
  });
  assertInvariants(turn);
  assert.equal(turn.cleanCount, 6);
  assert.equal(turn.dirtyCount, 0);
  assert.deepEqual(labelSet(turn.clean), ['Ad', 'Ah', 'As', 'Kc', 'Kh', 'Ks']);
  closeTo(turn.equityNow, 6 / 44, 'equityNow on the turn');

  // The same hand on the flop Qh 7s 2c:
  //   after (say) Ah the board is Qh 7s 2c Ah and they win with either of the two
  //   remaining nines -> hero's equity is 42/44 = 0.9545.
  // Hero's equity before any card is 253/990:
  //   C(45,2) = 990 two-card run-outs.
  //   at least one ace or king  = 6*39 + C(6,2) = 234 + 15 = 249
  //   plus a jack AND a ten (broadway) = 4*4 = 16, disjoint from the above
  //   minus run-outs of one ace-or-king together with one of the two nines, where
  //   their set wins = 6*2 = 12
  //   => 249 + 16 - 12 = 253.
  const flop = computeOuts({
    heroCards: parseCards('Ac Kd'),
    board: parseCards('Qh 7s 2c'),
    opponent: exactRange(parseCards('9h 9c')),
  });
  assertInvariants(flop);
  closeTo(flop.equityNow, 253 / 990, 'equityNow on the flop');
  assert.equal(flop.cleanCount, 6);
  assert.equal(flop.dirtyCount, 0);
  for (const outcome of flop.clean) closeTo(outcome.equityAfter, 42 / 44, `${outcome.label} after`);

  // At a 96% clean bar the same six cards, still 42/44, become dirty. The total does not move.
  const strict = computeOuts({
    heroCards: parseCards('Ac Kd'),
    board: parseCards('Qh 7s 2c'),
    opponent: exactRange(parseCards('9h 9c')),
    cleanThreshold: 0.96,
  });
  assertInvariants(strict);
  assert.equal(strict.cleanCount, 0);
  assert.equal(strict.dirtyCount, 6);
  assert.equal(strict.totalOuts, flop.totalOuts, 'the count of outs is unchanged; only the split moved');
  assert.deepEqual(labelSet(strict.dirty), labelSet(flop.clean));
});

test('a counterfeit card is not an out: the board pairing higher hands the pot over', () => {
  // Hero 6s 5s on 9c 6d 5c 2h (two pair) against Ah 9h (nines). 8 of 44 rivers take it away:
  //   any ace   (Ac Ad As)  3  -> aces and nines beats sixes and fives
  //   any nine  (9d 9s)     2  -> three nines
  //   any deuce (2c 2d 2s)  3  -> nines and deuces beats sixes and fives; hero's
  //                               two pair is COUNTERFEITED by a board pair higher
  //                               than either of hero's pairs
  // Everything else holds, so equityNow = 36/44.
  const result = computeOuts({
    heroCards: parseCards('6s 5s'),
    board: parseCards('9c 6d 5c 2h'),
    opponent: exactRange(parseCards('Ah 9h')),
  });
  assertInvariants(result);

  closeTo(result.equityNow, 36 / 44, 'equityNow');
  assert.equal(result.cleanCount, 36);
  assert.equal(result.dirtyCount, 0);
  assert.deepEqual(labelSet(result.neutral), ['2c', '2d', '2s', '9d', '9s', 'Ac', 'Ad', 'As']);

  // On a deuce the opponent's hand improved, not hero's, and the note says so.
  for (const label of ['2c', '2d', '2s']) {
    const outcome = outcomeFor(result, label);
    assert.equal(outcome.classification, 'neutral');
    closeTo(outcome.equityAfter, 0, `${label} after`);
    assert.match(outcome.note, /two pair, nines and deuces/);
    assert.match(outcome.note, /flipped it/);
  }
  assert.match(result.explanation, /already in front/);
});

test('outs are a property of the range, not of the cards: the same heart is clean or dead', () => {
  // Hero Ah Kh on Qh 7h 2c. Nine hearts remain (13 less Ah, Kh, Qh, 7h), plus three aces and three
  // kings. Against JJ and TT (12 combinations, no set yet) all 15 are clean:
  //   * a heart that does not pair the board (3h 4h 5h 6h 8h 9h): hero has the nut
  //     flush and an underpair can never beat it, since one more card cannot turn a
  //     pair into a full house. Equity exactly 1.
  //   * Jh and Th: hero has the nut flush, but now one third of the range (3 of 9
  //     surviving combinations) holds a SET, e.g. Jh on the board with JcJd behind.
  //     Those 3 combinations beat hero with the last jack (1), any queen (3), any
  //     seven (3) or any deuce (3) = 10 of 44 rivers, i.e. 34/44 each; the other 6
  //     combinations (TT) cannot get there at all. Hero's equity is therefore
  //     (3*34 + 6*44) / (9*44) = 366/396 = 0.9242, still clean.
  //   * 2h: the board pairs. They now beat hero's flush with their own pair's last
  //     two cards (2) or the last two deuces, which put trips on the board and make
  //     their pocket pair a full house (2) = 4 of 44, so 40/44 exactly.
  //   * an ace or a king: hero pairs and only a set beats it.
  const heroCards = parseCards('Ah Kh');
  const board = parseCards('Qh 7h 2c');
  const blockers = [...heroCards, ...board];

  const vsUnderpairs = computeOuts({
    heroCards,
    board,
    opponent: parseRange('JJ, TT', blockers),
  });
  assertInvariants(vsUnderpairs);
  assert.equal(vsUnderpairs.cardsConsidered, 47, '52 - 2 hero - 3 board; a range is not a known hand');
  assert.equal(vsUnderpairs.cleanCount, 15);
  assert.equal(vsUnderpairs.dirtyCount, 0);
  closeTo(outcomeFor(vsUnderpairs, '3h').equityAfter, 1, '3h against underpairs');
  closeTo(outcomeFor(vsUnderpairs, 'Jh').equityAfter, 366 / 396, 'Jh against underpairs');
  closeTo(outcomeFor(vsUnderpairs, '2h').equityAfter, 40 / 44, '2h against underpairs');

  // Against QQ, 77 and 22 (nine combinations after blockers) none of the nine hearts is clean:
  //   * a heart that does not pair the board: hero makes the nut flush and every one
  //     of the nine combinations is a set that boats up on the last card of its own
  //     rank (1) or on any card pairing one of the three other board ranks (3 x 3),
  //     = 10 of 44 rivers, so 34/44 = 0.7727 for every combination. Dirty, not clean.
  //   * 2h: the board pairs, and every combination beats hero's flush at once.
  //     QQ and 77 are full houses and 22 is four deuces. Equity 0, not an out.
  //   * an ace or a king: a pair loses to a set, so no equity at all.
  const vsSets = computeOuts({
    heroCards,
    board,
    opponent: parseRange('QQ, 77, 22', blockers),
  });
  assertInvariants(vsSets);
  assert.equal(vsSets.cardsConsidered, 47);
  assert.equal(vsSets.cleanCount, 0);
  assert.equal(vsSets.dirtyCount, 8);
  assert.deepEqual(labelSet(vsSets.dirty), ['3h', '4h', '5h', '6h', '8h', '9h', 'Jh', 'Th']);
  for (const outcome of vsSets.dirty) closeTo(outcome.equityAfter, 34 / 44, `${outcome.label} against sets`);
  closeTo(outcomeFor(vsSets, '2h').equityAfter, 0, '2h against sets');

  // One card, one board, one hero hand, two ranges, two answers.
  assert.equal(outcomeFor(vsUnderpairs, '4h').classification, 'clean');
  assert.equal(outcomeFor(vsSets, '4h').classification, 'dirty');
  assert.equal(outcomeFor(vsUnderpairs, '2h').classification, 'clean');
  assert.equal(outcomeFor(vsSets, '2h').classification, 'neutral');
  assert.equal(outcomeFor(vsUnderpairs, 'Ac').classification, 'clean');
  assert.equal(outcomeFor(vsSets, 'Ac').classification, 'neutral');
  assert.ok(vsUnderpairs.equityNow > vsSets.equityNow, 'the same hand is worth more against underpairs');

  // Range results must say they assumed a uniform range; hand results must not.
  assert.ok(vsSets.assumptions.some((note) => note.includes('equally likely')));
  assert.ok(
    vsSets.assumptions.some((note) => note.includes('blocked')),
    'the range is filtered by what hero can see, and the result says by how much',
  );
});

test('raising the clean threshold moves cards between the buckets without changing the total', () => {
  // Same spot against JJ and TT. Three outs sit between 0.90 and 0.95, Jh and Th at 366/396 = 0.9242
  // and 2h at 40/44 = 0.9091 (derived above). At 95% exactly those three become dirty.
  const heroCards = parseCards('Ah Kh');
  const board = parseCards('Qh 7h 2c');
  const opponent = parseRange('JJ, TT', [...heroCards, ...board]);

  const relaxed = computeOuts({ heroCards, board, opponent });
  const strict = computeOuts({ heroCards, board, opponent, cleanThreshold: 0.95 });
  assertInvariants(strict);

  assert.equal(relaxed.cleanCount, 15);
  assert.equal(relaxed.dirtyCount, 0);
  assert.equal(strict.cleanCount, 12);
  assert.equal(strict.dirtyCount, 3);
  assert.deepEqual(labelSet(strict.dirty), ['2h', 'Jh', 'Th']);
  assert.equal(strict.totalOuts, relaxed.totalOuts, '15 outs either way — only the split is a choice');
  assert.ok(strict.assumptions.some((note) => note.includes('modelling choice')));
});

test('a card that only chops sits exactly on the dirty boundary', () => {
  // Hero 9c 8d against 9h 8s on 7s 6h 2c 3d. Same ranks and a rainbow board, so every river chops.
  // A chop is exactly 0.5, the inclusive bottom of dirty, so all 44 cards are dirty and none clean.
  const result = computeOuts({
    heroCards: parseCards('9c 8d'),
    board: parseCards('7s 6h 2c 3d'),
    opponent: exactRange(parseCards('9h 8s')),
  });
  assertInvariants(result);

  closeTo(result.equityNow, 0.5, 'equityNow');
  assert.equal(result.cleanCount, 0);
  assert.equal(result.dirtyCount, 44);
  assert.equal(result.neutral.length, 0);
  for (const outcome of result.dirty) closeTo(outcome.equityAfter, 0.5, `${outcome.label} after`);
  assert.match(outcomeFor(result, 'Kd').note, /chops/);

  const stricter = computeOuts({
    heroCards: parseCards('9c 8d'),
    board: parseCards('7s 6h 2c 3d'),
    opponent: exactRange(parseCards('9h 8s')),
    aheadThreshold: 0.51,
  });
  assert.equal(stricter.totalOuts, 0);
  assert.equal(stricter.neutral.length, 44);
});

test('a card the range cannot exist behind is left out of the count and said so', () => {
  // Hero Qh Qd on Js 8h 4c 2d against AKo, with Ad, Ah and As dead. Every AKo left uses Ac (AcKd,
  // AcKh, AcKs), so if Ac comes the opponent cannot hold the range at all.
  // Candidates are 52 - 2 hero - 4 board - 3 dead - 1 impossible = 42.
  // The four kings beat hero's queens, and 38 cards keep hero in front.
  const heroCards = parseCards('Qh Qd');
  const board = parseCards('Js 8h 4c 2d');
  const deadCards = parseCards('Ad Ah As');
  const result = computeOuts({
    heroCards,
    board,
    deadCards,
    opponent: parseRange('AKo', [...heroCards, ...board, ...deadCards]),
  });
  assertInvariants(result);

  assert.equal(result.cardsConsidered, 42);
  assert.deepEqual(labelSet(result.neutral), ['Kc', 'Kd', 'Kh', 'Ks']);
  assert.equal(result.cleanCount, 38);
  assert.ok(
    result.assumptions.some((note) => note.includes('Ac') && note.includes('cannot exist')),
    'the skipped card has to be named, not silently dropped',
  );
});

test('a wide range still comes back exact, and says so', () => {
  // The widest input. C(45,2) = 990 combinations x 44 rivers = 43,560 units, inside the exact budget.
  const heroCards = parseCards('Ah Kh');
  const board = parseCards('Qh 7h 2c');
  const result = computeOuts({
    heroCards,
    board,
    opponent: parseRange('random', [...heroCards, ...board]),
  });
  assertInvariants(result);

  assert.equal(result.method, 'exact-per-card');
  assert.ok(
    result.assumptions.every((note) => !note.includes('sampled')),
    'nothing in this result may have been estimated by sampling',
  );
  assert.ok(
    result.assumptions.some((note) => note.includes('enumerating every remaining board exactly')),
    'the exactness claim must be stated, not implied',
  );
  // Ace-king with the nut flush draw is already in front of a random hand.
  assert.ok(result.equityNow > 0.5);
  assert.match(result.explanation, /already in front/);
});

test('bad input is rejected with a message that says what was expected', () => {
  const board = parseCards('Kh 9h 4s 2c');
  const opponent = exactRange(parseCards('Kd 9c'));

  assert.throws(
    () => computeOuts({ heroCards: parseCards('Ah'), board, opponent }),
    { name: 'OutsError', message: /exactly 2 hero cards, received 1/ },
    'one hero card',
  );
  assert.throws(
    () => computeOuts({ heroCards: parseCards('Ah 6h Qd'), board, opponent }),
    { name: 'OutsError', message: /exactly 2 hero cards, received 3/ },
    'three hero cards',
  );
  assert.throws(
    () => computeOuts({ heroCards: parseCards('Ah 6h'), board: parseCards('Kh 9h 4s 2c 3d'), opponent }),
    { name: 'OutsError', message: /flop \(3 cards\) or a turn \(4 cards\), received 5/ },
    'a complete board has no card to come',
  );
  assert.throws(
    () => computeOuts({ heroCards: parseCards('Ah 6h'), board: parseCards('Kh 9h'), opponent }),
    { name: 'OutsError', message: /received 2/ },
    'two board cards is not a street',
  );
  assert.throws(
    () => computeOuts({ heroCards: parseCards('Kh 6h'), board, opponent }),
    { name: 'OutsError', message: /Kh appears twice/ },
    'a hero card that is also on the board',
  );
  assert.throws(
    () => computeOuts({ heroCards: parseCards('Ah 6h'), board, opponent, deadCards: parseCards('9h') }),
    { name: 'OutsError', message: /9h appears twice/ },
    'a dead card that is also on the board',
  );
  assert.throws(
    () => computeOuts({ heroCards: parseCards('Ah Ah'), board, opponent }),
    { name: 'OutsError', message: /Ah appears twice/ },
    'the same card twice in hand',
  );
  assert.throws(
    () => computeOuts({ heroCards: [52, 3], board, opponent }),
    { name: 'OutsError', message: /not a card id/ },
    'a number that is not a card',
  );

  assert.throws(
    () =>
      computeOuts({
        heroCards: parseCards('Ah 6h'),
        board,
        opponent: parseRange('AA', parseCards('Ah Ad Ac As')),
      }),
    { name: 'OutsError', message: /holds no combinations/ },
    'a range with nothing in it',
  );

  assert.throws(
    () =>
      computeOuts({
        heroCards: parseCards('Ah 6h'),
        board,
        opponent: exactRange(parseCards('Ah Qd')),
      }),
    { name: 'OutsError', message: /uses a card hero can see/ },
    'the opponent cannot hold a card hero is holding',
  );

  // 43 dead cards leave 3 unseen, which must fail as an OutsError, not an equity error.
  assert.throws(
    () =>
      computeOuts({
        heroCards: parseCards('Ah 6h'),
        board,
        opponent,
        deadCards: remainingDeck([...parseCards('Ah 6h'), ...board]).slice(0, 43),
      }),
    { name: 'OutsError', message: /not enough for a card to come/ },
    'the deck has to have something left in it',
  );

  assert.throws(() => computeOuts({ heroCards: parseCards('Ah 6h'), board, opponent, cleanThreshold: 1.5 }), {
    name: 'OutsError',
    message: /cleanThreshold must be a fraction between 0 and 1/,
  });
  assert.throws(
    () => computeOuts({ heroCards: parseCards('Ah 6h'), board, opponent, aheadThreshold: Number.NaN }),
    { name: 'OutsError', message: /aheadThreshold must be a fraction between 0 and 1/ },
  );
  assert.throws(
    () =>
      computeOuts({
        heroCards: parseCards('Ah 6h'),
        board,
        opponent,
        cleanThreshold: 0.6,
        aheadThreshold: 0.8,
      }),
    { name: 'OutsError', message: /must not exceed cleanThreshold/ },
    'an out cannot need more equity than a clean out',
  );

  assert.throws(
    () => computeOuts({ heroCards: [], board, opponent }),
    (error: unknown) => error instanceof OutsError && error.name === 'OutsError',
  );
});

test('two identical calls produce identical results, down to the notes', () => {
  const input = {
    heroCards: parseCards('Ah Qh'),
    board: parseCards('Kh 7h 2c'),
    opponent: parseRange('KK, QQ, 77, AQo', parseCards('Ah Qh Kh 7h 2c')),
  };
  const first = computeOuts(input);
  const second = computeOuts(input);

  assert.deepEqual(second, first, 'no randomness, no clock, no iteration-order dependence');
  assert.deepEqual(labelsInOrder(second.clean), labelsInOrder(first.clean));
  assert.deepEqual(labelsInOrder(second.neutral), labelsInOrder(first.neutral));

  // Best equity first, then ascending card id.
  const ordered = [...first.clean, ...first.dirty, ...first.neutral];
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous === undefined || current === undefined) throw new Error('missing outcome');
    if (previous.classification !== current.classification) continue;
    assert.ok(
      previous.equityAfter > current.equityAfter ||
        (previous.equityAfter === current.equityAfter && previous.card < current.card),
      `${previous.label} must sort before ${current.label}`,
    );
  }
});

test('outsSummaryFor gives the Coach the counts, the card lists and one sentence', () => {
  const result = computeOuts({
    heroCards: parseCards('Ah Qh'),
    board: parseCards('Kh 7h 2c'),
    opponent: exactRange(parseCards('Kd Kc')),
  });
  const summary = outsSummaryFor(result);

  assert.equal(summary.clean, 0);
  assert.equal(summary.dirty, 8);
  assert.equal(summary.total, 8);
  assert.deepEqual(summary.cleanCards, []);
  assert.deepEqual([...summary.dirtyCards].sort(), ['3h', '4h', '5h', '6h', '8h', '9h', 'Jh', 'Th']);
  assert.equal(summary.explanation, result.explanation);
  assert.equal(summary.total, summary.clean + summary.dirty);
  assert.deepEqual(summary.dirtyCards, labelsInOrder(result.dirty));

  // Hero is well under the bar here, so there is a count and no refusal.
  assert.equal(summary.refusal, null);
  assert.equal(summary.refusal, result.refusal);

  const madeHand = computeOuts({
    heroCards: parseCards('Kh Kd'),
    board: parseCards('Kc 7h 2c 3d'),
    opponent: exactRange(parseCards('7c 7d')),
  });
  const madeSummary = outsSummaryFor(madeHand);
  assert.notEqual(madeSummary.refusal, null, 'the flattened shape has to carry the refusal too');
  assert.equal(madeSummary.refusal?.kind, 'already-ahead');
});

test('the counts agree with their verbs and their nouns (REGRESSION)', () => {
  // "1 are clean and 0 are dirty, which is 1 outs in total" reached 9 of 36 Lab scenarios.
  // The fixture forces a count of one. Hero's set needs the last eight, the opponent holds the other.
  const single = computeOuts({
    heroCards: parseCards('8h 8d'),
    board: parseCards('Ah Kd Qc Js'),
    opponent: exactRange(parseCards('Ac 8s')),
  });
  assert.equal(single.cleanCount, 1, 'the fixture must produce a count of one for this to test anything');
  assert.match(single.explanation, /\b1 is clean\b/u);
  assert.ok(
    !/\b\d+ are clean and \d+ are dirty\b/u.test(single.explanation) || single.cleanCount !== 1,
    `a count of one was given a plural verb: "${single.explanation}"`,
  );

  const many = computeOuts({
    heroCards: parseCards('Ah 6h'),
    board: parseCards('Kh 9h 4s 2c'),
    opponent: exactRange(parseCards('Kd 9c')),
  });
  assert.equal(many.cleanCount, 9);
  assert.match(many.explanation, /\b9 are clean\b/u);
  assert.match(many.explanation, /\b9 outs in total\b/u);
});
