/**
 * Turns a list of lessons into a curriculum, and a lesson's headings into an outline. Pure functions.
 *
 * A number is a position down reading order (prerequisites, then difficulty, then the given order),
 * derived every time so it cannot go stale. The cards, the numbers and "Next" all follow that one order.
 * Reading order splits topics, so groups are runs of one difficulty and the topic is on each card.
 * `unlocked` is information only. Nothing may use it to disable a link.
 * `completed` on the wire cannot say "unknown", so `completionKnown` is required and `completed` and
 * `unlocked` are `boolean | null`. A screen must handle the unknown state to compile.
 */

import type { ContentId, Difficulty, LessonBlock, LessonSummary, Topic } from '@prl/contracts';
import { TOPIC_LABELS, TOPICS } from '@prl/contracts';

export const DIFFICULTY_LABELS: Readonly<Record<Difficulty, string>> = {
  intro: 'Intro',
  core: 'Core',
  advanced: 'Advanced',
};

/** A shape cue, so difficulty is not told apart by its word alone. One, two or three squares. */
export const DIFFICULTY_GLYPHS: Readonly<Record<Difficulty, string>> = {
  intro: '▪',
  core: '▪▪',
  advanced: '▪▪▪',
};

const DIFFICULTY_RANK: Readonly<Record<Difficulty, number>> = { intro: 0, core: 1, advanced: 2 };

/** The wire types topic and difficulty as `string`. These narrow them, `null` for an unknown value. */
export function asTopic(value: string): Topic | null {
  return (TOPICS as readonly string[]).includes(value) ? (value as Topic) : null;
}

export function asDifficulty(value: string): Difficulty | null {
  if (value === 'intro' || value === 'core' || value === 'advanced') return value;
  return null;
}

export function topicLabel(value: string): string {
  const topic = asTopic(value);
  return topic === null ? value : TOPIC_LABELS[topic];
}

export interface CurriculumEntry {
  /** 1-based. Rendered as `01`, `02`, … by `formatIndex`. */
  readonly position: number;
  readonly summary: LessonSummary;
  /** Resolved to summaries. An id not in the list is dropped, as a content defect, not a dead link. */
  readonly prerequisites: readonly LessonSummary[];
  /** `null` when completion is unknown. Read this, not `summary.completed`, which is `false` then. */
  readonly completed: boolean | null;
  /** Every prerequisite is marked read. Never used to disable anything. `null` when unknown. */
  readonly unlocked: boolean | null;
  /** Prerequisites not marked read. Empty when completion is unknown. */
  readonly outstandingPrerequisites: readonly LessonSummary[];
  /** True when the fixture or API has a body for this lesson, so the link is worth following. */
  readonly readable: boolean;
}

/** A consecutive run of reading order at one difficulty. */
export interface CurriculumGroup {
  /** Unique across the curriculum even if a difficulty recurs, so it can key a React list. */
  readonly key: string;
  readonly difficulty: string;
  readonly label: string;
  readonly entries: readonly CurriculumEntry[];
  readonly minutes: number;
}

export interface Curriculum {
  readonly groups: readonly CurriculumGroup[];
  readonly entries: readonly CurriculumEntry[];
  /**
   * The first unread lesson whose prerequisites are read, else the first unread, else `null`. With
   * completion unknown, the first lesson. `completionKnown` tells a screen which claim it prints.
   */
  readonly startHere: CurriculumEntry | null;
  readonly completionKnown: boolean;
  readonly totalMinutes: number;
  readonly lessonCount: number;
  /** Distinct topics across every lesson. Not `groups.length`: the groups are difficulty runs. */
  readonly topicCount: number;
}

/**
 * Prerequisites first, then difficulty, then the order given. Content validation rejects cycles, but a
 * fixture or API response could carry one, so `visiting` emits the lesson rather than overflow the stack.
 */
function readingOrder(summaries: readonly LessonSummary[]): readonly LessonSummary[] {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const emitted = new Set<ContentId>();
  const visiting = new Set<ContentId>();
  const out: LessonSummary[] = [];

  const emit = (summary: LessonSummary): void => {
    if (emitted.has(summary.id) || visiting.has(summary.id)) return;
    visiting.add(summary.id);
    for (const prerequisiteId of summary.prerequisites) {
      const prerequisite = byId.get(prerequisiteId);
      if (prerequisite !== undefined) emit(prerequisite);
    }
    visiting.delete(summary.id);
    emitted.add(summary.id);
    out.push(summary);
  };

  const sorted = [...summaries].sort((a, b) => {
    const left = asDifficulty(a.difficulty);
    const right = asDifficulty(b.difficulty);
    // An unknown difficulty sorts last. It is more likely new advanced material than a new intro.
    const leftRank = left === null ? DIFFICULTY_RANK.advanced + 1 : DIFFICULTY_RANK[left];
    const rightRank = right === null ? DIFFICULTY_RANK.advanced + 1 : DIFFICULTY_RANK[right];
    return leftRank - rightRank;
  });
  for (const summary of sorted) emit(summary);
  return out;
}

function groupLabel(difficulty: string): string {
  const known = asDifficulty(difficulty);
  return `${known === null ? difficulty : DIFFICULTY_LABELS[known]} lessons`;
}

export interface CurriculumOptions {
  /**
   * Lesson ids whose body this build can render. Pass it only when the list came from the bundled copy,
   * or the index warns readers off lessons the API serves (see `app/learn/page.tsx`).
   */
  readonly readableIds?: readonly ContentId[];
  /** Whether `completed` on these summaries is this reader's answer. Only the caller knows. */
  readonly completionKnown: boolean;
}

function chooseStartHere(
  entries: readonly CurriculumEntry[],
  completionKnown: boolean,
): CurriculumEntry | null {
  if (!completionKnown) return entries[0] ?? null;
  return (
    entries.find((entry) => !entry.summary.completed && entry.unlocked === true) ??
    entries.find((entry) => !entry.summary.completed) ??
    null
  );
}

/**
 * The sentence under "Start here". The prerequisite count is checked before `unlocked`, because a
 * lesson with no prerequisites is vacuously unlocked for a reader who has read nothing.
 */
export function startHereNote(start: CurriculumEntry): string {
  if (start.unlocked === null) {
    return start.prerequisites.length === 0
      ? 'This is the first lesson in the syllabus, not a suggestion based on what you have read — this page has no way to know that. It assumes nothing, so it is the safe place to start if you are new.'
      : 'This is the first lesson in the syllabus, not a suggestion based on what you have read — this page has no way to know that. What it assumes is listed on its card below.';
  }
  if (start.prerequisites.length === 0) {
    return 'This is the earliest lesson you have not marked read, and it assumes nothing, so you can start it straight away.';
  }
  return start.unlocked
    ? 'Everything this lesson assumes is already marked read.'
    : 'This is the earliest lesson in the syllabus you have not marked read. Its prerequisites are listed on its card below.';
}

interface EntryContext {
  readonly byId: ReadonlyMap<ContentId, LessonSummary>;
  /** Ids whose body the offline bundle carries, or null when nothing declared a limit. */
  readonly readable: ReadonlySet<ContentId> | null;
  readonly completionKnown: boolean;
}

/** One card's derived facts. The three-way completion rule is stated here and nowhere else. */
function buildEntry(summary: LessonSummary, position: number, context: EntryContext): CurriculumEntry {
  const { byId, readable, completionKnown } = context;
  const resolved: LessonSummary[] = [];
  const outstanding: LessonSummary[] = [];
  for (const prerequisiteId of summary.prerequisites) {
    const prerequisite = byId.get(prerequisiteId);
    if (prerequisite === undefined) continue;
    resolved.push(prerequisite);
    // With completion unknown every prerequisite would land here, about a reader nobody identified.
    if (completionKnown && !prerequisite.completed) outstanding.push(prerequisite);
  }
  return {
    position,
    summary,
    prerequisites: resolved,
    completed: completionKnown ? summary.completed : null,
    unlocked: completionKnown ? outstanding.length === 0 : null,
    outstandingPrerequisites: outstanding,
    readable: readable === null ? true : readable.has(summary.id),
  };
}

export function buildCurriculum(summaries: readonly LessonSummary[], options: CurriculumOptions): Curriculum {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const readable = options.readableIds === undefined ? null : new Set(options.readableIds);
  const { completionKnown } = options;

  // Numbered down reading order, so a card's number is the step "Next" takes it to.
  const entries = readingOrder(summaries).map((summary, index) =>
    buildEntry(summary, index + 1, { byId, readable, completionKnown }),
  );

  const groups: CurriculumGroup[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last !== undefined && last.difficulty === entry.summary.difficulty) {
      groups[groups.length - 1] = {
        ...last,
        entries: [...last.entries, entry],
        minutes: last.minutes + entry.summary.estimatedMinutes,
      };
      continue;
    }
    groups.push({
      key: `${entry.summary.difficulty}-${entry.position}`,
      difficulty: entry.summary.difficulty,
      label: groupLabel(entry.summary.difficulty),
      entries: [entry],
      minutes: entry.summary.estimatedMinutes,
    });
  }

  return {
    groups,
    entries,
    startHere: chooseStartHere(entries, completionKnown),
    completionKnown,
    totalMinutes: entries.reduce((sum, entry) => sum + entry.summary.estimatedMinutes, 0),
    lessonCount: entries.length,
    topicCount: new Set(entries.map((entry) => entry.summary.topic)).size,
  };
}

export interface LessonStep {
  readonly id: ContentId;
  readonly title: string;
}

export function firstLesson(order: readonly LessonStep[]): LessonStep | null {
  const first = order[0];
  return first === undefined ? null : { id: first.id, title: first.title };
}

/**
 * Callers pass `lessonsInReadingOrder()`, the order the index is numbered in, so Next from 06 opens 07.
 * If the two disagree, renumber the index. Never make this follow a display order.
 */
export function nextLesson(order: readonly LessonStep[], currentId: ContentId): LessonStep | null {
  const index = order.findIndex((lesson) => lesson.id === currentId);
  if (index === -1) return null;
  const next = order[index + 1];
  return next === undefined ? null : { id: next.id, title: next.title };
}

/** Tells an unbundled next lesson apart from a link and from the last lesson. */
export type NextLessonStep =
  | { readonly kind: 'link'; readonly id: ContentId; readonly title: string }
  | { readonly kind: 'unavailable'; readonly title: string }
  | null;

/**
 * Offline, the bundle lacks some bodies, and `betting-actions` follows `hand-flow`. Skipping to the next
 * bundled lesson would pass a prerequisite, so the step names the lesson as unavailable instead.
 * `readable` is `null` for the live service, where every lesson is readable.
 */
export function nextLessonStep(
  next: LessonStep | null,
  readable: readonly ContentId[] | null,
): NextLessonStep {
  if (next === null) return null;
  if (readable !== null && !readable.includes(next.id)) return { kind: 'unavailable', title: next.title };
  return { kind: 'link', id: next.id, title: next.title };
}

/**
 * The `id` on a lesson's `h1`, which the quiz's "Re-read" links to. A same-URL link does not scroll,
 * so it needs a fragment, and `lessonOutline` reserves this id.
 */
export const LESSON_TITLE_ID = 'lesson-title';

export interface OutlineHeading {
  /** The `id` on the rendered heading, and the fragment the contents link points at. */
  readonly id: string;
  readonly text: string;
  /** Index into the lesson's `blocks`, so the renderer and the nav cannot disagree. */
  readonly blockIndex: number;
}

export interface LessonOutline {
  readonly headings: readonly OutlineHeading[];
  /** Block index → heading id. The renderer reads this rather than re-deriving a slug. */
  readonly idByBlockIndex: ReadonlyMap<number, string>;
}

/**
 * Lower-case ASCII letters, digits and single hyphens, so the fragment is typeable in a URL bar. A
 * heading that reduces to nothing falls back to its position.
 */
function slugify(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? fallback : slug;
}

/**
 * Every `heading` block with a unique id, computed once for both the renderer and the contents nav so
 * a link cannot point at a fragment one character off. Duplicate headings get a numeric suffix.
 */
export function lessonOutline(blocks: readonly LessonBlock[]): LessonOutline {
  const headings: OutlineHeading[] = [];
  const idByBlockIndex = new Map<number, string>();
  // Seeded with the title's id, so a heading that slugs to it is suffixed rather than duplicated.
  const used = new Map<string, number>([[LESSON_TITLE_ID, 1]]);

  blocks.forEach((block, blockIndex) => {
    if (block.kind !== 'heading') return;
    const base = slugify(block.text, `section-${blockIndex + 1}`);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}-${seen + 1}`;
    headings.push({ id, text: block.text, blockIndex });
    idByBlockIndex.set(blockIndex, id);
  });

  return { headings, idByBlockIndex };
}
