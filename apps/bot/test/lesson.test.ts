import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lessonById, lessonsInReadingOrder, quizForLesson } from '@prl/content';
import type { Lesson, LessonBlock } from '@prl/contracts';
import { calculate } from '../src/learn.ts';
import { FINISH_HAND_FIRST_LESSON, lessonPages, PAGE_BUDGET, paginate } from '../src/lesson.ts';
import { GONE } from '../src/quiz.ts';
import { type Deps, NEW_SESSION, type Session, type StepResult, step } from '../src/step.ts';
import { MESSAGE_LIMIT } from '../src/telegram.ts';
import { type Button, CALLBACK_DATA_MAX_BYTES, decodePress, encodePress, type Press } from '../src/view.ts';
import { buttonsOf, find, message, press, testDeps } from './helpers.ts';

const LESSON_COUNT = 17;

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-GB');
}

/** The text a block is made of, as the content states it. */
function fragmentsOf(block: LessonBlock): string[] {
  switch (block.kind) {
    case 'prose':
    case 'heading':
      return [block.text];
    case 'list':
      return [...block.items];
    case 'formula':
      return [block.expression, block.explanation];
    case 'callout':
      return [block.title, block.text];
    case 'liveCalculation':
      return [block.caption];
    case 'scenarioLink':
      return [block.prompt];
  }
}

function command(session: Session, name: string, deps: Deps): StepResult {
  return step(session, { kind: 'command', name, args: '' }, deps);
}

function data(pressed: Press): Button {
  return { label: pressed.kind, data: encodePress(pressed) };
}

/** Opens a lesson the way a reader does: the menu, Read a lesson, More lessons, then its title. */
function openByMenu(lesson: Lesson, deps: Deps): StepResult {
  const menu = command(NEW_SESSION, 'start', deps);
  let list = press(menu.session, find(buttonsOf(menu), /^Read a lesson$/), deps);
  const position = lessonsInReadingOrder().indexOf(lesson) + 1;
  const label = new RegExp(`^${position}\\. `);
  while (!buttonsOf(list).some((button) => label.test(button.label))) {
    list = press(list.session, find(buttonsOf(list), /^More lessons$/), deps);
  }
  return press(list.session, find(buttonsOf(list), label), deps);
}

describe('every lesson as pages', () => {
  test('all 17 lessons render: every page fits, none is empty, none ends on a heading, and every block is on a page', () => {
    const lessons = lessonsInReadingOrder();
    assert.equal(lessons.length, LESSON_COUNT, 'a sweep of nothing is not a pass');
    let blocks = 0;
    for (const lesson of lessons) {
      const pages = lessonPages(lesson);
      assert.ok(pages.length >= 2, `${lesson.id}: at least one page of blocks and the takeaways`);
      for (const [index, page] of pages.entries()) {
        assert.ok(page.trim().length > 0, `${lesson.id} page ${index + 1} is empty`);
        assert.ok(page.length <= PAGE_BUDGET, `${lesson.id} page ${index + 1} is ${page.length} characters`);
        const last = page.split('\n\n').at(-1) ?? '';
        const headings = lesson.blocks.filter((block) => block.kind === 'heading');
        assert.ok(
          !headings.some((heading) => normalise(heading.text) === normalise(last)),
          `${lesson.id} page ${index + 1} ends on its heading "${last}"`,
        );
      }
      const all = normalise(pages.join(' '));
      for (const block of lesson.blocks) {
        blocks += 1;
        for (const fragment of fragmentsOf(block)) {
          assert.ok(
            all.includes(normalise(fragment)),
            `${lesson.id}: "${fragment.slice(0, 60)}" is on no page`,
          );
        }
      }
      for (const takeaway of lesson.keyTakeaways) {
        assert.ok(normalise(pages.at(-1) ?? '').includes(normalise(takeaway)), `${lesson.id}: a takeaway`);
      }
    }
    assert.ok(blocks > LESSON_COUNT, `read ${blocks} blocks`);
  });

  test('every page as sent fits a Telegram message whole, because Next and Previous are edits', () => {
    const deps = testDeps(1);
    let checked = 0;
    for (const lesson of lessonsInReadingOrder()) {
      const pages = lessonPages(lesson);
      for (let page = 0; page < pages.length; page += 1) {
        const shown = message(
          press(NEW_SESSION, data({ kind: 'lessonPage', lessonId: lesson.id, page }), deps),
        );
        assert.equal(shown.kind, 'edit');
        assert.ok(shown.text.length <= MESSAGE_LIMIT, `${lesson.id} page ${page + 1}: ${shown.text.length}`);
        assert.ok(
          shown.text.includes(`Page ${page + 1} of ${pages.length}`),
          `${lesson.id} page ${page + 1}`,
        );
        checked += 1;
      }
    }
    assert.ok(checked > LESSON_COUNT, `checked ${checked} pages`);
  });

  test('a block longer than a page is cut at sentences, and short sections share a page up to a heading', () => {
    const sentence = 'Every bet you face is a price, and the price is arithmetic on chips you can see. ';
    const long = sentence.repeat(Math.ceil((PAGE_BUDGET * 2.5) / sentence.length)).trim();
    const cut = paginate([{ kind: 'prose', text: long }]);
    assert.ok(cut.length >= 3, `${cut.length} pages`);
    for (const page of cut) {
      assert.ok(page.length <= PAGE_BUDGET, `${page.length} characters`);
      assert.ok(page.endsWith('see.'), 'cut between sentences');
    }
    assert.equal(normalise(cut.join(' ')), normalise(long));

    const prose = (length: number): LessonBlock => ({ kind: 'prose', text: 'x'.repeat(length) });
    const pages = paginate([
      prose(300),
      { kind: 'heading', text: 'First' },
      prose(500),
      { kind: 'heading', text: 'Second' },
      prose(900),
      { kind: 'heading', text: 'Third' },
      prose(300),
    ]);
    assert.equal(pages.length, 2);
    assert.match(pages[0] ?? '', /SECOND/, 'a short page takes the next section while it fits');
    assert.match(pages[1] ?? '', /^THIRD\n/, 'and breaks at a heading once it is full');
  });
});

describe('live calculations', () => {
  test('every live calculation in every lesson computes, with a method and at least one finite result', () => {
    let calculations = 0;
    for (const lesson of lessonsInReadingOrder()) {
      for (const block of lesson.blocks) {
        if (block.kind !== 'liveCalculation') continue;
        calculations += 1;
        const computed = calculate(block.calculation);
        const results = Object.values(computed.figures).filter((figure) => figure.input !== true);
        assert.ok(results.length > 0, `${lesson.id} ${block.calculation.kind}: no figure`);
        for (const figure of Object.values(computed.figures)) {
          assert.ok(Number.isFinite(figure.value), `${lesson.id} ${figure.label} is ${figure.value}`);
        }
        assert.ok(computed.method.length > 0 && computed.working.length > 0, `${lesson.id}: method`);
        assert.doesNotMatch(computed.method, /Sampled/, `${lesson.id}: every lesson figure is exact`);
      }
    }
    assert.ok(calculations > LESSON_COUNT, `computed ${calculations} calculations`);
  });

  test('the figures a caption asks about are shown: every player in a three-way all-in, and the exact figure beside the shortcut', () => {
    const allIns = lessonById('all-ins-and-side-pots');
    assert.ok(allIns);
    const page = lessonPages(allIns).find((text) => text.includes('Equity of K♠ K♥'));
    assert.ok(page, 'the all-in lesson names each player');
    assert.match(page, /Your equity: \d+\.\d%/);
    assert.match(page, /Equity of 7♣ 7♦: \d+\.\d%/);
    const shortcut = lessonById('rule-of-2-and-4');
    assert.ok(shortcut);
    const pages = lessonPages(shortcut).join('\n');
    assert.match(
      pages,
      /Rule-of-thumb estimate: 18\.0%\n• Exact chance of hitting, from 46 unseen cards: 19\.6%/,
    );
  });

  test('text the bot writes around a calculation never claims to be right', () => {
    let read = 0;
    for (const lesson of lessonsInReadingOrder()) {
      for (const block of lesson.blocks) {
        if (block.kind !== 'liveCalculation') continue;
        const computed = calculate(block.calculation);
        for (const words of [
          computed.method,
          ...Object.values(computed.figures).map((figure) => figure.label),
        ]) {
          read += 1;
          assert.doesNotMatch(words, /\b(correct|optimal|best|GTO)\b/i, `${lesson.id}: "${words}"`);
        }
      }
    }
    assert.ok(read > 0);
  });
});

describe('callback data', () => {
  test('every lesson, page and list page encodes within 64 bytes and decodes to the same press', () => {
    const lessons = lessonsInReadingOrder();
    assert.equal(lessons.length, LESSON_COUNT);
    const longest = lessons.reduce((top, lesson) => (lesson.id.length > top.id.length ? lesson : top));
    assert.equal(longest.id, 'sample-size-and-risk-of-ruin');
    const presses: Press[] = [
      { kind: 'lessons', page: 0 },
      { kind: 'lessons', page: 2 },
    ];
    for (const lesson of lessons) {
      presses.push({ kind: 'lesson', lessonId: lesson.id });
      for (let page = 0; page < lessonPages(lesson).length; page += 1) {
        presses.push({ kind: 'lessonPage', lessonId: lesson.id, page });
      }
    }
    // The decoder's own ceiling, so a longer id added later fails here rather than at a reader's press.
    presses.push({ kind: 'lessonPage', lessonId: 'x'.repeat(57), page: 99 });
    for (const pressed of presses) {
      const wire = encodePress(pressed);
      assert.ok(Buffer.byteLength(wire, 'utf8') <= CALLBACK_DATA_MAX_BYTES, `"${wire}"`);
      assert.deepEqual(decodePress(wire), pressed);
    }
    assert.ok(presses.length > LESSON_COUNT * 2, `checked ${presses.length} presses`);
    assert.equal(decodePress(`lp:${'x'.repeat(58)}:1`), null, 'one past the ceiling is not ours');
  });
});

describe('reading a lesson through step', () => {
  test('menu, every page with Next, the last page, then Practise this lesson’s quiz starts that quiz, for every lesson', () => {
    const deps = testDeps(2);
    let lessons = 0;
    for (const lesson of lessonsInReadingOrder()) {
      const quiz = quizForLesson(lesson.id);
      assert.ok(quiz, `${lesson.id} has a quiz`);
      let shown = openByMenu(lesson, deps);
      assert.equal(message(shown).kind, 'send', 'a lesson opens as a new message');
      const count = lessonPages(lesson).length;
      for (let page = 1; page < count; page += 1) {
        assert.match(message(shown).text, new RegExp(`^${literal(lesson.title)}\\nPage ${page} of ${count}`));
        shown = press(shown.session, find(buttonsOf(shown), /^Next$/), deps);
        assert.equal(message(shown).kind, 'edit', 'Next edits the page in place');
      }
      const last = message(shown);
      assert.match(last.text, new RegExp(`Page ${count} of ${count}`));
      assert.match(last.text, /KEY TAKEAWAYS/);
      assert.ok(!buttonsOf(shown).some((button) => button.label === 'Next'), 'no Next on the last page');
      for (const id of lesson.glossaryTerms) {
        assert.ok(
          buttonsOf(shown).some((button) => button.data === `g:${id}`),
          `${lesson.id}: a button for ${id}`,
        );
      }
      const started = press(shown.session, find(buttonsOf(shown), /^Practise this lesson’s quiz$/), deps);
      assert.equal(started.session.phase.kind, 'quiz');
      assert.match(message(started).text, new RegExp(`^${literal(quiz.title)} · Question 1 of `));
      lessons += 1;
    }
    assert.equal(lessons, LESSON_COUNT);
  });

  test('Next lesson follows the reading order, and /learn opens the list', () => {
    const deps = testDeps(3);
    const order = lessonsInReadingOrder();
    const [first, second] = order;
    assert.ok(first && second);
    const lastPage = lessonPages(first).length - 1;
    const end = press(NEW_SESSION, data({ kind: 'lessonPage', lessonId: first.id, page: lastPage }), deps);
    const next = press(end.session, find(buttonsOf(end), /^Next lesson: /), deps);
    assert.match(message(next).text, new RegExp(`^${literal(second.title)}\\nPage 1 of`));
    const list = message(command(NEW_SESSION, 'learn', deps));
    assert.match(list.text, /^Read a lesson\. Lessons 1 to 6 of 17, in reading order/);
    assert.equal(list.buttons.flat().filter((button) => /^\d+\. /.test(button.label)).length, 6);
    const lastFinal = order.at(-1);
    assert.ok(lastFinal);
    const final = press(
      NEW_SESSION,
      data({ kind: 'lessonPage', lessonId: lastFinal.id, page: lessonPages(lastFinal).length - 1 }),
      deps,
    );
    assert.ok(!buttonsOf(final).some((button) => /^Next lesson/.test(button.label)), 'none after the last');
  });

  test('a double press and an older lesson’s button show the page they name, and change nothing', () => {
    const deps = testDeps(4);
    const [first, second] = lessonsInReadingOrder();
    assert.ok(first && second);
    const opened = press(NEW_SESSION, data({ kind: 'lesson', lessonId: first.id }), deps);
    const next = find(buttonsOf(opened), /^Next$/);
    const once = press(opened.session, next, deps);
    const twice = press(once.session, next, deps);
    assert.equal(once.session, opened.session, 'reading touches no session');
    assert.equal(twice.session, opened.session);
    assert.deepEqual(twice.out, once.out, 'the second press converges on the same page');

    const other = press(once.session, data({ kind: 'lesson', lessonId: second.id }), deps);
    const back = press(other.session, find(buttonsOf(once), /^Previous$/), deps);
    assert.match(message(back).text, new RegExp(`^${literal(first.title)}\\nPage 1 of`));
  });

  test('a lesson or page that no longer exists, and a list page past the end, are a toast', () => {
    const deps = testDeps(5);
    const [first] = lessonsInReadingOrder();
    assert.ok(first);
    for (const wire of ['lo:no-such-lesson', `lp:${first.id}:${lessonPages(first).length}`, 'll:9']) {
      const refused = step(NEW_SESSION, { kind: 'button', data: wire }, deps);
      assert.equal(refused.session, NEW_SESSION, wire);
      assert.deepEqual(refused.out, [{ kind: 'toast', text: GONE }], wire);
    }
  });

  test('a lesson waits for the hand to end, and /learn mid-hand gets a reply rather than a toast nobody sees', () => {
    const deps = testDeps(6);
    const menu = command(NEW_SESSION, 'start', deps);
    const hand = press(menu.session, find(buttonsOf(menu), /^Play a hand$/), deps);
    assert.equal(hand.session.phase.kind, 'deciding');
    const [first] = lessonsInReadingOrder();
    assert.ok(first);
    for (const pressed of [
      { kind: 'lessons', page: 0 },
      { kind: 'lesson', lessonId: first.id },
      { kind: 'lessonPage', lessonId: first.id, page: 1 },
    ] satisfies Press[]) {
      const refused = press(hand.session, data(pressed), deps);
      assert.equal(refused.session, hand.session, pressed.kind);
      assert.deepEqual(refused.out, [{ kind: 'toast', text: FINISH_HAND_FIRST_LESSON }], pressed.kind);
    }
    const typed = command(hand.session, 'learn', deps);
    assert.equal(typed.session, hand.session);
    assert.deepEqual(typed.out, [{ kind: 'send', text: FINISH_HAND_FIRST_LESSON, buttons: [] }]);
  });
});

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
