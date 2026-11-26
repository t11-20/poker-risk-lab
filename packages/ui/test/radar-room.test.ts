/**
 * Above 100% text the radar's markers were cut off: they are sized in rem and had a fixed 18 units of
 * room. The stylesheet now takes their room from the plot, and these hold its arithmetic to
 * `radarLabelRoom()` by evaluating the declarations themselves, at every label size a reader can pick.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { LEGEND_TRAIT_KEYS, type LegendTraitAxis } from '@prl/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RadarAxisLabels, RadarChartProps } from '../src/components/RadarChart.tsx';
import {
  RADAR_CENTRE,
  RADAR_LABEL_GUTTER,
  RADAR_LABEL_RADIUS,
  RADAR_MARKER_WIDTH_EM,
  RADAR_RADIUS,
  RADAR_WORD_WIDTH_EM,
  radarLabelRoom,
} from '../src/radar.ts';
import { findAll, hasClass, markupTree } from './support/markup-tree.ts';
import { loadComponent } from './support/render-component.ts';

const stylesheet = (name: string): string =>
  readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const css = stylesheet('components.css');

/** Later declarations win, as they do for one selector repeated. */
function declarations(selector: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, list = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!list.split(',').some((part) => part.trim() === selector)) continue;
    for (const declaration of body.split(';')) {
      const [property = '', ...value] = declaration.split(':');
      if (value.length > 0) found.set(property.trim(), value.join(':').replace(/\s+/g, ' ').trim());
    }
  }
  assert.ok(found.size > 0, `components.css has no ${selector} rule`);
  return found;
}

/**
 * The CSS math the radar rules use (`calc`, `min`, `max`, `sin`, `cos`, `atan2`, + - * /) with px read as
 * numbers, which inside the SVG they are: viewBox units. Anything else throws rather than guesses.
 */
function evaluate(expression: string, vars: ReadonlyMap<string, string>): number {
  let text = expression;
  for (let pass = 0; text.includes('var('); pass += 1) {
    assert.ok(pass < 20, `var() never resolves in ${expression}`);
    text = text.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
      const value = vars.get(name);
      assert.ok(value !== undefined, `${name} has no value in this test`);
      return `(${value})`;
    });
  }
  const tokens = text.match(/\d*\.?\d+(?:px)?|[a-z0-9]+\(|[-+*/(),]/g) ?? [];
  assert.equal(tokens.join(''), text.replace(/\s+/g, ''), `unparsed text in ${text}`);
  let at = 0;
  const next = (): string => tokens[at++] ?? '';
  const expect = (token: string): void => assert.equal(next(), token, `expected ${token} in ${text}`);

  const FUNCTIONS: Record<string, (args: number[]) => number> = {
    'calc(': ([a = Number.NaN]) => a,
    'min(': (args) => Math.min(...args),
    'max(': (args) => Math.max(...args),
    'sin(': ([a = Number.NaN]) => Math.sin(a),
    'cos(': ([a = Number.NaN]) => Math.cos(a),
    'atan2(': ([y = Number.NaN, x = Number.NaN]) => Math.atan2(y, x),
  };
  const primary = (): number => {
    const token = next();
    if (token === '(') {
      const value = sum();
      expect(')');
      return value;
    }
    if (token === '-') return -primary();
    const call = FUNCTIONS[token];
    if (call !== undefined) {
      const args = [sum()];
      while (tokens[at] === ',') {
        at += 1;
        args.push(sum());
      }
      expect(')');
      return call(args);
    }
    const number = Number.parseFloat(token);
    assert.ok(Number.isFinite(number), `unexpected ${token} in ${text}`);
    return number;
  };
  const product = (): number => {
    let value = primary();
    for (let op = tokens[at]; op === '*' || op === '/'; op = tokens[at]) {
      at += 1;
      value = op === '*' ? value * primary() : value / primary();
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    for (let op = tokens[at]; op === '+' || op === '-'; op = tokens[at]) {
      at += 1;
      value = op === '+' ? value + product() : value - product();
    }
    return value;
  };
  const result = sum();
  assert.equal(at, tokens.length, `trailing tokens in ${text}`);
  return result;
}

const svg = declarations('.prl-radar__svg');
const plot = declarations('.prl-radar__plot');
const label = declarations('.prl-radar__label');

/** The custom properties each element sees, for one label size and one kind of label. */
function scope(labelSize: number, widthEm: number, gutter: number): Map<string, string> {
  const vars = new Map<string, string>([
    ['--prl-type-label-sm', `${labelSize}px`],
    ['--prl-radar-gutter', `${gutter}px`],
    ['--prl-radar-label-width', String(widthEm)],
  ]);
  for (const [name, value] of [...svg, ...plot, ...label]) if (name.startsWith('--')) vars.set(name, value);
  return vars;
}

/** `scale(<expr>)` and `translate(<x>, <y>)`, split at their top-level comma. */
function argumentsOf(value: string, fn: string): string[] {
  assert.ok(value.startsWith(`${fn}(`) && value.endsWith(')'), `${value} is not a ${fn}()`);
  const inner = value.slice(fn.length + 1, -1);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] === '(') depth += 1;
    if (inner[index] === ')') depth -= 1;
    if (inner[index] === ',' && depth === 0) {
      parts.push(inner.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map((part) => part.trim());
}

const KINDS = [
  { name: 'markers', widthEm: RADAR_MARKER_WIDTH_EM, gutter: 0 },
  { name: 'words', widthEm: RADAR_WORD_WIDTH_EM, gutter: RADAR_LABEL_GUTTER },
  { name: 'no labels', widthEm: 0, gutter: 0 },
] as const;

/** Chrome's own text sizes run from 9px to 24px; a custom size can be larger. */
const LABEL_SIZES = [6.75, 9, 12, 12.75, 13.5, 15, 18, 21, 24, 30, 36, 54];

describe('the radar stylesheet takes label room from the plot', () => {
  const defaultLabel =
    16 * Number.parseFloat(/--prl-type-label-sm:\s*([\d.]+)rem/.exec(stylesheet('tokens.css'))?.[1] ?? '');

  it('reads a 12px default label from the tokens', () => {
    assert.equal(defaultLabel, 12);
  });

  it('computes the same plot radius as radarLabelRoom() at every label size', () => {
    for (const kind of KINDS) {
      for (const size of LABEL_SIZES) {
        const css = evaluate(
          svg.get('--prl-radar-plot-radius') ?? '',
          scope(size, kind.widthEm, kind.gutter),
        );
        const ts = radarLabelRoom(size, kind.widthEm, kind.gutter).plotRadius;
        assert.ok(Math.abs(css - ts) < 1e-9, `${kind.name} at ${size}px: CSS ${css}, radarLabelRoom ${ts}`);
      }
    }
  });

  it('scales the plot about the centre to that radius', () => {
    assert.equal(plot.get('transform-origin'), `${RADAR_CENTRE}px ${RADAR_CENTRE}px`);
    const [factor = ''] = argumentsOf(plot.get('transform') ?? '', 'scale');
    for (const kind of KINDS) {
      for (const size of LABEL_SIZES) {
        const scale = evaluate(factor, scope(size, kind.widthEm, kind.gutter));
        const want = radarLabelRoom(size, kind.widthEm, kind.gutter).plotRadius / RADAR_RADIUS;
        assert.ok(Math.abs(scale - want) < 1e-9, `${kind.name} at ${size}px: scale ${scale}, want ${want}`);
      }
    }
  });

  it('moves each label out by exactly the change in its radius', () => {
    const [x = '', y = ''] = argumentsOf(label.get('transform') ?? '', 'translate');
    for (const size of LABEL_SIZES) {
      const vars = scope(size, RADAR_MARKER_WIDTH_EM, 0);
      vars.set('--prl-radar-dx', '0.6');
      vars.set('--prl-radar-dy', '-0.8');
      const shift = radarLabelRoom(size, RADAR_MARKER_WIDTH_EM).labelRadius - RADAR_LABEL_RADIUS;
      assert.ok(Math.abs(evaluate(x, vars) - 0.6 * shift) < 1e-9, `x at ${size}px`);
      assert.ok(Math.abs(evaluate(y, vars) + 0.8 * shift) < 1e-9, `y at ${size}px`);
    }
  });

  it('is exactly the old drawing at the default label: scale 1 and no shift, not merely close', () => {
    const [factor = ''] = argumentsOf(plot.get('transform') ?? '', 'scale');
    const [x = ''] = argumentsOf(label.get('transform') ?? '', 'translate');
    for (const kind of KINDS) {
      const vars = scope(defaultLabel, kind.widthEm, kind.gutter);
      vars.set('--prl-radar-dx', '1');
      assert.equal(evaluate(factor, vars), 1, kind.name);
      assert.equal(evaluate(x, vars), 0, kind.name);
    }
  });

  it("keeps the label at the reader's text size: no px size, no clamp", () => {
    assert.equal(label.get('font-size'), 'var(--prl-type-label-sm)');
    for (const value of [...svg.values(), ...plot.values(), ...label.values()]) {
      assert.doesNotMatch(value, /clamp\(/);
    }
  });
});

const AXES: LegendTraitAxis[] = LEGEND_TRAIT_KEYS.map((key, index) => ({
  key,
  label: `Trait ${index + 1}`,
  value: (index % 4) / 4,
  description: '',
}));

describe('RadarChart markup for the label room', () => {
  const tree = async (axisLabels: RadarAxisLabels) => {
    const RadarChart = await loadComponent<RadarChartProps>('components/RadarChart', 'RadarChart');
    return markupTree(renderToStaticMarkup(createElement(RadarChart, { axes: AXES, axisLabels })));
  };

  it('scales only the plot: rings, spokes and shape sit in it, the labels outside it', async () => {
    const root = await tree('index');
    const [group] = findAll(root, (element) => hasClass(element, 'prl-radar__plot'));
    assert.ok(group, 'no .prl-radar__plot group');
    const inside = (name: string) => findAll(group, (element) => hasClass(element, name)).length;
    assert.equal(inside('prl-radar__ring'), 3);
    assert.equal(inside('prl-radar__spoke'), 16);
    assert.equal(inside('prl-radar__shape'), 1);
    assert.equal(inside('prl-radar__label'), 0);
    assert.equal(findAll(root, (element) => hasClass(element, 'prl-radar__label')).length, 16);
  });

  it('tells the stylesheet each kind of label and its gutter', async () => {
    for (const [axisLabels, width, gutter] of [
      ['index', RADAR_MARKER_WIDTH_EM, 0],
      ['text', RADAR_WORD_WIDTH_EM, RADAR_LABEL_GUTTER],
      ['none', 0, 0],
    ] as const) {
      const [element] = findAll(await tree(axisLabels), (e) => hasClass(e, 'prl-radar__svg'));
      assert.equal(
        element?.attributes.get('style'),
        `--prl-radar-gutter:${gutter}px;--prl-radar-label-width:${width}`,
        axisLabels,
      );
    }
  });

  it('gives every label the direction away from the centre', async () => {
    const labels = findAll(await tree('index'), (element) => hasClass(element, 'prl-radar__label'));
    for (const element of labels) {
      const style = element.attributes.get('style') ?? '';
      const dx = Number(/--prl-radar-dx:(-?[\d.]+)/.exec(style)?.[1]);
      const dy = Number(/--prl-radar-dy:(-?[\d.]+)/.exec(style)?.[1]);
      const x = Number(element.attributes.get('x')) - RADAR_CENTRE;
      const y = Number(element.attributes.get('y')) - RADAR_CENTRE;
      assert.ok(
        Math.abs(dx * x + dy * y - RADAR_LABEL_RADIUS) < 0.05,
        `${element.inner} does not point outward`,
      );
    }
  });
});
