/**
 * A stated accessibility preference must WIN, and in this stylesheet it did not.
 *
 * ## The defect this exists for
 *
 * `tokens.css` collapses the glass ladder to opaque surfaces under three preferences —
 * `prefers-reduced-transparency: reduce`, `prefers-contrast: more` and `forced-colors: active`
 * — and each block wrote its overrides on a bare `:root`. A media query contributes nothing to
 * specificity, so those blocks are (0,1,0), and the light theme is declared twice at (0,2,0):
 *
 *   - `:root[data-theme="light"]`, the reader who used the theme switch; and
 *   - `:root:not([data-theme="dark"])` inside `@media (prefers-color-scheme: light)`, the
 *     reader whose operating system is light. `:not()` takes the specificity of its argument,
 *     so that is (0,2,0) as well — the `:not()` is there to let the switch turn the light
 *     theme off, and raising the specificity is a side effect of it that nothing accounted for.
 *
 * Both scopes set `--prl-glass-floating`, `--prl-glass-overlay` and the `--prl-edge*` family, so
 * both beat the preference blocks and neither collapse happened for any light-theme reader.
 * Measured in Chrome 151 at 1440x900 against the production build, `prefers-color-scheme: light`
 * emulated:
 *
 *   reduce transparency, `data-theme="light"`  --prl-glass-floating  #fffffff0  (94% translucent)
 *   reduce transparency, no `data-theme`       --prl-glass-floating  #fffffff0  (94% translucent)
 *   contrast: more,      `data-theme="light"`  --prl-edge            #10141a1a  (~1.1:1 on white)
 *   contrast: more,      no `data-theme`       --prl-edge            #10141a1a  (~1.1:1 on white)
 *
 * After the fix, all four are `#fff` and `#6e7885` (4.34:1) respectively. What made this
 * invisible is that only the FILTER collapsed — `--prl-glass-filter` is not set by either theme
 * scope — so the result was a translucent pane with no blur behind it, which is precisely the
 * ghosting failure `apps/web/src/styles/nav.css` documents. A reader who asked their operating
 * system to remove translucency got the worst available combination of it.
 *
 * ## What this asserts
 *
 * For every custom property that a preference block sets, no theme scope that sets the same
 * property may beat it in the cascade — specificity first, then source order. That is the whole
 * rule, and it is expressed as arithmetic over the selectors rather than as "write this
 * selector", so it keeps holding when either side is rewritten.
 *
 * This is the same trap `layout-guarantees.test.ts` guards for `text-align: end` on a table
 * cell, one layer down: a declaration that never applies reads as done.
 *
 * Reproduce the rendered half — which is the half that matters — by emulating the preference in
 * Chrome and reading the resolved value off the root element:
 *
 *     Emulation.setEmulatedMedia features: prefers-color-scheme=light,
 *                                          prefers-reduced-transparency=reduce
 *     getComputedStyle(document.documentElement).getPropertyValue('--prl-glass-floating')
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const tokensCss = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

interface Declaration {
  /** The `@media` prelude this declaration sits under, or `''` at the top level. */
  readonly atRule: string;
  /** The selector the declaration is written on. */
  readonly selector: string;
  readonly property: string;
  /** Source order, so a tie on specificity can be broken the way a browser breaks it. */
  readonly order: number;
}

/**
 * The same crude brace-depth scan `scripts/check-contrast.mjs` uses, and for the same reason:
 * custom-property values in this file cannot contain `{`, `}` or `;`, so a character walk is
 * safe and a CSS parser would be a dependency nobody has read. Comments go first — a
 * commented-out token read as a real one is exactly the quiet wrongness a guard must not have.
 */
function scan(css: string): readonly Declaration[] {
  const out: Declaration[] = [];
  const stack: string[] = [];
  let buffer = '';
  let order = 0;

  for (const character of css.replace(/\/\*[\s\S]*?\*\//gu, '')) {
    if (character === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (character === '}') {
      stack.pop();
      buffer = '';
    } else if (character === ';') {
      const colon = buffer.indexOf(':');
      const property = colon > 0 ? buffer.slice(0, colon).trim() : '';
      if (property.startsWith('--prl-')) {
        const selector = stack.at(-1) ?? '';
        const atRule = stack.length > 1 ? (stack[0] ?? '') : '';
        order += 1;
        out.push({ atRule, selector, property, order });
      }
      buffer = '';
    } else {
      buffer += character;
    }
  }

  return out;
}

/**
 * Selector specificity as the (b, c, d) triple CSS defines: ids, then classes / attributes /
 * pseudo-classes, then element names and pseudo-elements. Only the shapes this file uses are
 * supported, and anything unrecognised is a failure rather than a zero — a guard that scores an
 * unfamiliar selector as "least specific" is a guard that passes whatever it does not understand.
 */
function specificity(selector: string): readonly [number, number, number] {
  const trimmed = selector.trim();
  assert.match(
    trimmed,
    /^:root(?::root)*(?:\[[a-z-]+(?:="[a-z-]+")?\])?(?::not\(\[[a-z-]+="[a-z-]+"\]\))?$/u,
    `preference-cascade.test.ts does not know how to score the selector \`${trimmed}\`. Teach it ` +
      'rather than letting it score an unknown selector as least specific.',
  );
  // Each `:root` is a pseudo-class and each `[attr]` an attribute selector, both in column c.
  // `:not()` itself adds nothing — it contributes the specificity of its argument, and the
  // argument's `[` is already counted by the same expression.
  const classes = (trimmed.match(/:root/gu) ?? []).length + (trimmed.match(/\[/gu) ?? []).length;
  return [0, classes, 0];
}

const beats = (a: readonly [number, number, number], b: readonly [number, number, number]): number => {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
};

/** The at-rules whose whole purpose is to override the palette for a reader who asked. */
const PREFERENCE_AT_RULES = [
  'prefers-reduced-transparency',
  'prefers-contrast',
  'forced-colors',
  'prefers-reduced-motion',
] as const;

const isPreference = (declaration: Declaration): boolean =>
  PREFERENCE_AT_RULES.some((name) => declaration.atRule.includes(name));

/**
 * A theme scope, and the specificity of its selector — or `null` if this is not one.
 *
 * Both ways of being in a theme count, because both of them beat a bare `:root`: the selector
 * that names `data-theme` directly, and anything inside a `prefers-color-scheme` query, which
 * in this file carries `:not([data-theme="dark"])` so the switch can turn it off.
 */
function themeSpecificity(declaration: Declaration): readonly [number, number, number] | null {
  if (declaration.selector.includes('[data-theme')) return specificity(declaration.selector);
  if (declaration.atRule.includes('prefers-color-scheme')) return specificity(declaration.selector);
  return null;
}

describe('a preference a reader stated outranks the theme they are in', () => {
  const declarations = scan(tokensCss);

  it('has found both kinds of scope to compare (a sweep of nothing is not a pass)', () => {
    assert.ok(
      declarations.filter(isPreference).length > 0,
      'no preference block sets any --prl-* token; this guard would pass over nothing',
    );
    assert.ok(
      declarations.filter((d) => themeSpecificity(d) !== null).length > 0,
      'no theme scope sets any --prl-* token; this guard would pass over nothing',
    );
  });

  it('never lets a theme scope beat a preference block on the same token (REGRESSION)', () => {
    const preferences = declarations.filter(isPreference);
    const themes = declarations.filter((d) => themeSpecificity(d) !== null);
    const offenders: string[] = [];
    let compared = 0;

    for (const preference of preferences) {
      const preferenceSpecificity = specificity(preference.selector);
      for (const theme of themes) {
        if (theme.property !== preference.property) continue;
        compared += 1;
        const themeScore = themeSpecificity(theme);
        assert.ok(themeScore !== null);
        const verdict = beats(themeScore, preferenceSpecificity);
        const themeWins = verdict > 0 || (verdict === 0 && theme.order > preference.order);
        if (themeWins) {
          offenders.push(
            `${preference.property}: \`${theme.atRule || 'top level'} { ${theme.selector} }\` ` +
              `(${themeScore.join(',')}) beats \`${preference.atRule} { ${preference.selector} }\` ` +
              `(${preferenceSpecificity.join(',')}), so the preference never applies`,
          );
        }
      }
    }

    assert.ok(compared > 0, 'no token is set by both a preference block and a theme scope to compare');
    assert.deepEqual(
      offenders,
      [],
      'A preference block that loses the cascade is a declaration that never applies, which reads ' +
        'as done. Raise the preference selector rather than lowering the theme one — see the header ' +
        `of this file.\n  ${offenders.join('\n  ')}`,
    );
  });
});
