'use client';

/**
 * The first-run explainer: three things worth knowing before the first lesson.
 *
 * ## What this deliberately is not
 *
 * Not a modal, not a tour with a spotlight, not a countdown, and not a reward. It is a panel at
 * the top of the curriculum with three short steps and two ways out, and once it is dismissed it
 * never appears again. The product guardrails rule out urgency and variable reward; a first-run
 * overlay that has to be cleared before the page can be used is the mildest form of both, and
 * the content of this one — "the chips are worthless, the Coach might be wrong, start here" — is
 * the opposite of a hook.
 *
 * ## Why it does not steal focus
 *
 * A modal would have to trap focus and would put an obstacle between a reader and the thing they
 * navigated to. This does neither: it is in the document after the page heading, it is reachable
 * by `Tab` in reading order, and the reader can ignore it entirely. Focus moves only when *they*
 * change step, and then only to the new step's heading, which is where a reader who just pressed
 * "next" expects to be.
 *
 * ## Why it renders nothing on the first paint
 *
 * Whether it has been dismissed lives in `localStorage`, which the server cannot read. Rendering
 * the panel and then removing it would be a flash of content that a returning learner sees on
 * every visit; rendering nothing and then adding it is a one-off shift on the very first visit
 * only, immediately after load, above content nobody has started reading. The second is the
 * cheaper mistake by a wide margin.
 *
 * `localStorage` rather than a cookie or the API: this is a per-device UI preference with no
 * bearing on anything the server does, and sending it to the server would make a
 * "have you seen the intro" fact into an account-level record for no gain.
 */

import { Button, Callout, formatIndex, UNITS_EXPLANATION } from '@prl/ui';
import Link from 'next/link';
import { type ReactElement, useEffect, useRef, useState } from 'react';

/** Namespaced so it cannot collide with anything else this origin stores. */
const DISMISSED_KEY = 'prl.learn.onboarding.dismissed';

export interface OnboardingProps {
  /** Where "start here" points. `null` when every lesson is already marked read. */
  readonly startHref: string | null;
  readonly startTitle: string | null;
  /** The start-here lesson's number in the curriculum, for the `01` motif. */
  readonly startPosition: number | null;
}

interface Step {
  readonly title: string;
  readonly body: readonly string[];
}

/**
 * Three steps, in the order a learner needs them: what the chips are, what the Coach is, where to
 * begin. The units wording comes from `UNITS_EXPLANATION` in `@prl/ui` rather than being written
 * again here, because that string is also what the header badge says and the two must not drift.
 */
const STEPS: readonly Step[] = [
  {
    title: 'The chips are not money',
    body: [
      UNITS_EXPLANATION,
      'Nothing in this app can be bought and nothing can be won. There is no deposit, no cash-out, no prize and no leaderboard. The units exist so that a decision has a size, which is what makes the arithmetic mean anything.',
    ],
  },
  {
    title: 'The Coach shows its working, and can be wrong',
    body: [
      'Every figure the Coach gives you arrives with how it was computed, how uncertain it is, and the assumptions it rests on. Those assumptions are always on screen — never behind a toggle — because a number without them is a guess wearing a lab coat.',
      'It does not tell you the right play. It tells you what the maths says under stated assumptions, and it labels its own confidence. Where a real opponent breaks an assumption, the Coach is the thing that is wrong.',
    ],
  },
  {
    title: 'Start at the beginning, or anywhere',
    body: [
      'The lessons are numbered and each one lists what it assumes you have read. Nothing is locked: if variance is what you came for, read variance first and come back for the prerequisites when a sentence stops making sense.',
      'Quizzes are not scored. There is no mark, no streak and no pass — getting one wrong opens the explanation and a link back to the lesson, and that is the whole consequence.',
    ],
  },
];

export function Onboarding(props: OnboardingProps): ReactElement | null {
  const { startHref, startTitle, startPosition } = props;
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stepped = useRef(false);

  useEffect(() => {
    // A browser with storage disabled throws on access rather than returning null, and the
    // honest response to "we cannot remember whether you have seen this" is not to nag: the panel
    // stays hidden rather than reappearing on every page load for the rest of time.
    try {
      if (window.localStorage.getItem(DISMISSED_KEY) === null) setVisible(true);
    } catch {
      setVisible(false);
    }
  }, []);

  /**
   * Focus follows a step change, and only a step change.
   *
   * `step` is the effect's *trigger* rather than a value it reads, which is why the linter cannot
   * see that it belongs in the list — and why removing it would silently stop focus following
   * "next", leaving a keyboard reader on a button whose surrounding text has changed underneath
   * them. `stepped` keeps the first render from stealing focus on page load.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `step` is the trigger; without it focus stops following navigation
  useEffect(() => {
    if (!stepped.current) return;
    headingRef.current?.focus();
  }, [step]);

  const dismiss = (): void => {
    setVisible(false);
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Storage refused. The panel is gone for this page view, which is what was asked for; it
      // will be back next time, and there is nothing further to do about it.
    }
  };

  if (!visible) return null;
  const current = STEPS[step];
  if (current === undefined) return null;
  const isLast = step === STEPS.length - 1;

  return (
    <section className="prl-learn-onboarding" aria-labelledby="prl-onboarding-title">
      <header className="prl-learn-onboarding__head">
        <span className="prl-label" id="prl-onboarding-title">
          Before you start
        </span>
        <ol className="prl-learn-onboarding__steps">
          {STEPS.map((entry, index) => (
            <li className="prl-learn-onboarding__step" key={entry.title}>
              <button
                type="button"
                className="prl-learn-onboarding__step-btn"
                {...(index === step ? { 'aria-current': 'step' as const } : {})}
                onClick={() => {
                  stepped.current = true;
                  setStep(index);
                }}
              >
                <span className="prl-index" aria-hidden="true">
                  {formatIndex(index + 1)}
                </span>
                <span className="prl-visually-hidden">{`Step ${index + 1}: ${entry.title}`}</span>
              </button>
            </li>
          ))}
        </ol>
      </header>

      <h2 className="prl-learn-onboarding__title" id="prl-onboarding-step" ref={headingRef} tabIndex={-1}>
        {current.title}
      </h2>
      {current.body.map((paragraph) => (
        <p className="prl-learn-onboarding__body" key={paragraph.slice(0, 32)}>
          {paragraph}
        </p>
      ))}

      {isLast && startHref !== null ? (
        <Callout tone="insight" title="Suggested first lesson">
          <Link className="prl-learn-onboarding__start" href={startHref}>
            <span className="prl-index" aria-hidden="true">
              {startPosition === null ? '' : formatIndex(startPosition)}
            </span>
            {startTitle ?? 'Start at the top of the curriculum'}
          </Link>
        </Callout>
      ) : null}

      <div className="prl-btn-row prl-learn-onboarding__actions">
        <Button
          variant="ghost"
          disabled={step === 0}
          onClick={() => {
            stepped.current = true;
            setStep(step - 1);
          }}
        >
          Back
        </Button>
        {isLast ? (
          <Button variant="secondary" onClick={dismiss}>
            Got it — don't show this again
          </Button>
        ) : (
          <Button
            variant="secondary"
            onClick={() => {
              stepped.current = true;
              setStep(step + 1);
            }}
          >
            Next
          </Button>
        )}
        <Button variant="ghost" onClick={dismiss}>
          Skip
        </Button>
      </div>
    </section>
  );
}
