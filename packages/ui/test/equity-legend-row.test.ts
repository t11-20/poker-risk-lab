/**
 * An equity legend row is swatch, name and value on one line, with the detail under the name. As a
 * wrapping flex row, a name too long for the line took a line of its own and left the swatch alone above it.
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

describe('the equity legend row', () => {
  it('is three tracks, so the name wraps inside its own column', () => {
    const row = rule('.prl-equity-bar__row');
    assert.match(row, /display: grid;/u);
    assert.match(row, /grid-template-columns: auto minmax\(0, 1fr\) auto;/u);
    assert.doesNotMatch(row, /flex-wrap/u);
  });

  it('puts the value in the last track and the detail under the name', () => {
    assert.match(rule('.prl-equity-bar__value'), /grid-column: 3;/u);
    assert.match(rule('.prl-equity-bar__detail'), /grid-column: 2 \/ -1;/u);
  });
});
