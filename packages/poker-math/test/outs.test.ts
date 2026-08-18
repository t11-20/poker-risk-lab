/**
 * Tests for outs analysis.
 *
 * Every expected number below is derived by hand, in a comment, from card counting —
 * never by running the implementation and pasting what came out. Most scenarios are
 * set on the TURN on purpose: with one card to come and a known opponent hand, hero's
 * equity after a card can only be 1 (hero wins that river), 0.5 (a chop) or 0, so the
 * whole result reduces to "how many of the 44 remaining cards win", which is
 * countable on paper. The flop scenarios then check the interesting part — that a
 * card can put hero in front and still leave hero beatable — and their expectations
 * are stated as exact fractions with the count of losing rivers spelled out.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardToString, parseCards, remainingDeck } from '@prl/poker-engine';
import type { CardOutcome, OutsResult } from '../src/outs.ts';
import { computeOuts, OutsError, outsSummaryFor } from '../src/outs.ts';
import { exactRange, parseRange } from '../src/ranges.ts';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Labels in the order the result returned them (best equity first, then card id). */
function labelsInOrder(outcomes: readonly CardOutcome[]): string[] {
  return outcomes.map((outcome) => outcome.label);
}

/** Labels as a set, for assertions where the display order is not the point. */
function labelSet(outcomes: readonly CardOutcome[]): string[] {
  return [...outcomes.map((outcome) => outcome.label)].sort();
}

function outcomeFor(result: OutsResult, label: string): CardOutcome {
  const all = [...result.clean, ...result.dirty, ...result.neutral];
  const found = all.find((outcome) => outcome.label === label);
  if (found === undefined) throw new Error(`no outcome for ${label} in this result`);
  return found;
}

/** Floating point comparison against an exact rational expectation. */
function closeTo(actual: number, expected: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `${what}: expected ${expected} (${expected.toFixed(6)}), got ${actual} (${actual.toFixed(6)})`,
  );
}

/** Every result must partition the cards it considered, with equities in range. */
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

// ---------------------------------------------------------------------------
// 1. a bare nut flush draw where every flush card wins
// ---------------------------------------------------------------------------

test('a bare nut flush draw against a hand it dominates has exactly 9 clean outs', () => {
  // Hero Ah 6h on Kh 9h 4s 2c against Kd 9c (two pair, kings and nines).
  //
  // Hearts: 13 in the deck, 4 visible (Ah, 6h, Kh, 9h), so 9 remain and none of
  // them is in the opponent's hand. Each makes hero an ace-high flush; the opponent
  // holds no heart and the board has no pair, so no river card can give them a full
  // house — a flush wins every time.
  //
  // Hero cannot win any other way: pairing the ace or the six still loses to two
  // pair, and A-6 with K-9-4-2 cannot make a straight. So hero wins on exactly 9 of
  // the 44 unseen cards and equityNow = 9/44.
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

  // On the river the answer is binary: a heart wins the whole pot, anything else
  // wins none of it.
  for (const outcome of result.clean) closeTo(outcome.equityAfter, 1, `${outcome.label} after`);
  for (const outcome of result.neutral) closeTo(outcome.equityAfter, 0, `${outcome.label} after`);

  assert.match(outcomeFor(result, 'Qh').note, /flush/);
  assert.match(result.explanation, /9 are clean and 0 are dirty/);
});

// ---------------------------------------------------------------------------
// 2. flush cards that also complete a straight for the opponent
// ---------------------------------------------------------------------------

test('flush cards that complete a straight flush for the opponent are not outs at all', () => {
  // Hero Ah Kh on 8h 9h 6c 2d against 7h 6h — they have a pair of sixes plus an
  // open-ended straight draw and a flush draw, so hero is behind with ace-king high.
  //
  // "Nine outs to the nut flush" is wrong twice over here.
  //
  // First, the opponent is holding two of hero's hearts: 13 hearts less Ah, Kh, 8h,
  // 9h, 7h, 6h leaves SEVEN — 2h, 3h, 4h, 5h, Th, Jh, Qh.
  //
  // Second, two of those seven complete a straight for them, and because their
  // straight is in hearts it is a STRAIGHT FLUSH, which beats hero's flush:
  //   5h  ->  5h 6h 7h 8h 9h
  //   Th  ->  6h 7h 8h 9h Th
  // The other five hearts give them only a nine-high flush against hero's ace-high
  // flush, so hero wins those.
  //
  // Hero's other outs are the overcards: three aces and three kings each make a pair
  // that beats their pair of sixes (the board is 8-9-6-2 with no pair, so they cannot
  // improve past one pair on a blank river).
  //
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

  // The exact split of the seven flush cards: five win, two lose outright.
  const flushCards = ['2h', '3h', '4h', '5h', 'Th', 'Jh', 'Qh'];
  const good = flushCards.filter((label) => outcomeFor(result, label).classification === 'clean');
  const bad = flushCards.filter((label) => outcomeFor(result, label).classification === 'neutral');
  assert.deepEqual(good, ['2h', '3h', '4h', 'Jh', 'Qh']);
  assert.deepEqual(bad, ['5h', 'Th'], 'these two make them a straight flush');
  for (const label of bad) {
    closeTo(outcomeFor(result, label).equityAfter, 0, `${label} after`);
    assert.match(outcomeFor(result, label).note, /straight flush/);
  }
  // Nothing here is merely "dirty": on the river a card either wins or it does not.
  assert.equal(result.dirty.length, 0);
});

test('nine flush cards can be worth zero clean outs and eight dirty ones', () => {
  // The headline claim of the module, on a flop this time. Hero Ah Qh on Kh 7h 2c
  // against Kd Kc — a set of kings.
  //
  // Nine hearts remain (13 less Ah, Qh, Kh, 7h). Each of the other eight makes hero
  // an ace-high flush on the turn, but the set is live for a full house on the river.
  // Take 3h: the board is Kh 7h 2c 3h and they hold Kd Kc, so they win with
  //   the last king (Ks)         1 card   -> four of a kind
  //   any seven (7c 7d 7s)       3 cards  -> kings full
  //   any deuce (2d 2h 2s)       3 cards  -> kings full
  //   any three (3c 3d 3s)       3 cards  -> kings full
  // = 10 of the 44 remaining cards, so hero's equity after 3h is 34/44 = 0.7727.
  // That is well under the 0.90 clean threshold: a dirty out.
  //
  // The ninth heart, 2h, pairs the board immediately: they have kings full of deuces
  // against hero's flush, so hero loses outright and it is not an out at all.
  //
  // Hero has nothing else: an ace or a queen pairs into a set, and A-Q with K-7-2
  // cannot make a straight.
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

// ---------------------------------------------------------------------------
// 3. an open-ended straight draw
// ---------------------------------------------------------------------------

test('an open-ended straight draw has 8 outs, all clean against a set it beats', () => {
  // Hero 9c 8d on 7s 6h 2c 3d against 7d 7c (a set of sevens; the board's 7s makes
  // three). Hero has 9-8-7-6 and needs a five or a ten: 4 + 4 = 8 cards, none of
  // them held by the opponent.
  //
  // Every one of the eight is clean. The board 7-6-2-3 has no pair, and neither a
  // five nor a ten pairs it, so their set can never become a full house on the card
  // that makes hero's straight — and a straight beats three of a kind.
  //
  // Hero has no other winner: pairing the nine or the eight still loses to the set,
  // and the board is rainbow (s, h, c, d) so no flush is possible for anyone.
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

  // The fourth seven is not an out for hero and must not be counted as one: it gives
  // them four of a kind.
  assert.equal(outcomeFor(result, '7h').classification, 'neutral');
});

// ---------------------------------------------------------------------------
// 4. a gutshot
// ---------------------------------------------------------------------------

test('a gutshot has 4 outs', () => {
  // Hero Jc Tc on 9h 7d 2c 5s against 9c 9s (a set of nines). Hero has J-T-9-7 and
  // only an eight fills it: exactly 4 cards, all live.
  //
  // Each eight makes 7-8-9-T-J, which beats three of a kind, and no eight pairs the
  // board (9-7-2-5) so the set cannot boat up on the same card. Hero has three clubs
  // (Jc, Tc, 2c) and so cannot flush. Pairing a jack or a ten loses to the set.
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

  // 4/44 is 9.1%, and the explanation must show the figure rather than round it to
  // a flat "9%".
  assert.match(result.explanation, /9\.1% equity/);
});

// ---------------------------------------------------------------------------
// 5. a hand that is already ahead
// ---------------------------------------------------------------------------

test('a hand that is already ahead is reported as such, not as a 43-out draw', () => {
  // Hero Kh Kd on Kc 7h 2c 3d against 7c 7d. Hero has three kings, they have three
  // sevens, and the board is unpaired.
  //
  // Only one river beats hero: 7s, which makes them four of a kind (hero's kings
  // full of sevens is second best). Every other card leaves hero in front — 43 of
  // 44 — so equityNow = 43/44 and the "clean" bucket holds 43 cards.
  //
  // That count is literally correct and would be badly misleading if it were read as
  // a draw, so the result has to say out loud that hero is not drawing.
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

  // Cards that "improve" hero are not treated as rescues: a deuce makes kings full
  // and the note says hero was already in front of the hand it beats.
  const boat = outcomeFor(result, '2d');
  assert.equal(boat.classification, 'clean');
  closeTo(boat.equityAfter, 1, '2d after');
  assert.match(boat.note, /full house/);
});

// ---------------------------------------------------------------------------
// 6. overcards to a pair
// ---------------------------------------------------------------------------

test('two overcards to a pair are 6 outs, clean on the turn and dirty if the bar is raised', () => {
  // Hero Ac Kd on Qh 7s 2c 3d against 9h 9c. Hero is behind with ace-king high and
  // needs to pair: three aces and three kings, 6 cards.
  //
  // On the turn all six are clean. The board Q-7-2-3 is unpaired and rainbow, so a
  // pair of nines cannot become anything better on the one remaining card, and a
  // pair of aces or kings beats it. Hero has no straight (A-K needs both J and T)
  // and no flush. equityNow = 6/44.
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

  // Now the same hand one card earlier, on the flop Qh 7s 2c, where the six outs are
  // no longer perfect:
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

  // The thresholds are a parameter, not a fact. Ask for 96% and the same six cards
  // — unchanged, still 42/44 — become dirty outs. The total does not move.
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

// ---------------------------------------------------------------------------
// 7. a counterfeit
// ---------------------------------------------------------------------------

test('a counterfeit card is not an out: the board pairing higher hands the pot over', () => {
  // Hero 6s 5s on 9c 6d 5c 2h against Ah 9h. Hero has two pair, sixes and fives;
  // they have a pair of nines. Hero is ahead, and 8 of the 44 rivers take it away:
  //   any ace   (Ac Ad As)  3  -> aces and nines beats sixes and fives
  //   any nine  (9d 9s)     2  -> three nines
  //   any deuce (2c 2d 2s)  3  -> nines and deuces beats sixes and fives; hero's
  //                               two pair is COUNTERFEITED by a board pair higher
  //                               than either of hero's pairs
  // Everything else holds: a six or a five fills hero up, and no other card helps
  // them. So hero wins 36 of 44 and equityNow = 36/44.
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

  // The deuces are the teaching case: hero's hand did not get worse, the opponent's
  // got better, and the note has to say which.
  for (const label of ['2c', '2d', '2s']) {
    const outcome = outcomeFor(result, label);
    assert.equal(outcome.classification, 'neutral');
    closeTo(outcome.equityAfter, 0, `${label} after`);
    assert.match(outcome.note, /two pair, nines and deuces/);
    assert.match(outcome.note, /flipped it/);
  }
  // Hero is in front but not safely so, and the result says that too.
  assert.match(result.explanation, /already in front/);
});

// ---------------------------------------------------------------------------
// 8. the same cards against different ranges
// ---------------------------------------------------------------------------

test('outs are a property of the range, not of the cards: the same heart is clean or dead', () => {
  // Hero Ah Kh on Qh 7h 2c. Nine hearts remain (13 less Ah, Kh, Qh, 7h) and three
  // aces and three kings can pair hero up.
  //
  // Against JJ and TT — 12 combinations, none of which can hold a heart hero needs
  // for the flush count and none of which can make a full house without first making
  // a set — all 15 of those cards are clean:
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

  // Against sets — QQ, 77 and 22, nine combinations once hero's and the board's
  // cards are removed — the same nine hearts are worth nothing clean:
  //   * a heart that does not pair the board: hero makes the nut flush and every one
  //     of the nine combinations is a set that boats up on the last card of its own
  //     rank (1) or on any card pairing one of the three other board ranks (3 x 3),
  //     = 10 of 44 rivers, so 34/44 = 0.7727 for every combination. Dirty, not clean.
  //   * 2h: the board pairs, and every combination beats hero's flush at once —
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

  // The point, stated as an assertion: one card, one board, one hero hand, two
  // ranges, two different answers.
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
  // Same spot as above against JJ and TT. Three of the fifteen outs sit between 0.90
  // and 0.95: Jh and Th at 366/396 = 0.9242 and 2h at 40/44 = 0.9091 (both derived
  // in the test above). Ask for 95% and exactly those three become dirty.
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

// ---------------------------------------------------------------------------
// extra cases the definitions have to get right
// ---------------------------------------------------------------------------

test('a card that only chops sits exactly on the dirty boundary', () => {
  // Hero 9c 8d against 9h 8s on 7s 6h 2c 3d. The two hands hold the same ranks and
  // the board has one card of each suit, so no flush is possible for anyone and
  // every single river produces an identical five-card hand: every card chops.
  //
  // A chop is a pot share of exactly 0.5, which is exactly aheadThreshold, and the
  // definition of dirty is inclusive at the bottom — so all 44 cards are dirty outs
  // and none is clean. That is the honest answer for a hand that cannot win: it is
  // also a reminder that "44 outs" is meaningless without the split beside it.
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

  // Move the bar above a chop and every one of them stops being an out.
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
  // Hero Qh Qd on Js 8h 4c 2d against A-K offsuit, with Ad, Ah and As exposed as
  // dead cards. Every A-K offsuit combination left must use the club ace: AcKd, AcKh
  // and AcKs. So if the ace of clubs comes off the deck, the opponent cannot hold
  // A-K at all — the card and the range assumption contradict each other, and
  // counting the card either way would be a claim about a hand that cannot exist.
  //
  // Candidates are therefore 52 - 2 hero - 4 board - 3 dead - 1 impossible = 42.
  // The four kings are the only cards that beat hero (any king gives them a pair of
  // kings against hero's queens), and 38 cards keep hero in front.
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
  // The widest input this function can be handed: hero Ah Kh on Qh 7h 2c against
  // every hand. C(45,2) = 990 combinations against 44 rivers per card is 43,560
  // units of work, far inside the exact-enumeration budget, so no figure here may
  // be sampled.
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
  // Against a random hand hero is already in front with ace-king and the nut flush
  // draw, so the result must not present its buckets as the size of a draw.
  assert.ok(result.equityNow > 0.5);
  assert.match(result.explanation, /already in front/);
});

// ---------------------------------------------------------------------------
// 9. input validation
// ---------------------------------------------------------------------------

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

  // An empty range: "AA" with all four aces accounted for elsewhere.
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

  // A range that is not empty but that hero's own cards make impossible.
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

  // Absurd, but it must fail as an OutsError rather than as an equity error from two
  // layers down: 43 dead cards leave only 3 unseen, which cannot cover a card to come,
  // an opponent hand and a run-out.
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

  // Thresholds.
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

  // The error class is the named one, so callers can branch on it.
  assert.throws(
    () => computeOuts({ heroCards: [], board, opponent }),
    (error: unknown) => error instanceof OutsError && error.name === 'OutsError',
  );
});

// ---------------------------------------------------------------------------
// 10. determinism
// ---------------------------------------------------------------------------

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

  // The ordering itself is defined: best equity first, then ascending card id.
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

// ---------------------------------------------------------------------------
// the Coach's view of the result
// ---------------------------------------------------------------------------

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
  // The summary is a view, never a second opinion.
  assert.deepEqual(summary.dirtyCards, labelsInOrder(result.dirty));
});
