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
 *
 * ## "Not marked read" and "we have not asked" are not the same fact
 *
 * `LessonSummary.completed` is a boolean on the wire and has no way to say "unknown", so for a
 * caller that did not identify the reader it is `false` for all seventeen lessons — not because
 * the reader has read none of them, but because nobody asked on their behalf. This module used to
 * take that at face value, and the index then printed, on sixteen of seventeen cards, that some of
 * their prerequisites were "not marked read", and picked a "start here" from an ordering derived
 * from the same non-answer. Every one of those sentences was a statement about a reader nobody had
 * looked up.
 *
 * So `completionKnown` is a REQUIRED option rather than a defaulted one, and `completed` and
 * `unlocked` are `boolean | null` rather than `boolean`. A caller has to say whether the flags it
 * is handing over are this reader's, and a screen has to handle the third state to compile. That
 * is deliberate friction: the previous shape let a screen make a per-reader claim without anything
 * in the types noticing that no reader had been identified.
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
  /**
   * Whether this reader has marked this lesson read. `null` when nobody has asked on their behalf
   * — see the module header. Read this rather than `summary.completed`, which cannot express the
   * third state and is `false` in it.
   */
  readonly completed: boolean | null;
  /**
   * Every prerequisite is marked read. Informational — never used to disable anything. `null` when
   * the reader's completion state is unknown, because "none of them is marked read" would then be
   * a claim about somebody nobody looked up.
   */
  readonly unlocked: boolean | null;
  /**
   * Prerequisites not yet marked read, resolved to summaries so they can be linked. Empty when
   * completion is unknown: there is nothing truthful to list.
   */
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
   * Where a learner should go next.
   *
   * With completion known: the first lesson in display order that is not marked read and whose
   * prerequisites all are, and `null` once everything is read.
   *
   * With completion unknown: simply the first lesson in display order. That is still a useful
   * suggestion — the ordering is the syllabus — but it is a different claim, and `completionKnown`
   * below is how a screen knows which of the two it is printing.
   */
  readonly startHere: CurriculumEntry | null;
  /** Carried through from the options so a screen can word its copy for the state it is in. */
  readonly completionKnown: boolean;
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
  /**
   * Lesson ids whose body this build can actually render.
   *
   * Only pass this when the list itself came from the bundled copy. It describes *fixture
   * coverage*, and passing it alongside a live list is how the index came to warn readers off nine
   * lessons the API was serving perfectly — see `app/learn/page.tsx`.
   */
  readonly readableIds?: readonly ContentId[];
  /**
   * Whether `LessonSummary.completed` on these summaries is THIS reader's answer.
   *
   * Required, and required for a reason: `false` and "we did not ask" are indistinguishable on the
   * wire, and the caller is the only party that knows which it is holding. See the module header.
   */
  readonly completionKnown: boolean;
}

/**
 * Which entry the index should point at, and the two different questions that answers.
 *
 * With completion known it is "the earliest lesson you have not read whose prerequisites you have",
 * falling back to "the earliest lesson you have not read", and `null` once everything is read.
 *
 * With completion unknown there is no such question to answer — nobody has established what this
 * reader has read — so the suggestion is the one the ordering already makes on its own: start at
 * the top. That is still useful, and it is a different claim, which is why `Curriculum` carries
 * `completionKnown` for the screen to word it with.
 *
 * `?? null` rather than `entries[0]` because `noUncheckedIndexedAccess` is on and an empty
 * curriculum is a real, if unhappy, state.
 */
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

/** What one entry needs to know about the curriculum around it. */
interface EntryContext {
  /** Every summary by id, for resolving prerequisites to something linkable. */
  readonly byId: ReadonlyMap<ContentId, LessonSummary>;
  /** Ids whose body the offline bundle carries, or null when nothing declared a limit. */
  readonly readable: ReadonlySet<ContentId> | null;
  readonly completionKnown: boolean;
}

/**
 * One card's worth of derived facts.
 *
 * Split out of the grouping loop so that the three-way completion rule is stated once, in one
 * place, rather than inside two nested loops where it is easy to add a fourth reading of the same
 * boolean.
 */
function buildEntry(summary: LessonSummary, position: number, context: EntryContext): CurriculumEntry {
  const { byId, readable, completionKnown } = context;
  const resolved: LessonSummary[] = [];
  const outstanding: LessonSummary[] = [];
  for (const prerequisiteId of summary.prerequisites) {
    const prerequisite = byId.get(prerequisiteId);
    if (prerequisite === undefined) continue;
    resolved.push(prerequisite);
    // Only collected when the flags mean something. With completion unknown every prerequisite
    // would land in here, and the card would print "N of those are not marked read" about a reader
    // nobody identified.
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

/**
 * Groups, numbers and annotates the curriculum.
 *
 * @param summaries every lesson the index should show, in any order
 * @param options must state whether the completion flags belong to the reader being shown this
 */
export function buildCurriculum(summaries: readonly LessonSummary[], options: CurriculumOptions): Curriculum {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));
  const readable = options.readableIds === undefined ? null : new Set(options.readableIds);
  const { completionKnown } = options;
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
      const entry = buildEntry(summary, position, { byId, readable, completionKnown });
      groupEntries.push(entry);
      entries.push(entry);
    }

    groups.push({ topic, label: topicLabel(topic), entries: groupEntries, minutes });
  }

  return {
    groups,
    entries,
    startHere: chooseStartHere(entries, completionKnown),
    completionKnown,
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
