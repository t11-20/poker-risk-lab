/**
 * `/record` — what this learner has actually done, and the reset every page promises them.
 *
 * ## Why this route exists
 *
 * `GET /me/progress` was in no client. Nothing in `apps/web` called it, so not one of its figures
 * had ever been shown to the learner it was about, and `POST /me/units/reset` — which the footer
 * advertises on every page as available "whenever you like" — had no control anywhere.
 *
 * ## Why it is not on `/learn`, and not in the main navigation
 *
 * `/learn`'s own header states the line it holds: "the page will tell you how long the syllabus is,
 * and it will not tell you how you are doing against it." Putting a count of finished lessons on
 * the curriculum index would put a progress bar next to a syllabus, which is the shape the product
 * guardrails rule out — and the five numbered destinations are an argument about learning order
 * that a sixth entry would blunt. So this is its own page, reached from the footer's units
 * paragraph, which is where the promise it honours is actually made.
 *
 * ## Counted, never scored — on this page as much as in the API
 *
 * No percentage complete, no rank, no streak, no "you are ahead of N% of learners", no target and
 * no chart of anything over time. Every figure says how much you have looked at; none says how well
 * you did. `quizQuestionsAnswered` counts questions answered right or wrong, and whether they
 * matched is not in the response at all. See `apps/api/src/routes/progress.ts` and
 * `docs/PRODUCT-GUARDRAILS.md`.
 *
 * ## A server render, with one client island
 *
 * The figures are the reader's own, so this is a per-reader render carrying their session cookie
 * (`lib/server-session.ts`), which also makes the route dynamic — correct, because a private record
 * must never be prerendered or cached. Only the two controls — the reset and the deletion — are
 * client components, because a mutation needs the CSRF token that only a browser holds.
 *
 * ## Why the way out is on this page and not somewhere quieter
 *
 * This is the page that shows a reader what the product holds about them, so it is the page where
 * "and here is how to have none of it held" belongs. Anywhere else would be a deletion control
 * that has to be gone looking for.
 */

import { Callout, Metric, Panel, pluralise } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { LEARN_PATH } from '@/lib/learn-data.ts';
import {
  loadRecord,
  RECORD_EXPLANATIONS,
  RECORD_FIGURES,
  RECORD_LABELS,
  type RecordFigureName,
} from '@/lib/record-data.ts';
import { readerCallOptions } from '@/lib/server-session.ts';
import { DeleteAccount } from './DeleteAccount.tsx';
import { UnitsReset } from './UnitsReset.tsx';
import '../../styles/page.css';

export const metadata: Metadata = {
  title: 'Your record',
  description:
    'What you have read, tried, answered and played, counted and never scored — the control that ' +
    'resets your practice units to the starting amount, and the one that deletes your account.',
};

/**
 * `units` for the signed quantity, `number` for the counts.
 *
 * `unitsNetLifetime` is the only figure here that can be negative, and it is formatted as units so
 * the sign is rendered rather than dropped. A count with a sign would be nonsense; a net result
 * without one would be a lie.
 */
function formatOf(figure: RecordFigureName): 'number' | 'units' {
  return figure === 'unitsNetLifetime' ? 'units' : 'number';
}

/** The reset block, which is shown whatever state the figures are in. It is a right, not a reward. */
function ResetPanel(): ReactElement {
  return (
    <Panel title="Reset your units" eyebrow="Always available" index={2} headingLevel={2}>
      <p className="prl-prose">
        Units are free practice counters with no value of any kind: they cannot be bought, transferred,
        redeemed or cashed out. Resetting them puts your balance back to the starting amount and puts every
        seat you currently hold back to its table’s starting stack. It costs nothing, it is not recorded as
        anything, and you may do it as often as you like.
      </p>
      <p className="prl-prose">
        It does not erase anything. The hands you have played stay in your history, and the net figure above
        is a sum over those hands rather than a balance — so it does not move either. A reset that quietly
        rewrote a finished table’s numbers would be editing the record instead of clearing the board.
      </p>
      <UnitsReset />
    </Panel>
  );
}

/**
 * The way out, and it is deliberately the last thing on the page.
 *
 * Below the reset rather than beside it, because the two are opposites and a reader skimming for
 * "put my units back" must not land on "erase everything" by muscle memory. The panel index
 * continues the page's numbering so the visual order and the reading order agree.
 *
 * Shown whenever there is an account to delete, which is every state except `signedOut` — a reader
 * whose record could not be FETCHED still has one, and a page that hid the way out whenever it
 * could not draw a figure would make leaving conditional on the API being healthy. The caller
 * below is where that condition lives, with the reasoning next to it.
 *
 * The panel's own copy is the summary; the control expands into the full list of what goes and
 * what stays before anything can be pressed. Everything true about that list is enforced in
 * `db/migrations/0004_account_deletion.sql` and proved in `apps/api/test/account-deletion.test.ts`,
 * which is what stops these sentences from becoming a claim nobody checks.
 */
function DeletePanel(): ReactElement {
  return (
    <Panel title="Delete your account" eyebrow="Irreversible" index={3} headingLevel={2}>
      <p className="prl-prose">
        You can close this account and take your record with you. Your sign-ins, the lessons you have marked
        as read, your quiz answers, your scenario decisions and your seat at every table are deleted outright
        — there is no recovery and no grace period.
      </p>
      <p className="prl-prose">
        Two things are kept rather than deleted, with your name removed from them: the hands you have played,
        and any table you created. A hand belongs to everybody who was in it — deleting it would erase it from
        their history too — so the seat stays and stops naming anybody. Tables you created are closed and
        detached for the same reason: the hands played at them would go with them.
      </p>
      <DeleteAccount />
    </Panel>
  );
}

export default async function RecordPage(): Promise<ReactElement> {
  const record = await loadRecord(await readerCallOptions());

  return (
    <div className="prl-container">
      <header className="prl-page-head">
        <p className="prl-label">Your record</p>
        <h1 className="prl-page-head__title prl-display-2">What you have actually done</h1>
        <p className="prl-page-head__standfirst">
          Six counts and two lists, and nothing else. There is no score on this page, no percentage complete,
          no streak and no rank — not because they were left out, but because the database has no column one
          could be stored in and the response type has no field one could be sent in.
        </p>
      </header>

      {record.state === 'signedOut' ? (
        <Callout tone="insight" title="There is no session to read a record with">
          A record belongs to one learner, so there is no anonymous version of this page to show you — an
          empty one would look like a record of having done nothing, which is a different claim. Opening the
          table creates a guest session in one request, with no email and no password, and everything you do
          from then on is counted here. <Link href="/play">Open a table</Link>, or{' '}
          <Link href={LEARN_PATH}>start reading</Link>.
        </Callout>
      ) : null}

      {record.state === 'unavailable' ? (
        <Callout tone="warning" title="Your record could not be fetched">
          {`${record.reason} Nothing is shown rather than zeroes: a zero here would be a claim about your record, and this page does not have one to make.`}
        </Callout>
      ) : null}

      {record.state === 'ready' ? (
        <Panel title="What you have covered" eyebrow="Counted, not scored" index={1} headingLevel={2}>
          <div className="prl-metric-row">
            {RECORD_FIGURES.map((name) => (
              <Metric
                key={name}
                label={RECORD_LABELS[name]}
                value={
                  name === 'lessonsCompleted'
                    ? record.progress.lessonsCompleted.length
                    : name === 'scenariosAttempted'
                      ? record.progress.scenariosAttempted.length
                      : record.progress[name]
                }
                format={formatOf(name)}
                size="md"
                note={RECORD_EXPLANATIONS[name]}
              />
            ))}
          </div>

          <dl className="prl-stat__pair">
            <dt className="prl-label">Topics touched</dt>
            <dd>
              {record.progress.topicsTouched.length === 0
                ? 'None yet — a topic appears here once you finish a lesson or try a scenario in it.'
                : record.progress.topicsTouched.join(', ')}
            </dd>
            <dt className="prl-label">Lessons finished</dt>
            <dd>
              {record.progress.lessonsCompleted.length === 0
                ? 'None yet.'
                : record.progress.lessonsCompleted.join(', ')}
            </dd>
            <dt className="prl-label">Scenarios tried</dt>
            <dd>
              {record.progress.scenariosAttempted.length === 0
                ? 'None yet.'
                : record.progress.scenariosAttempted.join(', ')}
            </dd>
          </dl>

          <p className="prl-note">
            {`Topics are derived from the content bundle when this page is read, not stored against your record — so a lesson that is retired contributes no topic rather than breaking the count. ${pluralise(record.progress.topicsTouched.length, 'topic')} so far.`}
          </p>
        </Panel>
      ) : null}

      <ResetPanel />

      {/*
        Hidden for a reader with no session, and shown in both of the other states.

        Not a tidiness rule: there is no account to delete when nobody is signed in, so the control
        could only ever produce a 401, and offering an irreversible action that cannot work is worse
        than not offering it. `unavailable` is a different case and keeps the panel — that reader
        has an account, and whether they can leave must not depend on whether their figures loaded.
      */}
      {record.state === 'signedOut' ? null : <DeletePanel />}

      <p className="prl-page-nav">
        <Link href={LEARN_PATH}>Back to the curriculum</Link>
        <Link href="/play">Open a table</Link>
        <Link href="/review">Your hand history</Link>
      </p>
    </div>
  );
}
