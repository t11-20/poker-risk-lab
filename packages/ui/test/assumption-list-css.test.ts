/**
 * `AssumptionList` draws its own index, so the list's own marker would put a bullet before every
 * "01". The Lab and the lessons load their own stylesheet after this one, and each must see the same list.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const componentsCss = read('../src/styles/components.css');
const ROUTE_SHEETS = {
  lab: read('../../../apps/web/src/styles/lab.css'),
  learn: read('../../../apps/web/src/styles/learn.css'),
} as const;

/** Declarations of every top-level block whose selector list names exactly `selector`, in source order. */
function declarationsOf(css: string, selector: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const [, selectors = '', body = ''] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(pattern)) {
    if (!selectors.split(',').some((part) => part.trim() === selector)) continue;
    for (const declaration of body.split(';')) {
      const [property = '', ...value] = declaration.split(':');
      if (value.length > 0) declarations.set(property.trim(), value.join(':').trim());
    }
  }
  return declarations;
}

/** The cascade for one selector of equal specificity: a later sheet's declaration wins. */
function cascaded(selector: string, ...sheets: readonly string[]): Record<string, string> {
  return Object.fromEntries(sheets.flatMap((css) => [...declarationsOf(css, selector)]));
}

const LIST = {
  display: 'grid',
  gap: 'var(--prl-space-3)',
  margin: '0',
  'padding-inline-start': '0',
  'font-size': 'var(--prl-type-body)',
  'line-height': 'var(--prl-leading-snug)',
  'list-style': 'none',
};

describe('the assumptions list', () => {
  it('takes its whole style from this package', () => {
    assert.deepEqual(cascaded('.prl-assumptions__list', componentsCss), LIST);
    for (const [route, sheet] of Object.entries(ROUTE_SHEETS)) {
      assert.equal(declarationsOf(sheet, '.prl-assumptions__list').size, 0, `${route}.css restates it`);
    }
  });

  for (const [route, sheet] of Object.entries(ROUTE_SHEETS)) {
    it(`draws no marker of its own on /${route}`, () => {
      assert.deepEqual(cascaded('.prl-assumptions__list', componentsCss, sheet), LIST);
    });
  }
});
