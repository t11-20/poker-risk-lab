/**
 * `repeat(auto-fit, minmax(<length>, 1fr))` is a hard floor, and a hard floor overflows.
 * A bare length in `minmax()` cannot resolve below itself, so the container overflows instead of the
 * track shrinking. At 360x640 a 19rem floor in `.prl-coach__grid` scrolled `/review/hand-0042` 2px
 * sideways and stretched six sibling panes past the gutter. `min(100%, <length>)` collapses only when
 * needed. Accepted floors are `min(100%, …)`, `min(…, 100%)`, `auto` and `min-content`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/** The same stylesheets the glass guard in `layout-guarantees.test.ts` scans, app routes included. */
const ROUTE_STYLE_DIR = new URL('../../../apps/web/src/styles/', import.meta.url);
const SCANNED: readonly (readonly [string, string])[] = [
  [
    'packages/ui components.css',
    readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8'),
  ],
  ['packages/ui base.css', readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8')],
  [
    'apps/web globals.css',
    readFileSync(new URL('../../../apps/web/src/app/globals.css', import.meta.url), 'utf8'),
  ],
  ...readdirSync(ROUTE_STYLE_DIR)
    .filter((file) => file.endsWith('.css'))
    .sort()
    .map((file) => [`apps/web ${file}`, readFileSync(new URL(file, ROUTE_STYLE_DIR), 'utf8')] as const),
];

/**
 * `repeat(auto-fit, minmax(…` up to the comma that closes the first `minmax()` argument.
 * Counts brackets because floors nest (`min(100%, calc(…))`), and a match to the first comma would
 * report `min(100%` and pass hard floors.
 */
function autoFitFloors(css: string): readonly string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const floors: string[] = [];
  const opener = /repeat\(\s*auto-(?:fit|fill)\s*,\s*minmax\(/gu;
  let match = opener.exec(withoutComments);
  while (match !== null) {
    let depth = 0;
    let floor = '';
    for (let i = opener.lastIndex; i < withoutComments.length; i += 1) {
      const character = withoutComments[i] ?? '';
      if (character === '(') depth += 1;
      else if (character === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (character === ',' && depth === 0) break;
      floor += character;
    }
    floors.push(floor.trim().replace(/\s+/gu, ' '));
    match = opener.exec(withoutComments);
  }
  return floors;
}

/** A floor that can give way when the container is narrower than it. */
const COLLAPSIBLE = /^(auto|min-content|min\(\s*100%\s*,|min\((?:[^()]|\([^()]*\))*,\s*100%\s*\))/u;

describe('an auto-fit track floor can always collapse', () => {
  it('never writes a hard minimum into repeat(auto-fit, minmax(…)) (REGRESSION)', () => {
    const offenders: string[] = [];
    let seen = 0;

    for (const [name, css] of SCANNED) {
      for (const floor of autoFitFloors(css)) {
        seen += 1;
        if (!COLLAPSIBLE.test(floor)) {
          offenders.push(`${name}: \`minmax(${floor}, …)\``);
        }
      }
    }

    // A sweep of nothing is not a pass.
    assert.ok(seen > 0, 'no repeat(auto-fit, minmax(…)) track exists to be checked');
    assert.deepEqual(
      offenders,
      [],
      'A bare length in `minmax()` cannot resolve below itself, so the grid CONTAINER overflows ' +
        'instead of the track shrinking — see the header of this file for the two pixels of ' +
        'sideways scroll that produced on /review/hand-0042 at 360px. Wrap the floor in ' +
        `\`min(100%, …)\`.\n  ${offenders.join('\n  ')}`,
    );
  });
});
