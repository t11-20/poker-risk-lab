/**
 * The hand history is usable on a phone: the row opens the hand, the columns are on screen, and the
 * sort control is one row. `test:layout` measures the result; this pins the source rules behind it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { scrollRegionTabIndex, scrollsSideways } from '../src/lib/scroll-region.ts';

const css = readFileSync(new URL('../src/styles/review.css', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/app/review/page.tsx', import.meta.url), 'utf8');
const region = readFileSync(new URL('../src/components/ScrollRegion.tsx', import.meta.url), 'utf8');

/** Comments out, so a selector quoted in prose cannot satisfy an assertion about a rule. */
const code = css.replace(/\/\*[\s\S]*?\*\//gu, '');

function mediaBlock(query: string): string {
  const at = code.indexOf(`@media (${query})`);
  assert.ok(at >= 0, `review.css has no @media (${query}) block`);
  const open = code.indexOf('{', at);
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '{') depth += 1;
    if (code[index] === '}') depth -= 1;
    if (depth === 0) return code.slice(open + 1, index);
  }
  throw new Error(`unbalanced @media (${query}) block`);
}

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(source);
  assert.ok(match !== null, `no rule for "${selector}"`);
  return match[1] ?? '';
}

describe('/review below 1024px', () => {
  const narrow = mediaBlock('width < 1024px');

  it('draws each row as a card instead of a table wider than the screen (REGRESSION)', () => {
    assert.match(rule(narrow, '.prl-review-table tbody tr'), /display:\s*grid/u);
    assert.match(rule(narrow, '.prl-review-table tbody'), /display:\s*grid/u);
  });

  it('hides the header row visually but keeps it in the accessibility tree', () => {
    const thead = rule(narrow, '.prl-review-table thead');
    // `display: none` here removed every `columnheader` from Chrome's AX tree in the probe.
    assert.doesNotMatch(thead, /display:\s*none/u);
    assert.match(thead, /clip-path:\s*inset\(50%\)/u);
  });
});

describe('/review at every width', () => {
  it('stretches the one link per row over the whole row (REGRESSION)', () => {
    assert.match(rule(code, '.prl-review-table tbody tr'), /position:\s*relative/u);
    const after = rule(code, '.prl-review-table__link::after');
    assert.match(after, /position:\s*absolute/u);
    assert.match(after, /inset:\s*0/u);
    // Without it the board cards (`position: relative`, later in the row) painted over the layer.
    assert.match(after, /z-index:/u);
  });

  it('says "Replay hand N" in words a sighted reader can see (REGRESSION)', () => {
    assert.doesNotMatch(page, /prl-visually-hidden">Replay hand/u);
    assert.match(page, /\{`Replay hand \$\{hand\.handNumber\}`\}/u);
  });

  it('offers a one-row GET form with every ordering on a phone, and only there (REGRESSION)', () => {
    assert.match(page, /<form className="prl-review-sorts__form" method="get" action=\{ROUTE\}>/u);
    assert.match(
      page,
      /<select className="prl-select" id=\{SORT_SELECT_ID\} name="sort" defaultValue=\{sort\}>/u,
    );
    assert.match(page, /\{SORTS\.map\(\(candidate\) => \(\s*<option key=\{candidate\} value=\{candidate\}>/u);
    const phone = mediaBlock('width < 600px');
    assert.match(rule(phone, '.prl-review-sorts__form'), /display:\s*flex/u);
    assert.match(rule(phone, '.prl-review-sorts__heading,\n  .prl-review-sorts__list'), /display:\s*none/u);
    assert.match(rule(code, '.prl-review-sorts__form'), /display:\s*none/u);
  });

  it('does not let the select squeeze the submit button below its word (REGRESSION)', () => {
    // test:layout at 360px measured the "Sort" column at 16.02px against 29.34px needed.
    assert.match(rule(code, '.prl-review-sorts__form .prl-btn'), /flex:\s*none/u);
  });
});

/**
 * The scroll region is a tab stop exactly when it scrolls sideways. Below 1024px the rows are cards,
 * so a fixed stop was 1,549px of nothing. The default's lean is explained in `src/lib/scroll-region.ts`.
 */
describe('/review scroll region', () => {
  it('is a tab stop when the table is wider than the region', () => {
    // 768 before the cards: a 928px table in a 707px scroller.
    assert.equal(scrollsSideways({ scrollWidth: 928, clientWidth: 707 }), true);
    assert.equal(scrollRegionTabIndex({ scrollWidth: 928, clientWidth: 707 }), 0);
  });

  it('is not a tab stop when the table fits, including exactly (REGRESSION)', () => {
    for (const box of [
      { scrollWidth: 328, clientWidth: 328 },
      { scrollWidth: 944, clientWidth: 944 },
      { scrollWidth: 943, clientWidth: 944 },
    ]) {
      assert.equal(scrollsSideways(box), false, JSON.stringify(box));
      // Absent, not -1: -1 is still click-focusable and still matches every gate's `[tabindex]`.
      assert.equal(scrollRegionTabIndex(box), undefined, JSON.stringify(box));
    }
  });

  it('wraps the table in the measuring region instead of a fixed tab stop (REGRESSION)', () => {
    assert.doesNotMatch(page, /className="prl-review-scroll" tabIndex=\{0\}/u);
    assert.match(page, /<ScrollRegion className="prl-review-scroll" label=\{TABLE_LABEL\}>/u);
  });

  it('server-renders the stop, and keeps the name whether or not it is one', () => {
    // The safe default: a region the server cannot measure is focusable until a browser says not.
    assert.match(region, /useState<0 \| undefined>\(0\)/u);
    assert.match(
      region,
      /<section ref=\{region\} className=\{className\} tabIndex=\{tabIndex\} aria-label=\{label\}>/u,
    );
    // A font swap widens the table without resizing the section, so both are observed.
    assert.match(region, /observer\.observe\(element\);/u);
    assert.match(region, /observer\.observe\(element\.firstElementChild\)/u);
  });
});
