/**
 * Lessons in a chat: the list in reading order, then each lesson as pages of plain text.
 *
 * ## A page is addressed, not stepped
 *
 * A lesson button names the lesson by id and the page it shows (`lp:<id>:<page>`), never "the
 * next one". A lesson is content that does not change while the process runs, so a press is
 * answered from its own data and touches no session. Next pressed twice shows the same page twice,
 * which Telegram refuses as "message is not modified" and the adapter treats as delivered, and Next
 * on an older lesson message pages that message, which is the one the reader pressed. A quiz needs
 * a run tag (`QuizMoment`) because answering changes the session; reading does not. What a deploy
 * can make stale is a lesson or page that no longer exists, and that is `GONE`.
 *
 * ## Pages
 *
 * A page breaks at a heading where it can, and fills to `PAGE_FILL` before it does, so a phone
 * screen holds a section or two rather than a single sentence or the whole lesson. No page body
 * exceeds `PAGE_BUDGET`, far under `MESSAGE_LIMIT`: Next and Previous are edits, and an edit is not
 * split for Telegram the way a send is. A block is cut only when it alone exceeds the budget, and
 * then at a line, then a sentence, then a word. The key takeaways are a page of their own, last.
 *
 * ## Between hands
 *
 * Every lesson press waits for a live hand to end, as a quiz does (`FINISH_HAND_FIRST`), so the
 * reader in a hand has one thing in front of them to answer.
 */

import { glossaryEntriesFor, lessonById, lessonsInReadingOrder, quizForLesson } from '@prl/content';
import type { Lesson, LessonBlock } from '@prl/contracts';
import { calculate, figureLine } from './learn.ts';
import { GONE } from './quiz.ts';
import type { Session, StepResult } from './step.ts';
import { type Button, encodePress, inPairs, termButton } from './view.ts';

export const FINISH_HAND_FIRST_LESSON = 'Finish this hand first, then read a lesson.';

export const PAGE_BUDGET = 1_800;
/** A page shorter than this takes the next section too, when the whole section still fits. */
const PAGE_FILL = 1_200;
const LIST_PAGE_SIZE = 6;
const BETWEEN_BLOCKS = '\n\n';

/** `MARKERS` in `packages/ui/src/components/Callout.tsx`: the tone is a word, never a colour alone. */
const CALLOUT_WORDS: Readonly<Record<Extract<LessonBlock, { kind: 'callout' }>['tone'], string>> = {
  insight: 'Insight',
  warning: 'Watch out',
  misconception: 'Common misconception',
};

function toast(session: Session, text: string): StepResult {
  return { session, out: [{ kind: 'toast', text }] };
}

function menuButton(): Button {
  return { label: 'Menu', data: encodePress({ kind: 'menu' }) };
}

// ---------------------------------------------------------------------------
// Blocks as text
// ---------------------------------------------------------------------------

function calculationText(block: Extract<LessonBlock, { kind: 'liveCalculation' }>): string {
  const computed = calculate(block.calculation);
  return [
    `Computed here: ${block.caption}`,
    ...Object.values(computed.figures)
      .filter((figure) => figure.input !== true)
      .map((figure) => `• ${figureLine(figure)}`),
    `Method: ${computed.method}`,
    `Working: ${computed.working}`,
  ].join('\n');
}

/**
 * One block as plain text.
 *
 * A heading is in capitals. Telegram's font is proportional, so a rule drawn under a heading never
 * matches its width, and a screen reader announces each rule character; capitals survive any
 * client, copy and paste, and need no glyph a reader has to hear.
 */
export function blockText(block: LessonBlock): string {
  switch (block.kind) {
    case 'prose':
      return block.text;
    case 'heading':
      return block.text.toLocaleUpperCase('en-GB');
    case 'list':
      return block.items
        .map((item, index) => (block.ordered ? `${index + 1}. ${item}` : `• ${item}`))
        .join('\n');
    case 'formula':
      return `Formula: ${block.expression}\n${block.explanation}`;
    case 'callout':
      return `${CALLOUT_WORDS[block.tone]}: ${block.title}\n${block.text}`;
    case 'liveCalculation':
      return calculationText(block);
    case 'scenarioLink':
      // No address: the web origin is a deployment setting (`PUBLIC_WEB_ORIGIN`), not a constant
      // this process knows, and a guessed link is worse than none.
      return `In the Scenario Lab, on the web: ${block.prompt}`;
    default: {
      const unreachable: never = block;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const CUTS: readonly { readonly split: RegExp; readonly join: string }[] = [
  { split: /\n/, join: '\n' },
  { split: /(?<=[.!?])\s+/, join: ' ' },
  { split: / /, join: ' ' },
];

/** `text` in pieces of at most `budget`, cut at the coarsest boundary that gets there. */
function cut(text: string, budget: number, level = 0): string[] {
  if (text.length <= budget) return [text];
  const at = CUTS[level];
  if (at === undefined) {
    return Array.from({ length: Math.ceil(text.length / budget) }, (_, index) =>
      text.slice(index * budget, (index + 1) * budget),
    );
  }
  const pieces: string[] = [];
  let current = '';
  for (const part of text.split(at.split)) {
    for (const piece of cut(part, budget, level + 1)) {
      const joined = current === '' ? piece : `${current}${at.join}${piece}`;
      if (joined.length <= budget) {
        current = joined;
      } else {
        pieces.push(current);
        current = piece;
      }
    }
  }
  if (current !== '') pieces.push(current);
  return pieces;
}

/** Blocks grouped so that each heading starts a section. */
function sections(blocks: readonly LessonBlock[]): string[][] {
  const out: string[][] = [];
  for (const block of blocks) {
    if (block.kind === 'heading' || out.length === 0) out.push([]);
    out[out.length - 1]?.push(blockText(block));
  }
  return out;
}

function length(parts: readonly string[]): number {
  return parts.join(BETWEEN_BLOCKS).length;
}

/** The lesson's blocks as page bodies, each at most `budget` characters. Takeaways not included. */
export function paginate(blocks: readonly LessonBlock[], budget = PAGE_BUDGET): string[] {
  const pages: string[] = [];
  let page: string[] = [];
  const flush = (): void => {
    if (page.length > 0) pages.push(page.join(BETWEEN_BLOCKS));
    page = [];
  };
  for (const section of sections(blocks)) {
    if (page.length > 0 && (length(page) >= PAGE_FILL || length([...page, ...section]) > budget)) flush();
    for (const text of section) {
      for (const piece of cut(text, budget)) {
        if (page.length > 0 && length([...page, piece]) > budget) flush();
        page.push(piece);
      }
    }
  }
  flush();
  return pages;
}

function takeawaysPage(lesson: Lesson): string {
  return ['KEY TAKEAWAYS', lesson.keyTakeaways.map((line) => `• ${line}`).join('\n')].join(BETWEEN_BLOCKS);
}

const pageCache = new Map<string, readonly string[]>();

/** Every page body of a lesson, the key takeaways last. */
export function lessonPages(lesson: Lesson): readonly string[] {
  const cached = pageCache.get(lesson.id);
  if (cached !== undefined) return cached;
  const pages = [...paginate(lesson.blocks), takeawaysPage(lesson)];
  pageCache.set(lesson.id, pages);
  return pages;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function listPageCount(): number {
  return Math.ceil(lessonsInReadingOrder().length / LIST_PAGE_SIZE);
}

function listPageOf(lesson: Lesson): number {
  return Math.floor(lessonsInReadingOrder().indexOf(lesson) / LIST_PAGE_SIZE);
}

export function onLessons(session: Session, page: number): StepResult {
  if (session.phase.kind === 'deciding') return toast(session, FINISH_HAND_FIRST_LESSON);
  const all = lessonsInReadingOrder();
  if (page >= listPageCount()) return toast(session, GONE);
  const first = page * LIST_PAGE_SIZE;
  const shown = all.slice(first, first + LIST_PAGE_SIZE);
  const entries = shown.map(
    (lesson, offset) =>
      `${first + offset + 1}. ${lesson.title} · ${lesson.estimatedMinutes} min\n${lesson.summary}`,
  );
  const nav: Button[] = [];
  if (page > 0)
    nav.push({ label: 'Earlier lessons', data: encodePress({ kind: 'lessons', page: page - 1 }) });
  if (page + 1 < listPageCount())
    nav.push({ label: 'More lessons', data: encodePress({ kind: 'lessons', page: page + 1 }) });
  return {
    session,
    out: [
      {
        kind: 'send',
        text: [
          `Read a lesson. Lessons ${first + 1} to ${first + shown.length} of ${all.length}, in reading ` +
            'order: each builds on the ones before it.',
          ...entries,
        ].join(BETWEEN_BLOCKS),
        buttons: [
          ...shown.map((lesson, offset) => [
            {
              label: `${first + offset + 1}. ${lesson.title}`,
              data: encodePress({ kind: 'lesson', lessonId: lesson.id }),
            },
          ]),
          [...nav, menuButton()],
        ],
      },
    ],
  };
}

/** Opens a lesson at its first page, as a new message. */
export function onLesson(session: Session, lessonId: string): StepResult {
  return showPage(session, lessonId, 0, 'send');
}

/** Another page of the lesson, in the message that was pressed. */
export function onLessonPage(session: Session, lessonId: string, page: number): StepResult {
  return showPage(session, lessonId, page, 'edit');
}

function showPage(session: Session, lessonId: string, page: number, how: 'send' | 'edit'): StepResult {
  if (session.phase.kind === 'deciding') return toast(session, FINISH_HAND_FIRST_LESSON);
  const lesson = lessonById(lessonId);
  if (lesson === null) return toast(session, GONE);
  const pages = lessonPages(lesson);
  const body = pages[page];
  if (body === undefined) return toast(session, GONE);
  const text = [
    `${lesson.title}\nPage ${page + 1} of ${pages.length} · ${lesson.estimatedMinutes} min read`,
    body,
  ].join(BETWEEN_BLOCKS);
  return { session, out: [{ kind: how, text, buttons: pageButtons(lesson, page, pages.length) }] };
}

function pageButtons(lesson: Lesson, page: number, count: number): Button[][] {
  const to = (target: number, label: string): Button => ({
    label,
    data: encodePress({ kind: 'lessonPage', lessonId: lesson.id, page: target }),
  });
  const previous = page > 0 ? [to(page - 1, 'Previous')] : [];
  const allLessons: Button = {
    label: 'All lessons',
    data: encodePress({ kind: 'lessons', page: listPageOf(lesson) }),
  };
  if (page + 1 < count)
    return [
      [...previous, to(page + 1, 'Next')],
      [allLessons, menuButton()],
    ];

  const rows: Button[][] = [];
  const quiz = quizForLesson(lesson.id);
  if (quiz !== null) {
    rows.push([
      { label: 'Practise this lesson’s quiz', data: encodePress({ kind: 'quiz', quizId: quiz.id }) },
    ]);
  }
  rows.push(...inPairs(glossaryEntriesFor(lesson.glossaryTerms).map(termButton)));
  const order = lessonsInReadingOrder();
  const next = order[order.indexOf(lesson) + 1];
  if (next !== undefined) {
    rows.push([
      { label: `Next lesson: ${next.title}`, data: encodePress({ kind: 'lesson', lessonId: next.id }) },
    ]);
  }
  rows.push([...previous, allLessons, menuButton()]);
  return rows;
}
