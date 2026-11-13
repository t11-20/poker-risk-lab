/**
 * One lesson. Everything is in the first HTML response, with no reveal-on-scroll, so find-in-page and
 * printing work. `lessonOutline` is computed once and handed to both the rail and the body, so their
 * heading ids cannot drift. A real lesson whose body is unreachable gets an explanation, not a 404.
 */

import { lessonsInReadingOrder } from '@prl/content';
import { Callout, Chip, formatIndex, Panel, pluralise, withKeys } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { NotFoundBody } from '@/app/not-found.tsx';
import { LessonBlockRenderer } from '@/components/LessonBlockRenderer.tsx';
import { LessonContents } from '@/components/LessonContents.tsx';
import { LessonRead } from '@/components/LessonRead.tsx';
import { QuizRunner } from '@/components/QuizRunner.tsx';
import { lessonSummaryFixture } from '@/fixtures/learn.ts';
import {
  asDifficulty,
  DIFFICULTY_GLYPHS,
  DIFFICULTY_LABELS,
  LESSON_TITLE_ID,
  lessonOutline,
  nextLesson,
  nextLessonStep,
  topicLabel,
} from '@/lib/learn-curriculum.ts';
import { GLOSSARY_PATH, LEARN_PATH, lessonHref, loadLesson, READABLE_LESSON_IDS } from '@/lib/learn-data.ts';

interface LessonPageProps {
  readonly params: Promise<{ readonly lessonId: string }>;
}

/** Known ids 404 at the router (full HTML) instead of via `notFound()` (empty Next 16 body). */
export function generateStaticParams(): { lessonId: string }[] {
  return lessonsInReadingOrder().map((lesson) => ({ lessonId: lesson.id }));
}

export const dynamicParams = false;

/** Falls back to the summary fixture, so an unavailable lesson is still named. */
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

function UnavailableLesson({ lessonId }: { readonly lessonId: string }): ReactElement {
  const summary = lessonSummaryFixture(lessonId);
  if (summary === null) return <NotFoundBody />;
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
  const prerequisites = lesson.prerequisites.map((id) => ({
    id,
    title: lessonSummaryFixture(id)?.title ?? id,
  }));
  const takeaways = withKeys(lesson.keyTakeaways, 'takeaway');
  // Null on the last lesson.
  const step = nextLessonStep(
    nextLesson(lessonsInReadingOrder(), lesson.id),
    loaded.source === 'fixture' ? READABLE_LESSON_IDS : null,
  );
  const nextStep = step?.kind === 'link' ? { href: lessonHref(step.id), title: step.title } : null;
  const unreadableNext = step?.kind === 'unavailable' ? step.title : null;

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
        {/* The quiz's "Re-read" target. `tabIndex={-1}` so the link moves focus as well as scroll. */}
        <h1 className="prl-display-2" id={LESSON_TITLE_ID} tabIndex={-1}>
          {lesson.title}
        </h1>
        <p className="prl-learn-lesson__summary">{lesson.summary}</p>
        <div className="prl-row prl-learn-lesson__chips">
          {difficulty === null ? (
            <Chip>{lesson.difficulty}</Chip>
          ) : (
            <Chip glyph={DIFFICULTY_GLYPHS[difficulty]}>{DIFFICULTY_LABELS[difficulty]}</Chip>
          )}
          <Chip>{pluralise(lesson.estimatedMinutes, 'minute')}</Chip>
          {/* No "read" chip. The fixture's `completed` flags belong to nobody (PROD-028). */}
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
            <QuizRunner
              quiz={quiz}
              lessonTitleId={LESSON_TITLE_ID}
              lessonTitle={lesson.title}
              nextLesson={nextStep}
            />
          )}

          {/* Last on purpose. Marking a lesson read is the learner's statement, not inferred (PROD-028). */}
          <LessonRead lessonId={lesson.id} lessonTitle={lesson.title} />

          {unreadableNext === null ? null : (
            <p className="prl-note">
              {`The next lesson, “${unreadableNext}”, needs the content service, which this page could not reach. It is in the curriculum, and it will open once the service answers.`}
            </p>
          )}
          <div className="prl-btn-row prl-learn-lesson__foot">
            {nextStep === null ? null : (
              <Link
                className="prl-btn prl-btn--primary prl-btn--md prl-learn-titled-btn"
                href={nextStep.href}
              >
                {`Next: ${nextStep.title}`}
              </Link>
            )}
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
