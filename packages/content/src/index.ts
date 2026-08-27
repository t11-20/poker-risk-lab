/**
 * `@prl/content` — the teaching material, loaded and validated.
 *
 * ## Server-side only, on purpose
 *
 * This package reads its JSON from disk with `node:fs`. It is imported by
 * `apps/api` and **not** by `apps/web`: the browser gets content over the API
 * instead. Two reasons that split is deliberate rather than incidental:
 *
 *   1. Bundling. JSON module imports need `with { type: 'json' }` under Node's ESM
 *      resolver but not under a bundler, so a package that imports JSON directly
 *      ends up needing two incompatible spellings. Reading from disk sidesteps that
 *      entirely.
 *   2. Personalisation. The API already has to merge content with the caller's
 *      progress and compute the live figures, so content has to pass through the
 *      server regardless. Shipping the whole bundle to the client as well would
 *      duplicate it.
 *
 * ## Validated at load, not at use
 *
 * The bundle is validated once, on first access, by `validateContent`. A malformed
 * content file therefore fails at start-up with a precise message rather than
 * halfway through rendering a lesson. See `validate.ts` for why that matters more
 * than usual here: content that is merely *shaped* wrong is a crash, but content
 * that is *semantically* wrong quietly teaches the wrong thing.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContentBundle, ContentId, GlossaryEntry, Lesson, Quiz, Scenario, Topic } from '@prl/contracts';
import { type RawContent, validateContent } from './validate.ts';

export type {
  AnalyseOptions,
  ClaimResult,
  ScenarioAnalysis,
  ScenarioSituation,
} from './scenario-analysis.ts';
/**
 * The scenario bridge, re-exported because this entry point is the whole of what any other
 * package can reach — the `exports` map publishes `.` and nothing else, so a deep import of
 * `dist/scenario-analysis.js` is blocked.
 *
 * `scenario-analysis.ts` describes itself as the bridge between the content and the maths, and
 * `apps/api` is the caller it exists for: the API serves a scenario with its analysis computed
 * live, and `readSituation` is the one definition of how a stored scenario becomes a pot, a
 * price, a board and a range. Without these lines the API would have to reimplement that
 * reading, which is precisely the second source of truth ADR 0006 exists to prevent.
 */
export {
  analyseScenario,
  checkScenarioClaims,
  describeAnalysis,
  readSituation,
  ScenarioAnalysisError,
} from './scenario-analysis.ts';
export type { RawContent } from './validate.ts';
export {
  BOARD_LENGTH_BY_STREET,
  ContentValidationError,
  collectContentProblems,
  validateContent,
} from './validate.ts';

export class ContentLoadError extends Error {
  override readonly name = 'ContentLoadError';
}

/**
 * The data directory, resolved relative to this module.
 *
 * `dist/index.js` and `src/index.ts` sit at different depths, so the directory is
 * located by walking up until `data/` is found rather than by a hard-coded `../..`.
 * That keeps the same code working whether the package is running from source
 * (tests, `node --watch`) or from its build output.
 */
function findDataDirectory(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(current, 'data');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  throw new ContentLoadError(
    `could not locate the content data directory starting from ${dirname(fileURLToPath(import.meta.url))}`,
  );
}

function readJsonArray(path: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ContentLoadError(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ContentLoadError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ContentLoadError(`${path} must contain a JSON array at the top level`);
  }
  return parsed;
}

/** Every `.json` file directly inside `dir`, in sorted order for determinism. */
function readJsonArraysIn(dir: string): unknown[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const out: unknown[] = [];
  for (const name of files) out.push(...readJsonArray(join(dir, name)));
  return out;
}

/**
 * Reads the raw content from disk without validating it. Exposed so tooling can
 * report every problem in one pass instead of stopping at the first throw.
 */
export function readRawContent(dataDirectory = findDataDirectory()): RawContent {
  const scenarios = readJsonArraysIn(join(dataDirectory, 'scenarios'));
  const lessons = readJsonArraysIn(join(dataDirectory, 'lessons'));
  const glossaryPath = join(dataDirectory, 'glossary.json');
  const quizzesPath = join(dataDirectory, 'quizzes.json');
  const glossary = existsSync(glossaryPath) ? readJsonArray(glossaryPath) : [];
  const quizzes = existsSync(quizzesPath) ? readJsonArray(quizzesPath) : [];

  if (scenarios.length === 0)
    throw new ContentLoadError(`no scenarios found under ${dataDirectory}/scenarios`);
  if (lessons.length === 0) throw new ContentLoadError(`no lessons found under ${dataDirectory}/lessons`);
  if (glossary.length === 0) throw new ContentLoadError(`no glossary entries found at ${glossaryPath}`);

  return { version: CONTENT_VERSION, lessons, quizzes, scenarios, glossary };
}

/** Bumped when the content shape changes in a way clients must notice. */
export const CONTENT_VERSION = '1.0.0';

let cached: ContentBundle | null = null;

/**
 * The validated bundle. Loaded and validated on first call, then memoised — the
 * files do not change while the process runs.
 */
export function content(): ContentBundle {
  if (cached === null) cached = validateContent(readRawContent());
  return cached;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function indexById<T extends { id: string }>(records: readonly T[]): Map<string, T> {
  return new Map(records.map((record) => [record.id, record]));
}

export function lessons(): readonly Lesson[] {
  return content().lessons;
}

export function quizzes(): readonly Quiz[] {
  return content().quizzes;
}

export function scenarios(): readonly Scenario[] {
  return content().scenarios;
}

export function glossary(): readonly GlossaryEntry[] {
  return content().glossary;
}

export function lessonById(id: ContentId): Lesson | null {
  return indexById(content().lessons).get(id) ?? null;
}

export function quizById(id: ContentId): Quiz | null {
  return indexById(content().quizzes).get(id) ?? null;
}

export function scenarioById(id: ContentId): Scenario | null {
  return indexById(content().scenarios).get(id) ?? null;
}

export function glossaryEntryById(id: ContentId): GlossaryEntry | null {
  return indexById(content().glossary).get(id) ?? null;
}

export function glossaryEntriesFor(ids: readonly ContentId[]): readonly GlossaryEntry[] {
  const index = indexById(content().glossary);
  const out: GlossaryEntry[] = [];
  for (const id of ids) {
    const entry = index.get(id);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}

export function lessonsByTopic(topic: Topic): readonly Lesson[] {
  return content().lessons.filter((lesson) => lesson.topic === topic);
}

export function scenariosByTopic(topic: Topic): readonly Scenario[] {
  return content().scenarios.filter((scenario) => scenario.topic === topic);
}

/** The quiz attached to a lesson, if there is one. */
export function quizForLesson(lessonId: ContentId): Quiz | null {
  const lesson = lessonById(lessonId);
  if (lesson?.quizId === undefined) {
    return content().quizzes.find((quiz) => quiz.lessonId === lessonId) ?? null;
  }
  return quizById(lesson.quizId);
}

/**
 * Lessons in an order that respects prerequisites — a reading order a learner can
 * follow front to back. Validation has already rejected cycles, so this terminates.
 */
export function lessonsInReadingOrder(): readonly Lesson[] {
  const all = content().lessons;
  const byId = indexById(all);
  const emitted = new Set<string>();
  const out: Lesson[] = [];

  const emit = (lesson: Lesson): void => {
    if (emitted.has(lesson.id)) return;
    emitted.add(lesson.id);
    for (const prerequisiteId of lesson.prerequisites) {
      const prerequisite = byId.get(prerequisiteId);
      if (prerequisite !== undefined) emit(prerequisite);
    }
    out.push(lesson);
  };

  // Stable outer order: by difficulty, then by the order they appear in the files.
  const difficultyRank = { intro: 0, core: 1, advanced: 2 } as const;
  const sorted = [...all].sort((a, b) => difficultyRank[a.difficulty] - difficultyRank[b.difficulty]);
  for (const lesson of sorted) emit(lesson);
  return out;
}

export interface ContentStats {
  readonly lessons: number;
  readonly quizzes: number;
  readonly quizQuestions: number;
  readonly scenarios: number;
  readonly glossaryTerms: number;
  readonly topicsCovered: number;
  readonly scenariosByDifficulty: Readonly<Record<string, number>>;
}

export function contentStats(): ContentStats {
  const bundle = content();
  const byDifficulty: Record<string, number> = {};
  for (const scenario of bundle.scenarios) {
    byDifficulty[scenario.difficulty] = (byDifficulty[scenario.difficulty] ?? 0) + 1;
  }
  const topics = new Set<string>();
  for (const lesson of bundle.lessons) topics.add(lesson.topic);
  for (const scenario of bundle.scenarios) topics.add(scenario.topic);
  return {
    lessons: bundle.lessons.length,
    quizzes: bundle.quizzes.length,
    quizQuestions: bundle.quizzes.reduce((sum, quiz) => sum + quiz.questions.length, 0),
    scenarios: bundle.scenarios.length,
    glossaryTerms: bundle.glossary.length,
    topicsCovered: topics.size,
    scenariosByDifficulty: byDifficulty,
  };
}
