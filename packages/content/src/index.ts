/**
 * `@prl/content`, the teaching material, loaded and validated. Server-side only. It reads JSON
 * with `node:fs`, which avoids the two incompatible JSON import spellings of Node ESM and bundlers.
 * The browser gets content through the API, which merges it with progress anyway.
 * The bundle is validated once on first access, so bad content fails at start-up.
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
 * Re-exported because the `exports` map publishes only `.`. `readSituation` is the one definition of
 * how a stored scenario becomes a pot, price, board and range, so the API must not reimplement it
 * (ADR 0006).
 */
export {
  analyseScenario,
  checkScenarioClaims,
  describeAnalysis,
  readSituation,
  SCENARIO_ANALYSIS_SAMPLES,
  SCENARIO_ANALYSIS_SEED,
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

/** Walks up to `data/`, because `src/index.ts` and `dist/index.js` sit at different depths. */
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

/** Unvalidated, so tooling can report every problem in one pass. */
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

/** Validated on first call, then memoised. The files do not change while the process runs. */
export function content(): ContentBundle {
  if (cached === null) cached = validateContent(readRawContent());
  return cached;
}

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

export function quizForLesson(lessonId: ContentId): Quiz | null {
  const lesson = lessonById(lessonId);
  if (lesson?.quizId === undefined) {
    return content().quizzes.find((quiz) => quiz.lessonId === lessonId) ?? null;
  }
  return quizById(lesson.quizId);
}

/** Prerequisites first. Validation rejects cycles, so this terminates. */
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

  // By difficulty, then file order (the sort is stable).
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
