'use client';

/**
 * The age gate's one screen: what it asks, what it admits it cannot do, and where it sends people.
 *
 * ## Why this is a form and not a button with an `onClick`
 *
 * A gate is the one control in the product that stands between a reader and everything else, so it
 * has to keep working when the JavaScript does not — a failed chunk, a blocked bundle, a browser
 * with script off. This is a plain `<form method="get">` pointing at the same route: the browser
 * submits it, `src/proxy.ts` recognises the declaration, sets the cookie and redirects. No fetch,
 * no route handler, no client state. `src/lib/age-gate.ts` explains at the `decideAgeGate` comment
 * why a GET is the right shape for a declaration that carries no account state and grants nothing
 * the reader could not grant themselves by clicking the button.
 *
 * ## Then why is it a client component at all
 *
 * For exactly one thing: moving focus. A reader who asked for `/play` and was redirected here has
 * been sent somewhere they did not choose, and a screen reader that reports nothing but "Poker Risk
 * Lab" and the site navigation leaves them to work out for themselves what happened. So on mount
 * focus moves to this section, whose accessible name is its own heading, and the explanation is
 * read out.
 *
 * `autoFocus` was the obvious alternative and does not work: `react-dom/server` does not serialise
 * it into the HTML — it is applied at hydration — so on a page whose whole point is to survive
 * without hydration it would do nothing precisely when it was needed. Focus is the only thing this
 * component needs the client for, and with script unavailable the gate still submits; the reader
 * simply lands at the top of the document like any other page.
 *
 * `tabIndex={-1}` makes the section focusable by script without adding a tab stop, the same
 * mechanism `layout.tsx` uses for `<main>` and for the same reason. Unlike `<main>`, this one keeps
 * its focus ring: a sighted keyboard user needs to see where they were just put.
 *
 * ## What this screen is not
 *
 * Not a modal, not a countdown, not a "are you sure you want to leave" and not a dark pattern of
 * any kind (`docs/PRODUCT-GUARDRAILS.md` §2). Declining is one control, sitting beside accepting,
 * and it leads to a page that explains rather than to a dead end. Nothing about the layout makes
 * one of the two answers easier to give than the other, which is the specific manipulation that
 * every gate of this kind is built to perform.
 *
 * Nothing is recorded either way. A declination writes no cookie, no row and no log line, and there
 * is nowhere in the schema a date of birth could be stored even if one were asked for.
 */

import { Button } from '@prl/ui';
import Link from 'next/link';
import { type ReactElement, useEffect, useId, useRef } from 'react';
import {
  AGE_GATE_DECLARE_PARAM,
  AGE_GATE_DECLINED_PARAM,
  AGE_GATE_DECLINED_VALUE,
  AGE_GATE_PATH,
  AGE_GATE_RETURN_PARAM,
  type AgeGateConfig,
  declarationValue,
} from '@/lib/age-gate.ts';
import { LEGAL_PATHS, PLAY_MONEY_WARNING } from '@/lib/legal-config.ts';

export interface AgeGateProps {
  readonly config: AgeGateConfig;
  /** Where the reader was going, already through `safeReturnPath`. Never echoed unvalidated. */
  readonly returnPath: string;
  /** True when the reader used the "I am under" control. Changes the copy and records nothing. */
  readonly declined: boolean;
}

/** The link back to the question, preserving where the reader was going. */
function reconsiderHref(returnPath: string): string {
  const params = new URLSearchParams();
  params.set(AGE_GATE_RETURN_PARAM, returnPath);
  return `${AGE_GATE_PATH}?${params.toString()}`;
}

/** The link to the declined view, which is a different explanation of the same page. */
function declineHref(returnPath: string): string {
  const params = new URLSearchParams();
  params.set(AGE_GATE_RETURN_PARAM, returnPath);
  params.set(AGE_GATE_DECLINED_PARAM, AGE_GATE_DECLINED_VALUE);
  return `${AGE_GATE_PATH}?${params.toString()}`;
}

export function AgeGate(props: AgeGateProps): ReactElement {
  const { config, returnPath, declined } = props;
  const titleId = useId();
  const sectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    sectionRef.current?.focus();
  }, []);

  const threshold = String(config.minimumAge);

  return (
    <section aria-labelledby={titleId} className="prl-gate" ref={sectionRef} tabIndex={-1}>
      {config.mode === 'off' ? (
        <>
          <h2 className="prl-gate__title" id={titleId}>
            This deployment has not set an age check
          </h2>
          <p className="prl-prose">
            Nothing is being asked of you, and nothing on this page has any effect. The software can be
            configured to ask readers to declare a minimum age before opening a table, and whoever runs this
            instance has not turned that on or chosen a threshold.
          </p>
          <p className="prl-prose">
            That is a decision they have to take with a lawyer rather than one this software makes for them:
            whether a free simulator with no stake, no purchase and no prize needs an age check at all depends
            on where it is offered. It is recorded as an open question in{' '}
            <code>docs/production/legal-review-requirements.md</code>.
          </p>
          <p className="prl-btn-row">
            <Link className="prl-gate__link" href={LEGAL_PATHS.responsibleUse}>
              How to use this responsibly
            </Link>
            <Link className="prl-gate__link" href={returnPath}>
              Carry on
            </Link>
          </p>
        </>
      ) : declined ? (
        <>
          <h2 className="prl-gate__title" id={titleId}>
            The tables are not for you yet
          </h2>
          <p className="prl-prose">
            Nothing was recorded — not your answer, not this visit, and not anything about you. There is no
            block and no penalty; you are simply not being shown the simulated tables on this deployment.
          </p>
          <p className="prl-prose">
            The written material is a different thing and it is still open. The lessons are about probability,
            expected value and variance, they use a deck of cards as the worked example, and there is no
            wagering of any kind in them. <Link href="/learn">Start reading</Link>, or read{' '}
            <Link href={LEGAL_PATHS.responsibleUse}>what this product is for</Link>.
          </p>
          <p className="prl-prose">
            <Link className="prl-gate__link" href={reconsiderHref(returnPath)}>
              Go back to the question
            </Link>
          </p>
        </>
      ) : (
        <>
          <h2 className="prl-gate__title" id={titleId}>
            {`Before you open a table: are you ${threshold} or older?`}
          </h2>

          <p className="prl-prose">
            This is a teaching tool for the arithmetic of No-Limit Hold’em — probability, price, expected
            value and variance. The chips are free counters called units. There is nothing to buy, nothing to
            win, no deposit, no cash-out and no way to move a unit between accounts, and there is no column
            anywhere in this application’s database that could hold a balance of money.
          </p>

          <p className="prl-prose">{PLAY_MONEY_WARNING}</p>

          {/*
            The honesty paragraph. It is above the controls rather than in small print below them,
            because a reader deciding what to click is entitled to know what the click means before
            they make it, and because a gate that overstates itself is worse than no gate — it lets
            an operator believe something has been verified when nothing has.
          */}
          <p className="prl-gate__caveat">
            <strong>This is a self-declaration, not a check.</strong> Pressing the control below tells this
            site nothing except that somebody pressed it. Nothing is verified, no document is asked for, no
            date of birth is stored — the database has no field for one — and the only thing kept is a browser
            cookie recording that the question was answered, so it is not asked again for a while.
          </p>

          {config.jurisdiction === null ? (
            <p className="prl-gate__caveat">
              {`The threshold of ${threshold} has not been tied to a named jurisdiction on this deployment. It is a number an operator configured, not a legal determination, and it may be wrong for where you are.`}
            </p>
          ) : (
            <p className="prl-gate__caveat">
              {`Whoever runs this deployment set the threshold at ${threshold} for ${config.jurisdiction}. That is their statement about their own obligations, not a finding by this software, and it may be wrong for where you are.`}
            </p>
          )}

          {/*
            `method="get"` on purpose: the proxy sets the cookie and redirects, so this works with
            no JavaScript at all. `action` is the gate's own path, so a submission with the value
            for a threshold this deployment no longer uses simply re-renders the question.
          */}
          <form action={AGE_GATE_PATH} className="prl-gate__form" method="get">
            <input name={AGE_GATE_RETURN_PARAM} type="hidden" value={returnPath} />
            <p className="prl-btn-row">
              <Button name={AGE_GATE_DECLARE_PARAM} type="submit" value={declarationValue(config.minimumAge)}>
                {`I am ${threshold} or older — open the tables`}
              </Button>
              {/*
                A link rather than a second submit button, because it is not a declaration: it
                changes what this page explains and sends nothing. Styled the same size as the
                button beside it, so neither answer is the easy one.
              */}
              <Link className="prl-gate__link" href={declineHref(returnPath)}>
                {`I am under ${threshold}`}
              </Link>
            </p>
          </form>

          <p className="prl-note">
            Either way you can read <Link href={LEGAL_PATHS.terms}>the terms</Link>,{' '}
            <Link href={LEGAL_PATHS.privacy}>what is stored about you</Link> and{' '}
            <Link href={LEGAL_PATHS.responsibleUse}>the responsible-use notes</Link> without answering
            anything. Those three pages are never behind this gate.
          </p>
        </>
      )}

      {config.problems.length > 0 ? (
        <div className="prl-gate__problems">
          <p className="prl-label">This deployment’s age-check settings could not be read</p>
          <ul className="prl-prose">
            {config.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <p className="prl-note">
            Shown rather than logged, because a setting that silently corrected itself is a setting nobody
            fixes. Every fallback above errs towards asking rather than towards letting through.
          </p>
        </div>
      ) : null}
    </section>
  );
}
