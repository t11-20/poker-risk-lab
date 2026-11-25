/**
 * Tablet-width defects on Learn, home, /checks and the 404, held as the rules that fixed them. Each was
 * measured in Chrome at 600-1280px; `test:layout` sees none of them, since nothing overlaps or clips.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const TOKENS = join(SRC, '..', '..', '..', 'packages', 'ui', 'src', 'styles', 'tokens.css');
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//gu, '');
const style = (file: string): string => stripComments(readFileSync(join(SRC, 'styles', file), 'utf8'));
const source = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

const SPACE = new Map<string, number>(
  [...readFileSync(TOKENS, 'utf8').matchAll(/--prl-space-(\d+): ([\d.]+)rem;/gu)].map(
    (m) => [`var(--prl-space-${m[1]})`, Number(m[2])] as const,
  ),
);

/** A spacing token in rem. */
function rem(token: string): number {
  const value = SPACE.get(token.trim());
  assert.ok(value !== undefined, `${token} is not a --prl-space-* token`);
  return value;
}

/** The body of the block opened by `opener`, braces balanced. */
function block(css: string, opener: string): string {
  const at = css.indexOf(`${opener} {`);
  assert.ok(at >= 0, `no "${opener}" block`);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(css.indexOf('{', at) + 1, i);
    }
  }
  assert.fail(`"${opener}" is never closed`);
}

/** The declarations of `selector` at the top level of `css` (a stylesheet or a block body). */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|[\\n}])\\s*${escaped} \\{([^}]*)\\}`, 'u').exec(css);
  assert.ok(match !== null, `no rule for ${selector}`);
  return match[1] ?? '';
}

function declared(declarations: string, property: string): string {
  const value = new RegExp(`(?:^|[;{\\s])${property}: ([^;]+);`, 'u').exec(declarations)?.[1];
  assert.ok(value !== undefined, `no ${property}`);
  return value.trim();
}

describe('a lesson heading from 900px', () => {
  const learn = style('learn.css');
  const wide = block(learn, '@media (min-width: 900px)');

  it('hangs its index inside the sheet padding, clear of the border', () => {
    const sheetX = rem(declared(rule(wide, '.prl-learn-lesson'), '--prl-learn-sheet-x'));
    const index = rule(wide, '.prl-learn-lesson__heading-index');
    const slot = rem(declared(index, 'inline-size'));
    const token = String.raw`(var\(--prl-space-\d+\))`;
    const margins = new RegExp(String.raw`^calc\(-1 \* \(${token} \+ ${token}\)\) ${token}$`, 'u').exec(
      declared(index, 'margin-inline'),
    );
    assert.ok(margins !== null, 'the index hangs by its slot plus its gap');
    const [, hangSlot = '', hangGap = '', after = ''] = margins;
    assert.equal(rem(hangSlot), slot, 'the hang is the slot itself');
    assert.equal(rem(hangGap), rem(after), 'the margins cancel the width, so the title is on the prose edge');
    // 900-1280px measured the glyph at the border (0px) when the hang filled the padding.
    assert.ok(sheetX - (slot + rem(after)) >= rem('var(--prl-space-5)'), 'the index clears the border');
  });

  it('draws its rule across the column, with the measure on the title track', () => {
    const heading = rule(wide, '.prl-learn-lesson__heading');
    assert.equal(declared(heading, 'max-width'), 'none');
    assert.equal(declared(heading, 'grid-template-columns'), '0 minmax(0, var(--prl-measure))');
    assert.doesNotMatch(heading, /margin-inline/u, 'the bordered box starts on the prose edge');
  });
});

describe('the calculator inputs never leave one alone on a row', () => {
  const learn = style('learn.css');

  it('know how many inputs they hold, and measure the calculator', () => {
    assert.match(
      source('components', 'LiveCalculation.tsx'),
      /<dl className="prl-learn-calc__inputs" data-inputs=\{props\.inputs\.length\}>/u,
    );
    assert.equal(declared(rule(learn, '.prl-learn-calc'), 'container'), 'prl-learn-calc / inline-size');
  });

  it('go across only at widths where every column is a whole track of the 8rem floor', () => {
    const base = rule(learn, '.prl-learn-calc__inputs');
    const floor = /minmax\(min\(100%, (var\(--prl-space-\d+\))\), 1fr\)/u.exec(
      declared(base, 'grid-template-columns'),
    )?.[1];
    assert.ok(floor !== undefined, 'the base grid is an auto-fit floor');
    const columnGap = rem(declared(base, 'gap').split(' ')[1] ?? '');
    const padding = rem(declared(base, 'padding'));
    assert.match(declared(base, 'border'), /^1px /u);
    const fits = (k: number): number => k * rem(floor) + (k - 1) * columnGap + 2 * padding + 2 / 16;

    assert.equal(
      declared(
        rule(learn, '.prl-learn-calc__inputs:is([data-inputs="3"], [data-inputs="4"])'),
        'grid-template-columns',
      ),
      'minmax(0, 1fr)',
    );
    const across = [
      ...learn.matchAll(
        new RegExp(
          String.raw`@container prl-learn-calc \(width >= ([\d.]+)rem\) \{\s*` +
            String.raw`\.prl-learn-calc__inputs\[data-inputs="(\d)"\] \{\s*` +
            String.raw`grid-template-columns: repeat\((\d), minmax\(0, 1fr\)\);`,
          'gu',
        ),
      ),
    ].map((m) => ({ width: Number(m[1]), inputs: Number(m[2]), columns: Number(m[3]) }));
    assert.ok(across.length > 0, 'a sweep of nothing is not a pass');
    for (const step of across) {
      assert.equal(step.inputs % step.columns, 0, `${step.inputs} inputs in ${step.columns} columns`);
      assert.equal(
        step.width,
        fits(step.columns),
        `${step.columns} tracks fit from ${fits(step.columns)}rem`,
      );
    }
    assert.deepEqual(across.map((step) => `${step.inputs}:${step.columns}`).sort(), ['3:3', '4:2', '4:4']);
  });
});

it('the home example ends its two figures on one line when only one label wraps', () => {
  assert.equal(declared(rule(style('home.css'), '.prl-spot__figures'), 'align-items'), 'end');
});

describe('/checks', () => {
  const checks = style('checks.css');

  it('draws one rule under the page head, not two', () => {
    assert.equal(declared(rule(checks, '.prl-checks__row:first-child'), 'border-block-start'), '0');
  });

  it('closes with a rule as wide as the rows, with the measure on its text', () => {
    assert.doesNotMatch(rule(checks, '.prl-checks__source'), /max-width/u);
    assert.equal(declared(rule(checks, '.prl-checks__source > *'), 'max-width'), 'var(--prl-measure)');
  });

  it('gives each claim one line beside its evidence, the evidence aligned across rows', () => {
    const wide = block(checks, '@media (min-width: 900px)');
    const claim = declared(rule(wide, '.prl-checks'), 'grid-template-columns').split(') ')[0] ?? '';
    assert.match(claim, /max-content$/u, 'the claim track grows to its longest claim');
    const row = rule(wide, '.prl-checks__row');
    assert.equal(declared(row, 'grid-template-columns'), 'subgrid');
    assert.equal(declared(row, 'grid-column'), '1 / -1');
  });
});

it('the 404 sets each description nearer its own link than the next', () => {
  assert.match(
    source('app', 'not-found.tsx'),
    /<ul className="prl-footer__list prl-footer__list--described">/u,
  );
  assert.doesNotMatch(source('components', 'SiteFooter.tsx'), /prl-footer__list--described/u);
  const globals = stripComments(source('app', 'globals.css'));
  // Measured: 19px from a description up to its label, and 18px plus (gap - 2px) down to the next.
  assert.ok(rem(declared(rule(globals, '.prl-footer__list--described'), 'gap')) >= 1);
});
