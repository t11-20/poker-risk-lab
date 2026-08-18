/**
 * The Coach panel, actually rendered, read as a learner would read it.
 *
 * ## Why a rendering test and not a formatter test
 *
 * `format.test.ts` proves `formatPercent(0.36)` is `"36.0%"`. That was true throughout the
 * period in which a shipped page told a learner a nine-out flush draw was **"3,600.0%"**,
 * and elsewhere that a flopped set was **"18,000.0%"**. The formatter was never wrong. The
 * *pairing* was: `@prl/poker-math` published `ruleOfThumb.estimate` in percentage points
 * (36) while `CoachPanel` rendered it with `formatPercent`, which multiplies by 100. Two
 * correct halves, one bare `number` between them, and nothing in either package's tests
 * could see the join.
 *
 * So this file asserts on the STRING A READER SEES. It renders the whole panel to static
 * markup and reads every percentage out of the result. A probability above 100% — or below
 * 0% — is not a rounding problem to be tolerated at one decimal place, it is a claim that
 * cannot be true, and no rendering of this panel may contain one.
 *
 * ## What changed when the panel gained its own guard
 *
 * This file used to prove its scan had teeth by feeding the panel `estimate: 36` and
 * asserting the panel *rendered* "3,600.0%". That assertion was correct and it now cannot
 * hold, because the panel refuses such a value instead of formatting it (`CoachPanel` rule
 * 5, `src/probability.ts`). Both halves of the original intent are kept, and separated:
 *
 *  - **the scan can fail** — proved against markup directly, so it no longer depends on the
 *    component being capable of the defect (`the percentage scan has teeth`);
 *  - **the component refuses** — proved by feeding the real panel the real bad values and
 *    reading the result (`the panel refuses …`), which is a strictly stronger claim than
 *    the one it replaces.
 *
 * The second is the guard the audit asked for. The first is why the second is believable.
 *
 * ## The fixtures are literals, on purpose
 *
 * Nothing here calls `@prl/poker-math`. The figures are hand-derived and written out: a
 * nine-out flush draw is 9 x 4 = 36 percentage points, which is 0.36 as the fraction this
 * contract carries, and 0.36 must render as "36.0%". Asserting against a fraction the
 * producer computed would only prove the two agree, which is the thing that was already
 * true when the panel said 3,600%.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CoachReport } from '@prl/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadComponent } from './support/render-component.ts';

// ---------------------------------------------------------------------------
// Rendering the real component
// ---------------------------------------------------------------------------

async function render(report: CoachReport): Promise<string> {
  const CoachPanel = await loadComponent<{ readonly report: CoachReport }>(
    'components/CoachPanel',
    'CoachPanel',
  );
  return renderToStaticMarkup(createElement(CoachPanel, { report }));
}

// ---------------------------------------------------------------------------
// Reading percentages back out of the markup
// ---------------------------------------------------------------------------

/**
 * Every percentage in the rendered output, attributes included.
 *
 * Attributes are deliberately in scope: an `aria-label` is user-facing to exactly the
 * readers least able to notice that a figure is absurd, and a bar sized `width: 3600%`
 * would be a visible defect too.
 */
function percentagesIn(markup: string): readonly { readonly text: string; readonly value: number }[] {
  const found: { text: string; value: number }[] = [];
  for (const match of markup.matchAll(/(-?\d[\d,]*(?:\.\d+)?)\s*%/g)) {
    const text = match[1] ?? '';
    found.push({ text: `${text}%`, value: Number(text.replace(/,/g, '')) });
  }
  return found;
}

/**
 * Every percentage that cannot be a probability: above 100, or below 0.
 *
 * Both ends, because a unit error has two directions and only one of them was ever caught.
 * "3,600.0%" is the famous one; "-50.0%" is the same defect with a sign, and a scan that
 * looks only upwards would pass it.
 */
function impossiblePercentagesIn(markup: string): readonly string[] {
  return percentagesIn(markup)
    .filter((entry) => entry.value > 100 || entry.value < 0)
    .map((entry) => entry.text);
}

// ---------------------------------------------------------------------------
// Fixtures, every figure derived by hand
// ---------------------------------------------------------------------------

/**
 * A real draw: hero Th 9h on Kh 7h 2c against Ks Qd, facing 50 into 100.
 *
 *   - nine unseen hearts, every one of them clean;
 *   - the rule of 2 and 4 gives 9 x 4 = **36 percentage points**, i.e. **0.36** as the
 *     fraction this contract carries, and must render as **"36.0%"**;
 *   - the exact chance of one of the nine arriving over two cards is
 *     1 - (38/47) x (37/46) = 34.967622571693%, so the shortcut overstates by
 *     **1.032377428307 points** — rendered as "1.0 points", not as "103.2%".
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

/**
 * The defect, preserved as a fixture rather than as a memory.
 *
 * `estimate: 36` is what `@prl/poker-math` used to publish for this exact hand — the rule
 * of 2 and 4 in percentage POINTS, on a field the panel renders as a fraction. Formatted
 * without a guard it becomes "3,600.0%".
 */
const WRONG_UNIT: CoachReport = {
  ...NINE_OUT_DRAW,
  equity: {
    ...NINE_OUT_DRAW.equity,
    ruleOfThumb: { estimate: 36, errorPoints: 1.032377428307, note: 'the old percentage-point unit' },
  },
};

/**
 * The value the release audit actually found sitting in a shipped fixture: `estimate: 1.6`.
 *
 * Worth its own fixture beside `WRONG_UNIT`, because it is a *different* failure and the
 * more dangerous of the two. "3,600.0%" is so obviously broken that a reader discounts the
 * whole panel; "160.0%" is close enough to a real number to be believed by someone who is
 * here precisely because they are still learning what a probability is.
 */
const STALE_FIXTURE: CoachReport = {
  ...NINE_OUT_DRAW,
  equity: {
    ...NINE_OUT_DRAW.equity,
    ruleOfThumb: { estimate: 1.6, errorPoints: 1.032377428307, note: 'a stale fixture value' },
  },
};

/**
 * Every figure the panel renders as a percentage, out of range at once.
 *
 * Not a realistic report — deliberately. The guard is defence in depth against inputs
 * nobody has predicted, so the fixture that proves it has to be one nobody would predict.
 * Each field is broken in the way its own type allows:
 *
 *   - `heroEquity: 1.6`               a probability above 1
 *   - `perPlayer[0].equity: 1.6`      the same, in the readout under the bar
 *   - `perPlayer[0].win: 1.6`         and in its detail line
 *   - `perPlayer[1].equity: NaN`      non-finite, which `EquityBar` coerces to 0 for the geometry
 *   - `breakEvenEquity: 2.4`          the figure the call/fold decision turns on
 *   - `equitySurplus: -3.2`           a difference outside -1..1, rendered as the metric's delta
 *   - `potOddsOfferedByPotSizedBet: 4` a probability rendered inside a stat tile
 *   - `foldEquityAssumed: 3`          an assumption stated in the EV table
 *   - `potShareIfCalled: 9`           likewise
 *   - `ruleOfThumb.estimate: 1.6`     the P0
 *   - `confidenceHalfWidthPoints: 5000` an error bar wider than the range it sits on
 *   - `confidenceInterval.level: 1.6` a 160% confidence level
 *
 * The prose fields are left clean on purpose. Free text the report supplies is rendered
 * verbatim and cannot be range-checked — see `CoachPanel` rule 5 — so putting an impossible
 * percentage in an `explanation` would fail this test for a reason the guard does not claim
 * to cover, and would teach the next reader that the guard is unreliable.
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

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

test('the percentage scan has teeth', () => {
  // The scan is the instrument every assertion below depends on, so it is calibrated
  // against markup directly rather than against a component. It used to be calibrated by
  // rendering a panel known to be broken — which was honest, but tied the instrument's
  // credibility to the component staying capable of the defect. It no longer is.
  const impossible = impossiblePercentagesIn(
    '<p>the rule of 2 and 4 estimates 3,600.0%</p><span aria-label="160.0%"></span><i>-50.0%</i>',
  );
  assert.deepEqual(impossible, ['3,600.0%', '160.0%', '-50.0%']);

  // And it does not cry wolf: the two endpoints are reachable and real.
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
  // `estimate: 36` is the exact value the producer used to publish for this hand. It must
  // not reach the reader in any form: not as "3,600.0%", and not as a bare "3,600" either.
  const markup = await render(WRONG_UNIT);

  assert.deepEqual(impossiblePercentagesIn(markup), [], 'no impossible percentage may reach the page');
  assert.ok(!markup.includes('3,600'), 'the percentage-point unit must never reach the page');
  assert.ok(
    markup.includes('The rule-of-thumb comparison is being withheld for this spot'),
    'and the panel has to say that it withheld the figure, not leave a silent gap',
  );
});

test('the panel refuses the stale fixture value the audit found', async () => {
  // `estimate: 1.6` rendered as "The rule of 2 and 4 estimates 160.0%" — a 160% probability
  // stated in the app's own voice. This is the P0, asserted on the string a learner reads.
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

  // Refusing must not become a way of quietly dropping half the panel. The sections whose
  // figures were withheld still have to be present, still labelled, and still say why —
  // an absent tile reads as "this app does not compute that", which is a second untruth.
  for (const label of ['Your share of the pot', 'Break-even equity', 'Price a pot-sized bet would offer']) {
    assert.ok(markup.includes(label), `the "${label}" figure should still be labelled`);
  }
  assert.equal(
    markup.split('not a probability').length - 1,
    // Counted rather than merely "present", so a change that silently stops refusing one of
    // them fails here. Nine, made up of:
    //   3  refused stat tiles — equity, break-even, the pot-sized-bet price
    //   2  `EquityBar` readout rows — the 1.6 equity and the NaN one
    //   1  `EquityBar` detail — the 1.6 win rate (the 0 tie rate is a real 0.0%)
    //   2  EV-table assumptions — fold equity and pot share when called
    //   1  the rule-of-2-and-4 refusal
    9,
    'every refused figure should say so, and the count is fixed so a lost refusal is visible',
  );

  // The caveats are never collapsible and never droppable, however bad the figures were.
  assert.ok(markup.includes('Every hand in the opponent range is weighted equally.'), 'assumptions survive');
  assert.ok(markup.includes('How certain is this?'), 'the uncertainty note survives');
  assert.ok(
    markup.includes('its confidence level or its width is not a possible one'),
    'and the refused interval explains itself rather than claiming there was no sampling error',
  );
});

test('the rule-of-2-and-4 figure for a real draw renders as 36.0%', async () => {
  // Nine clean outs, two cards to come: 9 x 4 = 36 percentage points. The contract carries
  // that as the fraction 0.36, and the reader must see "36.0%" — not "3,600.0%" and not
  // "0.4%", the two ways a unit can be wrong.
  const markup = await render(NINE_OUT_DRAW);

  assert.ok(markup.includes('The rule of 2 and 4 estimates 36.0%'), 'the shortcut is stated as 36.0%');
  assert.ok(!markup.includes('3,600'), 'the percentage-point unit must never reach the page');
  assert.ok(!markup.includes('0.4%'), 'nor the fraction rendered as though it were already a percentage');

  // Its error is in POINTS, so it is NOT multiplied: 1.032377... rounds to "1.0 point"
  // (`formatPoints` pluralises from the rounded figure). Had it gone through
  // `formatPercent` instead it would read "103.2%", which is the same unit error in the
  // other direction and just as wrong.
  assert.ok(markup.includes('off by 1.0 point'), 'the error is a difference in points, not a percentage');
  assert.ok(!markup.includes('103.2'), 'the error must not be multiplied by 100 either');
});

test('a withheld shortcut is explained rather than silently dropped', async () => {
  // `null` is now a real answer — the Coach refuses the shortcut on a made hand, on a draw
  // with no clean outs, and where the multiple would exceed 100% — so the panel has to say
  // that rather than leave a gap a reader reads as a missing feature.
  const markup = await render(CHECKED_TO);
  assert.ok(
    markup.includes('No rule-of-thumb comparison for this spot'),
    'the panel should say the shortcut was withheld',
  );
  assert.ok(markup.includes('clean outs'), 'and say what the shortcut needs in order to apply');
});
