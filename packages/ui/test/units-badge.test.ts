/**
 * `UnitsBadge`: the explanation can be put away, and the reset it promises is somewhere to go.
 * The panel closes on an outside tap, Escape, a scroll or a navigation, or it stays open over every page.
 * The closing paths need a DOM, which `node --test` lacks (ADR 0008), so their wiring is read from the
 * source. `scripts/keyboard-audit.mjs` drives the Escape path in a real browser.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compileSource, loadComponent } from './support/render-component.ts';

interface BadgeProps {
  readonly units: number;
  readonly recordHref?: string;
  readonly resetHref?: string;
  readonly route?: string;
}

const SOURCE = readFileSync(new URL('../src/components/UnitsBadge.tsx', import.meta.url), 'utf8');

/** The source with comment lines removed, so a sentence ABOUT a listener cannot satisfy a match for one. */
const CODE = SOURCE.split('\n')
  .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/u.test(line))
  .join('\n');

/** The exported promise, from the same emitted module the component is rendered from. */
async function explanation(): Promise<string> {
  const entry = pathToFileURL(join(compileSource(), 'components/UnitsBadge.js')).href;
  const loaded = (await import(entry)) as { readonly UNITS_EXPLANATION?: unknown };
  assert.equal(typeof loaded.UNITS_EXPLANATION, 'string');
  return loaded.UNITS_EXPLANATION as string;
}

async function render(props: BadgeProps): Promise<string> {
  const UnitsBadge = await loadComponent<BadgeProps>('components/UnitsBadge', 'UnitsBadge');
  return renderToStaticMarkup(createElement(UnitsBadge, props));
}

function noteOf(markup: string): string {
  const found = /<span class="prl-units__note"[^>]*>(.*?)<\/span>$/u.exec(markup.replace(/<\/span>$/u, ''));
  assert.ok(found !== null, `no explanation panel in the rendered badge:\n${markup}`);
  return found[1] ?? '';
}

describe('the explanation names where the reset is', () => {
  it('links "reset them to the starting amount" when it is given somewhere to go (REGRESSION)', async () => {
    const note = noteOf(await render({ units: 1000, resetHref: '/record' }));
    assert.match(note, /<a href="\/record">reset them to the starting amount<\/a>/u);
  });

  it('says exactly what UNITS_EXPLANATION says, link or no link', async () => {
    // The footer and onboarding restate the exported string, so the panel must not drift from it.
    const linked = noteOf(await render({ units: 1000, resetHref: '/record' })).replace(/<[^>]+>/gu, '');
    const plain = noteOf(await render({ units: 1000 })).replace(/<[^>]+>/gu, '');
    const promise = await explanation();
    assert.equal(linked, promise);
    assert.equal(plain, promise);
    assert.match(promise, /reset them to the starting amount at any time\.$/u);
  });

  it('is closed until asked for', async () => {
    assert.match(
      await render({ units: 1000, resetHref: '/record' }),
      /class="prl-units__note" id="[^"]+" hidden=""/u,
    );
  });
});

describe('the figure leads to the reader’s record', () => {
  it('is a link to recordHref, with the word "units" still beside the number (REGRESSION)', async () => {
    const markup = await render({ units: 1000, recordHref: '/record' });
    const pill = /<a class="prl-units__value prl-units__link" href="\/record">(.*?)<\/a>/u.exec(markup);
    assert.ok(pill !== null, `the figure is not a link to /record:\n${markup}`);
    const inside = pill[1] ?? '';
    assert.match(inside, /<span class="prl-units__figure">1,000<\/span>/u);
    assert.match(inside, /<span class="prl-units__word prl-label">units<\/span>/u);
    // "1,000 units" names the figure, so the name has to say where the link goes.
    assert.match(inside.replace(/<[^>]+>/gu, ''), /your record$/u);
  });

  it('stays plain text when no record is named', async () => {
    const markup = await render({ units: 1000 });
    assert.doesNotMatch(markup, /<a /u);
    assert.match(markup, /<span class="prl-units__value">/u);
  });
});

describe('the panel closes the ways a reader expects (wiring)', () => {
  it('closes on a pointerdown outside the whole badge, so the `i` is still a toggle', () => {
    assert.match(CODE, /document\.addEventListener\('pointerdown', onPointerDown\)/u);
    assert.match(CODE, /root\.contains\(event\.target\)\) return;\s*setExpanded\(false\);/u);
  });

  it('closes on Escape, and gives focus back to the `i` when focus was inside it', () => {
    assert.match(CODE, /document\.addEventListener\('keydown', onKeyDown\)/u);
    assert.match(CODE, /event\.key !== 'Escape'\) return;/u);
    assert.match(CODE, /if \(inside\) toggleRef\.current\?\.focus\(\);/u);
    assert.match(CODE, /ref=\{toggleRef\}/u);
  });

  it('listens only while open, and stops listening when it closes', () => {
    assert.match(CODE, /if \(!expanded\) return;/u);
    assert.match(CODE, /document\.removeEventListener\('pointerdown', onPointerDown\)/u);
    assert.match(CODE, /document\.removeEventListener\('keydown', onKeyDown\)/u);
  });

  it('closes when the route it is told about changes', () => {
    assert.match(CODE, /if \(route !== seenRoute\) \{\s*setSeenRoute\(route\);\s*setExpanded\(false\);/u);
  });
});
