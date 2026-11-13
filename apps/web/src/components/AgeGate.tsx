'use client';

/**
 * The age gate's one screen. A plain GET form that `src/proxy.ts` handles, so it works without
 * JavaScript. It is a client component only to move focus to the section on mount, because a
 * redirected screen-reader user would otherwise hear nothing about why they are here. `autoFocus`
 * is not serialised by the server render. Declining sits beside accepting at the same size and
 * records nothing (`docs/PRODUCT-GUARDRAILS.md` §2).
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
  /** Already through `safeReturnPath`. */
  readonly returnPath: string;
  readonly declined: boolean;
}

function reconsiderHref(returnPath: string): string {
  const params = new URLSearchParams();
  params.set(AGE_GATE_RETURN_PARAM, returnPath);
  return `${AGE_GATE_PATH}?${params.toString()}`;
}

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

          {/* Above the controls, so the reader knows what the click means before making it. */}
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

          {/* A value for a threshold no longer in use re-renders the question. */}
          <form action={AGE_GATE_PATH} className="prl-gate__form" method="get">
            <input name={AGE_GATE_RETURN_PARAM} type="hidden" value={returnPath} />
            <p className="prl-btn-row">
              <Button name={AGE_GATE_DECLARE_PARAM} type="submit" value={declarationValue(config.minimumAge)}>
                {`I am ${threshold} or older — open the tables`}
              </Button>
              {/* A link, because declining sends nothing. Same size as the button, so neither is easier. */}
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
