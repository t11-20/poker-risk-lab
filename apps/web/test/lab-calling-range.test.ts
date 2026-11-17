/**
 * The Lab's readings once a bet or raise is priced against the hands that continue against its size.
 * Driven with the reports the API builds, at its sample count and seed. A scenario that says the
 * whole range continues is the pricing from before, so building each report both ways is the
 * before-and-after pair.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { content, SCENARIO_ANALYSIS_SAMPLES, SCENARIO_ANALYSIS_SEED } from '@prl/content';
import { buildCoachReport, type CoachInput } from '@prl/poker-math';
import { coachInputFor } from './lab-coach-input.ts';

const SAMPLING = { samples: SCENARIO_ANALYSIS_SAMPLES, seed: SCENARIO_ANALYSIS_SEED };
const inputs = content().scenarios.map((scenario) => [scenario, coachInputFor(scenario, SAMPLING)] as const);
const inputOf = (id: string): CoachInput => {
  const found = inputs.find(([scenario]) => scenario.id === id);
  assert.ok(found !== undefined, `${id} is no longer in the bundle`);
  return found[1];
};
const isPassive = (action: string) => action === 'check' || action === 'call' || action === 'fold';

describe('the Lab reads a bet or raise against what continues', () => {
  it('two scenarios whose reasoning says call read call (REGRESSION)', () => {
    for (const id of ['rk-high-spr-same-top-pair', 'eq-second-pair-vs-wide-range']) {
      const { suggestion } = buildCoachReport(inputOf(id));
      assert.equal(suggestion.action, 'call', id);
      const margin = /by (-?[\d.]+) units over raising to /u.exec(suggestion.reason)?.[1];
      assert.ok(
        Number(margin) > 0,
        `${id}: the margin over the raise it set aside, in "${suggestion.reason}"`,
      );
    }
  });

  it('a raise that still qualifies keeps only the sizes ahead of what calls them', () => {
    assert.deepEqual(buildCoachReport(inputOf('rk-low-spr-commit-top-pair')).suggestion.sizeRange, {
      min: 350,
      max: 350,
    });
    // 50 and 78 are behind calling against the hands that continue. 105 is within a big blind of 185.
    assert.deepEqual(buildCoachReport(inputOf('rk-raise-size-sets-up-the-turn')).suggestion.sizeRange, {
      min: 105,
      max: 185,
    });
  });

  it('never turns a check, call or fold reading into a bet or raise', () => {
    assert.equal(inputs.length, 36, 'the bundle is 36 scenarios');
    const changed: string[] = [];
    for (const [scenario, input] of inputs) {
      const before = buildCoachReport({ ...input, wholeRangeContinues: true }).suggestion;
      const after = buildCoachReport(input).suggestion;
      if (isPassive(before.action)) {
        assert.equal(after.action, before.action, `${scenario.id} read ${before.action} before`);
      }
      const sizes = (range: typeof after.sizeRange) => `${range?.min}-${range?.max}`;
      if (before.action !== after.action || sizes(before.sizeRange) !== sizes(after.sizeRange)) {
        changed.push(scenario.id);
      }
    }
    assert.deepEqual(changed, [
      'eq-second-pair-vs-wide-range',
      'rk-low-spr-commit-top-pair',
      'rk-high-spr-same-top-pair',
      'rk-raise-size-sets-up-the-turn',
      'rk-counting-the-combos-that-beat-you',
    ]);
  });

  it('a scenario that says the opponent does not fold keeps one fold rate for every size', () => {
    const declared = inputs.filter(([scenario]) => scenario.wholeRangeContinues === true);
    assert.deepEqual(
      declared.map(([scenario]) => scenario.id),
      [
        'fl-big-blind-option-limped-pot',
        'fl-flush-draw-counting-outs',
        'fl-open-ended-straight-draw-outs',
        'fl-gutshot-facing-turn-bet',
        'fl-overcards-dirty-outs',
        'fl-combo-draw-already-ahead',
      ],
    );
    for (const [scenario, input] of declared) {
      const rates = buildCoachReport(input).candidates.flatMap((row) => row.foldEquityAssumed ?? []);
      assert.ok(rates.length > 0, `${scenario.id}: no bet or raise row; a sweep of nothing`);
      assert.deepEqual([...new Set(rates)], [0.35], scenario.id);
    }
  });
});
