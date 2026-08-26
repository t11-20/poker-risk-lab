/**
 * The four stylesheet invariants that a browser would otherwise be the only witness to.
 *
 * Three release defects motivated this file, and all three shared a shape: a rule whose effect was
 * argued for in a comment and checked nowhere.
 *
 *  - **R7.** `.prl-play__decision` was `position: sticky; inset-block-end: 0` from 900px up, which
 *    covered the pot, the board, all six seats and the dealer button at every common desktop size.
 *    The comment above the rule named the pot as the thing it protected.
 *  - **P2-1.** The boot overlay's 900ms cap lived only in `BootSequence`'s effect, so a bundle that
 *    never arrived left an opaque full-viewport sheet in place permanently.
 *  - **P2-1, second half.** The reveal's hidden state had no exit for "scripting is enabled and the
 *    bundle failed", which is the one failure mode no media query matches.
 *
 * The real test for the first is a hit-test at three viewports in a browser, and this repo has no
 * browser in CI (`node --test` runs no renderer, by policy — see `motion.test.ts`). What CAN be
 * asserted here is the *rule* rather than its rendering, which is where each of these regressed:
 * a stylesheet is text, and "this declaration must not come back" is a statement about text.
 *
 * `motion.test.ts` sets the precedent for a test in this package reading a stylesheet as its
 * source of truth. This one also reads `apps/web`'s route stylesheet, because the guarantee it
 * checks is a property of the two files together: the app's route arranges components this package
 * styles, and the occlusion was the product of both.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const componentsCss = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8');
const playCss = readFileSync(new URL('../../../apps/web/src/styles/play.css', import.meta.url), 'utf8');

/**
 * The declarations of one rule, by selector, with comments stripped.
 *
 * Deliberately crude — this is not a CSS parser and does not want to be. It finds every block whose
 * selector list contains `selector` and returns the declarations, which is enough to answer "is
 * this property set on this selector anywhere in the file", including inside a media or container
 * query. A false positive would be a rule that mentions the selector in a comment, which is why
 * comments go first.
 */
function declarationsFor(css: string, selector: string): readonly string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: string[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match = pattern.exec(withoutComments);
  while (match !== null) {
    const selectors = (match[1] ?? '').split(',').map((part) => part.trim());
    if (selectors.some((part) => part === selector || part.endsWith(` ${selector}`))) {
      blocks.push((match[2] ?? '').trim());
    }
    match = pattern.exec(withoutComments);
  }
  return blocks;
}

describe('the play screen never pins a surface over the table', () => {
  it('has the decision band in flow at every width', () => {
    const blocks = declarationsFor(playCss, '.prl-play__decision');
    assert.ok(blocks.length > 0, 'expected .prl-play__decision to be styled in play.css');
    for (const block of blocks) {
      assert.doesNotMatch(
        block,
        /position\s*:\s*(sticky|fixed|absolute)/,
        'A pinned decision band occupies the bottom strip of the viewport for the whole of its ' +
          'pinned range, and the block above it in flow — the table — therefore ends inside that ' +
          'strip by definition. See design system section 10.1; the fix is height, not layers.',
      );
    }
  });

  it('leaves the Coach rail sticky, which is the one thing that may be', () => {
    const blocks = declarationsFor(playCss, '.prl-play__coach');
    assert.ok(
      blocks.some((block) => /position\s*:\s*sticky/.test(block)),
      'the rail carries the equity figure and must not scroll away',
    );
  });

  it('reflows the band on a container query, at the same threshold the table uses', () => {
    assert.match(
      playCss,
      /@container\s+prl-play-column\s*\(min-width:\s*46rem\)/,
      'the band goes side by side on a CONTAINER query, because the column is not the viewport',
    );
    for (const block of declarationsFor(playCss, '.prl-play__decision')) {
      assert.doesNotMatch(
        block,
        /display\s*:\s*none/,
        'the decision band is the controls; it is never removed to make something else fit',
      );
    }
  });

  it('does not set `display` on the plate readout inside that container query', () => {
    const query = /@container\s+prl-play-column[^{]*\{([\s\S]*?)\n\}/.exec(playCss)?.[1];
    assert.ok(query !== undefined, 'expected the prl-play-column container query block');
    const hud = /\.prl-play__hud\s*\{([^}]*)\}/.exec(query)?.[1] ?? '';
    assert.doesNotMatch(
      hud,
      /display\s*:/,
      'The HUD is display:none under 900px because the stacked table already pins the viewer’s ' +
        'own plate above the band. A column between 860 and 899px matches this query, so setting ' +
        'display here would resurrect the duplicate plate at exactly those widths.',
    );
  });
});

describe('nothing can hide content until JavaScript arrives', () => {
  it('gives the boot overlay a CSS deadline on the budget it enforces', () => {
    const blocks = declarationsFor(componentsCss, '.prl-boot');
    const animation = blocks.map((block) => /animation\s*:\s*([^;]+)/.exec(block)?.[1]).find(Boolean);
    assert.ok(animation !== undefined, '.prl-boot needs a deadline animation, not only a transition');
    assert.match(animation, /var\(--prl-dur-count\)/, 'the delay is the 900ms cap section 8 states');
    assert.match(animation, /forwards/, 'the deadline must hold once it has passed');
  });

  it('ends that deadline on visibility, never on opacity', () => {
    const keyframes = /@keyframes\s+prl-boot-deadline\s*\{([\s\S]*?)\n\}/.exec(componentsCss)?.[1];
    assert.ok(keyframes !== undefined, 'expected a prl-boot-deadline keyframes block');
    assert.match(keyframes, /visibility\s*:\s*hidden/);
    assert.match(keyframes, /pointer-events\s*:\s*none/);
    assert.doesNotMatch(
      keyframes,
      /opacity/,
      'a filling opacity animation out-ranks the data-state="done" declaration, so the fade would ' +
        'never start, transitionend would never fire, and BootSequence would never unmount itself',
    );
  });

  it('releases every hidden reveal on an UNCONDITIONAL deadline', () => {
    // This used to be scoped to `:root:has(.prl-boot[data-state="pending"])` — "no JavaScript has
    // run yet". That covered one failure mode and missed the rest: boot finishes, the selector
    // stops matching, and from then on any reveal whose observer never fires is hidden forever.
    // It was measured doing exactly that. The deadline is now part of the hidden state itself,
    // so "still marked false" is the only condition, whatever the reason.
    const hidden = declarationsFor(componentsCss, '.prl-reveal[data-revealed="false"]')[0];
    assert.ok(hidden !== undefined, 'expected a .prl-reveal[data-revealed="false"] block');
    const animation = /animation\s*:\s*([^;]+)/.exec(hidden)?.[1];
    assert.ok(animation !== undefined, 'the hidden state must carry its own expiry');
    assert.match(animation, /prl-reveal-deadline/);
    assert.match(animation, /var\(--prl-dur-count\)/, 'the delay is the 900ms cap section 8 states');
    assert.match(animation, /forwards/, 'the deadline must hold once it has passed');
    assert.doesNotMatch(
      animation,
      /backwards|\bboth\b/,
      'a backwards fill would make the animation own opacity from time zero, which is how a ' +
        'deadline stops a transition from ever running',
    );

    const keyframes = /@keyframes\s+prl-reveal-deadline\s*\{([\s\S]*?)\n\}/.exec(componentsCss)?.[1];
    assert.ok(keyframes !== undefined, 'expected a prl-reveal-deadline keyframes block');
    assert.match(keyframes, /opacity\s*:\s*1/);
    assert.match(keyframes, /transform\s*:\s*none/);
  });

  it('binds that deadline to the hidden selector, so revealing removes it', () => {
    // The whole safety argument. An actively-filling opacity animation out-ranks a later
    // declaration of opacity, so a deadline that kept matching after the reveal resolved would
    // own the property and the `.prl-reveal` transition could never run. Keying it on
    // `[data-revealed="false"]` means flipping the attribute deletes the animation with the
    // hidden state — verified in Chrome: `animation-name` is `none` and `getAnimations()` holds
    // only the two CSSTransitions once `data-revealed="true"`.
    for (const block of declarationsFor(componentsCss, '.prl-reveal')) {
      assert.doesNotMatch(
        block,
        /animation\s*:/,
        'the deadline must never sit on the bare class, only on the hidden attribute selector',
      );
    }
  });

  it('keeps the reveal hidden state keyed on the attribute, never on the bare class', () => {
    const bare = declarationsFor(componentsCss, '.prl-reveal');
    for (const block of bare) {
      assert.doesNotMatch(
        block,
        /opacity\s*:\s*0/,
        'styling .prl-reveal bare hides content whenever the observer never runs',
      );
    }
  });
});

/**
 * Every declaration block in a stylesheet, as `{ selector, body }`, comments stripped.
 *
 * The same deliberately-crude scan `declarationsFor` uses, kept separate because these two
 * invariants are about blocks nobody named: the question is "does ANY rule do this", and a
 * lookup by selector cannot ask it.
 */
function allBlocks(css: string): readonly { selector: string; body: string }[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selector: string; body: string }[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match = pattern.exec(withoutComments);
  while (match !== null) {
    out.push({ selector: (match[1] ?? '').trim(), body: (match[2] ?? '').trim() });
    match = pattern.exec(withoutComments);
  }
  return out;
}

/** Every stylesheet a glass fill could legitimately reach: the package's own class layer, the
    app shell, and every route stylesheet. A guard that covered only `packages/ui` would miss the
    exact file the ghosting bug shipped in. */
const ROUTE_STYLE_DIR = new URL('../../../apps/web/src/styles/', import.meta.url);
const GLASS_SCANNED: readonly (readonly [string, string])[] = [
  ['packages/ui components.css', componentsCss],
  [
    'apps/web globals.css',
    readFileSync(new URL('../../../apps/web/src/app/globals.css', import.meta.url), 'utf8'),
  ],
  ...readdirSync(ROUTE_STYLE_DIR)
    .filter((file) => file.endsWith('.css'))
    .sort()
    .map((file) => [`apps/web ${file}`, readFileSync(new URL(file, ROUTE_STYLE_DIR), 'utf8')] as const),
];

describe('the design system rules that are stated in prose and checked nowhere', () => {
  /**
   * This replaced a check that read `assert.doesNotMatch(css, /box-shadow/)`, and the
   * replacement is TIGHTER rather than looser.
   *
   * The old rule was "no box-shadow at all", which was enforceable because the design system had
   * no elevation to express. It now has five levels, so a blanket ban would have had to be
   * deleted outright. What is asserted instead is that a shadow is never a LITERAL: every
   * `box-shadow` value must be built from `--prl-elevation-*` and `--prl-focus-ring` and nothing
   * else. That still forbids the thing the original rule existed to forbid - somebody inventing a
   * blurred layer in a component, on the table, where six seats and a live Coach panel repaint -
   * and it additionally forbids the ad-hoc `0 2px 8px rgba(...)` that a "no shadows" rule never
   * had to think about because no shadow was allowed anywhere.
   *
   * `none` is permitted so a rule can explicitly cancel an inherited elevation.
   */
  const SHADOW_VALUE = /box-shadow\s*:\s*([^;]+)/g;
  const ALLOWED_SHADOW_PART = /^(none|var\(--prl-elevation-[0-4]\)|var\(--prl-focus-ring\))$/;

  it('spends a shadow only through an elevation or focus-ring token, never as a literal', () => {
    for (const [name, css] of GLASS_SCANNED) {
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of withoutComments.matchAll(SHADOW_VALUE)) {
        const value = (match[1] ?? '').trim();
        for (const part of value.split(',').map((piece) => piece.trim())) {
          assert.match(
            part,
            ALLOWED_SHADOW_PART,
            `${name}: \`box-shadow: ${value}\` spends a literal. Elevation is a level on the ` +
              'material ladder (design system section 2.7); add a token before you add a shadow.',
          );
        }
      }
    }
  });

  /**
   * THE GHOSTING GUARD.
   *
   * `apps/web/src/styles/nav.css` documents the defect this exists for: a header resting at 92%
   * opacity with NO `backdrop-filter` let the headings underneath read straight through it as a
   * second, perfectly legible layer of text in the wrong place. Blur plus saturate is the
   * legitimate way to make a translucent bar work, because it destroys the LEGIBILITY of what is
   * behind while keeping its colour. Opacity alone destroys neither.
   *
   * So the rule is mechanical and has no exceptions: wherever a glass fill token goes, the
   * filter goes with it, in the same block - including in a `:hover` block whose base rule
   * already set it. Restating it costs nothing (the same value, re-declared, not re-computed)
   * and it is what makes the rule readable off a stylesheet instead of off a comment.
   *
   * Scoped to the FILL tokens, not to the word "glass": `--prl-glass-filter` is the filter
   * itself, and a block that sets it without a fill is a block adding blur to something that
   * already has its own background, which is not this defect.
   */
  const GLASS_FILL = /var\(--prl-glass-(?:floating|overlay)(?:-hover|-active)?\)/;

  it('never uses a glass fill without the blur that makes it legible', () => {
    let seen = 0;
    for (const [name, css] of GLASS_SCANNED) {
      for (const block of allBlocks(css)) {
        if (!GLASS_FILL.test(block.body)) continue;
        seen += 1;
        assert.match(
          block.body,
          /backdrop-filter\s*:/,
          `${name}: \`${block.selector}\` sets a translucent glass fill with no backdrop-filter. ` +
            'That is the ghosting bug in the header comment of apps/web/src/styles/nav.css: the ' +
            'content behind stays perfectly legible, in the wrong place, as a second layer of text.',
        );
      }
    }
    // A sweep of nothing is not a pass. If the material classes are renamed or deleted, this
    // guard would otherwise report success having examined zero blocks.
    assert.ok(seen > 0, 'expected at least one glass fill to exist to be checked');
  });

  it('spends no raw duration or easing curve outside the token layer', () => {
    for (const [name, css] of [
      ['components.css', componentsCss],
      ['play.css', playCss],
    ] as const) {
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert.doesNotMatch(withoutComments, /:\s*[\d.]+m?s\b/, `${name}: durations come from tokens`);
      assert.doesNotMatch(withoutComments, /cubic-bezier\(/, `${name}: easing comes from tokens`);
    }
  });
});

/**
 * A numeric column that declares `text-align: end` must actually win the cascade.
 *
 * ## The defect this exists for
 *
 * `.prl-legend-table__figure` carried `text-align: end` from the day that file was written and
 * **never once applied**. `.prl-legend-table th, td { text-align: start }` is specificity (0,2,1);
 * a bare class selector is (0,1,0) and loses silently. Every figure in that table had been
 * left-aligned for the whole life of the file, and the stylesheet read as though it were not.
 *
 * That is not a one-off. The same trap was reproduced in a *new* rule in the same session before
 * anybody noticed the first one, and again in the Coach's candidate table — the most numeric
 * surface in the product — where `.prl-candidates__table td` (0,1,1) beat `.prl-candidates__cost`
 * (0,1,0) and the costs and EVs rendered left-aligned under right-aligned intent.
 *
 * A declaration that applies to nothing is worse than a missing one: it reads as done.
 *
 * ## What this asserts
 *
 * For every rule that end-aligns a cell, the selector must be element-qualified (`td.` / `th.`),
 * which is (0,1,1) and at least ties with the table-wide rule it must beat — and a later rule wins
 * a tie, which is why placement below matters too and is asserted here as well.
 */
describe('numeric columns are actually end-aligned', () => {
  /** `.prl-candidates__table th, .prl-candidates__table td { … text-align: start … }` */
  const TABLE_WIDE_START = /([^{}]*\bth\b[^{}]*,[^{}]*\btd\b[^{}]*)\{[^{}]*text-align:\s*start[^{}]*\}/gu;
  const CELL_END = /([^{}]+)\{[^{}]*text-align:\s*end[^{}]*\}/gu;
  /** `prl-candidates__table` -> `prl-candidates`. The BEM block is what ties a cell to its table. */
  const blockOf = (selector: string): string | null => /\.([a-z0-9-]+)__/u.exec(selector)?.[1] ?? null;
  const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//gu, '');

  it('never end-aligns a cell through a selector that loses to its own table (REGRESSION)', () => {
    const offenders: string[] = [];
    let tablesFound = 0;
    for (const [name, raw] of GLASS_SCANNED) {
      // Comments stripped first. The first version of this scanned raw text and reported prose out
      // of the very comment block explaining the defect — a check reading its own documentation as
      // evidence. Every file here is heavily commented, so that is not a corner case.
      const css = strip(raw);

      // Only a table that sets `text-align: start` on its own cells can defeat anything. Without
      // one, an unqualified class is perfectly fine — which is why the first version of this test
      // produced three false positives on `div`/`span` layouts that merely end-align a value.
      const guarded = new Set<string>();
      for (const wide of css.matchAll(TABLE_WIDE_START)) {
        const block = blockOf(wide[1] ?? '');
        if (block !== null) {
          guarded.add(block);
          tablesFound += 1;
        }
      }
      if (guarded.size === 0) continue;

      for (const match of css.matchAll(CELL_END)) {
        for (const selector of (match[1] ?? '').split(',').map((part) => part.trim())) {
          const block = blockOf(selector);
          if (block === null || !guarded.has(block)) continue;
          // (0,1,1) or better beats the table-wide rule; a bare class at (0,1,0) does not.
          const beatsIt = /\b(?:td|th)\./u.test(selector) || /(?:^|\s)(?:td|th)\b/u.test(selector);
          if (!beatsIt) offenders.push(`${name}: ${selector}`);
        }
      }
    }
    assert.ok(tablesFound > 0, 'no table-wide start-align rule was found; the sweep proved nothing');
    assert.deepEqual(
      offenders,
      [],
      'a bare class cannot out-specify `<table> td`, so these declarations apply to nothing',
    );
  });

  it('places the candidate table override BELOW the rule it has to beat', () => {
    // (0,1,1) ties with (0,1,1); a tie is decided by source order, so this is load-bearing.
    const wide = componentsCss.indexOf('.prl-candidates__table th,');
    const override = componentsCss.indexOf('td.prl-candidates__cost');
    assert.ok(wide > 0 && override > 0, 'both rules must exist for the ordering to matter');
    assert.ok(override > wide, 'the end-align override must come after the table-wide start-align');
  });

  it('catches the historical defect when it is replayed (NEGATIVE CONTROL)', () => {
    // The exact shape that shipped in legends.css and never applied: a bare class end-aligning a
    // cell in a table whose own rule start-aligns every cell.
    const replayed = `
      .prl-x__table th, .prl-x__table td { text-align: start; }
      .prl-x__figure { text-align: end; }
    `;
    const guarded = new Set<string>();
    for (const wide of replayed.matchAll(TABLE_WIDE_START)) {
      const block = blockOf(wide[1] ?? '');
      if (block !== null) guarded.add(block);
    }
    assert.ok(guarded.has('prl-x'), 'the table-wide rule must be recognised');
    const caught: string[] = [];
    for (const match of replayed.matchAll(CELL_END)) {
      const selector = (match[1] ?? '').trim();
      const block = blockOf(selector);
      if (block !== null && guarded.has(block) && !/\b(?:td|th)\./u.test(selector)) {
        caught.push(selector);
      }
    }
    assert.deepEqual(caught, ['.prl-x__figure']);
  });
});
