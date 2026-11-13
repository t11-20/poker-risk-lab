/**
 * The Postgres client. EVERY QUERY USES TAGGED-TEMPLATE PARAMETERISATION, as in
 *     await sql`select * from rooms where id = ${roomId}`
 * Never concatenate SQL and never call `.unsafe()`, except the migration runner running a `.sql` file.
 * postgres.js sends text and values as separate protocol fields, which is the entire injection defence.
 * A frozen server (`docker pause`, a partition) enforces no timeout, so every query also carries a
 * client-side deadline. `reliability-drills.mjs --only postgres-outage` measures the recovery.
 */

import postgres from 'postgres';
import type { AppConfig } from './config.ts';
import { AppError } from './errors.ts';

/** `Record<never, never>` is the empty custom-type map, spelled so because the linter bans `{}`. */
export type Sql = postgres.Sql<Record<never, never>>;
export type TransactionSql = postgres.TransactionSql<Record<never, never>>;

/**
 * How long `/api/v1/ready` may take, whatever the database is doing. Kubernetes'
 * `readinessProbe.timeoutSeconds` defaults to 1 s, the tightest common probe timeout, and 750 ms
 * leaves a quarter second for the rest of the request. Not configurable, because a knob would let an
 * operator set it above their own probe timeout.
 */
export const READINESS_DEADLINE_MS = 750;

/**
 * The probe query's own bound, strictly inside `READINESS_DEADLINE_MS` so `ping()` normally fires first
 * and can report which failure happened. The outer bound in `app.ts` is a backstop over any
 * `DatabaseHandle`. `test/db-deadlines.test.ts` asserts the ordering.
 */
export const PROBE_QUERY_DEADLINE_MS = 600;

/**
 * Covers what `statement_timeout` does not bound: connecting, TLS, and queueing behind a busy pool.
 * Too large only delays an error. Too small cancels work the server would have completed.
 */
const QUERY_DEADLINE_SLACK_MS = 2_000;

/**
 * The request-path deadline, for one statement and for one whole transaction (see `boundScope`). It is
 * always above `statement_timeout`, so it fires only when the server enforces nothing. Lowering it
 * below that would cancel work Postgres was willing to run. `test/db-deadlines.test.ts` asserts it.
 */
export function queryDeadlineMs(config: AppConfig): number {
  return config.database.statementTimeoutMs + QUERY_DEADLINE_SLACK_MS;
}

/** Not an exception, because `/ready` must answer "degraded" with a reason when the database is down. */
export interface DbCheck {
  readonly ok: boolean;
  /** Never a driver message. */
  readonly detail?: string;
  /** Server-side only. `/api/v1/ready` never copies it, because it carries the postmaster start time. */
  readonly identity?: string;
}

/**
 * Which database answers this DSN: database oid, postmaster start time, and the ledger table's oid.
 * `schema-guard.ts` re-verifies when it changes, because a restore, a failover or a new container can
 * put an older schema behind a running API. Not `system_identifier`, which is shared across a cluster
 * and does not move when `backup.mjs restore` recreates the database on the same cluster. The start
 * time tells apart two fresh clusters that hand out the same oids. `extract(epoch ...)` keeps the text
 * independent of `DateStyle` and `TimeZone`. A fragment, so `ping()` and the ledger read cannot drift.
 */
export function databaseIdentity(sql: Sql): postgres.PendingQuery<postgres.Row[]> {
  return sql`pg_catalog.concat_ws(':',
    (select d.oid from pg_catalog.pg_database d where d.datname = pg_catalog.current_database()),
    extract(epoch from pg_catalog.pg_postmaster_start_time()),
    pg_catalog.to_regclass('prl.schema_migrations')::oid)`;
}

/** What `app.ts` depends on, so tests pass a stub and need no Postgres. */
export interface DatabaseHandle {
  readonly ping: () => Promise<DbCheck>;
  readonly close: (timeoutMs: number) => Promise<void>;
}

export interface DatabaseHooks {
  readonly onNotice?: (message: string) => void;
}

/**
 * A raw client with NO client-side deadline, for the migration runner and other callers that need the
 * full driver surface. The request path uses `getSql()`.
 */
export function createDatabaseClient(config: AppConfig, hooks: DatabaseHooks = {}): Sql {
  const onNotice = hooks.onNotice;
  return postgres(config.database.url, {
    // Unbounded, the client would hit Postgres' `max_connections` and fail every query instead of queueing.
    max: config.database.poolMax,
    idle_timeout: config.database.idleTimeoutSeconds,
    connect_timeout: config.database.connectTimeoutSeconds,
    // Bounds server-side memory per connection and picks up a rotated credential without a restart.
    max_lifetime: 1_800,
    connection: {
      application_name: 'poker-risk-lab-api',
      statement_timeout: config.database.statementTimeoutMs,
      idle_in_transaction_session_timeout: config.database.statementTimeoutMs * 2,
    },
    // The default, stated so that switching it off shows in a diff.
    prepare: true,
    /**
     * No `postgres.camel`. Snake_case columns stay snake_case, so a typo is a type error rather than a
     * silent `undefined`. `undefined` becomes NULL so an absent optional field is not a 500.
     */
    transform: { undefined: null },
    // The default prints notices to stdout, bypassing redaction. With no sink they are dropped.
    onnotice: (notice) => {
      onNotice?.(notice['message'] ?? 'postgres notice');
    },
  });
}

/**
 * "The server said nothing", distinct from "the server said no", because only this one strands a
 * connection. `abandoned` is the silenced query, which `ping()` holds to avoid a second probe.
 */
class DatabaseDeadlineError extends Error {
  override readonly name = 'DatabaseDeadlineError';
  readonly deadlineMs: number;
  readonly abandoned: Promise<void>;

  constructor(deadlineMs: number, abandoned: Promise<void>) {
    super(`the database did not answer within ${deadlineMs} ms`);
    this.deadlineMs = deadlineMs;
    this.abandoned = abandoned;
  }
}

/** A sentinel, not an error subclass, because `instanceof` breaks across duplicated module copies. */
const DEADLINE_FIRED = Symbol('database deadline fired');

/**
 * The timer is `unref`'d and always cleared. The abandoned promise gets a `.catch()`, because
 * `Promise.race` leaves the loser pending and its later rejection would crash the process. The query
 * is not cancelled, because `query.cancel()` opens a second connection to the frozen server and its
 * rejection cannot be caught. The abandoned query holds its connection until the socket settles.
 */
async function underDeadline<T>(work: PromiseLike<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(DEADLINE_FIRED), deadlineMs);
    timer.unref();
  });
  try {
    return await Promise.race([work, expiry]);
  } catch (error) {
    if (error !== DEADLINE_FIRED) throw error;
    const abandoned = Promise.resolve(work).then(
      () => undefined,
      () => undefined,
    );
    throw new DatabaseDeadlineError(deadlineMs, abandoned);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Expiry becomes 503 `service_unavailable`, which tells a retrying client and a load balancer to try
 * again. Every other rejection is rethrown untouched so `repositories/sql.ts` sees the driver's error.
 */
async function boundedQuery<T>(work: PromiseLike<T>, deadlineMs: number): Promise<T> {
  try {
    return await underDeadline(work, deadlineMs);
  } catch (error) {
    if (!(error instanceof DatabaseDeadlineError)) throw error;
    throw new AppError('service_unavailable', {
      logDetail: `a database query was abandoned after ${error.deadlineMs} ms with no answer`,
      cause: error,
    });
  }
}

function isTaggedTemplate(value: unknown): boolean {
  // The same test postgres.js makes in `src/index.js`, so the classifications cannot drift.
  return typeof value === 'object' && value !== null && Array.isArray((value as { raw?: unknown }).raw);
}

/**
 * `sql.begin(fn)` / `sql.savepoint(name, fn)`, with the callback's handle bound.
 *
 * The whole `begin` is also bounded, because on a statement failure postgres.js awaits `rollback`
 * with no deadline we can reach, and against a frozen server that never returns. So a transaction
 * gets one statement's budget in total. No transaction here comes near it. A savepoint is already
 * inside a bounded `begin`.
 */
type ScopeFunction = (...args: unknown[]) => unknown;

function boundScope(scope: ScopeFunction, deadlineMs: number, boundResult: boolean): ScopeFunction {
  return (...args: unknown[]): unknown => {
    const last = args.length === 0 ? undefined : args[args.length - 1];
    // The callback is always last. The tagged-template `savepoint` has none and passes through.
    if (typeof last !== 'function') return scope(...args);
    const callback = last as (handle: object) => unknown;
    const wrapped = (handle: object): unknown => callback(deadlineBound(handle, deadlineMs));
    const result = scope(...args.slice(0, -1), wrapped);
    return boundResult ? boundedQuery(result as PromiseLike<unknown>, deadlineMs) : result;
  };
}

const AWAIT_MEMBERS: ReadonlySet<string | symbol> = new Set(['then', 'catch', 'finally']);

/**
 * The driver's own `Query`, bounded when awaited. A Proxy, not a Promise, so it stays a `Query` and
 * postgres.js still splices it as a fragment; a Promise made `GET /hands?sort=` run its `order by`
 * fragment as a statement. Unawaited fragments get no timer.
 *
 * Not bounded: `.cursor()`, `.readable()` and `.writable()` return a separate object. Nothing in
 * `apps/api/src` uses them, and `test/db-deadlines.test.ts` scans for them.
 */
function boundQuery(query: object, deadlineMs: number): object {
  let waiting: Promise<unknown> | null = null;
  return new Proxy(query, {
    get: (target, property, receiver): unknown => {
      if (!AWAIT_MEMBERS.has(property)) return Reflect.get(target, property, receiver);
      // The RAW query, because handing `boundedQuery` the proxy would re-enter this trap.
      waiting ??= boundedQuery(query as PromiseLike<unknown>, deadlineMs);
      const settled = waiting;
      const member = Reflect.get(settled, property) as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => member.apply(settled, args);
    },
  });
}

/**
 * A handle whose every query carries a client-side deadline. A Proxy forwards the whole `sql` surface
 * and intercepts only the tagged-template call, `begin` and `savepoint`. `.unsafe`, `.file`, `.listen`
 * and `.reserve` pass through unbounded.
 */
function deadlineBound<T extends object>(handle: T, deadlineMs: number): T {
  const proxy = new Proxy(handle, {
    apply: (target, thisArg, argArray: unknown[]): unknown => {
      const call = Reflect.apply(target as unknown as (...args: unknown[]) => unknown, thisArg, argArray);
      // `sql(name)` and `sql(object)` build identifiers and fragments, not queries.
      if (!isTaggedTemplate(argArray[0]) || typeof call !== 'object' || call === null) return call;
      return boundQuery(call, deadlineMs);
    },
    get: (target, property, receiver): unknown => {
      const value = Reflect.get(target, property, receiver);
      if ((property === 'begin' || property === 'savepoint') && typeof value === 'function') {
        return boundScope(value as ScopeFunction, deadlineMs, property === 'begin');
      }
      return value;
    },
  });
  return proxy;
}

let shared: Sql | null = null;
let bound: Sql | null = null;

/** A latch, so a frozen database costs readiness one pooled connection however long the freeze lasts. */
let abandonedProbe: Promise<void> | null = null;

/**
 * Creates the process-wide client. A second call throws, because two pools share one
 * `max_connections` budget. Returns the same deadline-bound handle as `getSql()`.
 */
export function configureDatabase(config: AppConfig, hooks: DatabaseHooks = {}): Sql {
  if (shared !== null) {
    throw new Error('configureDatabase() was called twice; there must be exactly one pool per process');
  }
  shared = createDatabaseClient(config, hooks);
  abandonedProbe = null;
  bound = deadlineBound(shared, queryDeadlineMs(config));
  return bound;
}

/** Throws rather than creating a client lazily, because that would mean reading `process.env` here. */
export function getSql(): Sql {
  if (bound === null) {
    throw new Error('getSql() before configureDatabase(); call configureDatabase(config) during boot');
  }
  return bound;
}

export function isDatabaseConfigured(): boolean {
  return shared !== null;
}

/**
 * Boxed because `sql.begin()` is typed `UnwrapPromiseArray<T>`, so an array result would change type.
 * The deadline lives on the handle, so `sql.begin` called directly is bounded too.
 */
export async function withTransaction<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const boxed = await getSql().begin(async (tx) => ({ value: await fn(tx) }));
  return boxed.value;
}

/**
 * One round trip that also reads `databaseIdentity` for the schema guard. The driver's message can
 * name hosts and users, so `detail` is a fixed string for each of three incidents: never configured,
 * answered with an error, did not answer.
 */
export async function ping(): Promise<DbCheck> {
  if (shared === null) return { ok: false, detail: 'database is not configured' };
  // An earlier probe is still unanswered. The latch clears when it settles.
  if (abandonedProbe !== null) {
    return { ok: false, detail: `database did not answer within ${PROBE_QUERY_DEADLINE_MS} ms` };
  }
  const query = shared<{ identity: string }[]>`select ${databaseIdentity(shared)} as identity`;
  try {
    const [row] = await underDeadline(query, PROBE_QUERY_DEADLINE_MS);
    return row === undefined ? { ok: true } : { ok: true, identity: row.identity };
  } catch (error) {
    if (!(error instanceof DatabaseDeadlineError)) return { ok: false, detail: 'database did not answer' };
    const outstanding = error.abandoned;
    abandonedProbe = outstanding;
    // Compared by identity so a late query from a previous pool cannot clear a newer latch.
    void outstanding.finally(() => {
      if (abandonedProbe === outstanding) abandonedProbe = null;
    });
    return { ok: false, detail: `database did not answer within ${error.deadlineMs} ms` };
  }
}

/** A no-op when no client was created. */
export async function closeDatabase(timeoutMs: number): Promise<void> {
  if (shared === null) return;
  const client = shared;
  shared = null;
  bound = null;
  abandonedProbe = null;
  await client.end({ timeout: Math.max(0, Math.ceil(timeoutMs / 1000)) });
}

export const database: DatabaseHandle = { ping, close: closeDatabase };
