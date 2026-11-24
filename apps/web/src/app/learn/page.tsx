/**
 * The curriculum index, numbered in reading order so the numbers are the route "Next" takes
 * (`test/learn-index-reading-order.test.ts`). Nothing is locked and nothing is scored: no progress
 * bar, no "3 of 17", no streak. The top figures describe the curriculum, never the reader.
 */

import { Callout, Chip, formatIndex, Metric, Panel, pluralise } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { Onboarding } from '@/components/Onboarding.tsx';
import { SuitMark } from '@/components/SuitMark.tsx';
import {
  asDifficulty,
  buildCurriculum,
  type CurriculumEntry,
  DIFFICULTY_GLYPHS,
  DIFFICULTY_LABELS,
  startHereNote,
  topicLabel,
} from '@/lib/learn-curriculum.ts';
import { GLOSSARY_PATH, lessonHref, loadLessonList, READABLE_LESSON_IDS } from '@/lib/learn-data.ts';
import { readerCallOptions } from '@/lib/server-session.ts';

export const metadata: Metadata = {
  title: 'Learn',
  description:
    'The curriculum: numbered lessons on probability, outs, pot odds, expected value, bet sizing, ' +
    'ranges, variance and bankroll. Every figure is computed, never stored.',
};

/** A word and a shape, so it never depends on a colour. */
function DifficultyChip({ difficulty }: { readonly difficulty: string }): ReactElement {
  const known = asDifficulty(difficulty);
  if (known === null) return <Chip>{difficulty}</Chip>;
  return <Chip glyph={DIFFICULTY_GLYPHS[known]}>{DIFFICULTY_LABELS[known]}</Chip>;
}

function EntryCard({
  entry,
  isStart,
}: {
  readonly entry: CurriculumEntry;
  readonly isStart: boolean;
}): ReactElement {
  const { summary } = entry;
  return (
    <article className="prl-learn-entry" data-start={isStart ? 'true' : undefined}>
      <span className="prl-index prl-learn-entry__index" aria-hidden="true">
        {formatIndex(entry.position)}
      </span>
      <div className="prl-learn-entry__body">
        <h3 className="prl-learn-entry__title">
          <Link className="prl-learn-entry__link" href={lessonHref(summary.id)}>
            <span className="prl-visually-hidden">{`Lesson ${entry.position}: `}</span>
            {summary.title}
          </Link>
        </h3>
        <p className="prl-learn-entry__summary">{summary.summary}</p>
        <div className="prl-row prl-learn-entry__chips">
          {/* The topic, because the group heading already says the difficulty. */}
          <Chip>{topicLabel(summary.topic)}</Chip>
          <Chip>{pluralise(summary.estimatedMinutes, 'minute')}</Chip>
          {/* `=== true`, because `null` means nobody asked. */}
          {entry.completed === true ? <Chip glyph="✓">read</Chip> : null}
          {isStart ? <Chip glyph="▸">start here</Chip> : null}
          {summary.quizId === undefined ? null : <Chip glyph="?">has a quiz</Chip>}
        </div>
        {entry.prerequisites.length === 0 ? null : (
          <p className="prl-learn-entry__prereq">
            <span className="prl-label">Read first</span>
            {entry.prerequisites.map((prerequisite, position) => (
              <span key={prerequisite.id}>
                <Link className="prl-learn-entry__prereq-link" href={lessonHref(prerequisite.id)}>
                  {prerequisite.title}
                </Link>
                {position === entry.prerequisites.length - 1 ? '' : ','}
              </span>
            ))}
            {/* `false` only. `unlocked` is `null` when nobody checked. */}
            {entry.unlocked === false ? (
              <span className="prl-learn-entry__prereq-note">
                {entry.prerequisites.length === 1
                  ? ' — unread (optional)'
                  : entry.outstandingPrerequisites.length === 1
                    ? ' — 1 unread (optional)'
                    : ` — ${entry.outstandingPrerequisites.length} unread (optional)`}
              </span>
            ) : null}
          </p>
        )}
        {entry.readable ? null : (
          <p className="prl-learn-entry__pending">
            The content service is not reachable, and the bundled copy of the curriculum does not carry this
            lesson's text — so this link will tell you that rather than showing you an empty lesson.
          </p>
        )}
      </div>
    </article>
  );
}

export default async function LearnPage(): Promise<ReactElement> {
  const reader = await readerCallOptions();
  const lessons = await loadLessonList();
  const curriculum = buildCurriculum(lessons.data.lessons, {
    // Fixture coverage, so only for a fixture list. With a live list it flagged nine working lessons.
    ...(lessons.source === 'fixture' ? { readableIds: READABLE_LESSON_IDS } : {}),
    // Without a cookie the API answers `false` for everybody, which means unknown, not unread.
    completionKnown: lessons.source === 'api' && reader.cookie !== undefined,
  });
  const start = curriculum.startHere;

  return (
    <div className="prl-learn-page">
      <header className="prl-learn-page__head">
        <span className="prl-label prl-learn-page__eyebrow">
          <SuitMark area="learn" />
          Learn
        </span>
        <h1 className="prl-display-2">The curriculum</h1>
        <p className="prl-learn-page__lead">
          Seventeen lessons ordered by concept dependency — nothing is locked, so start anywhere. Every worked
          figure is computed live as you read.
        </p>
        {curriculum.completionKnown ? null : (
          // Said once in the lead, rather than hedged on seventeen cards.
          <p className="prl-note">
            Reading progress appears once you start a session and is tracked on{' '}
            <Link href="/record">your record</Link>.
          </p>
        )}
        <div className="prl-metric-row prl-learn-page__figures">
          <Metric label="Lessons" value={curriculum.lessonCount} format="number" size="md" />
          <Metric label="Topics" value={curriculum.topicCount} format="number" size="md" />
          <Metric
            label="Reading, end to end"
            value={curriculum.totalMinutes}
            format="number"
            unit="minutes"
            size="md"
            note="Estimated reading time."
          />
        </div>
      </header>

      {lessons.source === 'fixture' && lessons.fallbackReason !== null ? (
        <Callout tone="warning" title="This index is not live">
          {lessons.fallbackReason}
        </Callout>
      ) : null}

      <Onboarding
        startHref={start === null ? null : lessonHref(start.summary.id)}
        startTitle={start === null ? null : start.summary.title}
        startPosition={start === null ? null : start.position}
      />

      {start === null ? (
        <Panel className="prl-learn-start" eyebrow="Where to go next" title="Every lesson is marked read">
          <p>
            There is nothing left in the index to suggest. The Scenario Lab is where the same maths gets
            applied to spots you can change one input at a time.
          </p>
        </Panel>
      ) : (
        <Panel
          className="prl-learn-start"
          eyebrow={curriculum.completionKnown ? 'Start here' : 'Where the syllabus starts'}
          title={start.summary.title}
          index={start.position}
          actions={<DifficultyChip difficulty={start.summary.difficulty} />}
        >
          <p className="prl-learn-start__summary">{start.summary.summary}</p>
          <p className="prl-note">{startHereNote(start)}</p>
          <Link className="prl-btn prl-btn--primary prl-btn--lg" href={lessonHref(start.summary.id)}>
            {`Read lesson ${formatIndex(start.position)}`}
          </Link>
        </Panel>
      )}

      {curriculum.groups.map((group) => (
        <section className="prl-learn-group" key={group.key}>
          <header className="prl-learn-group__head">
            <h2 className="prl-learn-group__title">{group.label}</h2>
            <p className="prl-learn-group__meta">
              {`${pluralise(group.entries.length, 'lesson')} · ${pluralise(group.minutes, 'minute')}`}
            </p>
          </header>
          <div className="prl-learn-group__entries">
            {group.entries.map((entry) => (
              <EntryCard
                entry={entry}
                isStart={start !== null && start.summary.id === entry.summary.id}
                key={entry.summary.id}
              />
            ))}
          </div>
        </section>
      ))}

      <Panel className="prl-learn-glossary-cta" eyebrow="Reference" title="The glossary">
        <p>
          A hundred and six terms, plain language first — linked inline throughout every lesson.
        </p>
        <Link className="prl-btn prl-btn--secondary prl-btn--md" href={GLOSSARY_PATH}>
          Open the glossary
        </Link>
      </Panel>
    </div>
  );
}
