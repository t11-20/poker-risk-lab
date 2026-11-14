'use client';

/**
 * A quiz, one question at a time.
 *
 * There is no score, by design (`docs/PRODUCT-GUARDRAILS.md`). Nothing counts matches, `01 / 05` is
 * wayfinding, and the end shows only `reviewAdvice`. Nothing is labelled "correct". Numeric targets
 * are computed from `@prl/poker-math`, never stored (ADR 0006).
 *
 * Every graded answer is posted (`lib/quiz-attempts.ts`) and the server's verdict is shown when it
 * answered. A failed POST never throws. `VERDICT_SOURCE_NOTE` says who made the comparison, and says
 * "recorded" only when a row exists.
 *
 * A step change moves focus to the question heading, which carries "Question N of M" as hidden text.
 * Answering moves nothing. The verdict regions are `role="status"`, so the verdict and its source
 * note are read as one atomic message.
 */

import type { ContentId, Quiz, QuizQuestion } from '@prl/contracts';
import {
  Button,
  Callout,
  Chip,
  Formula,
  formatIndex,
  Metric,
  Panel,
  useFocusOnChange,
  withKeys,
} from '@prl/ui';
import Link from 'next/link';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useCalculationOutcome } from '@/components/LiveCalculation.tsx';
import {
  type CalculationResult,
  type ExpectedAnswer,
  expectedFromResult,
  figureFormat,
  figureValue,
  formatQuizValue,
  formatTolerance,
} from '@/lib/learn-calculations.ts';
import {
  attemptBodyFor,
  gradedAnswer,
  type QuizAnswer,
  type QuizVerdict,
  resolvedVerdict,
  submitQuizAttempt,
  VERDICT_SOURCE_NOTE,
} from '@/lib/quiz-attempts.ts';
import { QUIZ_UNIT_WORDS, withinTolerance } from '@/lib/quiz-tolerance.ts';
import { CHOICE_MARKER, numericVerdictSentence, verdictMarker } from '@/lib/quiz-verdict.ts';
import { RECORD_PATH } from '@/lib/record-data.ts';

/** What the learner did. `revealed` is a decision question, which has nothing to check. */
type Answer = QuizAnswer;

export interface QuizRunnerProps {
  readonly quiz: Quiz;
  /**
   * The id of the lesson title on this page, which "Re-read" scrolls to and focuses. `null` when the
   * quiz stands alone. An id, not a URL, because a same-URL `<Link>` does nothing.
   */
  readonly lessonTitleId: string | null;
  readonly lessonTitle: string | null;
  /** The lesson after this one in reading order, offered at the end. `null` on the last lesson. */
  readonly nextLesson: { readonly href: string; readonly title: string } | null;
}

/**
 * A same-document fragment link that also moves focus. A plain `<a>`, so native fragment navigation
 * applies `scroll-padding` and `:target`. Focus is moved by hand because not every browser does it,
 * with `preventScroll` because the fragment navigation does the scrolling.
 */
function ReReadLink(props: {
  readonly targetId: string;
  readonly lessonTitle: string | null;
  readonly className: string;
}): ReactElement {
  const { targetId, lessonTitle, className } = props;
  return (
    <a
      className={className}
      href={`#${targetId}`}
      onClick={() => document.getElementById(targetId)?.focus({ preventScroll: true })}
    >
      {lessonTitle === null ? 'Re-read the lesson' : `Re-read ${lessonTitle}`}
    </a>
  );
}

/**
 * The mark is painted by `::before { content: attr(data-mark) / "" }`, so it is never spoken and is
 * not in the region's `textContent`, which `test:ax` anchors on. The region stays `:empty` until answered.
 */
function verdictMarkAttributes(matched: boolean): { 'data-matched': string; 'data-mark': string } {
  return { 'data-matched': String(matched), 'data-mark': verdictMarker(matched) };
}

// Multiple choice

function MultipleChoice(props: {
  readonly question: Extract<QuizQuestion, { kind: 'multipleChoice' }>;
  readonly answer: Answer | undefined;
  readonly server: QuizVerdict;
  readonly onAnswer: (answer: Answer) => void;
}): ReactElement {
  const { question, answer, server, onAnswer } = props;
  /** The option the learner last CHECKED, which the verdict, chips and note describe. */
  const chosen = answer?.kind === 'choice' ? answer.index : null;
  const answered = chosen !== null;
  /**
   * The option the radio group is on, which is not yet an answer. A radio group changes on every
   * arrow key, so answering on change posted each option passed. Seeded from the checked answer
   * because this remounts per question.
   */
  const [selected, setSelected] = useState<number | null>(chosen);
  // Keyed by option text with an occurrence counter, so a re-ordered question cannot reuse a radio.
  const options = withKeys(question.options, 'option');

  // The server's comparison when there is one. `correctIndex` still picks the lesson-answer chip.
  const resolved = resolvedVerdict(server, chosen === question.correctIndex);
  const verdict = !answered
    ? ''
    : resolved.matched
      ? 'That matches the answer this lesson gives. The reasoning is below — worth reading even so, because the reasoning is the part that transfers.'
      : 'That is not the answer this lesson gives. Nothing is deducted for it, and you can change your mind as often as you like; the note beside each option says why it is a tempting one.';

  return (
    <div className="prl-stack">
      <fieldset className="prl-learn-quiz__options">
        {/* Not the prompt again, which is the heading just above. */}
        <legend className="prl-visually-hidden">Choose one answer</legend>
        {options.map((entry, index) => {
          const isChoice = chosen === index;
          const isLessonAnswer = index === question.correctIndex;
          const note = question.optionNotes?.[index];
          return (
            <div className="prl-learn-quiz__option" key={entry.key}>
              <label className="prl-choice">
                <input
                  className="prl-choice__control"
                  type="radio"
                  name={question.id}
                  value={String(index)}
                  checked={selected === index}
                  onChange={() => setSelected(index)}
                />
                <span className="prl-choice__label">{entry.value}</span>
              </label>
              {answered ? (
                <div className="prl-learn-quiz__option-feedback">
                  <span className="prl-row">
                    {isLessonAnswer ? (
                      <Chip glyph={CHOICE_MARKER.lesson}>the answer this lesson gives</Chip>
                    ) : null}
                    {isChoice && !isLessonAnswer ? (
                      <Chip glyph={CHOICE_MARKER.yours}>what you picked</Chip>
                    ) : null}
                  </span>
                  {note === undefined ? null : <p className="prl-note">{note}</p>}
                </div>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      {/*
        Focus stays on the button after a press, because the region below announces the verdict.
        "Check again" re-sends, and `record` mints a new answer object so it is posted.
      */}
      <div className="prl-btn-row">
        <Button
          className="prl-learn-quiz__check"
          variant="secondary"
          disabled={selected === null}
          onClick={() => {
            if (selected !== null) onAnswer({ kind: 'choice', index: selected });
          }}
        >
          {!answered ? 'Check answer' : selected === chosen ? 'Check again' : 'Check this answer'}
        </Button>
      </div>
      {/* Mounted empty on first render so it is announced. `role="status"` makes it atomic. */}
      <p
        aria-live="polite"
        className="prl-learn-quiz__verdict"
        role="status"
        {...(answered ? verdictMarkAttributes(resolved.matched) : {})}
      >
        {verdict}
        {answered ? ` ${VERDICT_SOURCE_NOTE[resolved.source]}` : ''}
      </p>
    </div>
  );
}

// Numeric

function Working(props: {
  readonly result: CalculationResult;
  readonly expected: ExpectedAnswer;
}): ReactElement {
  const { result, expected } = props;
  return (
    <div className="prl-stack prl-learn-quiz__working">
      <Metric
        label={`${expected.figure.label} — computed now, not stored`}
        value={figureValue(expected.figure)}
        format={figureFormat(expected.figure)}
        size="lg"
        {...(expected.figure.unit === undefined ? {} : { unit: expected.figure.unit })}
        {...(expected.figure.decimals === undefined ? {} : { decimals: expected.figure.decimals })}
        {...(expected.figure.interval === undefined ? {} : { interval: expected.figure.interval })}
      />
      <p className="prl-row">
        <Chip glyph={result.method.glyph}>{result.method.label}</Chip>
        <span className="prl-note">{result.method.note}</span>
      </p>
      {result.formula === null ? null : (
        <Formula
          eyebrow="How it is defined"
          expression={result.formula.expression}
          explanation={result.formula.explanation}
        />
      )}
      {result.derivation === null ? null : <p className="prl-note">{result.derivation}</p>}
      {result.assumptions.length === 0 ? null : (
        <ul className="prl-learn-quiz__assumptions">
          {result.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** `role="alert"` because this replaces the question. Mounted only on failure, so it fires on insertion. */
function Unmarkable(props: { readonly reason: string; readonly explanation: string }): ReactElement {
  return (
    <div className="prl-error" role="alert">
      <p className="prl-error__title">
        <span aria-hidden="true">▲ </span>
        This question cannot be marked
      </p>
      <p>{props.reason}</p>
      <p>{props.explanation}</p>
    </div>
  );
}

/** `against` is the figure the comparison was made against, the server's when the server made it. */
function numericVerdict(input: {
  readonly submitted: { readonly value: number } | null;
  readonly against: { readonly value: number; readonly tolerance: number } | undefined;
  readonly matched: boolean;
  readonly unit: Extract<QuizQuestion, { kind: 'numeric' }>['unit'];
}): string {
  const { submitted, against, matched, unit } = input;
  if (submitted === null) return '';
  if (against === undefined) {
    return 'The computed figure is not available, so there is nothing to compare your answer with.';
  }
  return numericVerdictSentence({
    yours: formatQuizValue(submitted.value, unit),
    computed: formatQuizValue(against.value, unit),
    tolerance: `${formatTolerance(against.tolerance, unit)} ${QUIZ_UNIT_WORDS[unit]}`,
    matched,
  });
}

function NumericQuestion(props: {
  readonly question: Extract<QuizQuestion, { kind: 'numeric' }>;
  readonly answer: Answer | undefined;
  readonly server: QuizVerdict;
  readonly onAnswer: (answer: Answer) => void;
}): ReactElement {
  const { question, answer, server, onAnswer } = props;
  const { outcome, pending } = useCalculationOutcome(question.calculation);
  // Seeded from the recorded answer. Correct because each question mounts fresh (`key` in `questionBody`).
  const [draft, setDraft] = useState(() => (answer?.kind === 'number' ? answer.raw : ''));
  /**
   * Tracked apart from `draft` because a number input reports `value === ''` for text it cannot
   * parse. `validity.badInput` is the only signal that something was typed.
   */
  const [badInput, setBadInput] = useState(false);
  const inputId = `${question.id}-value`;
  const hintId = `${question.id}-hint`;
  const invalidId = `${question.id}-invalid`;

  const submitted = answer?.kind === 'number' ? answer : null;

  if (outcome !== null && !outcome.ok) {
    return <Unmarkable reason={outcome.reason} explanation={question.explanation} />;
  }

  const expected = outcome === null ? null : expectedFromResult(outcome.result, question);
  if (expected !== null && !expected.ok) {
    return <Unmarkable reason={expected.reason} explanation={question.explanation} />;
  }

  const target = expected === null ? null : expected.expected;
  const parsed = Number(draft);
  // `!badInput` is stated so the button never depends on the browser sanitising the value.
  const canCheck = !pending && !badInput && draft.trim() !== '' && Number.isFinite(parsed);

  /**
   * Marks the INPUT invalid, never the answer. An answer outside the tolerance is not malformed, and
   * `aria-invalid` on it would read as a mark.
   */
  const malformed = badInput || (draft.trim() !== '' && !Number.isFinite(parsed));
  const describedBy = malformed ? `${invalidId} ${hintId}` : hintId;

  const localMatch = submitted !== null && target !== null && withinTolerance(submitted.value, target);
  const resolved = resolvedVerdict(server, localMatch);
  // `gradedAnswer` rather than `server.state === 'live'`, because a signed-out answer is graded but not
  // stored ('anonymous'), and a `=== 'live'` test would show this page's figure instead.
  const graded = gradedAnswer(server);
  // The tolerance comes from the same source as the figure, so the stated band produced the verdict.
  const against =
    graded !== null && graded.expected !== null
      ? { value: graded.expected.value, tolerance: graded.expected.tolerance }
      : target === null
        ? undefined
        : { value: target.value, tolerance: question.tolerance };
  const verdict = numericVerdict({
    submitted,
    against,
    matched: resolved.matched,
    unit: question.unit,
  });

  return (
    <div className="prl-stack">
      <div className="prl-field prl-learn-quiz__numeric">
        <label className="prl-field__label" htmlFor={inputId}>
          {`Your answer, in ${QUIZ_UNIT_WORDS[question.unit]}`}
        </label>
        {/* Editable after checking. With no score there is nothing to protect by locking it. */}
        <input
          className="prl-input prl-number"
          id={inputId}
          type="number"
          inputMode="decimal"
          step="any"
          aria-describedby={describedBy}
          aria-invalid={malformed ? true : undefined}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setBadInput(event.target.validity.badInput);
          }}
        />
        {/*
          First in `aria-describedby`, so the reason is heard before the tolerance. Rendered only while
          it applies, because a present but irrelevant description is read on every visit.
        */}
        {malformed ? (
          <p className="prl-field__error" id={invalidId}>
            <span aria-hidden="true">{'▲ '}</span>
            That is not a number this question can be checked against. Type digits — a decimal point is fine,
            and so is a rough figure.
          </p>
        ) : null}
        <p className="prl-field__hint" id={hintId}>
          {`Anything within ${formatTolerance(question.tolerance, question.unit)} ${QUIZ_UNIT_WORDS[question.unit]} of the computed figure is accepted. Work it out roughly — the point is the method, not the decimal place.`}
        </p>
      </div>

      <div className="prl-btn-row">
        <Button
          variant="secondary"
          disabled={!canCheck}
          onClick={() => onAnswer({ kind: 'number', value: parsed, raw: draft })}
        >
          {submitted === null ? 'Check against the computed figure' : 'Check again'}
        </Button>
        {pending ? (
          <p className="prl-note">
            Working out the figure your answer will be compared with. This one enumerates every remaining
            run-out, so it takes a moment.
          </p>
        ) : null}
      </div>

      {/* Empty from the first render, and `role="status"` for the atomic half. See the module comment. */}
      <p
        aria-live="polite"
        className="prl-learn-quiz__verdict"
        role="status"
        {...(submitted === null ? {} : verdictMarkAttributes(resolved.matched))}
      >
        {verdict}
        {submitted === null ? '' : ` ${VERDICT_SOURCE_NOTE[resolved.source]}`}
      </p>
      {submitted === null || target === null ? null : <Working result={target.result} expected={target} />}
    </div>
  );
}

// Decision

/**
 * A decision question has no answer in the contract, because an action is only consistent or not
 * with an analysis. The learner decides in the Scenario Lab, then reads the reasoning.
 */
function DecisionQuestion(props: {
  readonly question: Extract<QuizQuestion, { kind: 'decision' }>;
  readonly answer: Answer | undefined;
  readonly onAnswer: (answer: Answer) => void;
}): ReactElement {
  const { question, answer, onAnswer } = props;
  return (
    <div className="prl-stack">
      <Callout tone="insight" title="This one is not marked">
        Decide it first, then read the reasoning. There is no right answer recorded for a decision — only an
        analysis, and the assumptions it rests on.
      </Callout>
      <div className="prl-btn-row">
        <Link className="prl-btn prl-btn--secondary prl-btn--md" href={`/lab/${question.scenarioId}`}>
          Open this spot in the Scenario Lab
        </Link>
        {answer === undefined ? (
          <Button variant="ghost" onClick={() => onAnswer({ kind: 'revealed' })}>
            Show the reasoning
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// The runner

/** Every branch carries `key={question.id}`, or state seeded from one answer leaks into the next. */
function questionBody(
  question: QuizQuestion,
  answer: Answer | undefined,
  server: QuizVerdict,
  onAnswer: (answer: Answer) => void,
): ReactElement {
  if (question.kind === 'multipleChoice') {
    return (
      <MultipleChoice
        key={question.id}
        question={question}
        answer={answer}
        server={server}
        onAnswer={onAnswer}
      />
    );
  }
  if (question.kind === 'numeric') {
    return (
      <NumericQuestion
        key={question.id}
        question={question}
        answer={answer}
        server={server}
        onAnswer={onAnswer}
      />
    );
  }
  // No `server` prop, because a decision question is not graded and nothing is posted for it.
  return <DecisionQuestion key={question.id} question={question} answer={answer} onAnswer={onAnswer} />;
}

/** One object so the identity is stable across renders. */
const IDLE_VERDICT: QuizVerdict = { state: 'idle' };

export function QuizRunner(props: QuizRunnerProps): ReactElement {
  const { quiz, lessonTitleId, lessonTitle, nextLesson } = props;
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<ReadonlyMap<ContentId, Answer>>(new Map());
  const [verdicts, setVerdicts] = useState<ReadonlyMap<ContentId, QuizVerdict>>(new Map());
  const headingRef = useRef<HTMLHeadingElement>(null);
  useFocusOnChange(headingRef, step);
  /**
   * The answer object each question was posted for. Identity, not value, because `record` mints a
   * fresh object per press, so "Check again" posts and paging back does not.
   */
  const posted = useRef(new Map<ContentId, Answer>());

  const total = quiz.questions.length;
  const onReview = step >= total;
  const question = onReview ? undefined : quiz.questions[step];

  const record = (id: ContentId, answer: Answer): void => {
    setAnswers((current) => {
      const next = new Map(current);
      next.set(id, answer);
      return next;
    });
  };

  const currentAnswer = question === undefined ? undefined : answers.get(question.id);

  /**
   * One controller for the runner, aborted on unmount. One per question would abort the POST for the
   * answer just given when the learner pressed "Next question".
   */
  const submissions = useRef<AbortController | null>(null);
  useEffect(() => () => submissions.current?.abort(), []);

  /**
   * Posts each answer object once (see `posted`). Nothing here throws, because `submitQuizAttempt`
   * returns a failure as a value.
   */
  useEffect(() => {
    if (question === undefined || currentAnswer === undefined) return;
    if (posted.current.get(question.id) === currentAnswer) return;
    const body = attemptBodyFor(question, currentAnswer);
    // A decision question, or a "show me the reasoning". Neither is an attempt at anything.
    if (body === null) return;

    posted.current.set(question.id, currentAnswer);
    submissions.current ??= new AbortController();
    const signal = submissions.current.signal;
    const questionId = question.id;
    setVerdicts((current) => new Map(current).set(questionId, { state: 'pending' }));
    void (async () => {
      const verdict = await submitQuizAttempt(quiz.id, body, signal);
      if (signal.aborted) return;
      setVerdicts((current) => new Map(current).set(questionId, verdict));
    })();
  }, [quiz.id, question, currentAnswer]);

  if (question === undefined) {
    return (
      <Panel
        className="prl-learn-quiz"
        eyebrow="Quiz"
        title={quiz.title}
        headingLevel={2}
        actions={<span className="prl-label">Review</span>}
      >
        <h3 className="prl-learn-quiz__heading" ref={headingRef} tabIndex={-1}>
          What to do with all that
        </h3>
        <p className="prl-learn-quiz__advice">{quiz.reviewAdvice}</p>
        {/* Says what is kept and what is not. The condition is a guest session, not a sign-in. */}
        <p className="prl-note">
          Nothing here was scored. Once this browser has a guest session — opening a table starts one — each
          question you answer is kept on your record: the question, your answer, and whether it matched. The
          only figure taken from them is how many different questions you have answered, which you can see on{' '}
          <Link href={RECORD_PATH}>your record</Link>. Nothing adds them up, and there is nowhere in Poker
          Risk Lab for a mark out of five to live. These questions exist to make your own reasoning visible to
          you, which a score actively gets in the way of.
        </p>
        {/* "Next" leads, because the end of a quiz is the end of a lesson. */}
        <div className="prl-btn-row">
          {nextLesson === null ? null : (
            <Link
              className="prl-btn prl-btn--primary prl-btn--md prl-learn-titled-btn"
              href={nextLesson.href}
            >
              {`Next: ${nextLesson.title}`}
            </Link>
          )}
          <Button variant="secondary" onClick={() => setStep(0)}>
            Back to the first question
          </Button>
          {lessonTitleId === null ? null : (
            <ReReadLink
              targetId={lessonTitleId}
              lessonTitle={lessonTitle}
              className="prl-btn prl-btn--ghost prl-btn--md prl-learn-titled-btn"
            />
          )}
          <Link className="prl-btn prl-btn--ghost prl-btn--md" href="/learn">
            Back to the curriculum
          </Link>
        </div>
      </Panel>
    );
  }

  const answer = currentAnswer;
  const answered = answer !== undefined;
  const server = verdicts.get(question.id) ?? IDLE_VERDICT;

  return (
    <Panel
      className="prl-learn-quiz"
      eyebrow="Quiz"
      title={quiz.title}
      headingLevel={2}
      actions={
        <span className="prl-index prl-learn-quiz__position">
          <span className="prl-visually-hidden">Question </span>
          {`${formatIndex(step + 1)} / ${formatIndex(total)}`}
        </span>
      }
    >
      <h3 className="prl-learn-quiz__heading" ref={headingRef} tabIndex={-1}>
        {/* Focus lands here each step, so it says the position. Hidden, since `01 / 05` is drawn. */}
        <span className="prl-visually-hidden">{`Question ${String(step + 1)} of ${String(total)}. `}</span>
        {question.prompt}
      </h3>

      {questionBody(question, answer, server, (given) => record(question.id, given))}

      {answered ? (
        <div className="prl-learn-quiz__explanation">
          <span className="prl-label">Why</span>
          <p>{question.explanation}</p>
          {lessonTitleId === null ? null : (
            <ReReadLink
              targetId={lessonTitleId}
              lessonTitle={lessonTitle}
              className="prl-learn-quiz__lesson-link"
            />
          )}
        </div>
      ) : null}

      <div className="prl-btn-row prl-learn-quiz__nav">
        <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>
          Previous
        </Button>
        <Button variant="secondary" onClick={() => setStep(step + 1)}>
          {step + 1 === total ? 'Finish' : 'Next question'}
        </Button>
        {answered ? null : (
          <p className="prl-note prl-learn-quiz__skip">
            Skipping is fine, and costs nothing. Come back to it or do not.
          </p>
        )}
      </div>
    </Panel>
  );
}
