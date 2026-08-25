/**
 * From a validated request body to a costed plan — or to a refusal, with the field named.
 *
 * Ajv has already checked that the body is the right *shape*: the cards match a card pattern,
 * the range strings match a range pattern, the sample count is an integer inside its bounds.
 * None of that says whether the request describes a possible poker situation, and none of it
 * says what the situation would cost to compute. That is this file's job, and it does it before
 * anything is queued, because a calculation that cannot succeed should not occupy a thread for
 * a wall-clock budget first.
 *
 * ## Two kinds of "no", and they are different
 *
 * - `invalid_request` (400) with a **field-level message**: the request describes something
 *   that is not a poker situation, or names a range this parser deliberately refuses. Three
 *   cards in a hand, a board of two, an opponent holding a card hero is holding, `T9s+`. The
 *   caller can fix every one of these, and can only fix them if told which field and why — so
 *   these carry a message per field. They are the one place the error handler lets a real
 *   sentence through, and the sentences here are ours, derived from the caller's own payload
 *   against a grammar the caller can read. Nothing about the server leaks through them.
 * - `computation_rejected` (422): the request is a perfectly good poker question and the answer
 *   costs more than this endpoint is allowed to spend. That is a statement about our limits,
 *   not about their payload, so it gets no field detail.
 *
 * ## The work ceiling, and why it is measured rather than guessed
 *
 * The numbers below come from timing the real thing on the reference machine (Node 24, Apple
 * silicon, one thread):
 *
 * - Exact enumeration: AA vs KK preflop is 1,712,304 boards for two players — 3.42 million
 *   hand evaluations — in 271ms. About 12,600 evaluations per millisecond.
 * - Monte Carlo: 200,000 trials against five wide ranges is 1.2 million evaluations in 618ms.
 *   About 1,940 per millisecond; the gap is the per-trial cost of drawing a legal matchup and
 *   a run-out, which exact enumeration does not pay.
 *
 * Both ceilings are then set at roughly **half a second of one thread**, using the
 * conservative end of those rates. Half a second is deliberate: `coachTimeoutMs` defaults to
 * 3,000ms, so a request that lands on the ceiling still finishes several times inside its
 * budget even if the machine is slower than the one that was measured, and a sampled request
 * is sharded on top of that.
 *
 * ## What this file will not do
 *
 * It will not count legal matchups. `countMatchups()` enumerates them, which on wide ranges is
 * the 1.26 seconds it takes to reach the library's own five-million cap — on the event loop,
 * for every request, before any work has started. So the exact/sampled decision is made from
 * an **upper bound** instead: the product of the range sizes, which is every assignment
 * whether or not the cards collide. The bound can only err one way (a spec whose ranges block
 * each other heavily looks bigger than it is), so the consequence is that a handful of
 * multiway spots are sampled where an exact answer would in fact have fitted. The response
 * says `monte-carlo` and carries its interval when that happens, which is the honest outcome;
 * spending a second of everybody's event loop to avoid it would not be.
 *
 * Nor will it expand a `top:NN` range. That needs the preflop strength table, which is three
 * seconds of measurement on first use — see `equity-worker.ts`, which does it on a thread.
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

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

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
 * The measured ceilings. See the file header for where the rates come from.
 *
 * `maxExactEvaluations` is four million: half a second at a conservative 8,000 evaluations per
 * millisecond, and comfortably above the 3.42 million that a two-known-hands preflop
 * enumeration costs — which matters, because that spot is the canonical exact case and a
 * learner should never see it reported as sampled.
 *
 * `maxSampledEvaluations` is one million: half a second at a conservative 2,000 per
 * millisecond. Note what this does at the top of the range: 500,000 samples (the schema's
 * ceiling) against five opponents is three million evaluations, so that request is refused
 * rather than quietly served at a fifth of the precision it asked for.
 */
export const DEFAULT_WORK_LIMITS: WorkLimits = {
  maxSamplesPerRequest: 200_000,
  maxSampledEvaluations: 1_000_000,
  maxExactEvaluations: 4_000_000,
  samplesPerShard: 50_000,
  maxShards: 8,
};

/**
 * Samples for a request that did not ask for a count.
 *
 * Never below this, even when the player count makes the affordable figure smaller: at 20,000
 * trials the 95% interval on a two-way pot is about ±0.55 points, and an interval much wider
 * than that is not a figure worth teaching from. If even this does not fit the ceiling the
 * request is refused rather than answered vaguely.
 */
const MIN_DEFAULT_SAMPLES = 20_000;

/**
 * The seed every request starts from.
 *
 * Fixed, not random, and shard `i` uses `seed + i`. The same question therefore always gets
 * the same answer — two learners comparing screens see the same number, and a figure quoted in
 * a lesson stays quoted. The cost is that the sampling error is systematic rather than
 * averaging away across repeat calls, which is the right trade for a teaching tool and is why
 * the interval is always reported next to the figure.
 */
const DEFAULT_SEED = 20_260_817;

/**
 * Extra wall-clock time allowed for a request that names a `top:NN` range.
 *
 * "The top 15% of hands" is meaningless without an ordering, and this project computes its
 * ordering rather than copying a published chart: 169 starting-hand classes, each measured
 * all-in against a random hand. That measurement takes about three and a half seconds the
 * first time a thread is asked for it, and is memoised per thread afterwards — so the first
 * `top:NN` request a thread serves is slow and every later one is not. Measured at 3.0–3.4
 * seconds on the reference machine; twelve seconds is room for a machine several times
 * slower, and leaves the total inside the 20-second `requestTimeoutMs` that closes the socket.
 *
 * Without this allowance the feature simply does not work: the table alone exceeds the
 * default 3-second budget, the thread is terminated for overrunning, and the half-built table
 * dies with it — so the next request starts cold and fails in exactly the same way.
 *
 * The allowance is not a hole in the CPU limit. It applies only to a request that asked for a
 * top-percentage range, the expensive rate limit still applies, and the pool's queue is still
 * bounded — so the worst case is a cold pool serving a few slow requests, not an unbounded
 * one.
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

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface EquityPlan {
  /** Everything the pool needs to run it. */
  readonly request: ShardedEquityRequest;
  /** Hero plus opponents. */
  readonly playerCount: number;
  /**
   * Combinations per opponent after blockers. For a `top:NN` range this is an upper bound rather
   * than a count, because pinning it down needs the strength table this file will not build.
   */
  readonly opponentCombos: readonly number[];
  /** Boards still to be dealt, per matchup. */
  readonly boardsPerMatchup: number;
  /**
   * `Π range sizes × boards × players` — the bound the method was chosen from. Saturating:
   * once the product is past the point where exact enumeration is out of the question, its
   * exact value stops mattering and is not computed any further.
   */
  readonly exactWorkUpperBound: number;
  /** Hand evaluations the chosen plan is expected to cost. */
  readonly plannedEvaluations: number;
  /**
   * Extra wall-clock time this plan may need on top of the configured budget, in
   * milliseconds. Non-zero only for a `top:NN` range — see `STRENGTH_TABLE_ALLOWANCE_MS`.
   */
  readonly timeoutAllowanceMs: number;
}

export interface CoachPlan {
  readonly task: CoachTask;
  readonly playerCount: number;
  readonly plannedEvaluations: number;
  readonly timeoutAllowanceMs: number;
}

// ---------------------------------------------------------------------------
// Field-level failures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * Parses a card list, turning the engine's own parse failure into a field message.
 *
 * `CardParseError` messages name the offending token ("unknown suit \"x\" in \"Ax\"") and
 * nothing else, so they are safe to echo — they describe the caller's payload against a
 * notation the caller is already using.
 */
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

/** Hero's exact holding: two cards, distinct. */
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

/** The community cards: 0, 3, 4 or 5 of them, distinct, and none of them hero's. */
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
        { board: 'the board repeats a card hero is holding; one card cannot be in two places' },
        'board overlapped heroCards',
      );
    }
  }
  return board;
}

// ---------------------------------------------------------------------------
// Opponents
// ---------------------------------------------------------------------------

const TOP_PERCENT_PREFIX = 'top:';

function label(index: number, description: string): string {
  const suffix = description.length > MAX_LABEL ? `${description.slice(0, MAX_LABEL - 1)}…` : description;
  return `opponent ${index + 1} (${suffix})`;
}

/** One opponent, and how many combinations it comes to. */
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
  // The size is not knowable here without building the strength table, and it is bounded
  // anyway: the top N% covers at least N% of the 1,326 combinations and at most one class
  // (twelve combinations) more, because classes are taken whole until the share is reached.
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
      // The grammar's refusals are the useful part of it: `T9s+` is rejected because the two
      // readings of it disagree, and the message says which two. Surfacing that verbatim is the
      // difference between a caller fixing their range and a caller guessing.
      throw fieldError({ [field]: error.message }, `opponent ${index} range was rejected by the parser`);
    }
    throw error;
  }
  if (parsed.combos.length === 0) {
    throw fieldError(
      {
        [field]:
          'every hand in this range uses a card hero or the board already holds, so the range is ' +
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
 * One opponent string, in the three forms the contract names.
 *
 * The order of the tests is what makes them unambiguous. `top:NN` is checked first because it
 * is the only form with a prefix. Exact cards are recognised by *successfully* parsing as two
 * cards, which no range token can do — every rank is one character and no rank is also a suit,
 * so "QQ" and "AKs" both fail card parsing outright rather than parsing as something else.
 * Anything left is range notation.
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
 * A necessary condition for the ranges to be dealable at the same time.
 *
 * Every opponent needs two distinct cards and no card may be used twice, so any set of
 * opponents needs at least twice as many distinct cards between them as there are opponents in
 * the set. Five opponents all on "AA" fail it — there are four aces — and without this check
 * that request is accepted, sampled, and spends its whole budget rejecting illegal draws before
 * the maths gives up. Checked only across the opponents whose ranges are already expanded here,
 * which is sound: a condition that must hold for every subset must hold for that one.
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

/** Two opponents cannot hold the same card, and neither can hold one hero or the board holds. */
function assertExactHoldingsFit(opponents: readonly OpponentPlan[], blockers: readonly Card[]): void {
  const taken = new Set(blockers);
  for (const [index, opponent] of opponents.entries()) {
    if (opponent.range.kind !== 'exact') continue;
    for (const card of opponent.range.cards) {
      if (taken.has(card)) {
        throw fieldError(
          {
            [`opponents.${index}`]:
              `${cardsToString([card])} is already held by hero, the board, or another opponent — ` +
              'one card cannot be in two places',
          },
          `opponent ${index} reused a known card`,
        );
      }
      taken.add(card);
    }
  }
}

// ---------------------------------------------------------------------------
// Costing
// ---------------------------------------------------------------------------

/** Product of the range sizes, saturated so a wide multiway spot cannot reach Infinity. */
function matchupUpperBound(combos: readonly number[], ceiling: number): number {
  let product = 1;
  for (const size of combos) {
    product *= size;
    if (product > ceiling) return ceiling;
  }
  return product;
}

/** Boards left to deal once every player has a hand. */
export function boardsPerMatchup(boardLength: number, playerCount: number): number {
  const remaining = 52 - boardLength - playerCount * 2;
  return choose(remaining, 5 - boardLength);
}

function shardCount(samples: number, limits: WorkLimits): number {
  const wanted = Math.round(samples / limits.samplesPerShard);
  return Math.max(1, Math.min(limits.maxShards, wanted));
}

/**
 * Chooses the method, the sample count and the shard count.
 *
 * Exact when the *upper bound* on its work fits, sampled otherwise — see the file header for
 * why an upper bound rather than the real count. A caller's explicit sample count is clamped to
 * the operator's per-request cap (the contract says the server clamps) and then checked against
 * the work ceiling, which it can still exceed: asking for the schema's maximum against five
 * opponents is more work than this endpoint spends, and the honest answer to that is no rather
 * than a fifth of the precision that was asked for.
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

  // What we would actually run: the caller's count clamped to the operator's per-request cap.
  // The ceiling is then checked against that, so the refusal is always about real work.
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

// ---------------------------------------------------------------------------
// The two entry points
// ---------------------------------------------------------------------------

interface ParsedSituation {
  readonly spec: WireSpec;
  readonly opponents: readonly OpponentPlan[];
  readonly playerCount: number;
}

/** True when some range can only be expanded by building the preflop strength table. */
function needsStrengthTable(situation: ParsedSituation): boolean {
  return situation.spec.opponents.some((range) => range.kind === 'topPercent');
}

/** The parts `POST /math/equity` and `POST /math/coach` share, validated once. */
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
 * Costs a `POST /math/coach` body.
 *
 * Two differences from the equity path, both forced by `buildCoachReport` owning its own
 * decisions:
 *
 * 1. The method is not ours to choose. The report states the method it used, and it picks that
 *    itself through `equity()`'s automatic choice — which counts legal matchups first. So a
 *    Coach request pays for the count as well as the calculation, and on a multiway spot with
 *    wide ranges that count is the larger half. The sample count below is still planned here,
 *    so the sampled half stays bounded; the counting half is bounded by the library's own
 *    five-million cap and, past that, by the pool's deadline.
 * 2. The street and the board have to agree, because the report is written in terms of the
 *    street and a mismatch would be a report about a different hand.
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

  // `opponentStacks` is required by the TypeScript contract and optional in the JSON Schema, so
  // it can genuinely be absent at runtime whatever the type says. Checked rather than trusted.
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
  // An unstated opponent stack is taken to match hero's. It is the only default that invents
  // no depth advantage in either direction, and the report's own stack explanation states the
  // effective stack it used, so the assumption is visible to the reader rather than hidden.
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
      // Derived, because a request body describes a spot rather than a table: it carries no
      // per-seat commitments, so there is no seat state for `contestablePotFor` to layer. What a
      // description does establish is the part of the bet hero's stack cannot cover, and
      // `deriveContestablePot` subtracts exactly that and nothing else. Exact heads-up; see its
      // doc for what it cannot see multiway, and why the answer there is per-seat commitments in
      // the request rather than a guess.
      contestablePot: deriveContestablePot({
        pot: body.pot,
        toCall: body.toCall,
        heroCommittedThisStreet: 0,
        heroStack: body.heroStack,
        opponentStacks,
      }),
      toCall: body.toCall,
      // The ad-hoc calculator describes a spot, not a seat at a table: the request has
      // no field for chips hero has already put out on this street, and its `pot` is
      // documented as everything in the middle before hero's pending call. Zero is the
      // only reading of that body, and it is the reading the Coach's derived minimum
      // raise assumes, so the sizes it publishes stay legal for the spot as described.
      heroCommittedThisStreet: 0,
      heroStack: body.heroStack,
      opponentStacks,
      bigBlind: body.bigBlind,
      // Same reasoning as `heroCommittedThisStreet` above, one level up: the body
      // describes a spot, so there is no `HandState` whose `legalActions` could be asked
      // and the set is derived from what the body does state. Chiefly, a caller who says
      // every opponent is all-in (`opponentStacks: [0]`) is no longer offered a bet or a
      // raise priced on a 35% chance that one of them folds.
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
