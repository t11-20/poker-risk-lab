/**
 * The curriculum index: seventeen lessons as a numbered syllabus, grouped by topic.
 *
 * ## The numbering is the point
 *
 * `01 … 17` down the page, derived from the display order by `buildCurriculum` rather than stored
 * in the content. A flat list of seventeen links is a list; the same seventeen with numbers, topic
 * groups, prerequisites and reading times is a system a learner can hold in their head and refer
 * to out loud ("I'm on 06"). That is §1's "numbering turns a list into a system", applied to the
 * screen it was written for.
 *
 * ## Nothing is locked, and nothing is scored
 *
 * Prerequisites are printed and linked; they never disable a link. A lesson marked read gets a
 * word and a glyph, not a tick in a progress bar, and there is no "3 of 17 complete" anywhere on
 * this page. A completion percentage is the first step towards a streak, and the product
 * guardrails rule out the whole family.
 *
 * The three figures at the top — lessons, topics, reading time — are facts about the curriculum,
 * not about the reader. That is the line: the page will tell you how long the syllabus is, and it
 * will not tell you how you are doing against it.
 *
 * ## A server component, and a shared one — which is why it does not know who you are
 *
 * Everything here is data plus links, so it renders on the server and arrives as HTML. The two
 * client components are `Onboarding` (which needs `localStorage`) and `Metric` (which is a client
 * component in `@prl/ui` because of its count-up), and neither is on the critical path for
 * reading the page.
 *
 * `loadLessonList()` forwards the session cookie when the browser has one, so the `completed`
 * flags are that reader's. Without a cookie the API still answers `false` for everybody, and
 * the page treats that as unknown rather than unread. `test/y1-learn-index-honesty.test.ts`
 * couples the loader and the flag so they cannot drift.
 *
 * ## Nine cards used to warn readers off nine working lessons
 *
 * `READABLE_LESSON_IDS` is derived from the bundled fixture, which carries eight of the seventeen
 * lesson BODIES. It was passed to `buildCurriculum` unconditionally, so with a healthy API — one
 * serving all seventeen bodies — nine cards told the reader "this lesson's text comes from the
 * content service, which is not reachable". The content service was reachable; it had just answered
 * this very request. The index was reporting fixture coverage in the words of service availability,
 * on more than half the curriculum, on a working deployment.
 *
 * It is now passed only when the list itself came from the fixture, which is the only condition
 * under which it describes anything true.
 */

import { Callout, Chip, formatIndex, Metric, Panel, pluralise } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { Onboarding } from '@/components/Onboarding.tsx';
import {
  asDifficulty,
  buildCurriculum,
  type CurriculumEntry,
  DIFFICULTY_GLYPHS,
  DIFFICULTY_LABELS,
} from '@/lib/learn-curriculum.ts';
import { GLOSSARY_PATH, lessonHref, loadLessonList, READABLE_LESSON_IDS } from '@/lib/learn-data.ts';
import { readerCallOptions } from '@/lib/server-session.ts';

export const metadata: Metadata = {
  title: 'Learn',
  description:
    'The curriculum: numbered lessons on probability, outs, pot odds, expected value, bet sizing, ' +
    'ranges, variance and bankroll. Every figure is computed, never stored.',
};

/** The difficulty chip. A word and a shape, so it never depends on a colour. */
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
          <DifficultyChip difficulty={summary.difficulty} />
          <Chip>{pluralise(summary.estimatedMinutes, 'minute')}</Chip>
          {/* `=== true`, not truthiness: `null` means nobody asked, and a "read" tick on a lesson
              nobody checked would be the same lie in the opposite direction. */}
          {entry.completed === true ? <Chip glyph="✓">read</Chip> : null}
          {isStart ? <Chip glyph="▸">start here</Chip> : null}
          {summary.quizId === undefined ? null : <Chip glyph="?">has a quiz</Chip>}
        </div>
        {entry.prerequisites.length === 0 ? (
          <p className="prl-learn-entry__prereq">Nothing to read first.</p>
        ) : (
          <p className="prl-learn-entry__prereq">
            <span className="prl-label">Read first</span>
            {entry.prerequisites.map((prerequisite, position) => (
              <span key={prerequisite.id}>
                {position === 0 ? '' : ', '}
                <Link className="prl-learn-entry__prereq-link" href={lessonHref(prerequisite.id)}>
                  {prerequisite.title}
                </Link>
              </span>
            ))}
            {/* Only when the index actually knows. `unlocked` is `null` on this screen as it stands,
                and printing this note for `null` is what warned sixteen of seventeen cards' readers
                about prerequisites nobody had checked. */}
            {entry.unlocked === false ? (
              <span className="prl-learn-entry__prereq-note">
                {entry.outstandingPrerequisites.length === 1
                  ? ' — one of those is not marked read. Nothing stops you reading this one now.'
                  : ` — ${entry.outstandingPrerequisites.length} of those are not marked read. Nothing stops you reading this one now.`}
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
    // Fixture coverage, and only meaningful when the list itself is the fixture. Passed
    // unconditionally, it warned readers off the nine lessons whose bodies the bundle lacks — while
    // the API was serving all seventeen.
    ...(lessons.source === 'fixture' ? { readableIds: READABLE_LESSON_IDS } : {}),
    // `loadLessonList()` now forwards the session cookie, so `completed` is this reader's when
    // one exists. Without a cookie the API still answers `false` for everybody — keep that as
    // "unknown", not "unread". `test/y1-learn-index-honesty.test.ts` couples the two.
    completionKnown: lessons.source === 'api' && reader.cookie !== undefined,
  });
  const start = curriculum.startHere;

  return (
    <div className="prl-learn-page">
      <header className="prl-learn-page__head">
        <span className="prl-label prl-learn-page__eyebrow">
          <span className="prl-index" aria-hidden="true">
            {formatIndex(1)}
          </span>
          Learn
        </span>
        <h1 className="prl-display-2">The curriculum</h1>
        <p className="prl-learn-page__lead">
          Seventeen lessons, in the order the ideas depend on one another. Each one states what it assumes you
          have read, and none of them is locked — the numbering is a route through the material, not a gate
          across it.
        </p>
        <p className="prl-learn-page__lead">
          Every figure inside a lesson is computed while you read it, from the situation the lesson describes,
          rather than read out of a table that could have been wrong when it was written. If the calculator
          cannot be reached, the lesson says so where the figure would have been.
        </p>
        {curriculum.completionKnown ? null : (
          // Said once, in the lead, rather than hedged on seventeen cards. The index is the same
          // page for every reader — that is what makes it fast — so it has no way to know what you
          // have read, and it now says so instead of guessing `false` and printing the guess.
          <p className="prl-learn-page__lead">
            This index is the same for every reader, so it does not know which lessons you have already
            finished — nothing below is a mark on your record. What you have read is recorded when you press
            the control at the end of a lesson, and it is counted on <Link href="/record">your record</Link>.
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
            note="An estimate from the content, not a target."
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
          <p className="prl-note">
            {/* Three states, because `unlocked` has three. The third used to be rendered as the
                second — "the earliest lesson you have not marked read" — about a reader this page
                had never asked after. */}
            {start.unlocked === true
              ? 'Everything this lesson assumes is already marked read.'
              : start.unlocked === false
                ? 'This is the earliest lesson in the syllabus you have not marked read. Its prerequisites are listed on its card below.'
                : 'This is the first lesson in the syllabus, not a suggestion based on what you have read — this page has no way to know that. It assumes nothing, so it is the safe place to start if you are new.'}
          </p>
          <Link className="prl-btn prl-btn--primary prl-btn--lg" href={lessonHref(start.summary.id)}>
            {`Read lesson ${formatIndex(start.position)}`}
          </Link>
        </Panel>
      )}

      {curriculum.groups.map((group) => (
        <section className="prl-learn-group" key={group.topic}>
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
          Ninety terms, each with the plain-language version first and the jargon second. Every term a lesson
          uses is linked from inside its own prose, so you can read a definition without leaving the
          paragraph.
        </p>
        <Link className="prl-btn prl-btn--secondary prl-btn--md" href={GLOSSARY_PATH}>
          Open the glossary
        </Link>
      </Panel>
    </div>
  );
}
