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

  it('says what a size assumes of the hands that call it, in the report’s own figures', () => {
    const whole = (share: number | undefined) => `${((share ?? Number.NaN) * 100).toFixed(0)}%`;
    const raise = buildCoachReport(inputOf('rk-raise-size-sets-up-the-turn'));
    // The reading names the highest of the sizes it keeps, 105 to 185.
    const read = raise.candidates.find((row) => row.action === 'raise' && row.to === 185);
    assert.ok(read !== undefined && (read.continuingShare ?? 1) < 1, 'the premise: 185 is priced narrowed');
    assert.match(
      raise.suggestion.reason,
      new RegExp(
        `Called only by the strongest ${whole(read.continuingShare)} of the range, raising to 185 is still worth \\d+\\.\\d units more than calling\\.`,
      ),
    );
    assert.match(
      raise.suggestion.whatWouldChangeIt[0] ?? '',
      new RegExp(
        `^This assumes a raise to 185 is called by the strongest ${whole(read.continuingShare)} of the stated range as the board stands and the rest fold\\. If the whole range called, it would be worth -?\\d+\\.\\d units instead of ${read.ev.toFixed(1)}\\.$`,
      ),
    );
    // A reading every hand calls keeps the sentence it had.
    assert.ok(
      buildCoachReport(inputOf('rk-low-spr-commit-top-pair')).suggestion.whatWouldChangeIt.includes(
        'This assumes the line is called every time. An opponent who sometimes folds makes it better.',
      ),
    );
    for (const [id, set, reading] of [
      ['rk-counting-the-combos-that-beat-you', 560, 'calling'],
      ['rk-a-right-call-that-usually-loses', 125, 'calling'],
      ['eq-implied-odds-deep-stacks-turn', 240, 'folding'],
    ] as const) {
      const report = buildCoachReport(inputOf(id));
      const row = report.candidates.find((c) => c.action === 'raise' && c.to === set);
      assert.ok(row?.continuingShare !== undefined, `${id}: the premise: ${set} is priced narrowed`);
      const worth =
        reading === 'folding'
          ? 'it loses \\d+\\.\\d units, where folding loses nothing'
          : `it is worth -?\\d+\\.\\d units, behind calling's \\d+\\.\\d`;
      assert.match(
        report.suggestion.reason,
        new RegExp(
          `Raising to ${set} shows a higher figure only because it assumes they fold \\d+% of the time, which nothing here measures\\. Called only by the strongest ${whole(row.continuingShare)} of the range, ${worth}\\.$`,
        ),
        id,
      );
    }
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
