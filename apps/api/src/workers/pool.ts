/**
 * A bounded, cancellable pool of calculator threads. Fixed thread count, bounded queue, a
 * wall-clock deadline per request, and `terminate()` for a thread that overruns it.
 * Threads are reused because each builds a preflop strength table (about 3 s). Production warms
 * every thread at boot and `/ready` stays 503 until done.
 * The deadline starts at submission, so queue time counts against the caller.
 * One pool per process, so two pools never compete for the same cores. The first caller's sizing wins.
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
 * One slot would refuse a caller whenever every thread is busy. Many would accept work that then
 * times out. With four threads and a half-second task, twelve is about the deepest queue that finishes.
 */
const QUEUE_SLOTS_PER_WORKER = 3;

/** Every task's allocation is bounded, so a breach is a bug contained in a droppable thread. */
const WORKER_HEAP_MB = 256;

/**
 * The table build is about 3 s and live Coach requests get 12 s (`STRENGTH_TABLE_ALLOWANCE_MS`).
 * 15 s stays under the 20 s request timeout.
 */
const WARMUP_TIMEOUT_MS = 15_000;

type SuccessResponse = Extract<WorkerResponse, { ok: true }>;

interface Job {
  readonly id: number;
  readonly task: WorkerTask;
  readonly resolve: (response: SuccessResponse) => void;
  readonly reject: (error: unknown) => void;
  /** Null while queued. */
  worker: Worker | null;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

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

/** The pool must not import the logger, so it reports through `onWarn`. */
export interface PoolWarning {
  readonly event: 'worker-error' | 'worker-exit' | 'task-timeout' | 'protocol-mismatch';
  readonly detail: string;
}

export interface PoolOptions {
  readonly size: number;
  readonly timeoutMs: number;
  /** Defaults to `size * QUEUE_SLOTS_PER_WORKER`. */
  readonly queueLimit?: number;
  /** Test seam. */
  readonly workerUrl?: URL;
  readonly onWarn?: (warning: PoolWarning) => void;
}

/**
 * `tsc` rewrites import specifiers but not a string in `new URL(...)`, so the extension is derived.
 * A wrong one throws `MODULE_NOT_FOUND`.
 */
function defaultWorkerUrl(): URL {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return new URL(`./equity-worker${extension}`, import.meta.url);
}

/**
 * Refuses a report naming an action the task did not permit. A missing `legalActions` once let four
 * of five Coach surfaces publish illegal actions silently. Checked at the thread boundary so both
 * Coach routes share it. Exported for `test/coach-legality.test.ts`, since a healthy worker never
 * reaches it.
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

/** Built by `calc/parse.ts`, which decides method, samples and shards. */
export interface ShardedEquityRequest {
  readonly spec: WireSpec;
  readonly method: 'exact' | 'monte-carlo';
  /** Total across shards. Ignored on the exact path. */
  readonly samples: number;
  readonly shards: number;
  /** Shard `i` uses `seed + i`. */
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
  /** So `discard` cannot double-count a thread. */
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

  /** One warmup per slot, submitted together, so the table builds in parallel. */
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

  /** Never sharded. Two halves of a report cannot be combined. */
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
   * `combineMonteCarlo` recomputes the interval from the pooled sample size. Error falls with the
   * square root of samples, so four shards give about half a shard's interval, not a quarter.
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
    // Submission order, so the figure does not depend on which thread finished first.
    return results.length === 1 ? first : combineMonteCarlo(results);
  }

  /**
   * All or nothing under one deadline. Capacity is checked for the whole set first, so no thread is
   * spent on shards that can never be combined.
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
      // One failed shard makes the siblings worthless, so stop them now.
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
    job.timer = setTimeout(() => {
      this.expire(job);
    }, budget);
    this.queue.push(job);
    this.pump();
    return { job, promise };
  }

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
   * A configuration that cannot start a thread throws here. Escaping `pump`, it would leave armed
   * timers rejecting unobserved promises, and `server.ts` exits on an unhandled rejection. So the
   * queue is failed instead.
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
    worker.ref();
    const request: WorkerRequest = { id: job.id, task: job.task };
    worker.postMessage(request);
  }

  private spawn(): Worker {
    const worker = new Worker(this.workerUrl, {
      name: 'prl-equity',
      // Empty so no dependency in the thread can read the database URL or cookie secret.
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
      // A thread terminated on purpose exits with its job already settled.
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
      // A late reply from a thread terminated after a timeout.
      return;
    }
    if (response.id !== job.id) {
      // Protocol drift. Drop the thread rather than guess.
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

  private failWorker(worker: Worker, error: AppError): void {
    const job = this.busy.get(worker);
    this.discard(worker);
    if (job === undefined || job.settled) return;
    this.finish(job);
    this.failedCount += 1;
    job.reject(error);
  }

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
   * Stops a job without settling it. Terminating is the only way to interrupt a synchronous loop,
   * and is safe because the worker holds nothing that needs unwinding.
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

  private finish(job: Job): void {
    job.settled = true;
    if (job.timer !== null) {
      clearTimeout(job.timer);
      job.timer = null;
    }
  }

  private parkIdle(worker: Worker): void {
    if (this.closed || this.dead.has(worker)) {
      this.discard(worker);
      return;
    }
    // An idle thread must not keep a test runner or a stopped server alive.
    worker.unref();
    this.idle.push(worker);
    this.pump();
  }

  /** Idempotent. */
  private discard(worker: Worker): void {
    this.busy.delete(worker);
    const index = this.idle.indexOf(worker);
    if (index >= 0) this.idle.splice(index, 1);
    if (this.dead.has(worker)) return;
    this.dead.add(worker);
    this.workerCount = Math.max(0, this.workerCount - 1);
    void worker.terminate();
    this.pump();
  }

  /** Queued jobs are rejected, not drained, because shutdown has its own deadline (`server.ts`). */
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
 * Shard `i` gets `seed + i`, so a request always yields the same combined figure. The remainder
 * goes to the first shard so the shards sum to the requested sample count.
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
 * `EquityError`, `CoachError` and `StackError` are the maths refusing the request (422). Anything
 * else means `calc/parse.ts` and the maths disagree, which is our bug. The thread's message goes
 * only to `logDetail`.
 */
function failureToAppError(failure: WorkerFailure): AppError {
  const rejected =
    failure.name === 'EquityError' || failure.name === 'CoachError' || failure.name === 'StackError';
  return new AppError(rejected ? 'computation_rejected' : 'internal_error', {
    logDetail: `calculation thread refused the task: ${failure.name}: ${failure.message}`,
  });
}

let shared: WorkerPool | null = null;

type WarmupState = 'idle' | 'pending' | 'ready' | 'failed';

let warmupRequired = false;
let warmupState: WarmupState = 'idle';
let warmupError: string | undefined;
let warmupPromise: Promise<void> | null = null;

function dropClosedShared(): void {
  if (shared?.stats().closed) {
    shared = null;
    // So a later `beginSharedPoolWarmup` starts threads instead of joining a resolved no-op.
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

/** Metrics read this, so a scrape cannot create threads. A closed pool reads as absent. */
export function peekSharedPool(): WorkerPool | null {
  dropClosedShared();
  return shared;
}

/**
 * The first caller's configuration wins until `closeSharedPool()`. A memo pointing at a closed pool
 * is dropped, or every later call would return a pool that refuses all work.
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
 * `required` stays false until something calls `beginSharedPoolWarmup`, so tests that never boot
 * `server.ts` keep a database-only `/ready`.
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

/** Joins a warmup in flight and allows a retry after failure. `server.ts` does not await it. */
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

/** Idempotent, so several `onClose` hooks may call it. */
export async function closeSharedPool(): Promise<void> {
  const pool = shared;
  shared = null;
  resetWarmup();
  if (pool !== null) await pool.close();
}
