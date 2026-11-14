/**
 * Equity, the share of the pot a hand wins on average if played to the river with no more betting.
 *
 * `equity()` estimates the work, enumerates exactly when it fits the budget and otherwise runs
 * bounded Monte Carlo. The result names its `method`, and a sampled result always carries a 95%
 * interval. A board where k players tie awards each 1/k of the pot, so equity is `wins + ties/k`.
 * Monte Carlo is deterministic for a given (spec, samples, seed), which lets the API shard by seed.
 */

import {
  type Card,
  createSamplingRandom,
  DECK_SIZE,
  evaluate,
  type HandScore,
  type RandomSource,
  remainingDeck,
} from '@prl/poker-engine';
import type { Combo, ParsedRange } from './ranges.ts';

export class EquityError extends Error {
  override readonly name = 'EquityError';
}

export interface EquityPlayer {
  /** Shown to the learner, e.g. "hero" or "a tight opening range". */
  readonly label: string;
  /** The hands this player can hold. A single combo for a known hand. */
  readonly range: ParsedRange;
}

export interface EquitySpec {
  readonly players: readonly EquityPlayer[];
  /** Community cards already visible. 0, 3, 4 or 5 cards. */
  readonly board: readonly Card[];
  /** Cards known to be out of play but not on the board (e.g. exposed cards). */
  readonly deadCards?: readonly Card[];
}

export interface EquityOptions {
  /** Upper bound on (matchups × boards) before falling back to Monte Carlo. */
  readonly maxExactWork?: number;
  /** Monte Carlo sample count. Ignored when the exact path is taken. */
  readonly samples?: number;
  /** Monte Carlo seed. Same seed + same spec ⇒ identical result. */
  readonly seed?: number;
  /** Force a method rather than letting the estimate decide. */
  readonly method?: 'auto' | 'exact' | 'monte-carlo';
}

export interface PlayerEquity {
  readonly label: string;
  /** Fraction of trials this player held the sole best hand. */
  readonly win: number;
  /** Fraction of trials this player shared the best hand. */
  readonly tie: number;
  readonly lose: number;
  /** Pot share: `win + Σ(tie shares)`. This is the number that matters. */
  readonly equity: number;
}

export interface EquityConfidence {
  /** Always 0.95 here; stated explicitly rather than assumed. */
  readonly level: 0.95;
  /**
   * Half-width of the interval, in percentage points, for the FIRST player.
   * Equity is `equity ± halfWidthPoints/100`.
   */
  readonly halfWidthPoints: number;
  readonly samples: number;
}

export interface EquityResult {
  readonly method: 'exact-enumeration' | 'monte-carlo';
  readonly players: readonly PlayerEquity[];
  /** Boards enumerated (exact) or trials run (Monte Carlo). */
  readonly trials: number;
  /**
   * The matchups this figure stands on, which means different things per method.
   *
   * - `exact-enumeration`: the legal matchups enumerated, an exact count.
   * - `monte-carlo`: an upper bound, the product of the range sizes before card conflicts. `AA` vs
   *   `AA` reports 36 where only 6 are legal. Counting the legal ones would mean enumerating, which
   *   this path exists to avoid. `countMatchups(spec)` gives the legal figure.
   */
  readonly matchups: number;
  /** Present only for Monte Carlo. Exact enumeration has no sampling error. */
  readonly confidence: EquityConfidence | null;
  readonly elapsedMs: number;
  /** Everything the number depends on, in plain language, shown next to the figure in the UI. */
  readonly assumptions: readonly string[];
}

const DEFAULT_MAX_EXACT_WORK = 4_000_000;
const DEFAULT_SAMPLES = 100_000;
const BOARD_TARGET = 5;

/**
 * The most trials one Monte Carlo call will run. The trial loop is synchronous and nothing can
 * interrupt it, so `Infinity` would wedge the thread. The half-width falls as 1/√n, so 5 million is
 * far past the point where the interval stops moving.
 */
export const MAX_MONTE_CARLO_SAMPLES = 5_000_000;

/** The fewest trials that can carry an honest interval. See `validateSampling`. */
export const MIN_MONTE_CARLO_SAMPLES = 2;

/**
 * Validates `samples` and `seed`. Each rejection is an observed failure.
 *
 *   * `NaN` skipped the loop and returned a `NaN` equity.
 *   * `Infinity` ran an unbounded synchronous loop.
 *   * `0`, negatives and fractions were clamped to one trial, which reported a ±0.00 interval.
 *     Two trials is the minimum that carries real variance.
 *   * A non-integer `seed` breaks the determinism that sharding relies on.
 */
function validateSampling(options: EquityOptions): number {
  const requested = options.samples ?? DEFAULT_SAMPLES;
  if (!Number.isInteger(requested) || requested < MIN_MONTE_CARLO_SAMPLES) {
    throw new EquityError(
      `samples must be a whole number of at least ${MIN_MONTE_CARLO_SAMPLES}, received ${String(requested)} — ` +
        'a single trial cannot carry a confidence interval, and a non-integer or NaN count would return a NaN equity',
    );
  }
  if (requested > MAX_MONTE_CARLO_SAMPLES) {
    throw new EquityError(
      `samples must not exceed ${MAX_MONTE_CARLO_SAMPLES}, received ${requested} — the trial loop is ` +
        'synchronous, so nothing can interrupt it once it starts',
    );
  }
  const seed = options.seed;
  if (seed !== undefined && !Number.isInteger(seed)) {
    throw new EquityError(`seed must be a whole number, received ${String(seed)}`);
  }
  return requested;
}

/** C(n, k) without overflow for the sizes involved here. */
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 0; i < kk; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

function validateSpec(spec: EquitySpec): void {
  if (spec.players.length < 2) {
    throw new EquityError(`equity needs at least 2 players, received ${spec.players.length}`);
  }
  if (spec.players.length > 6) {
    throw new EquityError(`equity supports at most 6 players, received ${spec.players.length}`);
  }
  const boardLength = spec.board.length;
  if (boardLength !== 0 && boardLength !== 3 && boardLength !== 4 && boardLength !== 5) {
    throw new EquityError(`board must have 0, 3, 4 or 5 cards, received ${boardLength}`);
  }
  const known = [...spec.board, ...(spec.deadCards ?? [])];
  if (new Set(known).size !== known.length) {
    throw new EquityError('board and dead cards contain a duplicate');
  }
  for (const player of spec.players) {
    if (player.range.combos.length === 0) {
      throw new EquityError(`player "${player.label}" has no possible hands after removing blockers`);
    }
  }
}

function availableCards(spec: EquitySpec): Card[] {
  return remainingDeck([...spec.board, ...(spec.deadCards ?? [])]);
}

class Tally {
  readonly playerCount: number;
  readonly wins: Float64Array;
  readonly ties: Float64Array;
  readonly share: Float64Array;
  /** Sum of squared per-trial share, for the first player's variance. */
  private firstShareSquaredSum = 0;
  private trials = 0;

  // Explicit fields, not parameter properties, because `erasableSyntaxOnly` forbids them. That flag
  // lets Node run this TypeScript directly.
  constructor(playerCount: number) {
    this.playerCount = playerCount;
    this.wins = new Float64Array(playerCount);
    this.ties = new Float64Array(playerCount);
    this.share = new Float64Array(playerCount);
  }

  record(scores: Float64Array): void {
    let best = -1;
    let winners = 0;
    for (let i = 0; i < this.playerCount; i++) {
      const score = scores[i] ?? -1;
      if (score > best) {
        best = score;
        winners = 1;
      } else if (score === best) {
        winners += 1;
      }
    }
    const perWinner = 1 / winners;
    for (let i = 0; i < this.playerCount; i++) {
      if ((scores[i] ?? -1) !== best) continue;
      if (winners === 1) this.wins[i] = (this.wins[i] ?? 0) + 1;
      else this.ties[i] = (this.ties[i] ?? 0) + 1;
      this.share[i] = (this.share[i] ?? 0) + perWinner;
      if (i === 0) this.firstShareSquaredSum += perWinner * perWinner;
    }
    this.trials += 1;
  }

  get count(): number {
    return this.trials;
  }

  firstPlayerStdDev(): number {
    if (this.trials < 2) return 0;
    const mean = (this.share[0] ?? 0) / this.trials;
    const variance = Math.max(0, this.firstShareSquaredSum / this.trials - mean * mean);
    return Math.sqrt((variance * this.trials) / (this.trials - 1));
  }

  toPlayerEquities(labels: readonly string[]): PlayerEquity[] {
    const out: PlayerEquity[] = [];
    for (let i = 0; i < this.playerCount; i++) {
      const win = (this.wins[i] ?? 0) / this.trials;
      const tie = (this.ties[i] ?? 0) / this.trials;
      out.push({
        label: labels[i] ?? `player ${i}`,
        win,
        tie,
        lose: Math.max(0, 1 - win - tie),
        equity: (this.share[i] ?? 0) / this.trials,
      });
    }
    return out;
  }
}

/**
 * Every legal assignment of one combination to each player, with no shared cards. Card removal
 * between players is what makes a range-vs-range result exact.
 */
function* enumerateMatchups(
  players: readonly EquityPlayer[],
  blocked: Set<Card>,
): Generator<readonly Combo[]> {
  const assignment: Combo[] = [];

  function* recurse(index: number): Generator<readonly Combo[]> {
    const player = players[index];
    if (player === undefined) {
      yield [...assignment];
      return;
    }
    for (const combo of player.range.combos) {
      if (blocked.has(combo[0]) || blocked.has(combo[1])) continue;
      blocked.add(combo[0]);
      blocked.add(combo[1]);
      assignment.push(combo);
      yield* recurse(index + 1);
      assignment.pop();
      blocked.delete(combo[0]);
      blocked.delete(combo[1]);
    }
  }
  yield* recurse(0);
}

export function countMatchups(spec: EquitySpec): number {
  const blocked = new Set<Card>([...spec.board, ...(spec.deadCards ?? [])]);
  let count = 0;
  for (const _matchup of enumerateMatchups(spec.players, blocked)) {
    count += 1;
    // Past this the exact path is out of the question anyway.
    if (count > 5_000_000) return count;
  }
  return count;
}

/** Legal matchups × boards per matchup. It decides the method and is reported for inspection. */
export function estimateExactWork(spec: EquitySpec): {
  matchups: number;
  boardsPerMatchup: number;
  total: number;
} {
  const matchups = countMatchups(spec);
  const cardsUsedByHands = spec.players.length * 2;
  const remaining = DECK_SIZE - spec.board.length - (spec.deadCards?.length ?? 0) - cardsUsedByHands;
  const needed = BOARD_TARGET - spec.board.length;
  const boardsPerMatchup = choose(remaining, needed);
  return { matchups, boardsPerMatchup, total: matchups * boardsPerMatchup };
}

/** A player's label as the subject of an assumption: "You hold" or a capitalised "<label> holds". */
function holdsClause(label: string): string {
  if (label.toLowerCase() === 'you') return 'You hold';
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} holds`;
}

function assumptionsFor(spec: EquitySpec, method: EquityResult['method'], samples: number): string[] {
  const notes: string[] = [];
  notes.push(
    'The hand is played to the river with no further betting — this is raw equity, not the value of the spot.',
  );
  for (const player of spec.players) {
    const combos = player.range.combos.length;
    const holds = holdsClause(player.label);
    notes.push(
      combos === 1
        ? `${holds} exactly ${player.range.notation}.`
        : `${holds} any of ${combos} combinations from "${player.range.notation}", each equally likely.`,
    );
  }
  const multiCombo = spec.players.filter((player) => player.range.combos.length > 1);
  if (multiCombo.length > 0) {
    notes.push(
      'Every hand in a range is weighted equally. Real opponents do not play every hand in a range the same way, so treat this as the range assumption, not a prediction.',
    );
  }
  if (method === 'monte-carlo') {
    notes.push(
      `Estimated by sampling ${samples.toLocaleString('en-US')} random run-outs, not by exhaustive enumeration.`,
    );
  } else {
    notes.push('Computed by enumerating every remaining board — there is no sampling error.');
  }
  if (spec.board.length === 0) {
    notes.push('No community cards are known yet, so five more cards are still to come.');
  }
  return notes;
}

export function exactEquity(spec: EquitySpec): EquityResult {
  validateSpec(spec);
  const started = performance.now();
  const playerCount = spec.players.length;
  const tally = new Tally(playerCount);
  const scores = new Float64Array(playerCount);
  const needed = BOARD_TARGET - spec.board.length;
  const blocked = new Set<Card>([...spec.board, ...(spec.deadCards ?? [])]);
  let matchups = 0;

  const hands: Card[][] = Array.from({ length: playerCount }, () => []);

  for (const matchup of enumerateMatchups(spec.players, blocked)) {
    matchups += 1;
    const taken = new Set<Card>(blocked);
    for (const combo of matchup) {
      taken.add(combo[0]);
      taken.add(combo[1]);
    }
    for (let i = 0; i < playerCount; i++) {
      const combo = matchup[i];
      if (combo === undefined) throw new EquityError('matchup is missing a hand');
      hands[i] = [combo[0], combo[1], ...spec.board];
    }
    const deck: Card[] = [];
    for (let card = 0; card < DECK_SIZE; card++) if (!taken.has(card)) deck.push(card);

    if (needed === 0) {
      for (let i = 0; i < playerCount; i++) {
        const hand = hands[i];
        if (hand === undefined) throw new EquityError('hand missing');
        scores[i] = evaluate(hand);
      }
      tally.record(scores);
      continue;
    }

    // Nested loops, not a generic combination generator, because this inner loop runs millions of times.
    const n = deck.length;
    const pick = new Array<Card>(needed);
    const runBoard = (): void => {
      for (let i = 0; i < playerCount; i++) {
        const hand = hands[i];
        if (hand === undefined) throw new EquityError('hand missing');
        const full = needed === 0 ? hand : [...hand, ...pick];
        scores[i] = evaluate(full);
      }
      tally.record(scores);
    };
    const recurse = (depth: number, start: number): void => {
      if (depth === needed) {
        runBoard();
        return;
      }
      for (let i = start; i < n; i++) {
        const card = deck[i];
        if (card === undefined) continue;
        pick[depth] = card;
        recurse(depth + 1, i + 1);
      }
    };
    recurse(0, 0);
  }

  if (tally.count === 0) throw new EquityError('no legal matchups — the ranges block each other completely');

  return {
    method: 'exact-enumeration',
    players: tally.toPlayerEquities(spec.players.map((player) => player.label)),
    trials: tally.count,
    matchups,
    confidence: null,
    elapsedMs: performance.now() - started,
    assumptions: assumptionsFor(spec, 'exact-enumeration', 0),
  };
}

/**
 * Rejections allowed across a whole run. Per run, not per trial, so an unlucky trial does not abort a
 * healthy run while a hopeless spec still runs out.
 */
interface RejectionBudget {
  spent: number;
  readonly limit: number;
}

/**
 * Draws one legal matchup by rejection sampling. Filtering each range against cards already dealt
 * would be faster but biased, because it reweights later players' ranges by their blockers.
 */
function sampleLegalMatchup(
  rangeCombos: readonly (readonly Combo[])[],
  staticBlocked: ReadonlySet<Card>,
  random: RandomSource,
  budget: RejectionBudget,
): Combo[] {
  for (;;) {
    const used = new Set<Card>(staticBlocked);
    const candidate: Combo[] = [];
    let ok = true;
    for (const combos of rangeCombos) {
      if (combos.length === 0) {
        ok = false;
        break;
      }
      const combo = combos[random.nextInt(combos.length)];
      if (combo === undefined || used.has(combo[0]) || used.has(combo[1])) {
        ok = false;
        break;
      }
      used.add(combo[0]);
      used.add(combo[1]);
      candidate.push(combo);
    }
    if (ok) return candidate;
    budget.spent += 1;
    if (budget.spent > budget.limit) {
      throw new EquityError(
        'the ranges overlap so heavily that a legal matchup could not be sampled — use exact enumeration',
      );
    }
  }
}

/**
 * Draws `needed` board cards without replacement by a partial Fisher-Yates shuffle.
 */
function drawRunOut(
  pool: readonly Card[],
  assignment: readonly Combo[],
  needed: number,
  random: RandomSource,
): Card[] {
  const usedByHands = new Set<Card>();
  for (const combo of assignment) {
    usedByHands.add(combo[0]);
    usedByHands.add(combo[1]);
  }
  const deck: Card[] = [];
  for (const card of pool) if (!usedByHands.has(card)) deck.push(card);
  for (let i = 0; i < needed; i++) {
    const j = i + random.nextInt(deck.length - i);
    const a = deck[i];
    const b = deck[j];
    if (a === undefined || b === undefined) throw new EquityError('run-out draw out of range');
    deck[i] = b;
    deck[j] = a;
  }
  return deck.slice(0, needed);
}

/**
 * Bounded Monte Carlo. Each trial draws one combination per player, rejecting shared cards, then a
 * run-out. The interval is the normal approximation, sound because pot share lies in [0, 1].
 * Determinism rests on the order of draws: matchup first, then run-out, once per trial. Shard by seed
 * and combine with `combineMonteCarlo`.
 */
export function monteCarloEquity(spec: EquitySpec, options: EquityOptions = {}): EquityResult {
  validateSpec(spec);
  const samples = validateSampling(options);
  const started = performance.now();
  const seed = options.seed ?? 1;
  // `createSamplingRandom`, not the test-only generator, which refuses to exist under
  // `NODE_ENV=production`. Both give the same stream for a seed. See `rng.ts` in `@prl/poker-engine`.
  const random = createSamplingRandom(seed);

  const playerCount = spec.players.length;
  const tally = new Tally(playerCount);
  const scores = new Float64Array(playerCount);
  const needed = BOARD_TARGET - spec.board.length;
  const pool = availableCards(spec);
  const staticBlocked = new Set<Card>([...spec.board, ...(spec.deadCards ?? [])]);

  const rangeCombos = spec.players.map((player) => player.range.combos);
  const budget: RejectionBudget = { spent: 0, limit: samples * 200 + 10_000 };

  for (let trial = 0; trial < samples; trial++) {
    const assignment = sampleLegalMatchup(rangeCombos, staticBlocked, random, budget);
    const runOut = drawRunOut(pool, assignment, needed, random);

    for (let i = 0; i < playerCount; i++) {
      const combo = assignment[i];
      if (combo === undefined) throw new EquityError('matchup is missing a hand');
      scores[i] = evaluate([combo[0], combo[1], ...spec.board, ...runOut]);
    }
    tally.record(scores);
  }

  const stdDev = tally.firstPlayerStdDev();
  const halfWidth = (1.96 * stdDev) / Math.sqrt(tally.count);

  return {
    method: 'monte-carlo',
    players: tally.toPlayerEquities(spec.players.map((player) => player.label)),
    trials: tally.count,
    // An upper bound, not the legal count. See `EquityResult.matchups`.
    matchups: rangeCombos.reduce((product, combos) => product * combos.length, 1),
    confidence: { level: 0.95, halfWidthPoints: halfWidth * 100, samples: tally.count },
    elapsedMs: performance.now() - started,
    assumptions: assumptionsFor(spec, 'monte-carlo', tally.count),
  };
}

/** Chooses the method by estimating the work, then runs it. Everything else calls this. */
export function equity(spec: EquitySpec, options: EquityOptions = {}): EquityResult {
  validateSpec(spec);
  const method = options.method ?? 'auto';
  if (method === 'exact') return exactEquity(spec);
  if (method === 'monte-carlo') return monteCarloEquity(spec, options);

  const budget = options.maxExactWork ?? DEFAULT_MAX_EXACT_WORK;
  const estimate = estimateExactWork(spec);
  if (estimate.total > 0 && estimate.total <= budget) return exactEquity(spec);
  return monteCarloEquity(spec, options);
}

/** Hero's equity as a plain fraction, for callers that need only the number. */
export function heroEquity(spec: EquitySpec, options: EquityOptions = {}): number {
  const result = equity(spec, options);
  const hero = result.players[0];
  if (hero === undefined) throw new EquityError('equity result has no players');
  return hero.equity;
}

/**
 * Combines independent Monte Carlo shards from different seeds. The interval is recomputed from the
 * pooled sample size. Averaging shard intervals would report one shard's precision, not the run's.
 */
export function combineMonteCarlo(shards: readonly EquityResult[]): EquityResult {
  if (shards.length === 0) throw new EquityError('cannot combine zero shards');
  const first = shards[0];
  if (first === undefined) throw new EquityError('cannot combine zero shards');
  if (shards.some((shard) => shard.method !== 'monte-carlo')) {
    throw new EquityError('only Monte Carlo results can be combined');
  }
  if (shards.some((shard) => shard.players.length !== first.players.length)) {
    throw new EquityError('shards disagree on the number of players');
  }

  const totalTrials = shards.reduce((sum, shard) => sum + shard.trials, 0);
  const players: PlayerEquity[] = first.players.map((_unused, index) => {
    let win = 0;
    let tie = 0;
    let share = 0;
    for (const shard of shards) {
      const player = shard.players[index];
      if (player === undefined) throw new EquityError('shard is missing a player');
      win += player.win * shard.trials;
      tie += player.tie * shard.trials;
      share += player.equity * shard.trials;
    }
    const label = first.players[index]?.label ?? `player ${index}`;
    return {
      label,
      win: win / totalTrials,
      tie: tie / totalTrials,
      lose: Math.max(0, 1 - win / totalTrials - tie / totalTrials),
      equity: share / totalTrials,
    };
  });

  let pooledVariance = 0;
  for (const shard of shards) {
    const halfWidth = (shard.confidence?.halfWidthPoints ?? 0) / 100;
    const stdDev = (halfWidth * Math.sqrt(shard.trials)) / 1.96;
    pooledVariance += stdDev * stdDev * shard.trials;
  }
  const pooledStdDev = Math.sqrt(pooledVariance / totalTrials);
  const combinedHalfWidth = (1.96 * pooledStdDev) / Math.sqrt(totalTrials);

  return {
    method: 'monte-carlo',
    players,
    trials: totalTrials,
    matchups: first.matchups,
    confidence: { level: 0.95, halfWidthPoints: combinedHalfWidth * 100, samples: totalTrials },
    elapsedMs: shards.reduce((max, shard) => Math.max(max, shard.elapsedMs), 0),
    assumptions: [
      ...first.assumptions.filter((note) => !note.startsWith('Estimated by sampling')),
      `Estimated by sampling ${totalTrials.toLocaleString('en-US')} random run-outs across ${shards.length} independent shards.`,
    ],
  };
}

/** Scores every player's current made hand. Only valid with 5 board cards. */
export function showdownScores(hands: readonly Combo[], board: readonly Card[]): HandScore[] {
  if (board.length !== 5) throw new EquityError(`showdownScores needs a full board, got ${board.length}`);
  return hands.map((combo) => evaluate([combo[0], combo[1], ...board]));
}
