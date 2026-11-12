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
 * derived from the reading order every time, and the reading order is derived from the
 * prerequisites the content already declares.
 *
 * ## One ordering, because there used to be three
 *
 * **Reading order** — prerequisites before the lessons that need them, then by difficulty, then by
 * the order the content package listed them — is the order a learner can legitimately read front to
 * back, and it is now the only order this module produces. The cards are in it, the numbers are
 * assigned down it, and the lesson page's "Next" walks it (`nextLesson`, below).
 *
 * The index used to group the cards by topic and number them down the page in that display order,
 * while "Next" followed reading order. Measured by visiting all seventeen lessons and reading each
 * Next href (UX audit at 6b3886e, M1): the page said "the numbering is a route through the
 * material", and the route Next actually took was 1→2→4→6→7→9→10→13→11→12→15→3→5→8→14→16→17 — so
 * Lesson 2 sent a reader to Lesson 4, and Lesson 15 sent them back to Lesson 3. Making Next follow
 * the numbers instead is not a fix: the old display order put `bet-sizing` before `fold-equity`,
 * which it names as a prerequisite (see `nextLesson`).
 *
 * Reading order splits topics — rules and flow is lessons 1, 2 and 12 — so contiguous topic
 * sections and numbers that count upwards cannot both survive. The numbers won. The groups are
 * consecutive runs of one difficulty (Intro, Core, Advanced), which over reading order are
 * contiguous by construction because difficulty is the order's own second key, and the topic moved
 * onto each card. Should a prerequisite ever pull a harder lesson ahead of an easier one, the run
 * simply breaks and a second heading of the same difficulty appears: honest, and still in order.
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

/**
 * A consecutive run of reading order at one difficulty. See "One ordering" in the module header for
 * why the runs are by difficulty and not by topic.
 */
export interface CurriculumGroup {
  /** Unique across the curriculum even if a difficulty recurs, so it can key a React list. */
  readonly key: string;
  /** The raw difficulty, so an unrecognised one still reads rather than vanishing. */
  readonly difficulty: string;
  readonly label: string;
  readonly entries: readonly CurriculumEntry[];
  readonly minutes: number;
}

export interface Curriculum {
  readonly groups: readonly CurriculumGroup[];
  /** Every entry, in reading order, so callers do not have to flatten the groups again. */
  readonly entries: readonly CurriculumEntry[];
  /**
   * Where a learner should go next.
   *
   * With completion known: the first lesson in reading order that is not marked read and whose
   * prerequisites all are, and `null` once everything is read.
   *
   * With completion unknown: simply the first lesson in reading order. That is still a useful
   * suggestion — the ordering is the syllabus — but it is a different claim, and `completionKnown`
   * below is how a screen knows which of the two it is printing.
   */
  readonly startHere: CurriculumEntry | null;
  /** Carried through from the options so a screen can word its copy for the state it is in. */
  readonly completionKnown: boolean;
  readonly totalMinutes: number;
  readonly lessonCount: number;
  /** Distinct topics across every lesson. Not `groups.length`: the groups are difficulty runs. */
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

/** The heading over a run of one difficulty. A difficulty this build has never heard of reads as itself. */
function groupLabel(difficulty: string): string {
  const known = asDifficulty(difficulty);
  return `${known === null ? difficulty : DIFFICULTY_LABELS[known]} lessons`;
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

/**
 * The sentence under the "Start here" panel's summary, for the four states the suggestion can be in.
 *
 * The index printed "Everything this lesson assumes is already marked read." over Lesson 1 for a
 * reader who had read nothing (UX audit at 6b3886e, Minor 8): Lesson 1 has no prerequisites, so
 * "every prerequisite is read" was vacuously true and `unlocked === true` could not tell "you have
 * read what it needs" from "it needs nothing". The count is checked first for that reason.
 */
export function startHereNote(start: CurriculumEntry): string {
  if (start.unlocked === null) {
    // Nobody asked who this reader is, so the suggestion is the top of the syllabus and says so.
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

  // Numbered down reading order, so the number on a card is the step "Next" takes it to. See the
  // module header for the audit that measured the two disagreeing.
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

// ---------------------------------------------------------------------------
// Lesson outline
// ---------------------------------------------------------------------------

/** The two fields a step between lessons needs. `Lesson` and `LessonSummary` both carry them. */
export interface LessonStep {
  readonly id: ContentId;
  readonly title: string;
}

/**
 * Where a learner starts: the first lesson in the order given, or `null` for an empty list.
 *
 * The home page's "Start with the foundations" used to link to `/learn`, where the first lesson's
 * button was measured at y=1682 on a 360x640 first visit — four screens of index before the thing
 * the link had promised. `?? null` because `noUncheckedIndexedAccess` is on.
 */
export function firstLesson(order: readonly LessonStep[]): LessonStep | null {
  const first = order[0];
  return first === undefined ? null : { id: first.id, title: first.title };
}

/**
 * The lesson after `currentId` in `order`, or `null` for the last lesson or an id not in it.
 *
 * Callers pass `lessonsInReadingOrder()`, which is the order the content package defines as front to
 * back, and the order `buildCurriculum` numbers the index in — so "Next" from the card numbered 06
 * opens the card numbered 07. The index used to be numbered in a topic-grouped display order that
 * put `bet-sizing` before `fold-equity`, which `bet-sizing` names as a prerequisite, and the fix for
 * the two disagreeing was to renumber the index, never to make this follow it.
 */
export function nextLesson(order: readonly LessonStep[], currentId: ContentId): LessonStep | null {
  const index = order.findIndex((lesson) => lesson.id === currentId);
  if (index === -1) return null;
  const next = order[index + 1];
  return next === undefined ? null : { id: next.id, title: next.title };
}

/** Offline, hand-flow's Next opened an unbundled body; this tells that gap apart from a link or the last lesson. */
export type NextLessonStep =
  | { readonly kind: 'link'; readonly id: ContentId; readonly title: string }
  | { readonly kind: 'unavailable'; readonly title: string }
  | null;

/**
 * `nextLesson`, checked against what can actually be read right now.
 *
 * When the content service is down the lesson page falls back to a bundle of eight lesson bodies,
 * and reading order puts `betting-actions`, which is not one of them, straight after `hand-flow`.
 * A primary "Next" there opened "This lesson's text is not available in this build" (Devin Review
 * on #22). Skipping ahead to the next bundled lesson would walk a reader past a prerequisite, so
 * the step instead names the lesson and says it cannot be shown, and the foot's first action falls
 * back to the curriculum.
 *
 * `readable` is `null` when the lesson came from the live service, where every lesson is readable.
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
 * The `id` on a lesson's `h1`, which "Re-read" in the quiz points at.
 *
 * That link used to be `<Link href={lessonHref(id)}>` — the URL of the page it was on — and a
 * same-URL navigation does nothing: measured against the running build, scrollY 10050 before the
 * click and 10050 after, history unchanged. A learner meets that link once per answered question
 * and once more at the end. A fragment is what makes it move, and `lessonOutline` reserves this id
 * so no section heading can ever be given it too.
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
