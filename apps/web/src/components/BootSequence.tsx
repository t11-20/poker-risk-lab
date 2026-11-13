'use client';

/**
 * The first-paint overlay. It must never make a fast app slower (§8), so the 900ms cap runs from
 * navigation start (`COUNT_DURATION_MS - performance.now()`) and slow hydration shortens it.
 * Other exits: reduced motion and a repeat visit are suppressed pre-paint (`globals.css`, the
 * `data-boot` stamp from `theme.ts`), and `@media (scripting: none)` hides it without JavaScript.
 * Server-rendered so it never fades in over a readable page. `COUNT_DURATION_MS` mirrors
 * `--prl-dur-count` (§5.5). Removal waits on `transitionend`, which still fires at 1ms under
 * reduced motion. `aria-hidden` with nothing focusable.
 */

import { COUNT_DURATION_MS, easeStandard, interpolate, progress, usePrefersReducedMotion } from '@prl/ui';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { hasBooted, markBooted } from '@/lib/theme.ts';

const COUNT_FROM = 0;
const COUNT_TO = 100;

type BootState = 'pending' | 'done' | 'gone';

export function BootSequence(): ReactElement | null {
  const reducedMotion = usePrefersReducedMotion();
  const [state, setState] = useState<BootState>('pending');
  const [count, setCount] = useState(COUNT_FROM);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    // Marked before any early return, so a second reload never shows it again.
    const repeat = hasBooted();
    markBooted();

    if (reducedMotion || repeat) {
      // Straight to `gone`, because CSS never showed it, so no fade will end.
      setState('gone');
      return;
    }

    const remaining = COUNT_DURATION_MS - performance.now();
    if (remaining <= 0) {
      setState('done');
      return;
    }

    let startedAt: number | null = null;
    const step = (now: number): void => {
      // The first frame's timestamp starts the clock, so a frame spent elsewhere does not skip curve.
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

  // Removed, not left at zero opacity, because an invisible overlay is still a fixed full-viewport node.
  if (state === 'gone') return null;

  return (
    <div
      aria-hidden="true"
      className="prl-boot"
      data-state={state}
      onTransitionEnd={(event) => {
        // React transition events bubble, so ignore a child's.
        if (event.target !== event.currentTarget) return;
        if (event.propertyName !== 'opacity') return;
        setState('gone');
      }}
    >
      {/* A string expression, because a double slash in JSX text is linted as a comment. */}
      <p className="prl-boot__label">{'READY // CALIBRATING'}</p>
      {/* Rounded so the monospace counter stays three characters wide. */}
      <p className="prl-boot__count">{Math.round(count)}</p>
      <div className="prl-boot__rule" />
    </div>
  );
}
