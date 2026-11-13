/**
 * A quiz in chat, one question per message. Nothing counts matched answers, so there is no score
 * (guardrail §2, as in `QuizRunner.tsx`). Nothing is labelled "correct" (guardrail §3). A decision is
 * not marked; the reader sees the computed spot and its assumptions. Wording matches the web runner.
 * A press applies only at its run tag, position and stage. Anything else is a toast and no change.
 */

import { quizById, quizzes } from '@prl/content';
import { type Quiz, type QuizQuestion, type Topic, withinTolerance } from '@prl/contracts';
import {
  DECISION_ACTIONS,
  type DecisionAction,
  type DecisionQuestion,
  decisionSpot,
  expectedAnswer,
  figureText,
  isTopic,
  type NumericQuestion,
  parseNumber,
  quizTopics,
  quizzesIn,
  toleranceText,
  topicLabel,
} from './learn.ts';
import type { Deps, Outgoing, Phase, Session, StepResult } from './step.ts';
import { type Button, cardsText, encodePress, type Press, type QuizMoment } from './view.ts';

export type QuizPhase = Extract<Phase, { kind: 'quiz' }>;

export const QUIZ_STALE = 'That button is from an earlier question.';
export const GONE = 'That button is from an earlier version of this bot. Send /start for the menu.';
export const FINISH_HAND_FIRST = 'Finish this hand first, then practise a quiz.';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] as const;

function toast(session: Session, text: string): StepResult {
  return { session, out: [{ kind: 'toast', text }] };
}

function menuButton(): Button {
  return { label: 'Menu', data: encodePress({ kind: 'menu' }) };
}

/** Starting a quiz replaces the phase, so it waits for a live hand to end rather than abandon it. */
function midHand(session: Session): boolean {
  return session.phase.kind === 'deciding';
}

export function onQuizzes(session: Session): StepResult {
  if (midHand(session)) return toast(session, FINISH_HAND_FIRST);
  const buttons = quizTopics().map((topic) => [
    { label: topicLabel(topic), data: encodePress({ kind: 'topic', topic }) },
  ]);
  return {
    session,
    out: [
      {
        kind: 'send',
        text:
          'Practise a quiz. Choose a topic.\n\nOne question per message. Nothing is scored or kept: ' +
          'each answer opens the reasoning, and you can stop at any point.',
        buttons: [...buttons, [menuButton()]],
      },
    ],
  };
}

export function onTopic(session: Session, topic: string, deps: Deps): StepResult {
  if (midHand(session)) return toast(session, FINISH_HAND_FIRST);
  if (!isTopic(topic)) return toast(session, GONE);
  const inTopic = quizzesIn(topic);
  const only = inTopic[0];
  if (only === undefined) return toast(session, GONE);
  if (inTopic.length === 1) return startQuiz(session, only.id, deps);
  return { session, out: [quizListMessage(topic, inTopic)] };
}

function quizListMessage(topic: Topic, inTopic: readonly Quiz[]): Outgoing {
  return {
    kind: 'send',
    text: `${topicLabel(topic)}. Choose a quiz.`,
    buttons: [
      ...inTopic.map((quiz) => [
        {
          label: `${quiz.title} (${quiz.questions.length} questions)`,
          data: encodePress({ kind: 'quiz', quizId: quiz.id }),
        },
      ]),
      [{ label: 'Other topics', data: encodePress({ kind: 'quizzes' }) }, menuButton()],
    ],
  };
}

export function startQuiz(session: Session, quizId: string, deps: Deps): StepResult {
  if (midHand(session)) return toast(session, FINISH_HAND_FIRST);
  const quiz = quizById(quizId);
  if (quiz === null) return toast(session, GONE);
  const phase: QuizPhase = {
    kind: 'quiz',
    run: deps.newTag(),
    quiz: quizzes().indexOf(quiz),
    position: 0,
    stage: 'asking',
  };
  return {
    session: { ...session, phase, revision: session.revision + 1 },
    out: [questionMessage(phase)],
  };
}

function quizOf(phase: QuizPhase): Quiz {
  const quiz = quizzes()[phase.quiz];
  if (quiz === undefined) throw new Error(`quiz phase names quiz ${phase.quiz}, which does not exist`);
  return quiz;
}

function questionOf(phase: QuizPhase): QuizQuestion {
  const question = quizOf(phase).questions[phase.position];
  if (question === undefined) {
    throw new Error(
      `quiz phase names question ${phase.position} of ${quizOf(phase).id}, which does not exist`,
    );
  }
  return question;
}

function momentOf(phase: QuizPhase): QuizMoment {
  return { run: phase.run, position: phase.position };
}

/** Every later state of the question is this text with more beneath. */
function questionText(phase: QuizPhase): string {
  const quiz = quizOf(phase);
  const question = questionOf(phase);
  const lines = [
    `${quiz.title} · Question ${phase.position + 1} of ${quiz.questions.length}`,
    '',
    question.prompt,
  ];
  if (question.kind === 'multipleChoice') {
    lines.push('', ...question.options.map((option, index) => `${LETTERS[index] ?? '?'}. ${option}`));
  }
  if (question.kind === 'numeric') {
    lines.push(
      '',
      `Type your answer as a number, in ${unitPrompt(question)}. Anything within ` +
        `${toleranceText(question.tolerance, question.unit)} of the computed figure is accepted.`,
    );
  }
  if (question.kind === 'decision') lines.push('', ...spotLines(question));
  return lines.join('\n');
}

function unitPrompt(question: NumericQuestion): string {
  switch (question.unit) {
    case 'percent':
      return 'percent';
    case 'chips':
      return 'units';
    case 'ratio':
      return 'the first number of "X to 1"';
    case 'count':
      return 'cards';
    case 'hands':
      return 'hands';
  }
}

function spotLines(question: DecisionQuestion): string[] {
  const { analysis, facingAction, range } = decisionSpot(question);
  const { situation } = analysis;
  return [
    `Your cards: ${cardsText(situation.heroCards)}`,
    `Board: ${situation.board.length === 0 ? '(none yet)' : cardsText(situation.board)}`,
    `Pot ${situation.pot.toLocaleString('en-US')} with their bet in it, ${situation.toCall.toLocaleString('en-US')} to call. ${facingAction}`,
    `Their range, as this spot assumes it: ${range}.`,
  ];
}

function questionButtons(phase: QuizPhase): Button[][] {
  const question = questionOf(phase);
  const at = momentOf(phase);
  switch (question.kind) {
    case 'multipleChoice':
      return [
        question.options.map((_, option) => ({
          label: LETTERS[option] ?? '?',
          data: encodePress({ kind: 'choose', at, option }),
        })),
      ];
    case 'numeric':
      return [[{ label: 'Show the answer', data: encodePress({ kind: 'reveal', at }) }]];
    case 'decision':
      return [
        DECISION_ACTIONS.map((action) => ({
          label: action === 'fold' ? 'Fold' : 'Call',
          data: encodePress({ kind: 'decide', at, action }),
        })),
      ];
  }
}

function questionMessage(phase: QuizPhase): Outgoing {
  return { kind: 'send', text: questionText(phase), buttons: questionButtons(phase) };
}

type QuizPress = Extract<Press, { kind: 'choose' | 'decide' | 'reveal' | 'onward' }>;

/** Null when the session has moved on from the press. */
function drawnFor(session: Session, press: QuizPress): QuizPhase | null {
  const { phase } = session;
  if (phase.kind !== 'quiz') return null;
  if (phase.run !== press.at.run || phase.position !== press.at.position) return null;
  const stage = press.kind === 'onward' ? 'answered' : 'asking';
  return phase.stage === stage ? phase : null;
}

export function onQuizPress(session: Session, press: QuizPress): StepResult {
  const phase = drawnFor(session, press);
  if (phase === null) return toast(session, QUIZ_STALE);
  const question = questionOf(phase);
  if (press.kind === 'onward') return onward(session, phase);
  if (press.kind === 'choose' && question.kind === 'multipleChoice') {
    if (press.option >= question.options.length) return toast(session, QUIZ_STALE);
    return answered(session, phase, 'edit', choiceLines(question, press.option));
  }
  if (press.kind === 'decide' && question.kind === 'decision') {
    return answered(session, phase, 'edit', decisionLines(question, press.action));
  }
  if (press.kind === 'reveal' && question.kind === 'numeric') {
    return answered(session, phase, 'edit', revealLines(question));
  }
  // Right moment, wrong question kind. This process did not write it.
  return toast(session, QUIZ_STALE);
}

/** Only a numeric question still being asked takes text. Null otherwise. */
export function onQuizText(session: Session, text: string): StepResult | null {
  const { phase } = session;
  if (phase.kind !== 'quiz' || phase.stage !== 'asking') return null;
  const question = questionOf(phase);
  if (question.kind !== 'numeric') return null;
  const answer = parseNumber(text);
  if (answer === null) {
    return {
      session,
      out: [
        {
          kind: 'send',
          text: 'That is not a number I can read. Type just the figure, for example 33.3, or press Show the answer.',
          buttons: [],
        },
      ],
    };
  }
  // A typed answer has no message to edit, so the verdict is a new message with the header.
  const quiz = quizOf(phase);
  const header = `${quiz.title} · Question ${phase.position + 1} of ${quiz.questions.length}`;
  return answered(session, phase, 'send', [header, '', ...numericLines(question, answer)]);
}

function answered(
  session: Session,
  phase: QuizPhase,
  how: 'send' | 'edit',
  lines: readonly string[],
): StepResult {
  const next: QuizPhase = { ...phase, stage: 'answered' };
  const last = phase.position + 1 >= quizOf(phase).questions.length;
  const text = how === 'edit' ? `${questionText(phase)}\n\n${lines.join('\n')}` : lines.join('\n');
  return {
    session: { ...session, phase: next, revision: session.revision + 1 },
    out: [
      {
        kind: how,
        text,
        buttons: [
          [
            {
              label: last ? 'Finish' : 'Next question',
              data: encodePress({ kind: 'onward', at: momentOf(phase) }),
            },
            menuButton(),
          ],
        ],
      },
    ],
  };
}

function choiceLines(question: Extract<QuizQuestion, { kind: 'multipleChoice' }>, chosen: number): string[] {
  const letter = (index: number): string => LETTERS[index] ?? '?';
  const lines = [`You chose ${letter(chosen)}.`];
  if (chosen === question.correctIndex) {
    lines.push(
      'That matches the answer this lesson gives. The reasoning is below: the reasoning is the part that transfers.',
    );
  } else {
    lines.push(
      `That is not the answer this lesson gives, which is ${letter(question.correctIndex)}. Nothing is ` +
        'deducted for it.',
    );
  }
  const notes = [chosen, question.correctIndex]
    .filter((index, position, all) => all.indexOf(index) === position)
    .flatMap((index) => {
      const note = question.optionNotes?.[index];
      return note === undefined ? [] : [`On ${letter(index)}: ${note}`];
    });
  if (notes.length > 0) lines.push('', ...notes);
  lines.push('', question.explanation);
  return lines;
}

function numericLines(question: NumericQuestion, answer: number): string[] {
  const expected = expectedAnswer(question);
  const yours = figureText(answer, expected.unit);
  const theirs = figureText(expected.value, expected.unit);
  const verdict = withinTolerance(answer, expected)
    ? `${yours} is within the tolerance of ${theirs}.`
    : `${yours} is outside the tolerance of ${theirs}. Nothing is deducted for that: the working is ` +
      'below, and the gap is usually one step of the method rather than the whole of it.';
  return [
    `You answered ${yours}.`,
    verdict,
    `Anything within ${toleranceText(expected.tolerance, expected.unit)} is accepted.`,
    '',
    question.explanation,
    '',
    `How it was worked out: ${expected.working}`,
  ];
}

function revealLines(question: NumericQuestion): string[] {
  const expected = expectedAnswer(question);
  return [
    `The computed figure is ${figureText(expected.value, expected.unit)}. Anything within ` +
      `${toleranceText(expected.tolerance, expected.unit)} is accepted.`,
    '',
    question.explanation,
    '',
    `How it was worked out: ${expected.working}`,
  ];
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function decisionLines(question: DecisionQuestion, action: DecisionAction): string[] {
  const { analysis, assumptions } = decisionSpot(question);
  const { equity } = analysis;
  const method =
    equity.method === 'exact-enumeration'
      ? 'computed exactly, with no sampling error'
      : `sampled, ${equity.trials.toLocaleString('en-US')} run-outs` +
        (equity.confidence === null ? '' : `, ±${equity.confidence.halfWidthPoints.toFixed(1)} points`);
  const ev = analysis.callEv;
  const evText = `${ev >= 0 ? '+' : '−'}${Math.abs(ev).toFixed(1)}`;
  return [
    `You chose to ${action}.`,
    'This one is not marked. There is no right answer recorded for a decision, only an analysis ' +
      'and the assumptions it rests on.',
    '',
    `Against the stated range (${method}): your equity is ${percent(analysis.heroEquity)}, and ` +
      `calling needs ${percent(analysis.breakEvenEquity)}. Calling is worth ${evText} units on ` +
      'average, measured against folding, which is worth 0.',
    '',
    'Assumptions:',
    ...assumptions.map((assumption) => `- ${assumption}`),
    '',
    question.explanation,
  ];
}

function onward(session: Session, phase: QuizPhase): StepResult {
  const quiz = quizOf(phase);
  if (phase.position + 1 < quiz.questions.length) {
    const next: QuizPhase = { ...phase, position: phase.position + 1, stage: 'asking' };
    return {
      session: { ...session, phase: next, revision: session.revision + 1 },
      out: [questionMessage(next)],
    };
  }
  return {
    session: { ...session, phase: { kind: 'idle' }, revision: session.revision + 1 },
    out: [
      {
        kind: 'send',
        text: `That was the last of ${quiz.questions.length} questions in ${quiz.title}.\n\n${quiz.reviewAdvice}`,
        buttons: [[{ label: 'Another quiz', data: encodePress({ kind: 'quizzes' }) }, menuButton()]],
      },
    ],
  };
}
