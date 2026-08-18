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
import { readFileSync } from 'node:fs';
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

describe('the design system rules that are stated in prose and checked nowhere', () => {
  it('has no box-shadow in either stylesheet', () => {
    for (const [name, css] of [
      ['components.css', componentsCss],
      ['play.css', playCss],
    ] as const) {
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert.doesNotMatch(
        withoutComments,
        /box-shadow/,
        `${name}: elevation is a step on the surface ramp plus a hairline (section 4.1)`,
      );
    }
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
