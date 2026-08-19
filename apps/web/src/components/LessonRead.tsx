'use client';

/**
 * The control at the end of a lesson that records having finished it.
 *
 * ## What "reached the end" means on this screen, and why it is a button
 *
 * It means the learner pressed this, and this sits below the last thing the lesson has to say —
 * after the prose, after the takeaways, after the vocabulary, after the quiz. Reaching it requires
 * having gone past all of that, and pressing it is a deliberate statement rather than a side effect
 * of arriving.
 *
 * Every cheaper signal was considered and each one records the wrong thing:
 *
 *  - **Opening the page** is what the audit's PROD-028 forbids. A prefetch, a crawler and a
 *    back-button are indistinguishable from a read at `GET /content/lessons/:id`, and a figure that
 *    fills itself in describes nobody. The API's own route comment says the same.
 *  - **Scrolling to the bottom** looks explicit and is not. Browsers restore scroll position on
 *    back-navigation, `#anchor` links from the contents rail jump past the whole lesson, and "end
 *    of the document" on a short lesson at a tall viewport is the first paint. All three would
 *    write a completion the learner never claimed.
 *  - **A dwell timer** measures a tab being open, which is a fact about a tab.
 *
 * So the honest signal is the one the learner performs. It costs one press, and what it buys is
 * that every entry in `lessonsCompleted` is something somebody actually said.
 *
 * ## Why the learner is not told they already finished it
 *
 * There is no per-lesson progress read in the contract, and the page this sits on is a shared,
 * cacheable server render — making it per-reader to put a tick in the header is a large change to
 * the most cacheable screen in the app for a small ornament. `/record` is where the reader's own
 * state lives and it lists the finished lessons by id, so the note below links there rather than
 * guessing. Pressing again when it is already recorded is harmless: `upsertLessonProgress` is
 * sticky, so completion is set once and re-reading never un-finishes a lesson.
 *
 * Note what this replaced: the lesson header used to show a `✓ read` chip driven by
 * `lessonSummaryFixture(...).completed` — bundled sample data, two entries of which are hard-coded
 * `true` — shown to every visitor whether or not the lesson body came from the live API. That is a
 * claim about the reader sourced from a file in this repository, and it is exactly the class of
 * thing `/record` exists to be the truth about.
 */

import { Button, Panel } from '@prl/ui';
import Link from 'next/link';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { type LessonReadOutcome, lessonReadNote, submitLessonRead } from '@/lib/lesson-reads.ts';
import { RECORD_PATH } from '@/lib/record-data.ts';

export interface LessonReadProps {
  readonly lessonId: string;
  /** Named in the button so a screen reader hears which lesson is being marked, not just "read". */
  readonly lessonTitle: string;
}

/** Nothing has been claimed yet. One object so the identity is stable across renders. */
const IDLE: LessonReadOutcome = { state: 'idle' };

/**
 * The press, as a value with an identity.
 *
 * A fresh object per press rather than a boolean or a counter, because the effect below guards on
 * IDENTITY — the same guard `QuizRunner` uses for an answer. A boolean would go true once and could
 * never express "the learner pressed again after it failed"; a counter would work but would have to
 * be compared as a number, and a number that also lives in a ref is one off-by-one from either
 * double-posting or silently dropping a retry.
 */
interface Press {
  readonly lessonId: string;
}

/**
 * The server's own timestamp for the completion, plus the way to check it.
 *
 * `LessonReadResponse` echoes the stored row back specifically so a client renders what the server
 * holds rather than what it hoped it wrote, so the stamp shown here is the one in the database and
 * not this browser's clock. Rendered only after a press, which is client-only, so formatting it in
 * the reader's locale cannot produce a hydration mismatch.
 *
 * An unparseable string yields no `<time>` rather than the words "Invalid Date": the recording
 * genuinely happened, and a broken stamp is not a reason to cast doubt on it.
 */
function RecordedAt({ iso }: { readonly iso: string }): ReactElement {
  const at = new Date(iso);
  return (
    <>
      {Number.isNaN(at.getTime()) ? null : (
        <>
          {' '}
          The server stamped it <time dateTime={iso}>{at.toLocaleString()}</time>.
        </>
      )}{' '}
      <Link href={RECORD_PATH}>See your record</Link>.
    </>
  );
}

export function LessonRead(props: LessonReadProps): ReactElement {
  const { lessonId, lessonTitle } = props;
  const [press, setPress] = useState<Press | null>(null);
  const [outcome, setOutcome] = useState<LessonReadOutcome>(IDLE);

  /**
   * The press each lesson has already been posted for.
   *
   * Keyed by lesson id and compared by identity, so a re-render posts nothing and a genuine second
   * press — the retry after a failure — posts again. A ref rather than state because nothing
   * renders from it, and putting it in state would re-run the effect that writes it.
   */
  const posted = useRef(new Map<string, Press>());

  /**
   * One controller for every press this component sends, aborted when the component goes away.
   *
   * Deliberately NOT one per press. A per-press controller cleaned up by React would abort the POST
   * the moment anything above re-rendered, and the record would be lost for exactly the learner who
   * presses and immediately navigates on. Unmount is the only moment at which nobody is waiting for
   * the answer any more. Same reasoning, same shape as `QuizRunner`'s `submissions`.
   */
  const submissions = useRef<AbortController | null>(null);
  useEffect(() => () => submissions.current?.abort(), []);

  /**
   * Sends the completion, once per press.
   *
   * Nothing here throws and nothing here can fail the render: `submitLessonRead` returns its
   * failures as values, and the note says which of them happened.
   */
  useEffect(() => {
    if (press === null) return;
    if (posted.current.get(press.lessonId) === press) return;

    posted.current.set(press.lessonId, press);
    submissions.current ??= new AbortController();
    const signal = submissions.current.signal;
    setOutcome({ state: 'pending' });
    void (async () => {
      const next = await submitLessonRead(press.lessonId, signal);
      if (signal.aborted) return;
      setOutcome(next);
    })();
  }, [press]);

  const working = outcome.state === 'pending';
  const done = outcome.state === 'recorded';

  return (
    <Panel
      className="prl-learn-read"
      eyebrow="When you have finished"
      title="Mark this lesson as read"
      headingLevel={2}
    >
      <p className="prl-prose">
        Nothing on this page decides that for you. Opening a lesson is not reading it — a prefetch, a crawler
        and a back-button all look the same to the server — so your record only counts the lessons you say you
        have finished. It is counted, never scored: there is no percentage complete and nowhere for one to be
        stored.
      </p>
      <div className="prl-stack">
        <p className="prl-btn-row">
          <Button variant="primary" onClick={() => setPress({ lessonId })} disabled={working || done}>
            {working ? 'Recording…' : done ? 'Recorded' : `I have finished “${lessonTitle}”`}
          </Button>
        </p>
        {/*
          In the DOM from the first render, empty. A live region that arrives at the same moment as
          its text is missed by several screen readers, which for a control whose entire visible
          effect is a sentence would mean the press appeared to do nothing at all.
        */}
        <p className="prl-note" role="status">
          {lessonReadNote(outcome)}
          {outcome.state === 'recorded' ? <RecordedAt iso={outcome.completedAt} /> : null}
        </p>
      </div>
    </Panel>
  );
}
