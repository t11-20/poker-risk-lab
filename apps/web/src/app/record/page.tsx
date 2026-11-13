/**
 * `/record`, the learner's own progress, the units reset the footer promises, and account deletion.
 * Not on `/learn` and not in the main navigation, because a progress count beside the syllabus is the
 * shape `docs/PRODUCT-GUARDRAILS.md` rules out. Counted, never scored: no percentage, rank or streak.
 * A per-reader render, so it is never prerendered or cached.
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
import { type RecordEntry, recordLists } from '@/lib/record-links.ts';
import { readerCallOptions } from '@/lib/server-session.ts';
import { AccountDeletion } from './DeleteAccount.tsx';
import { UnitsReset } from './UnitsReset.tsx';
import '../../styles/page.css';

export const metadata: Metadata = {
  title: 'Your record',
  description:
    'What you have read, tried, answered and played, counted and never scored — the control that ' +
    'resets your practice units to the starting amount, and the one that deletes your account.',
};

/** `unitsNetLifetime` is the only signed figure, so only it is formatted as units. */
function formatOf(figure: RecordFigureName): 'number' | 'units' {
  return figure === 'unitsNetLifetime' ? 'units' : 'number';
}

/** A list, not a comma-joined run, because the titles contain commas. */
function RecordList({
  entries,
  empty,
}: {
  readonly entries: readonly RecordEntry[];
  readonly empty: string;
}): ReactElement {
  if (entries.length === 0) return <>{empty}</>;
  return (
    <ul className="prl-record__list">
      {entries.map((entry) => (
        <li key={`${entry.href ?? ''}|${entry.label}`}>
          {entry.href === null ? entry.label : <Link href={entry.href}>{entry.label}</Link>}
        </li>
      ))}
    </ul>
  );
}

/** Shown whatever state the figures are in. */
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

export default async function RecordPage(): Promise<ReactElement> {
  const record = await loadRecord(await readerCallOptions());
  const lists = record.state === 'ready' ? recordLists(record.progress) : null;

  return (
    <div className="prl-container prl-record">
      <header className="prl-page-head">
        <p className="prl-label">Your record</p>
        <h1 className="prl-page-head__title prl-display-2">What you have actually done</h1>
        {/* A fact, not a design choice. `prl` has no column a score could be stored in. */}
        <p className="prl-page-head__standfirst">
          Six counts and two lists, and nothing else. There is no score on this page, no percentage complete,
          no streak and no rank, and there is nowhere in Poker Risk Lab for one to be kept: what you have done
          is counted, never graded.
        </p>
      </header>

      {record.state === 'signedOut' ? (
        <Callout tone="insight" title="This browser has no record yet">
          A record belongs to one learner, and this browser has not started one — so there is nothing to show
          you here, and an empty page would look like a record of having done nothing, which is a different
          claim. Opening a table starts a guest session straight away, with no email and no password, and
          everything you do from then on is counted here. <Link href="/play">Open a table</Link>, or{' '}
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
          <div className="prl-metric-row prl-record__figures">
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

          {lists === null ? null : (
            <dl className="prl-stat__pair prl-record__lists">
              <dt className="prl-label">Topics touched</dt>
              <dd>
                <RecordList
                  entries={lists.topics}
                  empty="None yet — a topic appears here once you finish a lesson or try a scenario in it."
                />
              </dd>
              <dt className="prl-label">Lessons finished</dt>
              <dd>
                <RecordList entries={lists.lessons} empty="None yet." />
              </dd>
              <dt className="prl-label">Scenarios tried</dt>
              <dd>
                <RecordList entries={lists.scenarios} empty="None yet." />
              </dd>
            </dl>
          )}

          <p className="prl-note">
            {`A topic counts once you have finished a lesson or tried a scenario in it. ${pluralise(record.progress.topicsTouched.length, 'topic')} so far.`}
          </p>
        </Panel>
      ) : null}

      <ResetPanel />

      {/*
        Last, below the reset, so a reader looking for one does not hit the other. Rendered
        unconditionally and kept in this slot, so its receipt survives the refresh after deletion.
      */}
      <AccountDeletion deletable={record.state !== 'signedOut'} />

      <p className="prl-page-nav">
        <Link href={LEARN_PATH}>Back to the curriculum</Link>
        <Link href="/play">Open a table</Link>
        <Link href="/review">Your hand history</Link>
      </p>
    </div>
  );
}
