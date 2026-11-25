/**
 * Phone layout for the Scenario Lab filters. At 390×844 with the guide dismissed the first card
 * started at 1150px, and the three stacked selects were 254px of that. Topic stays alone: "Fold
 * equity and bluffing (2)" is 187px and a half column has 136px of text room at 390. Difficulty and Street
 * share the next row. From 600px the row is the one it was.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../src/styles/lab.css', import.meta.url), 'utf8');
const filters = readFileSync(new URL('../src/components/ScenarioFilters.tsx', import.meta.url), 'utf8');
const code = css.replace(/\/\*[\s\S]*?\*\//gu, '');

function mediaBlock(query: string): string {
  const at = code.indexOf(`@media (${query})`);
  assert.ok(at >= 0, `lab.css has no @media (${query}) block`);
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

/** Each top-level rule's selector and its offset. Rules inside an at-rule are skipped. */
function topLevelRules(source: string): { readonly selector: string; readonly at: number }[] {
  const found: { selector: string; at: number }[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      const head = source.slice(start, index).trim();
      if (depth === 0 && !head.startsWith('@')) found.push({ selector: head, at: start });
      depth += 1;
      start = index + 1;
    } else if (char === '}') {
      depth -= 1;
      start = index + 1;
    }
  }
  return found;
}

/** The body of a rule outside every at-rule, so a rule moved into a media query is not found. */
function topLevelRule(source: string, selector: string): string {
  const found = topLevelRules(source).find((one) => one.selector === selector);
  assert.ok(found !== undefined, `no top-level rule for "${selector}"`);
  const open = source.indexOf('{', found.at);
  return source.slice(open + 1, source.indexOf('}', open));
}

describe('lab filters on a phone', () => {
  const phone = mediaBlock('width < 37.5em');

  it('keeps topic full width and pairs the two shorter selects (REGRESSION)', () => {
    assert.match(
      rule(phone, '.prl-lab-filters__row'),
      /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/u,
    );
    assert.match(rule(phone, '.prl-lab-filters__field:first-child'), /grid-column:\s*1\s*\/\s*-1/u);
    // The span is the first field. Topic's options are the long ones, so it has to be first.
    assert.match(filters, /label="Topic"[\s\S]*?label="Difficulty"[\s\S]*?label="Street"/u);
  });

  it('does not apply that span from 600px up (REGRESSION)', () => {
    assert.match(
      rule(mediaBlock('min-width: 37.5em'), '.prl-lab-filters__row'),
      /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/u,
    );
    assert.match(
      rule(mediaBlock('min-width: 80em'), '.prl-lab-filters__row'),
      /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/u,
    );
    assert.doesNotMatch(mediaBlock('min-width: 37.5em'), /grid-column:\s*1\s*\/\s*-1/u);
    assert.doesNotMatch(mediaBlock('min-width: 80em'), /grid-column:\s*1\s*\/\s*-1/u);
  });

  it('stacks the selects below 380px, where the half column clips (REGRESSION)', () => {
    const narrow = mediaBlock('width < 23.75em');
    assert.match(rule(narrow, '.prl-lab-filters__row'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
    assert.match(rule(narrow, '.prl-lab-filters__field:first-child'), /grid-column:\s*auto/u);
    // The face stays the body size: below 380 the fields stack instead of shrinking the text.
    assert.doesNotMatch(narrow, /font-size/u);
  });

  it('stops a card from widening the page when text is enlarged (REGRESSION)', () => {
    // Twelve tracks put eleven gaps inside a spanned card: 528px at a 32px root.
    const grid = readFileSync(
      new URL('../../../packages/ui/src/styles/components.css', import.meta.url),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//gu, '');
    assert.match(rule(grid, '.prl-grid'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
    assert.doesNotMatch(rule(grid, '.prl-grid'), /repeat\(12/u, 'twelve tracks below 600px');
    const wide = grid.indexOf('@media (min-width: 37.5em) {\n  .prl-grid {');
    assert.ok(wide >= 0, 'no 600px query gives .prl-grid its twelve tracks back');
    assert.match(
      rule(grid.slice(wide), '.prl-grid'),
      /grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/u,
    );
    // At every width, because 600px at 200% text overflowed too. The nowrap chip set the card's width.
    const card = topLevelRule(code, '.prl-lab-card');
    assert.match(card, /min-inline-size:\s*0/u);
    assert.match(card, /max-inline-size:\s*100%/u);
    const chip = topLevelRule(code, '.prl-lab-card .prl-chip');
    assert.match(chip, /white-space:\s*normal/u);
    assert.match(chip, /overflow-wrap:\s*break-word/u);
  });

  it('sits after every base rule it overrides, because a media query adds no specificity', () => {
    const media = code.indexOf('@media (width < 37.5em)');
    const inside = topLevelRules(phone).map((one) => one.selector);
    assert.ok(inside.length >= 6, `read ${inside.length} phone rules`);
    const later = topLevelRules(code).filter((one) => inside.includes(one.selector) && one.at > media);
    assert.deepEqual(
      later.map((one) => one.selector),
      [],
      'a later base rule of equal specificity wins over the phone block',
    );
    // The stack below 380 overrides the pairing, so it has to come after it.
    assert.ok(
      code.indexOf('@media (width < 23.75em)') > media,
      'the 380px block sits before the 600px block',
    );
  });

  it('leaves the form a GET form whose count line is still the jump target', () => {
    assert.match(filters, /<form className="prl-lab-filters" method="get"/u);
    assert.match(filters, /id=\{LAB_RESULTS_ID\}/u);
    assert.match(filters, /<label className="prl-field__label" htmlFor=\{id\}>/u);
    assert.doesNotMatch(phone, /display:\s*none/u);
  });
});
