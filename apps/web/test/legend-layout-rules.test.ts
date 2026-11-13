/**
 * Layout defects on the Legends pages, held as the rules that fixed them. `test:layout` measures
 * glyphs, and nothing in these overlaps or clips: a trait's "of 1" wrapping alone at 360px, two
 * difficulty options beside an empty cell at 768px, and a radio centred on the description.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(join(SRC, 'styles', 'legends.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
const traitBars = readFileSync(join(SRC, 'components', 'TraitBars.tsx'), 'utf8');

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

  /* At 360px the picker was 849px; `legends.css` records the alternatives measured and turned down. */
  describe('on a phone only the ticked difficulty shows its description', () => {
    const picker = readFileSync(join(SRC, 'components', 'DifficultyPicker.tsx'), 'utf8');
    const PHONE = /@media \(width < 600px\) \{([\s\S]*?)\n\}/gu;
    const phoneBlocks = [...css.matchAll(PHONE)].map((match) => match[1] ?? '');
    const UNTICKED =
      '.prl-legend-difficulty__option:not(:has(.prl-legend-difficulty__control:checked))\n' +
      '    > .prl-legend-difficulty__description {';

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
