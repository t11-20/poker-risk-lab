/**
 * Coach tests of two kinds. First, promises the types cannot express. Every figure carries its
 * assumptions, every sampled figure its interval, nothing is labelled correct or optimal, bets are
 * whole chips, and the same input gives the same report. Second, numbers against ground truth worked
 * out by hand in the comments, because composing equity, odds and EV wrongly is not covered by their
 * own suites.
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
    // Hero covers the bet from a deep stack, so the whole pot is contestable. An all-in-for-less
    // test overrides this.
    contestablePot: overrides.contestablePot ?? overrides.pot ?? 100,
  };
}

test('a report never presents a figure without its assumptions', () => {
  // PRODUCT-GUARDRAILS §3. Checked across many spots, not one path.
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
  // The type has no field for it, so this checks the strings.
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
  // The engine rejects a fractional bet, so a fractional suggestion is an action the player cannot take.
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
  // Same cards, same equity, opposite decision, because only the price changed. The expensive spot
  // leaves 1,000 behind so a raise is still on offer and the raise path is really exercised.
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
  // A pot-sized bet lays the caller exactly 1/3.
  assert.ok(Math.abs(report.stackContext.potOddsOfferedByPotSizedBet - 1 / 3) < 1e-9);
});

/**
 * A nine-out flush draw: hero Th 9h on Kh 7h 2c against exactly Ks Qd. Hero has 39.49% equity, and
 * all nine hearts are clean (top pair cannot outdraw a flush without the board pairing twice).
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
    contestablePot: overrides.contestablePot ?? overrides.pot ?? 100,
  };
}

test('the rule of 2/4 is published as a fraction, from clean outs, with its real error', () => {
  // Every expectation below is a literal derived by hand from the cards, not from the code under test.
  // The shortcut counts clean outs only and is compared against the hit chance, not hero's equity.
  const report = buildCoachReport(nineOutFlushDraw());
  const outs = report.outs;
  assert.ok(outs !== null, 'a flop spot against one opponent has an outs breakdown');
  assert.equal(outs.clean, 9, 'the nine unseen hearts');
  assert.equal(outs.dirty, 0, 'and nothing dirty to blur the arithmetic');

  const thumb = report.equity.ruleOfThumb;
  assert.ok(thumb !== null, 'a real draw with clean outs should show the shortcut');

  // 9 clean outs x 4 = 36 points, carried as the fraction 0.36.
  assert.equal(thumb.estimate, 0.36, 'published as a FRACTION, so @prl/ui renders 36.0% and not 3,600.0%');
  assert.ok(thumb.estimate <= 1, 'a probability is never above 1');

  // Exact chance of one of nine arriving over turn and river. The denominator is 45, not 47, because
  // the opponent holds the known Ks Qd, which cannot come off the deck. `computeOuts` counts the same 45.
  //     1 - (36/45) x (35/44) = 1 - 1260/1980 = 1 - 7/11 = 4/11 = 0.363636363636...
  // so the shortcut understates by 36 - 36.3636363636 = -0.3636363636 points.
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
  // The note must quote the same denominator as the outs paragraph.
  assert.match(thumb.note, /45 cards unseen/, 'the derivation must quote the same 45 the outs came from');
  assert.doesNotMatch(thumb.note, /47 cards unseen/);
});

/**
 * The shortcut is measured against the denominator the outs were counted from, never one re-derived
 * from the street. The two spots below share hero hand, board and 8 clean outs, and differ only in
 * whether the opponent is a known hand or a range. The true error changes sign across them, so both
 * assert a sign. Every literal is worked out in the comments.
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
    contestablePot: overrides.contestablePot ?? overrides.pot ?? 100,
  };
}

test('errorPoints is measured against the cards the outs were counted from, sign included', () => {
  // Case 1. A known opponent hand, so 45 cards can come, not 47.
  // Hero 9s8s on 7s6d2c against exactly AhAd: 8 clean outs out of 45, equityNow 36.87%.
  //     1 - (37/45) x (36/44) = 1 - 1332/1980 = 1 - 37/55 = 18/55 = 0.327272727272...
  // The shortcut says 8 x 4 = 32%, so it understates by 32 - 32.727272727 = -0.727272727.
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

  // Case 2. A notation range, where 47 is correct and must stay. This guards against "correcting"
  // the denominator into a different wrong constant.
  //     1 - (39/47) x (38/46) = 1 - 1482/2162 = 1 - 741/1081 = 0.3145235892691952...
  // The shortcut's 32% overstates by 32 - 31.45235892691952 = +0.54764107308048.
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

  // Same 8 outs, same 32%, and the error changes sign with the card set.
  assert.ok(
    knownThumb.errorPoints < 0 && rangedThumb.errorPoints > 0,
    'the sign is a property of the spot, not of the street',
  );
});

test('the shortcut is withheld where it cannot mean anything, and says why', () => {
  // The rule of 2 and 4 is for a draw with clean outs still to come. Each spot breaks one of those
  // words. A shortcut figure here would not be a probability (the first one gives 180%).
  const cases: readonly [string, CoachInput, RegExp][] = [
    [
      // Hero's set against ace-high: 100% equity and 45 cards counted as outs. 45 x 4 = 180.
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
      // The nut flush draw against a set. Every out is dirty because the board can pair.
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
      // No note is owed. With no cards to come the panel shows no outs section either.
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
    // A total, not an increment. The fixture faces 50 with nothing out, so any legal raise total is
    // above 50. Accepting 40 or 50 would put every published size back below the minimum.
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

/**
 * A turn spot whose equity is a countable fraction. Hero Ah Kh, board Qh 7h 2c 3d, opponent exactly
 * Qs Qd (a set). 44 unseen cards. Hero wins only by making a flush that does not fill the opponent up:
 *
 *   * 9 hearts are unseen: 2h 3h 4h 5h 6h 8h 9h Th Jh.
 *   * 2h and 3h pair the board and give the opponent a full house.
 *   * That leaves 7 winners. A tie is impossible.
 *
 *     e = 7 / 44 = 0.15909090909...
 *
 * Every figure below is worked out from that fraction in a comment. Nothing calls the code under test.
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
    // Stated, not defaulted, so a moved default cannot break this test.
    assumedFoldEquity: 0.35,
    ...overrides,
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

  // Exact enumeration, so the equity is an identity, not an approximation.
  assert.equal(report.equity.method, 'exact-enumeration');
  assertChips(report.equity.heroEquity, COUNTED_EQUITY, 'hero equity should be exactly 7/44');

  const byAction = (action: string, to?: number) =>
    report.candidates.find(
      (candidate) => candidate.action === action && (to === undefined || candidate.to === to),
    );

  assertChips(byAction('fold')?.ev ?? Number.NaN, 0, 'folding is the zero point');

  // EV(call) = e x (pot + toCall) - toCall
  //          = (7/44) x (400 + 300) - 300
  //          = 4900/44 - 300 = 111.3636364 - 300 = -188.6363636
  assertChips(byAction('call')?.ev ?? Number.NaN, -188.63636364, 'EV of calling 300 into 400');

  // The raise sizes are the bar's (`offeredSizes`): its default, the floor, and the ⅓, ½, ⅔, pot and
  // all-in presets, each `betLevel + round(fraction x potAfterCall)` clamped into the legal range. The
  // level is 300, the floor 300 + max(300, 10) = 600, and the pot after the call 700. So ⅓ = 533 clamps
  // to 600, ½ = 650, ⅔ = 767, pot = 1000, all-in = 2000. Each is a raise by r = to - 300:
  //
  //     EV = 0.35 x 400 + 0.65 x [ (7/44) x (400 + 300 + 2r) - (300 + r) ]
  //
  //   to  600, r =  300: 140 + 0.65 x [ (7/44) x 1300 - 600 ]  = -115.5681818
  //   to  650, r =  350: 140 + 0.65 x [ (7/44) x 1400 - 650 ]  = -137.7272727
  //   to  767, r =  467: 140 + 0.65 x [ (7/44) x 1634 - 767 ]  = -189.5795455
  //   to 1000, r =  700: 140 + 0.65 x [ (7/44) x 2100 - 1000 ] = -292.8409091
  //   to 2000, r = 1700: 140 + 0.65 x [ (7/44) x 4100 - 2000 ] = -736.0227273
  const expectedRaises: readonly [number, number, number][] = [
    // [to, cost, ev]
    [600, 600, -115.56818182],
    [650, 650, -137.72727273],
    [767, 767, -189.57954545],
    [1000, 1000, -292.84090909],
    [2000, 2000, -736.02272727],
  ];
  const raises = report.candidates.filter((candidate) => candidate.action === 'raise');
  assert.equal(raises.length, expectedRaises.length, 'the floor, ½, ⅔, pot and the shove are offered');
  for (const [index, [to, cost, ev]] of expectedRaises.entries()) {
    const candidate = raises[index];
    assert.equal(candidate?.to, to, `raise ${index} total`);
    assert.equal(candidate?.cost, cost, `raise ${index} cost`);
    assertChips(candidate?.ev ?? Number.NaN, ev, `raise to ${to}`);
  }

  // Every raise is worse than folding. Bet-shaped arithmetic priced the smallest raise at +26.25.
  assert.equal(report.suggestion.action, 'fold');
  assert.equal(report.suggestion.sizeRange, undefined, 'a fold has no size');
});

test('checked to: every candidate EV matches a figure computed by hand', () => {
  // Same cards, nothing to call. Here the bet formula is the right one, which confines the old
  // defect to the raise path.
  const report = buildCoachReport(countedTurn({ toCall: 0 }));
  assertChips(report.equity.heroEquity, COUNTED_EQUITY, 'hero equity should be exactly 7/44');

  // EV(check) = e x pot = (7/44) x 400 = 2800/44 = 63.6363636. A check keeps the hand's share of
  // the pot, so it is never worth what a fold is worth. It equals `evOfCall` at `toCall = 0`.
  const check = report.candidates.find((candidate) => candidate.action === 'check');
  assertChips(check?.ev ?? Number.NaN, 2800 / 44, 'a free check keeps 7/44 of the 400 already in the middle');
  const fold = report.candidates.find((candidate) => candidate.action === 'fold');
  assert.ok(
    (check?.ev ?? Number.NaN) > (fold?.ev ?? Number.NaN),
    'a free check must be worth strictly more than folding whenever the hand has any equity at all',
  );

  // The bar's sizes against the 400 pot: the floor of 10, then ⅓ = 133, ½ = 200, ⅔ = 267 (266.67
  // rounded to the nearest chip) and pot = 400, and the 2000 all-in.
  //
  //   b =   10:  EV = 0.35 x 400 + 0.65 x [ (7/44) x (400 + 20) - 10 ]   = 176.9318182
  //   b =  133:  EV = 140 + 0.65 x [ (7/44) x (400 + 266) - 133 ]         = 122.4204545
  //   b =  200:  EV = 140 + 0.65 x [ (7/44) x (400 + 400) - 200 ]         =  92.7272727
  //   b =  267:  EV = 140 + 0.65 x [ (7/44) x (400 + 534) - 267 ]         =  63.0340909
  //   b =  400:  EV = 140 + 0.65 x [ (7/44) x (400 + 800) - 400 ]         =   4.0909091
  //   b = 2000:  EV = 140 + 0.65 x [ (7/44) x (400 + 4000) - 2000 ]       = -705
  const expectedBets: readonly [number, number][] = [
    [10, 176.93181818],
    [133, 122.42045455],
    [200, 92.72727273],
    [267, 63.03409091],
    [400, 4.09090909],
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
  // The raise-versus-bet distinction as arithmetic, so it holds at every size. Both closed forms are
  // written from the definitions, not taken from `ev.ts`:
  //
  //   EV(bet   b)      = f x pot + (1 - f) x [ e x (pot + 2b) - b ]
  //   EV(raise c by r) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ]
  //
  //   at the same increment r, EV(raise) = EV(bet r) - (1 - f) x c x (1 - e)
  //   at the same total risk b = c + r, EV(raise) = EV(bet b) - (1 - f) x e x c
  //
  // The second is why a raise never beats a bet that risks the same chips. Part of the raise was owed.
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

    assertChips(candidate.ev, evRaiseByHand(toCall, increment), `raise to ${to}`);

    // Strictly below the bet formula at the same increment.
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

    // The derivation a learner reads must state the real risk, the call plus the raise.
    assert.match(
      candidate.derivation,
      new RegExp(`Risks ${candidate.cost} to win ${pot}`),
      'the derivation must state the chips actually at risk',
    );
    assert.match(candidate.derivation, /EV\(raise\)/, 'a raise is labelled as a raise');
  }

  // At a 350 raise over a 300 bet the bet formula gives 140 + 0.65 x (175 - 350) = 26.25, a positive
  // figure. The raise formula gives -137.7272727. The gap is 0.65 x 300 x (1 - 7/44) = 163.9772727.
  assertChips(evBetByHand(350), 26.25, 'the bet formula at the same increment');
  assertChips(evRaiseByHand(300, 350), -137.72727273, 'the raise formula');
  assertChips(evBetByHand(350) - evRaiseByHand(300, 350), 163.97727273, 'the overstatement');
});

test('a total is a street commitment: the same spot from the big blind shifts totals, not values', () => {
  // Hero has 10 out already. EVs depend on chips still to be risked, so they do not move. Every `to`
  // is a street total, so each moves by exactly 10.
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
  // Hero 7c 2d on Ah Kd Qs 9c 4h against exactly Kh Kc, river. Equity is exactly 0.
  //
  //   EV(call)  = 0 x (140 + 45) - 45 = -45
  //   EV(raise) = 0.35 x 140 - 0.65 x risk = 49 - 0.65 x risk
  //
  // The floor is 45 + max(45, 10) = 90. The bar's sizes against the 185 after the call are 90,
  // ⅓ = 107, ½ = 138 (92.5 rounds up), ⅔ = 168, pot = 230 and the 500 all-in. Nothing is out
  // yet, so the risk is the total:
  //
  //   to =  90:  49 -  58.50 =   -9.50
  //   to = 107:  49 -  69.55 =  -20.55
  //   to = 138:  49 -  89.70 =  -40.70
  //   to = 168:  49 - 109.20 =  -60.20
  //   to = 230:  49 - 149.50 = -100.50
  //   to = 500:  49 - 325.00 = -276.00
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
    [90, -9.5],
    [107, -20.55],
    [138, -40.7],
    [168, -60.2],
    [230, -100.5],
    [500, -276],
  ];
  const raises = report.candidates.filter((candidate) => candidate.action === 'raise');
  assert.equal(raises.length, expected.length);
  for (const [index, [to, ev]] of expected.entries()) {
    assert.equal(raises[index]?.to, to);
    assert.equal(raises[index]?.cost, to, 'nothing was out there, so the cost is the total');
    assertChips(raises[index]?.ev ?? Number.NaN, ev, `raise to ${to} with no equity`);
  }

  // Every action loses chips, so folding wins.
  assert.equal(report.suggestion.action, 'fold');
});

test('the suggested size range holds only sizes priced within a big blind of the best', () => {
  // Facing 100 into 400 with 2,000 behind, the raises come out at roughly +71, -21 and -715 chips.
  // A size is inside the published range if and only if it is priced within one big blind of the
  // best candidate. Both directions are asserted.
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

    // The all-in is hundreds of chips worse than the best, so it is never the upper end.
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

  // At one big blind exactly one size qualifies, so the range is a single size. At a hundred, two
  // sizes are near-indifferent and the range is a real span.
  const atTen = buildCoachReport(countedTurn({ toCall: 100, bigBlind: 10 })).suggestion.sizeRange;
  const atHundred = buildCoachReport(countedTurn({ toCall: 100, bigBlind: 100 })).suggestion.sizeRange;
  assert.equal(atTen?.min, atTen?.max);
  assert.ok((atHundred?.min ?? 0) < (atHundred?.max ?? 0));
});

test('with nothing to call, fold is never ranked above check', () => {
  // With nothing to call, a fold never outranks a check. Two spots are drawing dead (equity exactly 0),
  // the only case where the two can still tie.
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
      // In an empty pot every candidate ties at zero and only the tiebreak separates them.
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

    // A check is `equity x pot`, never negative, so it is never below a fold's zero.
    assert.ok(check.ev >= fold.ev, `${label}: check priced at ${check.ev} against a fold at ${fold.ev}`);
    assert.ok(
      Math.abs(check.ev - report.equity.heroEquity * spot.pot) < 1e-9,
      `${label}: EV(check) = e x pot`,
    );

    // Ties are broken against giving up the hand, so a fold cannot win one.
    assert.notEqual(report.suggestion.action, 'fold', `${label}: the Coach suggested folding for free`);

    // The ordering explicitly, in case a candidate is added between them.
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
  // `@prl/ui` multiplies every probability on this contract by 100, so each field must be a fraction,
  // and no sentence may state an impossible figure. The spots are the ones that once broke it, plus
  // one real draw so the scan does not pass on empty reports.
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

    // Every sentence too, because a string can be wrong while every field is right.
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
   * A raise by `r` facing `c` risks `c + r` to win the pot as it stood before hero called, so its
   * minimum defence frequency is `pot / (pot + toCall + raiseBy)`, not the bet formula
   * `pot / (pot + bet)`. At pot 100 / toCall 50 a raise of 50 must read 50.0%, not 75.0%.
   * `priceLaidToCaller` is checked too so a fix to one cannot break the other.
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

    // The caller's price is against the pot after they call, which includes hero's call and the raise twice.
    const expectedPrice = (100 * raiseBy) / (input.pot + input.toCall + 2 * raiseBy);
    assert.ok(
      Math.abs(Number(price[1]) - expectedPrice) < 0.6,
      `raise of ${raiseBy}: published price ${price[1]}%, correct ${expectedPrice.toFixed(1)}%`,
    );
  }
});

test('the price sentence is chosen, not appended — a hero who misses the price is told so (REGRESSION)', () => {
  // The sentence's lead clause and the sign of the gap must both depend on whether hero clears the
  // price. A hero with no equity once read "You clear that with 0.0% equity, a -24.3 point shortfall."
  const board = parseCards('Ks 9h 4c 2d 8s');
  const base = {
    board,
    street: 'river' as const,
    pot: 220,
    contestablePot: 220,
    toCall: 80,
    heroCommittedThisStreet: 0,
    heroStack: 300,
    opponentStacks: [300],
    bigBlind: 10,
  };
  const missing: CoachInput = {
    ...base,
    heroCards: parseCards('7c 7d'),
    opponents: [{ label: 'the button', range: exactRange(parseCards('Kh Qd')) }],
  };
  const clearing: CoachInput = {
    ...base,
    heroCards: parseCards('Kh Qd'),
    opponents: [{ label: 'the button', range: exactRange(parseCards('7c 7d')) }],
  };

  const missed = buildCoachReport(missing).potOdds;
  assert.ok(
    missed.equitySurplus < 0,
    'the fixture must actually be a losing price for this to test anything',
  );
  assert.ok(
    !missed.explanation.includes('You clear that'),
    `a hero who misses the price was told they clear it: "${missed.explanation}"`,
  );
  assert.match(missed.explanation, /do not clear that/u);
  assert.ok(
    !/-\d/u.test(missed.explanation),
    `the shortfall is stated as a negative number: "${missed.explanation}"`,
  );

  const cleared = buildCoachReport(clearing).potOdds;
  assert.ok(cleared.equitySurplus > 0, 'the fixture must actually clear the price');
  assert.match(cleared.explanation, /You clear that/u);
  assert.match(cleared.explanation, /surplus/u);
});

test('"loses more often than it wins" is keyed to hero equity, not to the price (REGRESSION)', () => {
  // A profitable call can lose more often than it wins only when hero is under 50%, so the note keys
  // on that, not on `equitySurplus > 0` alone.
  const winning: CoachInput = {
    heroCards: parseCards('Kh Qd'),
    board: parseCards('Ks 9h 4c 2d 8s'),
    street: 'river',
    opponents: [{ label: 'the button', range: exactRange(parseCards('7c 7d')) }],
    pot: 220,
    contestablePot: 220,
    toCall: 80,
    heroCommittedThisStreet: 0,
    heroStack: 300,
    opponentStacks: [300],
    bigBlind: 10,
  };
  const report = buildCoachReport(winning);
  assert.ok(report.equity.heroEquity > 0.5, 'the fixture must have hero ahead for this to test anything');
  assert.ok(report.potOdds.equitySurplus > 0, 'and the call must be profitable, which is the old trigger');
  const claim = report.teachingNotes.find((note) => note.includes('loses more often than it wins'));
  assert.equal(
    claim,
    undefined,
    `a hero ahead at ${(report.equity.heroEquity * 100).toFixed(1)}% was told the call "loses more often than it wins"`,
  );
});

test('confidence measures the gap to the next-best ACTION, not to a neighbouring size of the same one', () => {
  // Facing 100 into 210 at a big blind of 20, Qh Jh against exactly Ac Kd on Th 9s 2c 3d. The floor
  // (200) and the ⅓-pot preset (203) price within a chip of each other (41.44 and 40.65). Confidence
  // is measured against the best line that is not a raise (fold, at 0, two big blinds behind). Size
  // near-ties are what `sizeRange` is for.
  const report = buildCoachReport({
    heroCards: parseCards('Qh Jh'),
    board: parseCards('Th 9s 2c 3d'),
    street: 'turn',
    opponents: [{ label: 'the opponent', range: exactRange(parseCards('Ac Kd')) }],
    pot: 210,
    contestablePot: 210,
    toCall: 100,
    heroCommittedThisStreet: 0,
    heroStack: 1000,
    opponentStacks: [1000],
    bigBlind: 20,
  });
  const raises = report.candidates.filter((candidate) => candidate.action === 'raise');
  assert.equal(raises[0]?.to, 200, 'the floor is priced');
  assert.equal(raises[1]?.to, 203, 'and the ⅓-pot preset beside it');
  assert.ok(Math.abs((raises[0]?.ev ?? 0) - (raises[1]?.ev ?? 0)) < 1, 'the two sizes are within a chip');

  assert.equal(report.suggestion.action, 'raise');
  assert.equal(report.suggestion.confidence, 'reasonable');
  assert.match(report.suggestion.reason, /by 41\.4 units over the next-best action/u);
  // 255 (½ pot) is 26.82, within one big blind of the best, so it is in the range too.
  assert.deepEqual(report.suggestion.sizeRange, { min: 200, max: 255 }, 'the near-tie is the size range');
});
