/**
 * Runtime validation for the content JSON. `resolveJsonModule` types a file by its literal shape,
 * so nothing else proves a record satisfies the contract. Every file passes through here and fails
 * at load time with the path of the bad field.
 * Hand-written rather than a schema library, to keep dependencies out and messages specific.
 * Beyond shape it checks duplicate cards, board length against street, dangling references and
 * prerequisite cycles.
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
import { type Card, CardParseError, cardToString, parseCards } from '@prl/poker-engine';
import { parseRange, RangeParseError, topPercentRange } from '@prl/poker-math';

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

// The `prl.content_id` domain (db/migrations/0001), so every id the bundle serves can be recorded.
const CONTENT_ID = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function requireContentId(problems: Problems, path: string, value: unknown): ContentId {
  const text = requireString(problems, path, value, { max: 63 });
  if (text !== '' && !CONTENT_ID.test(text)) {
    problems.add(
      path,
      `"${text}" is not a valid id (lower-case letters, digits and hyphens, at most 63 characters, ` +
        'not starting or ending with a hyphen)',
    );
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

/**
 * A string of exactly two cards, as `exactRange` and the equity planner require of a holding. Blank or
 * separator-only text parses as no cards without a problem, so the length is checked only when nothing
 * was reported, and each bad holding is reported once.
 */
function requireHolding(problems: Problems, path: string, raw: unknown): { text: string; cards: Card[] } {
  const before = problems.count;
  const text = requireString(problems, path, raw, { max: 24 });
  const cards = problems.count === before ? parseCardsSafely(problems, path, text) : [];
  if (problems.count === before && cards.length !== 2) {
    problems.add(path, `a holding is exactly 2 cards, got ${cards.length}`);
  }
  if (problems.count === before && cards[0] === cards[1]) {
    problems.add(path, `a holding is two different cards, got "${text}"`);
  }
  // A refused holding passes no cards on, so the distinct-card check does not report it again.
  return { text, cards: problems.count === before ? cards : [] };
}

/** The cards of a holding `requireHolding` accepted. A refused one was reported there, so it adds none. */
function acceptedHolding(text: string | undefined): Card[] {
  if (text === undefined) return [];
  try {
    const cards = parseCards(text);
    return cards.length === 2 && cards[0] !== cards[1] ? cards : [];
  } catch {
    return [];
  }
}

/** An equity opponent, refused in words a content author can act on when it is written as a range. */
function requireExactOpponent(
  problems: Problems,
  path: string,
  raw: unknown,
): { text: string; cards: Card[] } {
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      parseCards(raw);
    } catch (error) {
      // The parser's reason is kept, so a mistyped card reads as a typo and not only as a range.
      const reason = error instanceof CardParseError ? error.message : String(error);
      problems.add(
        path,
        `an equity opponent is an exact two-card hand such as "QsJc", because the browser cannot compute ` +
          `a range or a top percentage, got "${raw}" (${reason})`,
      );
      return { text: raw, cards: [] };
    }
  }
  return requireHolding(problems, path, raw);
}

function checkCardsDistinct(
  problems: Problems,
  path: string,
  groups: readonly (readonly [string, readonly Card[]])[],
): void {
  const seen = new Map<Card, string>();
  for (const [where, cards] of groups) {
    for (const card of cards) {
      const existing = seen.get(card);
      if (existing === undefined) seen.set(card, where);
      else problems.add(path, `card ${cardToString(card)} appears twice — in ${existing} and in ${where}`);
    }
  }
}

/** A range that `parseRange` would throw on, or that the blockers leave empty, fails at load, not on use. */
function checkRangeDealable(
  problems: Problems,
  path: string,
  notation: string,
  blockers: readonly Card[],
): void {
  try {
    if (parseRange(notation, blockers).combos.length === 0) {
      problems.add(path, `every hand in "${notation}" uses a card hero or the board already holds`);
    }
  } catch (error) {
    if (!(error instanceof RangeParseError)) throw error;
    problems.add(path, `could not parse range "${notation}": ${error.message}`);
  }
}

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

function validateEquityCalculation(
  problems: Problems,
  path: string,
  raw: Record<string, unknown>,
): Extract<LiveCalculation, { kind: 'equity' }> {
  const { text: heroCards, cards: hero } = requireHolding(problems, `${path}.heroCards`, raw['heroCards']);
  // Exact holdings only: the browser computes a lesson's equity with `exactRange`, which takes no range
  // or `top:NN`, although the API's planner would.
  const listed = Array.isArray(raw['opponents']) ? raw['opponents'] : [];
  if (!Array.isArray(raw['opponents'])) {
    problems.add(`${path}.opponents`, `expected an array, got ${describe(raw['opponents'])}`);
  } else if (listed.length < 1 || listed.length > 5) {
    problems.add(`${path}.opponents`, `an equity calculation has 1 to 5 opponents, got ${listed.length}`);
  }
  const held = listed.map((opponent, index) =>
    requireExactOpponent(problems, `${path}.opponents[${index}]`, opponent),
  );
  const opponents = held.map((holding) => holding.text);
  // Preflop is a board left out. A present board that is not a string, or names no cards, is refused,
  // because the calculators would otherwise run it as preflop. Each bad board is reported once.
  const before = problems.count;
  const board =
    raw['board'] === undefined
      ? undefined
      : requireString(problems, `${path}.board`, raw['board'], { max: 24 });
  const boardCards =
    board === undefined || problems.count > before ? [] : parseCardsSafely(problems, `${path}.board`, board);
  if (board !== undefined && problems.count === before && ![3, 4, 5].includes(boardCards.length)) {
    problems.add(
      `${path}.board`,
      `an equity board is left out before the flop, or has 3, 4 or 5 cards, got ${boardCards.length}`,
    );
  }
  const seen: [string, readonly Card[]][] = [
    ['heroCards', hero],
    ['board', problems.count === before ? boardCards : []],
  ];
  for (const [index, holding] of held.entries()) seen.push([`opponents[${index}]`, holding.cards]);
  checkCardsDistinct(problems, path, seen);
  return { kind: 'equity', heroCards, opponents, ...(board === undefined ? {} : { board }) };
}

function missingOutsOpponent(problems: Problems, path: string): { text: string; cards: Card[] } {
  problems.add(
    path,
    'an outs calculation names the opponent\'s exact two cards, such as "AsKs", because a card is a clean or a dirty out only against one hand',
  );
  return { text: '', cards: [] };
}

function validateOutsCalculation(
  problems: Problems,
  path: string,
  raw: Record<string, unknown>,
): Extract<LiveCalculation, { kind: 'outs' }> {
  const { text: heroCards, cards: hero } = requireHolding(problems, `${path}.heroCards`, raw['heroCards']);
  // Blank or separator-only text parses as no cards without a problem, so a report is counted, not guessed.
  const before = problems.count;
  const board = requireString(problems, `${path}.board`, raw['board'], { max: 24 });
  const boardCards = problems.count === before ? parseCardsSafely(problems, `${path}.board`, board) : [];
  if (problems.count === before && boardCards.length !== 3 && boardCards.length !== 4) {
    problems.add(
      `${path}.board`,
      `outs are counted on a flop or a turn, 3 or 4 cards, got ${boardCards.length}`,
    );
  }
  const boardAccepted = problems.count === before;
  const named =
    raw['opponentCards'] === undefined
      ? missingOutsOpponent(problems, `${path}.opponentCards`)
      : requireHolding(problems, `${path}.opponentCards`, raw['opponentCards']);
  checkCardsDistinct(problems, path, [
    ['heroCards', hero],
    ['board', boardAccepted ? boardCards : []],
    ['opponentCards', named.cards],
  ]);
  return { kind: 'outs', heroCards, board, opponentCards: named.text };
}

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
    case 'equity':
      return validateEquityCalculation(problems, path, raw);
    case 'outs':
      return validateOutsCalculation(problems, path, raw);
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
        ...(raw['title'] === undefined
          ? {}
          : { title: requireString(problems, `${path}.title`, raw['title'], { max: 80 }) }),
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
    const notes = Array.isArray(optionNotes)
      ? requireStringArray(problems, `${path}.optionNotes`, optionNotes, { max: 6 })
      : null;
    if (notes !== null && options.length > 0) {
      // `optionNotes[i]` explains `options[i]`. These checks do not catch a reversed `options` array
      // with notes and `correctIndex` left alone. That needs the answer pinned by text, not position.
      if (notes.length !== options.length) {
        problems.add(
          `${path}.optionNotes`,
          `${notes.length} note(s) for ${options.length} option(s); they are read positionally`,
        );
      }
      // The note on the right answer opens with "Correct:". Asserting it makes a reordered notes array
      // visible, so it is not left to review.
      const marked = notes.findIndex((note) => note.trimStart().startsWith('Correct:'));
      if (marked !== -1 && marked !== correctIndex) {
        problems.add(
          `${path}.optionNotes`,
          `the note beginning "Correct:" is at ${marked} and correctIndex is ${correctIndex}`,
        );
      }
    }
    return {
      kind,
      id,
      prompt,
      options,
      correctIndex,
      explanation,
      ...(notes !== null ? { optionNotes: notes } : {}),
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
    return { kind, cards: requireHolding(problems, `${path}.cards`, raw['cards']).text };
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
  const folded = raw['folded'];
  const holeCards = raw['holeCards'];
  const profile = raw['profile'];
  // Refused rather than dropped, because a seat silently kept in the hand is priced as a caller.
  if (folded !== undefined && typeof folded !== 'boolean') {
    problems.add(`${path}.folded`, `expected true or false, got ${describe(folded)}`);
  }
  return {
    seat: requireInteger(problems, `${path}.seat`, raw['seat'], { min: 0, max: 5 }),
    label: requireString(problems, `${path}.label`, raw['label'], { max: 16 }),
    // min 0, because `stack` is chips behind and an all-in seat has exactly 0.
    stack: requireInteger(problems, `${path}.stack`, raw['stack'], { min: 0, max: 10_000_000 }),
    ...(typeof isHero === 'boolean' ? { isHero } : {}),
    ...(typeof folded === 'boolean' ? { folded } : {}),
    // Refused rather than dropped, which would load the seat as one whose cards are unknown.
    ...(holeCards === undefined
      ? {}
      : { holeCards: requireHolding(problems, `${path}.holeCards`, holeCards).text }),
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

// Scenario coherence. A well-shaped scenario can still describe a table that cannot exist, and the
// prose hides it. These checks compare what a scenario states about itself: the price against the
// commitments, narrated all-ins against chips behind, narrated bets against the pot, and depth in
// words against the blinds. A claim that cannot be checked mechanically is left alone, so the gate
// raises no false alarms.

/** "moves all in for 7,200", "is all-in for 220". The comma is how the data writes it. */
const ALL_IN_FOR = /all[-\s]?in for ([\d,]+)/gi;
/** "bets 25 into a pot of 120", "bet 55 into 110", "leads out for 25 into a pot of 110". */
const WAGER_INTO_POT =
  /(?:bets?|leads out for|all[-\s]?in for)\s+([\d,]+)\s+into\s+(?:a pot of\s+)?([\d,]+)/gi;
/** The scenario saying hero's call is for everything. Prose says `you` as well as `hero`. */
const CALLING_IS_ALL_IN = /calling puts (?:hero|you) all[-\s]?in/i;

/**
 * A stack depth in words, such as "Nine big blinds" or "12 blinds". The quantity is the only capture.
 * A greedy qualifier group would take "Nine" and leave "big" as the number, so the word before the
 * match is read separately.
 */
const STATED_DEPTH = /\b(\d+|[a-z]+(?:-[a-z]+)?)\s+(?:big\s+)?blinds?\b/gi;
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

/** Null when the token is not a number. */
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

/** `toCall` must equal the largest commitment minus hero's, and cannot exceed hero's stack behind. */
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

/** Every all-in the prose narrates needs a seat with that commitment and `stack: 0`. */
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
 * A depth in the title is checked against hero, one in the range label against any seat. Chips behind
 * and chips at the start of the street both count. Half a big blind of slack, because titles round.
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
      // "under four big blinds each" is not a claim about any one stack.
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

/** An assumption that the stated range is what continues against a bet, in the words the scenarios use. */
const NEVER_FOLDS = /\b(?:does|will) not fold\b/iu;

/** The prose and the field price the same opponent, or bets are priced against hands the prose keeps in. */
function checkDeclaredContinuing(problems: Problems, path: string, scenario: Scenario): void {
  const said = scenario.assumptions.some((assumption) => NEVER_FOLDS.test(assumption));
  if (said && scenario.wholeRangeContinues !== true) {
    problems.add(
      `${path}.wholeRangeContinues`,
      'must be true: an assumption says the opponent does not fold, and without it a bet is priced as ' +
        'if the weaker part of the range folded',
    );
  }
  if (!said && scenario.wholeRangeContinues === true) {
    problems.add(
      `${path}.wholeRangeContinues`,
      'is set, but no assumption says the opponent does not fold, so the learner is never told why ' +
        'every size is priced against the whole range',
    );
  }
}

/** A fold rate stated in an assumption, in the words the scenarios use: "an assumed 30% chance ... fold". */
const STATED_FOLD_RATE = /\bassumed (\d+(?:\.\d+)?)% chance\b[^.]*\bfold/iu;

/** The prose and the field state one rate, or the table prices a figure the learner is never shown. */
function checkStatedFoldRate(problems: Problems, path: string, scenario: Scenario): void {
  const field = scenario.assumedFoldEquity;
  const stated = scenario.assumptions.flatMap((assumption) => {
    const percent = STATED_FOLD_RATE.exec(assumption)?.[1];
    return percent === undefined ? [] : [Number(percent)];
  });
  for (const percent of stated) {
    if (field !== undefined && Math.abs(field * 100 - percent) < 1e-9) continue;
    problems.add(
      `${path}.assumedFoldEquity`,
      field === undefined
        ? `must be ${percent / 100}: an assumption states a ${percent}% fold rate, and without it every ` +
            'bet and raise is priced at the default rate instead'
        : `is ${field}, but an assumption states a ${percent}% fold rate`,
    );
  }
  if (stated.length === 0 && field !== undefined) {
    problems.add(
      `${path}.assumedFoldEquity`,
      `is ${field}, but no assumption states the rate, so the learner is never told what every bet and ` +
        'raise is priced at',
    );
  }
}

type SetAsideAction = NonNullable<Scenario['actionsSetAside']>[number];

const GERUND_OF: Readonly<Record<SetAsideAction, string>> = {
  call: 'calling',
  bet: 'betting',
  raise: 'raising',
};

/** "raising is not being evaluated", "betting and raising are not being evaluated", "a, b and c are ...". */
function setAsideSentence(actions: readonly SetAsideAction[]): string {
  const gerunds = actions.map((action) => GERUND_OF[action]);
  const listed =
    gerunds.length === 1 ? gerunds.join('') : `${gerunds.slice(0, -1).join(', ')} and ${gerunds.at(-1)}`;
  return `${listed} ${gerunds.length === 1 ? 'is' : 'are'} not being evaluated`;
}

/** Any mention of evaluating, in any tense. Counted, so no second statement about it goes unread. */
const EVALUAT = /evaluat/giu;

/**
 * The field is the source of truth, and free wording cannot be read reliably: every partial match let
 * some sentence add or drop an action. So the one assumption that says it is anchored at both ends,
 * exactly "Raising is not being evaluated here." or ending "; raising is not being evaluated here.",
 * and no other assumption may mention evaluating at all.
 */
function checkDeclaredSetAside(problems: Problems, path: string, scenario: Scenario): void {
  const at = `${path}.actionsSetAside`;
  const field = scenario.actionsSetAside;
  const mentions = scenario.assumptions.reduce(
    (total, text) => total + [...text.matchAll(EVALUAT)].length,
    0,
  );
  if (field === undefined) {
    if (mentions > 0) {
      problems.add(
        at,
        'is missing, but an assumption mentions what is evaluated; if it sets actions aside, name them ' +
          'here, or the verdict can still support them',
      );
    }
    return;
  }
  const clause = `${setAsideSentence(field)} here.`;
  const whole = `${clause.charAt(0).toUpperCase()}${clause.slice(1)}`;
  const declares = scenario.assumptions.some((text) => text === whole || text.endsWith(`; ${clause}`));
  if (!declares || mentions !== 1) {
    problems.add(
      at,
      `is ${JSON.stringify(field)}, so one assumption must be "${whole}" or end "; ${clause}", ` +
        'and no other may mention what is evaluated, or the learner is not told exactly what the verdict ' +
        'leaves out',
    );
  }
}

/** Skipped when the shape checks failed, since coherence errors on top of those are noise. */
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
    // A seat with no chips anywhere would drag the effective stack to zero.
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
  checkDeclaredContinuing(problems, path, scenario);
  checkStatedFoldRate(problems, path, scenario);
}

function validateScenario(problems: Problems, path: string, raw: unknown): Scenario {
  if (!isRecord(raw)) {
    problems.add(path, `expected an object, got ${describe(raw)}`);
    return emptyScenario();
  }

  const street = requireOneOf(problems, `${path}.street`, raw['street'], STREETS);
  const beforeBoard = problems.count;
  const board = requireString(problems, `${path}.board`, raw['board'], { min: 0, max: 24 });
  const boardCards = problems.count === beforeBoard ? parseCardsSafely(problems, `${path}.board`, board) : [];
  const expectedBoardLength = BOARD_LENGTH_BY_STREET[street];
  if (problems.count === beforeBoard && boardCards.length !== expectedBoardLength) {
    problems.add(
      `${path}.board`,
      `street "${street}" needs ${expectedBoardLength} community card(s) but the board has ${boardCards.length}`,
    );
  }
  const boardAccepted = problems.count === beforeBoard;

  const seatsRaw = Array.isArray(raw['seats']) ? raw['seats'] : [];
  if (!Array.isArray(raw['seats'])) problems.add(`${path}.seats`, 'expected an array of seats');
  const seats = seatsRaw.map((seat, index) =>
    validateScenarioSeat(problems, `${path}.seats[${index}]`, seat),
  );

  const buttonSeat = requireInteger(problems, `${path}.buttonSeat`, raw['buttonSeat'], { min: 0, max: 5 });
  checkSeatSet(problems, path, seats, buttonSeat);

  const opponentRange = validateRangeSpec(problems, `${path}.opponentRange`, raw['opponentRange']);
  checkNoCardAppearsTwice(problems, path, boardAccepted ? boardCards : [], seats, opponentRange);
  checkOpponentRange(problems, `${path}.opponentRange`, boardCards, seats, opponentRange);

  const claimsRaw = Array.isArray(raw['expectedInsight']) ? raw['expectedInsight'] : [];
  if (!Array.isArray(raw['expectedInsight'])) problems.add(`${path}.expectedInsight`, 'expected an array');
  const claims = claimsRaw.map((claim, index) =>
    validateScenarioClaim(problems, `${path}.expectedInsight[${index}]`, claim),
  );
  // Clean outs exist only against one specific hand, not a range.
  if (opponentRange.kind !== 'exact' && claims.some((claim) => claim.kind === 'cleanOutsEquals')) {
    problems.add(
      `${path}.expectedInsight`,
      'a cleanOutsEquals claim requires an exact opponent hand — against a range the out count is not well defined',
    );
  }

  const committed = readCommittedThisStreet(problems, path, raw['committedThisStreet']);
  const ante = raw['ante'];
  // A malformed field is reported once, so the prose check below runs only when both parsed.
  const beforeSetAside = problems.count;
  const actionsSetAside =
    raw['actionsSetAside'] === undefined
      ? undefined
      : readActionsSetAside(problems, `${path}.actionsSetAside`, raw['actionsSetAside']);
  const setAsideReported = problems.count > beforeSetAside;
  const beforeAssumptions = problems.count;
  const assumptions = requireStringArray(problems, `${path}.assumptions`, raw['assumptions'], {
    min: 1,
    max: 8,
  });
  const assumptionsReported = problems.count > beforeAssumptions;

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
    assumptions,
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
    ...(raw['wholeRangeContinues'] === true ? { wholeRangeContinues: true } : {}),
    ...(raw['assumedFoldEquity'] === undefined
      ? {}
      : {
          assumedFoldEquity: requireNumber(problems, `${path}.assumedFoldEquity`, raw['assumedFoldEquity'], {
            min: 0,
            max: 1,
          }),
        }),
    ...(actionsSetAside === undefined ? {} : { actionsSetAside }),
  };

  // Last, on the assembled record, so coherence checks can trust the types.
  checkSituationCoherence(problems, path, scenario);
  if (!setAsideReported && !assumptionsReported) checkDeclaredSetAside(problems, path, scenario);
  return scenario;
}

// Fold and check are what the verdict judges against, so setting either aside would change the rule.
const SET_ASIDE_ACTIONS = ['call', 'bet', 'raise'] as const;

function readActionsSetAside(
  problems: Problems,
  path: string,
  raw: unknown,
): NonNullable<Scenario['actionsSetAside']> {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.add(path, 'must be a non-empty list of action names, or left out');
    return [];
  }
  const actions = raw.flatMap((action, index) => {
    const known = SET_ASIDE_ACTIONS.find((name) => name === action);
    if (known === undefined) {
      problems.add(
        `${path}[${index}]`,
        `expected one of ${SET_ASIDE_ACTIONS.join(' | ')}, got ${describe(action)}`,
      );
      return [];
    }
    return [known];
  });
  if (new Set(actions).size !== actions.length) problems.add(path, 'names an action more than once');
  return actions;
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
  if (hero !== undefined && hero.holeCards === undefined) {
    problems.add(`${path}.seats`, 'the hero seat must have holeCards');
  }
  if (hero?.folded === true) problems.add(`${path}.seats`, 'the hero seat cannot be folded');
  if (seats.every((seat) => seat.isHero === true || seat.folded === true)) {
    problems.add(`${path}.seats`, 'no opponent is still in the hand: every other seat is folded');
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
  const groups: [string, readonly Card[]][] = [['the board', boardCards]];
  for (const seat of seats) groups.push([`seat ${seat.seat}'s hole cards`, acceptedHolding(seat.holeCards)]);
  if (opponentRange.kind === 'exact') {
    const rangeCards = acceptedHolding(opponentRange.cards);
    // An exact range usually restates a seat's cards. Only cards no seat holds count as extra.
    const restatesASeat = groups.some(
      ([where, cards]) =>
        where !== 'the board' && cards.length === 2 && cards.every((card) => rangeCards.includes(card)),
    );
    if (!restatesASeat) groups.push(['the opponent range', rangeCards]);
  }
  checkCardsDistinct(problems, path, groups);
}

/** `readSituation` parses a range against hero's cards and the board, so it is checked against them here. */
function checkOpponentRange(
  problems: Problems,
  path: string,
  boardCards: readonly Card[],
  seats: readonly ScenarioSeat[],
  opponentRange: RangeSpec,
): void {
  if (opponentRange.kind === 'exact') return;
  const heroText = seats.find((seat) => seat.isHero === true)?.holeCards ?? '';
  let blockers: Card[] = [...boardCards];
  try {
    blockers = [...parseCards(heroText), ...boardCards];
  } catch {
    // Already reported on the seat. The range is still checked, against the board alone.
  }
  if (opponentRange.kind === 'notation') {
    checkRangeDealable(problems, `${path}.notation`, opponentRange.notation, blockers);
    return;
  }
  if (opponentRange.percent <= 0 || opponentRange.percent > 100) return;
  checkRangeDealable(problems, `${path}.percent`, topPercentRange(opponentRange.percent).notation, blockers);
}

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

export interface RawContent {
  readonly lessons: readonly unknown[];
  readonly quizzes: readonly unknown[];
  readonly scenarios: readonly unknown[];
  readonly glossary: readonly unknown[];
  readonly version: string;
}

/**
 * Returns a typed bundle or throws with every problem. Cross-references are checked after the
 * records, so a broken reference reports as a reference problem.
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
  // The API grades against the first question with the id, and progress counts distinct question ids
  // across every quiz, so a repeat anywhere misgrades or undercounts.
  assertUniqueIds(
    problems,
    'quiz questions',
    quizzes.flatMap((quiz) => quiz.questions),
  );

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

/** A prerequisite cycle would deadlock "what to read next", so it is rejected. */
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
