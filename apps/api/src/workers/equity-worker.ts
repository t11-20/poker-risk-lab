/**
 * The calculator, on its own thread. Nothing else.
 *
 * This file is the *only* place in the API where a long, uninterruptible stretch of CPU is
 * allowed to happen, and it is allowed here because it happens somewhere the event loop is
 * not. Enumerating 1.7 million boards takes about a quarter of a second; a Monte Carlo run
 * against five ranges takes half of one. On the main thread either of those is every
 * connected table's action timer stopping dead, so equity work goes here instead and the
 * pool in `pool.ts` treats a thread that overruns as something to kill rather than to wait
 * for.
 *
 * ## Why the import list is this short, and why that is load-bearing
 *
 * `@prl/poker-math`, `@prl/poker-engine`, and `node:worker_threads`. No database, no
 * configuration, no logger, no Fastify. That is not tidiness:
 *
 * - **It is what makes `worker.terminate()` safe.** Terminating a thread runs no cleanup: no
 *   `finally`, no destructor, no flush. A thread holding a pooled database connection, a
 *   half-written log line or a lock would leave that behind. A thread holding nothing but
 *   arithmetic can be killed at any instruction and the process is none the wiser.
 * - **It keeps hidden state out.** The redaction rules exist because state leaks through
 *   whatever exit is available; a worker with a logger is another exit. This thread never
 *   sees a `HandState`, a deck or a salt — only cards a caller sent us and ranges they named.
 * - **It keeps the thread cheap.** Every worker pays the import cost of everything reachable
 *   from here, once per thread.
 *
 * The type-only imports (`CoachReport`, `EquityResult`) are erased at compile time — with
 * `verbatimModuleSyntax` an `import type` emits nothing at all — so they add no runtime
 * dependency. The protocol types below live in this file rather than in `pool.ts` for the
 * same reason: the worker owns the contract, and `pool.ts` imports it with `import type` so
 * that requiring the protocol never means requiring the calculator.
 *
 * ## The one thing that is NOT decided here
 *
 * Whether a request is exact or sampled, how many samples it gets, and how many shards it
 * is split into are all decided before the task is posted (see `calc/parse.ts`). A worker
 * that chose its own method could not be sharded — each shard would be free to pick a
 * different one — and the wall-clock budget could not be planned. So `method` arrives on the
 * message and this file obeys it.
 */

import { type MessagePort, parentPort } from 'node:worker_threads';
import type { CoachReport } from '@prl/contracts';
import type { Card } from '@prl/poker-engine';
import {
  buildCoachReport,
  type CoachAction,
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

// ---------------------------------------------------------------------------
// The wire protocol
// ---------------------------------------------------------------------------

/**
 * One player's range as it crosses the thread boundary.
 *
 * Descriptors rather than expanded combination lists, for two reasons. A `topPercent` range
 * cannot be expanded on the main thread at all — `topPercentRange` builds a 169-class
 * strength table by measuring every class against a random hand, which takes about three
 * seconds the first time it is asked (memoised per thread thereafter). That is precisely the
 * kind of stall this whole file exists to move off the event loop. And for the other two
 * kinds the expansion is a pure function of the string: `calc/parse.ts` has already run the
 * same `parseRange`/`exactRange` call to validate the request and count its combinations, so
 * running it again here cannot produce a different answer, only the same one on a different
 * thread.
 */
export type WireRange =
  | { readonly kind: 'exact'; readonly label: string; readonly cards: readonly Card[] }
  | { readonly kind: 'notation'; readonly label: string; readonly notation: string }
  | { readonly kind: 'topPercent'; readonly label: string; readonly percent: number };

/** Hero, the board, and everyone hero is up against. */
export interface WireSpec {
  readonly heroLabel: string;
  readonly heroCards: readonly Card[];
  readonly board: readonly Card[];
  readonly opponents: readonly WireRange[];
}

/**
 * One equity job: a whole calculation when `method` is `exact`, one shard of a sampled run
 * when it is `monte-carlo`.
 *
 * `seed` is mandatory even for the exact path, where it is unused, so that a task is always
 * a complete description of a reproducible computation and no caller has to remember which
 * fields matter for which method.
 */
export interface EquityTask {
  readonly kind: 'equity';
  readonly spec: WireSpec;
  readonly method: 'exact' | 'monte-carlo';
  readonly samples: number;
  readonly seed: number;
}

/** One Coach report. Never sharded: `buildCoachReport` is a single indivisible analysis. */
export interface CoachTask {
  readonly kind: 'coach';
  readonly spec: WireSpec;
  readonly street: 'preflop' | 'flop' | 'turn' | 'river';
  readonly pot: number;
  /**
   * The part of `pot` hero can actually win. **Required, and required for the same reason
   * `legalActions` is.**
   *
   * A learner all-in for less than the bet facing them cannot win the side pot their stack
   * does not reach, and this type having no field for it is what let every surface behind
   * this wire price the call against the whole middle. Measured heads-up at 5/10, hero 40
   * against a 310 shove: "10.7 to 1, you need 8.6%" where the answer is 1.67 to 1 and
   * 37.5%, and a call worth -4.2 chips published at +82.8. See `CoachInput.contestablePot`.
   *
   * Callers with seat states use `contestablePotFor` from `@prl/poker-engine`; callers
   * describing a spot use `deriveContestablePot`. A task built without one is a compile
   * error at the caller rather than a mispriced report at a learner.
   */
  readonly contestablePot: number;
  readonly toCall: number;
  /** Chips hero has already put out on this street. See `CoachInput`. */
  readonly heroCommittedThisStreet: number;
  readonly heroStack: number;
  readonly opponentStacks: readonly number[];
  readonly bigBlind: number;
  /** The engine's own `legalActions` minimum, when the caller has a hand state. */
  readonly minimumRaiseTo?: number;
  /**
   * The action kinds hero may take here. **Required, and required for a reason.**
   *
   * `CoachInput.legalActions` was optional and this type had no field for it at all, so
   * every surface that crosses this boundary — the Scenario Lab, the hand review, the
   * profile comparison and `POST /math/coach` — analysed with the Coach's legality guard
   * disabled. Only the live table, which never crosses this boundary, supplied one.
   *
   * Making it required here is what stops that recurring: a task built without one is a
   * compile error at the caller rather than a report whose candidates the table would
   * refuse. Callers with no `HandState` pass `deriveLegalActions(...)`, which is the
   * honest answer for a described spot and is never the permissive one.
   */
  readonly legalActions: readonly CoachAction[];
  readonly samples: number;
  readonly seed: number;
}

/**
 * Forces this thread to build the preflop strength table.
 *
 * `topPercentRange` memoises a 169-class ordering that takes about three seconds the first
 * time a thread is asked. Live Coach requests default to `top:40`, so a process that has never
 * served one pays that cost on the first learner. The pool pre-warms every thread with this
 * task at boot so `/ready` can stay false until that cost is behind us, and the first live
 * request is a warm one.
 */
export interface WarmupTask {
  readonly kind: 'warmup';
}

export type WorkerTask = EquityTask | CoachTask | WarmupTask;

export interface WorkerRequest {
  /** Correlates a response with its request. Assigned by the pool. */
  readonly id: number;
  readonly task: WorkerTask;
}

/**
 * What failed, in the only two fields the pool is allowed to look at.
 *
 * The name is what the pool classifies on — an `EquityError` is a rejected request, anything
 * else is a bug — and the message is for the server-side log line only. It never reaches a
 * client: the route maps the name to an `ErrorCode` and the client gets the contract's
 * wording for that code. See the "no information leaks through errors" rule.
 */
export interface WorkerFailure {
  readonly name: string;
  readonly message: string;
}

export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly kind: 'equity'; readonly result: EquityResult }
  | { readonly id: number; readonly ok: true; readonly kind: 'coach'; readonly report: CoachReport }
  | { readonly id: number; readonly ok: true; readonly kind: 'warmup' }
  | { readonly id: number; readonly ok: false; readonly failure: WorkerFailure };

// ---------------------------------------------------------------------------
// Building the calculation
// ---------------------------------------------------------------------------

/** Cards an opponent cannot hold, because hero holds them or they are on the board. */
function blockersOf(spec: WireSpec): Card[] {
  return [...spec.heroCards, ...spec.board];
}

/**
 * Expands one descriptor.
 *
 * `topPercent` goes through `topPercentRange(...).notation` and then `parseRange`, rather
 * than using the returned range directly, because the range from `topPercentRange` knows
 * nothing about blockers. An opponent cannot hold a card hero is holding, and a "top 15%"
 * range that still contains hero's ace is the classic error that inflates an opponent's
 * strong combinations. Routing it through `parseRange` means every range in this file is
 * built by exactly one function with exactly one blocker rule.
 */
function expandRange(range: WireRange, blockers: readonly Card[]): ParsedRange {
  if (range.kind === 'exact') return exactRange(range.cards);
  if (range.kind === 'notation') return parseRange(range.notation, blockers);
  return parseRange(topPercentRange(range.percent).notation, blockers);
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
  return { players, board: spec.board };
}

/**
 * Runs one equity task.
 *
 * `exactEquity` and `monteCarloEquity` are called directly rather than through `equity()`.
 * `equity()`'s job is to choose between them, and it chooses by counting the legal matchups
 * first — which enumerates them, and then `exactEquity` enumerates them a second time. The
 * choice has already been made (and its reasoning recorded) in `calc/parse.ts`, so paying
 * for it again here would double the cost of the one path that is already the expensive one.
 */
function runEquity(task: EquityTask): EquityResult {
  const spec = buildSpec(task.spec);
  if (task.method === 'exact') return exactEquity(spec);
  return monteCarloEquity(spec, { samples: task.samples, seed: task.seed });
}

/**
 * Runs one Coach task.
 *
 * Unlike the equity path this one does go through `equity()` internally, because
 * `buildCoachReport` owns that decision and the Coach's report has to state the method it
 * used. The consequence is spelled out where the budget is chosen: a Coach request pays for
 * the matchup count as well as the calculation.
 */
function runCoach(task: CoachTask): CoachReport {
  const spec = buildSpec(task.spec);
  const opponents = spec.players.slice(1).map((player) => ({ label: player.label, range: player.range }));
  return buildCoachReport({
    heroCards: task.spec.heroCards,
    board: task.spec.board,
    street: task.street,
    opponents,
    pot: task.pot,
    // Passed straight through for the same reason `legalActions` is: a `?? task.pot` here
    // would restore the defect the field exists to close, and would do it invisibly.
    contestablePot: task.contestablePot,
    toCall: task.toCall,
    heroCommittedThisStreet: task.heroCommittedThisStreet,
    heroStack: task.heroStack,
    opponentStacks: task.opponentStacks,
    bigBlind: task.bigBlind,
    ...(task.minimumRaiseTo === undefined ? {} : { minimumRaiseTo: task.minimumRaiseTo }),
    // Passed straight through, never defaulted here. A `?? deriveLegalActions(task)` on
    // this line would look like belt and braces and would in fact re-open the hole: a
    // caller that stopped sending the field would keep working, and the compile error
    // that is the whole point of making it required would never be seen.
    legalActions: task.legalActions,
    samples: task.samples,
    seed: task.seed,
  });
}

/**
 * Runs one request and posts one reply.
 *
 * Every reply is built as a typed `WorkerResponse` before it is posted, so the protocol is
 * checked at compile time on this side of the boundary as well as in the pool. A structural
 * mismatch between the two halves of a `postMessage` is otherwise the sort of bug that only
 * appears as a task that never settles.
 */
function respond(request: WorkerRequest, port: MessagePort): void {
  try {
    let reply: WorkerResponse;
    if (request.task.kind === 'equity') {
      reply = { id: request.id, ok: true, kind: 'equity', result: runEquity(request.task) };
    } else if (request.task.kind === 'coach') {
      reply = { id: request.id, ok: true, kind: 'coach', report: runCoach(request.task) };
    } else {
      // The percent is the live Coach default. Any value would build the same table; this one
      // is the table the first real request will actually look up.
      topPercentRange(40);
      reply = { id: request.id, ok: true, kind: 'warmup' };
    }
    port.postMessage(reply);
  } catch (error) {
    // Caught and reported rather than thrown, so one rejected request does not cost the
    // thread: an uncaught throw here becomes an 'error' event on the Worker and the pool has
    // to discard the whole thread, losing a warm strength table with it.
    const failure: WorkerFailure =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: 'UnknownError', message: String(error) };
    const reply: WorkerResponse = { id: request.id, ok: false, failure };
    port.postMessage(reply);
  }
}

/**
 * A missing `parentPort` means this module was loaded on the main thread, which is a
 * programming error rather than a case to tolerate: the only legitimate references to this
 * file are `new Worker(url)` and `import type`, and silently doing nothing would present as
 * a pool where every task hangs until its timeout.
 */
if (parentPort === null) {
  throw new Error('equity-worker.ts must be run as a worker thread, not imported on the main thread');
}

const port = parentPort;
port.on('message', (request: WorkerRequest) => {
  respond(request, port);
});
