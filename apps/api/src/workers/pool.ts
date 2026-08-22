/**
 * A small, bounded, cancellable pool of calculator threads.
 *
 * Monte Carlo is the one place in this API where a 200-byte request buys a lot of CPU, so it
 * gets the treatment that shape of work needs: a fixed number of threads, a bounded queue in
 * front of them, a wall-clock deadline per request, and a kill switch for a thread that
 * overruns it. Everything below is one of those four things.
 *
 * ## Why threads are reused and never spawned per request
 *
 * Starting a worker costs a new V8 isolate plus the import of `@prl/poker-math` and
 * `@prl/poker-engine` — tens of milliseconds, comfortably more than a typical calculation.
 * Worse, the preflop strength table that `top:NN` needs is memoised *per thread* and takes
 * about three seconds to build, so a thread-per-request pool would rebuild it every time.
 *
 * Production therefore pre-warms every thread at boot (`WorkerPool.warm`, driven from
 * `server.ts`) and `/ready` stays 503 until that finishes. A deployment that never serves
 * Coach still pays the three seconds once, at startup, rather than on the first learner. Tests
 * that never call `beginSharedPoolWarmup` keep the old lazy behaviour: no threads, and `/ready`
 * does not wait for them.
 *
 * ## The deadline is wall-clock, and it starts when the request is submitted
 *
 * Not when a thread picks the task up. Queue time is time the caller is waiting, and a budget
 * that excluded it would let a busy pool blow through any latency promise while every
 * individual task still looked healthy.
 *
 * When the deadline fires there is exactly one way to stop a synchronous enumeration loop:
 * `worker.terminate()`. That is why the worker is a pure calculator (see `equity-worker.ts`) —
 * terminating a thread runs no `finally`, no flush and no destructor, so a thread must never
 * hold anything that needs one. A terminated thread is dropped from the pool and the next
 * submission creates a replacement, so a timeout costs one warm thread and never leaks one.
 *
 * ## The queue is bounded, and full means "no"
 *
 * An unbounded queue turns a CPU limit into a memory limit and a latency limit into neither:
 * callers keep being accepted, each waits longer than the last, and each eventually times out
 * having consumed a slot anyway. A full queue answers `service_unavailable` immediately, which
 * is both honest and cheap. The bound scales with the pool, because a bigger pool drains
 * faster.
 *
 * ## One pool per process
 *
 * `getSharedPool` exists because two pools would mean twice the threads competing for the same
 * cores while each believed it was inside its own limit. Route modules that need calculation
 * (`routes/calc.ts` today, the WebSocket hub's Coach request later) take the shared one and
 * close it from an `onClose` hook. This mirrors the single-client rule in `db.ts`, with the
 * same caveat: the first caller's sizing wins for the life of the process.
 */

import { Worker } from 'node:worker_threads';
import type { CoachReport } from '@prl/contracts';
import { combineMonteCarlo, type EquityResult } from '@prl/poker-math';
import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import type {
  CoachTask,
  EquityTask,
  WarmupTask,
  WireSpec,
  WorkerFailure,
  WorkerRequest,
  WorkerResponse,
  WorkerTask,
} from './equity-worker.ts';

/**
 * Queue slots per thread.
 *
 * Three is a deliberate compromise. One would refuse a caller the instant every thread is
 * busy, which is wrong for work that usually takes tens of milliseconds. A large number
 * accepts requests the pool cannot serve inside the deadline, so the caller waits and *then*
 * gets a timeout instead of an immediate, actionable `service_unavailable`. With four threads
 * and a half-second task, twelve queued tasks is roughly the deepest queue whose last entry
 * can still finish in time.
 */
const QUEUE_SLOTS_PER_WORKER = 3;

/**
 * Worker heap ceiling, in megabytes.
 *
 * Every calculation here has bounded allocation by construction — the largest thing any of
 * them builds is a 1,326-entry combination list — so reaching this means something has gone
 * wrong, and the point is that it goes wrong *inside a thread that can be dropped* instead of
 * taking the server's heap with it. Node reports the breach as an `error` event on the Worker,
 * which this file already handles.
 */
const WORKER_HEAP_MB = 256;

/**
 * Wall-clock budget for pre-warming one pool.
 *
 * The strength table is about three seconds on the reference machine; twelve seconds is the
 * allowance live Coach requests already get (`STRENGTH_TABLE_ALLOWANCE_MS` in `calc/parse.ts`).
 * Fifteen leaves a little more for a cold isolate on a slower box without approaching the
 * 20-second request timeout that would otherwise cut the process off mid-boot.
 */
const WARMUP_TIMEOUT_MS = 15_000;

/** A worker reply that carries a result, i.e. everything except a failure. */
type SuccessResponse = Extract<WorkerResponse, { ok: true }>;

interface Job {
  readonly id: number;
  readonly task: WorkerTask;
  readonly resolve: (response: SuccessResponse) => void;
  readonly reject: (error: unknown) => void;
  /** The thread running this job; null while it is still queued. */
  worker: Worker | null;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

/** Counters, for tests and for an operator asking whether the pool is the bottleneck. */
export interface PoolStats {
  readonly size: number;
  readonly workers: number;
  readonly busy: number;
  readonly queued: number;
  readonly submitted: number;
  readonly completed: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly rejected: number;
  readonly closed: boolean;
}

/** Diagnostics the pool cannot log itself, because it must not import the logger. */
export interface PoolWarning {
  readonly event: 'worker-error' | 'worker-exit' | 'task-timeout' | 'protocol-mismatch';
  readonly detail: string;
}

export interface PoolOptions {
  /** Maximum threads. `config.monteCarloWorkers`. */
  readonly size: number;
  /** Default wall-clock budget per submitted task. `config.coachTimeoutMs`. */
  readonly timeoutMs: number;
  /** Defaults to `size * QUEUE_SLOTS_PER_WORKER`. */
  readonly queueLimit?: number;
  /** Test seam: a different worker script. Production leaves this alone. */
  readonly workerUrl?: URL;
  /** Called for anything worth a log line. The route module passes `app.log`. */
  readonly onWarn?: (warning: PoolWarning) => void;
}

/**
 * The worker script's URL, resolved from this module's own extension.
 *
 * In development and in tests this file runs as `pool.ts` and Node strips the types; after
 * `tsc` it runs as `dist/workers/pool.js` beside `dist/workers/equity-worker.js`. Import
 * specifiers are rewritten on emit, but a string inside `new URL(...)` is not, so the
 * extension is derived rather than written down. Getting it wrong fails loudly — the Worker
 * constructor throws `MODULE_NOT_FOUND` — rather than silently, which is the right direction.
 */
function defaultWorkerUrl(): URL {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return new URL(`./equity-worker${extension}`, import.meta.url);
}

/**
 * The report a thread sent back names no action the task did not permit.
 *
 * `buildCoachReport` already filters its own candidates through `legalActions`, so in a
 * healthy process this never fires. It is here because the failure it guards against is
 * silent by nature and was live in production for the whole of this feature's life: the
 * field was optional, the wire type had no slot for it, and the filter treated "absent" as
 * "everything is permitted", so four of the five Coach surfaces published actions the table
 * would refuse and nothing anywhere said so. A report is the one thing a learner is asked to
 * trust, so the pool checks the reply against the request rather than assuming the two agree.
 *
 * Deliberately on the boundary between the thread and the route, not inside the route:
 * `routes/calc.ts` and `routes/content.ts` both serve Coach reports, and a check written
 * twice is a check one of them eventually loses.
 *
 * Exported for `test/coach-legality.test.ts` only. It cannot be reached through `runCoach`
 * with a healthy worker — which is the point of it — so the alternative to exporting it is a
 * guard nothing ever executes, and the audit that produced this fix was largely a list of
 * those.
 */
export function assertReportStaysInsideItsLegalSet(task: CoachTask, report: CoachReport): void {
  const permitted = new Set<string>(task.legalActions);
  const published = [...new Set(report.candidates.map((candidate) => candidate.action))];
  const outside = published.filter((action) => !permitted.has(action));
  if (outside.length > 0 || !permitted.has(report.suggestion.action)) {
    throw new AppError('internal_error', {
      logDetail:
        `a Coach report named ${[...new Set([...outside, report.suggestion.action])].join(', ')} for a ` +
        `spot whose legal actions are ${[...permitted].join(', ')}; refusing to serve it`,
    });
  }
}

/**
 * One equity calculation, possibly split across shards.
 *
 * Produced by `calc/parse.ts`, which is where the method, the sample count and the shard count
 * are decided and where the reasoning for each of them lives.
 */
export interface ShardedEquityRequest {
  readonly spec: WireSpec;
  readonly method: 'exact' | 'monte-carlo';
  /** Total samples across every shard. Ignored on the exact path. */
  readonly samples: number;
  /** 1 for exact; 1 or more for sampled. */
  readonly shards: number;
  /** Seed of the first shard; shard `i` uses `seed + i`. */
  readonly seed: number;
}

export class WorkerPool {
  private readonly size: number;
  private readonly timeoutMs: number;
  private readonly queueLimit: number;
  private readonly workerUrl: URL;
  private readonly onWarn: (warning: PoolWarning) => void;

  private readonly idle: Worker[] = [];
  private readonly busy = new Map<Worker, Job>();
  private readonly queue: Job[] = [];
  /** Threads already removed from the pool, so `discard` cannot double-count one. */
  private readonly dead = new WeakSet<Worker>();
  private workerCount = 0;
  private nextJobId = 1;
  private closed = false;

  private submittedCount = 0;
  private completedCount = 0;
  private failedCount = 0;
  private timedOutCount = 0;
  private rejectedCount = 0;

  constructor(options: PoolOptions) {
    this.size = Math.max(1, Math.floor(options.size));
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
    this.queueLimit = Math.max(1, Math.floor(options.queueLimit ?? this.size * QUEUE_SLOTS_PER_WORKER));
    this.workerUrl = options.workerUrl ?? defaultWorkerUrl();
    this.onWarn = options.onWarn ?? ((): void => undefined);
  }

  stats(): PoolStats {
    return {
      size: this.size,
      workers: this.workerCount,
      busy: this.busy.size,
      queued: this.queue.length,
      submitted: this.submittedCount,
      completed: this.completedCount,
      failed: this.failedCount,
      timedOut: this.timedOutCount,
      rejected: this.rejectedCount,
      closed: this.closed,
    };
  }

  /**
   * Runs one Coach analysis.
   *
   * Never sharded: `buildCoachReport` produces one report from one equity figure, and two
   * halves of a report could not be combined into anything meaningful.
   */
  /**
   * Spawns every thread and builds the preflop strength table on each of them.
   *
   * One warmup task per slot, submitted together, so a pool of four does the three-second
   * table build four times in parallel rather than four times in sequence. After this
   * resolves, a live `top:NN` Coach request on any of those threads is a warm lookup.
   */
  async warm(timeoutMs?: number): Promise<void> {
    const tasks: WarmupTask[] = Array.from({ length: this.size }, () => ({ kind: 'warmup' }));
    const responses = await this.runBatch(tasks, timeoutMs ?? WARMUP_TIMEOUT_MS);
    for (const response of responses) {
      if (response.kind !== 'warmup') {
        throw new AppError('internal_error', {
          logDetail: 'calculation thread returned a non-warmup reply for a warmup task',
        });
      }
    }
  }

  async runCoach(task: CoachTask, timeoutMs?: number): Promise<CoachReport> {
    const [response] = await this.runBatch([task], timeoutMs);
    if (response === undefined || response.kind !== 'coach') {
      throw new AppError('internal_error', {
        logDetail: 'calculation thread returned a non-coach reply for a coach task',
      });
    }
    assertReportStaysInsideItsLegalSet(task, response.report);
    return response.report;
  }

  /**
   * Runs one equity calculation, sharding a sampled run by seed and combining the shards.
   *
   * `combineMonteCarlo` is what keeps the sharding honest. It sums the shards' counts and then
   * **recomputes the confidence interval from the pooled sample size** rather than averaging
   * the shards' intervals. Averaging would report one shard's error bar for a run with several
   * times as many samples, which overstates it; the opposite naive mistake — four shards, so a
   * quarter of the interval — understates it, because sampling error falls with the square
   * root of the sample size and not with the sample size. Four shards of 50,000 report an
   * interval about half a single shard's, not a quarter of it.
   */
  async runEquity(request: ShardedEquityRequest, timeoutMs?: number): Promise<EquityResult> {
    const responses = await this.runBatch(shardTasks(request), timeoutMs);
    const results: EquityResult[] = [];
    for (const response of responses) {
      if (response.kind !== 'equity') {
        throw new AppError('internal_error', {
          logDetail: 'calculation thread returned a non-equity reply for an equity task',
        });
      }
      results.push(response.result);
    }
    const first = results[0];
    if (first === undefined) {
      throw new AppError('internal_error', { logDetail: 'equity request produced no shards' });
    }
    // Combined in submission order, never completion order, so the figure does not depend on
    // which thread happened to finish first.
    return results.length === 1 ? first : combineMonteCarlo(results);
  }

  /**
   * Submits a set of tasks that succeed or fail together, under one shared deadline.
   *
   * Capacity is checked for the whole set before any of it is submitted. Admitting three
   * shards of four and refusing the fourth would burn three threads on work whose result can
   * never be assembled — the caller gets an error either way, so the right error is the one
   * that costs nothing.
   */
  private async runBatch(tasks: readonly WorkerTask[], timeoutMs?: number): Promise<SuccessResponse[]> {
    if (this.closed) {
      this.rejectedCount += 1;
      throw new AppError('service_unavailable', { logDetail: 'calculation pool is shutting down' });
    }
    if (this.queue.length + tasks.length > this.queueLimit) {
      this.rejectedCount += 1;
      throw new AppError('service_unavailable', {
        logDetail:
          `calculation queue is full (${this.queue.length} of ${this.queueLimit} slots), ` +
          `refused ${tasks.length} task(s)`,
      });
    }

    const budget = Math.max(1, Math.floor(timeoutMs ?? this.timeoutMs));
    const jobs = tasks.map((task) => this.submit(task, budget));
    try {
      return await Promise.all(jobs.map((entry) => entry.promise));
    } catch (error) {
      // One shard failing makes every sibling's work worthless, so stop paying for it: queued
      // siblings are dropped and running ones are terminated. Without this, a request that has
      // already failed keeps the pool busy for the rest of its budget.
      for (const entry of jobs) this.cancel(entry.job);
      throw error;
    }
  }

  private submit(
    task: WorkerTask,
    budget: number,
  ): { readonly job: Job; readonly promise: Promise<SuccessResponse> } {
    this.submittedCount += 1;
    const id = this.nextJobId;
    this.nextJobId += 1;

    const { promise, resolve, reject } = Promise.withResolvers<SuccessResponse>();
    const job: Job = { id, task, resolve, reject, worker: null, timer: null, settled: false };
    // Armed here — at submission — so that time spent queued counts against the caller's
    // budget rather than being invisible.
    job.timer = setTimeout(() => {
      this.expire(job);
    }, budget);
    this.queue.push(job);
    this.pump();
    return { job, promise };
  }

  /** Hands queued jobs to idle threads, creating threads up to `size` as needed. */
  private pump(): void {
    if (this.closed) return;
    while (this.queue.length > 0) {
      const worker = this.idle.pop() ?? this.spawnIfAllowed();
      if (worker === null) return;
      const job = this.queue.shift();
      if (job === undefined) {
        this.parkIdle(worker);
        return;
      }
      this.assign(worker, job);
    }
  }

  /**
   * A new thread, or null when the pool is at its size — or when a thread cannot be started at
   * all.
   *
   * That last case needs handling rather than propagating. `new Worker()` reports a missing or
   * broken script through an `error` event, but an unusable *configuration* throws here, and a
   * throw escaping `pump` would leave queued jobs holding armed deadlines that nobody is
   * awaiting: the timer would fire, reject an unobserved promise, and `server.ts` exits the
   * process on an unhandled rejection. So the queue is failed instead, honestly, with a code.
   */
  private spawnIfAllowed(): Worker | null {
    if (this.workerCount >= this.size) return null;
    try {
      return this.spawn();
    } catch (error) {
      const failure = new AppError('service_unavailable', {
        logDetail: 'a calculation thread could not be started',
        cause: error,
      });
      this.onWarn({ event: 'worker-error', detail: 'a calculation thread could not be started' });
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (job === undefined || job.settled) continue;
        this.finish(job);
        this.failedCount += 1;
        job.reject(failure);
      }
      return null;
    }
  }

  private assign(worker: Worker, job: Job): void {
    job.worker = worker;
    this.busy.set(worker, job);
    // A thread with work to do must keep the process alive; `parkIdle` is the other half.
    worker.ref();
    const request: WorkerRequest = { id: job.id, task: job.task };
    worker.postMessage(request);
  }

  private spawn(): Worker {
    const worker = new Worker(this.workerUrl, {
      name: 'prl-equity',
      // The calculator needs no configuration, so it is given none. An empty environment also
      // means that a `process.env` read from anywhere inside a future dependency cannot pick
      // up this process's database URL or cookie secret.
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    this.workerCount += 1;

    worker.on('message', (response: WorkerResponse) => {
      this.onMessage(worker, response);
    });
    worker.on('error', (error: Error) => {
      this.onWarn({ event: 'worker-error', detail: `${error.name}: ${error.message}` });
      this.failWorker(
        worker,
        new AppError('internal_error', { logDetail: 'calculation thread errored', cause: error }),
      );
    });
    worker.on('exit', (code) => {
      // Only surprising when a job was in flight: a thread this pool terminated on purpose
      // exits with its job already settled.
      const job = this.busy.get(worker);
      if (job !== undefined && !job.settled) {
        this.onWarn({ event: 'worker-exit', detail: `thread exited with code ${code} mid-task` });
        this.failWorker(
          worker,
          new AppError('internal_error', { logDetail: `calculation thread exited (${code})` }),
        );
        return;
      }
      this.discard(worker);
    });

    return worker;
  }

  private onMessage(worker: Worker, response: WorkerResponse): void {
    const job = this.busy.get(worker);
    if (job === undefined) {
      // A reply for a job that already timed out, from a thread terminated a moment too late.
      // Nothing to settle and nothing to return the thread to.
      return;
    }
    if (response.id !== job.id) {
      // One thread runs one task at a time, so this cannot happen unless the protocol has
      // drifted. Drop the thread rather than guess which job the reply belongs to.
      this.onWarn({
        event: 'protocol-mismatch',
        detail: `thread replied to job ${response.id} while running job ${job.id}`,
      });
      this.failWorker(
        worker,
        new AppError('internal_error', { logDetail: 'calculation thread replied out of turn' }),
      );
      return;
    }

    this.finish(job);
    this.busy.delete(worker);
    this.parkIdle(worker);

    if (response.ok) {
      this.completedCount += 1;
      job.resolve(response);
      return;
    }
    this.failedCount += 1;
    job.reject(failureToAppError(response.failure));
  }

  /** A thread died or misbehaved: settle whatever it was running, then drop it. */
  private failWorker(worker: Worker, error: AppError): void {
    const job = this.busy.get(worker);
    this.discard(worker);
    if (job === undefined || job.settled) return;
    this.finish(job);
    this.failedCount += 1;
    job.reject(error);
  }

  /** The deadline fired. */
  private expire(job: Job): void {
    if (job.settled) return;
    this.timedOutCount += 1;
    const detail =
      job.worker === null
        ? `job ${job.id} (${job.task.kind}) timed out while still queued`
        : `job ${job.id} (${job.task.kind}) timed out; terminating its thread`;
    this.onWarn({ event: 'task-timeout', detail });
    this.cancel(job);
    job.reject(new AppError('computation_timeout', { logDetail: detail }));
  }

  /**
   * Stops a job without settling it: dequeues it if it is waiting, kills its thread if it is
   * running. Terminating is the only way to interrupt a synchronous enumeration loop, and it
   * is safe precisely because the worker holds nothing that needs unwinding.
   */
  private cancel(job: Job): void {
    if (job.settled) return;
    this.finish(job);
    const worker = job.worker;
    if (worker !== null) {
      this.discard(worker);
      return;
    }
    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
  }

  /** Marks a job as no longer pending and disarms its deadline. */
  private finish(job: Job): void {
    job.settled = true;
    if (job.timer !== null) {
      clearTimeout(job.timer);
      job.timer = null;
    }
  }

  /** Returns a thread to the idle set, or terminates it if the pool is closing. */
  private parkIdle(worker: Worker): void {
    if (this.closed || this.dead.has(worker)) {
      this.discard(worker);
      return;
    }
    // An idle thread must not be the reason this process stays alive. Without the unref, a
    // forgotten pool would keep a test runner — or a server that has finished shutting down —
    // waiting on threads with nothing to do.
    worker.unref();
    this.idle.push(worker);
    this.pump();
  }

  /** Removes a thread from the pool and terminates it. Safe to call more than once. */
  private discard(worker: Worker): void {
    this.busy.delete(worker);
    const index = this.idle.indexOf(worker);
    if (index >= 0) this.idle.splice(index, 1);
    if (this.dead.has(worker)) return;
    this.dead.add(worker);
    this.workerCount = Math.max(0, this.workerCount - 1);
    // `terminate()` resolves once the thread is gone and cannot reject; nothing here needs to
    // wait for it, and a job that was running on it has already been settled by the caller.
    void worker.terminate();
    this.pump();
  }

  /**
   * Shuts the pool down: refuses new work, abandons what is queued, terminates every thread.
   *
   * Queued jobs are rejected rather than drained. Shutdown has a deadline of its own (see
   * `server.ts`) and a calculation nobody is waiting for any more is not worth delaying it by.
   */
  async close(): Promise<void> {
    this.closed = true;
    const abandoned = [...this.queue, ...this.busy.values()];
    this.queue.length = 0;
    for (const job of abandoned) {
      if (job.settled) continue;
      this.finish(job);
      this.rejectedCount += 1;
      job.reject(new AppError('service_unavailable', { logDetail: 'calculation pool closed' }));
    }

    const workers = [...this.idle, ...this.busy.keys()];
    this.idle.length = 0;
    this.busy.clear();
    for (const worker of workers) this.dead.add(worker);
    this.workerCount = 0;
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

/**
 * Splits a request into per-shard tasks.
 *
 * Shard `i` gets `seed + i`, which is what makes the split reproducible: the same request
 * always produces the same shards with the same seeds and therefore the same combined figure,
 * whatever the pool's size or the machine's load. The remainder goes to the first shard so the
 * shards sum to exactly the requested sample count — rounding it down would make the reported
 * sample size a lie.
 */
export function shardTasks(request: ShardedEquityRequest): EquityTask[] {
  if (request.method === 'exact') {
    return [{ kind: 'equity', spec: request.spec, method: 'exact', samples: 0, seed: request.seed }];
  }
  const shards = Math.max(1, Math.floor(request.shards));
  const base = Math.floor(request.samples / shards);
  const remainder = request.samples - base * shards;
  const tasks: EquityTask[] = [];
  for (let index = 0; index < shards; index++) {
    const samples = base + (index === 0 ? remainder : 0);
    if (samples <= 0) continue;
    tasks.push({
      kind: 'equity',
      spec: request.spec,
      method: 'monte-carlo',
      samples,
      seed: request.seed + index,
    });
  }
  return tasks;
}

/**
 * Maps a worker failure to an `ErrorCode`, by error class and nothing else.
 *
 * `EquityError`, `CoachError` and `StackError` are the maths package refusing a calculation it
 * cannot do honestly — ranges that block each other so completely that no legal matchup exists,
 * for instance. That is a statement about the request, so it becomes `computation_rejected`
 * (422). Anything else is a bug in our own planning: `calc/parse.ts` has already validated the
 * cards, the ranges and the board, so a `CardParseError` or a `RangeParseError` arriving here
 * means those two disagree, and a caller must not be told that as though it were their mistake.
 *
 * The thread's message goes into `logDetail` and never into a response body.
 */
function failureToAppError(failure: WorkerFailure): AppError {
  const rejected =
    failure.name === 'EquityError' || failure.name === 'CoachError' || failure.name === 'StackError';
  return new AppError(rejected ? 'computation_rejected' : 'internal_error', {
    logDetail: `calculation thread refused the task: ${failure.name}: ${failure.message}`,
  });
}

// ---------------------------------------------------------------------------
// The process-wide pool
// ---------------------------------------------------------------------------

let shared: WorkerPool | null = null;

type WarmupState = 'idle' | 'pending' | 'ready' | 'failed';

let warmupRequired = false;
let warmupState: WarmupState = 'idle';
let warmupError: string | undefined;
let warmupPromise: Promise<void> | null = null;

function dropClosedShared(): void {
  if (shared?.stats().closed) {
    shared = null;
    // The finished warmup described the dead pool. Drop the promise so a later
    // `beginSharedPoolWarmup` actually starts threads again instead of joining a resolved no-op.
    warmupPromise = null;
    if (warmupRequired && warmupState !== 'failed') warmupState = 'pending';
  }
}

function resetWarmup(): void {
  warmupRequired = false;
  warmupState = 'idle';
  warmupError = undefined;
  warmupPromise = null;
}

/**
 * The process-wide pool, or `null` when none exists or the memo still points at a closed one.
 *
 * Metrics scrape this rather than calling `getSharedPool`, so a Prometheus poll cannot be the
 * thing that creates four threads. A closed leftover is treated as absent: `close()` without
 * `closeSharedPool()` used to leave the memo pointing at a pool that refused every task.
 */
export function peekSharedPool(): WorkerPool | null {
  dropClosedShared();
  return shared;
}

/**
 * The pool every route module shares.
 *
 * Sized from configuration on first use. As with the allowlist in `plugins/security.ts` and the
 * client in `db.ts`, the first caller's configuration wins for the life of the process — which
 * is right for a server (it builds one app) and something a test building several apps has to
 * know about: `closeSharedPool()` drops the memo.
 *
 * A memo that still points at a *closed* pool is dropped too. Capturing the instance and calling
 * `.close()` on it, or a hook that closed without going through `closeSharedPool`, used to make
 * every later `getSharedPool` return the dead leftover and refuse work for the life of the
 * process.
 */
export function getSharedPool(
  config: AppConfig,
  hooks: { readonly onWarn?: (warning: PoolWarning) => void } = {},
): WorkerPool {
  dropClosedShared();
  shared ??= new WorkerPool({
    size: config.monteCarloWorkers,
    timeoutMs: config.coachTimeoutMs,
    ...(hooks.onWarn === undefined ? {} : { onWarn: hooks.onWarn }),
  });
  return shared;
}

/**
 * What `/ready` should report about the calculation threads.
 *
 * `required` is false until something in this process has asked for a warmup — tests that
 * never boot the production entry point, and so never call `beginSharedPoolWarmup`, keep the
 * historical `/ready` body (database only). Once warmup is required, `/ready` is 503 until
 * every thread has built its strength table, and 503 again if that failed.
 */
export function sharedPoolReadiness(): {
  readonly required: boolean;
  readonly ok: boolean;
  readonly detail?: string;
} {
  if (!warmupRequired) return { required: false, ok: true };
  if (warmupState === 'ready' && peekSharedPool() !== null) return { required: true, ok: true };
  if (warmupState === 'failed') {
    return {
      required: true,
      ok: false,
      detail: warmupError ?? 'calculation workers failed to start',
    };
  }
  return { required: true, ok: false, detail: 'calculation workers are still starting' };
}

/**
 * Pre-warms the shared pool and makes `/ready` wait until it is usable.
 *
 * Safe to call more than once: a warmup already in flight is joined, a finished one is a
 * no-op, a failed one can be retried. `server.ts` fires this before `listen` and does not
 * await it — liveness starts answering immediately, readiness waits.
 */
export function beginSharedPoolWarmup(
  config: AppConfig,
  hooks: { readonly onWarn?: (warning: PoolWarning) => void } = {},
): Promise<void> {
  dropClosedShared();
  warmupRequired = true;
  if (warmupState === 'ready' && peekSharedPool() !== null) return Promise.resolve();
  if (warmupPromise !== null) return warmupPromise;

  warmupState = 'pending';
  warmupError = undefined;
  const pool = getSharedPool(config, hooks);
  warmupPromise = pool
    .warm()
    .then(() => {
      warmupState = 'ready';
    })
    .catch((error: unknown) => {
      warmupState = 'failed';
      warmupError = error instanceof Error ? error.message : 'calculation workers failed to start';
      warmupPromise = null;
      throw error;
    });
  return warmupPromise;
}

/** Closes and forgets the shared pool. Idempotent, so several `onClose` hooks may call it. */
export async function closeSharedPool(): Promise<void> {
  const pool = shared;
  shared = null;
  resetWarmup();
  if (pool !== null) await pool.close();
}
