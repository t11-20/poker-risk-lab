/**
 * The hand history is usable on a phone: the row opens the hand, the columns are on screen, and the
 * sort control is one row.
 *
 * ## The failure this is written against
 *
 * Measured on `/review` with the fixture history, before the change:
 *
 *   - 360x640: an 852px table in a 328px scroller. "Net to you" began at x=616 and "Ending" at
 *     x=745, both off screen, with nothing saying they were there.
 *   - every width: the only way into a hand was its number, a 21x44px link whose words ("Replay
 *     hand") were visually hidden; `elementFromPoint` at 70% across the first row found the net
 *     figure's `<span>` — and the row still lit up on hover.
 *   - 360x640: the five sort links wrapped to five rows, 247px of control, and the first hand began
 *     at y=931.
 *
 * After: no horizontal scroll at 360, 768, 900, 1024 or 1440; every probe across the first row
 * lands on the link; the sort control is 44px tall at 360. Those numbers come from a browser and
 * this file cannot reproduce them — it pins the four things in the source that produce them, each
 * of which fails against the code as it was.
 *
 * Read as text because `apps/web` has no way to render a `.tsx` component under `node --test`
 * (Node strips types and does not transform JSX), and `packages/ui/test/layout-guarantees.test.ts`
 * reads CSS the same way for the same kind of guarantee.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../src/styles/review.css', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/app/review/page.tsx', import.meta.url), 'utf8');

/** Comments out, so a selector quoted in prose cannot satisfy an assertion about a rule. */
const code = css.replace(/\/\*[\s\S]*?\*\//gu, '');

/** The body of the first top-level `@media` block whose prelude contains `query`. */
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

/** The declarations of the rule whose selector list is exactly `selector`, within `source`. */
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
    // test:layout, CI run 43044654587, /review at 360px: "the column is 16.02px and the word
    // "Sort" needs 29.34px". The glyph measurement is that gate's; this pins the rule behind it.
    assert.match(rule(code, '.prl-review-sorts__form .prl-btn'), /flex:\s*none/u);
  });
});
