'use client';

/**
 * The turn clock, a conic-gradient ring that drains with the seconds left inside it.
 * The ring is animated by CSS, never by re-rendering. `--prl-turn-progress` is registered with
 * `@property` so it interpolates. This component sets only `--prl-turn-duration` and a negative
 * `--prl-turn-offset`, so a mid-turn arrival starts the animation part-drained.
 * Only `deadlineMs - serverTimeMs` is used, a duration between two server readings, so client clock
 * skew cannot matter and `Date.now()` is never read. The countdown runs on monotonic `performance.now()`.
 * The server enforces the deadline. A ring at zero does nothing.
 * The digits tick on whole-second boundaries and survive reduced motion, where they are the only clock.
 * The timer role is live but off by default, so it never announces every second.
 */

import { type ReactElement, useEffect, useState } from 'react';
import { cx, type StyleWithVars } from '../cx.ts';
import { formatChips, pluralise } from '../format.ts';

const MS_PER_SECOND = 1000;

export interface TurnClock {
  /** Absolute time on the SERVER's clock by which the seat must act. */
  readonly deadlineMs: number;
  /** The server's own clock reading in the same frame. */
  readonly serverTimeMs: number;
  /** The whole turn budget in seconds. */
  readonly budgetSeconds: number;
}

export interface TurnTimerProps {
  readonly clock: TurnClock;
  readonly label?: string;
  readonly className?: string;
}

/** Total, so a malformed frame produces a stopped clock rather than `NaN` in a CSS value. */
function clampDuration(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), max);
}

/**
 * One turn's countdown, remounted for each turn by its deadline key. Consecutive turns often have equal
 * remaining durations (5 of 12 hero-to-hero transitions at 1440x900), and without the key the old digits
 * and the old CSS animation kept running.
 */
export function TurnTimer(props: TurnTimerProps): ReactElement {
  return <TurnCountdown {...props} key={String(props.clock.deadlineMs)} />;
}

function TurnCountdown(props: TurnTimerProps): ReactElement {
  const { clock, label = 'Turn timer', className } = props;

  const budgetMs = Number.isFinite(clock.budgetSeconds)
    ? Math.max(Math.round(clock.budgetSeconds * MS_PER_SECOND), 0)
    : 0;
  const remainingAtFrameMs = clampDuration(clock.deadlineMs - clock.serverTimeMs, budgetMs);
  const elapsedAtFrameMs = budgetMs - remainingAtFrameMs;

  const [remainingMs, setRemainingMs] = useState(remainingAtFrameMs);

  useEffect(() => {
    setRemainingMs(remainingAtFrameMs);
    if (remainingAtFrameMs <= 0) return;
    // No `performance` means no DOM. The digits then hold the server's figure.
    if (typeof performance === 'undefined') return;

    const startedAt = performance.now();
    let handle: number | null = null;
    const tick = (): void => {
      const left = Math.max(remainingAtFrameMs - (performance.now() - startedAt), 0);
      setRemainingMs(left);
      if (left <= 0) return;
      // Wake on the next whole-second boundary. A flat 1000ms drifts by the timer's own lateness.
      const remainder = left % MS_PER_SECOND;
      handle = window.setTimeout(tick, remainder === 0 ? MS_PER_SECOND : remainder);
    };
    const first = remainingAtFrameMs % MS_PER_SECOND;
    handle = window.setTimeout(tick, first === 0 ? MS_PER_SECOND : first);

    return () => {
      if (handle !== null) window.clearTimeout(handle);
    };
  }, [remainingAtFrameMs]);

  const secondsLeft = Math.ceil(remainingMs / MS_PER_SECOND);
  /** Strings derived from props, so a re-render of the digits never restarts the animation. */
  const style: StyleWithVars = {
    '--prl-turn-duration': `${budgetMs}ms`,
    '--prl-turn-offset': `-${elapsedAtFrameMs}ms`,
  };

  return (
    <span
      className={cx('prl-turn-timer', className)}
      style={style}
      role="timer"
      aria-label={`${label}: ${pluralise(clock.budgetSeconds, 'second')} to act`}
    >
      <span className="prl-turn-ring prl-turn-timer__ring" aria-hidden="true" />
      <span
        className="prl-turn-timer__value"
        aria-hidden="true"
        data-digits={secondsLeft < 100 ? undefined : 3}
      >
        {formatChips(secondsLeft)}
        {/* No unit at three digits. "196s" painted 31.7px of glyphs across a 24px hole at 1440x900. */}
        {secondsLeft < 100 ? <span className="prl-turn-timer__unit">s</span> : null}
      </span>
    </span>
  );
}
