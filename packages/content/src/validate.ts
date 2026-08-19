/**
 * Runtime validation for the content data files.
 *
 * ## Why validate content at all
 *
 * The lessons, quizzes, scenarios and glossary live as JSON under `data/`. TypeScript
 * cannot check a JSON file against a union type — `resolveJsonModule` gives you the
 * *inferred* shape of the literal, not a guarantee that it satisfies `Scenario`. So a
 * malformed scenario would typecheck, build, deploy, and then throw somewhere deep in
 * a React render or, worse, silently teach something wrong.
 *
 * This module is the boundary. Every content file passes through it, and anything
 * that does not match the contract fails loudly at load time with a path that says
 * exactly which field of which record is wrong.
 *
 * ## Why hand-written and not a schema library
 *
 * The repo's dependency policy is strict, and a validator is precisely the kind of
 * code that should not pull in a dependency tree of its own. These validators are
 * plain functions over `unknown` with no cleverness: each one narrows one field and
 * reports the path it was at. That also lets the error messages be genuinely
 * specific ("scenarios[7].board: 'Qh 7h 2c' has 3 cards but street is 'turn', which
 * needs 4") rather than a generic schema trace.
 *
 * ## What is checked beyond shape
 *
 * Shape alone is not enough for content that teaches. The semantic checks matter more:
 * duplicate cards across a scenario, a board length that contradicts the street,
 * a glossary reference that points at nothing, a prerequisite cycle. Those are the
 * defects that produce a plausible-looking lesson that is quietly wrong, and they are
 * all checked here.
 */

import {
  type ContentBundle,
  type ContentId,
  type GlossaryEntry,
  type Lesson,
  type LessonBlock,
  type LiveCalculation,
  OPPONENT_PROFILES,
  type Quiz,
  type QuizQuestion,
  type RangeSpec,
  type Scenario,
  type ScenarioClaim,
  type ScenarioSeat,
  TOPICS,
  type Topic,
} from '@prl/contracts';
import { type Card, CardParseError, parseCards } from '@prl/poker-engine';

export class ContentValidationError extends Error {
  override readonly name = 'ContentValidationError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`content validation failed with ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

/** Collects problems so one run reports everything, not just the first failure. */
class Problems {
  private readonly list: string[] = [];

  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }

  get count(): number {
    return this.list.length;
  }

  throwIfAny(): void {
    if (this.list.length > 0) throw new ContentValidationError(this.list);
  }

  all(): readonly string[] {
    return this.list;
  }
}

// ---------------------------------------------------------------------------
// Primitive checks
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  problems: Problems,
  path: string,
  value: unknown,
  options: { min?: number; max?: number } = {},
): string {
  if (typeof value !== 'string') {
    problems.add(path, `expected a string, got ${describe(value)}`);
    return '';
  }
  const min = options.min ?? 1;
  const max = options.max ?? 20_000;
  if (value.length < min) problems.add(path, `string is shorter than ${min} characters`);
  if (value.length > max) problems.add(path, `string is longer than ${max} characters`);
  return value;
}

function requireInteger(
  problems: Problems,
  path: string,
  value: unknown,
  options: { min?: number; max?: number } = {},
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    problems.add(path, `expected an integer, got ${describe(value)}`);
    return 0;
  }
  if (options.min !== undefined && value < options.min) problems.add(path, `must be at least ${options.min}`);
  if (options.max !== undefined && value > options.max) problems.add(path, `must be at most ${options.max}`);
  return value;
}

function requireNumber(
  problems: Problems,
  path: string,
  value: unknown,
  options: { min?: number; max?: number } = {},
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.add(path, `expected a finite number, got ${describe(value)}`);
    return 0;
  }
  if (options.min !== undefined && value < options.min) problems.add(path, `must be at least ${options.min}`);
  if (options.max !== undefined && value > options.max) problems.add(path, `must be at most ${options.max}`);
  return value;
}

function requireStringArray(
  problems: Problems,
  path: string,
  value: unknown,
  options: { min?: number; max?: number } = {},
): string[] {
  if (!Array.isArray(value)) {
    problems.add(path, `expected an array, got ${describe(value)}`);
    return [];
  }
  const min = options.min ?? 0;
  const max = options.max ?? 200;
  if (value.length < min) problems.add(path, `needs at least ${min} entries, has ${value.length}`);
  if (value.length > max) problems.add(path, `has ${value.length} entries, more than the ${max} allowed`);
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    out.push(requireString(problems, `${path}[${index}]`, entry));
  }
  return out;
}

function requireOneOf<T extends string>(
  problems: Problems,
  path: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    problems.add(path, `expected one of ${allowed.join(' | ')}, got ${describe(value)}`);
    return allowed[0] as T;
  }
  return value as T;
}

const CONTENT_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

function requireContentId(problems: Problems, path: string, value: unknown): ContentId {
  const text = requireString(problems, path, value, { max: 80 });
  if (text !== '' && !CONTENT_ID.test(text)) {
    problems.add(path, `"${text}" is not a valid id (lower-case letters, digits and hyphens only)`);
  }
  return text;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'object') return 'an object';
  return `${typeof value} ${JSON.stringify(value)}`;
}

/** Parses a card string, recording a problem instead of throwing. */
function parseCardsSafely(problems: Problems, path: string, text: string): Card[] {
  if (text.trim() === '') return [];
  try {
    return parseCards(text);
  } catch (error) {
    const message = error instanceof CardParseError ? error.message : String(error);
    problems.add(path, `could not parse cards from "${text}": ${message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

function validateGlossaryEntry(problems: Problems, path: string, raw: unknown): GlossaryEntry {
  if (!isRecord(raw)) {
    problems.add(path, `expected an object, got ${describe(raw)}`);
    return { id: '', term: '', definition: '', topics: [] };
  }
  const entry: GlossaryEntry = {
    id: requireContentId(problems, `${path}.id`, raw['id']),
    term: requireString(problems, `${path}.term`, raw['term'], { max: 60 }),
    definition: requireString(problems, `${path}.definition`, raw['definition'], { min: 10, max: 1200 }),
    topics: (Array.isArray(raw['topics']) ? raw['topics'] : []).map((topic, index) =>
      requireOneOf(problems, `${path}.topics[${index}]`, topic, TOPICS),
    ),
    ...(typeof raw['formula'] === 'string' ? { formula: raw['formula'] } : {}),
    ...(Array.isArray(raw['seeAlso'])
      ? {
          seeAlso: raw['seeAlso'].map((id, index) =>
            requireContentId(problems, `${path}.seeAlso[${index}]`, id),
          ),
        }
      : {}),
  };
  if (!Array.isArray(raw['topics'])) problems.add(`${path}.topics`, 'expected an array of topics');
  return entry;
}

// ---------------------------------------------------------------------------
// Live calculations
// ---------------------------------------------------------------------------

function validateIcmCalculation(
  problems: Problems,
  path: string,
  raw: Record<string, unknown>,
): Extract<LiveCalculation, { kind: 'icm' }> {
  const stacksRaw = Array.isArray(raw['stacks']) ? raw['stacks'] : [];
  const payoutsRaw = Array.isArray(raw['payouts']) ? raw['payouts'] : [];
  if (!Array.isArray(raw['stacks'])) problems.add(`${path}.stacks`, 'expected an array of stacks');
  if (!Array.isArray(raw['payouts'])) problems.add(`${path}.payouts`, 'expected an array of payouts');
  if (stacksRaw.length < 2) problems.add(`${path}.stacks`, 'ICM needs at least two stacks');
  if (stacksRaw.length > 9) problems.add(`${path}.stacks`, 'ICM is capped at 9 players');
  if (payoutsRaw.length > stacksRaw.length) {
    problems.add(`${path}.payouts`, 'cannot list more paid places than there are stacks');
  }
  return {
    kind: 'icm',
    stacks: stacksRaw.map((value, index) =>
      requireInteger(problems, `${path}.stacks[${index}]`, value, { min: 0, max: 10_000_000 }),
    ),
    payouts: payoutsRaw.map((value, index) =>
      requireInteger(problems, `${path}.payouts[${index}]`, value, { min: 0, max: 10_000_000 }),
    ),
  };
}

const CALCULATION_KINDS = [
  'equity',
  'outs',
  'potOdds',
  'ruleOf24',
  'callEv',
  'foldEquity',
  'spr',
  'variance',
  'riskOfRuin',
  'icm',
] as const;

function validateLiveCalculation(problems: Problems, path: string, raw: unknown): LiveCalculation {
  if (!isRecord(raw)) {
    problems.add(path, `expected an object, got ${describe(raw)}`);
    return { kind: 'potOdds', pot: 0, toCall: 0 };
  }
  const kind = requireOneOf(problems, `${path}.kind`, raw['kind'], CALCULATION_KINDS);
  switch (kind) {
    case 'equity': {
      const heroCards = requireString(problems, `${path}.heroCards`, raw['heroCards'], { max: 24 });
      parseCardsSafely(problems, `${path}.heroCards`, heroCards);
      const opponents = requireStringArray(problems, `${path}.opponents`, raw['opponents'], {
        min: 1,
        max: 5,
      });
      const board = typeof raw['board'] === 'string' ? raw['board'] : undefined;
      if (board !== undefined) parseCardsSafely(problems, `${path}.board`, board);
      return { kind, heroCards, opponents, ...(board === undefined ? {} : { board }) };
    }
    case 'outs': {
      const heroCards = requireString(problems, `${path}.heroCards`, raw['heroCards'], { max: 24 });
      const board = requireString(problems, `${path}.board`, raw['board'], { max: 24 });
      parseCardsSafely(problems, `${path}.heroCards`, heroCards);
      parseCardsSafely(problems, `${path}.board`, board);
      const opponentCards = typeof raw['opponentCards'] === 'string' ? raw['opponentCards'] : undefined;
      return { kind, heroCards, board, ...(opponentCards === undefined ? {} : { opponentCards }) };
    }
    case 'potOdds':
      return {
        kind,
        pot: requireInteger(problems, `${path}.pot`, raw['pot'], { min: 0, max: 10_000_000 }),
        toCall: requireInteger(problems, `${path}.toCall`, raw['toCall'], { min: 0, max: 10_000_000 }),
      };
    case 'ruleOf24': {
      const outs = requireInteger(problems, `${path}.outs`, raw['outs'], { min: 0, max: 47 });
      const cardsToCome = raw['cardsToCome'] === 1 || raw['cardsToCome'] === 2 ? raw['cardsToCome'] : 2;
      if (raw['cardsToCome'] !== 1 && raw['cardsToCome'] !== 2) {
        problems.add(`${path}.cardsToCome`, `must be 1 or 2, got ${describe(raw['cardsToCome'])}`);
      }
      return { kind, outs, cardsToCome };
    }
    case 'callEv':
      return {
        kind,
        pot: requireInteger(problems, `${path}.pot`, raw['pot'], { min: 0, max: 10_000_000 }),
        toCall: requireInteger(problems, `${path}.toCall`, raw['toCall'], { min: 0, max: 10_000_000 }),
        equity: requireNumber(problems, `${path}.equity`, raw['equity'], { min: 0, max: 1 }),
      };
    case 'foldEquity':
      return {
        kind,
        pot: requireInteger(problems, `${path}.pot`, raw['pot'], { min: 0, max: 10_000_000 }),
        betSize: requireInteger(problems, `${path}.betSize`, raw['betSize'], { min: 0, max: 10_000_000 }),
        foldProbability: requireNumber(problems, `${path}.foldProbability`, raw['foldProbability'], {
          min: 0,
          max: 1,
        }),
        equityWhenCalled: requireNumber(problems, `${path}.equityWhenCalled`, raw['equityWhenCalled'], {
          min: 0,
          max: 1,
        }),
      };
    case 'spr':
      return {
        kind,
        effectiveStack: requireInteger(problems, `${path}.effectiveStack`, raw['effectiveStack'], {
          min: 0,
          max: 10_000_000,
        }),
        pot: requireInteger(problems, `${path}.pot`, raw['pot'], { min: 1, max: 10_000_000 }),
      };
    case 'variance':
      return {
        kind,
        winRateBbPer100: requireNumber(problems, `${path}.winRateBbPer100`, raw['winRateBbPer100'], {
          min: -200,
          max: 200,
        }),
        standardDeviationBbPer100: requireNumber(
          problems,
          `${path}.standardDeviationBbPer100`,
          raw['standardDeviationBbPer100'],
          { min: 0.01, max: 500 },
        ),
        hands: requireInteger(problems, `${path}.hands`, raw['hands'], { min: 1, max: 100_000_000 }),
      };
    case 'icm':
      return validateIcmCalculation(problems, path, raw);
    default:
      return {
        kind: 'riskOfRuin',
        bankrollBb: requireNumber(problems, `${path}.bankrollBb`, raw['bankrollBb'], {
          min: 0,
          max: 1_000_000,
        }),
        winRateBbPer100: requireNumber(problems, `${path}.winRateBbPer100`, raw['winRateBbPer100'], {
          min: -200,
          max: 200,
        }),
        standardDeviationBbPer100: requireNumber(
          problems,
          `${path}.standardDeviationBbPer100`,
          raw['standardDeviationBbPer100'],
          { min: 0.01, max: 500 },
        ),
      };
  }
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

const BLOCK_KINDS = [
  'prose',
  'heading',
  'list',
  'formula',
  'callout',
  'liveCalculation',
  'scenarioLink',
] as const;
const CALLOUT_TONES = ['insight', 'warning', 'misconception'] as const;

function validateLessonBlock(problems: Problems, path: string, raw: unknown): LessonBlock {
  if (!isRecord(raw)) {
    problems.add(path, `expected an object, got ${describe(raw)}`);
    return { kind: 'prose', text: '' };
  }
  const kind = requireOneOf(problems, `${path}.kind`, raw['kind'], BLOCK_KINDS);
  switch (kind) {
    case 'prose':
      return { kind, text: requireString(problems, `${path}.text`, raw['text'], { min: 1, max: 4000 }) };
    case 'heading':
      return { kind, text: requireString(problems, `${path}.text`, raw['text'], { max: 120 }) };
    case 'list': {
      const items = requireStringArray(problems, `${path}.items`, raw['items'], { min: 1, max: 30 });
      const ordered = raw['ordered'];
      return { kind, items, ...(typeof ordered === 'boolean' ? { ordered } : {}) };
    }
    case 'formula':
      return {
        kind,
        expression: requireString(problems, `${path}.expression`, raw['expression'], { max: 300 }),
        explanation: requireString(problems, `${path}.explanation`, raw['explanation'], { max: 2000 }),
      };
    case 'callout':
      return {
        kind,
        tone: requireOneOf(problems, `${path}.tone`, raw['tone'], CALLOUT_TONES),
        title: requireString(problems, `${path}.title`, raw['title'], { max: 120 }),
        text: requireString(problems, `${path}.text`, raw['text'], { max: 2000 }),
      };
    case 'liveCalculation':
      return {
        kind,
        calculation: validateLiveCalculation(problems, `${path}.calculation`, raw['calculation']),
        caption: requireString(problems, `${path}.caption`, raw['caption'], { max: 700 }),
      };
    default:
      return {
        kind: 'scenarioLink',
        scenarioId: requireContentId(problems, `${path}.scenarioId`, raw['scenarioId']),
        prompt: requireString(problems, `${path}.prompt`, raw['prompt'], { max: 300 }),
      };
  }
}

const DIFFICULTIES = ['intro', 'core', 'advanced'] as const;

function validateLesson(problems: Problems, path: string, raw: unknown): Lesson {
  if (!isRecord(raw)) {
    problems.add(path, `expected an object, got ${describe(raw)}`);
    return {
      id: '',
      title: '',
      summary: '',
      topic: 'rules-and-flow',
      difficulty: 'intro',
      estimatedMinutes: 1,
      prerequisites: [],
      blocks: [],
      keyTakeaways: [],
      glossaryTerms: [],
    };
  }
  const blocksRaw = Array.isArray(raw['blocks']) ? raw['blocks'] : [];
  if (!Array.isArray(raw['blocks'])) problems.add(`${path}.blocks`, 'expected an array of blocks');
  if (blocksRaw.length === 0) problems.add(`${path}.blocks`, 'a lesson needs at least one block');

  const quizId = raw['quizId'];
  return {
    id: requireContentId(problems, `${path}.id`, raw['id']),
    title: requireString(problems, `${path}.title`, raw['title'], { max: 120 }),
    summary: requireString(problems, `${path}.summary`, raw['summary'], { min: 10, max: 400 }),
    topic: requireOneOf(problems, `${path}.topic`, raw['topic'], TOPICS),
    difficulty: requireOneOf(problems, `${path}.difficulty`, raw['difficulty'], DIFFICULTIES),
    estimatedMinutes: requireInteger(problems, `${path}.estimatedMinutes`, raw['estimatedMinutes'], {
      min: 1,
      max: 120,
    }),
    prerequisites: (Array.isArray(raw['prerequisites']) ? raw['prerequisites'] : []).map((id, index) =>
      requireContentId(problems, `${path}.prerequisites[${index}]`, id),
    ),
    blocks: blocksRaw.map((block, index) => validateLessonBlock(problems, `${path}.blocks[${index}]`, block)),
    keyTakeaways: requireStringArray(problems, `${path}.keyTakeaways`, raw['keyTakeaways'], {
      min: 2,
      max: 10,
    }),
    glossaryTerms: (Array.isArray(raw['glossaryTerms']) ? raw['glossaryTerms'] : []).map((id, index) =>
      requireContentId(problems, `${path}.glossaryTerms[${index}]`, id),
    ),
    ...(typeof quizId === 'string' ? { quizId: requireContentId(problems, `${path}.quizId`, quizId) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Quizzes
// ---------------------------------------------------------------------------

const QUESTION_KINDS = ['multipleChoice', 'numeric', 'decision'] as const;
const UNITS = ['percent', 'chips', 'ratio', 'count', 'hands'] as const;

function validateQuizQuestion(problems: Problems, path: string, raw: unknown): QuizQuestion {
  if (!isRecord(raw)) {
    problems.add(path, `expected an object, got ${describe(raw)}`);
    return { kind: 'multipleChoice', id: '', prompt: '', options: [], correctIndex: 0, explanation: '' };
  }
  const kind = requireOneOf(problems, `${path}.kind`, raw['kind'], QUESTION_KINDS);
  const id = requireContentId(problems, `${path}.id`, raw['id']);
  const prompt = requireString(problems, `${path}.prompt`, raw['prompt'], { min: 5, max: 1200 });
  const explanation = requireString(problems, `${path}.explanation`, raw['explanation'], {
    min: 10,
    max: 2000,
  });

  if (kind === 'multipleChoice') {
    const options = requireStringArray(problems, `${path}.options`, raw['options'], { min: 2, max: 6 });
    const correctIndex = requireInteger(problems, `${path}.correctIndex`, raw['correctIndex'], { min: 0 });
    if (options.length > 0 && correctIndex >= options.length) {
      problems.add(`${path}.correctIndex`, `${correctIndex} is out of range for ${options.length} options`);
    }
    const optionNotes = raw['optionNotes'];
    return {
      kind,
      id,
      prompt,
      options,
      correctIndex,
      explanation,
      ...(Array.isArray(optionNotes)
        ? { optionNotes: requireStringArray(problems, `${path}.optionNotes`, optionNotes, { max: 6 }) }
        : {}),
    };
  }
  if (kind === 'numeric') {
    return {
      kind,
      id,
      prompt,
      explanation,
      calculation: validateLiveCalculation(problems, `${path}.calculation`, raw['calculation']),
      field: requireString(problems, `${path}.field`, raw['field'], { max: 60 }),
      unit: requireOneOf(problems, `${path}.unit`, raw['unit'], UNITS),
      tolerance: requireNumber(problems, `${path}.tolerance`, raw['tolerance'], { min: 0, max: 1000 }),
    };
  }
  return {
    kind: 'decision',
    id,
    prompt,
    explanation,
    scenarioId: requireContentId(problems, `${path}.scenarioId`, raw['scenarioId']),
  };
}

function validateQuiz(problems: Problems, path: string, raw: unknown): Quiz {
  if (!isRecord(raw)) {
    problems.add(path, `expected an object, got ${describe(raw)}`);
    return { id: '', title: '', topic: 'rules-and-flow', questions: [], reviewAdvice: '' };
  }
  const questionsRaw = Array.isArray(raw['questions']) ? raw['questions'] : [];
  if (!Array.isArray(raw['questions'])) problems.add(`${path}.questions`, 'expected an array');
  if (questionsRaw.length === 0) problems.add(`${path}.questions`, 'a quiz needs at least one question');
  const lessonId = raw['lessonId'];
  return {
    id: requireContentId(problems, `${path}.id`, raw['id']),
    title: requireString(problems, `${path}.title`, raw['title'], { max: 120 }),
    topic: requireOneOf(problems, `${path}.topic`, raw['topic'], TOPICS),
    questions: questionsRaw.map((question, index) =>
      validateQuizQuestion(problems, `${path}.questions[${index}]`, question),
    ),
    reviewAdvice: requireString(problems, `${path}.reviewAdvice`, raw['reviewAdvice'], {
      min: 10,
      max: 1000,
    }),
    ...(typeof lessonId === 'string'
      ? { lessonId: requireContentId(problems, `${path}.lessonId`, lessonId) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const STREETS = ['preflop', 'flop', 'turn', 'river'] as const;
const CLAIM_KINDS = [
  'equityBetween',
  'breakEvenEquityBetween',
  'callEvSign',
  'cleanOutsEquals',
  'dirtyOutsAtLeast',
  'equityExceedsBreakEven',
  'breakEvenExceedsEquity',
  'sprBetween',
  'ruleOf24ErrorAtMost',
] as const;

/** Community cards required for each street. A mismatch is a content bug. */
export const BOARD_LENGTH_BY_STREET: Readonly<Record<(typeof STREETS)[number], number>> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

function validateRangeSpec(problems: Problems, path: string, raw: unknown): RangeSpec {
  if (!isRecord(raw)) {
    problems.add(path, `expected an object, got ${describe(raw)}`);
    return { kind: 'notation', notation: 'random', label: 'any hand' };
  }
  const kind = requireOneOf(problems, `${path}.kind`, raw['kind'], [
    'exact',
    'notation',
    'topPercent',
  ] as const);
  if (kind === 'exact') {
    const cards = requireString(problems, `${path}.cards`, raw['cards'], { max: 24 });
    const parsed = parseCardsSafely(problems, `${path}.cards`, cards);
    if (parsed.length !== 0 && parsed.length !== 2) {
      problems.add(`${path}.cards`, `an exact range needs exactly 2 cards, got ${parsed.length}`);
    }
    return { kind, cards };
  }
  if (kind === 'notation') {
    return {
      kind,
      notation: requireString(problems, `${path}.notation`, raw['notation'], { max: 200 }),
      label: requireString(problems, `${path}.label`, raw['label'], { max: 120 }),
    };
  }
  return {
    kind: 'topPercent',
    percent: requireNumber(problems, `${path}.percent`, raw['percent'], { min: 0.1, max: 100 }),
    label: requireString(problems, `${path}.label`, raw['label'], { max: 120 }),
  };
}

function validateScenarioSeat(problems: Problems, path: string, raw: unknown): ScenarioSeat {
  if (!isRecord(raw)) {
    problems.add(path, `expected an object, got ${describe(raw)}`);
    return { seat: 0, label: '', stack: 0 };
  }
  const isHero = raw['isHero'];
  const holeCards = raw['holeCards'];
  const profile = raw['profile'];
  return {
    seat: requireInteger(problems, `${path}.seat`, raw['seat'], { min: 0, max: 5 }),
    label: requireString(problems, `${path}.label`, raw['label'], { max: 16 }),
    // min 0, not 1. `stack` is chips BEHIND (see ScenarioSeat in @prl/contracts),
    // so a seat that is all in has exactly 0 — and a floor of 1 made the only
    // correct way to write an all-in opponent unrepresentable. That is not a
    // hypothetical: five shipped scenarios described a seat as moving all in and
    // then gave it its whole stack again as chips behind, which fed effectiveStack
    // and every fold-equity figure derived from it. checkSituationCoherence below
    // now REQUIRES 0 for a seat the scenario narrates as all in, so this is a
    // narrower rule than the one it replaces, not a looser one.
    stack: requireInteger(problems, `${path}.stack`, raw['stack'], { min: 0, max: 10_000_000 }),
    ...(typeof isHero === 'boolean' ? { isHero } : {}),
    ...(typeof holeCards === 'string' ? { holeCards } : {}),
    ...(typeof profile === 'string'
      ? { profile: requireOneOf(problems, `${path}.profile`, profile, OPPONENT_PROFILES) }
      : {}),
  };
}

function validateScenarioClaim(problems: Problems, path: string, raw: unknown): ScenarioClaim {
  if (!isRecord(raw)) {
    problems.add(path, `expected an object, got ${describe(raw)}`);
    return { kind: 'equityExceedsBreakEven' };
  }
  const kind = requireOneOf(problems, `${path}.kind`, raw['kind'], CLAIM_KINDS);
  switch (kind) {
    case 'equityBetween':
    case 'breakEvenEquityBetween': {
      const min = requireNumber(problems, `${path}.min`, raw['min'], { min: 0, max: 1 });
      const max = requireNumber(problems, `${path}.max`, raw['max'], { min: 0, max: 1 });
      if (min > max) problems.add(path, `min ${min} is above max ${max}`);
      return { kind, min, max };
    }
    case 'sprBetween': {
      const min = requireNumber(problems, `${path}.min`, raw['min'], { min: 0, max: 10_000 });
      const max = requireNumber(problems, `${path}.max`, raw['max'], { min: 0, max: 10_000 });
      if (min > max) problems.add(path, `min ${min} is above max ${max}`);
      return { kind, min, max };
    }
    case 'callEvSign':
      return {
        kind,
        expect: requireOneOf(problems, `${path}.expect`, raw['expect'], [
          'positive',
          'negative',
          'breakEven',
        ] as const),
      };
    case 'cleanOutsEquals':
      return { kind, outs: requireInteger(problems, `${path}.outs`, raw['outs'], { min: 0, max: 47 }) };
    case 'dirtyOutsAtLeast':
      return { kind, outs: requireInteger(problems, `${path}.outs`, raw['outs'], { min: 0, max: 47 }) };
    case 'ruleOf24ErrorAtMost':
      return {
        kind,
        maxErrorPoints: requireNumber(problems, `${path}.maxErrorPoints`, raw['maxErrorPoints'], {
          min: 0,
          max: 100,
        }),
      };
    default:
      return { kind };
  }
}

// ---------------------------------------------------------------------------
// Scenario coherence
//
// Shape is not the interesting failure mode for a scenario. A scenario can be
// perfectly shaped and still describe a table that cannot exist — and that kind of
// defect is invisible in review, because the prose reads correctly and only the
// numbers underneath it disagree.
//
// The release audit found exactly that. `rk-nine-big-blinds-call-or-fold` said
// "the small blind moves all in for 7,200, which is their whole stack" and then
// recorded that seat with 7,200 still BEHIND, so every figure derived from the
// effective stack was computed against an opponent who had twice what they had.
// It was titled "Nine big blinds" while giving hero 13.5 of them. Nothing failed.
//
// The checks below are the ones that can be made mechanically from what a scenario
// already states about itself: the price against the committed chips, the stated
// all-ins against the chips behind, the narrated bet sizes against the pot, and any
// stack depth quoted in words against the blinds. Where a claim is not mechanically
// checkable it is left alone rather than guessed at — a content gate that cries wolf
// gets a blanket suppression, which is worse than not having it.
// ---------------------------------------------------------------------------

/** "moves all in for 7,200", "is all-in for 220". The comma is how the data writes it. */
const ALL_IN_FOR = /all[-\s]?in for ([\d,]+)/gi;
/** "bets 25 into a pot of 120", "bet 55 into 110", "leads out for 25 into a pot of 110". */
const WAGER_INTO_POT =
  /(?:bets?|leads out for|all[-\s]?in for)\s+([\d,]+)\s+into\s+(?:a pot of\s+)?([\d,]+)/gi;
/** The scenario stating outright that hero's call is for everything. */
const CALLING_IS_ALL_IN = /calling puts hero all[-\s]?in/i;

/**
 * A stack depth quoted in words: "Nine big blinds", "seventy blinds deep", "12 blinds".
 *
 * The quantity is the only capture. An optional group for the preceding qualifier
 * looked tidier and was wrong: being greedy, it took "Nine" out of "Nine big blinds"
 * and left "big" as the number, so the phrase this whole check exists for was the
 * one it silently skipped. The word before the match is read separately, below.
 */
const STATED_DEPTH = /\b(\d+|[a-z]+(?:-[a-z]+)?)\s+(?:big\s+)?blinds?\b/gi;
/** The word immediately before a match, which is what bounds it (if anything does). */
const WORD_BEFORE = /([a-z-]+)[^a-z-]*$/i;
const DEPTH_QUALIFIERS = new Set([
  'under',
  'over',
  'about',
  'roughly',
  'around',
  'nearly',
  'almost',
  'below',
  'above',
  'than',
  'least',
  'most',
  'to',
]);
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** The number a depth phrase names, or null when the token is not a number at all. */
function readNumberToken(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  const parts = token.toLowerCase().split('-');
  let total = 0;
  for (const part of parts) {
    const value = NUMBER_WORDS[part];
    if (value === undefined) return null;
    total += value;
  }
  return total;
}

/** "7,200" as written in the prose -> 7200. */
const readAmount = (text: string): number => Number(text.replace(/,/g, ''));

interface SeatMoney {
  readonly seat: ScenarioSeat;
  /** What this seat has put in on the current street. */
  readonly committed: number;
  /** Chips at the start of the street: behind plus committed. */
  readonly total: number;
}

function seatMoney(seats: readonly ScenarioSeat[], committed: Record<number, number>): SeatMoney[] {
  return seats.map((seat) => {
    const put = committed[seat.seat] ?? 0;
    return { seat, committed: put, total: seat.stack + put };
  });
}

const describeSeat = (money: SeatMoney): string =>
  `seat ${money.seat.seat} (${money.seat.label}) has ${money.seat.stack} behind and ${money.committed} committed`;

/**
 * The price hero is being asked, against the chips actually on the table.
 *
 * `toCall` is the difference between the largest commitment and hero's own — it is
 * not a free field. And hero cannot be asked for more than hero has behind, which
 * is the check that would have caught a hero stack written as a total.
 */
function checkPrice(problems: Problems, path: string, money: readonly SeatMoney[], scenario: Scenario): void {
  const hero = money.find((entry) => entry.seat.isHero === true);
  if (hero === undefined) return;
  const highest = Math.max(...money.map((entry) => entry.committed));
  const owed = highest - hero.committed;

  if (scenario.toCall !== owed) {
    problems.add(
      `${path}.toCall`,
      `is ${scenario.toCall}, but the largest commitment this street is ${highest} and hero has ` +
        `${hero.committed} in, so hero owes ${owed}`,
    );
  }
  if (scenario.toCall > hero.seat.stack) {
    problems.add(
      `${path}.toCall`,
      `is ${scenario.toCall}, which is more than hero has behind (${hero.seat.stack}). Either the price ` +
        'or the stack is wrong; `stack` is chips behind, never a total.',
    );
  }
  if (CALLING_IS_ALL_IN.test(scenario.facingAction) && scenario.toCall !== hero.seat.stack) {
    problems.add(
      `${path}.facingAction`,
      `says calling puts hero all in, but hero has ${hero.seat.stack} behind and is only being asked ` +
        `for ${scenario.toCall}`,
    );
  }
}

/**
 * Every all-in the prose narrates, against the seat it must belong to.
 *
 * Nothing behind is what "all in" MEANS, so the seat that put in that amount has to
 * have `stack: 0`. This is the check that fails on the defect the audit found.
 */
function checkNarratedAllIns(
  problems: Problems,
  path: string,
  money: readonly SeatMoney[],
  text: string,
): void {
  for (const match of text.matchAll(ALL_IN_FOR)) {
    const amount = readAmount(match[1] ?? '');
    const candidates = money.filter((entry) => entry.committed === amount);
    if (candidates.length !== 1) {
      problems.add(
        `${path}.facingAction`,
        `describes an all-in for ${amount}, but ${candidates.length} seat(s) have committed that ` +
          `this street: ${money.map(describeSeat).join('; ')}`,
      );
      continue;
    }
    const [entry] = candidates;
    if (entry !== undefined && entry.seat.stack !== 0) {
      problems.add(
        `${path}.seats`,
        `${describeSeat(entry)}, but facingAction says that seat moved all in for ${amount}. A seat ` +
          'that is all in has nothing behind: `stack` must be 0. As written, effectiveStack and every ' +
          'fold-equity figure treat this opponent as able to call a bet they cannot.',
      );
    }
  }
}

/** "bets N into a pot of M": N has to be somebody's commitment and M the pot before it. */
function checkNarratedWagers(
  problems: Problems,
  path: string,
  money: readonly SeatMoney[],
  scenario: Scenario,
): void {
  for (const match of scenario.facingAction.matchAll(WAGER_INTO_POT)) {
    const wager = readAmount(match[1] ?? '');
    const pot = readAmount(match[2] ?? '');
    if (!money.some((entry) => entry.committed === wager)) {
      problems.add(
        `${path}.facingAction`,
        `describes a bet of ${wager}, but no seat has committed that this street: ` +
          `${money.map(describeSeat).join('; ')}`,
      );
    }
    if (pot !== scenario.potBeforeStreet) {
      problems.add(
        `${path}.facingAction`,
        `says the bet went into a pot of ${pot}, but potBeforeStreet is ${scenario.potBeforeStreet}`,
      );
    }
  }
}

/** Preflop: the blinds are posted, and nothing but antes can already be in the middle. */
function checkPreflopPosting(
  problems: Problems,
  path: string,
  money: readonly SeatMoney[],
  scenario: Scenario,
): void {
  if (scenario.street !== 'preflop') return;
  const antes = (scenario.ante ?? 0) * money.length;
  if (scenario.potBeforeStreet !== antes) {
    problems.add(
      `${path}.potBeforeStreet`,
      `is ${scenario.potBeforeStreet} on a preflop scenario. Nothing precedes the first betting round ` +
        `except antes, which come to ${antes} here.`,
    );
  }
  const posts: readonly (readonly [string, number])[] = [
    ['SB', scenario.smallBlind],
    ['BB', scenario.bigBlind],
  ];
  for (const [label, blind] of posts) {
    for (const entry of money.filter((seat) => seat.seat.label === label)) {
      if (entry.committed < blind) {
        problems.add(
          `${path}.committedThisStreet`,
          `${describeSeat(entry)}, but a seat labelled ${label} has posted at least ${blind} preflop`,
        );
      }
    }
  }
}

/**
 * A stack depth stated in words, against the blinds.
 *
 * A depth in the TITLE describes hero's spot — that is what a scenario title is —
 * so it is checked against hero. One in the range label describes whoever the range
 * belongs to, so any seat satisfies it. Both readings of a depth are accepted:
 * chips behind, and chips at the start of the street. What is rejected is a number
 * that matches neither, which is how "Nine big blinds" came to be worth 13.5 of them.
 *
 * Half a big blind of slack, because a title rounds and should be allowed to.
 */
function checkStatedDepth(
  problems: Problems,
  path: string,
  money: readonly SeatMoney[],
  scenario: Scenario,
): void {
  const inBlinds = (chips: number): number => chips / scenario.bigBlind;
  const sources: readonly (readonly [string, string, readonly SeatMoney[]])[] = [
    ['title', scenario.title, money.filter((entry) => entry.seat.isHero === true)],
    [
      'opponentRange.label',
      scenario.opponentRange.kind === 'exact' ? '' : scenario.opponentRange.label,
      money,
    ],
  ];

  for (const [field, text, candidates] of sources) {
    for (const match of text.matchAll(STATED_DEPTH)) {
      const before = WORD_BEFORE.exec(text.slice(0, match.index))?.[1] ?? '';
      // "under four big blinds each" describes two seats and names neither, so it
      // is not a claim about any one stack and must not be read as one.
      if (DEPTH_QUALIFIERS.has(before.toLowerCase())) continue;
      const stated = readNumberToken(match[1] ?? '');
      if (stated === null) continue;
      const matches = candidates.some((entry) =>
        [inBlinds(entry.seat.stack), inBlinds(entry.total)].some((depth) => Math.abs(depth - stated) < 0.5),
      );
      if (matches) continue;
      problems.add(
        `${path}.${field}`,
        `says "${match[0].trim()}", but at a big blind of ${scenario.bigBlind} that is ${
          stated * scenario.bigBlind
        } chips and no ${field === 'title' ? 'hero stack' : 'seat'} here holds it: ` +
          `${candidates.map((entry) => `${entry.seat.label} ${entry.seat.stack} behind / ${entry.total} total`).join('; ')}`,
      );
    }
  }
}

/**
 * Everything above, plus the two invariants that need no prose to check.
 * Skipped entirely when the shape checks already failed: coherence errors derived
 * from a scenario that has no hero would be noise on top of the real problem.
 */
function checkSituationCoherence(problems: Problems, path: string, scenario: Scenario): void {
  const heroes = scenario.seats.filter((seat) => seat.isHero === true);
  if (scenario.seats.length < 2 || heroes.length !== 1) return;

  if (scenario.bigBlind <= scenario.smallBlind) {
    problems.add(
      `${path}.bigBlind`,
      `is ${scenario.bigBlind}, which is not above the small blind of ${scenario.smallBlind}`,
    );
  }

  const committed = scenario.committedThisStreet ?? {};
  const seatNumbers = new Set(scenario.seats.map((seat) => seat.seat));
  for (const key of Object.keys(committed)) {
    if (!seatNumbers.has(Number(key))) {
      problems.add(`${path}.committedThisStreet`, `seat ${key} is not at this table`);
    }
  }

  const money = seatMoney(scenario.seats, committed);
  for (const entry of money) {
    // A seat with nothing behind and nothing in front of it is not in the hand,
    // and it drags the effective stack to zero for everyone else.
    if (entry.seat.stack === 0 && entry.committed === 0) {
      problems.add(
        `${path}.seats`,
        `${describeSeat(entry)} — a seat with nothing behind and nothing committed is not in the hand`,
      );
    }
  }

  checkPrice(problems, path, money, scenario);
  checkNarratedAllIns(problems, path, money, scenario.facingAction);
  checkNarratedWagers(problems, path, money, scenario);
  checkPreflopPosting(problems, path, money, scenario);
  checkStatedDepth(problems, path, money, scenario);
}

function validateScenario(problems: Problems, path: string, raw: unknown): Scenario {
  if (!isRecord(raw)) {
    problems.add(path, `expected an object, got ${describe(raw)}`);
    return emptyScenario();
  }

  const street = requireOneOf(problems, `${path}.street`, raw['street'], STREETS);
  const board = requireString(problems, `${path}.board`, raw['board'], { min: 0, max: 24 });
  const boardCards = parseCardsSafely(problems, `${path}.board`, board);
  const expectedBoardLength = BOARD_LENGTH_BY_STREET[street];
  if (boardCards.length !== expectedBoardLength) {
    problems.add(
      `${path}.board`,
      `street "${street}" needs ${expectedBoardLength} community card(s) but the board has ${boardCards.length}`,
    );
  }

  const seatsRaw = Array.isArray(raw['seats']) ? raw['seats'] : [];
  if (!Array.isArray(raw['seats'])) problems.add(`${path}.seats`, 'expected an array of seats');
  const seats = seatsRaw.map((seat, index) =>
    validateScenarioSeat(problems, `${path}.seats[${index}]`, seat),
  );

  const buttonSeat = requireInteger(problems, `${path}.buttonSeat`, raw['buttonSeat'], { min: 0, max: 5 });
  checkSeatSet(problems, path, seats, buttonSeat);

  const opponentRange = validateRangeSpec(problems, `${path}.opponentRange`, raw['opponentRange']);
  checkNoCardAppearsTwice(problems, path, boardCards, seats, opponentRange);

  const claimsRaw = Array.isArray(raw['expectedInsight']) ? raw['expectedInsight'] : [];
  if (!Array.isArray(raw['expectedInsight'])) problems.add(`${path}.expectedInsight`, 'expected an array');
  const claims = claimsRaw.map((claim, index) =>
    validateScenarioClaim(problems, `${path}.expectedInsight[${index}]`, claim),
  );
  // A clean-out count is only meaningful against one specific hand: against a range,
  // "how many outs" depends on which hand in the range the opponent holds.
  if (opponentRange.kind !== 'exact' && claims.some((claim) => claim.kind === 'cleanOutsEquals')) {
    problems.add(
      `${path}.expectedInsight`,
      'a cleanOutsEquals claim requires an exact opponent hand — against a range the out count is not well defined',
    );
  }

  const committed = readCommittedThisStreet(problems, path, raw['committedThisStreet']);
  const ante = raw['ante'];

  const scenario: Scenario = {
    id: requireContentId(problems, `${path}.id`, raw['id']),
    title: requireString(problems, `${path}.title`, raw['title'], { max: 120 }),
    topic: requireOneOf(problems, `${path}.topic`, raw['topic'], TOPICS),
    difficulty: requireOneOf(problems, `${path}.difficulty`, raw['difficulty'], DIFFICULTIES),
    question: requireString(problems, `${path}.question`, raw['question'], { min: 5, max: 400 }),
    smallBlind: requireInteger(problems, `${path}.smallBlind`, raw['smallBlind'], { min: 1, max: 100_000 }),
    bigBlind: requireInteger(problems, `${path}.bigBlind`, raw['bigBlind'], { min: 1, max: 200_000 }),
    buttonSeat,
    seats,
    board,
    potBeforeStreet: requireInteger(problems, `${path}.potBeforeStreet`, raw['potBeforeStreet'], {
      min: 0,
      max: 10_000_000,
    }),
    street,
    facingAction: requireString(problems, `${path}.facingAction`, raw['facingAction'], { min: 5, max: 400 }),
    toCall: requireInteger(problems, `${path}.toCall`, raw['toCall'], { min: 0, max: 10_000_000 }),
    opponentRange,
    assumptions: requireStringArray(problems, `${path}.assumptions`, raw['assumptions'], { min: 1, max: 8 }),
    reasoning: requireString(problems, `${path}.reasoning`, raw['reasoning'], { min: 40, max: 4000 }),
    expectedInsight: claims,
    commonMistakes: requireStringArray(problems, `${path}.commonMistakes`, raw['commonMistakes'], {
      min: 1,
      max: 6,
    }),
    glossaryTerms: (Array.isArray(raw['glossaryTerms']) ? raw['glossaryTerms'] : []).map((id, index) =>
      requireContentId(problems, `${path}.glossaryTerms[${index}]`, id),
    ),
    ...(typeof ante === 'number'
      ? { ante: requireInteger(problems, `${path}.ante`, ante, { min: 0, max: 100_000 }) }
      : {}),
    ...(Object.keys(committed).length > 0 ? { committedThisStreet: committed } : {}),
  };

  // Last, and on the assembled record rather than on `raw`: every coherence check
  // compares one validated field against another, so running them here means they
  // can trust the types and say something specific about the situation instead of
  // re-deriving it from unknowns.
  checkSituationCoherence(problems, path, scenario);
  return scenario;
}

/** Seat count, seat numbers, exactly one hero with cards, and a button that is at the table. */
function checkSeatSet(
  problems: Problems,
  path: string,
  seats: readonly ScenarioSeat[],
  buttonSeat: number,
): void {
  if (seats.length < 2 || seats.length > 6) {
    problems.add(`${path}.seats`, `needs 2 to 6 seats, has ${seats.length}`);
  }
  const seatNumbers = seats.map((seat) => seat.seat);
  if (new Set(seatNumbers).size !== seatNumbers.length) {
    problems.add(`${path}.seats`, 'two seats share the same seat number');
  }
  const heroes = seats.filter((seat) => seat.isHero === true);
  if (heroes.length !== 1) {
    problems.add(`${path}.seats`, `exactly one seat must have isHero: true, found ${heroes.length}`);
  }
  const hero = heroes[0];
  if (hero !== undefined && (hero.holeCards === undefined || hero.holeCards === '')) {
    problems.add(`${path}.seats`, 'the hero seat must have holeCards');
  }
  if (seatNumbers.length > 0 && !seatNumbers.includes(buttonSeat)) {
    problems.add(`${path}.buttonSeat`, `seat ${buttonSeat} is not one of the seats in this scenario`);
  }
}

/** The check that matters most: no card may appear twice across the board and the seats. */
function checkNoCardAppearsTwice(
  problems: Problems,
  path: string,
  boardCards: readonly Card[],
  seats: readonly ScenarioSeat[],
  opponentRange: RangeSpec,
): void {
  const seen = new Map<Card, string>();
  const noteCards = (cards: readonly Card[], where: string): void => {
    for (const card of cards) {
      const existing = seen.get(card);
      if (existing !== undefined) {
        problems.add(path, `card appears twice — in ${existing} and in ${where}`);
      } else {
        seen.set(card, where);
      }
    }
  };

  noteCards(boardCards, 'the board');
  const seatHoleCards: Card[][] = [];
  for (const [index, seat] of seats.entries()) {
    if (seat.holeCards === undefined || seat.holeCards === '') continue;
    const cards = parseCardsSafely(problems, `${path}.seats[${index}].holeCards`, seat.holeCards);
    if (cards.length !== 2) {
      problems.add(`${path}.seats[${index}].holeCards`, `expected 2 cards, got ${cards.length}`);
    }
    seatHoleCards.push(cards);
    noteCards(cards, `seat ${seat.seat}'s hole cards`);
  }

  if (opponentRange.kind !== 'exact') return;
  const rangeCards = parseCardsSafely(problems, `${path}.opponentRange.cards`, opponentRange.cards);
  // An exact opponent range normally RESTATES the cards already given on that
  // opponent's seat — the same two cards described in two places, not two pairs of
  // cards. Only treat them as additional (and therefore as a possible duplicate)
  // when they do not match any seat's holding, which is the case that really is a
  // content bug: an exact range naming cards nobody at the table holds.
  const restatesASeat = seatHoleCards.some(
    (cards) => cards.length === rangeCards.length && cards.every((card) => rangeCards.includes(card)),
  );
  if (!restatesASeat) noteCards(rangeCards, 'the opponent range');
}

/** `committedThisStreet` as a seat-keyed record, with every key and value checked. */
function readCommittedThisStreet(problems: Problems, path: string, raw: unknown): Record<number, number> {
  const committed: Record<number, number> = {};
  if (raw === undefined) return committed;
  if (!isRecord(raw)) {
    problems.add(`${path}.committedThisStreet`, 'expected an object keyed by seat number');
    return committed;
  }
  for (const [key, value] of Object.entries(raw)) {
    const seat = Number(key);
    if (!Number.isInteger(seat)) {
      problems.add(`${path}.committedThisStreet`, `"${key}" is not a seat number`);
      continue;
    }
    committed[seat] = requireInteger(problems, `${path}.committedThisStreet.${key}`, value, {
      min: 0,
      max: 10_000_000,
    });
  }
  return committed;
}

function emptyScenario(): Scenario {
  return {
    id: '',
    title: '',
    topic: 'rules-and-flow',
    difficulty: 'intro',
    question: '',
    smallBlind: 1,
    bigBlind: 2,
    buttonSeat: 0,
    seats: [],
    board: '',
    potBeforeStreet: 0,
    street: 'preflop',
    facingAction: '',
    toCall: 0,
    opponentRange: { kind: 'notation', notation: 'random', label: 'any hand' },
    assumptions: [],
    reasoning: '',
    expectedInsight: [],
    commonMistakes: [],
    glossaryTerms: [],
  };
}

// ---------------------------------------------------------------------------
// Bundle-level checks
// ---------------------------------------------------------------------------

export interface RawContent {
  readonly lessons: readonly unknown[];
  readonly quizzes: readonly unknown[];
  readonly scenarios: readonly unknown[];
  readonly glossary: readonly unknown[];
  readonly version: string;
}

/**
 * Validates everything and returns a typed bundle, or throws with every problem
 * found. Cross-references (glossary ids, quiz→lesson links, prerequisite cycles) are
 * checked after the individual records, so a broken reference is reported as a
 * reference problem rather than as a missing field somewhere unrelated.
 */
export function validateContent(raw: RawContent): ContentBundle {
  const problems = new Problems();

  const glossary = raw.glossary.map((entry, index) =>
    validateGlossaryEntry(problems, `glossary[${index}]`, entry),
  );
  const lessons = raw.lessons.map((lesson, index) => validateLesson(problems, `lessons[${index}]`, lesson));
  const quizzes = raw.quizzes.map((quiz, index) => validateQuiz(problems, `quizzes[${index}]`, quiz));
  const scenarios = raw.scenarios.map((scenario, index) =>
    validateScenario(problems, `scenarios[${index}]`, scenario),
  );

  assertUniqueIds(problems, 'glossary', glossary);
  assertUniqueIds(problems, 'lessons', lessons);
  assertUniqueIds(problems, 'quizzes', quizzes);
  assertUniqueIds(problems, 'scenarios', scenarios);

  const known: KnownIds = {
    glossary: new Set(glossary.map((entry) => entry.id)),
    lessons: new Set(lessons.map((lesson) => lesson.id)),
    quizzes: new Set(quizzes.map((quiz) => quiz.id)),
    scenarios: new Set(scenarios.map((scenario) => scenario.id)),
  };

  checkLessonReferences(problems, lessons, known);
  checkQuizReferences(problems, quizzes, known);
  checkGlossaryReferences(problems, glossary, scenarios, known);

  detectPrerequisiteCycles(problems, lessons);
  problems.throwIfAny();

  return { version: raw.version, lessons, quizzes, scenarios, glossary };
}

/** The id sets every cross-reference check is resolved against. */
interface KnownIds {
  readonly glossary: ReadonlySet<ContentId>;
  readonly lessons: ReadonlySet<ContentId>;
  readonly quizzes: ReadonlySet<ContentId>;
  readonly scenarios: ReadonlySet<ContentId>;
}

function checkGlossaryTerms(
  problems: Problems,
  known: KnownIds,
  where: string,
  ids: readonly ContentId[],
): void {
  for (const id of ids) {
    if (!known.glossary.has(id)) {
      problems.add(where, `references glossary term "${id}", which does not exist`);
    }
  }
}

function checkLessonReferences(problems: Problems, lessons: readonly Lesson[], known: KnownIds): void {
  for (const lesson of lessons) {
    checkGlossaryTerms(problems, known, `lesson "${lesson.id}".glossaryTerms`, lesson.glossaryTerms);
    for (const prerequisite of lesson.prerequisites) {
      if (!known.lessons.has(prerequisite)) {
        problems.add(
          `lesson "${lesson.id}".prerequisites`,
          `references lesson "${prerequisite}", which does not exist`,
        );
      }
    }
    if (lesson.quizId !== undefined && !known.quizzes.has(lesson.quizId)) {
      problems.add(
        `lesson "${lesson.id}".quizId`,
        `references quiz "${lesson.quizId}", which does not exist`,
      );
    }
    for (const block of lesson.blocks) {
      if (block.kind === 'scenarioLink' && !known.scenarios.has(block.scenarioId)) {
        problems.add(`lesson "${lesson.id}"`, `links scenario "${block.scenarioId}", which does not exist`);
      }
    }
  }
}

function checkQuizReferences(problems: Problems, quizzes: readonly Quiz[], known: KnownIds): void {
  for (const quiz of quizzes) {
    if (quiz.lessonId !== undefined && !known.lessons.has(quiz.lessonId)) {
      problems.add(
        `quiz "${quiz.id}".lessonId`,
        `references lesson "${quiz.lessonId}", which does not exist`,
      );
    }
    for (const question of quiz.questions) {
      if (question.kind === 'decision' && !known.scenarios.has(question.scenarioId)) {
        problems.add(
          `quiz "${quiz.id}" question "${question.id}"`,
          `references scenario "${question.scenarioId}", which does not exist`,
        );
      }
    }
  }
}

function checkGlossaryReferences(
  problems: Problems,
  glossary: readonly GlossaryEntry[],
  scenarios: readonly Scenario[],
  known: KnownIds,
): void {
  for (const scenario of scenarios) {
    checkGlossaryTerms(problems, known, `scenario "${scenario.id}".glossaryTerms`, scenario.glossaryTerms);
  }
  for (const entry of glossary) {
    for (const id of entry.seeAlso ?? []) {
      if (!known.glossary.has(id)) {
        problems.add(`glossary "${entry.id}".seeAlso`, `references "${id}", which does not exist`);
      }
    }
  }
}

function assertUniqueIds(problems: Problems, where: string, records: readonly { id: string }[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    if (record.id === '') continue;
    if (seen.has(record.id)) problems.add(where, `duplicate id "${record.id}"`);
    seen.add(record.id);
  }
}

/**
 * A prerequisite cycle would make the lesson graph unrenderable and would deadlock
 * any "what should I read next" logic, so it is rejected rather than tolerated.
 */
function detectPrerequisiteCycles(problems: Problems, lessons: readonly Lesson[]): void {
  const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string, path: readonly string[]): void => {
    const status = state.get(id);
    if (status === 'done') return;
    if (status === 'visiting') {
      problems.add('lessons.prerequisites', `cycle: ${[...path, id].join(' → ')}`);
      return;
    }
    state.set(id, 'visiting');
    for (const prerequisite of byId.get(id)?.prerequisites ?? []) {
      if (byId.has(prerequisite)) visit(prerequisite, [...path, id]);
    }
    state.set(id, 'done');
  };

  for (const lesson of lessons) visit(lesson.id, []);
}

/** Validates without throwing, for tooling that wants to report all problems. */
export function collectContentProblems(raw: RawContent): readonly string[] {
  try {
    validateContent(raw);
    return [];
  } catch (error) {
    if (error instanceof ContentValidationError) return error.problems;
    throw error;
  }
}

export function topicsOf(bundle: ContentBundle): readonly Topic[] {
  const seen = new Set<Topic>();
  for (const lesson of bundle.lessons) seen.add(lesson.topic);
  for (const scenario of bundle.scenarios) seen.add(scenario.topic);
  return [...seen];
}
