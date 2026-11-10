/**
 * `repeat(auto-fit, minmax(<length>, 1fr))` is a HARD FLOOR, and a hard floor overflows.
 *
 * ## The defect this exists for
 *
 * `.prl-coach__grid` was `repeat(auto-fit, minmax(calc(19rem), 1fr))`. `minmax()` with a bare
 * length cannot resolve below that length, so when the grid container is narrower than the floor
 * the track does not shrink — the container overflows instead, and in a nested grid it drags
 * every sibling out with it.
 *
 * Measured on `/review/hand-0042` at 360x640 against the production build: 19rem is 304px, the
 * Coach's own padding takes the pane to 346px, and the page gutter leaves 328px. `.prl-coach` laid
 * out 346px wide at x=16, so its right edge was 362 and `document.documentElement.scrollWidth` was
 * 362 against a `clientWidth` of 360 — the whole page scrolled sideways. Because `.prl-replay` is a
 * grid whose single implicit track is sized by its widest item, the timeline, the transport, the
 * table, the metrics and the verifier were all stretched to 346px too and hung over the right
 * gutter. One track floor, six panes off the edge, on the narrowest common phone.
 *
 * `min(100%, <length>)` is the whole fix: the floor collapses to the container's own width when
 * there is not enough room, and is the length itself whenever there is — so nothing changes at any
 * width where the design was already working, and `auto-fit` still packs the same columns.
 *
 * ## Why a test and not a comment
 *
 * The repo already knew this rule. Eleven tracks in `legends.css`, `review.css` and `lab.css`
 * carry `min(100%, …)`, and `lab.css` section 2 writes up the 390px truncation that taught it —
 * while eight tracks in `components.css`, `learn.css`, `play.css` and this one did not. A rule
 * that half the stylesheets follow is a rule, and the other half is the bug.
 *
 * ## What this asserts
 *
 * Every `repeat(auto-fit | auto-fill, minmax(…, …))` in the app's stylesheets has a floor that can
 * collapse — spelled `min(100%, …)` or `min(…, 100%)`. `auto` and `min-content` are accepted too:
 * both already collapse. Anything else is a hard floor.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/** Every stylesheet an `auto-fit` track could legitimately reach — the same set the glass guard
    in `layout-guarantees.test.ts` scans, and for the same reason: a guard that covered only
    `packages/ui` would miss the file the last one shipped in. */
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
 *
 * Counting brackets rather than reaching for a regex, because the floor is routinely a nested
 * `calc(var(…) * 2 - var(…))` or a `min(100%, calc(…))` and a non-greedy match to the first comma
 * would cut it in half — reporting `min(100%` as the floor, which happens to contain the string
 * this test looks for and would pass every hard floor written with a `calc()` in it.
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

    // A sweep of nothing is not a pass: if the layouts are rewritten away from `auto-fit`, or the
    // route stylesheet directory is renamed, this would otherwise report success over zero tracks.
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
