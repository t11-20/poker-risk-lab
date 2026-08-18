/**
 * One lesson: prose at the measure, a sticky contents rail, and figures computed while you read.
 *
 * ## What makes this a reading experience rather than a document dump
 *
 *  - **Prose caps at `--prl-measure` (68ch).** Past roughly 75 characters the eye loses the line
 *    start on the return sweep, which is a comprehension problem rather than a taste one. The rail
 *    and the calculations sit outside that column so the column itself never widens.
 *  - **Generous vertical rhythm.** `--prl-space-9` between blocks, `--prl-space-11` before a
 *    heading. A lesson is the longest continuous read in the app and the spacing is what makes
 *    twelve minutes of it survivable.
 *  - **The contents rail is sticky from 1280px** and appears inline above the prose below that,
 *    so the structure of a long lesson is visible at every width rather than only on a desktop.
 *  - **Everything is in the first HTML response.** No reveal-on-scroll, so find-in-page works and
 *    printing works.
 *
 * ## One `h1`, and the outline below it
 *
 * The lesson title is the page's `h1`. Every `heading` block becomes an `h2` with a numbered
 * index; a live calculation's own title is an `h3` inside its panel, and its assumptions heading
 * is an `h4`. Nothing skips a level, which is what makes heading navigation usable — and the ids
 * the rail links to come from `lessonOutline`, computed once here and handed to both, so the two
 * cannot drift.
 *
 * ## Missing lesson bodies are a state, not an error
 *
 * The fixture carries eight of the seventeen bodies, so a lesson the API has not served yet
 * renders a page that says so and offers the way back. `notFound()` is reserved for an id that is
 * not a lesson at all in either source — a 404 for content that exists but is unreachable would
 * be a lie about what went wrong.
 */

import { Callout, Chip, formatIndex, Panel, pluralise, withKeys } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';
import { LessonBlockRenderer } from '@/components/LessonBlockRenderer.tsx';
import { LessonContents } from '@/components/LessonContents.tsx';
import { QuizRunner } from '@/components/QuizRunner.tsx';
import { lessonSummaryFixture } from '@/fixtures/learn.ts';
import {
  asDifficulty,
  DIFFICULTY_GLYPHS,
  DIFFICULTY_LABELS,
  lessonOutline,
  topicLabel,
} from '@/lib/learn-curriculum.ts';
import { GLOSSARY_PATH, LEARN_PATH, lessonHref, loadLesson } from '@/lib/learn-data.ts';

interface LessonPageProps {
  readonly params: Promise<{ readonly lessonId: string }>;
}

/**
 * The tab title and description come from the lesson itself.
 *
 * Falls back to the summary fixture when the body is unavailable, so a page that has to apologise
 * still says which lesson it is apologising about.
 */
export async function generateMetadata({ params }: LessonPageProps): Promise<Metadata> {
  const { lessonId } = await params;
  const loaded = await loadLesson(lessonId);
  if (loaded !== null) {
    return { title: loaded.data.lesson.title, description: loaded.data.lesson.summary };
  }
  const summary = lessonSummaryFixture(lessonId);
  if (summary === null) return { title: 'Lesson not found' };
  return { title: summary.title, description: summary.summary };
}

/** The page shown when the lesson is real but its text is not reachable. */
function UnavailableLesson({ lessonId }: { readonly lessonId: string }): ReactElement {
  const summary = lessonSummaryFixture(lessonId);
  if (summary === null) notFound();
  return (
    <div className="prl-learn-lesson">
      <header className="prl-learn-lesson__head">
        <span className="prl-label prl-learn-lesson__eyebrow">{topicLabel(summary.topic)}</span>
        <h1 className="prl-display-2">{summary.title}</h1>
        <p className="prl-learn-lesson__summary">{summary.summary}</p>
      </header>
      <Callout tone="warning" title="This lesson's text is not available in this build">
        The content service is not reachable and this lesson's body is not in the bundled copy, so there is
        nothing to show you. It is a gap in the deployment rather than a missing lesson — the syllabus entry,
        its prerequisites and its reading time are all real.
      </Callout>
      <div className="prl-btn-row">
        <Link className="prl-btn prl-btn--secondary prl-btn--md" href={LEARN_PATH}>
          Back to the curriculum
        </Link>
        <Link className="prl-btn prl-btn--ghost prl-btn--md" href={GLOSSARY_PATH}>
          Open the glossary
        </Link>
      </div>
    </div>
  );
}

export default async function LessonPage({ params }: LessonPageProps): Promise<ReactElement> {
  const { lessonId } = await params;
  const loaded = await loadLesson(lessonId);
  if (loaded === null) return <UnavailableLesson lessonId={lessonId} />;

  const { lesson, quiz, glossary } = loaded.data;
  const outline = lessonOutline(lesson.blocks);
  const difficulty = asDifficulty(lesson.difficulty);
  const summary = lessonSummaryFixture(lesson.id);
  const prerequisites = lesson.prerequisites.map((id) => ({
    id,
    title: lessonSummaryFixture(id)?.title ?? id,
  }));
  const takeaways = withKeys(lesson.keyTakeaways, 'takeaway');

  return (
    <div className="prl-learn-lesson">
      <header className="prl-learn-lesson__head">
        <p className="prl-learn-lesson__eyebrow">
          <Link className="prl-learn-lesson__back" href={LEARN_PATH}>
            Curriculum
          </Link>
          <span aria-hidden="true"> / </span>
          <span className="prl-label">{topicLabel(lesson.topic)}</span>
        </p>
        <h1 className="prl-display-2">{lesson.title}</h1>
        <p className="prl-learn-lesson__summary">{lesson.summary}</p>
        <div className="prl-row prl-learn-lesson__chips">
          {difficulty === null ? (
            <Chip>{lesson.difficulty}</Chip>
          ) : (
            <Chip glyph={DIFFICULTY_GLYPHS[difficulty]}>{DIFFICULTY_LABELS[difficulty]}</Chip>
          )}
          <Chip>{pluralise(lesson.estimatedMinutes, 'minute')}</Chip>
          {summary?.completed === true ? <Chip glyph="✓">read</Chip> : null}
          {quiz === null ? null : <Chip glyph="?">{pluralise(quiz.questions.length, 'question')}</Chip>}
        </div>
        {prerequisites.length === 0 ? null : (
          <p className="prl-learn-lesson__prereq">
            <span className="prl-label">Assumes you have read</span>
            {prerequisites.map((prerequisite, position) => (
              <span key={prerequisite.id}>
                {position === 0 ? '' : ', '}
                <Link href={lessonHref(prerequisite.id)}>{prerequisite.title}</Link>
              </span>
            ))}
          </p>
        )}
      </header>

      {loaded.source === 'fixture' && loaded.fallbackReason !== null ? (
        <Callout tone="warning" title="This lesson is the bundled copy">
          {loaded.fallbackReason}
        </Callout>
      ) : null}

      <div className="prl-learn-lesson__layout">
        <LessonContents headings={outline.headings} />
        <div className="prl-learn-lesson__body">
          <LessonBlockRenderer blocks={lesson.blocks} outline={outline} glossary={glossary} />

          {takeaways.length === 0 ? null : (
            <Panel
              className="prl-learn-takeaways"
              eyebrow="Leave with these"
              title="What this lesson was for"
              headingLevel={2}
            >
              <ol className="prl-learn-takeaways__list">
                {takeaways.map((takeaway, position) => (
                  <li className="prl-learn-takeaways__item" key={takeaway.key}>
                    <span className="prl-index prl-learn-takeaways__index" aria-hidden="true">
                      {formatIndex(position + 1)}
                    </span>
                    <span>{takeaway.value}</span>
                  </li>
                ))}
              </ol>
            </Panel>
          )}

          {glossary.length === 0 ? null : (
            <Panel
              className="prl-learn-terms"
              eyebrow="Vocabulary"
              title="Terms this lesson uses"
              headingLevel={2}
            >
              <p className="prl-note">
                Each of these is a button the first time it appears in the text above. The full definitions,
                with cross-references, are in the glossary.
              </p>
              <ul className="prl-learn-terms__list">
                {glossary.map((entry) => (
                  <li key={entry.id}>
                    <Link href={`${GLOSSARY_PATH}#${entry.id}`}>{entry.term}</Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {quiz === null ? null : (
            <QuizRunner quiz={quiz} lessonHref={lessonHref(lesson.id)} lessonTitle={lesson.title} />
          )}

          <div className="prl-btn-row prl-learn-lesson__foot">
            <Link className="prl-btn prl-btn--secondary prl-btn--md" href={LEARN_PATH}>
              Back to the curriculum
            </Link>
            <Link className="prl-btn prl-btn--ghost prl-btn--md" href={GLOSSARY_PATH}>
              Open the glossary
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
