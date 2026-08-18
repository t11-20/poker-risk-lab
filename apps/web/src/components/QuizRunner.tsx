'use client';

/**
 * A quiz, one question at a time.
 *
 * ## There is no score in this file, and that is the design
 *
 * `Quiz` in `@prl/contracts` has no score field, no pass mark, no streak counter and no
 * percentage, and its doc comment says the absence is deliberate. This component does not
 * reintroduce any of it. Concretely, and checkably:
 *
 *  - nothing counts how many answers matched, so nothing can be displayed;
 *  - `01 / 05` is wayfinding, the same as a page number — it says where you are, never how you
 *    are doing;
 *  - an answer that does not match costs nothing: the explanation opens, a link to the lesson
 *    appears, and the learner moves on or goes back at their own choosing;
 *  - the end of the quiz shows `reviewAdvice` and nothing else. No summary, no tally, no
 *    "you got 3".
 *
 * The reason is in `docs/PRODUCT-GUARDRAILS.md`: reward the reasoning, never the outcome. A
 * score turns a reflection tool into a slot machine with homework, and it teaches a learner to
 * optimise for the number instead of for understanding.
 *
 * ## Nothing is labelled "correct"
 *
 * Multiple choice says "the answer this lesson gives"; numeric says "within the tolerance of the
 * computed value". Both are precise about *what* the comparison is, which "correct" is not — the
 * lesson's answer is the lesson's answer, and a numeric answer is judged against a figure
 * computed here, to a tolerance the question itself declares.
 *
 * ## Numeric answers are computed, never stored
 *
 * `expectedFromResult` derives the target from the question's `calculation` and `field` using
 * `@prl/poker-math`. The content contains no answer to read (ADR 0006), so a question cannot
 * drift out of step with the maths the lesson taught. The working is shown after answering, not
 * before.
 *
 * ## Focus
 *
 * Moving to another question is a keystroke or a click by the learner, so focus follows them to
 * the new question's heading — that is navigation, and leaving focus on a button whose label
 * just changed is worse. Answering, by contrast, moves nothing: the feedback is announced by an
 * `aria-live` region, because a reader who is mid-sentence should not be dragged elsewhere.
 */

import type { ContentId, Quiz, QuizQuestion } from '@prl/contracts';
import { Button, Callout, Chip, Formula, formatChips, formatIndex, Metric, Panel, withKeys } from '@prl/ui';
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
  QUIZ_UNIT_DECIMALS,
  QUIZ_UNIT_WORDS,
  withinTolerance,
} from '@/lib/learn-calculations.ts';

/** What the learner did. `revealed` is a decision question, which has nothing to check. */
type Answer =
  | { readonly kind: 'choice'; readonly index: number }
  | { readonly kind: 'number'; readonly value: number; readonly raw: string }
  | { readonly kind: 'revealed' };

export interface QuizRunnerProps {
  readonly quiz: Quiz;
  /** Where to send a learner who wants to re-read. `null` when the quiz stands alone. */
  readonly lessonHref: string | null;
  readonly lessonTitle: string | null;
}

const CHOICE_MARKER = { lesson: '◆', yours: '✕' } as const;

// ---------------------------------------------------------------------------
// Multiple choice
// ---------------------------------------------------------------------------

function MultipleChoice(props: {
  readonly question: Extract<QuizQuestion, { kind: 'multipleChoice' }>;
  readonly answer: Answer | undefined;
  readonly onAnswer: (answer: Answer) => void;
}): ReactElement {
  const { question, answer, onAnswer } = props;
  const chosen = answer?.kind === 'choice' ? answer.index : null;
  const answered = chosen !== null;
  // Keys from the option text, with an occurrence counter, rather than from the position: an
  // index key makes React reuse the wrong radio if a question is ever re-ordered, and the
  // position is still available as the `index` argument for the logic that genuinely needs it.
  const options = withKeys(question.options, 'option');

  const verdict = !answered
    ? ''
    : chosen === question.correctIndex
      ? 'That matches the answer this lesson gives. The reasoning is below — worth reading even so, because the reasoning is the part that transfers.'
      : 'That is not the answer this lesson gives. Nothing is deducted for it, and you can change your mind as often as you like; the note beside each option says why it is a tempting one.';

  return (
    <div className="prl-stack">
      <fieldset className="prl-learn-quiz__options">
        {/*
          "Choose one answer", not the prompt again. The prompt is already the `h3` immediately
          above this group, and a legend that repeats it makes a screen reader read the whole
          question twice — once as the heading, once as the group's name.
        */}
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
                  checked={isChoice}
                  onChange={() => onAnswer({ kind: 'choice', index })}
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
        The live region is in the DOM from the first render, empty, rather than appearing with
        its text. A region that arrives at the same moment as its content is missed by several
        screen readers, which is the difference between feedback being announced and being
        silently added below the fold.
      */}
      <p className="prl-learn-quiz__verdict" aria-live="polite">
        {verdict}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Numeric
// ---------------------------------------------------------------------------

/** The working: the figure, its method, and the derivation the library wrote. */
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

function NumericQuestion(props: {
  readonly question: Extract<QuizQuestion, { kind: 'numeric' }>;
  readonly answer: Answer | undefined;
  readonly onAnswer: (answer: Answer) => void;
}): ReactElement {
  const { question, answer, onAnswer } = props;
  const { outcome, pending } = useCalculationOutcome(question.calculation);
  // Seeded from the recorded answer so that coming back to a question shows what was typed.
  // Mounting fresh per question is what makes the initialiser correct — see the `key` in
  // `questionBody`.
  const [draft, setDraft] = useState(() => (answer?.kind === 'number' ? answer.raw : ''));
  const inputId = `${question.id}-value`;
  const hintId = `${question.id}-hint`;

  const submitted = answer?.kind === 'number' ? answer : null;

  if (outcome !== null && !outcome.ok) {
    return (
      <div className="prl-error">
        <p className="prl-error__title">
          <span aria-hidden="true">▲ </span>
          This question cannot be marked
        </p>
        <p>{outcome.reason}</p>
        <p>{question.explanation}</p>
      </div>
    );
  }

  const expected = outcome === null ? null : expectedFromResult(outcome.result, question);
  if (expected !== null && !expected.ok) {
    return (
      <div className="prl-error">
        <p className="prl-error__title">
          <span aria-hidden="true">▲ </span>
          This question cannot be marked
        </p>
        <p>{expected.reason}</p>
        <p>{question.explanation}</p>
      </div>
    );
  }

  const target = expected === null ? null : expected.expected;
  const matched = submitted !== null && target !== null && withinTolerance(submitted.value, target);
  const parsed = Number(draft);
  const canCheck = !pending && draft.trim() !== '' && Number.isFinite(parsed);

  const verdict =
    submitted === null
      ? ''
      : target === null
        ? 'The computed figure is not available, so there is nothing to compare your answer with.'
        : matched
          ? `${formatQuizValue(submitted.value, question.unit)} is within the tolerance of ${formatQuizValue(target.value, question.unit)}.`
          : `${formatQuizValue(submitted.value, question.unit)} is outside the tolerance of ${formatQuizValue(target.value, question.unit)}. Nothing is deducted for that — the working is below, and the gap is usually one step of the method rather than the whole of it.`;

  return (
    <div className="prl-stack">
      <div className="prl-field prl-learn-quiz__numeric">
        <label className="prl-field__label" htmlFor={inputId}>
          {`Your answer, in ${QUIZ_UNIT_WORDS[question.unit]}`}
        </label>
        {/*
          Editable after checking, on purpose. There is no score, so there is nothing to protect
          by locking the field — and a learner who wants to try the arithmetic a second way should
          not have to reload the page to do it.
        */}
        <input
          className="prl-input prl-number"
          id={inputId}
          type="number"
          inputMode="decimal"
          step="any"
          aria-describedby={hintId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className="prl-field__hint" id={hintId}>
          {`Anything within ${formatChips(question.tolerance, { decimals: QUIZ_UNIT_DECIMALS[question.unit] })} ${QUIZ_UNIT_WORDS[question.unit]} of the computed figure is accepted. Work it out roughly — the point is the method, not the decimal place.`}
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

      <p className="prl-learn-quiz__verdict" aria-live="polite">
        {verdict}
      </p>
      {submitted === null || target === null ? null : <Working result={target.result} expected={target} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * A decision question has no answer in the contract, and that is right.
 *
 * There is no `correctAction` field on a `decision` question, because a poker action is not
 * right or wrong — it is consistent or inconsistent with an analysis whose assumptions you can
 * read. So this asks the learner to decide in the Scenario Lab, where the figures are computed
 * live and the assumptions are on screen, and then offers the reasoning. Marking it would be
 * claiming an authority the product explicitly declines.
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

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * Dispatch by question kind.
 *
 * Every branch carries `key={question.id}`, which is load-bearing rather than tidy: without it
 * React keeps one `NumericQuestion` instance alive across two consecutive numeric questions, and
 * the state seeded from the previous answer would carry over into the next question's input.
 */
function questionBody(
  question: QuizQuestion,
  answer: Answer | undefined,
  onAnswer: (answer: Answer) => void,
): ReactElement {
  if (question.kind === 'multipleChoice') {
    return <MultipleChoice key={question.id} question={question} answer={answer} onAnswer={onAnswer} />;
  }
  if (question.kind === 'numeric') {
    return <NumericQuestion key={question.id} question={question} answer={answer} onAnswer={onAnswer} />;
  }
  return <DecisionQuestion key={question.id} question={question} answer={answer} onAnswer={onAnswer} />;
}

export function QuizRunner(props: QuizRunnerProps): ReactElement {
  const { quiz, lessonHref, lessonTitle } = props;
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<ReadonlyMap<ContentId, Answer>>(new Map());
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** The first render must not steal focus; only a step *change* moves it. */
  const mounted = useRef(false);

  const total = quiz.questions.length;
  const onReview = step >= total;
  const question = onReview ? undefined : quiz.questions[step];

  /**
   * Focus follows a step change, and only a step change.
   *
   * `step` is the effect's *trigger* rather than a value it reads, which is why the linter cannot
   * see that it belongs in the list. Removing it would leave a keyboard reader on a "next" button
   * while the question above it changed silently. The `mounted` guard is what stops the first
   * render pulling focus into the middle of a lesson someone is reading.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `step` is the trigger; without it focus stops following navigation
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const record = (id: ContentId, answer: Answer): void => {
    setAnswers((current) => {
      const next = new Map(current);
      next.set(id, answer);
      return next;
    });
  };

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
        <p className="prl-note">
          Nothing here was scored, and nothing was recorded as a result. These questions exist to make your
          own reasoning visible to you, which a mark out of five actively gets in the way of.
        </p>
        <div className="prl-btn-row">
          <Button variant="secondary" onClick={() => setStep(0)}>
            Back to the first question
          </Button>
          {lessonHref === null ? null : (
            <Link className="prl-btn prl-btn--ghost prl-btn--md" href={lessonHref}>
              {lessonTitle === null ? 'Re-read the lesson' : `Re-read ${lessonTitle}`}
            </Link>
          )}
          <Link className="prl-btn prl-btn--ghost prl-btn--md" href="/learn">
            Back to the curriculum
          </Link>
        </div>
      </Panel>
    );
  }

  const answer = answers.get(question.id);
  const answered = answer !== undefined;

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
        {question.prompt}
      </h3>

      {questionBody(question, answer, (given) => record(question.id, given))}

      {answered ? (
        <div className="prl-learn-quiz__explanation">
          <span className="prl-label">Why</span>
          <p>{question.explanation}</p>
          {lessonHref === null ? null : (
            <Link className="prl-learn-quiz__lesson-link" href={lessonHref}>
              {lessonTitle === null ? 'Re-read the lesson' : `Re-read ${lessonTitle}`}
            </Link>
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
