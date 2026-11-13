/**
 * The control that chooses which styles `/legends/compare` puts side by side can be found.
 *
 * ## The defect this exists for
 *
 * The audit at 6b3886e measured the "Change the comparison" picker at y=11996 of a 15738px page on
 * a phone — about fourteen screens down — and at y=5916 of 7721 on a desktop. The top of the page
 * linked only to "All profiles" and "A finished hand, reviewed", so a reader who wanted different
 * styles had no sign that the page could do it.
 *
 * The page imports CSS and cannot be loaded under `node --test`, so it is held to its source.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const PAGE = readFileSync(new URL('../src/app/legends/compare/page.tsx', import.meta.url), 'utf8');

describe('the compare picker is linked from the top of the page', () => {
  const id = /const PICKER_HEADING_ID = '([a-z-]+)';/u.exec(PAGE)?.[1];

  it('names one id for the link and its target', () => {
    assert.ok(id !== undefined && id.length > 0, 'PICKER_HEADING_ID has moved; this needs updating');
  });

  it('links to the picker from the page head, before any section (REGRESSION)', () => {
    // `${…}` is built rather than written out — biome's `noTemplateCurlyInString`, and the repo's
    // idiom is a helper rather than an ignore.
    const hole = (expression: string): string => `\${${expression}}`;
    const link = PAGE.indexOf(`<a href={\`#${hole('PICKER_HEADING_ID')}\`}>Change the styles</a>`);
    const nav = PAGE.indexOf('<nav aria-label="Legends navigation"');
    const firstSection = PAGE.indexOf('<section');
    assert.ok(nav >= 0 && firstSection > nav, 'the page head has moved; this assertion needs updating');
    assert.ok(link > nav && link < firstSection, 'no "Change the styles" link in the page head');
  });

  it('lands on the picker’s heading, which takes focus, ahead of the form', () => {
    const heading = PAGE.indexOf('<h2 id={PICKER_HEADING_ID} tabIndex={-1}>');
    const form = PAGE.indexOf('aria-label="Choose which styles to compare"');
    assert.ok(heading >= 0, 'the target heading is not focusable, or has lost its id');
    assert.ok(form > heading, 'the target is not the heading of the picker');
    assert.equal(PAGE.match(/id=\{PICKER_HEADING_ID\}/gu)?.length, 1, 'one target, not two');
  });
});
