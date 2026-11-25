/**
 * At 360px with 200% text a nowrap chip and a nowrap equity detail each pushed pages past the
 * screen. These read the rules that let them wrap instead.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** The body of the first `@media` block whose prelude is exactly `prelude`, braces matched. */
function mediaBody(sheet: string, prelude: string): string {
  const head = sheet.indexOf(`@media ${prelude} {`);
  assert.ok(head >= 0, `no @media ${prelude} block`);
  const start = sheet.indexOf('{', head) + 1;
  let depth = 1;
  for (let i = start; i < sheet.length; i += 1) {
    if (sheet[i] === '{') depth += 1;
    if (sheet[i] === '}') depth -= 1;
    if (depth === 0) return sheet.slice(start, i);
  }
  throw new Error(`@media ${prelude} is never closed`);
}

/** `sheet` with every `@media` block removed, so only rules that apply at every size remain. */
function withoutMedia(sheet: string): string {
  let out = sheet;
  for (let head = out.indexOf('@media'); head >= 0; head = out.indexOf('@media')) {
    const prelude = out.slice(head + '@media'.length, out.indexOf('{', head)).trim();
    const body = mediaBody(out, prelude);
    out = out.slice(0, head) + out.slice(out.indexOf(body, head) + body.length + 1);
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

describe('the equity detail', () => {
  it('wraps inside the two tracks it spans', () => {
    const detail = cascaded(everySize, '.prl-equity-bar__detail');
    assert.equal(detail.get('grid-column'), '2 / -1');
    assert.equal(detail.get('white-space'), 'normal');
  });
});
