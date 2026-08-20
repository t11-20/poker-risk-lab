/**
 * `Metric format="percent"` is a probability. It must not print 160%.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadComponent } from './support/render-component.ts';

interface MetricProps {
  readonly label: string;
  readonly value: number;
  readonly format?: 'number' | 'percent' | 'units' | 'points' | 'odds';
  readonly unit?: string | null;
}

async function render(props: MetricProps): Promise<string> {
  const Metric = await loadComponent<MetricProps>('components/Metric', 'Metric');
  return renderToStaticMarkup(createElement(Metric, props));
}

test('a real probability is a percentage', async () => {
  const html = await render({ label: 'Equity', value: 0.36, format: 'percent' });
  assert.match(html, /36\.0/);
  assert.match(html, />%<\/span>/);
  assert.doesNotMatch(html, /160/);
});

test('a stale fixture value is refused rather than printed as 160%', async () => {
  const html = await render({ label: 'Equity', value: 1.6, format: 'percent' });
  assert.match(html, /not a probability/);
  assert.doesNotMatch(html, /160/);
  assert.doesNotMatch(html, /1\.6\s*%/);
});

test('a percentage-point unit error is refused rather than printed as 3,600%', async () => {
  const html = await render({ label: 'Equity', value: 36, format: 'percent' });
  assert.match(html, /not a probability/);
  assert.doesNotMatch(html, /3,600/);
  assert.doesNotMatch(html, /3600/);
});

test('an absent (non-finite) figure stays a dash, not a refusal', async () => {
  const html = await render({ label: 'Your equity', value: Number.NaN, format: 'percent', unit: null });
  assert.doesNotMatch(html, /not a probability/);
  assert.doesNotMatch(html, /NaN/i);
  assert.match(html, /—/);
});
