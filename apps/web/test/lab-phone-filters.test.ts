/**
 * Phone layout for the Scenario Lab filters. At 390×844 with the guide dismissed the first card
 * started at 1150px, and the three stacked selects were 254px of that. Topic stays alone: "Fold
 * equity and bluffing (2)" is 187px and a half column has 144px of text room. Difficulty and Street
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

describe('lab filters on a phone', () => {
  const phone = mediaBlock('width < 600px');

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
      rule(mediaBlock('min-width: 600px'), '.prl-lab-filters__row'),
      /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/u,
    );
    assert.match(
      rule(mediaBlock('min-width: 1280px'), '.prl-lab-filters__row'),
      /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/u,
    );
    assert.doesNotMatch(mediaBlock('min-width: 600px'), /grid-column:\s*1\s*\/\s*-1/u);
    assert.doesNotMatch(mediaBlock('min-width: 1280px'), /grid-column:\s*1\s*\/\s*-1/u);
  });

  it('stacks the selects below 380px, where the half column clips (REGRESSION)', () => {
    const narrow = mediaBlock('width < 380px');
    assert.match(rule(narrow, '.prl-lab-filters__row'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
    assert.match(rule(narrow, '.prl-lab-filters__field:first-child'), /grid-column:\s*auto/u);
    // The face stays the body size. A smaller face was 2px short of "Every street (36)" at 320.
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
    const card = rule(phone, '.prl-lab-card');
    assert.match(card, /min-inline-size:\s*0/u);
    assert.match(card, /max-inline-size:\s*100%/u);
    // The nowrap chip was the column's min-content, and the state strip then cleared the screen.
    const chip = rule(phone, '.prl-lab-card .prl-chip');
    assert.match(chip, /white-space:\s*normal/u);
    assert.match(chip, /overflow-wrap:\s*break-word/u);
  });

  it('leaves the form a GET form whose count line is still the jump target', () => {
    assert.match(filters, /<form className="prl-lab-filters" method="get"/u);
    assert.match(filters, /id=\{LAB_RESULTS_ID\}/u);
    assert.match(filters, /<label className="prl-field__label" htmlFor=\{id\}>/u);
    assert.doesNotMatch(phone, /display:\s*none/u);
  });
});
