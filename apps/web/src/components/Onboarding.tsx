'use client';

/**
 * The first-run explainer, three steps before the first lesson. An in-flow panel, not a modal, so it
 * traps nothing and can be ignored. Focus moves only when the reader changes step.
 * The dismissal is a per-device `localStorage` flag the server cannot read, so the first paint
 * renders nothing. A one-off shift on a first visit beats a flash on every return visit.
 */

import { Button, Callout, formatIndex, UNITS_EXPLANATION, useFocusOnChange } from '@prl/ui';
import Link from 'next/link';
import { type ReactElement, useEffect, useRef, useState } from 'react';

const DISMISSED_KEY = 'prl.learn.onboarding.dismissed';

export interface OnboardingProps {
  /** `null` when every lesson is already marked read. */
  readonly startHref: string | null;
  readonly startTitle: string | null;
  readonly startPosition: number | null;
}

interface Step {
  readonly title: string;
  readonly body: readonly string[];
}

/** `UNITS_EXPLANATION` is shared with the header badge so the two cannot drift. */
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
  useFocusOnChange(headingRef, step);

  useEffect(() => {
    // Disabled storage throws. Stay hidden rather than reappear on every page load.
    try {
      if (window.localStorage.getItem(DISMISSED_KEY) === null) setVisible(true);
    } catch {
      setVisible(false);
    }
  }, []);

  const dismiss = (): void => {
    setVisible(false);
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Storage refused. Hidden for this page view only.
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
                onClick={() => setStep(index)}
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
        <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>
          Back
        </Button>
        {isLast ? (
          <Button variant="secondary" onClick={dismiss}>
            Got it — don't show this again
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => setStep(step + 1)}>
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
