/**
 * The sizer's "Raise to" field kept a bare input's 4px corner in a row of capsules. It takes the
 * shape and inline padding every `.prl-input` has.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** What the rules naming `selector` exactly set `property` to, the last one winning; at-rules included. */
function value(selector: string, property: string): string | undefined {
  let found: string | undefined;
  for (const [, list = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!list.split(',').some((part) => part.trim() === selector)) continue;
    const hit = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`).exec(body)?.[1];
    if (hit !== undefined) found = hit.trim();
  }
  return found;
}

describe('the sizer’s number field', () => {
  it('is the capsule a text field is', () => {
    const shape = value('.prl-input', 'border-radius');
    assert.equal(shape, 'var(--prl-control-radius)');
    assert.equal(value('.prl-sizer__number', 'border-radius'), shape);
  });

  it('pads its ends as a text field does, so the digits and spinner clear the end caps', () => {
    const pad = value('.prl-input', 'padding-inline');
    assert.equal(pad, 'var(--prl-control-pad-field)');
    assert.equal(value('.prl-sizer__number', 'padding-inline'), pad);
  });

  it('sits beside preset pills', () => {
    assert.equal(value('.prl-preset', 'border-radius'), 'var(--prl-radius-pill)');
  });
});
