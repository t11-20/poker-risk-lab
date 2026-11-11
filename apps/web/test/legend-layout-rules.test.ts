/**
 * Three layout defects on the Legends pages, measured in Chrome against the running build, held
 * here as the rules that fixed them. `test:layout` measures glyphs and would not call any of these
 * a failure — nothing overlaps or clips — so without this nothing would notice them coming back.
 *
 *  1. 360px, `/legends/calling-station`: "03 Aggression [Signature axis] 0.16" filled the row and
 *     "OF 1" wrapped onto a line of its own, a scale with no figure beside it.
 *  2. 768px, `/legends`: the three difficulty options laid out two on a row and one alone beside an
 *     empty cell (two 322px options at y=806, the third at y=1000).
 *  3. 1440px: each radio was centred across the option's name AND description, so it sat beside
 *     the description — dot centre 72px into the option, name centre 29px.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(join(SRC, 'styles', 'legends.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
const traitBars = readFileSync(join(SRC, 'components', 'TraitBars.tsx'), 'utf8');

/** The declarations of the first top-level rule with exactly this selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, 'u').exec(css);
  assert.ok(match !== null, `no rule for ${selector} in legends.css`);
  return match[1] ?? '';
}

describe('legends layout rules', () => {
  it('a trait figure and its "of 1" are one unit that does not wrap apart', () => {
    assert.match(
      traitBars,
      /<span className="prl-legend-traits__figure">\s*<span className="prl-legend-traits__value">[\s\S]*?<span className="prl-label">of 1<\/span>\s*<\/span>/u,
    );
    const figure = rule('.prl-legend-traits__figure');
    assert.match(figure, /white-space: nowrap/u);
    assert.match(figure, /flex: 0 0 auto/u);
  });

  it('the difficulty options are three across or one column, decided by the picker’s own width', () => {
    assert.match(rule('.prl-legend-difficulty'), /container: prl-legend-difficulty \/ inline-size/u);
    assert.match(
      css,
      /@container prl-legend-difficulty \(width < 46\.5rem\) \{\s*\.prl-legend-difficulty__options \{\s*grid-template-columns: minmax\(0, 1fr\);/u,
    );
  });

  it('the radio sits on the row of the option’s name, not across the description', () => {
    const control = rule('.prl-legend-difficulty__control');
    assert.match(control, /grid-row: 1;/u);
    assert.doesNotMatch(control, /span 2/u);
  });

  it('the card grid takes two columns at tablet width', () => {
    assert.match(
      css,
      /@media \(720px <= width < 900px\) \{\s*\.prl-legend-grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u,
    );
  });
});
