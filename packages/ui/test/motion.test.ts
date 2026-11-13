/**
 * The motion primitives' pure parts. There is no renderer, so the hooks' decisions and effects live
 * in React-free modules tested here.
 * A11Y-016: the reduced-motion preference is exercised, not asserted. A faked `matchMedia` reports
 * `reduce`, and the tests count zero animation frames and zero `IntersectionObserver`s.
 * Not covered: the line in each hook that calls `usePrefersReducedMotion()`, which needs a renderer.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { driveCountUp, type FrameClock } from '../src/motion/count-up-driver.ts';
import { cubicBezier, easeStandard, interpolate, progress } from '../src/motion/easing.ts';
import {
  REDUCED_MOTION_QUERY,
  shouldCountUp,
  shouldRevealImmediately,
} from '../src/motion/reduced-motion.ts';
import { type RevealHost, watchForReveal } from '../src/motion/reveal-watcher.ts';
import {
  COUNT_DURATION_MS,
  EASE_STANDARD_CONTROL_POINTS,
  MIN_COUNT_UP_CHANGE,
} from '../src/motion/tokens.ts';
import {
  createReducedMotionStore,
  type MediaQueryHost,
  type ReducedMotionQuery,
} from '../src/motion/usePrefersReducedMotion.ts';

/** The bézier solver converges to 1e-7, so comparisons allow a little more than that. */
const TOLERANCE = 1e-6;

function assertClose(actual: number, expected: number, what: string): void {
  assert.ok(Math.abs(actual - expected) < TOLERANCE, `${what}: expected ${expected}, received ${actual}`);
}

describe('interpolate', () => {
  it('returns the endpoints by identity, not by arithmetic', () => {
    // `41.2 + (0 - 41.2) * 1` is not always exactly 0 in binary floating point.
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
    // This makes `durationMs: 0` a way to ask for no animation.
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
    // Both CSS spellings of "linear". A sign error or a bad derivative in the solver shows up here.
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
    // Design system §5 asks for a curve that arrives quickly and then settles.
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
    // Fail visible. No observer must never leave content hidden.
    assert.equal(shouldRevealImmediately({ reducedMotion: false, observerAvailable: false }), true);
    assert.equal(shouldRevealImmediately({ reducedMotion: true, observerAvailable: false }), true);
  });

  it('reveals at once when the document is hidden', () => {
    // A hidden document runs no rendering step. In Chrome a background tab delivered no observer entry
    // in 1.5s and its document timeline advanced 0ms, so neither the observer nor a CSS deadline resolves.
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
    // The server cannot answer this, and guessing "hidden" would break hydration.
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
    // Relative, so an equity in 0..1 and a pot in the hundreds behave alike. The base is the larger
    // end, so 99 -> 100 is exactly on the floor and 100 -> 101 is just under it.
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
    // Dividing by the larger end, not the starting value, is what makes this symmetric.
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

interface FakeMedia {
  readonly host: MediaQueryHost;
  readonly queries: readonly string[];
  listenerCount(): number;
  setMatches(next: boolean): void;
}

/**
 * A `window` that reports whatever preference the test asks for. `supportsEvents: false` models a
 * `MediaQueryList` too old to be an `EventTarget`, the one case `createReducedMotionStore` branches on.
 */
function fakeMediaHost(options: { matches: boolean; supportsEvents?: boolean }): FakeMedia {
  const queries: string[] = [];
  const listeners = new Set<() => void>();
  let matches = options.matches;

  const withEvents: ReducedMotionQuery = {
    get matches(): boolean {
      return matches;
    },
    addEventListener(_type: 'change', listener: () => void): void {
      listeners.add(listener);
    },
    removeEventListener(_type: 'change', listener: () => void): void {
      listeners.delete(listener);
    },
  };
  const withoutEvents: ReducedMotionQuery = {
    get matches(): boolean {
      return matches;
    },
  };
  const query = options.supportsEvents === false ? withoutEvents : withEvents;

  return {
    host: {
      matchMedia(text: string): ReducedMotionQuery {
        queries.push(text);
        return query;
      },
    },
    queries,
    listenerCount: () => listeners.size,
    setMatches(next: boolean): void {
      matches = next;
      for (const listener of listeners) listener();
    },
  };
}

describe('createReducedMotionStore — the preference is actually read', () => {
  it('reports true when the OS says reduce, through the query the stylesheet uses', () => {
    const media = fakeMediaHost({ matches: true });
    const store = createReducedMotionStore(media.host);

    assert.equal(store.getSnapshot(), true);
    assert.deepEqual(media.queries, [REDUCED_MOTION_QUERY]);
  });

  it('reports false when the reader has expressed no preference', () => {
    const store = createReducedMotionStore(fakeMediaHost({ matches: false }).host);
    assert.equal(store.getSnapshot(), false);
  });

  it('follows a preference the reader changes mid-session, and tells React', () => {
    const media = fakeMediaHost({ matches: false });
    const store = createReducedMotionStore(media.host);
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });

    assert.equal(store.getSnapshot(), false);
    media.setMatches(true);
    assert.equal(notified, 1, 'React has to be told, or the new answer never reaches a render');
    assert.equal(store.getSnapshot(), true);

    unsubscribe();
    assert.equal(media.listenerCount(), 0, 'and the listener has to go when the subscription does');
    media.setMatches(false);
    assert.equal(notified, 1, 'an unsubscribed store must not keep being notified');
  });

  it('asks matchMedia once, however many times it is read', () => {
    const media = fakeMediaHost({ matches: true });
    const store = createReducedMotionStore(media.host);
    store.getSnapshot();
    store.getSnapshot();
    store.subscribe(() => undefined);
    assert.equal(media.queries.length, 1, 'one MediaQueryList for the whole app, not one per read');
  });

  it('answers false, and subscribes to nothing, where there is no matchMedia', () => {
    // False is the safe guess on the server. The client's first render corrects it before paint, while
    // true would show every reveal as arrived and take it away on hydration.
    const store = createReducedMotionStore(undefined);
    assert.equal(store.getSnapshot(), false);
    assert.doesNotThrow(() => store.subscribe(() => undefined)());
  });

  it('still reads the preference from a MediaQueryList too old to be an EventTarget', () => {
    const media = fakeMediaHost({ matches: true, supportsEvents: false });
    const store = createReducedMotionStore(media.host);
    assert.equal(store.getSnapshot(), true);
    assert.doesNotThrow(() => store.subscribe(() => undefined)());
  });
});

interface FakeClock {
  readonly clock: FrameClock;
  requested(): number;
  cancelled(): number;
  advance(now: number): void;
}

function fakeClock(): FakeClock {
  let requested = 0;
  let cancelled = 0;
  let nextHandle = 1;
  let pending: { readonly handle: number; readonly callback: (now: number) => void } | null = null;

  return {
    clock: {
      requestAnimationFrame(callback: (now: number) => void): number {
        requested += 1;
        const handle = nextHandle;
        nextHandle += 1;
        pending = { handle, callback };
        return handle;
      },
      cancelAnimationFrame(handle: number): void {
        cancelled += 1;
        if (pending !== null && pending.handle === handle) pending = null;
      },
    },
    requested: () => requested,
    cancelled: () => cancelled,
    advance(now: number): void {
      const frame = pending;
      pending = null;
      if (frame !== null) frame.callback(now);
    },
  };
}

describe('driveCountUp — reduced motion means no animation at all', () => {
  const base = { from: 0.412, to: 0.489, durationMs: COUNT_DURATION_MS };

  it('requests zero animation frames when the reader asked for reduced motion', () => {
    // Counts frames, because checking `shouldCountUp` would pass a driver that ignored the answer.
    const clock = fakeClock();
    const seen: number[] = [];

    const cancel = driveCountUp({ ...base, reducedMotion: true }, clock.clock, (value) => seen.push(value));

    assert.equal(clock.requested(), 0, 'a frame was requested for a reader who asked for no motion');
    assert.deepEqual(seen, [0.489], 'the figure should simply be its settled value, once');
    assert.doesNotThrow(cancel);
  });

  it('animates the same change when motion is allowed, so the guard is doing the work', () => {
    // The control. A driver that never animated would pass the test above.
    const clock = fakeClock();
    const seen: number[] = [];
    driveCountUp({ ...base, reducedMotion: false }, clock.clock, (value) => seen.push(value));

    assert.equal(clock.requested(), 1, 'the first frame is requested immediately');
    clock.advance(1_000);
    clock.advance(1_000 + COUNT_DURATION_MS / 2);
    assert.equal(clock.requested(), 3, 'and each frame schedules the next until the duration is up');

    clock.advance(1_000 + COUNT_DURATION_MS);
    assert.equal(seen.length, 3);
    assert.equal(seen[0], 0.412, 'the first frame is the starting value, not a jump');
    assert.equal(seen[seen.length - 1], 0.489, 'and the last is the target exactly');
    const middle = seen[1] ?? 0;
    assert.ok(middle > 0.412 && middle < 0.489, `the middle frame should be in between, got ${middle}`);
  });

  it('stops when cancelled, so a value change mid-flight cannot leave two loops running', () => {
    const clock = fakeClock();
    const cancel = driveCountUp({ ...base, reducedMotion: false }, clock.clock, () => undefined);
    cancel();
    assert.equal(clock.cancelled(), 1);
    clock.advance(1_000);
    assert.equal(clock.requested(), 1, 'a cancelled run must not schedule another frame');
  });

  it('settles without animating for a change too small to be worth watching', () => {
    const clock = fakeClock();
    const seen: number[] = [];
    driveCountUp(
      { from: 100, to: 100.5, durationMs: COUNT_DURATION_MS, reducedMotion: false },
      clock.clock,
      (v) => seen.push(v),
    );
    assert.equal(clock.requested(), 0);
    assert.deepEqual(seen, [100.5]);
  });
});

interface FakeBrowser {
  readonly host: RevealHost;
  observeCalls(): number;
  intersect(): void;
  setHidden(next: boolean): void;
  visibilityListeners(): number;
  disconnects(): number;
}

function fakeBrowser(options: { hidden?: boolean } = {}): FakeBrowser {
  let hidden = options.hidden ?? false;
  let observeCalls = 0;
  let disconnects = 0;
  let onIntersecting: (() => void) | null = null;
  const visibility = new Set<() => void>();

  return {
    host: {
      observe(_target: Element, _threshold: number, callback: () => void): () => void {
        observeCalls += 1;
        onIntersecting = callback;
        return () => {
          disconnects += 1;
          onIntersecting = null;
        };
      },
      isDocumentHidden: () => hidden,
      onVisibilityChange(listener: () => void): () => void {
        visibility.add(listener);
        return () => visibility.delete(listener);
      },
    },
    observeCalls: () => observeCalls,
    intersect(): void {
      onIntersecting?.();
    },
    setHidden(next: boolean): void {
      hidden = next;
      for (const listener of visibility) listener();
    },
    visibilityListeners: () => visibility.size,
    disconnects: () => disconnects,
  };
}

/** `watchForReveal` only hands the `Element` back to the host, so a token stands in for a DOM node. */
const TARGET = { nodeName: 'DIV' } as unknown as Element;

describe('watchForReveal — reduced motion means no observer', () => {
  const base = { target: TARGET, observerAvailable: true, threshold: 0.2 };

  it('creates no IntersectionObserver at all when the reader asked for reduced motion', () => {
    const browser = fakeBrowser();
    let revealed = 0;

    const stop = watchForReveal({ ...base, reducedMotion: true }, browser.host, () => {
      revealed += 1;
    });

    assert.equal(browser.observeCalls(), 0, 'an observer was created for a reader who asked for no motion');
    assert.equal(revealed, 1, 'and the content must be revealed at once rather than left hidden');
    assert.equal(browser.visibilityListeners(), 0, 'with nothing left subscribed');
    assert.doesNotThrow(stop);
  });

  it('observes when motion is allowed, so the guard is doing the work', () => {
    const browser = fakeBrowser();
    let revealed = 0;
    watchForReveal({ ...base, reducedMotion: false }, browser.host, () => {
      revealed += 1;
    });

    assert.equal(browser.observeCalls(), 1);
    assert.equal(revealed, 0, 'nothing is revealed until the element is actually in view');
    browser.intersect();
    assert.equal(revealed, 1);
  });

  it('reveals without observing when the document is hidden', () => {
    // An observer never fires in a hidden document, so the element would stay at opacity 0.
    const browser = fakeBrowser({ hidden: true });
    let revealed = 0;
    watchForReveal({ ...base, reducedMotion: false }, browser.host, () => {
      revealed += 1;
    });

    assert.equal(browser.observeCalls(), 0);
    assert.equal(revealed, 1);
  });

  it('reveals and stops observing if the tab is backgrounded while a reveal is pending', () => {
    const browser = fakeBrowser();
    let revealed = 0;
    watchForReveal({ ...base, reducedMotion: false }, browser.host, () => {
      revealed += 1;
    });
    assert.equal(browser.observeCalls(), 1);

    browser.setHidden(true);
    assert.equal(revealed, 1, 'the reveal resolves rather than waiting for a callback that cannot come');
    assert.equal(browser.disconnects(), 1);
  });

  it('reveals at once where there is no observer to watch with', () => {
    const browser = fakeBrowser();
    let revealed = 0;
    watchForReveal({ ...base, reducedMotion: false, observerAvailable: false }, browser.host, () => {
      revealed += 1;
    });
    assert.equal(browser.observeCalls(), 0);
    assert.equal(revealed, 1);
  });

  it('tears down both subscriptions when it stops', () => {
    const browser = fakeBrowser();
    const stop = watchForReveal({ ...base, reducedMotion: false }, browser.host, () => undefined);
    stop();
    assert.equal(browser.disconnects(), 1);
    assert.equal(browser.visibilityListeners(), 0);
  });
});

describe('the JS mirror of the motion tokens', () => {
  const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

  it('matches --prl-dur-count in tokens.css', () => {
    // The first match is the `:root` value. The later 1ms is the reduced-motion collapse.
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
