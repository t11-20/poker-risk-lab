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
 *  4. 360px, `/legends`: three full difficulty options made the picker 849px of the 3,230 above the
 *     first "Play this style".
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

  /*
    4. 360px, `/legends`: the picker was 849px — three full option blocks — and the first Play sat
       at y=3,230. On a phone only the ticked option now shows its description (602px, 247px off
       the first Play); the other two keep their name and Coach chip. See the comment in
       `legends.css` for the three alternatives measured and why each was turned down.
  */
  describe('on a phone only the ticked difficulty shows its description', () => {
    const picker = readFileSync(join(SRC, 'components', 'DifficultyPicker.tsx'), 'utf8');
    const PHONE = /@media \(width < 600px\) \{([\s\S]*?)\n\}/gu;
    const phoneBlocks = [...css.matchAll(PHONE)].map((match) => match[1] ?? '');
    const UNTICKED =
      '.prl-legend-difficulty__option:not(:has(.prl-legend-difficulty__control:checked))\n' +
      '    > .prl-legend-difficulty__description {';

    /** The declarations of the unticked-description rule, from whichever phone block holds it. */
    function untickedRule(): string {
      assert.ok(phoneBlocks.length > 0, 'no `@media (width < 600px)` block in legends.css');
      for (const block of phoneBlocks) {
        const at = block.indexOf(UNTICKED);
        if (at >= 0) return block.slice(at + UNTICKED.length, block.indexOf('}', at));
      }
      assert.fail('no phone rule for the description of an option whose radio is not checked');
    }

    it('hides it with the visually-hidden idiom, so it stays in the radio’s accessible name', () => {
      const declarations = untickedRule();
      assert.match(declarations, /clip-path: inset\(50%\);/u);
      assert.match(declarations, /position: absolute;/u);
      assert.match(declarations, /width: 1px;/u);
      assert.doesNotMatch(declarations, /display: none|visibility: hidden/u);
    });

    it('the label still wraps the description, which is what puts it in the name', () => {
      assert.match(
        picker,
        /<label className="prl-legend-difficulty__option"[\s\S]*?<p className="prl-legend-difficulty__description">[\s\S]*?<\/label>/u,
      );
    });

    it('the Coach chip is never hidden: every option shows what it does to the Coach', () => {
      assert.ok(phoneBlocks.length > 0, 'no `@media (width < 600px)` block in legends.css');
      for (const block of phoneBlocks) {
        const hides = /([^{}]*)\{[^}]*(?:clip-path|display: none)[^}]*\}/gu;
        for (const [, selector] of block.matchAll(hides)) {
          assert.doesNotMatch(selector ?? '', /__coach/u, `phone rule hides the Coach chip: ${selector}`);
        }
      }
    });

    it('the 1px box is positioned inside its own option, not against the page', () => {
      assert.ok(
        phoneBlocks.some((block) =>
          /\.prl-legend-difficulty__option \{[^}]*position: relative;/u.test(block),
        ),
      );
    });
  });

  it('the card grid takes two columns at tablet width', () => {
    assert.match(
      css,
      /@media \(720px <= width < 900px\) \{\s*\.prl-legend-grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u,
    );
  });
});
