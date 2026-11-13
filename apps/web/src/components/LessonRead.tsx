'use client';

/**
 * The control at the end of a lesson that records having finished it. A completion is a press, never
 * inferred (PROD-028). A page load, a scroll to the bottom or a dwell timer all record visits the
 * learner never claimed. The page is a shared cached render, so it cannot show whether this reader
 * already finished. `/record` is where that lives. A second press is harmless because
 * `upsertLessonProgress` is sticky.
 */

import { Button, Panel } from '@prl/ui';
import Link from 'next/link';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { type LessonReadOutcome, lessonReadNote, submitLessonRead } from '@/lib/lesson-reads.ts';
import { RECORD_PATH } from '@/lib/record-data.ts';

export interface LessonReadProps {
  readonly lessonId: string;
  readonly lessonTitle: string;
}

const IDLE: LessonReadOutcome = { state: 'idle' };

/** A fresh object per press, so the send effect can guard on identity and a retry posts again. */
interface Press {
  readonly lessonId: string;
}

/**
 * The stored row's own timestamp, not this browser's clock. Rendered only after a press, so the
 * locale format cannot cause a hydration mismatch. An unparseable stamp renders no `<time>`.
 */
function RecordedAt({ iso }: { readonly iso: string }): ReactElement {
  const at = new Date(iso);
  return (
    <>
      {Number.isNaN(at.getTime()) ? null : (
        <>
          {' '}
          Recorded at <time dateTime={iso}>{at.toLocaleString()}</time>.
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

  const posted = useRef(new Map<string, Press>());

  /** One controller aborted on unmount. A per-press one would abort the POST on any re-render above. */
  const submissions = useRef<AbortController | null>(null);
  useEffect(() => () => submissions.current?.abort(), []);

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
        Nothing on this page decides that for you. Opening a lesson is not the same as reading it, so your
        record only counts the lessons you say you have finished. It is counted, never scored: there is no
        percentage complete.
      </p>
      <div className="prl-stack">
        <p className="prl-btn-row">
          <Button
            variant="primary"
            className="prl-learn-titled-btn"
            onClick={() => setPress({ lessonId })}
            disabled={working || done}
          >
            {working ? 'Recording…' : done ? 'Recorded' : `I have finished “${lessonTitle}”`}
          </Button>
        </p>
        {/* Empty from first render. Screen readers miss a live region that arrives with its text. */}
        <p className="prl-note" role="status">
          {lessonReadNote(outcome)}
          {outcome.state === 'recorded' ? <RecordedAt iso={outcome.completedAt} /> : null}
        </p>
      </div>
    </Panel>
  );
}
