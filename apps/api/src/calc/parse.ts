/**
 * Turns an Ajv-validated body into a costed plan, or a refusal naming the field, before anything is queued.
 * `invalid_request` (400) carries a message per field, because the caller can fix the request.
 * `computation_rejected` (422) carries none, because it is about our limits, not their payload.
 * Ceilings are about half a second of one thread at measured rates (Node 24, Apple silicon): exact
 * enumeration runs 12,600 evaluations/ms, Monte Carlo 1,940/ms. It never counts matchups (1.26s on
 * wide ranges) and never expands `top:NN` (see `equity-worker.ts`), so method choice uses an upper bound.
 */

import type { CoachRequest, EquityRequest } from '@prl/contracts';
import { type Card, CardParseError, cardsToString, parseCards } from '@prl/poker-engine';
import {
  choose,
  deriveContestablePot,
  deriveLegalActions,
  type ParsedRange,
  parseRange,
  RangeParseError,
} from '@prl/poker-math';
import { AppError } from '../errors.ts';
import { withoutControlCharacters } from '../logging.ts';
import type { CoachTask, WireRange, WireSpec } from '../workers/equity-worker.ts';
import type { ShardedEquityRequest } from '../workers/pool.ts';

export interface WorkLimits {
  /** Hard cap on samples per request, whatever the caller asked for. `monteCarloMaxSamples`. */
  readonly maxSamplesPerRequest: number;
  /** Ceiling on `samples × players` for a sampled run. */
  readonly maxSampledEvaluations: number;
  /** Ceiling on `matchups × boards × players` before the exact path is abandoned. */
  readonly maxExactEvaluations: number;
  /** Target samples per shard. */
  readonly samplesPerShard: number;
  readonly maxShards: number;
}

/**
 * Exact is 4M, half a second at 8,000/ms and above the 3.42M of two known hands preflop, which must
 * stay exact. Sampled is 1M, half a second at 2,000/ms, so 500,000 samples against five opponents is
 * refused rather than served at a fifth of the precision asked for.
 */
export const DEFAULT_WORK_LIMITS: WorkLimits = {
  maxSamplesPerRequest: 200_000,
  maxSampledEvaluations: 1_000_000,
  maxExactEvaluations: 4_000_000,
  samplesPerShard: 50_000,
  maxShards: 8,
};

/**
 * Default samples, never fewer. At 20,000 the 95% interval on a two-way pot is about ±0.55 points.
 * If this does not fit the ceiling the request is refused.
 */
const MIN_DEFAULT_SAMPLES = 20_000;

/**
 * Fixed, and shard `i` uses `seed + i`, so the same question always gets the same answer. The
 * sampling error is then systematic, which is why the interval is always reported.
 */
const DEFAULT_SEED = 20_260_817;

/**
 * Extra time for a `top:NN` request. The strength table takes 3.0 to 3.4s on a thread's first use
 * and is memoised. Without this the 3s budget kills the thread with the table half built, and every
 * retry starts cold. 12s stays inside the 20s `requestTimeoutMs`, and the rate limit still applies.
 */
export const STRENGTH_TABLE_ALLOWANCE_MS = 12_000;

/** Legal board lengths. Four cards is a turn, five a river; two is not a poker board. */
const BOARD_LENGTHS: readonly number[] = [0, 3, 4, 5];

/** Community cards each street must have, so a street and a board cannot disagree. */
const BOARD_LENGTH_BY_STREET: Readonly<Record<CoachRequest['street'], number>> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

/** Longest field message returned. Long enough for the range grammar's explanations. */
const MAX_FIELD_MESSAGE = 200;

/** Longest player label. The full range notation always appears in the assumptions. */
const MAX_LABEL = 48;

export interface EquityPlan {
  readonly request: ShardedEquityRequest;
  readonly playerCount: number;
  /** Combinations per opponent after blockers. An upper bound for a `top:NN` range. */
  readonly opponentCombos: readonly number[];
  /** Boards still to be dealt, per matchup. */
  readonly boardsPerMatchup: number;
  /** `Π range sizes × boards × players`, saturating once exact enumeration is out of reach. */
  readonly exactWorkUpperBound: number;
  readonly plannedEvaluations: number;
  /** Milliseconds on top of the budget. Non-zero only for a `top:NN` range. */
  readonly timeoutAllowanceMs: number;
}

export interface CoachPlan {
  readonly task: CoachTask;
  readonly playerCount: number;
  readonly plannedEvaluations: number;
  readonly timeoutAllowanceMs: number;
}

function fieldError(fields: Readonly<Record<string, string>>, logDetail: string): AppError {
  const safe: Record<string, string> = {};
  for (const [key, message] of Object.entries(fields)) {
    safe[key] = withoutControlCharacters(message).slice(0, MAX_FIELD_MESSAGE);
  }
  return new AppError('invalid_request', { fields: safe, logDetail });
}

function rejected(logDetail: string): AppError {
  return new AppError('computation_rejected', { logDetail });
}

/** `CardParseError` messages name only the offending token, so they are safe to echo. */
function readCards(field: string, text: string): Card[] {
  try {
    return parseCards(text);
  } catch (error) {
    if (error instanceof CardParseError) {
      throw fieldError({ [field]: error.message }, `${field} did not parse as cards`);
    }
    throw error;
  }
}

function assertDistinct(field: string, cards: readonly Card[], what: string): void {
  if (new Set(cards).size !== cards.length) {
    throw fieldError({ [field]: `${what} contains the same card twice` }, `${field} repeated a card`);
  }
}

function parseHeroCards(text: string): Card[] {
  const cards = readCards('heroCards', text);
  if (cards.length !== 2) {
    throw fieldError(
      { heroCards: `a hold'em hand is exactly 2 cards, this is ${cards.length} (for example "AhKh")` },
      `heroCards had ${cards.length} cards`,
    );
  }
  assertDistinct('heroCards', cards, 'heroCards');
  return cards;
}

function parseBoard(text: string | undefined, heroCards: readonly Card[]): Card[] {
  const trimmed = (text ?? '').trim();
  const board = trimmed === '' ? [] : readCards('board', trimmed);
  if (!BOARD_LENGTHS.includes(board.length)) {
    throw fieldError(
      {
        board: `a board has 0, 3, 4 or 5 cards (preflop, flop, turn, river), this has ${board.length}`,
      },
      `board had ${board.length} cards`,
    );
  }
  assertDistinct('board', board, 'board');
  const held = new Set(heroCards);
  for (const card of board) {
    if (held.has(card)) {
      throw fieldError(
        { board: 'the board repeats a card you are holding; one card cannot be in two places' },
        'board overlapped heroCards',
      );
    }
  }
  return board;
}

const TOP_PERCENT_PREFIX = 'top:';

function label(index: number, description: string): string {
  const suffix = description.length > MAX_LABEL ? `${description.slice(0, MAX_LABEL - 1)}…` : description;
  return `opponent ${index + 1} (${suffix})`;
}

interface OpponentPlan {
  readonly range: WireRange;
  /** Combinations after blockers, or an upper bound on them for a `top:NN` range. */
  readonly combos: number;
  /** Every card this range can contain, for the dealability check. Empty when unknown. */
  readonly support: readonly Card[];
}

function parseTopPercent(field: string, index: number, text: string): OpponentPlan {
  const percent = Number(text.slice(TOP_PERCENT_PREFIX.length));
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw fieldError(
      { [field]: 'a top-percentage range is written "top:15" — a whole number from 1 to 100' },
      `opponent ${index} had a malformed top-percentage`,
    );
  }
  // Classes are taken whole, so the top N% is at most one class (12 combinations) over N% of 1,326.
  const upperBound = Math.ceil((percent / 100) * 1326) + 12;
  return {
    range: { kind: 'topPercent', label: label(index, `top ${percent}%`), percent },
    combos: Math.min(1326, upperBound),
    support: [],
  };
}

function parseExactOpponent(field: string, index: number, cards: readonly Card[]): OpponentPlan {
  assertDistinct(field, cards, 'this holding');
  return {
    range: { kind: 'exact', label: label(index, cardsToString(cards, '')), cards: [...cards] },
    combos: 1,
    support: [...cards],
  };
}

function parseNotationOpponent(
  field: string,
  index: number,
  notation: string,
  blockers: readonly Card[],
): OpponentPlan {
  let parsed: ParsedRange;
  try {
    parsed = parseRange(notation, blockers);
  } catch (error) {
    if (error instanceof RangeParseError) {
      // Echoed verbatim, because the message says why (`T9s+` has two readings that disagree).
      throw fieldError({ [field]: error.message }, `opponent ${index} range was rejected by the parser`);
    }
    throw error;
  }
  if (parsed.combos.length === 0) {
    throw fieldError(
      {
        [field]:
          'every hand in this range uses a card you or the board already hold, so the range is ' +
          'empty — widen it or check the board',
      },
      `opponent ${index} range was fully blocked`,
    );
  }
  const support = new Set<Card>();
  for (const combo of parsed.combos) {
    support.add(combo[0]);
    support.add(combo[1]);
  }
  return {
    range: { kind: 'notation', label: label(index, notation.trim()), notation },
    combos: parsed.combos.length,
    support: [...support],
  };
}

/**
 * `top:NN`, then exact cards, then range notation. No range token parses as cards, because no rank
 * is also a suit, so "QQ" and "AKs" fail card parsing.
 */
function parseOpponent(index: number, text: string, blockers: readonly Card[]): OpponentPlan {
  const field = `opponents.${index}`;
  const trimmed = text.trim();
  if (trimmed.toLowerCase().startsWith(TOP_PERCENT_PREFIX)) {
    return parseTopPercent(field, index, trimmed.toLowerCase());
  }

  let asCards: Card[] | null = null;
  try {
    asCards = parseCards(trimmed);
  } catch {
    asCards = null;
  }
  if (asCards !== null && asCards.length === 2) return parseExactOpponent(field, index, asCards);
  if (asCards !== null && asCards.length > 0) {
    throw fieldError(
      {
        [field]:
          `"${trimmed}" reads as ${asCards.length} cards. An opponent is either an exact 2-card ` +
          'holding, range notation such as "QQ+, AKs", or a top-percentage such as "top:15"',
      },
      `opponent ${index} named ${asCards.length} cards`,
    );
  }
  return parseNotationOpponent(field, index, trimmed, blockers);
}

/**
 * A necessary condition. n opponents need 2n distinct cards between them. Five opponents on "AA"
 * otherwise spend the whole budget rejecting illegal draws. Checked over the expanded ranges only,
 * which is sound because the condition holds for every subset.
 */
function assertDealable(opponents: readonly OpponentPlan[]): void {
  const known = opponents.filter((opponent) => opponent.support.length > 0);
  if (known.length === 0) return;
  const support = new Set<Card>();
  for (const opponent of known) for (const card of opponent.support) support.add(card);
  const needed = known.length * 2;
  if (support.size >= needed) return;
  throw fieldError(
    {
      opponents:
        `these ranges cannot all be dealt at once: ${known.length} opponents need ${needed} distinct ` +
        `cards between them and their ranges only contain ${support.size}`,
    },
    `ranges are jointly undealable (${support.size} cards for ${known.length} opponents)`,
  );
}

function assertExactHoldingsFit(opponents: readonly OpponentPlan[], blockers: readonly Card[]): void {
  const taken = new Set(blockers);
  for (const [index, opponent] of opponents.entries()) {
    if (opponent.range.kind !== 'exact') continue;
    for (const card of opponent.range.cards) {
      if (taken.has(card)) {
        throw fieldError(
          {
            [`opponents.${index}`]:
              `${cardsToString([card])} is already held by you, the board, or another opponent — ` +
              'one card cannot be in two places',
          },
          `opponent ${index} reused a known card`,
        );
      }
      taken.add(card);
    }
  }
}

/** Product of the range sizes, saturated so a wide multiway spot cannot reach Infinity. */
function matchupUpperBound(combos: readonly number[], ceiling: number): number {
  let product = 1;
  for (const size of combos) {
    product *= size;
    if (product > ceiling) return ceiling;
  }
  return product;
}

export function boardsPerMatchup(boardLength: number, playerCount: number): number {
  const remaining = 52 - boardLength - playerCount * 2;
  return choose(remaining, 5 - boardLength);
}

function shardCount(samples: number, limits: WorkLimits): number {
  const wanted = Math.round(samples / limits.samplesPerShard);
  return Math.max(1, Math.min(limits.maxShards, wanted));
}

/**
 * Exact when the upper bound fits. Otherwise the caller's count is clamped to the per-request cap and
 * then checked against the ceiling, which refuses rather than serving less precision than asked.
 */
function planWork(
  boardLength: number,
  playerCount: number,
  combos: readonly number[],
  requestedSamples: number | undefined,
  limits: WorkLimits,
): {
  readonly method: 'exact' | 'monte-carlo';
  readonly samples: number;
  readonly shards: number;
  readonly boards: number;
  readonly exactWorkUpperBound: number;
  readonly plannedEvaluations: number;
} {
  const boards = boardsPerMatchup(boardLength, playerCount);
  const ceiling = Math.ceil(limits.maxExactEvaluations / Math.max(1, boards * playerCount)) + 1;
  const matchups = matchupUpperBound(combos, ceiling);
  const exactWorkUpperBound = matchups * boards * playerCount;

  if (exactWorkUpperBound <= limits.maxExactEvaluations) {
    return {
      method: 'exact',
      samples: 0,
      shards: 1,
      boards,
      exactWorkUpperBound,
      plannedEvaluations: exactWorkUpperBound,
    };
  }

  const affordable = Math.floor(limits.maxSampledEvaluations / playerCount);
  const samples = Math.min(
    limits.maxSamplesPerRequest,
    requestedSamples ?? Math.max(MIN_DEFAULT_SAMPLES, affordable),
  );
  if (samples * playerCount > limits.maxSampledEvaluations) {
    throw rejected(
      `${samples} samples against ${playerCount} players is ${samples * playerCount} hand ` +
        `evaluations, over the ${limits.maxSampledEvaluations} this endpoint spends on one request` +
        (requestedSamples === undefined ? '' : ` (asked for ${requestedSamples})`),
    );
  }
  return {
    method: 'monte-carlo',
    samples,
    shards: shardCount(samples, limits),
    boards,
    exactWorkUpperBound,
    plannedEvaluations: samples * playerCount,
  };
}

interface ParsedSituation {
  readonly spec: WireSpec;
  readonly opponents: readonly OpponentPlan[];
  readonly playerCount: number;
}

function needsStrengthTable(situation: ParsedSituation): boolean {
  return situation.spec.opponents.some((range) => range.kind === 'topPercent');
}

function parseSituation(
  heroCardsText: string,
  boardText: string | undefined,
  opponentTexts: readonly string[],
): ParsedSituation {
  const heroCards = parseHeroCards(heroCardsText);
  const board = parseBoard(boardText, heroCards);
  const blockers = [...heroCards, ...board];

  if (opponentTexts.length === 0) {
    throw fieldError({ opponents: 'name at least one opponent range' }, 'no opponents');
  }
  const opponents = opponentTexts.map((text, index) => parseOpponent(index, text, blockers));
  assertExactHoldingsFit(opponents, blockers);
  assertDealable(opponents);

  return {
    spec: {
      heroLabel: 'you',
      heroCards,
      board,
      opponents: opponents.map((opponent) => opponent.range),
    },
    opponents,
    playerCount: opponents.length + 1,
  };
}

/** Costs a `POST /math/equity` body. Throws `AppError` and queues nothing. */
export function parseEquityRequest(
  body: EquityRequest,
  limits: WorkLimits = DEFAULT_WORK_LIMITS,
): EquityPlan {
  const situation = parseSituation(body.heroCards, body.board, body.opponents);
  const combos = situation.opponents.map((opponent) => opponent.combos);
  const work = planWork(situation.spec.board.length, situation.playerCount, combos, body.samples, limits);

  const request: ShardedEquityRequest = {
    spec: situation.spec,
    method: work.method,
    samples: work.samples,
    shards: work.shards,
    seed: DEFAULT_SEED,
  };
  return {
    request,
    playerCount: situation.playerCount,
    opponentCombos: combos,
    boardsPerMatchup: work.boards,
    exactWorkUpperBound: work.exactWorkUpperBound,
    plannedEvaluations: work.plannedEvaluations,
    timeoutAllowanceMs: needsStrengthTable(situation) ? STRENGTH_TABLE_ALLOWANCE_MS : 0,
  };
}

/**
 * `buildCoachReport` picks its own method through `equity()`, which counts matchups first. The
 * samples are planned here; the count is bounded by the library's five-million cap and the pool's
 * deadline. The street and board must agree, or the report describes a different hand.
 */
export function parseCoachRequest(body: CoachRequest, limits: WorkLimits = DEFAULT_WORK_LIMITS): CoachPlan {
  const situation = parseSituation(body.heroCards, body.board, body.opponents);
  const expected = BOARD_LENGTH_BY_STREET[body.street];
  if (situation.spec.board.length !== expected) {
    throw fieldError(
      {
        board:
          `the ${body.street} has ${expected} community card${expected === 1 ? '' : 's'}, ` +
          `this board has ${situation.spec.board.length}`,
        street: `change the street, or send ${expected} board cards`,
      },
      `street ${body.street} disagreed with a board of ${situation.spec.board.length}`,
    );
  }

  // Required by the TypeScript contract but optional in the JSON Schema, so it can be absent.
  const stacks: readonly number[] = Array.isArray(body.opponentStacks) ? body.opponentStacks : [];
  if (stacks.length > 0 && stacks.length !== situation.opponents.length) {
    throw fieldError(
      {
        opponentStacks:
          `send one stack per opponent (${situation.opponents.length}) or none at all, not ` +
          `${stacks.length}`,
      },
      'opponentStacks did not match the opponent count',
    );
  }
  // An unstated stack matches hero's, which invents no depth advantage. The report states it.
  const opponentStacks = stacks.length > 0 ? [...stacks] : situation.opponents.map(() => body.heroStack);

  const work = planWork(
    situation.spec.board.length,
    situation.playerCount,
    situation.opponents.map((opponent) => opponent.combos),
    undefined,
    limits,
  );

  return {
    task: {
      kind: 'coach',
      spec: situation.spec,
      street: body.street,
      pot: body.pot,
      // A body has no per-seat commitments, so this subtracts only the bet hero cannot cover.
      // Exact heads-up; see `deriveContestablePot` for multiway.
      contestablePot: deriveContestablePot({
        pot: body.pot,
        toCall: body.toCall,
        heroCommittedThisStreet: 0,
        heroStack: body.heroStack,
        opponentStacks,
      }),
      toCall: body.toCall,
      // The body has no field for chips hero already put in, and `pot` is everything before
      // hero's call, so zero is the only reading. The Coach's minimum raise assumes it too.
      heroCommittedThisStreet: 0,
      heroStack: body.heroStack,
      opponentStacks,
      bigBlind: body.bigBlind,
      // No `HandState` to ask, so derived from the body. With every opponent all-in
      // (`opponentStacks: [0]`) no bet or raise is offered on a 35% fold chance.
      legalActions: deriveLegalActions({
        toCall: body.toCall,
        heroCommittedThisStreet: 0,
        heroStack: body.heroStack,
        opponentStacks,
      }),
      samples: Math.max(MIN_DEFAULT_SAMPLES, work.samples),
      seed: DEFAULT_SEED,
    },
    playerCount: situation.playerCount,
    plannedEvaluations: work.plannedEvaluations,
    timeoutAllowanceMs: needsStrengthTable(situation) ? STRENGTH_TABLE_ALLOWANCE_MS : 0,
  };
}
