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
 * markup and reads every percentage out of the result. A probability above 100% is not a
 * rounding problem to be tolerated at one decimal place, it is a claim that cannot be
 * true, and no rendering of this panel may contain one.
 *
 * ## How the component is loaded
 *
 * Node runs `.ts` by stripping types, but it cannot run `.tsx`: JSX has to be transformed,
 * not erased. Rather than give up and test a hand-copy of the panel's logic — which would
 * reproduce exactly the class of bug this file exists to catch — the package's own `tsc`
 * emits `src/` to a temporary directory and the emitted module is imported. That is the
 * real component, compiled by the same compiler and the same `tsconfig.json` the app uses.
 *
 * The temp directory gets a `node_modules` symlink to this package's own, so
 * `react/jsx-runtime` inside the emitted module resolves to the same physical files as the
 * `react` this test imports. Node realpaths symlinked packages, so both paths reach one
 * instance and there is no second copy of React.
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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CoachReport } from '@prl/contracts';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Compiling the component
// ---------------------------------------------------------------------------

type CoachPanelComponent = (props: { readonly report: CoachReport }) => ReactElement;

let compiled: CoachPanelComponent | null = null;
let workspace: string | null = null;

after(() => {
  if (workspace !== null) rmSync(workspace, { recursive: true, force: true });
});

/** The `tsc` this repo pins, found through its own package rather than by guessing a path. */
function tscEntryPoint(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

async function loadCoachPanel(): Promise<CoachPanelComponent> {
  if (compiled !== null) return compiled;

  const dir = mkdtempSync(join(tmpdir(), 'prl-coach-render-'));
  workspace = dir;
  const out = join(dir, 'out');
  const config = join(dir, 'tsconfig.json');

  // The package's own config, with emit turned on. `types` is emptied because the ambient
  // type packages are not resolvable from a directory outside the workspace; type errors
  // do not block emit, and typechecking is `pnpm run typecheck`'s job, not this file's.
  writeFileSync(
    config,
    JSON.stringify({
      extends: join(PACKAGE_ROOT, 'tsconfig.json'),
      compilerOptions: {
        noEmit: false,
        outDir: out,
        rootDir: join(PACKAGE_ROOT, 'src'),
        declaration: false,
        declarationMap: false,
        sourceMap: false,
        incremental: false,
        skipLibCheck: true,
        types: [],
      },
      include: [join(PACKAGE_ROOT, 'src', '**', '*.ts'), join(PACKAGE_ROOT, 'src', '**', '*.tsx')],
    }),
  );

  const result = spawnSync(process.execPath, [tscEntryPoint(), '-p', config], { encoding: 'utf8' });
  const entry = join(out, 'components', 'CoachPanel.js');
  assert.ok(
    existsSync(entry),
    `tsc emitted no CoachPanel.js.\nstdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}`,
  );

  // `type: module` so the emitted ESM is read as ESM, and the symlink so `react/jsx-runtime`
  // and `@prl/contracts` resolve from inside the temp tree.
  writeFileSync(join(out, 'package.json'), '{"type":"module"}');
  symlinkSync(join(PACKAGE_ROOT, 'node_modules'), join(out, 'node_modules'), 'dir');

  const module: unknown = await import(pathToFileURL(entry).href);
  const exported = (module as { CoachPanel?: unknown }).CoachPanel;
  assert.equal(typeof exported, 'function', 'the emitted module does not export CoachPanel');
  compiled = exported as CoachPanelComponent;
  return compiled;
}

async function render(report: CoachReport): Promise<string> {
  const CoachPanel = await loadCoachPanel();
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
 * of 2 and 4 in percentage POINTS, on a field the panel renders as a fraction. It is here
 * so the guard below can be shown to have teeth: a test that scans for impossible
 * percentages is worth nothing unless it is known to fail when one is present.
 */
const WRONG_UNIT: CoachReport = {
  ...NINE_OUT_DRAW,
  equity: {
    ...NINE_OUT_DRAW.equity,
    ruleOfThumb: { estimate: 36, errorPoints: 1.032377428307, note: 'the old percentage-point unit' },
  },
};

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

test('no percentage the panel renders is above 100%', async () => {
  for (const [label, report] of [
    ['a nine-out draw facing a bet', NINE_OUT_DRAW],
    ['a free continuation with a sampled figure', CHECKED_TO],
  ] as const) {
    const markup = await render(report);
    const percentages = percentagesIn(markup);
    assert.ok(percentages.length >= 5, `${label}: found only ${percentages.length} percentages to check`);

    const impossible = percentages.filter((entry) => entry.value > 100);
    assert.deepEqual(
      impossible.map((entry) => entry.text),
      [],
      `${label}: the panel rendered ${impossible.length} percentage(s) above 100%, which cannot be probabilities`,
    );
  }
});

test('the guard above would catch the unit error it was written for', async () => {
  // Not a curiosity. The scan is the whole defence, and a scan that cannot fail is not a
  // defence. `estimate: 36` is the exact value the producer used to publish for this hand.
  const markup = await render(WRONG_UNIT);
  const impossible = percentagesIn(markup).filter((entry) => entry.value > 100);
  assert.ok(
    impossible.some((entry) => entry.text === '3,600.0%'),
    `the old unit should render as "3,600.0%"; found ${JSON.stringify(impossible.map((e) => e.text))}`,
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
