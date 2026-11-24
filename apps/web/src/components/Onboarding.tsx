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
      `${UNITS_EXPLANATION} Units exist purely to give decisions a clear size for arithmetic.`,
    ],
  },
  {
    title: 'The Coach shows its working',
    body: [
      'Every figure shows how it was computed, its uncertainty, and the assumptions it rests on — always visible so you can spot when an assumption breaks.',
    ],
  },
  {
    title: 'Start anywhere, no scores',
    body: [
      'Nothing is locked and quizzes are ungraded. Start at Lesson 01 or jump straight to any topic.',
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
            Got it
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
