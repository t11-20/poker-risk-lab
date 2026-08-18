/**
 * The Postgres client.
 *
 * ############################################################################
 * ##  EVERY QUERY IN THIS CODEBASE USES TAGGED-TEMPLATE PARAMETERISATION.   ##
 * ##                                                                        ##
 * ##      await sql`select * from rooms where id = ${roomId}`               ##
 * ##                                                                        ##
 * ##  Never build SQL by string concatenation, never interpolate a value    ##
 * ##  into the template body, and never call `.unsafe()` — with exactly one ##
 * ##  exception: the migration runner (`apps/api/scripts/migrate.mjs`)      ##
 * ##  executing a whole `.sql` file from `db/migrations/`, which contains   ##
 * ##  no user input at all.                                                 ##
 * ##                                                                        ##
 * ##  postgres.js sends the template's text and its values as separate      ##
 * ##  protocol fields, so a parameterised value can never become SQL        ##
 * ##  syntax. That property is the whole SQL-injection defence here — there ##
 * ##  is no ORM escaping and no input sanitiser behind it. One `.unsafe()`  ##
 * ##  with a value spliced in defeats all of it.                            ##
 * ############################################################################
 *
 * ## Why there is no eagerly-created `sql` export
 *
 * `export const sql = postgres(url)` would run at import time, so any module importing
 * this file — including a test that only wants a type — would parse the URL, allocate the
 * pool, and fail outright without `DATABASE_URL`. Configuration errors would surface as
 * import failures with no context, and every unit test would need a live database.
 *
 * Instead: `configureDatabase(config)` is called once, from `server.ts`, and `getSql()`
 * returns that client. `getSql()` throws a specific, readable error if configuration never
 * happened, which is a far better failure than a connection attempt to `undefined`.
 * Repository modules should call `getSql()` *inside* their functions, not at module scope,
 * for the same reason.
 *
 * ## Why the timeouts are set here rather than left to Postgres' defaults
 *
 * Postgres' default `statement_timeout` is zero — unlimited. One accidental sequential scan
 * over the hand-history table then holds a pooled connection for as long as it takes, and
 * with a bounded pool that is an outage rather than a slow query. Every connection here
 * starts with a statement timeout and an idle-in-transaction timeout, so a stuck query, or
 * a transaction a crashed handler never closed, is killed by the server instead of by a
 * person.
 */

import postgres from 'postgres';
import type { AppConfig } from './config.ts';

/**
 * The client type.
 *
 * `Record<never, never>` is the empty custom-type map that `postgres(url, options)`
 * actually returns. It is written this way rather than as `{}` because the linter bans that
 * spelling, and rather than being inferred because these aliases are the names repository
 * modules will import.
 */
export type Sql = postgres.Sql<Record<never, never>>;
/** The handle passed to a `withTransaction` callback. Same client, inside a transaction. */
export type TransactionSql = postgres.TransactionSql<Record<never, never>>;

/**
 * What the readiness probe reports.
 *
 * Deliberately not an exception: `/ready` has to answer even when the database is
 * unreachable, and "degraded, with a reason" is more useful to an orchestrator than a 500.
 */
export interface DbCheck {
  readonly ok: boolean;
  /** Short, non-sensitive reason when `ok` is false. Never a driver message. */
  readonly detail?: string;
}

/**
 * The narrow interface `app.ts` depends on.
 *
 * This is the seam that keeps the tests database-free: `buildApp` takes a `DatabaseHandle`,
 * and a test passes a stub, so routes can be exercised with no Postgres anywhere.
 */
export interface DatabaseHandle {
  readonly ping: () => Promise<DbCheck>;
  readonly close: (timeoutMs: number) => Promise<void>;
}

/** Optional hooks, so server notices reach the app logger instead of stdout. */
export interface DatabaseHooks {
  readonly onNotice?: (message: string) => void;
}

/**
 * Builds a client. Exported for the migration runner and anything else that genuinely needs
 * a pool of its own; ordinary code wants `getSql()`.
 */
export function createDatabaseClient(config: AppConfig, hooks: DatabaseHooks = {}): Sql {
  const onNotice = hooks.onNotice;
  return postgres(config.database.url, {
    // A bounded pool, and the bound is the point: an unbounded client happily opens one
    // connection per concurrent request and then hits Postgres' own `max_connections`,
    // which fails every query instead of queueing them.
    max: config.database.poolMax,
    idle_timeout: config.database.idleTimeoutSeconds,
    connect_timeout: config.database.connectTimeoutSeconds,
    // Recycle connections. Stops a long-lived connection accumulating server-side memory,
    // and lets a rotated credential take effect without a restart.
    max_lifetime: 1_800,
    // Server-enforced ceilings, applied to every connection as it is created.
    connection: {
      application_name: 'poker-risk-lab-api',
      statement_timeout: config.database.statementTimeoutMs,
      idle_in_transaction_session_timeout: config.database.statementTimeoutMs * 2,
    },
    // Prepared statements: the plan is cached per connection and — the part that matters
    // here — the value is bound by the wire protocol rather than pasted into text. Stated
    // explicitly although it is the default, because switching it off would be a meaningful
    // change and should look like one in a diff.
    prepare: true,
    /**
     * Column names come back exactly as the database spells them.
     *
     * postgres.js ships `postgres.camel`, which would rewrite `starting_stack` to
     * `startingStack`. We deliberately do not use it: `db/migrations/0001_initial.sql`
     * defines snake_case columns, and under a renaming transform a typo in a repository
     * (`row.startingstack`) yields `undefined` at runtime instead of an error, while a
     * `select` written in snake_case quietly stops matching the type that describes it. One
     * naming convention, visible in both the SQL and the row type, is worth more than the
     * cosmetics.
     *
     * The one transform we do want: JavaScript `undefined` becomes SQL NULL instead of
     * throwing, so an optional field that happens to be absent does not turn a write into
     * a 500.
     */
    transform: { undefined: null },
    // Notices ("index already exists", deprecation warnings) are printed straight to stdout
    // by default, bypassing the redaction in `logging.ts`. With no sink wired up they are
    // dropped on purpose: a notice is never load-bearing, and an unredacted write is worse
    // than a missing line.
    onnotice: (notice) => {
      onNotice?.(notice['message'] ?? 'postgres notice');
    },
  });
}

let shared: Sql | null = null;

/**
 * Creates the process-wide client. Call once, early, from `server.ts`.
 *
 * Calling it twice is a programming error rather than something to paper over: two pools in
 * one process means two sets of connections against one `max_connections` budget, and the
 * second call's configuration silently losing to the first is exactly the kind of bug that
 * takes a day to find.
 */
export function configureDatabase(config: AppConfig, hooks: DatabaseHooks = {}): Sql {
  if (shared !== null) {
    throw new Error('configureDatabase() was called twice; there must be exactly one pool per process');
  }
  shared = createDatabaseClient(config, hooks);
  return shared;
}

/**
 * The process-wide client.
 *
 * Throws rather than lazily creating one, because a lazily-created client would need
 * configuration from somewhere, and "somewhere" would mean reading `process.env` from deep
 * inside a repository — which is how a test suite ends up connecting to a developer's real
 * database.
 */
export function getSql(): Sql {
  if (shared === null) {
    throw new Error('getSql() before configureDatabase(); call configureDatabase(config) during boot');
  }
  return shared;
}

/** True when a client exists. Lets shutdown and probes avoid creating one. */
export function isDatabaseConfigured(): boolean {
  return shared !== null;
}

/**
 * Runs `fn` inside a transaction, committing on return and rolling back on throw.
 *
 * The boxing is not decoration. `sql.begin()` is typed `Promise<UnwrapPromiseArray<T>>`,
 * which means a callback returning an *array* has any promises inside it resolved — so
 * returning `[queryA, queryB]` produces a different result type from returning one row.
 * Wrapping the value in `{ value }` makes the return type unconditionally `T`, so this
 * helper behaves identically whatever the callback returns and no caller has to know that
 * rule exists.
 */
export async function withTransaction<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const boxed = await getSql().begin(async (tx) => ({ value: await fn(tx) }));
  return boxed.value;
}

/**
 * Readiness check.
 *
 * `select 1` and nothing else: the probe has to be cheaper than the cheapest real request,
 * or a readiness endpoint under load becomes the reason the service is not ready. The
 * driver's message is deliberately not returned — it can name hosts, users and databases —
 * so the caller gets a fixed string while the detail goes to the log at the call site.
 */
export async function ping(): Promise<DbCheck> {
  if (shared === null) return { ok: false, detail: 'database is not configured' };
  try {
    await shared`select 1 as ok`;
    return { ok: true };
  } catch {
    return { ok: false, detail: 'database did not answer' };
  }
}

/**
 * Closes the pool, waiting up to `timeoutMs` for in-flight queries.
 *
 * A no-op when no client was created, so shutdown works in a process that never touched the
 * database.
 */
export async function closeDatabase(timeoutMs: number): Promise<void> {
  if (shared === null) return;
  const client = shared;
  shared = null;
  await client.end({ timeout: Math.max(0, Math.ceil(timeoutMs / 1000)) });
}

/** The handle `buildApp` uses in production. A test passes its own stub instead. */
export const database: DatabaseHandle = { ping, close: closeDatabase };
