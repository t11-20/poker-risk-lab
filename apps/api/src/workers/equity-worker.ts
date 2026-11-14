/**
 * The calculator, on its own thread, so long CPU runs never stall the event loop.
 * Imports only maths, the engine and `node:worker_threads`. No database, config or logger, so
 * `worker.terminate()` (which runs no cleanup) is safe and no hidden state can leak out.
 * Protocol types live here and `pool.ts` imports them with `import type`.
 * Method, samples and shards are decided in `calc/parse.ts`, never here.
 */

import { type MessagePort, parentPort } from 'node:worker_threads';
import type { CoachReport } from '@prl/contracts';
import type { Card } from '@prl/poker-engine';
import {
  buildCoachReport,
  type CoachAction,
  EquityError,
  type EquityPlayer,
  type EquityResult,
  type EquitySpec,
  exactEquity,
  exactRange,
  monteCarloEquity,
  type ParsedRange,
  parseRange,
  topPercentRange,
} from '@prl/poker-math';

/**
 * Descriptors, not expanded combos. `topPercent` needs the 3 s strength table, which must not run
 * on the main thread, and the other kinds expand deterministically from the string.
 */
export type WireRange =
  | { readonly kind: 'exact'; readonly label: string; readonly cards: readonly Card[] }
  | { readonly kind: 'notation'; readonly label: string; readonly notation: string }
  | { readonly kind: 'topPercent'; readonly label: string; readonly percent: number };

export interface WireSpec {
  readonly heroLabel: string;
  readonly heroCards: readonly Card[];
  readonly board: readonly Card[];
  readonly opponents: readonly WireRange[];
}

/** One whole exact calculation, or one Monte Carlo shard. `seed` is always required. */
export interface EquityTask {
  readonly kind: 'equity';
  readonly spec: WireSpec;
  readonly method: 'exact' | 'monte-carlo';
  readonly samples: number;
  readonly seed: number;
}

export interface CoachTask {
  readonly kind: 'coach';
  readonly spec: WireSpec;
  readonly street: 'preflop' | 'flop' | 'turn' | 'river';
  readonly pot: number;
  /**
   * The part of `pot` hero can win. Required, so a missing value is a compile error. Against the
   * whole pot, hero's 40 facing a 310 shove at 5/10 shows 8.6% needed instead of 37.5%. See
   * `CoachInput.contestablePot`.
   */
  readonly contestablePot: number;
  readonly toCall: number;
  readonly heroCommittedThisStreet: number;
  readonly heroStack: number;
  readonly opponentStacks: readonly number[];
  readonly bigBlind: number;
  readonly minimumRaiseTo?: number;
  /**
   * Required, because without it the Coach runs with its legality guard off. Callers without a
   * `HandState` pass `deriveLegalActions(...)`.
   */
  readonly legalActions: readonly CoachAction[];
  readonly samples: number;
  readonly seed: number;
}

/** Builds the strength table at boot, so `/ready` waits for it and the first learner does not. */
export interface WarmupTask {
  readonly kind: 'warmup';
}

export type WorkerTask = EquityTask | CoachTask | WarmupTask;

export interface WorkerRequest {
  readonly id: number;
  readonly task: WorkerTask;
}

/** The pool classifies on `name`. `message` goes to the server log only, never to a client. */
export interface WorkerFailure {
  readonly name: string;
  readonly message: string;
}

export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly kind: 'equity'; readonly result: EquityResult }
  | { readonly id: number; readonly ok: true; readonly kind: 'coach'; readonly report: CoachReport }
  | { readonly id: number; readonly ok: true; readonly kind: 'warmup' }
  | { readonly id: number; readonly ok: false; readonly failure: WorkerFailure };

function blockersOf(spec: WireSpec): Card[] {
  return [...spec.heroCards, ...spec.board];
}

/** `topPercent` goes back through `parseRange` because `topPercentRange` ignores blockers. */
function expandRange(range: WireRange, blockers: readonly Card[]): ParsedRange {
  if (range.kind === 'exact') return exactRange(range.cards);
  if (range.kind === 'notation') return parseRange(range.notation, blockers);
  return parseRange(topPercentRange(range.percent).notation, blockers);
}

/**
 * `k` opponents need `2k` distinct cards. `calc/parse.ts` checks this but cannot expand `top:NN`;
 * unchecked, five `top:1` opponents held a warm thread for 9,431 ms before the same 422 the
 * notation spelling gets in 0 ms. Hero and board cards are already removed from each range.
 */
function assertOpponentsAreDealable(players: readonly EquityPlayer[]): void {
  const opponents = players.slice(1);
  if (opponents.length === 0) return;
  const support = new Set<Card>();
  for (const opponent of opponents) {
    for (const combo of opponent.range.combos) {
      support.add(combo[0]);
      support.add(combo[1]);
    }
  }
  const needed = opponents.length * 2;
  if (support.size >= needed) return;
  throw new EquityError(
    `these ranges cannot all be dealt at once: ${opponents.length} opponents need ${needed} ` +
      `distinct cards between them and their ranges only contain ${support.size}`,
  );
}

function buildSpec(spec: WireSpec): EquitySpec {
  const blockers = blockersOf(spec);
  const players: EquityPlayer[] = [
    { label: spec.heroLabel, range: exactRange(spec.heroCards) },
    ...spec.opponents.map((opponent) => ({
      label: opponent.label,
      range: expandRange(opponent, blockers),
    })),
  ];
  assertOpponentsAreDealable(players);
  return { players, board: spec.board };
}

/** Not through `equity()`, which would enumerate matchups a second time to choose a method. */
function runEquity(task: EquityTask): EquityResult {
  const spec = buildSpec(task.spec);
  if (task.method === 'exact') return exactEquity(spec);
  return monteCarloEquity(spec, { samples: task.samples, seed: task.seed });
}

function runCoach(task: CoachTask): CoachReport {
  const spec = buildSpec(task.spec);
  const opponents = spec.players.slice(1).map((player) => ({ label: player.label, range: player.range }));
  return buildCoachReport({
    heroCards: task.spec.heroCards,
    board: task.spec.board,
    street: task.street,
    opponents,
    pot: task.pot,
    // Never defaulted here, or a caller that stopped sending it would keep compiling.
    contestablePot: task.contestablePot,
    toCall: task.toCall,
    heroCommittedThisStreet: task.heroCommittedThisStreet,
    heroStack: task.heroStack,
    opponentStacks: task.opponentStacks,
    bigBlind: task.bigBlind,
    ...(task.minimumRaiseTo === undefined ? {} : { minimumRaiseTo: task.minimumRaiseTo }),
    // Never defaulted here, for the same reason.
    legalActions: task.legalActions,
    samples: task.samples,
    seed: task.seed,
  });
}

function respond(request: WorkerRequest, port: MessagePort): void {
  try {
    let reply: WorkerResponse;
    if (request.task.kind === 'equity') {
      reply = { id: request.id, ok: true, kind: 'equity', result: runEquity(request.task) };
    } else if (request.task.kind === 'coach') {
      reply = { id: request.id, ok: true, kind: 'coach', report: runCoach(request.task) };
    } else {
      // The live Coach default.
      topPercentRange(40);
      reply = { id: request.id, ok: true, kind: 'warmup' };
    }
    port.postMessage(reply);
  } catch (error) {
    // Reported, not thrown, so a rejected request does not cost a warm thread.
    const failure: WorkerFailure =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: 'UnknownError', message: String(error) };
    const reply: WorkerResponse = { id: request.id, ok: false, failure };
    port.postMessage(reply);
  }
}

/** Loaded on the main thread by mistake. Doing nothing would look like every task hanging. */
if (parentPort === null) {
  throw new Error('equity-worker.ts must be run as a worker thread, not imported on the main thread');
}

const port = parentPort;
port.on('message', (request: WorkerRequest) => {
  respond(request, port);
});
