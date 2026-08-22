/**
 * `/responsible-use` — what this product is for, what it cannot teach, and how to stop.
 *
 * ## Why it is a page and not a paragraph in the terms
 *
 * The terms are a document about obligations and almost nobody reads them. This is the page that
 * has something a learner actually needs: that practising against free chips does not tell you how
 * you behave when a loss costs something, that the tools for noticing you have been here two hours
 * are in the footer of every page, and that the product is built to be easy to leave.
 *
 * It is also the honest counterweight to the whole feature set. A poker simulator with correct
 * arithmetic and contrasting opponents is a good way to learn probability, and it is also a good
 * way to become more comfortable with a game that takes money from people. Both are true. Saying
 * only the first would make every other page in this app slightly dishonest.
 *
 * ## What is deliberately NOT on this page
 *
 * **A named helpline chosen by us.** The right organisation depends entirely on where a reader is,
 * and a wrong or out-of-date referral on a page about vulnerability is worse than an honest gap.
 * `PRL_LEGAL_SUPPORT_RESOURCE` lets an operator name one for their own audience, and it is rendered
 * as plain text rather than as a link — the value comes from a deployment's environment, and a
 * clickable destination on this page in particular is not somewhere to be relaxed about that.
 *
 * **Any of the mechanisms it is warning about.** No "you have played N hands today" counter, no
 * cooling-off timer that locks the tables, no scored self-assessment. Each of those is the same
 * attention-grab as the thing it claims to protect against, and `docs/PRODUCT-GUARDRAILS.md` §2
 * rules out the whole family. What is offered instead is a clock and an off switch.
 *
 * `robots` is not overridden here, for the reason written out on `/terms`.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { AGE_GATE_PATH, readAgeGateConfig } from '@/lib/age-gate.ts';
import {
  COUNSEL_CLAUSES,
  COUNSEL_MARKER,
  COUNSEL_MARKER_EXPLANATION,
  type CounselClause,
  LEGAL_PATHS,
  PLAY_MONEY_WARNING,
  readLegalDeployment,
} from '@/lib/legal-config.ts';
import '../../styles/page.css';
import '../../styles/legal.css';

export const metadata: Metadata = {
  title: 'Responsible use',
  description:
    'What this play-money lab is for, what it cannot teach you about playing for money, and the ' +
    'controls it gives you for noticing how long you have been here.',
};

/** See the note on the identical function in `app/terms/page.tsx` for why it is repeated. */
function CounselFlag(props: { readonly clause: CounselClause }): ReactElement {
  const { clause } = props;
  return (
    <div className="prl-legal-flag">
      <p className="prl-legal-flag__mark prl-label">{COUNSEL_MARKER}</p>
      <p>
        <strong>{clause.subject}.</strong> {clause.question}
      </p>
    </div>
  );
}

export default function ResponsibleUsePage(): ReactElement {
  const deployment = readLegalDeployment();
  const gate = readAgeGateConfig();

  return (
    <div className="prl-container">
      <header className="prl-page-head">
        <p className="prl-label">Responsible use</p>
        <h1 className="prl-page-head__title prl-display-2">What this can teach you, and what it cannot</h1>
        <p className="prl-page-head__standfirst">
          This is a maths tool that uses poker as its worked example. It is good at probability, price and
          variance. It is structurally incapable of teaching you the thing that decides most real results, and
          this page says which thing that is.
        </p>
      </header>

      <div className="prl-legal">
        <section className="prl-legal__section">
          <h2>1. The one warning that matters</h2>
          <p>
            <strong>{PLAY_MONEY_WARNING}</strong>
          </p>
          <p>
            The arithmetic here is correct and it transfers. Pot odds are pot odds; an equity figure computed
            from the actual deck is the same figure at any table. What does not transfer is everything that
            follows from a stake being real — the tilt after a bad beat that cost something, the call you make
            because you have already put money in, the session you extend because you are down. A free,
            resettable chip removes all of it by design, which is what makes this a good place to learn
            arithmetic and a bad place to conclude anything about how you would play for money.
          </p>
        </section>

        <section className="prl-legal__section">
          <h2>2. What this product refuses to do</h2>
          <p>
            These are constraints on what the product may be, not preferences, and most of them are enforced
            somewhere mechanical rather than left to whoever writes the next screen:
          </p>
          <ul>
            <li>
              <strong>No money, in any direction.</strong> Nothing to buy, no deposit, no prize, no cash-out,
              and no way to move a unit between accounts. There is no column in the database that could hold a
              balance and no endpoint that could transfer one.
            </li>
            <li>
              <strong>No streaks, levels, badges, daily rewards or leaderboards.</strong> Quiz answers are
              stored one row at a time with no aggregate score column, so there is nowhere a streak could be
              kept even if somebody wanted one.
            </li>
            <li>
              <strong>No loss-chasing prompts and no near-miss celebration.</strong> A hand played well and
              lost is reported as a hand played well. Feedback attaches to the quality of a decision, never to
              whether it won.
            </li>
            <li>
              <strong>No urgency, no countdowns that are not real, no autoplay, no infinite feed.</strong>{' '}
              Stopping is always one click and is never behind a confirmation designed to keep you.
            </li>
            <li>
              <strong>No claim to be right.</strong> Every figure carries its assumptions and its uncertainty,
              inline and never behind a toggle, and the analysis type has no field capable of expressing “this
              is the correct play”.
            </li>
          </ul>
          <p>
            Resetting your units is always available, costs nothing and is not recorded as anything —{' '}
            <Link href="/record">from your record</Link>, as often as you like.
          </p>
        </section>

        <section className="prl-legal__section">
          <h2>3. Noticing how long you have been here</h2>
          <p>
            A poker table has no natural end: the next hand always deals. At the bottom of every page there is
            a block called <strong>This sitting</strong> that tells you how long this tab has been open, and
            lets you pick an interval — fifteen minutes to an hour and a half — after which it will say so
            once.
          </p>
          <p>
            It is deliberately small. The reminder is a sentence in the footer; it does not interrupt, it does
            not cover the table, it never blocks a hand, and it never offers to “continue”. It starts counting
            when the tab is opened, it is not switched on by default, nothing about it is sent anywhere, and
            it is not attached to your account — the time is held in this tab and disappears when you close
            it. You can hide it, and hiding it lasts for the tab; opening a new one brings it back.
          </p>
          <p>
            If what you actually want is to stop, the honest advice is that no in-app timer is as effective as
            closing the tab, and nothing here will try to talk you out of it.
          </p>
        </section>

        <section className="prl-legal__section">
          <h2>4. Age</h2>
          {gate.mode === 'on' ? (
            <p>
              {`This deployment asks visitors to declare that they are ${String(gate.minimumAge)} or older before opening a table${gate.jurisdiction === null ? '' : `, a threshold its operator set for ${gate.jurisdiction}`}. `}
              <Link href={AGE_GATE_PATH}>The check</Link> is a self-declaration and nothing more: nothing is
              verified, no document is requested, and no date of birth is stored anywhere. It is a statement
              of intent by the operator, not a control that can enforce one.
            </p>
          ) : (
            <p>
              <strong>This deployment has not set a minimum age.</strong> The software can ask for a
              self-declared age before the tables open, and that has not been turned on here. Whether a free
              simulator with no stake and no prize needs an age check at all is a question for the operator’s
              lawyer rather than one this software answers on their behalf, and it is recorded as an open
              question in the deployment’s review document.
            </p>
          )}
          <CounselFlag clause={COUNSEL_CLAUSES['age-threshold']} />
        </section>

        <section className="prl-legal__section">
          <h2>5. The opponents are models, not people</h2>
          <p>
            Every simulated opponent is a set of numbers describing tendencies, shown to you on its own
            profile card. They are not real people, not copies of anybody, and not endorsed by anyone. No
            commentary in this product narrates a person’s thinking; the software has no field that could hold
            such a claim, and the profiles are shown under generic archetype names unless a deployment has
            deliberately configured otherwise.
          </p>
          <CounselFlag clause={COUNSEL_CLAUSES['ai-legend-naming']} />
        </section>

        <section className="prl-legal__section">
          <h2>6. If gambling is causing you harm</h2>
          <p>
            This application is not a gambling product and cannot take money from you. That is not the same as
            being unrelated: a poker simulator is a comfortable place to spend time with a game that does take
            money from people, and if that is where you are, a tool that makes the game more familiar is not
            what you need.
          </p>
          {deployment.supportResource === null ? (
            <p>
              Help exists and it is worth using. This page does not name an organisation, because which one is
              right depends on where you are and a wrong or out-of-date referral on a page like this is worse
              than an honest gap. Search for the national gambling-support service in your own country, or ask
              a doctor — both are better routes than a link chosen by software that does not know where you
              live.
            </p>
          ) : (
            <p>
              {`Whoever runs this deployment names this source of help for their audience: ${deployment.supportResource}. It is shown as text rather than as a link, and it is their statement rather than a recommendation by this software.`}
            </p>
          )}
          <CounselFlag clause={COUNSEL_CLAUSES['play-money-classification']} />
        </section>

        <div className="prl-legal__banner">
          <p className="prl-legal__banner-mark prl-label">Not a reviewed document</p>
          <p>{COUNSEL_MARKER_EXPLANATION}</p>
        </div>
      </div>

      <p className="prl-page-nav">
        <Link href={LEGAL_PATHS.terms}>Terms of use</Link>
        <Link href={LEGAL_PATHS.privacy}>What is stored about you</Link>
        <Link href="/learn">Start reading</Link>
      </p>
    </div>
  );
}
