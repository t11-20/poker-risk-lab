import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { quizzes } from '@prl/content';
import { type Quiz, type QuizQuestion, withinTolerance } from '@prl/contracts';
import {
  decisionSpot,
  expectedAnswer,
  type NumericQuestion,
  parseNumber,
  quizTopics,
  topicLabel,
} from '../src/learn.ts';
import { FINISH_HAND_FIRST, QUIZ_STALE } from '../src/quiz.ts';
import { type Deps, NEW_SESSION, type Session, type StepResult, step } from '../src/step.ts';
import { MESSAGE_LIMIT } from '../src/telegram.ts';
import { type Button, CALLBACK_DATA_MAX_BYTES } from '../src/view.ts';
import { buttonsOf, find, message, press, testDeps } from './helpers.ts';

/**
 * Run tags at the decoder's own 24-character ceiling, so every byte count measured here is the
 * worst case a run can produce. Production tags are 8.
 */
function longTagDeps(): Deps {
  let runs = 0;
  return {
    ...testDeps(1),
    newTag: () => {
      runs += 1;
      return String(runs).padStart(24, 'r');
    },
  };
}

function text(session: Session, body: string, deps: Deps): StepResult {
  return step(session, { kind: 'text', text: body }, deps);
}

function allButtons(result: StepResult): Button[] {
  return result.out.flatMap((out) => (out.kind === 'toast' ? [] : out.buttons.flat()));
}

function assertFits(result: StepResult, seen: { count: number }): void {
  for (const out of result.out) {
    // An edit is not split for Telegram the way a send is (`splitForChat`), so it has to fit whole.
    if (out.kind !== 'toast')
      assert.ok(out.text.length <= MESSAGE_LIMIT, `a ${out.text.length}-character ${out.kind}`);
  }
  for (const button of allButtons(result)) {
    seen.count += 1;
    const bytes = Buffer.byteLength(button.data, 'utf8');
    assert.ok(bytes <= CALLBACK_DATA_MAX_BYTES, `"${button.data}" is ${bytes} bytes`);
  }
}

/** Reaches a quiz the way a reader does: menu, Practise a quiz, its topic, then its title if asked. */
function startByMenu(quiz: Quiz, deps: Deps, seen: { count: number }): StepResult {
  const menu = step(NEW_SESSION, { kind: 'command', name: 'start', args: '' }, deps);
  const topics = press(menu.session, find(buttonsOf(menu), /^Practise a quiz$/), deps);
  assertFits(topics, seen);
  const label = new RegExp(`^${topicLabel(quiz.topic)}$`);
  const topic = press(topics.session, find(buttonsOf(topics), label), deps);
  assertFits(topic, seen);
  if (topic.session.phase.kind === 'quiz') return topic;
  const title = buttonsOf(topic).find((button) => button.label.startsWith(`${quiz.title} (`));
  assert.ok(title, `the ${quiz.topic} list offers ${quiz.title}`);
  return press(topic.session, title, deps);
}

/** The lesson's answer for a question that has one, as the event a reader would send. */
function answerTheLessonsWay(asked: StepResult, question: QuizQuestion, deps: Deps): StepResult {
  if (question.kind === 'multipleChoice') {
    return press(
      asked.session,
      find(buttonsOf(asked), new RegExp(`^${'ABCDEFGHIJ'[question.correctIndex]}$`)),
      deps,
    );
  }
  if (question.kind === 'numeric') return text(asked.session, String(expectedAnswer(question).value), deps);
  return press(asked.session, find(buttonsOf(asked), /^Call$/), deps);
}

function answerAnotherWay(asked: StepResult, question: QuizQuestion, deps: Deps): StepResult {
  if (question.kind === 'multipleChoice') {
    const wrong = (question.correctIndex + 1) % question.options.length;
    return press(asked.session, find(buttonsOf(asked), new RegExp(`^${'ABCDEFGHIJ'[wrong]}$`)), deps);
  }
  if (question.kind === 'numeric') {
    const expected = expectedAnswer(question);
    return text(asked.session, String(expected.value + 2 * expected.tolerance + 1), deps);
  }
  return press(asked.session, find(buttonsOf(asked), /^Fold$/), deps);
}

const VERDICT = {
  multipleChoice: {
    lessons: /That matches the answer this lesson gives/,
    other: /That is not the answer this lesson gives, which is [A-J]\./,
  },
  numeric: { lessons: /is within the tolerance of/, other: /is outside the tolerance of/ },
  decision: {
    lessons: /You chose to call\.\nThis one is not marked/,
    other: /You chose to fold\.\nThis one is not marked/,
  },
} as const;

describe('every question through step', () => {
  test('all 81 questions are presented, answered the lesson’s way and another way, with the explanation each time', () => {
    const deps = longTagDeps();
    const all = quizzes();
    const expectedQuestions = all.reduce((sum, quiz) => sum + quiz.questions.length, 0);
    assert.ok(all.length > 0 && expectedQuestions > 0, 'a sweep of nothing is not a pass');
    const seen = { count: 0 };
    const kinds = { multipleChoice: 0, numeric: 0, decision: 0 };
    let questionsRead = 0;
    for (const quiz of all) {
      let asked = startByMenu(quiz, deps, seen);
      for (const [position, question] of quiz.questions.entries()) {
        assertFits(asked, seen);
        const shown = message(asked);
        assert.equal(shown.kind, 'send');
        assert.ok(shown.text.includes(question.prompt), `${question.id}: the prompt is shown`);
        assert.ok(
          shown.text.includes(`Question ${position + 1} of ${quiz.questions.length}`),
          `${question.id}: wayfinding`,
        );
        if (question.kind === 'multipleChoice') {
          for (const option of question.options)
            assert.ok(shown.text.includes(option), `${question.id}: an option is missing`);
        }

        const other = answerAnotherWay(asked, question, deps);
        assert.match(message(other).text, VERDICT[question.kind].other, `${question.id}: another answer`);
        assert.ok(
          message(other).text.includes(question.explanation),
          `${question.id}: explained when it misses`,
        );

        const lessons = answerTheLessonsWay(asked, question, deps);
        assertFits(lessons, seen);
        const verdict = message(lessons);
        assert.equal(
          verdict.kind,
          question.kind === 'numeric' ? 'send' : 'edit',
          `${question.id}: a typed answer has nothing to edit`,
        );
        assert.match(verdict.text, VERDICT[question.kind].lessons, `${question.id}: the lesson's answer`);
        assert.ok(verdict.text.includes(question.explanation), `${question.id}: explained`);

        kinds[question.kind] += 1;
        questionsRead += 1;
        asked = press(lessons.session, find(buttonsOf(lessons), /^(Next question|Finish)$/), deps);
      }
      const end = message(asked);
      assert.ok(end.text.includes(quiz.reviewAdvice), `${quiz.id}: ends with its review advice`);
      // The advice is content and may say "there is no score here"; what this client adds may not count.
      const own = end.text.replace(quiz.reviewAdvice, '');
      assert.doesNotMatch(
        own,
        /\d+\s*(?:\/|of|out of)\s*\d+\s*(?:correct|right|matched)|score|%/i,
        'no tally',
      );
      assert.equal(asked.session.phase.kind, 'idle', `${quiz.id}: the run is over`);
    }
    assert.equal(questionsRead, expectedQuestions);
    assert.equal(questionsRead, 81, 'the shipped content has 81 questions');
    assert.ok(kinds.multipleChoice > 0 && kinds.numeric > 0 && kinds.decision > 0, JSON.stringify(kinds));
    assert.ok(seen.count > 81 * 2, `${seen.count} buttons measured`);
  });

  test('every topic with a quiz is offered, and only those', () => {
    const topics = quizTopics();
    assert.ok(topics.length > 0);
    for (const quiz of quizzes()) assert.ok(topics.includes(quiz.topic), `${quiz.topic} offered`);
    for (const topic of topics) assert.ok(quizzes().some((quiz) => quiz.topic === topic));
  });
});

function numericQuestions(): NumericQuestion[] {
  const found = quizzes().flatMap((quiz) =>
    quiz.questions.filter((question): question is NumericQuestion => question.kind === 'numeric'),
  );
  assert.ok(found.length > 0, 'a sweep of nothing is not a pass');
  return found;
}

/** Steps a session to the given numeric question's asking stage. */
function askedFor(question: NumericQuestion, deps: Deps): StepResult {
  const quiz = quizzes().find((candidate) => candidate.questions.includes(question)) as Quiz;
  let current = step(NEW_SESSION, { kind: 'button', data: `qs:${quiz.id}` }, deps);
  for (const earlier of quiz.questions) {
    if (earlier === question) return current;
    const answered = answerTheLessonsWay(current, earlier, deps);
    current = press(answered.session, find(buttonsOf(answered), /^Next question$/), deps);
  }
  throw new Error(`${question.id} not found`);
}

describe('numeric tolerance', () => {
  test('an answer at the edge of tolerance is accepted, and just outside it is refused, for every numeric question', () => {
    const deps = testDeps(2);
    for (const question of numericQuestions()) {
      const expected = expectedAnswer(question);
      const asked = askedFor(question, deps);
      const outside = expected.tolerance * 1.001 + 1e-9;
      for (const [offset, verdict] of [
        [expected.tolerance, /is within the tolerance/],
        [-expected.tolerance, /is within the tolerance/],
        [outside, /is outside the tolerance/],
        [-outside, /is outside the tolerance/],
      ] as const) {
        const typed = String(expected.value + offset);
        assert.match(
          message(text(asked.session, typed, deps)).text,
          verdict,
          `${question.id}: ${typed} against ${expected.value}`,
        );
      }
    }
  });

  test('the edge is the stated tolerance, not one ulp inside it: the cases quiz-tolerance.ts names', () => {
    // `apps/web/src/lib/quiz-tolerance.ts` lists these as refused by a plain `<=`. The bot uses its
    // rule, so each must be accepted; the first assertion shows the plain rule really refuses them.
    for (const [answer, value] of [
      [3.2, 3.0],
      [2.2, 2.0],
      [4.2, 4.0],
    ] as const) {
      assert.ok(Math.abs(answer - value) > 0.2, `${answer} − ${value} overshoots 0.2 in binary`);
      assert.ok(withinTolerance(answer, { value, tolerance: 0.2 }));
      assert.ok(!withinTolerance(answer + 1e-9, { value, tolerance: 0.2 }));
    }
  });

  test('closed-form targets agree with arithmetic done here, not with the table under test', () => {
    let checked = 0;
    for (const question of numericQuestions()) {
      const c = question.calculation;
      const got = expectedAnswer(question).value;
      let want: number | null = null;
      if (c.kind === 'potOdds' && question.field === 'breakEvenEquity')
        want = (100 * c.toCall) / (c.pot + c.toCall);
      if (c.kind === 'potOdds' && question.field === 'oddsRatio') want = c.pot / c.toCall;
      if (c.kind === 'ruleOf24') want = c.outs * (c.cardsToCome === 2 ? 4 : 2);
      if (c.kind === 'callEv') want = c.equity * (c.pot + c.toCall) - c.toCall;
      if (c.kind === 'spr') want = c.effectiveStack / c.pot;
      if (want === null) continue;
      checked += 1;
      assert.ok(Math.abs(got - want) < 1e-9, `${question.id}: ${got} against ${want}`);
    }
    assert.ok(checked >= 10, `${checked} closed-form questions checked`);
  });

  test('a computed figure is what the reveal shows, at the unit’s decimals', () => {
    const deps = testDeps(3);
    const question = numericQuestions().find((candidate) => candidate.id === 'counting-outs-q4');
    assert.ok(question, 'counting-outs-q4 ships');
    const asked = askedFor(question, deps);
    const revealed = press(asked.session, find(buttonsOf(asked), /^Show the answer$/), deps);
    // 0.5 cards, not "1 cards": the defect apps/web/src/lib/quiz-tolerance.ts exists for.
    assert.match(message(revealed).text, /Anything within 0\.5 cards is accepted\./);
    assert.equal(message(revealed).kind, 'edit');
  });

  test('a typed reply is read as a number only when it plainly is one', () => {
    for (const [typed, value] of [
      ['33.3', 33.3],
      [' 33.3% ', 33.3],
      ['-12.5', -12.5],
      ['.5', 0.5],
      ['1,200', 1200],
      ['2.5 to 1', 2.5],
      ['9 cards', 9],
    ] as const) {
      assert.equal(parseNumber(typed), value, typed);
    }
    for (const typed of ['', 'about 30', '30 or 35', '1,2', 'thirty', '3.', '1e3', '12abc']) {
      assert.equal(parseNumber(typed), null, typed);
    }
  });

  test('every decision spot computes, from the content, without sampling', () => {
    const decisions = quizzes().flatMap((quiz) =>
      quiz.questions.filter((question) => question.kind === 'decision'),
    );
    assert.ok(decisions.length > 0);
    for (const question of decisions) {
      const spot = decisionSpot(question);
      assert.ok(spot.assumptions.length > 0, `${question.id} states its assumptions`);
      assert.equal(spot.analysis.equity.method, 'exact-enumeration');
    }
  });
});

describe('stale quiz presses', () => {
  const deps = testDeps(4);
  const quiz = quizzes()[0] as Quiz;
  const start = (): StepResult => step(NEW_SESSION, { kind: 'button', data: `qs:${quiz.id}` }, deps);

  test('a double press on an option applies once; the second is a toast and changes nothing', () => {
    const asked = start();
    const option = buttonsOf(asked)[0] as Button;
    const once = press(asked.session, option, deps);
    assert.ok(once.session.revision > asked.session.revision);
    const twice = press(once.session, option, deps);
    assert.equal(twice.session, once.session);
    assert.deepEqual(twice.out, [{ kind: 'toast', text: QUIZ_STALE }]);
  });

  test('an earlier question’s buttons, Next pressed twice, and a press from an earlier run are refused', () => {
    const asked = start();
    const option = buttonsOf(asked)[0] as Button;
    const answered = press(asked.session, option, deps);
    const next = find(buttonsOf(answered), /^Next question$/);
    const second = press(answered.session, next, deps);
    assert.equal(second.session.phase.kind === 'quiz' ? second.session.phase.position : -1, 1);
    for (const stale of [option, next]) {
      const refused = press(second.session, stale, deps);
      assert.equal(refused.session, second.session, `${stale.data} changed nothing`);
      assert.deepEqual(refused.out, [{ kind: 'toast', text: QUIZ_STALE }]);
    }
    const rerun = step(second.session, { kind: 'button', data: `qs:${quiz.id}` }, deps);
    const fromOldRun = press(rerun.session, option, deps);
    assert.equal(
      fromOldRun.session,
      rerun.session,
      'a new run of the same quiz does not take the old run’s press',
    );
    assert.deepEqual(fromOldRun.out, [{ kind: 'toast', text: QUIZ_STALE }]);
  });

  test('data this process did not write is refused without touching the session', () => {
    const asked = start();
    const phase = asked.session.phase;
    assert.equal(phase.kind, 'quiz');
    const run = phase.kind === 'quiz' ? phase.run : '';
    for (const data of [
      `qa:${run}:0:9`,
      `qd:${run}:0:c`,
      `qr:${run}:0`,
      `qa:${run}:7:0`,
      'qa::0:0',
      'qs:no-such-quiz',
      'qt:nope',
      'g:no-such-term',
    ]) {
      const refused = step(asked.session, { kind: 'button', data }, deps);
      assert.equal(refused.session, asked.session, `"${data}" changed nothing`);
      assert.equal(refused.out[0]?.kind, 'toast', `"${data}" is a toast`);
    }
  });
});

describe('a quiz and a hand do not share typed text', () => {
  test('a number typed during a hand is not an answer, and a quiz cannot start over a live hand', () => {
    const deps = testDeps(6);
    const quiz = quizzes()[0] as Quiz;
    const menu = step(NEW_SESSION, { kind: 'command', name: 'start', args: '' }, deps);
    const hand = press(menu.session, find(buttonsOf(menu), /^Play a hand$/), deps);
    assert.equal(hand.session.phase.kind, 'deciding');
    const typed = text(hand.session, '25', deps);
    assert.equal(typed.session, hand.session, 'the hand is untouched');
    assert.match(message(typed).text, /^Use the buttons/);
    const refused = step(hand.session, { kind: 'button', data: `qs:${quiz.id}` }, deps);
    assert.equal(refused.session, hand.session);
    assert.deepEqual(refused.out, [{ kind: 'toast', text: FINISH_HAND_FIRST }]);
  });

  test('a number typed on a multiple-choice question, or after answering, is not taken as an answer', () => {
    const deps = testDeps(8);
    const quiz = quizzes().find((candidate) => candidate.questions[0]?.kind === 'multipleChoice') as Quiz;
    const asked = step(NEW_SESSION, { kind: 'button', data: `qs:${quiz.id}` }, deps);
    const typed = text(asked.session, '1', deps);
    assert.equal(typed.session, asked.session);
    const numeric = numericQuestions()[0] as NumericQuestion;
    const ready = askedFor(numeric, deps);
    const once = text(ready.session, String(expectedAnswer(numeric).value), deps);
    const again = text(once.session, '0', deps);
    assert.equal(again.session, once.session, 'the answered question takes no second answer');
    assert.match(message(again).text, /^Use the buttons/);
  });

  test('text that is not a number, on a numeric question, says so and keeps the question open', () => {
    const deps = testDeps(9);
    const asked = askedFor(numericQuestions()[0] as NumericQuestion, deps);
    const typed = text(asked.session, 'about a third', deps);
    assert.equal(typed.session, asked.session);
    assert.match(message(typed).text, /not a number I can read/);
  });
});
