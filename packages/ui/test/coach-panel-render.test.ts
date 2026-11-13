/**
 * The Coach panel, rendered, read as a learner reads it.
 * A percentage-point value once reached `formatPercent` and printed "3,600.0%", with both halves
 * passing their own tests. So this reads every percentage out of the markup, and none may be above
 * 100 or below 0. Fixtures are hand-derived literals, because figures from `@prl/poker-math` would
 * only prove the two agree.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CoachReport } from '@prl/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadComponent } from './support/render-component.ts';

async function render(report: CoachReport): Promise<string> {
  const CoachPanel = await loadComponent<{ readonly report: CoachReport }>(
    'components/CoachPanel',
    'CoachPanel',
  );
  return renderToStaticMarkup(createElement(CoachPanel, { report }));
}

/** Every percentage in the rendered output, attributes included, because an `aria-label` is read aloud. */
function percentagesIn(markup: string): readonly { readonly text: string; readonly value: number }[] {
  const found: { text: string; value: number }[] = [];
  for (const match of markup.matchAll(/(-?\d[\d,]*(?:\.\d+)?)\s*%/g)) {
    const text = match[1] ?? '';
    found.push({ text: `${text}%`, value: Number(text.replace(/,/g, '')) });
  }
  return found;
}

/** Every percentage that cannot be a probability. Both ends, because a unit error can carry a sign. */
function impossiblePercentagesIn(markup: string): readonly string[] {
  return percentagesIn(markup)
    .filter((entry) => entry.value > 100 || entry.value < 0)
    .map((entry) => entry.text);
}

/**
 * Hero Th 9h on Kh 7h 2c against Ks Qd, facing 50 into 100, with nine clean hearts.
 * The rule of 2 and 4 gives 9 x 4 = 36 points, carried as 0.36. The exact two-card chance is
 * 1 - (38/47) x (37/46) = 34.967622571693%, so the shortcut overstates by 1.032377428307 points.
 */
const NINE_OUT_DRAW: CoachReport = {
  street: 'flop',
  potTotal: 100,
  toCall: 50,
  outs: {
    clean: 9,
    dirty: 0,
    total: 9,
    cleanCards: ['3h', '4h', '5h', '6h', '8h', 'Th', 'Jh', 'Ah', 'Qh'],
    dirtyCards: [],
    explanation: 'Nine hearts complete the flush and none of them helps the opponent.',
  },
  equity: {
    heroEquity: 0.3949,
    method: 'exact-enumeration',
    trials: 990,
    confidenceHalfWidthPoints: null,
    ruleOfThumb: {
      estimate: 0.36,
      errorPoints: 1.032377428307,
      note: '9 outs with two cards to come, times 4, is roughly 36% — the rule of 2 and 4.',
    },
    perPlayer: [
      { label: 'you', equity: 0.3949, win: 0.3949, tie: 0 },
      { label: 'top pair', equity: 0.6051, win: 0.6051, tie: 0 },
    ],
  },
  potOdds: {
    pot: 100,
    toCall: 50,
    breakEvenEquity: 1 / 3,
    oddsRatio: 2,
    equitySurplus: 0.3949 - 1 / 3,
    explanation: 'Risking 50 to win 100 is 2 to 1, so the call breaks even at 33.3%.',
  },
  candidates: [
    { action: 'fold', cost: 0, ev: 0, derivation: 'EV(fold) = 0 chips.' },
    {
      action: 'call',
      to: 50,
      cost: 50,
      ev: 9.235,
      derivation: 'EV(call) = equity x (pot + toCall) - toCall.',
      potShareIfCalled: 0.3949,
    },
    {
      action: 'raise',
      to: 200,
      cost: 200,
      ev: 12.5,
      derivation: 'EV(raise) charges the call inside it.',
      foldEquityAssumed: 0.35,
      potShareIfCalled: 0.3949,
    },
  ],
  suggestion: {
    action: 'call',
    sizeRange: { min: 50, max: 50 },
    confidence: 'moderate',
    reason: 'call has the highest expected value against the stated range.',
    whatWouldChangeIt: ['A narrower, stronger range does the opposite.'],
  },
  stackContext: {
    effectiveStack: 400,
    spr: 4,
    potOddsOfferedByPotSizedBet: 1 / 3,
    explanation: 'The effective stack is 400 against a pot of 100.',
  },
  assumptions: ['Every hand in the opponent range is weighted equally.'],
  uncertainty: {
    method: 'exact-enumeration',
    summary: 'Computed exactly by enumerating every remaining board. There is no sampling error.',
    confidenceInterval: null,
    limitations: ['No implied odds, reverse implied odds or future-street play are modelled.'],
  },
  teachingNotes: ['The rule of 2 and 4 gives 36% on your 9 cards of clean outs.'],
};

/** A free continuation, no shortcut published, and a sampled figure with its interval. */
const CHECKED_TO: CoachReport = {
  ...NINE_OUT_DRAW,
  toCall: 0,
  outs: null,
  equity: {
    ...NINE_OUT_DRAW.equity,
    heroEquity: 0.9871,
    method: 'monte-carlo',
    trials: 40_000,
    confidenceHalfWidthPoints: 0.35,
    ruleOfThumb: null,
    perPlayer: [
      { label: 'you', equity: 0.9871, win: 0.9871, tie: 0 },
      { label: 'the opponent', equity: 0.0129, win: 0.0129, tie: 0 },
    ],
  },
  potOdds: {
    pot: 100,
    toCall: 0,
    breakEvenEquity: 0,
    oddsRatio: null,
    equitySurplus: 0.9871,
    explanation: 'Checking is free. There is nothing to call, so there is no price.',
  },
  candidates: [
    { action: 'check', cost: 0, ev: 98.71, derivation: 'EV(check) = equity x pot.' },
    { action: 'fold', cost: 0, ev: 0, derivation: 'EV(fold) = 0 chips.' },
  ],
  suggestion: {
    action: 'check',
    confidence: 'reasonable',
    reason: 'check has the highest expected value against the stated range.',
    whatWouldChangeIt: ['Nothing about the range can make folding better than a free check.'],
  },
  uncertainty: {
    method: 'monte-carlo',
    summary: 'Estimated by sampling 40,000 run-outs.',
    confidenceInterval: { level: 0.95, halfWidthPoints: 0.35 },
    limitations: ['Equity was estimated from sampled run-outs, not enumerated exhaustively.'],
  },
  teachingNotes: ['No rule-of-2-and-4 figure here: there is nothing to draw to.'],
};

/** `estimate: 36` is the rule of 2 and 4 in percentage points, on a field the panel reads as a fraction. */
const WRONG_UNIT: CoachReport = {
  ...NINE_OUT_DRAW,
  equity: {
    ...NINE_OUT_DRAW.equity,
    ruleOfThumb: { estimate: 36, errorPoints: 1.032377428307, note: 'the old percentage-point unit' },
  },
};

/** `estimate: 1.6`, found in a shipped fixture. "160.0%" is close enough to real to be believed. */
const STALE_FIXTURE: CoachReport = {
  ...NINE_OUT_DRAW,
  equity: {
    ...NINE_OUT_DRAW.equity,
    ruleOfThumb: { estimate: 1.6, errorPoints: 1.032377428307, note: 'a stale fixture value' },
  },
};

/**
 * Hero already in front (two pair, 88.2% on the flop), so all 47 unseen cards clear the outs bar.
 * The `explanation` is deliberately the old prose ("47 outs in total"), because a report can reach
 * the panel from a stale cache or file. The panel must refuse on the equity, not on the prose.
 */
const ALREADY_AHEAD: CoachReport = {
  ...NINE_OUT_DRAW,
  outs: {
    clean: 10,
    dirty: 37,
    total: 47,
    cleanCards: ['2d', '2h', '2s', '5c', '5h', 'Ad', 'As', '3c', '3d', '3h'],
    dirtyCards: ['4c', '4d', '4h', '4s', '6c', '6d', '6h', '6s', '7c', '7d'],
    explanation:
      'On Ah 5s 2c you hold Ac 5d — two pair, aces and fives — for 88% equity against a wide range. ' +
      'Of the 47 cards that can come next, 10 are clean and 37 are dirty, which is 47 outs in total.',
  },
  equity: {
    ...NINE_OUT_DRAW.equity,
    heroEquity: 0.882,
    // The Coach withholds the rule of 2 and 4 on a made hand.
    ruleOfThumb: null,
    perPlayer: [
      { label: 'you', equity: 0.882, win: 0.882, tie: 0 },
      { label: 'a wide range', equity: 0.118, win: 0.118, tie: 0 },
    ],
  },
  potOdds: { ...NINE_OUT_DRAW.potOdds, equitySurplus: 0.882 - 1 / 3 },
};

/**
 * Every figure the panel renders as a percentage, out of range at once, each in the way its type allows.
 * Prose fields stay clean, because free text is rendered verbatim and cannot be range-checked
 * (`CoachPanel` rule 5).
 */
const EVERY_FIGURE_IMPOSSIBLE: CoachReport = {
  ...NINE_OUT_DRAW,
  equity: {
    heroEquity: 1.6,
    method: 'monte-carlo',
    trials: 40_000,
    confidenceHalfWidthPoints: 5000,
    ruleOfThumb: { estimate: 1.6, errorPoints: 1.032377428307, note: 'a stale fixture value' },
    perPlayer: [
      { label: 'you', equity: 1.6, win: 1.6, tie: 0 },
      { label: 'top pair', equity: Number.NaN, win: 0, tie: 0 },
    ],
  },
  potOdds: {
    pot: 100,
    toCall: 50,
    breakEvenEquity: 2.4,
    oddsRatio: 2,
    equitySurplus: -3.2,
    explanation: 'Risking 50 to win 100 is 2 to 1.',
  },
  candidates: [
    { action: 'fold', cost: 0, ev: 0, derivation: 'EV(fold) = 0 chips.' },
    {
      action: 'call',
      to: 50,
      cost: 50,
      ev: 9.235,
      derivation: 'EV(call) = equity x (pot + toCall) - toCall.',
      foldEquityAssumed: 3,
      potShareIfCalled: 9,
    },
  ],
  stackContext: {
    effectiveStack: 400,
    spr: 4,
    potOddsOfferedByPotSizedBet: 4,
    explanation: 'The effective stack is 400 against a pot of 100.',
  },
  uncertainty: {
    method: 'monte-carlo',
    summary: 'Estimated by sampling 40,000 run-outs.',
    confidenceInterval: { level: 1.6, halfWidthPoints: 5000 },
    limitations: ['Equity was estimated from sampled run-outs, not enumerated exhaustively.'],
  },
  teachingNotes: ['A fixture built to be impossible.'],
};

test('the percentage scan has teeth', () => {
  // Calibrated against markup, because the panel can no longer produce the defect.
  const impossible = impossiblePercentagesIn(
    '<p>the rule of 2 and 4 estimates 3,600.0%</p><span aria-label="160.0%"></span><i>-50.0%</i>',
  );
  assert.deepEqual(impossible, ['3,600.0%', '160.0%', '-50.0%']);

  assert.deepEqual(impossiblePercentagesIn('<p>0.0% to 100.0%, and 41.2%</p>'), []);
});

test('no percentage the panel renders is above 100% or below 0%', async () => {
  for (const [label, report] of [
    ['a nine-out draw facing a bet', NINE_OUT_DRAW],
    ['a free continuation with a sampled figure', CHECKED_TO],
  ] as const) {
    const markup = await render(report);
    const percentages = percentagesIn(markup);
    assert.ok(percentages.length >= 5, `${label}: found only ${percentages.length} percentages to check`);

    const impossible = impossiblePercentagesIn(markup);
    assert.deepEqual(
      impossible,
      [],
      `${label}: the panel rendered ${impossible.length} percentage(s) that cannot be probabilities`,
    );
  }
});

test('the panel refuses the percentage-point unit error rather than rendering it', async () => {
  const markup = await render(WRONG_UNIT);

  assert.deepEqual(impossiblePercentagesIn(markup), [], 'no impossible percentage may reach the page');
  assert.ok(!markup.includes('3,600'), 'the percentage-point unit must never reach the page');
  assert.ok(
    markup.includes('The rule-of-thumb comparison is being withheld for this spot'),
    'and the panel has to say that it withheld the figure, not leave a silent gap',
  );
});

test('a hand already in front is not given an outs count', async () => {
  // Rule 6. The report says 47, and the panel must not put 47 next to the word "outs" anywhere.
  const markup = await render(ALREADY_AHEAD);

  assert.ok(
    !markup.includes('Outs — 47 cards in total'),
    'the section title must not publish every unseen card as an outs count',
  );
  assert.ok(
    !markup.includes('Outs, card by card (47 cards)'),
    'nor may the collapsed breakdown, which is the other place the two words meet a number',
  );
  assert.ok(
    markup.includes('Outs — no outs count for this spot'),
    'the section still has to be there, still labelled, and still say what is missing',
  );

  // The counts are true and stay, with the card-by-card list.
  assert.ok(markup.includes('10 cards'), 'the clean count survives the refusal');
  assert.ok(markup.includes('37 cards'), 'and so does the dirty count');
  assert.ok(
    markup.includes('Every card that can come, one by one (47 cards)'),
    'the breakdown is still reachable, under a name that describes what is in it',
  );

  // The "dirty" bucket's stock sentence is false here, because a blank does not improve two pair.
  assert.ok(
    !markup.includes('These improve your hand but can still lose'),
    'a card that leaves hero in front has not necessarily improved anything',
  );
  assert.ok(
    markup.includes('These leave you in front but not safe'),
    'the bucket still has to say what it means, in words that are true of this spot',
  );

  assert.ok(
    markup.includes('An out is a card that rescues a hand that is behind, and you are not behind'),
    'the refusal has to carry its reason, exactly as the rule-of-thumb refusal does',
  );
});

test('a real draw keeps its outs count', async () => {
  // The control. A nine-out flush draw at 39.5% is behind, so the count must stay.
  const markup = await render(NINE_OUT_DRAW);

  assert.ok(markup.includes('Outs — 9 cards in total'), 'a hand that is behind keeps its count');
  assert.ok(markup.includes('Outs, card by card (9 cards)'), 'and its breakdown keeps the word');
  assert.ok(
    !markup.includes('no outs count for this spot'),
    'the refusal must not fire on a spot that has a perfectly good count',
  );
  assert.ok(
    markup.includes('These improve your hand but can still lose'),
    'and the dirty bucket keeps the sentence that is true of a draw',
  );
});

test('the panel refuses the stale fixture value the audit found', async () => {
  const markup = await render(STALE_FIXTURE);

  assert.deepEqual(impossiblePercentagesIn(markup), [], 'no impossible percentage may reach the page');
  assert.ok(!markup.includes('160.0'), 'the impossible figure must not survive anywhere in the markup');
  assert.ok(
    !markup.includes('The rule of 2 and 4 estimates'),
    'the claim itself must be withdrawn, not merely reworded around a bad number',
  );
  assert.ok(
    markup.includes('it is not a probability'),
    'and the reason has to be stated in the panel, in the same voice as everything else',
  );
});

test('no figure the panel renders as a percentage can be impossible, whatever it is fed', async () => {
  const markup = await render(EVERY_FIGURE_IMPOSSIBLE);

  const impossible = impossiblePercentagesIn(markup);
  assert.deepEqual(
    impossible,
    [],
    `every percentage-bearing field was out of range and the panel rendered ${impossible.length} of them: ${JSON.stringify(impossible)}`,
  );

  // Withheld sections stay labelled, because an absent tile reads as a figure the app never computes.
  for (const label of ['Your share of the pot', 'Break-even equity', 'Price a pot-sized bet would offer']) {
    assert.ok(markup.includes(label), `the "${label}" figure should still be labelled`);
  }
  assert.equal(
    markup.split('not a probability').length - 1,
    // 3 stat tiles, 2 `EquityBar` rows, 1 `EquityBar` detail (the 0 tie rate is real),
    // 2 EV-table assumptions and the rule-of-2-and-4 refusal.
    9,
    'every refused figure should say so, and the count is fixed so a lost refusal is visible',
  );

  assert.ok(markup.includes('Every hand in the opponent range is weighted equally.'), 'assumptions survive');
  assert.ok(markup.includes('How certain is this?'), 'the uncertainty note survives');
  assert.ok(
    markup.includes('its confidence level or its width is not a possible one'),
    'and the refused interval explains itself rather than claiming there was no sampling error',
  );
});

test('the rule-of-2-and-4 figure for a real draw renders as 36.0%', async () => {
  const markup = await render(NINE_OUT_DRAW);

  assert.ok(markup.includes('The rule of 2 and 4 estimates 36.0%'), 'the shortcut is stated as 36.0%');
  assert.ok(!markup.includes('3,600'), 'the percentage-point unit must never reach the page');
  assert.ok(!markup.includes('0.4%'), 'nor the fraction rendered as though it were already a percentage');

  // The error is in points, so it is not multiplied. `formatPoints` pluralises from the rounded figure.
  assert.ok(markup.includes('off by 1.0 point'), 'the error is a difference in points, not a percentage');
  assert.ok(!markup.includes('103.2'), 'the error must not be multiplied by 100 either');
});

test('a withheld shortcut is explained rather than silently dropped', async () => {
  // The Coach refuses the shortcut on a made hand, a draw with no clean outs, or a multiple over 100.
  const markup = await render(CHECKED_TO);
  assert.ok(
    markup.includes('No rule-of-thumb comparison for this spot'),
    'the panel should say the shortcut was withheld',
  );
  assert.ok(markup.includes('clean outs'), 'and say what the shortcut needs in order to apply');
});

test('the reading of the spot comes after the price and before the detail', async () => {
  // At a live table the Coach is a scroll pane, so the suggestion must not sit screens down the rail.
  // Equity and the price stay first, because the reading follows from them.
  const markup = await render(NINE_OUT_DRAW);
  const at = (text: string): number => {
    const index = markup.indexOf(text);
    assert.ok(index !== -1, `"${text}" is rendered`);
    return index;
  };
  const reading = at('One reading of this spot');
  assert.ok(at('>Equity<') < reading, 'the equity figure is read before the suggestion');
  assert.ok(at('>The price<') < reading, 'and so is the price');
  assert.ok(reading < at('Outs — 9 cards in total'), 'the suggestion is read before the outs detail');
  assert.ok(reading < at('>Stack context<'), 'and before the stack context');
  assert.ok(
    at('not a claim about the best play') < at('Outs — 9 cards in total'),
    'its disclaimer travels with it, never left behind at the bottom',
  );
});

test('explanatory prose under outs and stack is behind a disclosure, and the figures are not', async () => {
  const markup = await render(NINE_OUT_DRAW);
  const inDisclosure = (text: string): boolean => {
    const at = markup.indexOf(text);
    if (at === -1) return false;
    const open = markup.lastIndexOf('<details', at);
    return open !== -1 && markup.lastIndexOf('</details>', at) < open;
  };

  assert.ok(inDisclosure('Nine hearts complete the flush'), 'the outs prose is collapsible');
  assert.ok(inDisclosure('The effective stack is 400 against a pot of 100.'), 'and so is the stack prose');

  assert.ok(!inDisclosure('Outs — 9 cards in total'), 'the outs count stays visible');
  assert.ok(!inDisclosure('Effective stack'), 'the stack figure stays visible');
  assert.ok(!inDisclosure('Risking 50 to win 100'), 'the price explanation stays visible');
  assert.ok(!inDisclosure('One reading of this spot'), 'and so does the suggestion');
});

test('a size range whose two ends are one figure prints it once', async () => {
  const single = await render({
    ...NINE_OUT_DRAW,
    suggestion: { ...NINE_OUT_DRAW.suggestion, sizeRange: { min: 50, max: 50 } },
  });
  assert.match(single, /Call — 50 units</u);
  assert.doesNotMatch(single, /50 units to 50 units/u);
  const spread = await render({
    ...NINE_OUT_DRAW,
    suggestion: { ...NINE_OUT_DRAW.suggestion, sizeRange: { min: 50, max: 80 } },
  });
  assert.match(spread, /Call — 50 units to 80 units</u);
});

test('a negative margin over break-even is said to be under it (REGRESSION)', async () => {
  // The Lab once printed "▼ −27.0 points over the break-even equity".
  const label = (markup: string): string | undefined =>
    /class="prl-metric__delta-label">([^<]*)</u.exec(markup)?.[1];
  const priced = (surplus: number): CoachReport => ({
    ...NINE_OUT_DRAW,
    potOdds: { ...NINE_OUT_DRAW.potOdds, equitySurplus: surplus },
  });
  assert.equal(label(await render(priced(-0.27))), 'under the break-even equity');
  assert.equal(label(await render(priced(0.0616))), 'over the break-even equity');
  // Rounds to 0.0 points, which the metric renders flat: neither over nor under.
  assert.equal(label(await render(priced(-0.0004))), 'at the break-even equity');
});
