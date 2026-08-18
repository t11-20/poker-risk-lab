/**
 * Tests for the motion primitives' pure parts.
 *
 * The hooks themselves cannot be tested here — `node --test` runs no renderer in this repo, by
 * policy — so everything the hooks *decide* was extracted into pure modules precisely so that
 * it could be. What is covered:
 *
 *  - the count-up's arithmetic, including the two floating-point traps (an animation that
 *    settles on 41.199999, and a NaN progress reaching the DOM);
 *  - the easing curve, checked by round-trip and by the shape the design system asks for
 *    rather than by a table of magic numbers copied from the implementation;
 *  - the reduced-motion decisions, which are the accessibility-critical part: a false positive
 *    here means a reader who asked for no motion gets motion;
 *  - the JS mirror of the motion tokens, asserted **against `tokens.css` itself**. That
 *    duplication is deliberate and documented, and this is what stops it drifting: change the
 *    token and forget the mirror, and this test fails.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { cubicBezier, easeStandard, interpolate, progress } from '../src/motion/easing.ts';
import {
  REDUCED_MOTION_QUERY,
  shouldCountUp,
  shouldRevealImmediately,
} from '../src/motion/reduced-motion.ts';
import {
  COUNT_DURATION_MS,
  EASE_STANDARD_CONTROL_POINTS,
  MIN_COUNT_UP_CHANGE,
} from '../src/motion/tokens.ts';

/** The bézier solver converges to 1e-7, so comparisons allow a little more than that. */
const TOLERANCE = 1e-6;

function assertClose(actual: number, expected: number, what: string): void {
  assert.ok(Math.abs(actual - expected) < TOLERANCE, `${what}: expected ${expected}, received ${actual}`);
}

describe('interpolate', () => {
  it('returns the endpoints by identity, not by arithmetic', () => {
    // The reason this matters: `41.2 + (0 - 41.2) * 1` is not always exactly 0 in binary
    // floating point, and a metric that settles one digit off is a visible bug.
    assert.equal(interpolate(0.412, 0.489, 1), 0.489);
    assert.equal(interpolate(0.412, 0.489, 0), 0.412);
    assert.equal(interpolate(1 / 3, 2 / 3, 1), 2 / 3);
  });

  it('interpolates linearly in between', () => {
    assert.equal(interpolate(0, 100, 0.5), 50);
    assert.equal(interpolate(100, 200, 0.25), 125);
    assertClose(interpolate(0.4, 0.5, 0.5), 0.45, 'midpoint');
  });

  it('runs downwards as happily as upwards', () => {
    assert.equal(interpolate(200, 100, 0.5), 150);
    assert.equal(interpolate(-50, 50, 0.5), 0);
    assert.equal(interpolate(-10, -20, 0.5), -15);
  });

  it('clamps a progress outside 0..1 rather than overshooting', () => {
    assert.equal(interpolate(0, 100, 1.5), 100);
    assert.equal(interpolate(0, 100, -3), 0);
  });

  it('never produces NaN from a NaN progress', () => {
    // A strange frame timestamp must not put "NaN%" on screen.
    assert.equal(interpolate(10, 20, Number.NaN), 20);
  });
});

describe('progress', () => {
  it('maps elapsed time onto 0..1', () => {
    assert.equal(progress(0, 900), 0);
    assert.equal(progress(450, 900), 0.5);
    assert.equal(progress(900, 900), 1);
  });

  it('clamps at both ends', () => {
    assert.equal(progress(-100, 900), 0);
    assert.equal(progress(1800, 900), 1);
  });

  it('treats a zero or negative duration as already finished', () => {
    // This is what makes `durationMs: 0` a legitimate way to ask for no animation, rather
    // than a division by zero producing Infinity.
    assert.equal(progress(0, 0), 1);
    assert.equal(progress(10, -5), 1);
  });

  it('treats a non-finite input as finished', () => {
    assert.equal(progress(Number.NaN, 900), 1);
    assert.equal(progress(10, Number.NaN), 1);
  });
});

describe('cubicBezier', () => {
  it('pins both ends exactly', () => {
    const ease = cubicBezier(0.42, 0, 0.58, 1);
    assert.equal(ease(0), 0);
    assert.equal(ease(1), 1);
    assert.equal(easeStandard(0), 0);
    assert.equal(easeStandard(1), 1);
  });

  it('is the identity when the curve is a straight line', () => {
    // Both CSS spellings of "linear": the x and y control values are equal, so the mapping
    // from progress to eased progress must come back unchanged. This is the strongest simple
    // check of the solver, because a sign error or a bad derivative shows up immediately.
    for (const ease of [cubicBezier(0, 0, 1, 1), cubicBezier(0.5, 0.5, 0.5, 0.5)]) {
      for (const t of [0.1, 0.2, 0.37, 0.5, 0.63, 0.8, 0.95]) {
        assertClose(ease(t), t, `linear curve at ${t}`);
      }
    }
  });

  it('is monotonic and inside 0..1 across the whole curve', () => {
    let previous = 0;
    for (let step = 0; step <= 100; step += 1) {
      const value = easeStandard(step / 100);
      assert.ok(value >= 0 && value <= 1, `eased value out of range at ${step}: ${value}`);
      assert.ok(value >= previous - TOLERANCE, `eased value went backwards at ${step}`);
      previous = value;
    }
  });

  it('has the shape the design system asks for: fast out, long settle', () => {
    // §5: the signature curve arrives quickly and then settles. So by the halfway point most
    // of the distance is covered, and the last tenth of the time covers almost none of it.
    assert.ok(easeStandard(0.5) > 0.7, `midpoint should be well ahead of linear: ${easeStandard(0.5)}`);
    assert.ok(easeStandard(0.9) > 0.99, `should be nearly settled by 90%: ${easeStandard(0.9)}`);
    assert.ok(easeStandard(0.1) < 0.1, `should not leap on the first frames: ${easeStandard(0.1)}`);
  });

  it('resolves a non-finite progress to finished rather than to NaN', () => {
    assert.equal(easeStandard(Number.NaN), 1);
    assert.equal(easeStandard(Number.POSITIVE_INFINITY), 1);
  });

  it('is deterministic, which is what makes a server render match a client render', () => {
    assert.equal(easeStandard(0.31), easeStandard(0.31));
  });
});

describe('shouldRevealImmediately', () => {
  it('reveals at once when motion is reduced', () => {
    assert.equal(shouldRevealImmediately({ reducedMotion: true, observerAvailable: true }), true);
  });

  it('reveals at once when there is no observer to watch with', () => {
    // The failure direction that matters: no observer must mean visible content, never content
    // left hidden waiting for a callback that can never arrive.
    assert.equal(shouldRevealImmediately({ reducedMotion: false, observerAvailable: false }), true);
    assert.equal(shouldRevealImmediately({ reducedMotion: true, observerAvailable: false }), true);
  });

  it('reveals at once when the document is hidden', () => {
    // Measured in Chrome, and the reason this input exists: IntersectionObserver entries are
    // delivered from the "update the rendering" step, which a hidden document does not run.
    // An element sitting FULLY inside the viewport of a background tab received no entry in
    // 1.5s, and the document timeline advanced 0ms over the same window — so neither the
    // observer nor a CSS deadline was ever going to resolve it. Nobody is looking at a hidden
    // document, so there is no arrival to animate: resolve, and show the content.
    assert.equal(
      shouldRevealImmediately({ reducedMotion: false, observerAvailable: true, documentHidden: true }),
      true,
    );
  });

  it('waits for the observer only when it can, motion is allowed and the document is visible', () => {
    assert.equal(shouldRevealImmediately({ reducedMotion: false, observerAvailable: true }), false);
    assert.equal(
      shouldRevealImmediately({ reducedMotion: false, observerAvailable: true, documentHidden: false }),
      false,
    );
  });

  it('treats an absent documentHidden as "not known to be hidden"', () => {
    // The server cannot answer this, and guessing "hidden" there would make the server's markup
    // disagree with the client's first render. Omitted must therefore behave exactly as `false`.
    assert.equal(
      shouldRevealImmediately({ reducedMotion: false, observerAvailable: true }),
      shouldRevealImmediately({ reducedMotion: false, observerAvailable: true, documentHidden: false }),
    );
  });
});

describe('shouldCountUp', () => {
  const base = { reducedMotion: false, durationMs: COUNT_DURATION_MS };

  it('refuses outright under reduced motion, however large the change', () => {
    assert.equal(shouldCountUp({ ...base, reducedMotion: true, from: 0, to: 1000 }), false);
  });

  it('animates a change worth watching', () => {
    assert.equal(shouldCountUp({ ...base, from: 0.412, to: 0.489 }), true);
    assert.equal(shouldCountUp({ ...base, from: 1200, to: 1800 }), true);
  });

  it('does not animate a figure that did not change', () => {
    assert.equal(shouldCountUp({ ...base, from: 0.412, to: 0.412 }), false);
    assert.equal(shouldCountUp({ ...base, from: 0, to: 0 }), false);
    assert.equal(shouldCountUp({ ...base, from: -0, to: 0 }), false);
  });

  it('applies the 1% floor relative to the larger end', () => {
    // Exactly on the threshold animates; just under it does not. Relative rather than absolute
    // so an equity in 0..1 and a pot in the hundreds behave the same way. Note the base is the
    // LARGER end, so 99 -> 100 is exactly 1% while 100 -> 101 is a shade under it.
    assert.equal(shouldCountUp({ ...base, from: 99, to: 100 }), true);
    assert.equal(shouldCountUp({ ...base, from: 100, to: 101 }), false);
    assert.equal(shouldCountUp({ ...base, from: 99.5, to: 100 }), false);
    assert.equal(shouldCountUp({ ...base, from: 0.4, to: 0.402 }), false);
    assert.equal(shouldCountUp({ ...base, from: 0.4, to: 0.41 }), true);
  });

  it('measures a downward change the same way', () => {
    assert.equal(shouldCountUp({ ...base, from: 100, to: 99 }), true);
    assert.equal(shouldCountUp({ ...base, from: 100, to: 99.5 }), false);
  });

  it('is symmetric: a figure oscillating between two values animates both ways or neither', () => {
    // Dividing by the larger end rather than by the starting value is what buys this. Without
    // it, a pot flicking between 100 and 101 would animate one way and jump the other.
    for (const [low, high] of [
      [0.4, 0.41],
      [100, 101],
      [0, 500],
      [12, 12.02],
    ]) {
      assert.equal(
        shouldCountUp({ ...base, from: low ?? 0, to: high ?? 0 }),
        shouldCountUp({ ...base, from: high ?? 0, to: low ?? 0 }),
        `asymmetric decision for ${low} <-> ${high}`,
      );
    }
  });

  it('animates away from zero without dividing by it', () => {
    assert.equal(shouldCountUp({ ...base, from: 0, to: 500 }), true);
    assert.equal(shouldCountUp({ ...base, from: 500, to: 0 }), true);
  });

  it('honours a caller-supplied floor', () => {
    assert.equal(shouldCountUp({ ...base, from: 100, to: 100.5, minChange: 0.001 }), true);
    assert.equal(shouldCountUp({ ...base, from: 100, to: 120, minChange: 0.5 }), false);
  });

  it('never animates towards or away from a figure that is not a number', () => {
    // A missing figure renders as "not available" at once. Counting towards it would render a
    // sequence of numbers on the way to nothing.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(shouldCountUp({ ...base, from: 0.4, to: bad }), false);
      assert.equal(shouldCountUp({ ...base, from: bad, to: 0.4 }), false);
    }
  });

  it('treats a zero or non-finite duration as no animation', () => {
    assert.equal(shouldCountUp({ ...base, durationMs: 0, from: 0, to: 100 }), false);
    assert.equal(shouldCountUp({ ...base, durationMs: -1, from: 0, to: 100 }), false);
    assert.equal(shouldCountUp({ ...base, durationMs: Number.NaN, from: 0, to: 100 }), false);
  });
});

describe('the JS mirror of the motion tokens', () => {
  const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

  it('matches --prl-dur-count in tokens.css', () => {
    // The first match is the `:root` value; the 1ms later in the file is the reduced-motion
    // collapse, which is CSS's own business.
    const found = /--prl-dur-count:\s*(\d+)ms;/.exec(css);
    assert.ok(found !== null, '--prl-dur-count not found in tokens.css');
    assert.equal(Number(found[1]), COUNT_DURATION_MS);
  });

  it('matches --prl-ease-standard in tokens.css', () => {
    const found = /--prl-ease-standard:\s*cubic-bezier\(([^)]+)\);/.exec(css);
    assert.ok(found !== null, '--prl-ease-standard not found in tokens.css');
    const numbers = (found[1] ?? '').split(',').map((part) => Number(part.trim()));
    assert.deepEqual(numbers, [...EASE_STANDARD_CONTROL_POINTS]);
  });

  it('states the reduced-motion query exactly as the stylesheet does', () => {
    assert.equal(REDUCED_MOTION_QUERY, '(prefers-reduced-motion: reduce)');
    assert.ok(css.includes('prefers-reduced-motion: reduce'), 'tokens.css must honour the same query');
  });

  it('keeps the count-up floor at one percent', () => {
    assert.equal(MIN_COUNT_UP_CHANGE, 0.01);
  });
});
