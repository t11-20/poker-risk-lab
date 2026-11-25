/**
 * A list that sits beside prose is held to the same measure. Uncapped, the Coach's notes ran 88
 * characters a line on /legends/compare and the limitations 87 to 120 on /review.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//gu,
  '',
);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, 'u').exec(css);
  assert.ok(match !== null, `no rule for ${selector} in components.css`);
  return match[1] ?? '';
}

describe('lists beside prose', () => {
  for (const [list, prose] of [
    ['.prl-coach__list', '.prl-coach__prose'],
    ['.prl-uncertainty__limitations', '.prl-uncertainty__summary'],
  ] as const) {
    it(`${list} is capped at the measure, as ${prose} is`, () => {
      assert.match(rule(prose), /max-width: var\(--prl-measure\);/u);
      assert.match(rule(list), /max-width: var\(--prl-measure\);/u);
    });
  }
});
