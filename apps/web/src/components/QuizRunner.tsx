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
 * ## The answer goes to the server, and the server's comparison is the one displayed
 *
 * This file used to grade every answer in the browser and send nothing at all, which had two
 * consequences. `prl.quiz_attempts` was never written, so `quizQuestionsAnswered` in
 * `GET /me/progress` could not be anything but zero however much work a learner did. And the
 * comparison on screen was nobody's record of anything — there was no server answer for it to
 * agree or disagree with.
 *
 * Both are fixed by `src/lib/quiz-attempts.ts`: every graded answer is posted, and the verdict
 * shown is the server's whenever the server answered. Where it did not, the local comparison
 * stands in and the screen says plainly that nothing was recorded — see `VERDICT_SOURCE_NOTE`. A
 * failed POST must never take a lesson down with it, which is why nothing on this path throws.
 *
 * ## "Recorded" is only said when a row exists
 *
 * The sentence under a verdict used to claim the server had recorded the question for every
 * successful call, including the signed-out one — the product's default state — where the route
 * answers 200 and deliberately stores nothing. `QuizAttemptResponse.recorded` now carries that
 * difference and `resolvedVerdict` turns it into a fourth source, `'anonymous'`, whose sentence
 * says what actually happened and how a learner who wants their answers kept gets a session. It is
 * said once, under the answer, and never as a banner or a gate: this quiz is worth doing signed
 * out, and it is not worth nagging anybody through.
 *
 * A `decision` question is still not sent. There is no answer to record for one; see
 * `DecisionQuestion` below.
 *
 * ## Focus
 *
 * Moving to another question is a keystroke or a click by the learner, so focus follows them to
 * the new question's heading — that is navigation, and leaving focus on a button whose label
 * just changed is worse. Answering, by contrast, moves nothing: the feedback is announced by an
 * `aria-live` region, because a reader who is mid-sentence should not be dragged elsewhere.
 *
 * The heading carries the position as visually-hidden text — "Question 2 of 5." before the prompt —
 * precisely because focus lands there. Without it, pressing "Next question" announced the new prompt
 * and nothing else: a reader had no way to tell whether they had advanced one question or five, and
 * the `01 / 05` counter that answers it is in the panel's action slot, which focus never visits. The
 * counter stays where it is for a reader who is browsing rather than being moved.
 *
 * ## The verdict regions are `role="status"`, not a bare `aria-live`
 *
 * Both of them hold two pieces of text: the comparison, and the sentence saying who made it
 * (`VERDICT_SOURCE_NOTE`). With `aria-live="polite"` alone the region is not atomic, so a change
 * announces only the text node that changed — a learner could hear "Nothing was recorded, because
 * you are not signed in." with no verdict in front of it. `role="status"` carries an implicit
 * `aria-atomic="true"`, which is what makes the whole sentence arrive as one message.
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
import {
  attemptBodyFor,
  gradedAnswer,
  type QuizAnswer,
  type QuizVerdict,
  resolvedVerdict,
  submitQuizAttempt,
  VERDICT_SOURCE_NOTE,
} from '@/lib/quiz-attempts.ts';
import { RECORD_PATH } from '@/lib/record-data.ts';

/** What the learner did. `revealed` is a decision question, which has nothing to check. */
type Answer = QuizAnswer;

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
  readonly server: QuizVerdict;
  readonly onAnswer: (answer: Answer) => void;
}): ReactElement {
  const { question, answer, server, onAnswer } = props;
  const chosen = answer?.kind === 'choice' ? answer.index : null;
  const answered = chosen !== null;
  // Keys from the option text, with an occurrence counter, rather than from the position: an
  // index key makes React reuse the wrong radio if a question is ever re-ordered, and the
  // position is still available as the `index` argument for the logic that genuinely needs it.
  const options = withKeys(question.options, 'option');

  // The server's comparison when there is one, this page's when there is not. `correctIndex` still
  // decides which option carries the "the answer this lesson gives" chip, because that is a fact
  // about the option rather than about what the learner did.
  const resolved = resolvedVerdict(server, chosen === question.correctIndex);
  const verdict = !answered
    ? ''
    : resolved.matched
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

        `role="status"` for the atomic half — see the module comment.
      */}
      <p aria-live="polite" className="prl-learn-quiz__verdict" role="status">
        {verdict}
        {answered ? ` ${VERDICT_SOURCE_NOTE[resolved.source]}` : ''}
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

/**
 * What stands in for a numeric question whose target could not be computed.
 *
 * `role="alert"`, because this block REPLACES the question: a reader who cannot see the screen is
 * otherwise left waiting at a field that has silently gone away. It is mounted only in the failure
 * state, which is what makes an alert fire — an always-present region whose text merely changes is
 * announced far less reliably.
 */
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

/**
 * The sentence about one numeric answer.
 *
 * `against` is the figure the comparison was actually made against — the server's when the server
 * made it — so the number quoted here is always the number that produced the verdict beside it.
 * Pulled out of the component because a comparison written inline next to five other conditionals
 * is where a precedence gets quietly reversed.
 */
function numericVerdict(input: {
  readonly submitted: { readonly value: number } | null;
  readonly against: number | undefined;
  readonly matched: boolean;
  readonly unit: Extract<QuizQuestion, { kind: 'numeric' }>['unit'];
}): string {
  const { submitted, against, matched, unit } = input;
  if (submitted === null) return '';
  if (against === undefined) {
    return 'The computed figure is not available, so there is nothing to compare your answer with.';
  }
  const yours = formatQuizValue(submitted.value, unit);
  const theirs = formatQuizValue(against, unit);
  if (matched) return `${yours} is within the tolerance of ${theirs}.`;
  return (
    `${yours} is outside the tolerance of ${theirs}. Nothing is deducted for that — the working is ` +
    'below, and the gap is usually one step of the method rather than the whole of it.'
  );
}

function NumericQuestion(props: {
  readonly question: Extract<QuizQuestion, { kind: 'numeric' }>;
  readonly answer: Answer | undefined;
  readonly server: QuizVerdict;
  readonly onAnswer: (answer: Answer) => void;
}): ReactElement {
  const { question, answer, server, onAnswer } = props;
  const { outcome, pending } = useCalculationOutcome(question.calculation);
  // Seeded from the recorded answer so that coming back to a question shows what was typed.
  // Mounting fresh per question is what makes the initialiser correct — see the `key` in
  // `questionBody`.
  const [draft, setDraft] = useState(() => (answer?.kind === 'number' ? answer.raw : ''));
  /**
   * Whether the browser is holding text it could not parse as a number.
   *
   * Tracked separately from `draft` because it CANNOT be derived from it. An `<input type="number">`
   * reports `value === ''` for anything it failed to parse — type "one third" and the characters
   * are on screen while `event.target.value` is the empty string — so a check written against the
   * draft alone can never fire, which is exactly what the first version of this fix got wrong. The
   * only signal that anything was typed is `validity.badInput`, and without it the field looks
   * empty, the button disables, and nothing anywhere says why. That is the "announce or silently
   * clamp without marking the field" the audit named.
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
  // `!badInput` is stated rather than relied upon: a number field sanitises an unparseable value to
  // the empty string, so the draft check already covers it today — but that is the platform's rule
  // and not this component's, and "the button was enabled for text that is not a number" is not a
  // defect worth inheriting if a browser ever keeps the characters.
  const canCheck = !pending && !badInput && draft.trim() !== '' && Number.isFinite(parsed);

  /**
   * The field is marked invalid when what is in it is not a number this question can be answered
   * with — and only then.
   *
   * "Invalid" here means the INPUT, never the answer. An answer outside the tolerance is a correct
   * use of this field, and marking it `aria-invalid` would tell a screen reader the learner had
   * typed something malformed — which is both false and the closest thing to a mark this product
   * allows itself.
   *
   * Two conditions, because there are two ways to get text that is not a number into this field:
   * `badInput` is the browser holding characters it could not parse (see the state above), and the
   * second covers a draft that survives as a string but does not produce a finite number.
   */
  const malformed = badInput || (draft.trim() !== '' && !Number.isFinite(parsed));
  const describedBy = malformed ? `${invalidId} ${hintId}` : hintId;

  // The server's comparison when it answered, this page's when it did not. `resolvedVerdict` keeps
  // that precedence in one place, shared with the multiple-choice branch.
  const localMatch = submitted !== null && target !== null && withinTolerance(submitted.value, target);
  const resolved = resolvedVerdict(server, localMatch);
  // `gradedAnswer` rather than `server.state === 'live'`: a signed-out learner's answer is graded by
  // the server and stored nowhere, which is the `'anonymous'` state — a `=== 'live'` test here would
  // quietly show them this page's figure while the server's own sat unread in the reply.
  const graded = gradedAnswer(server);
  const against = graded !== null && graded.expected !== null ? graded.expected.value : target?.value;
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
          aria-describedby={describedBy}
          aria-invalid={malformed ? true : undefined}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setBadInput(event.target.validity.badInput);
          }}
        />
        {/*
          The correction comes FIRST in `aria-describedby`, so a reader who has just been told the
          field is invalid hears why before hearing the tolerance rule again. It is rendered only
          while it applies rather than hidden with CSS: an always-present description that is
          sometimes irrelevant is read out on every visit to the field.
        */}
        {malformed ? (
          <p className="prl-field__error" id={invalidId}>
            <span aria-hidden="true">{'▲ '}</span>
            That is not a number this question can be checked against. Type digits — a decimal point is fine,
            and so is a rough figure.
          </p>
        ) : null}
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

      {/* Empty from the first render, and `role="status"` for the atomic half. See the module comment. */}
      <p aria-live="polite" className="prl-learn-quiz__verdict" role="status">
        {verdict}
        {submitted === null ? '' : ` ${VERDICT_SOURCE_NOTE[resolved.source]}`}
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
  // No `server` prop: a decision question is not graded and nothing is posted for it.
  return <DecisionQuestion key={question.id} question={question} answer={answer} onAnswer={onAnswer} />;
}

/** Nothing has been answered yet. One object so the identity is stable across renders. */
const IDLE_VERDICT: QuizVerdict = { state: 'idle' };

export function QuizRunner(props: QuizRunnerProps): ReactElement {
  const { quiz, lessonHref, lessonTitle } = props;
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<ReadonlyMap<ContentId, Answer>>(new Map());
  const [verdicts, setVerdicts] = useState<ReadonlyMap<ContentId, QuizVerdict>>(new Map());
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** The first render must not steal focus; only a step *change* moves it. */
  const mounted = useRef(false);
  /**
   * The answer object each question has already been posted for.
   *
   * Identity, not value: `record` mints a fresh object on every press, so "the learner pressed
   * Check again with the same number" is a new answer and is posted again — which is what they
   * asked for — while merely paging back to a question they answered ten minutes ago is not. A ref
   * rather than state because nothing renders from it, and putting it in state would re-run the
   * effect that writes it.
   */
  const posted = useRef(new Map<ContentId, Answer>());

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

  const currentAnswer = question === undefined ? undefined : answers.get(question.id);

  /**
   * One controller for every attempt this runner sends, aborted when the runner goes away.
   *
   * Deliberately NOT one per question. A per-question controller would be cleaned up by React the
   * moment the learner pressed "Next question", which would abort the POST for the answer they had
   * just given — the attempt would be lost for exactly the learner who works quickly. Unmount is
   * the only moment at which nobody is waiting for the answer any more.
   */
  const submissions = useRef<AbortController | null>(null);
  useEffect(() => () => submissions.current?.abort(), []);

  /**
   * Sends the answer, once per answer.
   *
   * The guard is on object IDENTITY, and `record` mints a fresh object on every press: pressing
   * "Check again" is a new attempt and is sent again, while paging back to a question answered ten
   * minutes ago sends nothing. Re-sending on navigation would be harmless to the count the server
   * derives — it counts DISTINCT questions — but it would write rows nobody asked for.
   *
   * Nothing here throws and nothing here can fail the render: `submitQuizAttempt` returns the
   * failure as a value, and the screen keeps its own comparison and says so.
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
        {/*
          This used to read "nothing was recorded as a result", which was true only because the
          answers were never sent anywhere. They are sent now, so the sentence says what is actually
          kept — and, more usefully, what is not: there is no total, and the schema has no column
          one could be stored in.
        */}
        <p className="prl-note">
          Nothing here was scored. If you are signed in, each question you answered is stored as one row — the
          question, the answer you sent, and whether it matched — and the only figure derived from those rows
          is how many different questions you have answered, which you can see under{' '}
          <Link href={RECORD_PATH}>your record</Link>. Nothing adds them up, and there is nowhere in this
          product for a mark out of five to live. These questions exist to make your own reasoning visible to
          you, which a score actively gets in the way of.
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
        {/* Where the caret lands on every step change, so this is where the position has to be
            said. Hidden rather than drawn: the panel already shows `01 / 05` beside the title, and
            printing it twice would be noise for everybody who can see it. */}
        <span className="prl-visually-hidden">{`Question ${String(step + 1)} of ${String(total)}. `}</span>
        {question.prompt}
      </h3>

      {questionBody(question, answer, server, (given) => record(question.id, given))}

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
