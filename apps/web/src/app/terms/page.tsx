/**
 * `/terms`. Factual sentences are checked against the schema and routes. Every legal conclusion carries
 * `COUNSEL_MARKER` and is listed in `docs/production/legal-review-requirements.md`. `legal-pages.test.ts`
 * reads this page's posture on enrolment and holds it and `db/migrations` to the same answer, so §8
 * describes the old free-of-charge clause instead of quoting it. `robots` is not overridden, because
 * indexing unreviewed placeholder clauses is worse than being unfindable. Counsel review decides that.
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
  LEGAL_DRAFTED_ON,
  LEGAL_PATHS,
  LEGAL_REVISION,
  NOT_SUPPLIED,
  PLAY_MONEY_WARNING,
  readLegalDeployment,
} from '@/lib/legal-config.ts';
import '../../styles/page.css';
import '../../styles/legal.css';

export const metadata: Metadata = {
  title: 'Terms of use',
  description:
    'What this educational play-money poker lab is, what you may do with it, and which clauses ' +
    'have not been written by a lawyer yet.',
};

/**
 * Repeated in each legal page to keep the marker beside its prose. The wording and clause ownership
 * live in `lib/legal-config.ts`, and `legal-pages.test.ts` asserts each clause is rendered.
 */
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

export default function TermsPage(): ReactElement {
  const deployment = readLegalDeployment();
  const gate = readAgeGateConfig();

  return (
    <div className="prl-container">
      <header className="prl-page-head">
        <p className="prl-label">Terms of use</p>
        <h1 className="prl-page-head__title prl-display-2">What this is, and what you may do with it</h1>
        <p className="prl-page-head__standfirst">
          A draft. The factual half of this page — what the software stores, what it refuses to do, what the
          chips are — is checked against the code and can be relied on. The legal half has not been written by
          a lawyer, and every clause of it is marked as such.
        </p>
      </header>

      <div className="prl-legal">
        <div className="prl-legal__banner">
          <p className="prl-legal__banner-mark prl-label">Not a reviewed document</p>
          <p>{COUNSEL_MARKER_EXPLANATION}</p>
        </div>

        <dl className="prl-legal__meta">
          <dt>Revision</dt>
          <dd>{`${LEGAL_REVISION}, drafted ${LEGAL_DRAFTED_ON}`}</dd>
          <dt>In effect from</dt>
          <dd>{deployment.effectiveDate ?? NOT_SUPPLIED}</dd>
          <dt>Operated by</dt>
          <dd>{deployment.operator ?? NOT_SUPPLIED}</dd>
          <dt>Contact</dt>
          <dd>{deployment.contact ?? NOT_SUPPLIED}</dd>
          <dt>Stated under the law of</dt>
          <dd>{deployment.governingLaw ?? NOT_SUPPLIED}</dd>
        </dl>

        <section className="prl-legal__section">
          <h2>1. What this software is</h2>
          <p>
            Poker Risk Lab is a teaching tool for the arithmetic of No-Limit Hold’em: probability, price,
            expected value, risk and variance. It contains lessons, quizzes, a scenario workbench, tables
            against simulated opponents, private invite-only tables, and a review screen that prices every
            decision after the fact.
          </p>
          <p>
            <strong>It is not a gambling product and it is not a route to one.</strong> There is no real money
            in it. There is nothing to buy, no deposit, no subscription tied to play, no prize, no tournament
            with an external reward, and no way to cash anything out. The chips are called <em>units</em>:
            they are free, they can be reset to the starting amount at any time from{' '}
            <Link href="/record">your record</Link>, and they have no value inside or outside this
            application. There is no column anywhere in the database that could hold a balance of money, no
            endpoint that could transfer a unit between accounts, and adding either would be a change to what
            the product is rather than a feature.
          </p>
          <p>{PLAY_MONEY_WARNING}</p>
        </section>

        <section className="prl-legal__section">
          <h2>2. Who is providing it to you</h2>
          <p>
            This software is open source and can be run by anybody. The entity running <em>this</em> instance
            is whoever is named in the box above, and they — not the authors of the software — are the party
            you are dealing with.
          </p>
          <CounselFlag clause={COUNSEL_CLAUSES['operator-identity']} />
        </section>

        <section className="prl-legal__section">
          <h2>3. Who may use it</h2>
          {gate.mode === 'on' ? (
            <p>
              {`This deployment asks visitors to declare that they are ${String(gate.minimumAge)} or older before opening a table. `}
              <Link href={AGE_GATE_PATH}>That check</Link> is a self-declaration: nothing is verified, no
              document is asked for and no date of birth is stored. It is a statement by the operator about
              the audience they intend, not a control that can enforce one.
            </p>
          ) : (
            <p>
              <strong>This deployment has not set a minimum age.</strong> The software can be configured to
              ask for a self-declared age before the tables open, and whoever runs this instance has not
              turned that on. There is no age requirement stated here, because stating one that nothing had
              decided would be worse than saying so plainly.
            </p>
          )}
          <p>
            One person, one account. You may not use this service to build a dataset for another product, to
            run automated play at a scale that degrades it for other readers, or to attempt to reach another
            player’s private cards — the last of those is the one property the whole server design exists to
            guarantee, and attempting to break it is the clearest thing on this page that you may not do.
          </p>
          <CounselFlag clause={COUNSEL_CLAUSES['age-threshold']} />
        </section>

        <section className="prl-legal__section">
          <h2>4. Your account, and the only text you can write</h2>
          <p>
            An account is created for you the first time you open a lesson, the Scenario Lab or your record —
            no email, no password, no confirmation. It is a real row in a database with an identifier and a
            display name, which is generated for you (something like <em>Guest 3F9A21</em>) unless you choose
            one.
          </p>
          <p>
            The only free text you can put into this product is a display name and the name of a private
            table, both between 2 and 24 characters (48 for a table), both refused if they contain control
            characters. <strong>There is no chat.</strong> There are no avatars, no uploads, no profiles and
            no public lobby: tables are invite-only, and that is enforced by a constraint in the database
            rather than by a setting, so it cannot be switched on without a migration and a review. A name
            that impersonates somebody, or that would be abuse if anyone could see it, may be changed or the
            account closed.
          </p>
          <p>
            An invite code is shown to you exactly once, when you create a table. Only a hash of it is stored,
            so nobody — including the operator — can recover it afterwards.
          </p>
        </section>

        <section className="prl-legal__section">
          <h2>5. The opponents, and the names on them</h2>
          <p>
            The simulated opponents are configurable sets of tendencies: how often a model enters a pot, how
            aggressively it bets, how much it adjusts to position and stack depth. Each one is defined
            entirely by a numeric trait vector, which is shown to you on its own profile card.{' '}
            <strong>
              They are not real people, not digital copies of anybody, and not endorsed by anyone.
            </strong>{' '}
            Nothing in this product reproduces how a named person plays, and no commentary here narrates
            anybody’s thoughts — the software has no field capable of holding such a claim.
          </p>
          <p>
            By default every profile is shown under a generic archetype name that describes what it does. A
            deployment can be configured to show attributed names instead; the educational content is
            byte-identical either way, which is the evidence that the names are mnemonics and the traits are
            the substance.
          </p>
          <CounselFlag clause={COUNSEL_CLAUSES['ai-legend-naming']} />
        </section>

        <section className="prl-legal__section">
          <h2>6. Nothing here is advice, and nothing here claims to be right</h2>
          <p>
            Every figure this product shows you is computed at the moment you ask for it, and arrives with the
            method used, the assumptions it rests on, and — where it was sampled rather than enumerated — an
            interval around it. That is a commitment to showing our working. It is not a claim of correctness.
          </p>
          <p>
            The Coach does not tell you the right play, and the type it returns has no field capable of
            expressing one: a suggestion carries an action, a size range, a confidence level that may be low,
            a reason, and a list of what would change it. Where a real opponent breaks an assumption, the
            analysis is the thing that is wrong. Nothing in this product is financial, legal or professional
            advice of any kind.
          </p>
          <p>
            Some screens can fall back to a copy of a worked example bundled with the application when the
            service that computes figures cannot be reached. Those screens say so, at the top, where you are
            reading them. A bundled figure ships with the app rather than being computed for you, so it can be
            out of date.
          </p>
        </section>

        <section className="prl-legal__section">
          <h2>7. What access to this costs, and what the software records about it</h2>
          <p>
            <strong>This software cannot take money, and it cannot tell whether you paid.</strong> Nothing in
            it can charge a card, and there is no column anywhere in its database that could hold an amount, a
            currency or a price — not empty ones: no such columns exist, which is something you can check for
            yourself by reading the migrations in <code>db/migrations</code>. A test in the repository fails
            the build if one is added.
          </p>
          <p>
            What it can record is that whoever operates this instance <em>enrolled</em> you: a place in a
            named group of learners, granted on a named operator’s stated authority, alongside one opaque
            reference to whatever arrangement was made outside this system, when the place begins and ends,
            and — if the place is withdrawn — when, by whom and why. A withdrawal is written down rather than
            erased, so the record of it survives. Your place also ends when the group’s own period ends,
            whatever your row says, because the two are read together.{' '}
            <strong>An enrolment record is not evidence that money changed hands.</strong> A deployment may
            enrol a scholarship group, a class of employees or a set of friends for nothing at all, and the
            rows look identical either way — the reference may literally be the word <em>scholarship</em> —
            because the only thing this software knows is that an operator asserted you have a place.
          </p>
          <p>
            So whether you were charged for that place, what the charge bought, who took the money and what
            they owe you for it are all outside this software, and this page would be inventing them if it
            told you. What you were told when you were enrolled is the agreement; this document describes the
            software.
          </p>
          <CounselFlag clause={COUNSEL_CLAUSES['enrolment-and-fees']} />
        </section>

        <section className="prl-legal__section">
          <h2>8. Availability</h2>
          <p>
            There is no promise that it will be available, that your data will survive, or that any particular
            feature will continue to exist — and as far as the software goes that is a description of how it
            is built rather than a disclaimer somebody chose. Exactly one server process is authoritative for
            a table at a time, because two would deal two different hands; there is no undo; and the only
            copies of your rows are whatever backups the operator takes, which are restored whole or not at
            all. It may be taken down, reset or changed at any time by whoever runs it. Practically: keep
            nothing here that you would mind losing.
          </p>
          <p>
            <strong>
              What that does not decide is whether the operator may do any of it without owing you something.
            </strong>{' '}
            Until revision 0.1 of these terms this clause opened by saying the service was given to you for
            nothing, and every promise it withheld was reasonable on that footing. It is no longer a footing
            this software can stand on: section 7 explains that an enrolment record says nothing about money,
            so this page cannot know whether you are reading it as somebody who paid for a course. Withholding
            availability and data survival from somebody who did is a commercial decision, and it has not been
            made here.
          </p>
          <CounselFlag clause={COUNSEL_CLAUSES['refunds-and-cancellation']} />
        </section>

        <section className="prl-legal__section">
          <h2>9. Liability</h2>
          <p>
            The software is provided as it is. The authors publish it under the licence in the repository and
            make no warranty about it.
          </p>
          <CounselFlag clause={COUNSEL_CLAUSES['liability-and-warranty']} />
        </section>

        <section className="prl-legal__section">
          <h2>10. Regulatory status</h2>
          <p>
            The facts are settled and checkable: no stake, no purchase, no prize, no cash-out, no transfer, no
            ledger of value. What those facts mean under the law of any particular place is not.
          </p>
          <CounselFlag clause={COUNSEL_CLAUSES['play-money-classification']} />
        </section>

        <section className="prl-legal__section">
          <h2>11. Governing law</h2>
          <CounselFlag clause={COUNSEL_CLAUSES['governing-law']} />
        </section>

        <section className="prl-legal__section">
          <h2>12. Changes</h2>
          <p>
            {`These terms are revision ${LEGAL_REVISION}, drafted on ${LEGAL_DRAFTED_ON}. When the text changes, the revision changes with it. There is no notification mechanism in this product — no email address is stored to send one to — so the revision line at the top of this page is the whole of how you can tell.`}
          </p>
        </section>
      </div>

      <p className="prl-page-nav">
        <Link href={LEGAL_PATHS.privacy}>What is stored about you</Link>
        <Link href={LEGAL_PATHS.responsibleUse}>Responsible use</Link>
        <Link href="/record">Your record</Link>
      </p>
    </div>
  );
}
