/**
 * At 360px with 200% text a nowrap chip, a nowrap equity detail and unbreakable words in the Coach's
 * nested boxes each pushed pages past the screen. These read the rules that let them wrap instead.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** The bodies of every `@media` block whose prelude is exactly `prelude`, braces matched, joined. */
function mediaBody(sheet: string, prelude: string): string {
  const bodies: string[] = [];
  for (let head = sheet.indexOf(`@media ${prelude} {`); head >= 0; ) {
    const start = sheet.indexOf('{', head) + 1;
    let depth = 1;
    let end = start;
    for (; end < sheet.length && depth > 0; end += 1) {
      if (sheet[end] === '{') depth += 1;
      if (sheet[end] === '}') depth -= 1;
    }
    assert.equal(depth, 0, `@media ${prelude} is never closed`);
    bodies.push(sheet.slice(start, end - 1));
    head = sheet.indexOf(`@media ${prelude} {`, end);
  }
  assert.ok(bodies.length > 0, `no @media ${prelude} block`);
  return bodies.join('\n');
}

/** `sheet` with every `@media` block removed, so only rules that apply at every size remain. */
function withoutMedia(sheet: string): string {
  let out = sheet;
  for (let head = out.indexOf('@media'); head >= 0; head = out.indexOf('@media')) {
    let depth = 0;
    let end = out.indexOf('{', head);
    do {
      if (out[end] === '{') depth += 1;
      if (out[end] === '}') depth -= 1;
      end += 1;
    } while (depth > 0 && end < out.length);
    out = out.slice(0, head) + out.slice(end);
  }
  return out;
}

/** Later declarations win, as they do for selectors of equal specificity. */
function cascaded(sheet: string, ...selectors: readonly string[]): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const [, list = '', body = ''] of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!list.split(',').some((part) => selectors.includes(part.trim()))) continue;
    for (const declaration of body.split(';')) {
      const [property = '', ...value] = declaration.split(':');
      if (value.length > 0) declarations.set(property.trim(), value.join(':').trim());
    }
  }
  return declarations;
}

const everySize = withoutMedia(css);

describe('a chip at large text', () => {
  const chip = cascaded(everySize, '.prl-chip');

  it('wraps between words and is never wider than its container', () => {
    assert.equal(chip.get('white-space'), 'normal');
    assert.equal(chip.get('max-inline-size'), '100%');
  });

  it('has a corner of half its one-line height, so one line stays a capsule', () => {
    const height = chip.get('min-height');
    assert.ok(height, 'the chip sets no min-height');
    assert.equal(chip.get('border-radius'), `calc(${height} / 2)`);
  });

  it('gives the uncertainty method chip the same wrapping and corner', () => {
    const method = cascaded(everySize, '.prl-chip', '.prl-uncertainty__method');
    assert.equal(method.get('white-space'), 'normal');
    assert.equal(method.get('border-radius'), chip.get('border-radius'));
  });

  it('leaves a badge on one line', () => {
    assert.equal(cascaded(everySize, '.prl-badge').get('white-space'), 'nowrap');
  });
});

describe('the equity readout', () => {
  it('wraps the detail inside the two tracks it spans', () => {
    const detail = cascaded(everySize, '.prl-equity-bar__detail');
    assert.equal(detail.get('grid-column'), '2 / -1');
    assert.equal(detail.get('white-space'), 'normal');
  });

  it('puts the value and detail under the name under 20em, so the name keeps the row', () => {
    const narrow = mediaBody(css, '(width < 20em)');
    assert.equal(
      cascaded(narrow, '.prl-equity-bar__row').get('grid-template-columns'),
      'auto minmax(0, 1fr)',
    );
    for (const selector of ['.prl-equity-bar__value', '.prl-equity-bar__detail']) {
      assert.equal(cascaded(narrow, selector).get('grid-column'), '2', selector);
    }
  });
});

describe('Coach prose under 20em', () => {
  const PROSE = [
    '.prl-coach__prose',
    '.prl-suggestion__reason',
    '.prl-suggestion__disclaimer',
    '.prl-outs__meaning',
    '.prl-stat__note',
    '.prl-uncertainty__summary',
    '.prl-uncertainty__limitations',
    '.prl-assumptions__text',
  ];
  const narrow = mediaBody(css, '(width < 20em)');

  for (const selector of PROSE) {
    it(`hyphenates ${selector}`, () => {
      assert.equal(cascaded(narrow, selector).get('hyphens'), 'auto');
    });
  }

  it('hyphenates nothing at any other size', () => {
    assert.ok(everySize.includes('.prl-coach'), 'read no rules outside @media');
    assert.doesNotMatch(everySize, /hyphens\s*:\s*auto/);
  });
});
