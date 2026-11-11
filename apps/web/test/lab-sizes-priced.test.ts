/**
 * Every size the Lab's decision bar offers without typing is a size the analysis priced.
 *
 * ## The failure this is written against
 *
 * The `ActionBar` offers a default (the minimum raise, which is what an untouched sizer sends) and
 * ⅓, ½, ⅔, pot and all-in presets. The Coach used to price three rungs of its own ladder — the
 * smallest ladder rung at or above the floor, a middle one and the shove, each rounded down — and
 * `judgeConsistency` grades a sized action only on an exact match. Measured over the bundle at
 * commit 308fadf: the default was unpriced in 23 of the 31 scenarios with a bet or raise, the ⅔-pot
 * preset on `eq-second-pair-vs-wide-range` was 207 against a priced 206, and the best row on
 * `eq-flush-draw-turn-small-bet` ("Raise to 67") was reachable by no preset at all. A learner who
 * pressed a button the product offered was told "this analysis did not price that size".
 *
 * ## What is built, and from where
 *
 * The bar's side comes from `scenarioToPlayerView` — the function that fills the real bar — fed
 * through `offeredSizes`, which is the list `ActionBar` renders (`packages/ui/test` pins that the
 * bar's presets and arithmetic ARE these). The Coach's side is a real `buildCoachReport`, with the
 * input `coachTaskFor` in `apps/api/src/routes/content.ts` builds. Sampling is cut to 2,000 because
 * no size depends on equity: a size is arithmetic on the pot, the price and the bounds.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { content } from '@prl/content';
import type { CoachReport } from '@prl/contracts';
import {
  buildCoachReport,
  maximumTo,
  minimumAggressiveTo,
  offeredSizes,
  pricedSizesFor,
} from '@prl/poker-math';
import { scenarioToPlayerView } from '../src/lib/scenario-view.ts';
import { coachInputFor } from './lab-coach-input.ts';

const AGGRESSIVE = new Set(['bet', 'raise']);

interface Sweep {
  readonly withAggression: number;
  readonly unpriced: readonly string[];
  readonly disagreements: readonly string[];
}

let memo: Sweep | null = null;

function sweep(): Sweep {
  if (memo !== null) return memo;
  const scenarios = content().scenarios;
  assert.ok(scenarios.length >= 36, `only ${scenarios.length} scenario(s); a sweep of nothing is not a pass`);
  let withAggression = 0;
  const unpriced: string[] = [];
  const disagreements: string[] = [];
  for (const scenario of scenarios) {
    const table = scenarioToPlayerView(scenario);
    assert.ok(table !== null, `${scenario.id} did not project into a table`);
    const sized = table.legalActions.find((action) => AGGRESSIVE.has(action.type));
    if (sized === undefined || sized.minTo === undefined || sized.maxTo === undefined) continue;
    withAggression += 1;

    const hero = table.view.seats.find((seat) => seat.isSelf);
    const input = coachInputFor(scenario);
    // The two sides must be sizing the same spot, or agreement below would be a coincidence. Each
    // of these is a figure one side reads and the other derives separately.
    const facts: [string, number, number][] = [
      ['pot', table.view.potTotal, input.pot],
      // The Coach prices against the pot hero can win; the bar sizes against the whole middle. They
      // are equal wherever a raise is on offer — hero has to cover the bet to raise past it, which
      // leaves nothing above hero's reach — and this says so rather than assuming it.
      ['contestable pot', table.view.potTotal, input.contestablePot],
      ['to call', table.view.amountToCall, input.toCall],
      ['committed this street', hero?.committedThisStreet ?? -1, input.heroCommittedThisStreet],
      ['floor', sized.minTo, minimumAggressiveTo(input)],
      ['ceiling', sized.maxTo, maximumTo(input)],
    ];
    for (const [what, bar, coach] of facts) {
      if (bar !== coach)
        disagreements.push(`${scenario.id}: ${what} — the bar reads ${bar}, the Coach ${coach}`);
    }

    const report: CoachReport = buildCoachReport(input);
    const priced = new Set(pricedSizesFor(report, sized.type));
    const offered = offeredSizes({
      bounds: { min: sized.minTo, max: sized.maxTo },
      pot: table.view.potTotal,
      toCall: table.view.amountToCall,
      committedThisStreet: hero?.committedThisStreet ?? 0,
    });
    for (const size of offered) {
      if (!priced.has(size.to)) {
        unpriced.push(
          `${scenario.id}: ${size.id} offers ${sized.type} to ${size.to}; priced [${[...priced].join(', ')}]`,
        );
      }
    }
  }
  memo = { withAggression, unpriced, disagreements };
  return memo;
}

describe('the Lab offers only sizes the analysis priced', () => {
  it('reaches the scenarios that offer a bet or a raise', () => {
    // 31 of 36 at the time of writing; the other five face an all-in and offer fold and call only.
    assert.ok(sweep().withAggression >= 30, `only ${sweep().withAggression} scenario(s) offer aggression`);
  });

  it('sizes the same spot on both sides', () => {
    assert.deepEqual(sweep().disagreements, [], sweep().disagreements.join('\n'));
  });

  it('prices the default and every preset, in all 36 scenarios (REGRESSION)', () => {
    assert.deepEqual(
      sweep().unpriced,
      [],
      `${sweep().unpriced.length} unpriced:\n${sweep().unpriced.join('\n')}`,
    );
  });
});
