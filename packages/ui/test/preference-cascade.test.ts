/**
 * A stated accessibility preference must win the cascade over the theme scope.
 * A media query adds no specificity, so a preference block on bare `:root` is (0,1,0) and loses to
 * `:root[data-theme="light"]` and `:root:not([data-theme="dark"])`, both (0,2,0). Light-theme readers
 * who asked for reduced transparency kept `--prl-glass-floating: #fffffff0` with no blur behind it.
 * No theme scope may beat a preference block on the same token, by specificity then source order.
 * Fix a failure by raising the preference selector, not lowering the theme one.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const tokensCss = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

interface Declaration {
  /** The `@media` prelude this declaration sits under, or `''` at the top level. */
  readonly atRule: string;
  readonly selector: string;
  readonly property: string;
  /** Source order, so a tie on specificity can be broken the way a browser breaks it. */
  readonly order: number;
}

/**
 * The brace-depth scan `scripts/check-contrast.mjs` uses. Token values here cannot contain `{`, `}`
 * or `;`, so a character walk is safe. Comments are stripped first so a commented-out token is not read.
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
 * Specificity as the (b, c, d) triple. Only the shapes this file uses are supported, and an
 * unrecognised selector fails rather than scoring zero, which would pass whatever it cannot read.
 */
function specificity(selector: string): readonly [number, number, number] {
  const trimmed = selector.trim();
  assert.match(
    trimmed,
    /^:root(?::root)*(?:\[[a-z-]+(?:="[a-z-]+")?\])?(?::not\(\[[a-z-]+="[a-z-]+"\]\))?$/u,
    `preference-cascade.test.ts does not know how to score the selector \`${trimmed}\`. Teach it ` +
      'rather than letting it score an unknown selector as least specific.',
  );
  // `:root` and `[attr]` both count in column c. `:not()` adds only its argument's `[`.
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
 * A theme scope's specificity, or `null` if this is not one. A `prefers-color-scheme` block counts too,
 * because it carries `:not([data-theme="dark"])`.
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
