/**
 * `Metric`'s unit word, a separate element from the figure, must agree with it.
 * The unit does not go through `formatUnits`, so it must not print "1 units" or "— units".
 * Rendered, because the join between figure and word is what is asserted.
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

/** The figure and its unit, as one string, which is what a reader sees. */
function figureAndUnit(markup: string): string {
  const value = /<span class="prl-metric__value">([^<]*)<\/span>/u.exec(markup);
  assert.ok(value !== null, `no value in the rendered metric:\n${markup}`);
  const unit = /<span class="prl-metric__unit prl-label">([^<]*)<\/span>/u.exec(markup);
  return unit === null ? (value[1] ?? '') : `${value[1] ?? ''} ${unit[1] ?? ''}`;
}

/**
 * The same two properties on `CountedFigure`, which has its own unit logic and the only live region.
 * `figureAndUnit` cannot see it (it emits `prl-metric__value prl-count`). Without these cases, breaking
 * its `unitFor` passed every test in both packages.
 */
describe('the counting figure says the same word as the static one', () => {
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
    // The positive control. A figure that always dropped the "s" would pass the cases above.
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
    // `formatUnits` decides on the rendered body's value, so 1.0 at one decimal is still "unit".
    assert.equal(
      figureAndUnit(await render({ label: 'Net', value: 1, format: 'units', decimals: 1 })),
      '1.0 unit',
    );
  });

  it('leaves a unit the caller passed exactly as the caller wrote it', async () => {
    // `unit="of 1"` is used on the trait metrics in the post-hand comparison.
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
    const markup = await render({ label: 'Equity', value: 1.6, format: 'percent' });
    assert.match(markup, /not a probability/u);
    assert.doesNotMatch(markup, /class="prl-metric__unit/u);
  });

  it('NEGATIVE CONTROL: the detectors do fire on a figure that HAS a unit', async () => {
    // A renamed `prl-metric__unit` class would make every `doesNotMatch` above pass.
    const present = await render({ label: 'Net', value: 12, format: 'units' });
    assert.match(present, /class="prl-metric__unit prl-label">units<\/span>/u);
    assert.equal(figureAndUnit(present), '12 units');
  });
});
