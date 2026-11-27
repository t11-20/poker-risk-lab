/**
 * A seat's stack was set in amber `caution`, which the design system reserves for a risk (2.2). A stack
 * is a figure, so it takes the text ink, as the pot's own figures do.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Every `color` set by a rule whose selector list names `selector` exactly, in source order. */
function colours(selector: string): string[] {
  const found: string[] = [];
  for (const [, list = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!list.split(',').some((part) => part.trim() === selector)) continue;
    const colour = /(?:^|;)\s*color:\s*([^;]+);/.exec(body)?.[1];
    if (colour !== undefined) found.push(colour.trim());
  }
  return found;
}

describe('a seat’s stack', () => {
  it('is set in the text ink, as the pot’s amount is', () => {
    assert.deepEqual(colours('dd.prl-seat__stat-value'), ['var(--prl-text)']);
    assert.deepEqual(colours('.prl-pot__side-amount'), ['var(--prl-text)']);
  });

  // The test above reads the bare selector only, and a state rule could still recolour the stack.
  it('is never set in a risk or result colour by any rule naming it', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, list = '']) =>
      list.includes('prl-seat__stat-value'),
    );
    assert.ok(rules.length > 0, 'no rule names the stack');
    for (const [, list = '', body = ''] of rules) {
      assert.doesNotMatch(body, /(?:^|;)\s*color:[^;]*(?:caution|adverse|favourable)/, list.trim());
    }
  });
});
