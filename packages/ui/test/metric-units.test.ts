/**
 * `Metric`'s unit word, which is a separate element from the figure — and used to disagree with it.
 *
 * ## The two defects
 *
 * Rule 3 in `Metric.tsx` puts the unit in its own element so it can sit at label size and never be
 * mistaken for a digit. The cost of that is that the unit does not go through `formatUnits`, the
 * formatter that owns the word — and the component's fallback was a constant per format:
 *
 *     units:  'units'      →   a figure of 1 rendered "1 units"
 *     points: 'points'     →   a figure of 1 rendered "1 points"
 *
 * `formatUnits(1)` has said "1 unit" all along, so the two disagreed wherever both appear.
 *
 * The second: the unit was suppressed for a figure that is not a quantity only in the `percent`
 * branch. `formatChips` renders a non-finite value as the em dash `NOT_AVAILABLE` — so a `units`
 * or `points` metric with nothing to show rendered **"— units"**, which reads as a quantity of
 * nothing rather than as nothing.
 *
 * Both are reachable in ordinary use: `/record` renders `unitsNetLifetime` as `format="units"`,
 * and it is one whenever a learner is a single unit up or down over their whole history.
 *
 * ## Rendered rather than read
 *
 * The join between the figure and the word beside it is the thing being asserted, so nothing short
 * of the real component rendering real markup would show it — which is the argument
 * `action-bar-render.test.ts` makes at length about the same trap.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadComponent } from './support/render-component.ts';

interface MetricProps {
  readonly label: string;
  readonly value: number;
  readonly format?: 'number' | 'percent' | 'units' | 'points' | 'odds';
  readonly decimals?: number;
  readonly unit?: string | null;
  readonly countUp?: boolean;
}

async function render(props: MetricProps): Promise<string> {
  const Metric = await loadComponent<MetricProps>('components/Metric', 'Metric');
  return renderToStaticMarkup(createElement(Metric, props));
}

/** The figure and its unit, as one string — which is what a reader sees, and what is asserted. */
function figureAndUnit(markup: string): string {
  const value = /<span class="prl-metric__value">([^<]*)<\/span>/u.exec(markup);
  assert.ok(value !== null, `no value in the rendered metric:\n${markup}`);
  const unit = /<span class="prl-metric__unit prl-label">([^<]*)<\/span>/u.exec(markup);
  return unit === null ? (value[1] ?? '') : `${value[1] ?? ''} ${unit[1] ?? ''}`;
}

/**
 * The same two properties on the COUNTING figure, which nothing rendered.
 *
 * `Metric` has two figure components with independent unit logic — `StaticFigure` and
 * `CountedFigure` — and every case above renders with `countUp` unset, so all of them exercise
 * `StaticFigure`. `figureAndUnit` above cannot even see the other one: it matches
 * `class="prl-metric__value"` exactly and `CountedFigure` emits `prl-metric__value prl-count`.
 *
 * That is not a spare branch. `countUp` is what `HandReplay.tsx` (three metrics), `MetricsBand`,
 * `PotDisplay` and `CoachPanel` (two) pass, so the counting figure is the pot, the reader's stack
 * and the Coach's headline numbers — and it is also the only one that feeds a live region, so a
 * wrong word there is a wrong word spoken aloud rather than merely printed.
 *
 * Measured: with `CountedFigure`'s `unitFor(props, real)` replaced by the constant-per-format
 * fallback this file exists to have removed, `packages/ui` passed 297 of 297 and `apps/web` 425
 * of 425. Both original defects — "1 units" on a pot of one, and "— units" for an absent figure —
 * came straight back on the counting path, and into the live region with them.
 */
describe('the counting figure says the same word as the static one', () => {
  /** The unit aside and the live region, which are what the counting figure actually publishes. */
  function counted(markup: string): { readonly unit: string | null; readonly spoken: string } {
    const value = /<span class="prl-metric__value prl-count"[^>]*>([^<]*)<\/span>/u.exec(markup);
    assert.ok(value !== null, `no counting figure in the rendered metric:\n${markup}`);
    const unit = /<span class="prl-metric__unit prl-label"[^>]*>([^<]*)<\/span>/u.exec(markup);
    const live = /aria-live="polite"[^>]*>([^<]*)<\/span>/u.exec(markup);
    assert.ok(live !== null, `the counting figure published no live region:\n${markup}`);
    return { unit: unit === null ? null : (unit[1] ?? ''), spoken: live[1] ?? '' };
  }

  it('singularises a figure of one, in the aside and in the live region', async () => {
    const one = counted(await render({ label: 'Net', value: 1, format: 'units', countUp: true }));
    assert.equal(one.unit, 'unit', '"1 units" is the defect this file was written for');
    assert.equal(one.spoken, 'Net: 1 unit', 'the live region spoke a word the figure disagrees with');

    const points = counted(await render({ label: 'Edge', value: 1, format: 'points', countUp: true }));
    assert.equal(points.unit, 'point');
    assert.equal(points.spoken, 'Edge: 1.0 point');
  });

  it('keeps the plural everywhere else, so the check is not just "always singular"', async () => {
    // The positive control. A counting figure that dropped the "s" unconditionally would satisfy
    // every assertion above and would be wrong on every pot in the product.
    const many = counted(await render({ label: 'Pot', value: 240, format: 'units', countUp: true }));
    assert.equal(many.unit, 'units');
    assert.equal(many.spoken, 'Pot: 240 units');
  });

  it('carries no unit on an absent figure, and does not speak one either', async () => {
    const markup = await render({ label: 'Net', value: Number.NaN, format: 'units', countUp: true });
    assert.doesNotMatch(
      markup,
      /class="prl-metric__unit/u,
      '"— units" reads as a quantity of nothing rather than as nothing',
    );
    assert.equal(counted(markup).spoken, 'Net: —', 'a screen reader was told "dash units"');
  });
});

describe('the unit word agrees with the figure beside it', () => {
  it('singularises a figure of one', async () => {
    assert.equal(figureAndUnit(await render({ label: 'Net', value: 1, format: 'units' })), '1 unit');
    assert.equal(figureAndUnit(await render({ label: 'Net', value: -1, format: 'units' })), '-1 unit');
    assert.equal(figureAndUnit(await render({ label: 'Edge', value: 1, format: 'points' })), '1.0 point');
  });

  it('keeps the plural everywhere else, including zero', async () => {
    assert.equal(figureAndUnit(await render({ label: 'Net', value: 0, format: 'units' })), '0 units');
    assert.equal(figureAndUnit(await render({ label: 'Net', value: 2, format: 'units' })), '2 units');
    assert.equal(
      figureAndUnit(await render({ label: 'Net', value: 1200, format: 'units' })),
      '1,200 units',
      'the grouped body must still be read as a number when deciding the word',
    );
    assert.equal(figureAndUnit(await render({ label: 'Edge', value: 7.9, format: 'points' })), '7.9 points');
  });

  it('agrees with formatUnits, which is the formatter that owns the word', async () => {
    // `formatUnits` decides on the numeric value of the RENDERED body, so 1.0 at one decimal is
    // still "unit". Restated here as the pairing rather than trusted, because the whole defect was
    // two pieces of code holding different opinions about one word.
    assert.equal(
      figureAndUnit(await render({ label: 'Net', value: 1, format: 'units', decimals: 1 })),
      '1.0 unit',
    );
  });

  it('leaves a unit the caller passed exactly as the caller wrote it', async () => {
    // `unit="of 1"` is used on the trait metrics in the post-hand comparison. Conjugating somebody
    // else's string would be a different bug in the same place.
    assert.equal(figureAndUnit(await render({ label: 'Aggression', value: 1, unit: 'of 1' })), '1 of 1');
    assert.equal(
      figureAndUnit(await render({ label: 'Net', value: 1, format: 'units', unit: 'units' })),
      '1 units',
    );
    assert.equal(figureAndUnit(await render({ label: 'Hands', value: 1, unit: null })), '1');
  });
});

describe('an absent figure carries no unit, because it is not a quantity', () => {
  it('renders a bare dash for units and points', async () => {
    for (const format of ['units', 'points'] as const) {
      const markup = await render({ label: 'Net', value: Number.NaN, format });
      assert.equal(figureAndUnit(markup), '—', `${format}: the dash was given a unit`);
      assert.doesNotMatch(
        markup,
        /class="prl-metric__unit/u,
        `${format}: "— ${format}" reads as a quantity of nothing rather than as nothing`,
      );
    }
  });

  it('does the same for the infinities, which are absences too', async () => {
    assert.equal(
      figureAndUnit(await render({ label: 'Net', value: Number.POSITIVE_INFINITY, format: 'units' })),
      '—',
    );
  });

  it('still refuses a unit on a refused probability', async () => {
    // The one case that was already handled. Kept here so a rewrite of `unitFor` cannot lose it.
    const markup = await render({ label: 'Equity', value: 1.6, format: 'percent' });
    assert.match(markup, /not a probability/u);
    assert.doesNotMatch(markup, /class="prl-metric__unit/u);
  });

  it('NEGATIVE CONTROL: the detectors do fire on a figure that HAS a unit', async () => {
    // Without this, a `prl-metric__unit` class that had been renamed would make every
    // `doesNotMatch` above pass over markup nobody was reading.
    const present = await render({ label: 'Net', value: 12, format: 'units' });
    assert.match(present, /class="prl-metric__unit prl-label">units<\/span>/u);
    assert.equal(figureAndUnit(present), '12 units');
  });
});
