'use client';

/**
 * The turn clock: a conic-gradient ring that drains, with the seconds left printed inside it.
 *
 * ## The ring is animated by CSS, never by re-rendering
 *
 * A turn timer is the one thing on this table that moves continuously, so it is also the one
 * thing most likely to cost frames. The naive implementation — `setInterval` at 60Hz writing a
 * new `stroke-dashoffset` or a new width — re-renders a React subtree and repaints an SVG sixty
 * times a second, per seat, for the entire duration of every turn.
 *
 * So the ring is a single element with a single animated custom property:
 *
 *   - `--prl-turn-progress` is registered with `@property` as a `<percentage>` (see
 *     components.css section 8). Registration is what makes it *interpolable*: an unregistered
 *     custom property has no type, so `@keyframes` would jump from 100% to 0% in one step.
 *   - One `@keyframes prl-turn-drain` runs 100% -> 0% over the whole turn budget.
 *   - This component contributes exactly two values, as data: `--prl-turn-duration` (the budget)
 *     and `--prl-turn-offset` (a NEGATIVE `animation-delay`).
 *
 * The negative delay is the trick that makes a mid-turn arrival correct. A frame that reaches the
 * client eight seconds into a thirty-second turn sets `--prl-turn-offset: -8000ms`, and the
 * browser starts the animation eight seconds in — the ring is already 27% drained on its first
 * paint. No keyframe has to be rewritten per instance, and React never touches the element again.
 *
 * ## Why the deadline is turned into a DURATION before it is used
 *
 * `WsState` sends `deadlineMs` and `serverTimeMs` — both on the *server's* clock. A client whose
 * clock is two minutes fast would compute a turn that has already expired; a client two minutes
 * slow would draw a full ring forever. Neither is a hypothetical: clock skew on consumer machines
 * is routine.
 *
 * `deadlineMs - serverTimeMs` is a **difference of two server readings**, so it is a duration and
 * it is clock-independent. That duration is the only thing this component uses. `Date.now()` is
 * never read, which is also why the server render and the hydration render agree: the initial
 * digits are a pure function of the props.
 *
 * From then on the countdown advances on `performance.now()`, which is monotonic — it cannot jump
 * when the system clock is corrected or the machine wakes from sleep.
 *
 * **The client is never the authority.** This is a readout of a deadline the server owns and the
 * server enforces; a ring that reaches zero does nothing at all. The server times the seat out.
 *
 * ## The digits tick once per second, and that is not an animation
 *
 * The only React state here is the whole number of seconds remaining, and the timeout that
 * advances it is scheduled to land on the next second *boundary* (`left % 1000`) rather than every
 * 1000ms, so the digits change when the number changes instead of drifting a fraction of a second
 * per tick. One re-render per second, not sixty.
 *
 * The digits survive `prefers-reduced-motion` deliberately. Under that preference the ring stops
 * being a clock and becomes a state (a full accent ring meaning "it is this seat's turn"), so the
 * text is the only remaining carrier of *how long is left* — and a timer that exists only as an
 * animation is a timer that does not exist for a reader who turned animation off. A number
 * changing once a second is information, not vestibular motion.
 *
 * ## Accessibility
 *
 * `role="timer"` is a live region whose implicit `aria-live` is `off`: assistive technology can
 * read it on demand but is not interrupted by it. That is the correct choice and the reason there
 * is no `aria-live="polite"` here — a polite region would announce "twenty-three seconds, twenty-two
 * seconds, twenty-one seconds" over the top of whatever the reader was doing, once a second, for
 * every turn. The visible digits are `aria-hidden` and the accessible name states the budget.
 */

import { type ReactElement, useEffect, useState } from 'react';
import { cx, type StyleWithVars } from '../cx.ts';
import { formatChips, pluralise } from '../format.ts';

const MS_PER_SECOND = 1000;

/** The server-owned turn deadline, exactly as `WsState` carries it. */
export interface TurnClock {
  /** Absolute time on the SERVER's clock by which the seat must act (`WsState.deadlineMs`). */
  readonly deadlineMs: number;
  /** The server's own clock reading in the same frame (`WsState.serverTimeMs`). */
  readonly serverTimeMs: number;
  /** The whole turn budget in seconds (`TableConfig.actionTimeoutSeconds`). */
  readonly budgetSeconds: number;
}

export interface TurnTimerProps {
  readonly clock: TurnClock;
  /** Whose clock this is, for the accessible name. */
  readonly label?: string;
  readonly className?: string;
}

/** Total, so a malformed frame produces a stopped clock rather than `NaN` in a CSS value. */
function clampDuration(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), max);
}

export function TurnTimer(props: TurnTimerProps): ReactElement {
  const { clock, label = 'Turn timer', className } = props;

  const budgetMs = Number.isFinite(clock.budgetSeconds)
    ? Math.max(Math.round(clock.budgetSeconds * MS_PER_SECOND), 0)
    : 0;
  // A duration, not a timestamp. See the module comment: this is the whole reason the client
  // clock is never consulted.
  const remainingAtFrameMs = clampDuration(clock.deadlineMs - clock.serverTimeMs, budgetMs);
  const elapsedAtFrameMs = budgetMs - remainingAtFrameMs;

  const [remainingMs, setRemainingMs] = useState(remainingAtFrameMs);

  useEffect(() => {
    // A new frame restarts the countdown from whatever the server last said. `Object.is` makes
    // this a no-op re-render when the value is unchanged.
    setRemainingMs(remainingAtFrameMs);
    if (remainingAtFrameMs <= 0) return;
    // No `performance` means no DOM (a server render, or a test environment without one). The
    // digits then simply hold the server's figure, which is the honest static rendering.
    if (typeof performance === 'undefined') return;

    const startedAt = performance.now();
    let handle: number | null = null;
    const tick = (): void => {
      const left = Math.max(remainingAtFrameMs - (performance.now() - startedAt), 0);
      setRemainingMs(left);
      if (left <= 0) return;
      // Wake on the next whole-second boundary. Scheduling a flat 1000ms instead would drift by
      // the timer's own lateness on every tick, so the digits would eventually skip a second.
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
  /**
   * The two values CSS needs, and nothing else. Both are strings derived from props, so React
   * writes them once and the animation is never restarted by a re-render of the digits beside it.
   */
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
      <span className="prl-turn-timer__value" aria-hidden="true">
        {formatChips(secondsLeft)}
        <span className="prl-turn-timer__unit">s</span>
      </span>
    </span>
  );
}
