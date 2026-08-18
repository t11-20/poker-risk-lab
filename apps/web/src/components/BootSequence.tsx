'use client';

/**
 * `READY // CALIBRATING` — the first-paint transition, and the four ways it gets out of the way.
 *
 * ## The one thing this must never do
 *
 * A loading animation that makes a fast app slower is a net loss (§8). Everything below follows
 * from that single sentence, and it is worth stating what the failure mode looks like: a reader
 * clicks a link, the app is ready in 180ms, and a 900ms animation holds the screen for the other
 * 720ms to look considered. That is not polish. That is a slower product wearing a costume.
 *
 * So the cap is measured from **navigation start**, not from mount:
 *
 *     remaining = COUNT_DURATION_MS - performance.now()
 *
 * `performance.now()` is already the milliseconds since the navigation began, so this is the time
 * left of the 900ms budget after everything the browser and React have spent getting here. Slow
 * hydration therefore SHORTENS the overlay rather than adding to it, and the total is bounded by
 * 900ms end to end no matter what. If hydration alone took longer than the budget, `remaining` is
 * zero or negative and the overlay is dismissed on its first commit without ever animating.
 *
 * That is also what "dismissed early the moment the shell is ready" means here in practice: the
 * shell IS ready at hydration, because the markup is server-rendered and interactive from then on.
 *
 * ## Four exits, in the order they fire
 *
 *  1. **Reduced motion** — `usePrefersReducedMotion`, and independently `globals.css` sets
 *     `display: none` under the media query, so the overlay is gone before paint rather than
 *     removed after it.
 *  2. **A repeat visit in this session** — `sessionStorage`. Handled in the same pre-paint inline
 *     script that resolves the theme (`theme.ts`), which stamps `data-boot="skip"` on the root
 *     element so CSS can suppress the overlay in the first paint. Doing it here in an effect
 *     instead would flash the boot screen on every navigation of a hard reload.
 *  3. **The 900ms cap**, measured as above.
 *  4. **No JavaScript at all** — `@media (scripting: none)` hides it. Without that guard, a reader
 *     with scripting disabled would be left staring at an opaque overlay over a perfectly good
 *     server-rendered page, permanently. That is the worst bug this component could have, and it
 *     is invisible in every environment where it is being developed.
 *
 * ## Why it is server-rendered rather than mounted on the client
 *
 * Both directions of flash are bad, and only one of them is obvious. An overlay mounted in an
 * effect fades IN over a shell the reader can already see and read — it takes the page away from
 * them. Rendering it in the server's HTML means it is simply the first thing on screen, and the
 * only transition anyone sees is it leaving.
 *
 * ## The counter, and the only duration this file knows
 *
 * `COUNT_DURATION_MS` from `@prl/ui` is the JS mirror of `--prl-dur-count` — the one duplication
 * the design system sanctions (§5.5), for exactly this reason: `requestAnimationFrame` needs a
 * number and a custom property is a string that does not resolve during a server render. The
 * count is driven with `easeStandard`, the same curve the CSS around it uses, and it is scaled to
 * the *remaining* window so it reaches exactly 100 as the overlay leaves rather than being cut off
 * at 63.
 *
 * The overlay is removed from the DOM on `transitionend` rather than after a timer, so this file
 * holds no second duration. Durations collapse to 1ms under reduced motion instead of to 0
 * precisely so that event still fires (`tokens.css`), which is why waiting on it is safe.
 *
 * The whole thing is `aria-hidden` and contains no focusable element: it is 900ms of visual
 * texture, it has nothing to say to a screen reader, and announcing "calibrating" to somebody who
 * is already listening to the page would be noise, not information.
 */

import { COUNT_DURATION_MS, easeStandard, interpolate, progress, usePrefersReducedMotion } from '@prl/ui';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { hasBooted, markBooted } from '@/lib/theme.ts';

/** The counter's endpoints. Not durations or design values — the two ends of `0 → 100`. */
const COUNT_FROM = 0;
const COUNT_TO = 100;

type BootState = 'pending' | 'done' | 'gone';

export function BootSequence(): ReactElement | null {
  const reducedMotion = usePrefersReducedMotion();
  const [state, setState] = useState<BootState>('pending');
  const [count, setCount] = useState(COUNT_FROM);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    // Whatever happens below, this session has now seen the boot sequence. Written first so an
    // early return cannot skip it — a reader who reloads twice in a row should see it once.
    const repeat = hasBooted();
    markBooted();

    if (reducedMotion || repeat) {
      // Straight to `gone`, not to `done`: there is no fade to wait for when there was never
      // anything visible. CSS has already suppressed the overlay in both of these cases.
      setState('gone');
      return;
    }

    const remaining = COUNT_DURATION_MS - performance.now();
    if (remaining <= 0) {
      // The budget was spent before hydration finished. The overlay was on screen for that whole
      // time as static server-rendered markup and its 900ms is up; it leaves now.
      setState('done');
      return;
    }

    let startedAt: number | null = null;
    const step = (now: number): void => {
      // The first frame's own timestamp starts the clock, rather than a `performance.now()` read
      // taken here: a frame may be spent elsewhere between the two, and starting early would skip
      // that much of the curve. Same reasoning as `useCountUp` in @prl/ui.
      if (startedAt === null) startedAt = now;
      const elapsed = progress(now - startedAt, remaining);
      setCount(interpolate(COUNT_FROM, COUNT_TO, easeStandard(elapsed)));
      if (elapsed < 1) {
        frameRef.current = requestAnimationFrame(step);
        return;
      }
      frameRef.current = null;
      setState('done');
    };
    frameRef.current = requestAnimationFrame(step);

    return () => {
      if (frameRef.current === null) return;
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [reducedMotion]);

  // A fixed, full-viewport element that outlives its purpose is a permanent hazard, so the node is
  // removed rather than left at `opacity: 0` — an invisible overlay is still an overlay.
  if (state === 'gone') return null;

  return (
    <div
      aria-hidden="true"
      className="prl-boot"
      data-state={state}
      onTransitionEnd={(event) => {
        // React's transition events bubble, so a child's transition would otherwise unmount the
        // overlay mid-fade. Only this element's own opacity ending means the fade is over.
        if (event.target !== event.currentTarget) return;
        if (event.propertyName !== 'opacity') return;
        setState('gone');
      }}
    >
      {/* A string expression, not JSX text: `//` inside JSX children reads as the start of a
          comment, and the lint rule that catches it is right to — the label would silently become
          "READY". */}
      <p className="prl-boot__label">{'READY // CALIBRATING'}</p>
      {/* `Math.round`, not `toFixed`: the counter is three characters wide in a monospace face and
          a decimal point would make it five, which is exactly the horizontal shuffle tabular
          figures exist to prevent. */}
      <p className="prl-boot__count">{Math.round(count)}</p>
      <div className="prl-boot__rule" />
    </div>
  );
}
