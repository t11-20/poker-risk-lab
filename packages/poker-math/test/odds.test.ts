/**
 * Tests for the price-of-a-call family.
 *
 * Every expected value below comes from somewhere other than `odds.ts`: arithmetic
 * worked out longhand in the comment above the assertion, a closed-form identity, a
 * brute-force count over an urn, or — for the one that matters most — an exhaustive
 * enumeration of real run-outs through `@prl/poker-engine`. Nothing here is compared
 * against the implementation's own output, because that would only prove the code
 * agrees with itself.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  categoryOf,
  evaluate,
  HAND_CATEGORY,
  parseCards,
  remainingDeck,
  suitIndexOf,
} from '@prl/poker-engine';
import {
  defenceFrequency,
  impliedOdds,
  maximumOutsForRuleOf24,
  OddsError,
  potOdds,
  priceLaidByBet,
  probabilityOfHitting,
  reverseImpliedOdds,
  ruleOf24,
  ruleOf24Accuracy,
} from '../src/odds.ts';

/**
 * A deliberately loose view of the two functions that take `cardsToCome`.
 *
 * The parameter is typed `1 | 2`, so TypeScript will never let a 3 reach them — but
 * a JSON request body will, which is why the runtime guard exists and why it has to
 * be tested. Parameters of method-shorthand signatures are compared bivariantly even
 * under `strictFunctionTypes`, so this assignment is legal with no cast and no `any`.
 */
interface LooseCardsToCome {
  ruleOf24(outs: number, cardsToCome: number): unknown;
  probabilityOfHitting(outs: number, unseen: number, cardsToCome: number): unknown;
}
const loose: LooseCardsToCome = { ruleOf24, probabilityOfHitting };

// ---------------------------------------------------------------------------
// Pot odds and the price a bet lays
// ---------------------------------------------------------------------------

test('a pot-sized bet lays 2 to 1, so the caller needs exactly one third', () => {
  // Longhand: a bet of 100 into a pot of 100 leaves 200 in the middle. The caller
  // puts in 100 to win that 200, so calling is 100 to win 200 — 2 to 1. Break even
  // where the two sides are equal: p * 200 = (1 - p) * 100, so 300p = 100, p = 1/3.
  // The closed form must agree: 100 / (100 + 2 * 100) = 100/300 = 1/3.
  const price = priceLaidByBet(100, 100);
  assert.equal(price.breakEvenEquity, 1 / 3);
  assert.equal(price.oddsRatio, 2);
  assert.equal(price.pot, 200, 'the middle reported by priceLaidByBet already contains the bet');
  assert.equal(price.toCall, 100);
  assert.equal(price.breakEvenEquity, 100 / (100 + 2 * 100), 'the denominator is pot + 2 x bet');
});

test('a half-pot bet lays 3 to 1, so the caller needs exactly one quarter', () => {
  // Longhand: 50 into 100 leaves 150 in the middle, and the call costs 50, so the
  // caller is getting 150 to 50 = 3 to 1. Break even: p * 150 = (1 - p) * 50, so
  // 200p = 50, p = 1/4. Closed form: 50 / (100 + 2 * 50) = 50/200 = 0.25.
  const price = priceLaidByBet(100, 50);
  assert.equal(price.breakEvenEquity, 0.25);
  assert.equal(price.oddsRatio, 3);
  assert.equal(price.breakEvenEquity, 50 / (100 + 2 * 50));

  // A quarter-pot bet: 25 into 100 leaves 125, so 125 to 25 = 5 to 1, needing
  // 25 / (100 + 50) = 1/6. A two-thirds bet: 80 into 120 leaves 200, so 200 to 80 =
  // 2.5 to 1, needing 80 / (120 + 160) = 80/280 = 2/7.
  assert.equal(priceLaidByBet(100, 25).oddsRatio, 5);
  assert.equal(priceLaidByBet(100, 25).breakEvenEquity, 1 / 6);
  assert.equal(priceLaidByBet(120, 80).oddsRatio, 2.5);
  assert.equal(priceLaidByBet(120, 80).breakEvenEquity, 2 / 7);
});

test('breakEvenEquity for a pot of 100 with 50 to call is exactly one third', () => {
  // `pot` excludes hero's own call, so this is "100 in the middle, 50 to call".
  // Risking 50 to win 100 is 2 to 1: p * 100 = (1 - p) * 50 gives 150p = 50, p = 1/3.
  // Closed form: 50 / (100 + 50) = 50/150 = 1/3.
  const odds = potOdds(100, 50);
  assert.equal(odds.breakEvenEquity, 1 / 3);
  assert.equal(odds.oddsRatio, 2);
  assert.match(odds.explanation, /33\.3%/);
  assert.match(odds.explanation, /before hero's own 50 goes in/, 'the exclusion is stated for the learner');
});

test('the price a bet lays the caller is 1 / (ratio + 1) for every sizing', () => {
  // Independent identity: "getting R to 1" means risking 1 to win R, which breaks
  // even at 1 / (R + 1) by definition of the odds notation. Any implementation where
  // breakEvenEquity and oddsRatio disagree about that has one of the two wrong.
  // Checked to a tolerance rather than exactly: both sides are separately rounded
  // divisions, and 1/(R+1) can land one ulp away from bet/(pot + 2*bet).
  let checked = 0;
  for (let pot = 0; pot <= 200; pot += 1) {
    for (let bet = 1; bet <= 200; bet += 1) {
      const price = priceLaidByBet(pot, bet);
      // A bet is positive by construction — `priceLaidByBet` refuses 0 — so there is
      // always a price here. Asserted rather than assumed, because that is what turns
      // `number | null` into the `number` the identity below needs, with no cast.
      assert.notEqual(price.oddsRatio, null, `pot ${pot}, bet ${bet}: a real bet always lays a price`);
      if (price.oddsRatio === null) return;
      assert.ok(
        Math.abs(price.breakEvenEquity - 1 / (price.oddsRatio + 1)) < 1e-12,
        `pot ${pot}, bet ${bet}: ${price.breakEvenEquity} vs ${1 / (price.oddsRatio + 1)}`,
      );
      checked += 1;
    }
  }
  assert.equal(checked, 201 * 200);
});

test('checking is free: nothing to call needs no equity and has no price', () => {
  const odds = potOdds(120, 0);
  assert.equal(odds.breakEvenEquity, 0);
  // This assertion used to read `Number.POSITIVE_INFINITY`, and that expectation was
  // wrong — not about the maths, which has no answer here either way, but about what a
  // value of this type is allowed to be. `oddsRatio` crosses an HTTP and a WebSocket
  // boundary, `JSON.stringify(Infinity)` is `"null"`, and so every free-call spot
  // arrived at the browser as `null` against a contract that declared `number`. The
  // sentinel is now the value JSON itself produces, which is the only one that can make
  // the round trip. See the header of `src/odds.ts`.
  assert.equal(odds.oddsRatio, null, 'there is no "X to 1" price on a free look');
  assert.match(odds.explanation, /free/i);
  assert.equal(odds.explanation.includes('Infinity'), false, 'no sentinel leaks into the prose');

  // The degenerate case that would otherwise produce 0/0. NaN would compare false
  // against itself and quietly poison every figure downstream, so it must not appear —
  // and neither must 0, which is a real price rather than the absence of one.
  const empty = potOdds(0, 0);
  assert.equal(empty.breakEvenEquity, 0);
  assert.equal(Number.isNaN(empty.breakEvenEquity), false);
  assert.equal(empty.oddsRatio, null);
  assert.notEqual(empty.oddsRatio, 0);
});

test('the free-call price survives the wire, which the old sentinel could not', () => {
  // The regression test for the actual defect. `Infinity` is not JSON: it serialises to
  // `null` and comes back as `null`, so a member typed `number` was a lie the moment it
  // was serialised. `null` is a fixed point of the round trip.
  const free = potOdds(120, 0);
  const priced = potOdds(100, 50);

  assert.deepEqual(JSON.parse(JSON.stringify(free)), free);
  assert.deepEqual(JSON.parse(JSON.stringify(priced)), priced);

  const parsed: unknown = JSON.parse(JSON.stringify(free));
  assert.ok(typeof parsed === 'object' && parsed !== null);
  assert.equal((parsed as { readonly oddsRatio: unknown }).oddsRatio, null);

  // And the shape of the failure, so nobody restores the old sentinel: this is what the
  // wire did to it.
  assert.equal(JSON.stringify({ oddsRatio: Number.POSITIVE_INFINITY }), '{"oddsRatio":null}');
});

// ---------------------------------------------------------------------------
// Minimum defence frequency and alpha
// ---------------------------------------------------------------------------

test('MDF and alpha are hand-derivable and always add to exactly 1', () => {
  // A bluff of 50 into 100 risks 50 to win 100, so it breaks even when it works
  // 50 / (100 + 50) = 1/3 of the time: that is alpha. The defence that removes the
  // free profit is the rest, 100/150 = 2/3.
  const half = defenceFrequency(100, 50);
  assert.equal(half.alpha, 1 / 3);
  assert.equal(half.minimumDefenceFrequency, 2 / 3);

  // A pot-sized bluff risks 100 to win 100, so it breaks even at 50%.
  const potSized = defenceFrequency(100, 100);
  assert.equal(potSized.alpha, 0.5);
  assert.equal(potSized.minimumDefenceFrequency, 0.5);

  // The complement identity, over every integer pot/bet pair up to 120. Integer chip
  // amounts make pot + bet exact, and the two rounded halves come back to exactly 1
  // for every pair here.
  let checked = 0;
  for (let pot = 0; pot <= 120; pot += 1) {
    for (let bet = 1; bet <= 120; bet += 1) {
      const result = defenceFrequency(pot, bet);
      assert.equal(
        result.minimumDefenceFrequency + result.alpha,
        1,
        `pot ${pot}, bet ${bet} should split exactly into MDF + alpha`,
      );
      checked += 1;
    }
  }
  assert.equal(checked, 121 * 120);

  // Fractional amounts (an averaged pot, say) cannot promise bit-exactness: two
  // separately rounded divisions can land an ulp or two off 1. The identity still
  // holds to any precision anyone can act on.
  for (const [pot, bet] of [
    [0.5, 1.5],
    [33.33, 66.67],
    [1e6 + 0.5, 1],
    [7.125, 19.875],
  ] as const) {
    const result = defenceFrequency(pot, bet);
    assert.ok(Math.abs(result.minimumDefenceFrequency + result.alpha - 1) < 1e-12);
  }
});

test('alpha is not the price the bet lays the caller', () => {
  // Same pot, same bet, two different questions. Alpha asks how often a bluff has to
  // work: 100 / (100 + 100) = 50%. The caller's break-even asks what equity a call
  // needs: 100 / (100 + 2 x 100) = 33.3%. Quoting one as the other is the classic
  // error, so this test exists to keep the two numbers apart.
  const defence = defenceFrequency(100, 100);
  const price = priceLaidByBet(100, 100);
  assert.equal(defence.alpha, 0.5);
  assert.equal(price.breakEvenEquity, 1 / 3);
  assert.notEqual(defence.alpha, price.breakEvenEquity);

  // The caveat has to say where the number comes from, not just wave at it.
  assert.match(defence.caveat, /polarised/);
  assert.match(defence.caveat, /never bluffs/);
});

// ---------------------------------------------------------------------------
// The exact hit probability
// ---------------------------------------------------------------------------

test('one card to come is outs over unseen, exactly', () => {
  // A flush draw on the flop, counting only the river: 9 of the 47 unseen cards.
  assert.equal(probabilityOfHitting(9, 47, 1).probability, 9 / 47);
  // The same draw with the turn already dealt and missed: 9 of 46.
  assert.equal(probabilityOfHitting(9, 46, 1).probability, 9 / 46);
  assert.equal(probabilityOfHitting(0, 47, 1).probability, 0, 'no outs is no chance');
  assert.equal(probabilityOfHitting(47, 47, 1).probability, 1, 'every card an out is certainty');
});

test('two cards to come matches the hand-computed complement', () => {
  // Hand arithmetic for a nine-out draw with 47 cards unseen:
  //   the turn misses 38/47, then the river misses 37/46,
  //   so both miss (38 x 37) / (47 x 46) = 1406/2162 = 0.650324,
  //   so at least one hits 1 - 0.650324 = 0.349676 = 34.97%.
  const expected = 1 - (38 / 47) * (37 / 46);
  const result = probabilityOfHitting(9, 47, 2);
  assert.equal(result.probability, expected);
  assert.ok(Math.abs(result.probability - 0.349676) < 1e-6, 'the familiar "about 35%" for a flush draw');
  assert.match(result.derivation, /1 - \(38\/47\) x \(37\/46\)|both cards miss/);
  assert.match(result.derivation, /34\.97%|35\.0%/);

  // A four-out gutshot: 1 - (43/47) x (42/46) = 1 - 1806/2162 = 0.164662 = 16.47%.
  assert.equal(probabilityOfHitting(4, 47, 2).probability, 1 - (43 / 47) * (42 / 46));
  // Fifteen outs (flush plus open-ended straight): 1 - (32/47) x (31/46) = 0.541166.
  assert.equal(probabilityOfHitting(15, 47, 2).probability, 1 - (32 / 47) * (31 / 46));
  assert.ok(Math.abs(probabilityOfHitting(15, 47, 2).probability - 0.541166) < 1e-6);
});

test('two cards to come never double counts, and the boundary cases are exact', () => {
  // The wrong way to do it is to add the two streets: 9/47 + 9/46 = 38.7%, which
  // counts every run-out that hits on both cards twice. The complement is 35.0%, so
  // the naive sum is nearly four points too high — the derivation says so out loud.
  const naive = 9 / 47 + 9 / 46;
  const result = probabilityOfHitting(9, 47, 2);
  assert.ok(naive > result.probability + 0.03, 'the additive shortcut overstates by more than 3 points');
  assert.match(result.derivation, /twice/);

  assert.equal(probabilityOfHitting(0, 47, 2).probability, 0, 'no outs is still no chance');
  assert.equal(probabilityOfHitting(47, 47, 2).probability, 1, 'every card an out is still certainty');
  // With 46 of 47 cards live, only one card misses, so two cards cannot both miss.
  assert.equal(probabilityOfHitting(46, 47, 2).probability, 1);
  // Two cards to come is never worse than one, and strictly better whenever there is
  // an out to hit and a card that can miss.
  for (const outs of [1, 4, 9, 15, 21]) {
    const one = probabilityOfHitting(outs, 47, 1).probability;
    const two = probabilityOfHitting(outs, 47, 2).probability;
    assert.ok(two > one, `${outs} outs: two cards (${two}) must beat one (${one})`);
  }
});

test('the closed form matches a brute-force count over the urn', () => {
  // Independent ground truth: enumerate every unordered pair of positions out of
  // `unseen`, treat the first `outs` positions as the winning cards, and count. This
  // is C(unseen, 2) additions with no probability theory in it at all.
  const cases = [
    [1, 2],
    [2, 5],
    [3, 10],
    [4, 47],
    [9, 47],
    [12, 46],
    [15, 47],
    [46, 47],
    [47, 47],
  ] as const;
  for (const [outs, unseen] of cases) {
    let hits = 0;
    let total = 0;
    for (let first = 0; first < unseen; first += 1) {
      for (let second = first + 1; second < unseen; second += 1) {
        total += 1;
        if (first < outs || second < outs) hits += 1;
      }
    }
    const bruteForce = hits / total;
    const closedForm = probabilityOfHitting(outs, unseen, 2).probability;
    assert.ok(
      Math.abs(bruteForce - closedForm) < 1e-12,
      `${outs} outs of ${unseen}: brute force ${bruteForce} vs closed form ${closedForm}`,
    );
  }
});

test('the closed form matches real run-outs enumerated with the engine', () => {
  // Hero holds Ah Kh on a flop of Qh 7h 2c: four hearts, so nine hearts are still
  // out there and 47 cards are unseen. Enumerate every one of the C(47,2) = 1081
  // two-card run-outs and count two independent ways:
  //   (a) does the run-out contain a heart, by suit;
  //   (b) does the ENGINE score the resulting seven cards as a flush.
  // (a) and (b) must agree here, because with two hearts in hand and two on the
  // board any heart completes the flush, and no other suit can reach five cards
  // (clubs top out at three, diamonds and spades at two). Counting via `evaluate`
  // is what makes this a check against the engine rather than against my own suit
  // arithmetic.
  const hero = parseCards('AhKh');
  const flop = parseCards('Qh7h2c');
  const stub = remainingDeck([...hero, ...flop]);
  assert.equal(stub.length, 47, '52 - 2 hole cards - 3 flop cards');
  const HEARTS = 2; // suit index order is c, d, h, s
  assert.equal(stub.filter((card) => suitIndexOf(card) === HEARTS).length, 9, 'nine hearts left');

  let total = 0;
  let withFlushCard = 0;
  let scoredAsFlush = 0;
  for (let i = 0; i < stub.length; i += 1) {
    for (let j = i + 1; j < stub.length; j += 1) {
      const turn = stub[i];
      const river = stub[j];
      if (turn === undefined || river === undefined) continue;
      total += 1;
      if (suitIndexOf(turn) === HEARTS || suitIndexOf(river) === HEARTS) withFlushCard += 1;
      const category = categoryOf(evaluate([...hero, ...flop, turn, river]));
      if (category === HAND_CATEGORY.flush || category === HAND_CATEGORY.straightFlush) {
        scoredAsFlush += 1;
      }
    }
  }

  // C(47,2) = 47 x 46 / 2 = 1081. Run-outs with no heart: C(38,2) = 38 x 37 / 2 =
  // 703. So run-outs with at least one heart: 1081 - 703 = 378.
  assert.equal(total, 1081);
  assert.equal(withFlushCard, 378);
  assert.equal(scoredAsFlush, 378, 'the engine agrees that a heart, and only a heart, makes the flush');

  const enumerated = withFlushCard / total;
  const closedForm = probabilityOfHitting(9, 47, 2).probability;
  assert.ok(
    Math.abs(enumerated - closedForm) < 1e-12,
    `enumerated ${enumerated} (378/1081) vs closed form ${closedForm}`,
  );
});

// ---------------------------------------------------------------------------
// The rule of 2 and 4
// ---------------------------------------------------------------------------

test('the rule of 2 and 4 multiplies by 2 for one card and 4 for two', () => {
  const river = ruleOf24(9, 1);
  assert.equal(river.multiplier, 2);
  assert.equal(river.estimatePercent, 18);
  const both = ruleOf24(9, 2);
  assert.equal(both.multiplier, 4);
  assert.equal(both.estimatePercent, 36);
  assert.equal(ruleOf24(0, 2).estimatePercent, 0);
  assert.equal(ruleOf24(15, 2).estimatePercent, 60);
});

test('the caveat names the specific error rather than warning vaguely', () => {
  // This is release-blocking content, not prose: the shortcut is taught here, so the
  // place where it breaks has to be stated with numbers attached.
  const both = ruleOf24(9, 2);
  assert.match(both.caveat, /turn/, 'the x4 form assumes both cards arrive for this price');
  assert.match(both.caveat, /15 outs/);
  assert.match(both.caveat, /60%/);
  assert.match(both.caveat, /54\.1%/);
  const river = ruleOf24(9, 1);
  assert.match(river.caveat, /2\.17%/, 'one card off a 46-card stub is worth more than 2%');
  assert.match(river.caveat, /19\.6%/);
});

test('the x4 error grows with the out count above four outs, and changes sign between six and seven', () => {
  // Exact figures, hand-derived from the complement with 47 cards unseen:
  //    4 outs: 1 - (43/47)(42/46) = 1 - 1806/2162 = 16.4662%  → x4 says 16, so -0.47
  //    9 outs: 1 - (38/47)(37/46) = 1 - 1406/2162 = 34.9676%  → x4 says 36, so +1.03
  //   15 outs: 1 - (32/47)(31/46) = 1 -  992/2162 = 54.1166%  → x4 says 60, so +5.88
  const at = (outs: number) => ruleOf24Accuracy(outs, 2, probabilityOfHitting(outs, 47, 2).probability);

  const four = at(4);
  const nine = at(9);
  const fifteen = at(15);

  assert.ok(Math.abs(four.exactPercent - 16.4662) < 1e-3);
  assert.ok(Math.abs(nine.exactPercent - 34.9676) < 1e-3);
  assert.ok(Math.abs(fifteen.exactPercent - 54.1166) < 1e-3);

  // Sign: at 4 outs the shortcut understates slightly, and from about 7 outs upward
  // it overstates. Magnitudes to the tenth of a point.
  assert.ok(four.errorPoints < 0, 'at 4 outs x4 is a little low');
  assert.ok(Math.abs(four.errorPoints + 0.4662) < 1e-3);
  assert.ok(nine.errorPoints > 0, 'at 9 outs x4 is a little high');
  assert.ok(Math.abs(nine.errorPoints - 1.0324) < 1e-3);
  assert.ok(fifteen.errorPoints > 0, 'at 15 outs x4 is badly high');
  assert.ok(Math.abs(fifteen.errorPoints - 5.8834) < 1e-3);

  // The error has a closed form, which is worth deriving because it says exactly
  // where the shortcut goes wrong and why. With u unseen cards fixed at 47:
  //   exact%  = 100 * (1 - (47-o)(46-o)/2162) = 100 * (93o - o^2) / 2162
  //   error   = 4o - 100 * (93o - o^2) / 2162
  //           = o * (4 * 2162 - 9300 + 100o) / 2162
  //           = o * (100o - 652) / 2162
  // That is an upward parabola through the origin: negative for o < 6.52, positive
  // above it, with its minimum at o = 3.26 and growing without limit after that. So
  // the error is NOT monotone across the whole range — it dips slightly more negative
  // up to three outs before turning — and the honest claim is that it rises from four
  // outs upward. That is the range every real draw lives in, and it is exactly where
  // the shortcut is trusted most.
  const predicted = (outs: number): number => (outs * (100 * outs - 652)) / 2162;
  for (let outs = 1; outs <= 20; outs += 1) {
    assert.ok(
      Math.abs(at(outs).errorPoints - predicted(outs)) < 1e-9,
      `error at ${outs} outs: ${at(outs).errorPoints} vs the algebra's ${predicted(outs)}`,
    );
  }
  let previous = at(4).errorPoints;
  for (let outs = 5; outs <= 20; outs += 1) {
    const current = at(outs).errorPoints;
    assert.ok(current > previous, `error at ${outs} outs (${current}) should exceed ${previous}`);
    previous = current;
  }
  assert.ok(four.errorPoints < nine.errorPoints);
  assert.ok(nine.errorPoints < fifteen.errorPoints);

  // The sign flips where the algebra says it does, between 6 and 7 outs (100o = 652).
  assert.ok(at(6).errorPoints < 0, 'six outs: x4 still understates');
  assert.ok(at(7).errorPoints > 0, 'seven outs: x4 has started to overstate');
  assert.ok(at(3).errorPoints < at(2).errorPoints, 'the dip before the turn, as the parabola predicts');

  // The verdict has to name the direction and the size, and it must escalate.
  assert.match(four.verdict, /within half a point/);
  assert.match(nine.verdict, /overstates by 1\.0 points/);
  assert.match(fifteen.verdict, /overstates by 5\.9 points/);
  assert.match(fifteen.verdict, /flip a marginal call/);
});

test('the x2 form understates, always in the same direction', () => {
  // One card to come off a 46-card stub: each out is 1/46 = 2.174%, not 2%. So the
  // shortcut is low by 0.174 points per out — 9 outs is 19.5652%, not 18%.
  const nine = ruleOf24Accuracy(9, 1, probabilityOfHitting(9, 46, 1).probability);
  assert.ok(Math.abs(nine.exactPercent - 19.5652) < 1e-3);
  assert.ok(Math.abs(nine.errorPoints + 1.5652) < 1e-3);
  assert.match(nine.verdict, /understates/);

  for (const outs of [2, 4, 8, 12, 15]) {
    const accuracy = ruleOf24Accuracy(outs, 1, probabilityOfHitting(outs, 46, 1).probability);
    assert.ok(accuracy.errorPoints < 0, `x2 should understate at ${outs} outs`);
    // 2 points per out against 2.1739 points per out.
    assert.ok(Math.abs(accuracy.errorPoints + outs * (100 / 46 - 2)) < 1e-9);
  }
});

// ---------------------------------------------------------------------------
// Implied and reverse implied odds
// ---------------------------------------------------------------------------

test('implied odds lower the required equity by the money still to come', () => {
  // 100 in the middle, 50 to call, and hitting is worth another 150 later. The call
  // is playing for 100 + 50 + 150 = 300, so it needs 50/300 = 1/6 = 16.7% instead of
  // the 50/150 = 33.3% the pot alone demands.
  const implied = impliedOdds({ pot: 100, toCall: 50, expectedAdditionalWinnings: 150 });
  assert.equal(implied.effectiveBreakEvenEquity, 1 / 6);
  assert.ok(implied.effectiveBreakEvenEquity < potOdds(100, 50).breakEvenEquity);

  // With nothing extra expected it must collapse back onto the pot price exactly.
  assert.equal(
    impliedOdds({ pot: 100, toCall: 50, expectedAdditionalWinnings: 0 }).effectiveBreakEvenEquity,
    potOdds(100, 50).breakEvenEquity,
  );

  // Closed-form identity: counting W of future money is the same arithmetic as
  // playing for a pot that is already W bigger. Exact with integer chip amounts.
  for (const extra of [0, 1, 25, 150, 1000]) {
    assert.equal(
      impliedOdds({ pot: 100, toCall: 50, expectedAdditionalWinnings: extra }).effectiveBreakEvenEquity,
      potOdds(100 + extra, 50).breakEvenEquity,
      `implied odds with ${extra} extra is the pot price with a pot of ${100 + extra}`,
    );
  }

  // Monotone: more expected winnings can only ever make the call cheaper.
  let previous = Number.POSITIVE_INFINITY;
  for (const extra of [0, 10, 50, 200, 800]) {
    const current = impliedOdds({
      pot: 100,
      toCall: 50,
      expectedAdditionalWinnings: extra,
    }).effectiveBreakEvenEquity;
    assert.ok(current < previous);
    previous = current;
  }

  // The forecast has to be flagged as a forecast, every time.
  assert.ok(implied.assumptions.length > 0);
  assert.ok(
    implied.assumptions.some((note) => /estimate about future streets, not a fact/.test(note)),
    'the extra money must be labelled an estimate about future streets',
  );
});

test('reverse implied odds raise the required equity by the money still to be lost', () => {
  // 100 in the middle, 50 to call, and the hand tends to cost another 100 later. The
  // call is really 150 to win 100 + 50 + 100 = 250, so it needs 150/250 = 60%, far
  // worse than the 33.3% the pot advertises.
  const reverse = reverseImpliedOdds({ pot: 100, toCall: 50, expectedAdditionalLosses: 100 });
  assert.equal(reverse.effectiveBreakEvenEquity, 0.6);
  assert.ok(reverse.effectiveBreakEvenEquity > potOdds(100, 50).breakEvenEquity);

  assert.equal(
    reverseImpliedOdds({ pot: 100, toCall: 50, expectedAdditionalLosses: 0 }).effectiveBreakEvenEquity,
    potOdds(100, 50).breakEvenEquity,
    'with nothing extra expected it is just the pot price',
  );

  // Closed-form identity: money that is going in later costs the same as money going
  // in now, so the effective price equals the pot price on a larger call.
  for (const loss of [0, 5, 100, 400]) {
    assert.equal(
      reverseImpliedOdds({ pot: 100, toCall: 50, expectedAdditionalLosses: loss }).effectiveBreakEvenEquity,
      potOdds(100, 50 + loss).breakEvenEquity,
      `reverse implied odds with ${loss} extra is the pot price on a call of ${50 + loss}`,
    );
  }

  // Monotone the other way, and never below the pot price.
  let previous = Number.NEGATIVE_INFINITY;
  for (const loss of [0, 10, 60, 300, 900]) {
    const current = reverseImpliedOdds({
      pot: 100,
      toCall: 50,
      expectedAdditionalLosses: loss,
    }).effectiveBreakEvenEquity;
    assert.ok(current > previous);
    assert.ok(current >= potOdds(100, 50).breakEvenEquity);
    previous = current;
  }

  assert.ok(reverse.assumptions.length > 0);
  assert.ok(
    reverse.assumptions.some((note) => /estimate about future streets, not a fact/.test(note)),
    'the extra cost must be labelled an estimate about future streets',
  );
});

test('implied and reverse implied odds bracket the pot price', () => {
  // The same spot seen three ways. The pot price sits between the two adjustments,
  // which is the shape a learner should end up with: the pot price is the only one of
  // the three that is a fact.
  const base = potOdds(60, 20).breakEvenEquity;
  const optimistic = impliedOdds({
    pot: 60,
    toCall: 20,
    expectedAdditionalWinnings: 120,
  }).effectiveBreakEvenEquity;
  const pessimistic = reverseImpliedOdds({
    pot: 60,
    toCall: 20,
    expectedAdditionalLosses: 120,
  }).effectiveBreakEvenEquity;
  assert.ok(optimistic < base);
  assert.ok(base < pessimistic);
  // 20/200 = 10%, 20/80 = 25%, 140/200 = 70%.
  assert.equal(optimistic, 0.1);
  assert.equal(base, 0.25);
  assert.equal(pessimistic, 0.7);
});

// ---------------------------------------------------------------------------
// Validation and the no-bare-numbers rule
// ---------------------------------------------------------------------------

test('bad chip amounts throw OddsError naming what was expected', () => {
  assert.throws(() => potOdds(-1, 50), { name: 'OddsError', message: /pot cannot be negative/ });
  assert.throws(() => potOdds(100, -5), { name: 'OddsError', message: /toCall cannot be negative/ });
  assert.throws(() => potOdds(Number.NaN, 50), { name: 'OddsError', message: /finite/ });
  assert.throws(() => potOdds(100, Number.POSITIVE_INFINITY), { name: 'OddsError', message: /finite/ });
  assert.throws(() => defenceFrequency(-1, 50), { name: 'OddsError', message: /pot cannot be negative/ });
  assert.throws(() => defenceFrequency(100, 0), {
    name: 'OddsError',
    message: /betSize must be greater than 0.*check/s,
  });
  assert.throws(() => priceLaidByBet(100, 0), {
    name: 'OddsError',
    message: /betSize must be greater than 0/,
  });
  assert.throws(() => priceLaidByBet(100, -20), { name: 'OddsError', message: /cannot be negative/ });
  assert.throws(() => impliedOdds({ pot: 100, toCall: 50, expectedAdditionalWinnings: -1 }), {
    name: 'OddsError',
    message: /expectedAdditionalWinnings cannot be negative/,
  });
  assert.throws(() => reverseImpliedOdds({ pot: 100, toCall: 50, expectedAdditionalLosses: Number.NaN }), {
    name: 'OddsError',
    message: /expectedAdditionalLosses must be a finite/,
  });
  // The error type is the named class, so callers can catch this and nothing else.
  assert.throws(() => potOdds(-1, 0), OddsError);
});

test('bad card counts throw OddsError naming what was expected', () => {
  assert.throws(() => probabilityOfHitting(48, 47, 2), {
    name: 'OddsError',
    message: /outs cannot exceed unseen/,
  });
  assert.throws(() => probabilityOfHitting(9.5, 47, 2), {
    name: 'OddsError',
    message: /whole number of cards/,
  });
  assert.throws(() => probabilityOfHitting(9, 47.5, 2), {
    name: 'OddsError',
    message: /whole number of cards/,
  });
  assert.throws(() => probabilityOfHitting(-1, 47, 1), { name: 'OddsError', message: /cannot be negative/ });
  assert.throws(() => probabilityOfHitting(1, 53, 1), { name: 'OddsError', message: /52 cards in a deck/ });
  assert.throws(() => probabilityOfHitting(1, 1, 2), {
    name: 'OddsError',
    message: /unseen must be at least cardsToCome/,
  });
  assert.throws(() => probabilityOfHitting(0, 0, 1), {
    name: 'OddsError',
    message: /unseen must be at least cardsToCome/,
  });
  assert.throws(() => ruleOf24(2.5, 2), { name: 'OddsError', message: /whole number of cards/ });
  // 47 unseen cards is the most there can be while cards are still to come.
  assert.throws(() => ruleOf24(48, 2), { name: 'OddsError', message: /outs cannot exceed 47/ });
  assert.throws(() => ruleOf24Accuracy(9, 2, 35), {
    name: 'OddsError',
    message: /fraction,[\s\S]*not a percentage/,
  });
  assert.throws(() => ruleOf24Accuracy(9, 2, -0.01), { name: 'OddsError', message: /between 0 and 1/ });
  assert.throws(() => ruleOf24Accuracy(9, 2, Number.NaN), { name: 'OddsError', message: /finite/ });
});

test('the shortcut refuses an out count whose multiple is not a probability', () => {
  // The defect this guard exists for was measured, not imagined: a Coach panel published
  // "180%" for a flopped set (45 cards classified as outs, times 4) and a shipped scenario
  // in `@prl/content` reached "188%" at 47. A probability above 100% is not a rounding
  // problem to be tolerated at one decimal place; it is the shortcut being applied where
  // it approximates nothing, and the honest answer is to refuse rather than to clamp — a
  // clamped 100% would be a fabricated certainty.
  //
  // The ceiling is where `outs x multiplier` reaches exactly 100: 25 outs with two cards
  // to come, 50 with one (unreachable, since at most 46 cards are unseen with one to come,
  // which is why only the x4 form can actually cross it).
  assert.equal(maximumOutsForRuleOf24(2), 25);
  assert.equal(maximumOutsForRuleOf24(1), 50);

  // Exactly at the ceiling is still a probability and is still answered.
  assert.equal(ruleOf24(25, 2).estimatePercent, 100);
  assert.equal(ruleOf24(46, 1).estimatePercent, 92);

  for (const outs of [26, 45, 47]) {
    assert.throws(() => ruleOf24(outs, 2), {
      name: 'OddsError',
      message: /is not a probability/,
    });
  }
  // And the message names the figure that would have been published, so the failure reads
  // like the bug rather than like a validation rule.
  assert.throws(() => ruleOf24(47, 2), { name: 'OddsError', message: /47 x 4 is 188%/ });
  // `ruleOf24Accuracy` validates the shortcut's own inputs first, so it refuses too rather
  // than reporting a mismatch against an exact figure.
  assert.throws(() => ruleOf24Accuracy(47, 2, 0.99), {
    name: 'OddsError',
    message: /is not a probability/,
  });
});

test('cardsToCome outside 1 or 2 throws, even though the type forbids it', () => {
  // The guard exists for values that arrive as JSON, where the type system was never
  // consulted. See `LooseCardsToCome` at the top of this file.
  assert.throws(() => loose.probabilityOfHitting(9, 47, 3), {
    name: 'OddsError',
    message: /cardsToCome must be 1 \(the river only\) or 2/,
  });
  assert.throws(() => loose.probabilityOfHitting(9, 47, 0), { name: 'OddsError', message: /cardsToCome/ });
  assert.throws(() => loose.probabilityOfHitting(9, 47, 1.5), { name: 'OddsError', message: /cardsToCome/ });
  assert.throws(() => loose.ruleOf24(9, 5), { name: 'OddsError', message: /cardsToCome/ });
  assert.throws(() => loose.ruleOf24(9, Number.NaN), { name: 'OddsError', message: /cardsToCome/ });
});

test('every figure in the family arrives with words attached', () => {
  // The house rule for this package: no bare numbers. A figure a learner cannot
  // interrogate is a figure they will misuse, so this is a structural check that the
  // explanation, derivation, caveat and assumption fields are actually populated.
  const texts: string[] = [
    potOdds(100, 50).explanation,
    potOdds(100, 0).explanation,
    priceLaidByBet(100, 66).explanation,
    defenceFrequency(100, 66).explanation,
    defenceFrequency(100, 66).caveat,
    ruleOf24(9, 2).explanation,
    ruleOf24(9, 2).caveat,
    ruleOf24(9, 1).explanation,
    ruleOf24(9, 1).caveat,
    ruleOf24Accuracy(9, 2, 0.349676).verdict,
    probabilityOfHitting(9, 47, 1).derivation,
    probabilityOfHitting(9, 47, 2).derivation,
    probabilityOfHitting(47, 47, 2).derivation,
    impliedOdds({ pot: 100, toCall: 50, expectedAdditionalWinnings: 150 }).explanation,
    reverseImpliedOdds({ pot: 100, toCall: 50, expectedAdditionalLosses: 100 }).explanation,
    ...impliedOdds({ pot: 100, toCall: 50, expectedAdditionalWinnings: 150 }).assumptions,
    ...reverseImpliedOdds({ pot: 100, toCall: 50, expectedAdditionalLosses: 100 }).assumptions,
  ];
  for (const text of texts) {
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 40, `too short to explain anything: "${text}"`);
    assert.equal(text.includes('NaN'), false, 'no NaN can reach a learner-facing string');
    assert.equal(text.includes('undefined'), false);
    // This line used to allow one exception — the free-call explanation, which said the
    // ratio "is reported as Infinity". That was a sentence naming an implementation
    // sentinel to a learner, and the sentinel it named is gone. No exception now: nothing
    // a learner reads mentions Infinity, null, or a price of 0 where there is no price.
    assert.equal(text.includes('Infinity'), false, 'no sentinel can reach a learner-facing string');
    assert.equal(text.includes('null'), false);
  }
});
