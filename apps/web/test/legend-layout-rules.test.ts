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
const legendCard = readFileSync(join(SRC, 'components', 'LegendCard.tsx'), 'utf8');
const postHand = readFileSync(join(SRC, 'components', 'PostHandComparison.tsx'), 'utf8');
const comparePage = readFileSync(join(SRC, 'app', 'legends', 'compare', 'page.tsx'), 'utf8');
const tokens = readFileSync(
  join(SRC, '..', '..', '..', 'packages', 'ui', 'src', 'styles', 'tokens.css'),
  'utf8',
);

/** A `calc()` of `--prl-space-*` tokens, sums and products only, in rem. */
function rem(expression: string): number {
  const resolved = expression.replace(/var\((--prl-space-\d+)\)/gu, (_, name: string) => {
    const value = new RegExp(`${name}: ([\\d.]+)rem;`, 'u').exec(tokens)?.[1];
    assert.ok(value !== undefined, `no rem value for ${name} in tokens.css`);
    return value;
  });
  const sum = /^calc\(([\d.\s+*]+)\)$/u.exec(resolved)?.[1];
  assert.ok(sum !== undefined, `not a sum of space tokens: ${expression}`);
  return sum
    .split('+')
    .map((term) => term.split('*').reduce((product, factor) => product * Number(factor), 1))
    .reduce((total, term) => total + term, 0);
}

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

  it('a card shares its row lines with its neighbours, one line per child, so the actions align', () => {
    const card = rule('.prl-legend-grid > .prl-legend-card');
    assert.match(card, /grid-template-rows: subgrid;/u);
    const span = Number(/grid-row: span (\d+);/u.exec(card)?.[1]);
    const body =
      /<article className=\{cx\('prl-legend-card', className\)\}>\n([\s\S]*?)\n {4}<\/article>/u.exec(
        legendCard,
      )?.[1];
    assert.ok(body !== undefined, 'no card article in LegendCard.tsx');
    const children = body.split('\n').filter((line) => /^ {6}<[A-Za-z]/u.test(line));
    assert.equal(children.length, span, `LegendCard has ${children.length} children and spans ${span} rows`);
  });

  it('two-column cards put the name under the sigil, so a name has the card’s width', () => {
    assert.match(
      css,
      /@media \(720px <= width < 900px\) \{\s*\.prl-legend-grid \.prl-legend-identity \{\s*flex-direction: column;/u,
    );
  });

  /* Two plus one left a 250-290px hole at 600-834; the grids are 291px in a card and 707px on a profile. */
  it('the three-item grids are three across or one column, decided by their own width', () => {
    const shared = rule(
      '.prl-legend-card__metrics,\n.prl-legend-maths,\n.prl-legend-contrast:has(> :nth-child(3):last-child)',
    );
    assert.match(
      shared.replace(/\s+/gu, ' '),
      /repeat\( auto-fit, minmax\(min\(100%, max\(25%, \(var\(--prl-legend-thirds-at\) - 100%\) \* 999\)\), 1fr\) \)/u,
    );
    assert.match(
      shared,
      /--prl-legend-thirds-at: calc\(3 \* var\(--prl-legend-thirds-min\) \+ 2 \* var\(--prl-legend-thirds-gap\)\);/u,
    );
    for (const selector of ['.prl-legend-card__metrics', '.prl-legend-contrast', '.prl-legend-maths']) {
      const own = new RegExp(`\\}\\s*${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'u').exec(css)?.[1];
      assert.ok(own !== undefined, `no rule of its own for ${selector}`);
      assert.match(own, /--prl-legend-thirds-gap: var\(--prl-space-\d+\);/u, `${selector} sets no gap`);
      const floor = /--prl-legend-thirds-min: ([^;]+);/u.exec(own)?.[1];
      assert.ok(floor !== undefined, `${selector} sets no floor`);
      // "Three across once each clears about 160px": never a narrower floor than that.
      assert.ok(
        rem(floor.startsWith('calc(') ? floor : `calc(${floor})`) >= 10,
        `${selector} floor ${floor}`,
      );
      // Contrast keeps its own tracks as a fallback for any count but three; the rest never override.
      if (selector === '.prl-legend-contrast') continue;
      assert.doesNotMatch(
        own,
        /grid-template-columns|(?:^|\s)gap:/u,
        `${selector} overrides the shared tracks`,
      );
    }
  });

  it('a compare checkbox is wide enough for the longest name on one line', () => {
    assert.match(
      rule('.prl-legend-picker__options'),
      /minmax\(min\(100%, var\(--prl-legend-pick-min\)\), 1fr\)/u,
    );
    const floor = /--prl-legend-pick-min: (calc\([^;]+\));/u.exec(css)?.[1];
    assert.ok(floor !== undefined, 'no --prl-legend-pick-min');
    // 233px of "High-Variance Tournament Aggressor" at 14px, plus 47px of padding, border, box and gap.
    assert.ok(rem(floor) * 16 >= 233 + 47, `the floor is ${rem(floor) * 16}px`);
  });

  it('the "what would change it" lists are held to the measure', () => {
    for (const [name, source] of [
      ['compare', comparePage],
      ['PostHandComparison', postHand],
    ] as const) {
      assert.match(source, /What would (?:have )?changed? it<\/span>\s*<ul className="prl-prose">/u, name);
    }
  });

  it('the Coach’s lists take the measure on the Legends and review pages, not on /play', () => {
    const review = readFileSync(join(SRC, 'styles', 'review.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
    for (const [name, sheet, page] of [
      ['legends.css', css, '.prl-legend-page'],
      ['review.css', review, '.prl-review-page'],
    ] as const) {
      const scoped = new RegExp(
        `\\n\\${page} :is\\(\\.prl-coach__list, \\.prl-uncertainty__limitations\\) \\{\\s*max-width: var\\(--prl-measure\\);`,
        'u',
      );
      assert.match(sheet, scoped, name);
    }
    // The Coach on /play is held, so the shared rules carry no cap of their own.
    const shared = readFileSync(
      join(SRC, '..', '..', '..', 'packages', 'ui', 'src', 'styles', 'components.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//gu, '');
    for (const selector of ['.prl-coach__list', '.prl-uncertainty__limitations']) {
      // Innermost rules at any depth, so a cap inside a media or container query is read too.
      const subject = new RegExp(`${selector.replace('.', '\\.')}(?![\\w-])[^\\s>+~]*$`, 'u');
      const rules = [...shared.matchAll(/([^{};]+)\{([^{}]*)\}/gu)].filter(([, head]) =>
        (head ?? '').split(',').some((part) => subject.test(part.trim())),
      );
      assert.ok(rules.length > 0, `components.css has no rule for ${selector}`);
      for (const [, , body] of rules) assert.doesNotMatch(body ?? '', /max-width|max-inline-size/u, selector);
    }
  });

  it('the hand-review board is drawn at the size of the other boards, not beside its label at 32px', () => {
    assert.match(postHand, /label="Community cards" size="md"/u);
  });
});
