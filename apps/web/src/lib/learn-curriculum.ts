/**
 * Turning a list of lessons into a curriculum, and a lesson's headings into an outline.
 *
 * Pure functions over the wire types. No React, no DOM, no fetch — so the ordering rules can be
 * reasoned about (and, when there is a test runner for this app, tested) without rendering
 * anything.
 *
 * ## Why the numbering is computed here rather than stored
 *
 * The design system's numbered-system motif (§1, §9) is the point of this screen: `01 02 03`
 * turns seventeen links into a syllabus you can hold in your head. But the number is a
 * *position*, not an identity — insert a lesson on pot geometry between two others and every
 * number after it moves. Storing it in the content would guarantee it goes stale, so it is
 * derived from the display order every time, and the display order is derived from the
 * prerequisites the content already declares.
 *
 * ## The three orderings, and why they are not the same one
 *
 *  1. **Reading order** — prerequisites before the lessons that need them, then by difficulty,
 *     then by the order the content package listed them. This is the order a learner could
 *     legitimately read front to back.
 *  2. **Display order** — grouped by topic, topics in the contract's own `TOPICS` order, and
 *     within a topic sorted by reading order. Grouping is what makes the index scannable;
 *     without it the reader gets a flat seventeen-item list with no shape.
 *  3. **Numbering** — assigned down the page in display order, so `01` is the first thing you
 *     see and `17` is the last. Numbering by reading order instead would print numbers that
 *     jump around inside each group, which reads as a mistake rather than as a system.
 *
 * ## Prerequisites are information, never a gate
 *
 * `unlocked` reports whether every prerequisite is marked read. Nothing in the UI uses it to
 * disable a link. Locking lessons behind a completion state is the mechanic that turns a
 * syllabus into a progression ladder, and the product guardrails rule that out: a learner who
 * wants to read about variance first is allowed to, and telling them what they have skipped is
 * more useful than stopping them.
 */

import type { ContentId, Difficulty, LessonBlock, LessonSummary, Topic } from '@prl/contracts';
import { TOPICS } from '@prl/contracts';

/**
 * Human labels for the syllabus areas.
 *
 * Written out rather than de-slugged from the id, because "Pot odds and EV" and "Bet sizing and
 * SPR" both need capitalisation a string transform cannot guess, and a heading that reads
 * "Pot Odds And Ev" undoes the technical voice the labels are for.
 */
export const TOPIC_LABELS: Readonly<Record<Topic, string>> = {
  'rules-and-flow': 'Rules and flow',
  'positions-and-blinds': 'Position and the blinds',
  'hand-reading-and-outs': 'Hand reading and outs',
  'probability-and-equity': 'Probability and equity',
  'pot-odds-and-ev': 'Pot odds and EV',
  'bet-sizing-and-spr': 'Bet sizing and SPR',
  'fold-equity-and-bluffing': 'Fold equity and bluffing',
  ranges: 'Ranges',
  'variance-and-bankroll': 'Variance and bankroll',
  tournaments: 'Tournaments',
  'risk-psychology': 'Risk psychology',
};

export const DIFFICULTY_LABELS: Readonly<Record<Difficulty, string>> = {
  intro: 'Intro',
  core: 'Core',
  advanced: 'Advanced',
};

/**
 * A shape cue for each difficulty, so the chip is not distinguished by its word alone at a
 * glance. One, two or three filled squares — a quantity, which is what difficulty is.
 */
export const DIFFICULTY_GLYPHS: Readonly<Record<Difficulty, string>> = {
  intro: '▪',
  core: '▪▪',
  advanced: '▪▪▪',
};

const DIFFICULTY_RANK: Readonly<Record<Difficulty, number>> = { intro: 0, core: 1, advanced: 2 };

/**
 * `LessonSummary.topic` and `.difficulty` are `string` on the wire, not the unions — the API
 * type widens them so a server that gains a topic does not break an older client at the type
 * level. These two guards are where that widening is narrowed back, once, with an honest
 * fallback for a value this build has never heard of.
 */
export function asTopic(value: string): Topic | null {
  return (TOPICS as readonly string[]).includes(value) ? (value as Topic) : null;
}

export function asDifficulty(value: string): Difficulty | null {
  if (value === 'intro' || value === 'core' || value === 'advanced') return value;
  return null;
}

/** The label for a topic id, falling back to the id itself so an unknown topic still reads. */
export function topicLabel(value: string): string {
  const topic = asTopic(value);
  return topic === null ? value : TOPIC_LABELS[topic];
}

export interface CurriculumEntry {
  /** Position down the page, 1-based. Rendered as `01`, `02`, … by `formatIndex`. */
  readonly position: number;
  readonly summary: LessonSummary;
  /**
   * Prerequisites resolved to summaries, so a card can print "Read first: How a hand runs" rather
   * than the id. A prerequisite naming a lesson that is not in the list is dropped: it is a
   * content defect for `packages/content` to report, not a dead link on this page.
   */
  readonly prerequisites: readonly LessonSummary[];
  /** Every prerequisite is marked read. Informational — never used to disable anything. */
  readonly unlocked: boolean;
  /** Prerequisites not yet marked read, resolved to summaries so they can be linked. */
  readonly outstandingPrerequisites: readonly LessonSummary[];
  /** True when the fixture or API has a body for this lesson, so the link is worth following. */
  readonly readable: boolean;
}

export interface CurriculumGroup {
  readonly topic: string;
  readonly label: string;
  readonly entries: readonly CurriculumEntry[];
  readonly minutes: number;
}

export interface Curriculum {
  readonly groups: readonly CurriculumGroup[];
  /** Every entry, in display order, so callers do not have to flatten the groups again. */
  readonly entries: readonly CurriculumEntry[];
  /**
   * Where a learner should go next: the first lesson in display order that is not marked read
   * and whose prerequisites all are. `null` once everything is read.
   */
  readonly startHere: CurriculumEntry | null;
  readonly totalMinutes: number;
  readonly lessonCount: number;
  readonly topicCount: number;
}

/**
 * Reading order: prerequisites first, then difficulty, then the order given.
 *
 * Depth-first over the prerequisite graph, emitting each lesson after everything it depends on.
 * `packages/content/src/validate.ts` has already rejected cycles, but this cannot assume it is
 * running against validated content — a fixture or a future API response could contain one — so
 * `visiting` breaks a cycle by emitting the lesson anyway rather than recursing for ever. A
 * slightly wrong order is a bad index; a stack overflow is a blank page.
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
    // An unrecognised difficulty sorts last rather than first: it is more likely to be new
    // advanced material than a new intro.
    const leftRank = left === null ? DIFFICULTY_RANK.advanced + 1 : DIFFICULTY_RANK[left];
    const rightRank = right === null ? DIFFICULTY_RANK.advanced + 1 : DIFFICULTY_RANK[right];
    return leftRank - rightRank;
  });
  for (const summary of sorted) emit(summary);
  return out;
}

/** Topics in the contract's order, then any topic this build does not know, in first-seen order. */
function topicOrder(summaries: readonly LessonSummary[]): readonly string[] {
  const present = new Set(summaries.map((summary) => summary.topic));
  const out: string[] = [];
  for (const topic of TOPICS) {
    if (present.has(topic)) out.push(topic);
  }
  for (const summary of summaries) {
    if (asTopic(summary.topic) === null && !out.includes(summary.topic)) out.push(summary.topic);
  }
  return out;
}

export interface CurriculumOptions {
  /** Lesson ids whose body this build can actually render. */
  readonly readableIds?: readonly ContentId[];
}

/**
 * Groups, numbers and annotates the curriculum.
 *
 * @param summaries every lesson the index should show, in any order
 */
export function buildCurriculum(
  summaries: readonly LessonSummary[],
  options: CurriculumOptions = {},
): Curriculum {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const readable = options.readableIds === undefined ? null : new Set(options.readableIds);
  const rank = new Map<ContentId, number>();
  let readingRank = 0;
  for (const summary of readingOrder(summaries)) {
    rank.set(summary.id, readingRank);
    readingRank += 1;
  }

  const groups: CurriculumGroup[] = [];
  const entries: CurriculumEntry[] = [];
  let position = 0;

  for (const topic of topicOrder(summaries)) {
    const inTopic = summaries
      .filter((summary) => summary.topic === topic)
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    const groupEntries: CurriculumEntry[] = [];
    let minutes = 0;

    for (const summary of inTopic) {
      position += 1;
      minutes += summary.estimatedMinutes;
      const resolved: LessonSummary[] = [];
      const outstanding: LessonSummary[] = [];
      for (const prerequisiteId of summary.prerequisites) {
        const prerequisite = byId.get(prerequisiteId);
        if (prerequisite === undefined) continue;
        resolved.push(prerequisite);
        if (!prerequisite.completed) outstanding.push(prerequisite);
      }
      const entry: CurriculumEntry = {
        position,
        summary,
        prerequisites: resolved,
        unlocked: outstanding.length === 0,
        outstandingPrerequisites: outstanding,
        readable: readable === null ? true : readable.has(summary.id),
      };
      groupEntries.push(entry);
      entries.push(entry);
    }

    groups.push({ topic, label: topicLabel(topic), entries: groupEntries, minutes });
  }

  const startHere =
    entries.find((entry) => !entry.summary.completed && entry.unlocked) ??
    entries.find((entry) => !entry.summary.completed) ??
    null;

  return {
    groups,
    entries,
    startHere,
    totalMinutes: entries.reduce((sum, entry) => sum + entry.summary.estimatedMinutes, 0),
    lessonCount: entries.length,
    topicCount: groups.length,
  };
}

// ---------------------------------------------------------------------------
// Lesson outline
// ---------------------------------------------------------------------------

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
 * A URL-safe fragment from heading text.
 *
 * Deliberately narrow: lower-case, ASCII letters, digits and single hyphens. Heading text is
 * English prose with apostrophes and em dashes in it ("Hold'em", "The rule — and where it
 * drifts"), and anything that survives into an `id` has to be typeable into a URL bar by hand.
 * A heading that reduces to nothing (all punctuation) falls back to its position, so the
 * fragment always exists.
 */
function slugify(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? fallback : slug;
}

/**
 * Every `heading` block, with a stable, unique id.
 *
 * Computed once by the page and handed to both the renderer and the contents nav. Deriving it
 * twice — once in each — is the classic way a table of contents ends up linking to fragments
 * that are one character different from the ids on the page, and the failure is silent: the
 * link simply does nothing.
 *
 * Duplicate headings get a numeric suffix. Two sections legitimately called "Worked example"
 * is normal in teaching material, and two elements with the same `id` is invalid HTML that
 * breaks `aria-current` tracking as well as the link.
 */
export function lessonOutline(blocks: readonly LessonBlock[]): LessonOutline {
  const headings: OutlineHeading[] = [];
  const idByBlockIndex = new Map<number, string>();
  const used = new Map<string, number>();

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
