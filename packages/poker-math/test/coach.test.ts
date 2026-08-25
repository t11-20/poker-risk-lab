/**
 * The Coach is the product, and it was the one module with no test. This closes that.
 *
 * Two kinds of test live here, and the second kind was missing for a long time at real
 * cost — see below.
 *
 * **Promises the type system cannot express.** A figure never appears without its
 * assumptions; a sampled figure never appears without its interval; nothing is ever
 * labelled correct or optimal; a bet amount is always a whole number of chips; the same
 * input gives the same report. Each is a thing a well-meaning refactor could quietly
 * break while every other test in the package still passed.
 *
 * **Numbers, against ground truth derived outside this module.** The original suite
 * asserted only structural and relative properties, on the reasoning that equity, odds
 * and EV each have their own suites and the Coach merely composes them. That reasoning
 * had a hole in it: composing them *wrongly* is not covered by any of those suites, and
 * for a while the Coach priced every raise with the bet formula — charging hero the
 * raise but never the call — so every raise EV was overstated and its recommendation
 * was frequently wrong. Fifteen passing tests said nothing about it. The tests named
 * "against figures computed by hand" below close that hole: they fix a spot whose equity
 * is a countable fraction, work the closed forms out longhand in the comment, and assert
 * the literals. Nothing in them is computed by the code under test.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport, CoachError, type CoachInput, summariseCoachReport } from '../src/coach.ts';
import { exactRange, parseRange } from '../src/ranges.ts';

/** A flop spot: nut flush draw facing a half-pot bet from a set. */
function flushDrawVsSet(overrides: Partial<CoachInput> = {}): CoachInput {
  return {
    heroCards: parseCards('Ah Kh'),
    board: parseCards('Qh 7h 2c'),
    street: 'flop',
    opponents: [{ label: 'the big blind', range: exactRange(parseCards('Qs Qd')) }],
    pot: 100,
    toCall: 50,
    heroCommittedThisStreet: 0,
    heroStack: 400,
    opponentStacks: [400],
    bigBlind: 10,
    ...overrides,
    // Stated after the spread, and derived from whatever `pot` ended up being: these spots all
    // have hero covering the bet from a deep stack, so the pot hero can win is the whole middle.
    // A test that means to describe a hero all-in for less overrides it and says so.
    contestablePot: overrides.contestablePot ?? overrides.pot ?? 100,
  };
}

test('a report never presents a figure without its assumptions', () => {
  // PRODUCT-GUARDRAILS §3: a number without its assumptions is a guess dressed as a fact.
  // The Coach is documented as throwing rather than returning an empty list, so this
  // asserts the property across a range of spots rather than trusting one path.
  const spots: CoachInput[] = [
    flushDrawVsSet(),
    flushDrawVsSet({ toCall: 0 }),
    flushDrawVsSet({ toCall: 400, heroStack: 400 }),
    flushDrawVsSet({
      opponents: [{ label: 'a tight range', range: parseRange('QQ+, AKs', parseCards('Ah Kh Qh 7h 2c')) }],
    }),
    {
      heroCards: parseCards('Ah Ad'),
      board: [],
      street: 'preflop',
      opponents: [{ label: 'an opener', range: parseRange('77+, ATs+', parseCards('Ah Ad')) }],
      pot: 30,
      contestablePot: 30,
      toCall: 20,
      heroCommittedThisStreet: 0,
      heroStack: 500,
      opponentStacks: [500],
      bigBlind: 10,
    },
    {
      heroCards: parseCards('7c 7d'),
      board: parseCards('Ks 9h 4c 2d 8s'),
      street: 'river',
      opponents: [{ label: 'the button', range: exactRange(parseCards('Kh Qd')) }],
      pot: 220,
      contestablePot: 220,
      toCall: 80,
      heroCommittedThisStreet: 0,
      heroStack: 300,
      opponentStacks: [300],
      bigBlind: 10,
    },
  ];

  for (const spot of spots) {
    const report = buildCoachReport(spot);
    assert.ok(report.assumptions.length > 0, `${spot.street}: assumptions must never be empty`);
    for (const assumption of report.assumptions) {
      assert.ok(assumption.trim().length > 10, 'an assumption must be a real sentence');
    }
    assert.ok(report.uncertainty.limitations.length > 0, 'limitations must never be empty');
    assert.ok(report.uncertainty.summary.length > 0);
  }
});

test('a sampled figure always carries its interval; an exact one reports null rather than zero', () => {
  // "No sampling error" and "zero error" are different claims, and conflating them is how a
  // sampled number starts being read as exact.
  const exact = buildCoachReport(flushDrawVsSet());
  assert.equal(exact.equity.method, 'exact-enumeration');
  assert.equal(
    exact.equity.confidenceHalfWidthPoints,
    null,
    'exact enumeration must report null, never a fabricated 0',
  );
  assert.equal(exact.uncertainty.confidenceInterval, null);
  assert.match(exact.uncertainty.summary, /no sampling error/i);

  // A wide range against a preflop board forces the Monte Carlo path.
  const sampled = buildCoachReport({
    heroCards: parseCards('Ah Kh'),
    board: [],
    street: 'preflop',
    opponents: [
      { label: 'a wide range', range: parseRange('22+, A2s+, KTs+, QJs, A9o+, KQo', parseCards('Ah Kh')) },
    ],
    pot: 30,
    contestablePot: 30,
    toCall: 20,
    heroCommittedThisStreet: 0,
    heroStack: 500,
    opponentStacks: [500],
    bigBlind: 10,
    samples: 8_000,
    seed: 7,
  });
  assert.equal(sampled.equity.method, 'monte-carlo');
  assert.ok(
    (sampled.equity.confidenceHalfWidthPoints ?? 0) > 0,
    'a sampled figure must carry a positive interval',
  );
  assert.notEqual(sampled.uncertainty.confidenceInterval, null);
  assert.equal(sampled.uncertainty.confidenceInterval?.level, 0.95);
  assert.match(sampled.uncertainty.summary, /±/);
});

test('nothing in a report is ever labelled correct or optimal', () => {
  // The type has no field for it, so this checks the STRINGS — which is where the claim
  // would actually leak back in.
  const banned = /\b(?:correct|optimal|solved|guaranteed|always right|the right play|GTO)\b/i;
  const spots = [flushDrawVsSet(), flushDrawVsSet({ toCall: 0 }), flushDrawVsSet({ toCall: 400 })];

  for (const spot of spots) {
    const report = buildCoachReport(spot);
    const strings: string[] = [
      report.suggestion.reason,
      ...report.suggestion.whatWouldChangeIt,
      ...report.assumptions,
      ...report.teachingNotes,
      ...report.uncertainty.limitations,
      report.uncertainty.summary,
      report.potOdds.explanation,
      report.stackContext.explanation,
      ...report.candidates.map((candidate) => candidate.derivation),
    ];
    for (const text of strings) {
      assert.ok(!banned.test(text), `report text claims certainty: ${JSON.stringify(text.slice(0, 120))}`);
    }
  }
});

test('the suggestion always says what would change it, and may be low confidence', () => {
  const report = buildCoachReport(flushDrawVsSet());
  assert.ok(report.suggestion.whatWouldChangeIt.length > 0, 'never empty');
  assert.ok(['low', 'moderate', 'reasonable'].includes(report.suggestion.confidence));
  // A size range, not a single number, whenever a size applies at all.
  if (report.suggestion.sizeRange !== undefined) {
    assert.ok(report.suggestion.sizeRange.min <= report.suggestion.sizeRange.max);
  }
});

test('every candidate bet amount is a whole number of chips', () => {
  // The engine rejects a fractional bet, so a Coach that suggests 83.33 is suggesting an
  // action the player cannot take. This caught a real defect: the sizing ladder was
  // returning exact pot fractions.
  for (const pot of [7, 13, 100, 101, 250, 999]) {
    for (const toCall of [0, 5, 50]) {
      const report = buildCoachReport(flushDrawVsSet({ pot, toCall, heroStack: 1_000 }));
      for (const candidate of report.candidates) {
        if (candidate.to !== undefined) {
          assert.ok(
            Number.isInteger(candidate.to),
            `pot ${pot} toCall ${toCall}: ${candidate.action} to ${candidate.to} is not an integer`,
          );
        }
        assert.ok(Number.isInteger(candidate.cost), `${candidate.action} cost must be an integer`);
        assert.ok(candidate.cost >= 0);
      }
    }
  }
});

test('folding is the zero point, and no candidate costs more than the stack', () => {
  const report = buildCoachReport(flushDrawVsSet({ heroStack: 120 }));
  const fold = report.candidates.find((candidate) => candidate.action === 'fold');
  assert.equal(fold?.ev, 0, 'folding defines zero — money already in the pot is sunk');
  for (const candidate of report.candidates) {
    assert.ok(candidate.cost <= 120, `${candidate.action} costs ${candidate.cost} of a 120 stack`);
  }
});

test('checking is offered when nothing is owed, and calling is not', () => {
  const report = buildCoachReport(flushDrawVsSet({ toCall: 0 }));
  const actions = report.candidates.map((candidate) => candidate.action);
  assert.ok(actions.includes('check'));
  assert.ok(!actions.includes('call'), 'there is nothing to call');
  assert.equal(report.potOdds.breakEvenEquity, 0);
  assert.match(report.potOdds.explanation, /free|nothing to call/i);
});

test('outs are reported with cards to come and omitted on the river', () => {
  const flop = buildCoachReport(flushDrawVsSet());
  assert.notEqual(flop.outs, null);
  assert.equal(flop.outs?.total, (flop.outs?.clean ?? 0) + (flop.outs?.dirty ?? 0));
  assert.equal(flop.outs?.cleanCards.length, flop.outs?.clean);
  assert.equal(flop.outs?.dirtyCards.length, flop.outs?.dirty);

  const river = buildCoachReport({
    heroCards: parseCards('Ah Kh'),
    board: parseCards('Qh 7h 2c 3d 9s'),
    street: 'river',
    opponents: [{ label: 'villain', range: exactRange(parseCards('Qs Qd')) }],
    pot: 100,
    contestablePot: 100,
    toCall: 50,
    heroCommittedThisStreet: 0,
    heroStack: 400,
    opponentStacks: [400],
    bigBlind: 10,
  });
  assert.equal(river.outs, null, 'there are no outs with no cards to come');
});

test('the same input produces the same report', () => {
  // A teaching scenario must show every learner identical numbers.
  const first = buildCoachReport(flushDrawVsSet());
  const second = buildCoachReport(flushDrawVsSet());
  assert.equal(first.equity.heroEquity, second.equity.heroEquity);
  assert.equal(first.potOdds.breakEvenEquity, second.potOdds.breakEvenEquity);
  assert.deepEqual(
    first.candidates.map((candidate) => [candidate.action, candidate.to, candidate.ev]),
    second.candidates.map((candidate) => [candidate.action, candidate.to, candidate.ev]),
  );
  assert.equal(first.suggestion.action, second.suggestion.action);
});

test('the price drives the decision: the same draw flips from raise to fold as the bet grows', () => {
  // The single most important teaching property in the app. Same cards, same equity,
  // opposite decision — because the price changed and nothing else did.
  //
  // The expensive spot used to be `{ pot: 100, toCall: 400, heroStack: 400 }`, and that
  // made this test a lie by omission rather than a wrong expectation: with 400 behind and
  // 400 to call there is nothing left to raise WITH, so the candidate list was exactly
  // ["fold", "call"] and the test never exercised the raise path its own name claims to
  // cover. A deeper stack keeps the raise on offer, which is the only way "flips from
  // raise to fold" can be tested at all — so the spot now leaves 1,000 behind, and the
  // assertion below checks the raise really is available before checking it is rejected.
  const cheap = buildCoachReport(flushDrawVsSet({ pot: 100, toCall: 20 }));
  const expensive = buildCoachReport(flushDrawVsSet({ pot: 100, toCall: 400, heroStack: 1_000 }));

  assert.equal(
    cheap.equity.heroEquity,
    expensive.equity.heroEquity,
    'equity depends on the cards, not the price',
  );
  assert.ok(
    expensive.potOdds.breakEvenEquity > cheap.potOdds.breakEvenEquity,
    'a bigger bet demands more equity',
  );
  assert.ok(cheap.potOdds.equitySurplus > expensive.potOdds.equitySurplus);
  assert.ok(
    expensive.candidates.some((candidate) => candidate.action === 'raise'),
    'the expensive spot must still offer a raise, or the flip below proves nothing',
  );
  assert.equal(expensive.suggestion.action, 'fold', 'at 4x pot this draw cannot continue');
  assert.equal(cheap.suggestion.action, 'raise', 'at a fifth of the pot the draw can raise');
});

test('a wider opponent range raises hero equity, all else equal', () => {
  const blockers = parseCards('Ah Kh Qh 7h 2c');
  const narrow = buildCoachReport(
    flushDrawVsSet({ opponents: [{ label: 'narrow', range: parseRange('QQ+', blockers) }] }),
  );
  const wide = buildCoachReport(
    flushDrawVsSet({
      opponents: [{ label: 'wide', range: parseRange('22+, A2s+, K9o+, QJo, JTo', blockers) }],
      samples: 12_000,
      seed: 3,
    }),
  );
  assert.ok(
    wide.equity.heroEquity > narrow.equity.heroEquity,
    `wide ${wide.equity.heroEquity} should beat narrow ${narrow.equity.heroEquity}`,
  );
});

test('stack context reports the effective stack and an SPR consistent with it', () => {
  const report = buildCoachReport(flushDrawVsSet({ heroStack: 400, opponentStacks: [150], pot: 100 }));
  assert.equal(report.stackContext.effectiveStack, 150, 'capped by the shorter stack');
  assert.ok(Math.abs(report.stackContext.spr - 1.5) < 1e-9);
  // A pot-sized bet lays the caller exactly 1/3 — the anchor identity from odds.ts.
  assert.ok(Math.abs(report.stackContext.potOddsOfferedByPotSizedBet - 1 / 3) < 1e-9);
});

/**
 * A genuine nine-out flush draw: hero Th 9h on Kh 7h 2c against exactly Ks Qd.
 *
 * Chosen because every figure it produces is countable on paper. Hero has 39.49% equity,
 * so hero is behind and really is drawing; the nine remaining hearts are all clean (the
 * opponent's top pair cannot outdraw a flush without the board pairing twice) and there
 * is not one dirty out to argue about.
 */
function nineOutFlushDraw(overrides: Partial<CoachInput> = {}): CoachInput {
  return {
    heroCards: parseCards('Th 9h'),
    board: parseCards('Kh 7h 2c'),
    street: 'flop',
    opponents: [{ label: 'top pair', range: exactRange(parseCards('Ks Qd')) }],
    pot: 100,
    toCall: 50,
    heroCommittedThisStreet: 0,
    heroStack: 400,
    opponentStacks: [400],
    bigBlind: 10,
    ...overrides,
    // Stated after the spread, and derived from whatever `pot` ended up being: these spots all
    // have hero covering the bet from a deep stack, so the pot hero can win is the whole middle.
    // A test that means to describe a hero all-in for less overrides it and says so.
    contestablePot: overrides.contestablePot ?? overrides.pot ?? 100,
  };
}

test('the rule of 2/4 is published as a fraction, from clean outs, with its real error', () => {
  // This test replaces one that asserted three things that were all wrong, and each was
  // wrong in a way that shipped:
  //
  //   1. `assert.equal(thumb.estimate, report.outs.total * 4)` — TOTAL outs, clean plus
  //      dirty, on a shortcut whose own printed explanation says "count clean outs
  //      only". The Coach contradicted the sentence directly beneath it.
  //   2. It compared the shortcut against `report.equity.heroEquity`, so `errorPoints`
  //      was the shortcut's error PLUS the gap between hitting and winning, reported as
  //      though the shortcut were responsible for all of it.
  //   3. It asserted the estimate against the code's own output (`outs.total * 4`)
  //      rather than a literal, so it could not have caught the unit: `estimate` was in
  //      percentage points, `@prl/ui` rendered it with `formatPercent`, and the panel
  //      said "3,600.0%".
  //
  // Everything below is a literal derived by hand from the cards, and none of it is
  // computed by the code under test.
  const report = buildCoachReport(nineOutFlushDraw());
  const outs = report.outs;
  assert.ok(outs !== null, 'a flop spot against one opponent has an outs breakdown');
  assert.equal(outs.clean, 9, 'the nine unseen hearts');
  assert.equal(outs.dirty, 0, 'and nothing dirty to blur the arithmetic');

  const thumb = report.equity.ruleOfThumb;
  assert.ok(thumb !== null, 'a real draw with clean outs should show the shortcut');

  // 9 clean outs x 4 = 36 percentage points = 0.36 as the fraction this contract carries.
  assert.equal(thumb.estimate, 0.36, 'published as a FRACTION, so @prl/ui renders 36.0% and not 3,600.0%');
  assert.ok(thumb.estimate <= 1, 'a probability is never above 1');

  // The exact chance of one of those nine arriving, by complementary counting, with the
  // turn and the river to come.
  //
  // The denominator is 45, not 47. The opponent is `exactRange(Ks Qd)` — a KNOWN hand —
  // so the king of spades and the queen of diamonds are face down in front of them and
  // cannot come off the deck. `computeOuts` already works this way: its own sentence for
  // this spot reads "Of the 45 cards that can come next, 9 are clean". Nine hearts among
  // 45 leaves 36 misses:
  //     1 - (36/45) x (35/44) = 1 - 1260/1980 = 1 - 7/11 = 4/11 = 0.363636363636...
  // so the shortcut UNDERSTATES by 36 - 36.3636363636 = -0.3636363636 points.
  //
  // This assertion used to read 47, 38, 37 and "+1.0324, the x4 form overstates". Those
  // literals were correct arithmetic for a denominator this spot does not have, and they
  // passed only because `buildRuleOfThumb` was re-deriving 47 from the street instead of
  // using the card set the outs were counted from. Fed `nineOutFlushDraw()` the old code
  // returned errorPoints +1.0324 and a note quoting "47 cards unseen" beside an outs
  // paragraph quoting 45; it now returns -0.3636 and quotes 45 in both places.
  const exactHitPercent = (1 - (36 / 45) * (35 / 44)) * 100;
  assert.ok(Math.abs(exactHitPercent - (4 / 11) * 100) < 1e-12, 'the hand-derived exact figure, 4/11');
  assert.ok(Math.abs(exactHitPercent - 36.363636363636) < 1e-9, 'stated as a decimal too');
  assert.ok(
    Math.abs(thumb.errorPoints - (36 - exactHitPercent)) < 1e-9,
    `errorPoints should be -0.3636 against the exact chance of HITTING out of 45, got ${thumb.errorPoints}`,
  );
  assert.ok(
    thumb.errorPoints < 0,
    'x4 understates here: nine outs among 45 is worth more per out than nine among 47',
  );
  assert.ok(thumb.note.length > 0);
  // The note carries the derivation, and the derivation names the denominator. If it
  // ever says 47 again the report is contradicting its own outs paragraph.
  assert.match(thumb.note, /45 cards unseen/, 'the derivation must quote the same 45 the outs came from');
  assert.doesNotMatch(thumb.note, /47 cards unseen/);
});

/**
 * The denominator the shortcut is measured against is the one the outs were counted
 * from — the defect this pins, and the sign of the error is what it got wrong.
 *
 * `buildRuleOfThumb` used to compute the unseen count as `52 - 2 - (5 - cardsToCome)`,
 * which is 47 on the flop whatever the spot is, while `computeOuts` had counted the
 * outs out of `cardsConsidered`. Those two agree for a notation range and disagree by
 * two cards for a known opponent hand, so one report carried both numbers for one
 * event: "Of the 45 cards that can come next, 8 are clean" three paragraphs above "Two
 * cards to come, 8 outs, 47 cards unseen … = 31.5%".
 *
 * `errorPoints` is documented as "the shortcut's error and nothing else". It was
 * carrying a denominator mismatch larger than the error it reported, and — the part
 * that reaches a learner — pointing the wrong way.
 *
 * The two spots below are the same hero hand, the same board and the same 8 clean outs,
 * differing only in whether the opponent is a known hand or a range. That is the whole
 * variable, and the true error points in opposite directions across it, which is why
 * both are here and why both assert a SIGN and not just a magnitude. Every literal is
 * worked out longhand in the comments and nothing is taken from the code under test.
 */
function eightOutStraightDraw(overrides: Partial<CoachInput> = {}): CoachInput {
  return {
    heroCards: parseCards('9s 8s'),
    board: parseCards('7s 6d 2c'),
    street: 'flop',
    opponents: [{ label: 'aces', range: exactRange(parseCards('Ah Ad')) }],
    pot: 100,
    toCall: 50,
    heroCommittedThisStreet: 0,
    heroStack: 400,
    opponentStacks: [400],
    bigBlind: 10,
    ...overrides,
    // Stated after the spread, and derived from whatever `pot` ended up being: these spots all
    // have hero covering the bet from a deep stack, so the pot hero can win is the whole middle.
    // A test that means to describe a hero all-in for less overrides it and says so.
    contestablePot: overrides.contestablePot ?? overrides.pot ?? 100,
  };
}

test('errorPoints is measured against the cards the outs were counted from, sign included', () => {
  // ---- Case 1: a KNOWN opponent hand, so 45 cards can come, not 47. ----
  //
  // Hero 9s8s on 7s6d2c against exactly AhAd: an open-ended straight draw, and
  // `computeOuts` reports cleanCount 8, cardsConsidered 45, equityNow 36.87%, no
  // refusal. The two aces are behind the opponent and cannot arrive.
  //
  // 8 outs among 45, two cards to come, 37 misses:
  //     1 - (37/45) x (36/44) = 1 - 1332/1980 = 1 - 37/55 = 18/55 = 0.327272727272...
  // The shortcut says 8 x 4 = 32%, so it UNDERSTATES by 32 - 32.727272727 = -0.727272727.
  //
  // Fed exactly this input, the old code published estimate 0.32, errorPoints +0.5476
  // and a note reading "overstating … by 0.5 points" — it had divided by 47. The
  // published 31.45% was 1.28 points below the truth and the direction was inverted.
  // It now returns errorPoints -0.7273 and says "understates".
  const known = buildCoachReport(eightOutStraightDraw());
  const knownOuts = known.outs;
  assert.ok(knownOuts !== null);
  assert.equal(knownOuts.clean, 8, 'the four fives and the four tens');
  assert.equal(knownOuts.dirty, 0);
  assert.match(
    knownOuts.explanation,
    /Of the 45 cards that can come next/,
    'the outs paragraph is the one that names the real card set',
  );

  const knownThumb = known.equity.ruleOfThumb;
  assert.ok(knownThumb !== null);
  assert.equal(knownThumb.estimate, 0.32, '8 x 4 = 32 points = 0.32 as a fraction');

  const exactOutOf45 = (1 - (37 / 45) * (36 / 44)) * 100;
  assert.ok(Math.abs(exactOutOf45 - (18 / 55) * 100) < 1e-12, 'the hand-derived exact figure, 18/55');
  assert.ok(Math.abs(exactOutOf45 - 32.727272727272) < 1e-9, 'stated as a decimal too');
  assert.ok(
    Math.abs(knownThumb.errorPoints - (32 - exactOutOf45)) < 1e-9,
    `errorPoints should be -0.7273, got ${knownThumb.errorPoints}`,
  );
  assert.ok(
    knownThumb.errorPoints < 0,
    'THE SIGN IS THE DEFECT: the old code published +0.5476 and the word "overstating" here',
  );
  assert.match(knownThumb.note, /understates/, 'and the prose has to agree with the sign');
  assert.doesNotMatch(knownThumb.note, /overstates/);
  assert.match(knownThumb.note, /45 cards unseen/, 'one denominator in the whole report, not two');
  assert.doesNotMatch(knownThumb.note, /47 cards unseen/);

  // ---- Case 2: an ordinary notation range, where 47 is correct and must stay. ----
  //
  // Same hero hand and board against "QQ+, AKs". The range holds more than one
  // combination, so no specific two cards are removed from the deck and `computeOuts`
  // reports cleanCount 8 out of cardsConsidered 47. The fix must not move this figure:
  // it is a regression guard against "correcting" the denominator into a different
  // wrong constant.
  //
  // 8 outs among 47, two cards to come, 39 misses:
  //     1 - (39/47) x (38/46) = 1 - 1482/2162 = 1 - 741/1081 = 0.3145235892691952...
  // The shortcut's 32% OVERSTATES by 32 - 31.45235892691952 = +0.54764107308048 —
  // the identical number the old code wrongly attached to case 1.
  const dead = parseCards('9s 8s 7s 6d 2c');
  const ranged = buildCoachReport(
    eightOutStraightDraw({ opponents: [{ label: 'a strong range', range: parseRange('QQ+, AKs', dead) }] }),
  );
  const rangedOuts = ranged.outs;
  assert.ok(rangedOuts !== null);
  assert.equal(rangedOuts.clean, 8, 'the same eight cards');
  assert.match(rangedOuts.explanation, /Of the 47 cards that can come next/);

  const rangedThumb = ranged.equity.ruleOfThumb;
  assert.ok(rangedThumb !== null);
  assert.equal(rangedThumb.estimate, 0.32);

  const exactOutOf47 = (1 - (39 / 47) * (38 / 46)) * 100;
  assert.ok(
    Math.abs(exactOutOf47 - (1 - 741 / 1081) * 100) < 1e-12,
    'the hand-derived exact figure, 741/1081',
  );
  assert.ok(Math.abs(exactOutOf47 - 31.45235892691952) < 1e-9, 'stated as a decimal too');
  assert.ok(
    Math.abs(rangedThumb.errorPoints - (32 - exactOutOf47)) < 1e-9,
    `errorPoints should be +0.5476, got ${rangedThumb.errorPoints}`,
  );
  assert.ok(rangedThumb.errorPoints > 0, 'and here the x4 form really does overstate');
  assert.match(rangedThumb.note, /47 cards unseen/);

  // The same 8 outs, the same 32% shortcut, and an error that changes SIGN with the card
  // set. That is the whole reason the denominator cannot be re-derived from the street.
  assert.ok(
    knownThumb.errorPoints < 0 && rangedThumb.errorPoints > 0,
    'the sign is a property of the spot, not of the street',
  );
});

test('the shortcut is withheld where it cannot mean anything, and says why', () => {
  // The rule of 2 and 4 is a shortcut for a draw with clean outs still to come. Each
  // spot below breaks one of those words, and each used to publish a number anyway —
  // including "180%", which is not a bad estimate of a probability but not a
  // probability at all.
  const cases: readonly [string, CoachInput, RegExp][] = [
    [
      // Hero flops a set against ace-high: 100% equity, 45 cards classified as "outs"
      // because almost anything keeps hero in front. 45 x 4 = 180.
      'a made hand that is already miles ahead',
      {
        heroCards: parseCards('7s 7d'),
        board: parseCards('7h 2c 9d'),
        street: 'flop',
        opponents: [{ label: 'ace high', range: exactRange(parseCards('As Kd')) }],
        pot: 100,
        contestablePot: 100,
        toCall: 50,
        heroCommittedThisStreet: 0,
        heroStack: 400,
        opponentStacks: [400],
        bigBlind: 10,
      },
      /already ahead/i,
    ],
    [
      // The nut flush draw against a set: eight outs, every one of them dirty, because
      // the board can still pair and fill the set up.
      'a draw whose every out is dirty',
      flushDrawVsSet(),
      /clean/i,
    ],
    [
      // A river spot: nothing left to come, so there is no draw to shortcut.
      'a complete board',
      {
        heroCards: parseCards('7c 7d'),
        board: parseCards('Ks 9h 4c 2d 8s'),
        street: 'river',
        opponents: [{ label: 'the button', range: exactRange(parseCards('Kh Qd')) }],
        pot: 220,
        contestablePot: 220,
        toCall: 80,
        heroCommittedThisStreet: 0,
        heroStack: 300,
        opponentStacks: [300],
        bigBlind: 10,
      },
      // No note is owed here: with no cards to come the panel shows no outs section
      // either, so there is nothing for a learner to wonder about.
      /(?:)/,
    ],
  ];

  for (const [label, input, reason] of cases) {
    const report = buildCoachReport(input);
    assert.equal(report.equity.ruleOfThumb, null, `${label}: the shortcut must be withheld`);
    if (reason.source !== '(?:)') {
      assert.ok(
        report.teachingNotes.some((note) => /rule[ -]of[ -]2[ -]and[ -]4/i.test(note) && reason.test(note)),
        `${label}: the notes must say why it was withheld, got ${JSON.stringify(report.teachingNotes)}`,
      );
    }
  }
});

test('invalid input is rejected with a message that says what was expected', () => {
  const cases: [Partial<CoachInput>, RegExp][] = [
    [{ heroCards: parseCards('Ah') }, /exactly 2 cards/],
    [{ board: parseCards('Qh 7h') }, /needs 3 board cards/],
    [{ opponents: [] }, /1 to 5 opponents/],
    [{ bigBlind: 0 }, /bigBlind must be positive/],
    [{ pot: -1 }, /non-negative integers/],
    [{ pot: 10.5 }, /non-negative integers/],
    [{ assumedFoldEquity: 1.4 }, /between 0 and 1/],
    [{ heroCards: parseCards('Qh 7h') }, /duplicate/],
    [{ heroCommittedThisStreet: -5 }, /non-negative integers/],
    [{ heroCommittedThisStreet: 2.5 }, /non-negative integers/],
    // A total, not an increment. The fixture faces 50 with nothing out, so the level is
    // 50 and any legal raise total is above it; 40 and 50 are both a different quantity
    // wearing this field's name, and accepting either would put every published size
    // back below the minimum.
    [{ minimumRaiseTo: 50 }, /above the current bet level of 50/],
    [{ minimumRaiseTo: 40 }, /above the current bet level of 50/],
    [{ minimumRaiseTo: 100.5 }, /whole number of chips/],
  ];
  for (const [override, pattern] of cases) {
    assert.throws(() => buildCoachReport(flushDrawVsSet(override)), pattern, JSON.stringify(override));
  }
  assert.throws(() => buildCoachReport(flushDrawVsSet({ heroCards: parseCards('Ah') })), CoachError);
});

test('the summary line always names the method and never claims certainty', () => {
  for (const spot of [flushDrawVsSet(), flushDrawVsSet({ toCall: 0 })]) {
    const summary = summariseCoachReport(buildCoachReport(spot));
    assert.match(summary, /exact|±/, 'the method or the interval must be present');
    assert.match(summary, /suggests/, 'framed as a suggestion');
    assert.ok(!/correct|optimal/i.test(summary));
  }
});

// ---------------------------------------------------------------------------
// Numbers, against ground truth derived by hand
// ---------------------------------------------------------------------------

/**
 * A turn spot whose equity is a fraction that can be counted on paper.
 *
 * Hero holds Ah Kh. The board is Qh 7h 2c 3d. The opponent holds exactly Qs Qd — a set
 * of queens — so nothing is assumed about a range and the equity is a pure count.
 *
 * 52 - 4 board - 2 hero - 2 opponent = **44 unseen cards**, each equally likely to be
 * the river.
 *
 * Hero cannot win a showdown as things stand (ace high against three queens) and cannot
 * make a straight or a better made hand, so hero wins if and only if the river completes
 * the flush *and* does not fill the opponent up:
 *
 *   * 13 hearts exist. Qh and 7h are on the board, Ah and Kh are in hero's hand, so 9
 *     hearts are unseen: 2h 3h 4h 5h 6h 8h 9h Th Jh.
 *   * 2h pairs the 2c and 3h pairs the 3d, either of which gives the opponent a full
 *     house — which beats a flush. Both are losers, not winners.
 *   * That leaves 4h 5h 6h 8h 9h Th Jh: **7 winners**.
 *
 * A tie is impossible (the opponent always holds at least three queens), so
 *
 *     e = 7 / 44 = 0.15909090909...
 *
 * Every figure asserted below is worked out from that fraction longhand in a comment and
 * written into the test as a literal. Nothing here calls the code it is checking.
 */
const COUNTED_EQUITY = 7 / 44;

function countedTurn(overrides: Partial<CoachInput> = {}): CoachInput {
  return {
    heroCards: parseCards('Ah Kh'),
    board: parseCards('Qh 7h 2c 3d'),
    street: 'turn',
    opponents: [{ label: 'the set', range: exactRange(parseCards('Qs Qd')) }],
    pot: 400,
    toCall: 300,
    heroCommittedThisStreet: 0,
    heroStack: 2_000,
    opponentStacks: [2_000],
    bigBlind: 10,
    // Stated rather than defaulted: every figure below depends on it, and a default that
    // moved would make this test fail for a reason that has nothing to do with it.
    assumedFoldEquity: 0.35,
    ...overrides,
    // Stated after the spread, and derived from whatever `pot` ended up being: these spots all
    // have hero covering the bet from a deep stack, so the pot hero can win is the whole middle.
    // A test that means to describe a hero all-in for less overrides it and says so.
    contestablePot: overrides.contestablePot ?? overrides.pot ?? 400,
  };
}

/** Chips, to a tenth of a chip. Nothing a learner reads is finer than this. */
function assertChips(actual: number, expected: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${what}: expected ${expected} chips, got ${actual} (difference ${actual - expected})`,
  );
}

test('facing a bet: every candidate EV matches a figure computed by hand', () => {
  const report = buildCoachReport(countedTurn());

  // Ground truth for the equity itself, before anything is derived from it. Exact
  // enumeration, so this is an identity and not an approximation.
  assert.equal(report.equity.method, 'exact-enumeration');
  assertChips(report.equity.heroEquity, COUNTED_EQUITY, 'hero equity should be exactly 7/44');

  const byAction = (action: string, to?: number) =>
    report.candidates.find(
      (candidate) => candidate.action === action && (to === undefined || candidate.to === to),
    );

  // EV(fold) = 0, by definition.
  assertChips(byAction('fold')?.ev ?? Number.NaN, 0, 'folding is the zero point');

  // EV(call) = e x (pot + toCall) - toCall
  //          = (7/44) x (400 + 300) - 300
  //          = 4900/44 - 300 = 111.3636364 - 300 = -188.6363636
  assertChips(byAction('call')?.ev ?? Number.NaN, -188.63636364, 'EV of calling 300 into 400');

  // The three raise sizes. Hero has nothing out on this street, so the level is the 300
  // being faced; the minimum legal total is 300 + max(300, bigBlind 10) = 600, so the
  // smallest offered raise is the smallest ladder rung at or above a 300 increment. The
  // ladder is priced against the 700 that would be in the middle once hero calls, giving
  // rungs of 175, 233, 350, 466, 525, 700, 1050 and the 1700 all-in; the rungs below 300
  // are not legal raises and are not offered. Smallest legal, middle, and the shove:
  //
  //   R = 350 -> to = 650, risk = 300 + 350 = 650, final pot = 400 + 300 + 700 = 1400
  //     EV = 0.35 x 400 + 0.65 x [ (7/44) x 1400 - 650 ]
  //        = 140 + 0.65 x [ 222.7272727 - 650 ]
  //        = 140 + 0.65 x (-427.2727273) = 140 - 277.7272727 = -137.7272727
  //
  //   R = 525 -> to = 825, risk = 825, final pot = 400 + 300 + 1050 = 1750
  //     EV = 140 + 0.65 x [ (7/44) x 1750 - 825 ]
  //        = 140 + 0.65 x [ 278.4090909 - 825 ] = 140 - 355.2840909 = -215.2840909
  //
  //   R = 1700 -> to = 2000 (the all-in), risk = 2000, final pot = 400 + 300 + 3400 = 4100
  //     EV = 140 + 0.65 x [ (7/44) x 4100 - 2000 ]
  //        = 140 + 0.65 x [ 652.2727273 - 2000 ] = 140 - 876.0227273 = -736.0227273
  const expectedRaises: readonly [number, number, number][] = [
    // [to, cost, ev]
    [650, 650, -137.72727273],
    [825, 825, -215.28409091],
    [2000, 2000, -736.02272727],
  ];
  const raises = report.candidates.filter((candidate) => candidate.action === 'raise');
  assert.equal(raises.length, expectedRaises.length, 'three raise sizes are offered');
  for (const [index, [to, cost, ev]] of expectedRaises.entries()) {
    const candidate = raises[index];
    assert.equal(candidate?.to, to, `raise ${index} total`);
    assert.equal(candidate?.cost, cost, `raise ${index} cost`);
    assertChips(candidate?.ev ?? Number.NaN, ev, `raise to ${to}`);
  }

  // Every raise here is worse than folding, so the suggestion is a fold. Under the old
  // bet-shaped arithmetic the smallest raise came out at +26.25 (see the test below) and
  // this spot recommended raising a hand with 15.9% equity against a set.
  assert.equal(report.suggestion.action, 'fold');
  assert.equal(report.suggestion.sizeRange, undefined, 'a fold has no size');
});

test('checked to: every candidate EV matches a figure computed by hand', () => {
  // Same cards, same 7/44, nothing to call. Now the aggressive action really is an
  // opening bet, and the bet formula is the right one — which is what localises the old
  // defect to the raise path rather than to `evOfBet`.
  const report = buildCoachReport(countedTurn({ toCall: 0 }));
  assertChips(report.equity.heroEquity, COUNTED_EQUITY, 'hero equity should be exactly 7/44');

  // EV(check) = e x pot = (7/44) x 400 = 2800/44 = 63.6363636.
  //
  // This assertion used to read `0`, with the comment "checking is worth the same as
  // folding right now". That was the defect written down as an expectation: a check is
  // NOT worth what a fold is worth. Folding surrenders every claim on the 400 already in
  // the middle; checking keeps the hand and therefore keeps 7/44 of that 400, for free.
  // Pricing the two the same is what let the Coach rank a fold above a free check — the
  // one line the engine, the lessons and the scenarios all agree is never right.
  //
  // It is the same number `evOfCall` gives at `toCall = 0`, which is the point: a check
  // is a call priced at nothing, and `ev.ts` has said so in its own doc comment all
  // along ("a free showdown is worth e x pot, which is why giving up a hand you could
  // see for free is never right"). The Coach simply was not asking it.
  const check = report.candidates.find((candidate) => candidate.action === 'check');
  assertChips(check?.ev ?? Number.NaN, 2800 / 44, 'a free check keeps 7/44 of the 400 already in the middle');
  const fold = report.candidates.find((candidate) => candidate.action === 'fold');
  assert.ok(
    (check?.ev ?? Number.NaN) > (fold?.ev ?? Number.NaN),
    'a free check must be worth strictly more than folding whenever the hand has any equity at all',
  );

  // The ladder is priced against the 400 pot, giving 100, 133, 200, 266, 300, 400, 600
  // and the 2000 all-in; the minimum legal bet is one big blind, so all of them are
  // legal and the picks are smallest, middle and shove.
  //
  //   b = 100:  EV = 0.35 x 400 + 0.65 x [ (7/44) x (400 + 200) - 100 ]
  //                = 140 + 0.65 x [ 95.4545455 - 100 ] = 140 - 2.9545455 = 137.0454545
  //   b = 266:  EV = 140 + 0.65 x [ (7/44) x (400 + 532) - 266 ]
  //                = 140 + 0.65 x [ 148.2727273 - 266 ] = 140 - 76.5227273 = 63.4772727
  //   b = 2000: EV = 140 + 0.65 x [ (7/44) x (400 + 4000) - 2000 ]
  //                = 140 + 0.65 x [ 700 - 2000 ] = 140 - 845 = -705
  const expectedBets: readonly [number, number][] = [
    [100, 137.04545455],
    [266, 63.47727273],
    [2000, -705],
  ];
  const bets = report.candidates.filter((candidate) => candidate.action === 'bet');
  assert.equal(bets.length, expectedBets.length);
  for (const [index, [to, ev]] of expectedBets.entries()) {
    const candidate = bets[index];
    assert.equal(candidate?.to, to, `bet ${index} total`);
    assert.equal(candidate?.cost, to, 'an opening bet costs exactly what it totals');
    assertChips(candidate?.ev ?? Number.NaN, ev, `bet of ${to}`);
  }
});

test('a raise is charged for the call inside it; an opening bet is not', () => {
  // The regression test for the defect this file's header describes, written as the
  // arithmetic distinction itself rather than as a fixed number, so it holds at every
  // size the ladder can produce.
  //
  // Both closed forms are written out here from the definitions, NOT taken from `ev.ts`:
  //
  //   EV(bet   b)      = f x pot + (1 - f) x [ e x (pot + 2b) - b ]
  //   EV(raise c by r) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ]
  //
  // and the two identities that separate them:
  //
  //   at the same increment r, EV(raise) = EV(bet r) - (1 - f) x c x (1 - e)
  //   at the same total risk b = c + r, EV(raise) = EV(bet b) - (1 - f) x e x c
  //
  // The first is the size of the old overstatement. The second is why a raise can never
  // beat a bet that risks the same chips into the same pot: part of what a raiser puts
  // in was already owed, so the opponent does not match it.
  const input = countedTurn();
  const report = buildCoachReport(input);
  const { pot, toCall } = input;
  const foldEquity = 0.35;
  const called = 1 - foldEquity;
  const equityWhenCalled = COUNTED_EQUITY;

  const evBetByHand = (b: number): number =>
    foldEquity * pot + called * (equityWhenCalled * (pot + 2 * b) - b);
  const evRaiseByHand = (c: number, r: number): number =>
    foldEquity * pot + called * (equityWhenCalled * (pot + c + 2 * r) - (c + r));

  const raises = report.candidates.filter((candidate) => candidate.action === 'raise');
  assert.ok(raises.length >= 2, 'the spot must offer raises for this to test anything');

  for (const candidate of raises) {
    const to = candidate.to ?? Number.NaN;
    const increment = to - (input.heroCommittedThisStreet + toCall);

    // Cost is the whole risk, and the total is the whole street commitment.
    assert.equal(candidate.cost, toCall + increment, `raise to ${to} must cost the call plus the raise`);
    assert.equal(
      to,
      input.heroCommittedThisStreet + toCall + increment,
      'to is a street total, not an increment',
    );

    // The EV is the raise formula...
    assertChips(candidate.ev, evRaiseByHand(toCall, increment), `raise to ${to}`);

    // ...and is strictly below the bet formula at the same increment, by exactly the
    // amount the old code overstated it by.
    const asOpeningBet = evBetByHand(increment);
    assertChips(
      asOpeningBet - candidate.ev,
      called * toCall * (1 - equityWhenCalled),
      `overstatement if raise to ${to} were priced as an opening bet`,
    );
    assert.ok(
      candidate.ev < asOpeningBet,
      `raising to ${to} must be worth less than betting ${increment} into the same pot`,
    );

    // And below a bet that risks the same total, by (1 - f) x e x c.
    const sameRiskBet = evBetByHand(candidate.cost);
    assertChips(
      sameRiskBet - candidate.ev,
      called * equityWhenCalled * toCall,
      `raise to ${to} against a bet risking the same ${candidate.cost}`,
    );

    // The derivation a learner reads must state the real risk. The old string said
    // "Risks 133 to win 400" for a raise that risked 433.
    assert.match(
      candidate.derivation,
      new RegExp(`Risks ${candidate.cost} to win ${pot}`),
      'the derivation must state the chips actually at risk',
    );
    assert.match(candidate.derivation, /EV\(raise\)/, 'a raise is labelled as a raise');
  }

  // The specific figure from the review, spelled out: at a 350 raise over a 300 bet the
  // bet formula gives 140 + 0.65 x [ (7/44) x 1100 - 350 ] = 140 + 0.65 x (175 - 350)
  // = 26.25 — a positive number that made "raise" the recommendation. The raise formula
  // gives -137.7272727. The gap is 0.65 x 300 x (1 - 7/44) = 163.9772727.
  assertChips(evBetByHand(350), 26.25, 'the bet formula at the same increment');
  assertChips(evRaiseByHand(300, 350), -137.72727273, 'the raise formula');
  assertChips(evBetByHand(350) - evRaiseByHand(300, 350), 163.97727273, 'the overstatement');
});

test('a total is a street commitment: the same spot from the big blind shifts totals, not values', () => {
  // Identical spot except that hero has 10 out there already. Every EV is a function of
  // chips still to be risked, so nothing about the values moves; every `to` is a street
  // total, so all of them move by exactly 10. Getting this wrong is what published
  // raises the table refuses.
  const flat = buildCoachReport(countedTurn());
  const fromBlind = buildCoachReport(countedTurn({ heroCommittedThisStreet: 10 }));

  const sizedFlat = flat.candidates.filter((candidate) => candidate.to !== undefined);
  const sizedBlind = fromBlind.candidates.filter((candidate) => candidate.to !== undefined);
  assert.equal(sizedBlind.length, sizedFlat.length);

  for (const [index, candidate] of sizedFlat.entries()) {
    const shifted = sizedBlind[index];
    assert.equal(shifted?.action, candidate.action);
    assert.equal(
      shifted?.to,
      (candidate.to ?? 0) + 10,
      `${candidate.action} total shifts by the 10 already out`,
    );
    assert.equal(shifted?.cost, candidate.cost, 'the chips leaving the stack do not change');
    assertChips(shifted?.ev ?? Number.NaN, candidate.ev, `${candidate.action} EV must not move`);
  }
});

test('a hand that is drawing dead is priced as a pure bluff, with no equity credited', () => {
  // Hero holds 7c 2d on Ah Kd Qs 9c 4h against exactly Kh Kc. Three kings against seven
  // high with no cards to come: hero's equity is exactly 0 and a tie is impossible, so
  // every figure here is pure arithmetic on the price.
  //
  //   EV(call)  = 0 x (140 + 45) - 45 = -45, the money handed over.
  //   EV(raise) = f x pot - (1 - f) x risk = 0.35 x 140 - 0.65 x risk = 49 - 0.65 x risk.
  //
  // The level is 45 and the minimum legal total is 45 + max(45, 10) = 90, so the ladder
  // (priced against the 185 that would be in the middle after the call) offers increments
  // of 46, 61, 92, 123, 138, 185, 277 and the 455 all-in, all of them legal raises.
  // Smallest, middle and shove:
  //
  //   R = 46  -> to = 91,  risk = 91:  49 - 59.15  = -10.15
  //   R = 123 -> to = 168, risk = 168: 49 - 109.20 = -60.20
  //   R = 455 -> to = 500, risk = 500: 49 - 325.00 = -276.00
  const report = buildCoachReport({
    heroCards: parseCards('7c 2d'),
    board: parseCards('Ah Kd Qs 9c 4h'),
    street: 'river',
    opponents: [{ label: 'trip kings', range: exactRange(parseCards('Kh Kc')) }],
    pot: 140,
    contestablePot: 140,
    toCall: 45,
    heroCommittedThisStreet: 0,
    heroStack: 500,
    opponentStacks: [500],
    bigBlind: 10,
    assumedFoldEquity: 0.35,
  });

  assert.equal(report.equity.heroEquity, 0, 'drawing dead is exactly zero, not nearly zero');
  assertChips(report.candidates.find((c) => c.action === 'call')?.ev ?? Number.NaN, -45, 'EV of calling');

  const expected: readonly [number, number][] = [
    [91, -10.15],
    [168, -60.2],
    [500, -276],
  ];
  const raises = report.candidates.filter((candidate) => candidate.action === 'raise');
  assert.equal(raises.length, expected.length);
  for (const [index, [to, ev]] of expected.entries()) {
    assert.equal(raises[index]?.to, to);
    assert.equal(raises[index]?.cost, to, 'nothing was out there, so the cost is the total');
    assertChips(raises[index]?.ev ?? Number.NaN, ev, `raise to ${to} with no equity`);
  }

  // Every action loses money, so folding wins. The review found this spot
  // (fl-top-pair-weak-kicker-river, the same shape) recommending a raise at +19.1 chips
  // and marking a learner's fold as inconsistent with the analysis.
  assert.equal(report.suggestion.action, 'fold');
});

test('the suggested size range holds only sizes priced within a big blind of the best', () => {
  // A spot where the smallest legal raise is clearly best and the all-in is clearly not:
  // facing 100 into 400 with 2,000 behind, the raises come out at roughly +71, -21 and
  // -715 chips. The range used to span the whole ladder, so its upper end was a size the
  // Coach itself priced 786 chips below its lower end — printed to a learner as
  // "Raise — 225 to 2000", which reads as "anything in here is fine".
  //
  // The property asserted is the definition itself, both ways round: a size is inside the
  // published range if and only if it is priced within one big blind of the best
  // candidate. A range that spans everything fails the "only if" half; a range that
  // dropped a genuinely near-indifferent size would fail the "if" half.
  for (const bigBlind of [10, 100]) {
    const report = buildCoachReport(countedTurn({ toCall: 100, bigBlind }));
    const ranked = [...report.candidates].sort((a, b) => b.ev - a.ev);
    const best = ranked[0];
    const range = report.suggestion.sizeRange;
    assert.notEqual(best, undefined);
    assert.notEqual(range, undefined, `bigBlind ${bigBlind}: a sized suggestion must publish a range`);
    if (best === undefined || range === undefined) continue;
    assert.equal(best.action, 'raise', 'the spot is meant to favour a raise');
    assert.ok(range.min <= range.max);

    for (const candidate of report.candidates) {
      if (candidate.action !== best.action || candidate.to === undefined) continue;
      // Annotated rather than inferred: `assert.equal` takes `unknown`, and letting the
      // checker infer this while it is also read inside the same call's message argument
      // is a circularity it reports as an implicit `any`.
      const inside: boolean = candidate.to >= range.min && candidate.to <= range.max;
      assert.equal(
        inside,
        candidate.ev >= best.ev - bigBlind,
        `bigBlind ${bigBlind}: size ${candidate.to} priced at ${candidate.ev.toFixed(2)} against a best of ` +
          `${best.ev.toFixed(2)} is ${inside ? 'inside' : 'outside'} the published ${range.min}..${range.max}`,
      );
    }

    // The all-in exists in both reports and is hundreds of chips worse than the best, so
    // it must never be the upper end. It always was.
    const shove = report.candidates.find(
      (candidate) => candidate.action === 'raise' && candidate.to === 2_000,
    );
    assert.notEqual(shove, undefined, 'the all-in must exist for its exclusion to mean anything');
    assert.ok((shove?.ev ?? 0) < best.ev - bigBlind, 'the all-in is far worse than the best size here');
    assert.ok(
      range.max < 2_000,
      `bigBlind ${bigBlind}: the all-in must not be published as a defensible size`,
    );
  }

  // At one big blind exactly one size qualifies, so the range is that single size stated
  // twice rather than a span. At a hundred, two sizes are near-indifferent and the range
  // widens to a real span — which is the only shape in which the field carries
  // information.
  const atTen = buildCoachReport(countedTurn({ toCall: 100, bigBlind: 10 })).suggestion.sizeRange;
  const atHundred = buildCoachReport(countedTurn({ toCall: 100, bigBlind: 100 })).suggestion.sizeRange;
  assert.equal(atTen?.min, atTen?.max);
  assert.ok((atHundred?.min ?? 0) < (atHundred?.max ?? 0));
});

// ---------------------------------------------------------------------------
// Folding when checking is free
// ---------------------------------------------------------------------------

test('with nothing to call, fold is never ranked above check', () => {
  // The one line the engine, the lessons and the scenarios all agree can never be right.
  // `legalActions` says as much in the note it attaches to a free fold ("Legal, but
  // checking costs nothing"), and the Coach used to recommend it anyway: a check was
  // hard-coded at EV 0, a fold is 0 by definition, and a stable descending sort with fold
  // pushed first put fold on top of the tie.
  //
  // The spots below are chosen to be adversarial rather than typical. Hero is drawing
  // stone dead in two of them — equity exactly 0 — which is the only case where the two
  // figures can still tie, and it is where a "check is worth 0" implementation looked
  // most defensible.
  const spots: readonly (readonly [string, CoachInput])[] = [
    [
      // Equity exactly 0 (three kings against seven high, board complete) and no chips
      // behind, so fold and check are the only two candidates there are.
      'drawing dead with no chips behind',
      {
        heroCards: parseCards('7c 2d'),
        board: parseCards('Ah Kd Qs 9c 4h'),
        street: 'river',
        opponents: [{ label: 'trip kings', range: exactRange(parseCards('Kh Kc')) }],
        pot: 140,
        contestablePot: 140,
        toCall: 0,
        heroCommittedThisStreet: 0,
        heroStack: 0,
        opponentStacks: [500],
        bigBlind: 10,
      },
    ],
    [
      // The same, with the engine's own list saying only these two are available.
      'drawing dead, engine offers fold and check only',
      {
        heroCards: parseCards('7c 2d'),
        board: parseCards('Ah Kd Qs 9c 4h'),
        street: 'river',
        opponents: [{ label: 'trip kings', range: exactRange(parseCards('Kh Kc')) }],
        pot: 140,
        contestablePot: 140,
        toCall: 0,
        heroCommittedThisStreet: 0,
        heroStack: 500,
        opponentStacks: [500],
        bigBlind: 10,
        legalActions: ['fold', 'check'],
      },
    ],
    [
      // An empty pot: `equity x pot` is 0 for every hand, so every candidate ties at zero
      // and only the tiebreak separates them.
      'an empty pot, where every free action is worth exactly zero',
      {
        heroCards: parseCards('Th 9h'),
        board: parseCards('Kh 7h 2c'),
        street: 'flop',
        opponents: [{ label: 'top pair', range: exactRange(parseCards('Ks Qd')) }],
        pot: 0,
        contestablePot: 0,
        toCall: 0,
        heroCommittedThisStreet: 0,
        heroStack: 0,
        opponentStacks: [500],
        bigBlind: 10,
      },
    ],
    ['an ordinary free continuation with a real draw', nineOutFlushDraw({ toCall: 0 })],
    ['a made hand checked to', countedTurn({ toCall: 0 })],
  ];

  for (const [label, spot] of spots) {
    const report = buildCoachReport(spot);
    assert.equal(report.toCall, 0, `${label}: the fixture must be a free continuation`);

    const check = report.candidates.find((candidate) => candidate.action === 'check');
    const fold = report.candidates.find((candidate) => candidate.action === 'fold');
    assert.ok(check !== undefined, `${label}: a free spot must offer a check`);
    assert.ok(fold !== undefined, `${label}: a free spot still offers a fold`);

    // The arithmetic, first: a check is `equity x pot`, which is never negative, so it
    // can never be below a fold's zero. Asserting the inequality rather than the number
    // keeps this true for every spot rather than for these five.
    assert.ok(check.ev >= fold.ev, `${label}: check priced at ${check.ev} against a fold at ${fold.ev}`);
    assert.ok(
      Math.abs(check.ev - report.equity.heroEquity * spot.pot) < 1e-9,
      `${label}: EV(check) = e x pot`,
    );

    // Then the ranking, which is the thing a learner actually reads. Ties are broken
    // against giving up the hand, so a fold cannot win one.
    assert.notEqual(report.suggestion.action, 'fold', `${label}: the Coach suggested folding for free`);

    // And the ordering explicitly, in case a future candidate is added between them.
    const ranked = [...report.candidates].sort((a, b) => b.ev - a.ev);
    const foldRank = ranked.findIndex((candidate) => candidate.action === 'fold');
    const checkRank = ranked.findIndex((candidate) => candidate.action === 'check');
    assert.ok(
      checkRank <= foldRank || check.ev > fold.ev,
      `${label}: fold sorted above check (${foldRank} vs ${checkRank})`,
    );
  }
});

test('no figure a report publishes, in a number or in a sentence, is a probability above 100%', () => {
  // The whole class of defect in one assertion, on the producing side. `@prl/ui` renders
  // every probability on this contract by multiplying by 100, so a field that is not a
  // fraction becomes a four-figure percentage on the panel; and a sentence built here can
  // state an impossible figure without any field being wrong at all — which is what
  // "The rule of 2 and 4 gives 180% here" was.
  //
  // The spots are chosen to be the ones that used to break it: a made hand miles ahead
  // (45 cards classified as outs), a draw whose every out is dirty, a hand drawing stone
  // dead, and one real draw so the scan is not passing on empty reports.
  const spots: readonly (readonly [string, CoachInput])[] = [
    [
      'a flopped set, 100% to win',
      {
        heroCards: parseCards('7s 7d'),
        board: parseCards('7h 2c 9d'),
        street: 'flop',
        opponents: [{ label: 'ace high', range: exactRange(parseCards('As Kd')) }],
        pot: 100,
        contestablePot: 100,
        toCall: 50,
        heroCommittedThisStreet: 0,
        heroStack: 400,
        opponentStacks: [400],
        bigBlind: 10,
      },
    ],
    ['a nut flush draw against a set', flushDrawVsSet()],
    ['a real nine-out draw', nineOutFlushDraw()],
    ['a free continuation', nineOutFlushDraw({ toCall: 0 })],
    [
      'drawing dead on the river',
      {
        heroCards: parseCards('7c 2d'),
        board: parseCards('Ah Kd Qs 9c 4h'),
        street: 'river',
        opponents: [{ label: 'trip kings', range: exactRange(parseCards('Kh Kc')) }],
        pot: 140,
        contestablePot: 140,
        toCall: 45,
        heroCommittedThisStreet: 0,
        heroStack: 500,
        opponentStacks: [500],
        bigBlind: 10,
      },
    ],
  ];

  for (const [label, spot] of spots) {
    const report = buildCoachReport(spot);

    // Every field the UI will multiply by 100 has to be a fraction already.
    const fractions: readonly (readonly [string, number | null | undefined])[] = [
      ['heroEquity', report.equity.heroEquity],
      ['ruleOfThumb.estimate', report.equity.ruleOfThumb?.estimate],
      ['breakEvenEquity', report.potOdds.breakEvenEquity],
      ['potOddsOfferedByPotSizedBet', report.stackContext.potOddsOfferedByPotSizedBet],
      ...report.equity.perPlayer.map(
        (player) => [`perPlayer[${player.label}].equity`, player.equity] as const,
      ),
      ...report.candidates.flatMap((candidate) => [
        [`${candidate.action}.potShareIfCalled`, candidate.potShareIfCalled] as const,
        [`${candidate.action}.foldEquityAssumed`, candidate.foldEquityAssumed] as const,
      ]),
    ];
    for (const [field, value] of fractions) {
      if (value === null || value === undefined) continue;
      assert.ok(value >= 0 && value <= 1, `${label}: ${field} is ${value}, which is not a fraction in 0..1`);
    }

    // And every sentence, because a string can be wrong while every field is right.
    const sentences: readonly string[] = [
      report.suggestion.reason,
      ...report.suggestion.whatWouldChangeIt,
      ...report.assumptions,
      ...report.teachingNotes,
      ...report.uncertainty.limitations,
      report.uncertainty.summary,
      report.potOdds.explanation,
      report.stackContext.explanation,
      report.outs?.explanation ?? '',
      report.equity.ruleOfThumb?.note ?? '',
      ...report.candidates.map((candidate) => candidate.derivation),
    ];
    for (const sentence of sentences) {
      for (const match of sentence.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*%/g)) {
        const value = Number((match[1] ?? '').replace(/,/g, ''));
        assert.ok(
          value <= 100,
          `${label}: a report sentence states "${match[0]}", which cannot be a probability — ${JSON.stringify(sentence.slice(0, 160))}`,
        );
      }
    }
  }
});

test('a raise states the defence frequency for a RAISE, not for a bet of the same size', () => {
  /**
   * `sizingLadder` builds its options with `defenceFrequency(potAfterCall, raiseBy)`, which
   * returns `pot / (pot + bet)` — correct for a BET, where the aggressor risks `bet` to win
   * `pot`. A raise is a different shape: raising by `r` while facing `c` risks `c + r` to win the
   * pot as it stood BEFORE hero called. Reading the ladder's figure into a raise's note therefore
   * counted hero's own call as money hero wins when the opponent folds, and overstated every
   * raise's minimum defence frequency.
   *
   * Measured before the fix, at pot 100 / toCall 50: a raise of 50 published 75.0% where the
   * answer is 50.0%. The published sentence is "…has to continue with X% of their range for a
   * raise of this size not to print automatically", so an overstated X tells the learner to
   * defend far wider than the arithmetic supports — in a product whose whole purpose is the
   * arithmetic.
   *
   * This asserts the closed form `pot / (pot + toCall + raiseBy)` against every raise the report
   * publishes, so it cannot be satisfied by a single hard-coded number. `priceLaidToCaller` in
   * the same sentence was always right, and is checked here too so a future edit cannot fix one
   * by breaking the other.
   */
  const input = flushDrawVsSet();
  const report = buildCoachReport(input);
  const raises = report.candidates.filter((entry) => /Raising by/.test(entry.derivation));
  assert.ok(raises.length > 0, 'the fixture must publish at least one raise for this to mean anything');

  for (const entry of raises) {
    const sizing = /Raising by ([\d,]+)/.exec(entry.derivation);
    const defence = /continue with ([\d.]+)%/.exec(entry.derivation);
    const price = /needs ([\d.]+)% equity/.exec(entry.derivation);
    assert.ok(sizing?.[1] !== undefined, entry.derivation);
    assert.ok(defence?.[1] !== undefined, entry.derivation);
    assert.ok(price?.[1] !== undefined, entry.derivation);
    const raiseBy = Number(sizing[1].replace(/,/g, ''));

    const expectedDefence = (100 * input.pot) / (input.pot + input.toCall + raiseBy);
    assert.ok(
      Math.abs(Number(defence[1]) - expectedDefence) < 0.6,
      `raise of ${raiseBy}: published MDF ${defence[1]}%, correct ${expectedDefence.toFixed(1)}%`,
    );

    // The caller's price is measured against the pot after they call the raise, which includes
    // hero's call and the raise twice — this one the ladder gets right.
    const expectedPrice = (100 * raiseBy) / (input.pot + input.toCall + 2 * raiseBy);
    assert.ok(
      Math.abs(Number(price[1]) - expectedPrice) < 0.6,
      `raise of ${raiseBy}: published price ${price[1]}%, correct ${expectedPrice.toFixed(1)}%`,
    );
  }
});
