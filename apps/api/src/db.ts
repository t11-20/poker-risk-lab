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
 *
 * ## Why there are ALSO client-side deadlines, and why there are two of them
 *
 * `statement_timeout` and `idle_in_transaction_session_timeout` are enforced by the SERVER.
 * A server that is frozen rather than stopped — `docker pause`, a cgroup freezer, a VM
 * suspended by its hypervisor, a network partition that leaves the TCP connection
 * established — enforces nothing at all: the socket stays open, no FIN arrives, TCP
 * keepalives are answered by a kernel that is still running, and every query already in
 * flight simply never comes back. Before these deadlines existed, that state made every
 * database-touching request hang for the length of the freeze, and it hung `/ready` with
 * them — which is worse than a 503, because a probe that never answers gives an
 * orchestrator nothing to act on until its own timeout fires, while a 503 takes the
 * instance out of rotation immediately.
 *
 * So there is a timer on this side of the socket, one that does not need the database to be
 * alive in order to fire. There are two of them because they answer different questions:
 *
 *   * `PROBE_QUERY_DEADLINE_MS` bounds the readiness probe's `select 1`. It is short,
 *     because a probe that is slow has already answered the only question readiness asks.
 *   * `queryDeadlineMs(config)` bounds everything else — every statement, and every
 *     `begin` block as a whole. It is deliberately GENEROUS — it exists to turn "hangs
 *     forever" into "fails", not to enforce latency — and it is derived from
 *     `statement_timeout` so that it is always LARGER than the ceiling the server itself
 *     imposes. That ordering is the whole reason a blanket deadline is safe here: any
 *     server still able to enforce anything has already killed the statement before this
 *     timer fires, so this deadline can only fire for a server that is enforcing nothing,
 *     and it therefore cannot cancel legitimate slow work.
 *
 * ### What was rejected, and why
 *
 * **A deadline on the readiness probe alone.** It fixes the probe and leaves every feature
 * route hanging for the length of the outage, holding a pooled connection and a browser tab
 * each. The measured symptom was an authenticated `GET /api/v1/rooms` that had not answered
 * four seconds into a freeze.
 *
 * **A per-statement deadline alone, with transactions left to the statements inside them.**
 * That fixes reads and leaves every write hanging, because the driver's rollback path is not
 * ours to bound. `boundScope` has the detail.
 *
 * **`query.cancel()` on the abandoned query.** postgres.js does support cancellation, and it
 * is the wrong tool here, for three separate reasons. (1) For a query already sent to the
 * backend it opens a SECOND TCP connection to the same server in order to send a
 * CancelRequest — a server that cannot answer the first connection cannot answer that one
 * either, so the cancel is exactly as stuck as the query it is trying to stop. (2) `Query#
 * cancel()` returns `null` rather than the promise it starts (`src/query.js`: the comma
 * expression yields the cleared canceller), so a rejection from that second connection
 * cannot be caught by the caller and becomes an unhandled rejection in this process — a
 * crash, on the default `--unhandled-rejections=throw`. (3) It is unnecessary in the only
 * case where it would work: because these deadlines sit ABOVE the server's own
 * `statement_timeout`, a server that can still cancel has already cancelled.
 *
 * **A shorter blanket deadline, tight enough to bound the request path aggressively.** That
 * is the version that cancels legitimate slow work: below `statement_timeout` it starts
 * killing statements the server was perfectly willing to run, and the failure looks like a
 * flaky database rather than a configuration mistake.
 *
 * ### What happens to the connection a deadline abandons
 *
 * Nothing frees it, and that is stated rather than hidden. The abandoned query stays
 * `active` on its pooled connection until either the server finally answers — postgres.js
 * settles the query, the result is discarded by the `.catch()` attached in `underDeadline`,
 * and the connection returns to the pool — or the socket errors or closes, at which point
 * the driver rejects the query and reconnects. So while a freeze lasts, an instance can burn
 * through `DATABASE_POOL_MAX` connections and then queue; queued queries fail their own
 * deadlines, which is the correct behaviour for an instance whose database is frozen (shed,
 * do not queue) and is what `/ready` is meanwhile reporting. It repairs itself with no
 * restart when the freeze lifts: `scripts/reliability-drills.mjs --only postgres-outage`
 * measures that as `readyAgainMs`.
 *
 * `ping()` additionally refuses to issue a second probe while one it already gave up on is
 * still unanswered, so however long an outage runs, readiness costs the pool exactly one
 * connection rather than one per probe interval.
 *
 * ### What `--only postgres-outage` measured, before and after
 *
 * Before: three of three `/ready` probes exceeded the drill's own 4,000 ms deadline (`readyHung
 * 3`, `readyDegraded 0`), and a `/ready` issued the instant the freeze began answered **200
 * READY** after 16,772 ms, having spanned a 16,641 ms outage. After: `readyHung 0`,
 * `readyDegraded 3`, slowest 3 ms, and the probe held across the freeze answered 503 in 604 ms.
 *
 * The feature route is bounded but the bound follows `statement_timeout`, which is the whole
 * point of it. At the repository's own `DATABASE_STATEMENT_TIMEOUT_MS=5000` the request-path
 * deadline is 7,000 ms, so `GET /api/v1/rooms` degrades at seven seconds — past the drill's
 * 4,000 ms patience, which the drill reports as a warning. Re-running the same unmodified drill
 * with `DATABASE_STATEMENT_TIMEOUT_MS=1000` (deadline 3,000 ms) records
 * `featureStatusDuringOutage=503` and a contract error body, with no warnings at all. Making the
 * deadline shorter than that WITHOUT lowering the server's ceiling is the one change this file
 * must not make: it would start cancelling statements Postgres was willing to run.
 */

import postgres from 'postgres';
import type { AppConfig } from './config.ts';
import { AppError } from './errors.ts';

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
 * How long `/api/v1/ready` may take to answer, whatever the database is doing.
 *
 * ## Why 750 ms, and why it is not configurable
 *
 * This number is chosen against the probe timeouts a deployment would realistically use, and
 * the binding one is the tightest: Kubernetes' `readinessProbe.timeoutSeconds` defaults to
 * **1 second**. A probe slower than that is recorded by the kubelet as a timeout, which is
 * the exact failure this bound exists to remove — the orchestrator learns "no answer" rather
 * than "degraded", and cannot tell a wedged process from a healthy one with a dead
 * dependency. Everything else in common use is looser (an AWS ALB target group defaults to a
 * 5 s health-check timeout, HAProxy checks every 2 s, a Docker `HEALTHCHECK` defaults to
 * 30 s), so a bound that fits inside Kubernetes' default fits inside all of them.
 *
 * 750 ms leaves roughly a quarter of a second for the rest of the request — the hook chain,
 * the rate limiter, JSON serialisation and the socket write — inside that 1 s. At the other
 * end, `select 1` against a healthy Postgres on loopback or in the same VPC is single-digit
 * milliseconds, so this is around two orders of magnitude above the healthy case and cannot
 * fire because a database is merely busy.
 *
 * It is a constant rather than an environment variable on purpose. A knob here would let an
 * operator set the bound ABOVE their own probe timeout, which reintroduces the defect while
 * looking like a tuning decision; and there is no deployment-specific right answer, because
 * the requirement is "smaller than every probe timeout that will ever point at this
 * endpoint" rather than anything about this deployment's data or hardware. The cost, stated:
 * a deployment whose database routinely takes longer than 750 ms to answer `select 1` will
 * see readiness flap, and it should — that instance cannot serve a request either.
 */
export const READINESS_DEADLINE_MS = 750;

/**
 * The bound on the probe's own `select 1`, inside `READINESS_DEADLINE_MS`.
 *
 * Two bounds rather than one, because they guarantee different things. This one is what
 * normally fires, and it is what lets `ping()` report *which* kind of failure happened and
 * latch the connection it abandoned. The outer one, applied by `/api/v1/ready` in `app.ts`,
 * is a backstop over the `DatabaseHandle` INTERFACE: it holds for any implementation,
 * including a test stub and any handle written later, so the endpoint's promise does not
 * depend on a collaborator honouring a bound of its own.
 *
 * Strictly smaller than the outer bound so the informative path is the one that normally
 * wins; `test/db-deadlines.test.ts` asserts that ordering rather than trusting the two
 * literals to stay in step.
 */
export const PROBE_QUERY_DEADLINE_MS = 600;

/**
 * How far above the server's `statement_timeout` the request-path deadline sits.
 *
 * It has to cover the work that `statement_timeout` does NOT bound, because that clock only
 * starts once the backend has the statement: establishing a connection when the pool has to
 * open one, the TLS handshake, and time spent queued behind a busy pool. Two seconds is
 * generous for all three on any network where this application is deployable at all —
 * `DATABASE_CONNECT_TIMEOUT_SECONDS` defaults to ten, so a connection that needs more than
 * two seconds is already pathological — and being generous is the correct direction: the
 * cost of this number being too large is that a hang takes two seconds longer to become an
 * error, while the cost of it being too small is cancelling work the server would have
 * completed.
 */
const QUERY_DEADLINE_SLACK_MS = 2_000;

/**
 * The request-path deadline: one statement's budget, and also one transaction's.
 *
 * Exported so `test/db-deadlines.test.ts` can assert the property that makes a blanket
 * deadline safe — that it is strictly greater than the server-side ceiling — for every
 * `DATABASE_STATEMENT_TIMEOUT_MS` the configuration accepts, rather than for the default
 * alone.
 *
 * One number covers both because a transaction needs a bound of its own for a reason that has
 * nothing to do with how long its statements take: see `boundScope`, where the driver's own
 * unbounded rollback is what makes a per-statement deadline insufficient.
 *
 * A deployment that sets `DATABASE_STATEMENT_TIMEOUT_MS` above `REQUEST_TIMEOUT_MS` minus
 * this slack has, by its own configuration, allowed a statement to outlive the request that
 * issued it; Fastify closes that socket first and the caller gets no body. This deadline does
 * not paper over that, because it is the operator's decision and not this module's to
 * second-guess — but it still bounds the same query for the bots, the WebSocket hub and the
 * telemetry writer, none of which is behind a request timeout at all.
 */
export function queryDeadlineMs(config: AppConfig): number {
  return config.database.statementTimeoutMs + QUERY_DEADLINE_SLACK_MS;
}

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
 *
 * The handle this returns is the driver's own, with NO client-side deadline on it. That is
 * the point of the escape hatch: a caller here wants the full postgres.js surface — cursors,
 * `.values()`, `COPY` — and those are the shapes `deadlineBound` cannot wrap. Anything on
 * the request path should be reaching for `getSql()` instead.
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

// ---------------------------------------------------------------------------
// Client-side deadlines
// ---------------------------------------------------------------------------

/**
 * Thrown when a client-side deadline gave up on a query.
 *
 * Distinct from every other database failure on purpose: "the server said no" and "the
 * server said nothing" are different incidents, they want different runbook entries, and
 * only the second one leaves a connection stranded. `abandoned` is the query this deadline
 * walked away from, already silenced so that a late rejection cannot reach the process's
 * unhandled-rejection handler; `ping()` holds on to it to avoid issuing a second probe while
 * the first is still outstanding.
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

/**
 * The token the internal timer rejects with.
 *
 * A module-private sentinel rather than an error subclass, so that `underDeadline` can tell
 * "my timer fired" from "the query rejected with something that happens to look like my
 * timer" without an `instanceof` that a duplicated module copy would break.
 */
const DEADLINE_FIRED = Symbol('database deadline fired');

/**
 * Awaits `work`, giving up after `deadlineMs`.
 *
 * The timer is `unref`'d and always cleared, so a deadline never keeps the event loop alive
 * and a fast query does not leave a pending timer behind for its whole budget — which, at
 * one per query on a busy server, would be a real amount of garbage.
 *
 * On expiry the abandoned promise gets a `.catch()` attached before it is handed back. That
 * is not tidiness: `Promise.race` leaves the loser pending, postgres.js will eventually
 * reject it when the socket dies, and an unobserved rejection is a process crash under
 * Node's default `--unhandled-rejections=throw`.
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
 * `underDeadline`, with the expiry turned into the answer a client should get.
 *
 * 503 `service_unavailable` rather than 500 `internal_error`, because the two say different
 * things to whatever is on the other end: "try again shortly" is true and actionable, and it
 * is what a retrying client and a load balancer both need to hear, while a 500 invites a bug
 * report about a database that was merely unreachable. The driver's message never leaves the
 * process — `errors.ts` logs `cause` in full and sends the client a code and a request id.
 *
 * Every other rejection is rethrown untouched, so an integrity violation still reaches
 * `sqlViolation` in `repositories/sql.ts` as the driver's own error.
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

/** True when `value` is the tagged-template call rather than one of postgres.js's helpers. */
function isTaggedTemplate(value: unknown): boolean {
  // The same test postgres.js itself makes in `src/index.js`, so the two classifications
  // cannot drift: `sql(name)` builds an identifier and `sql(object)` builds a fragment, and
  // neither is a query with a deadline to give it.
  return typeof value === 'object' && value !== null && Array.isArray((value as { raw?: unknown }).raw);
}

/**
 * `sql.begin(fn)` / `sql.savepoint(name, fn)`, with the handle they hand the callback bound.
 *
 * `boundResult` is set for `begin` and not for `savepoint`, and the difference is the one
 * thing about this wrapper that is not obvious. Bounding the statements inside a transaction
 * is not enough to bound the transaction, because the UNWIND is the driver's: when a
 * statement inside `begin` throws, postgres.js's own `scope()` awaits `rollback` on the same
 * connection, and that rollback carries no deadline this module can reach. Against a frozen
 * server that rollback never returns, so a transaction whose first statement was correctly
 * abandoned would still hang for the length of the outage — the per-statement deadline alone
 * would have fixed reads and left every write hanging.
 *
 * So the whole `begin` gets the same budget as one statement, measured from its start. The
 * cost, stated plainly: a transaction whose statements legitimately SUM to more than one
 * statement's budget is abandoned even though the server allowed each of them individually.
 * That is accepted because no transaction in this repository comes within two orders of
 * magnitude of it against a healthy database, and because the alternative — a per-transaction
 * budget that scales with however many statements the callback turns out to issue — cannot be
 * known before the callback runs, which is how you end up back at no bound at all.
 *
 * A savepoint is nested inside a `begin` that is already bounded, so bounding it again would
 * be a second timer measuring a subset of the first.
 */
type ScopeFunction = (...args: unknown[]) => unknown;

function boundScope(scope: ScopeFunction, deadlineMs: number, boundResult: boolean): ScopeFunction {
  return (...args: unknown[]): unknown => {
    const last = args.length === 0 ? undefined : args[args.length - 1];
    // `begin('read write', fn)`, `begin(fn)`, `savepoint('name', fn)` and `savepoint(fn)` all
    // put the callback last. The tagged-template form of `savepoint` has no callback at all,
    // and falls through unchanged rather than being guessed at.
    if (typeof last !== 'function') return scope(...args);
    const callback = last as (handle: object) => unknown;
    const wrapped = (handle: object): unknown => callback(deadlineBound(handle, deadlineMs));
    const result = scope(...args.slice(0, -1), wrapped);
    return boundResult ? boundedQuery(result as PromiseLike<unknown>, deadlineMs) : result;
  };
}

/** The three members through which a caller *waits* for a query, as against inspecting it. */
const AWAIT_MEMBERS: ReadonlySet<string | symbol> = new Set(['then', 'catch', 'finally']);

/**
 * The driver's own `Query`, with the deadline attached to the act of awaiting it.
 *
 * ## Why this is a Proxy and not the promise the deadline produces
 *
 * Because returning a plain `Promise` here breaks nested fragments, and it breaks them
 * SILENTLY-ish: postgres.js composes SQL by splicing a `Query` used as an interpolated value
 * into its parent (`value instanceof Query ? fragment(value, …)` in the driver's `types.js`),
 * and `repositories/hands.ts` builds every `order by` that way. Hand a `Promise` back instead
 * and the parent no longer recognises a fragment — worse, `Promise.race` calls `.then` on the
 * inner query, which is what makes postgres.js EXECUTE it. The whole `GET /hands?sort=` suite
 * failed with `syntax error at or near "order"` at character 1: the fragment had been run as a
 * statement of its own.
 *
 * A Proxy keeps the object a `Query` — `instanceof` reads the target's prototype — so the
 * driver still splices it, while anything that actually waits for it gets the bound. That also
 * makes the deadline LAZY: a query used as a fragment is never awaited, so no timer is ever
 * created for it.
 *
 * ## What is still not bounded, and it is a real gap
 *
 * `.values()`, `.raw()`, `.simple()`, `.describe()`, `.execute()` and `.forEach()` all return
 * `this` — which, called on the proxy, IS the proxy — so awaiting their result still goes
 * through the deadline. `.cursor()`, `.readable()` and `.writable()` do not: they hand back a
 * separate object whose settlement is not this query's promise, and nothing here bounds that.
 * Nothing in `apps/api/src` uses those three, and `test/db-deadlines.test.ts` scans for them so
 * the gap stays a known one rather than a surprise.
 */
function boundQuery(query: object, deadlineMs: number): object {
  let waiting: Promise<unknown> | null = null;
  return new Proxy(query, {
    get: (target, property, receiver): unknown => {
      if (!AWAIT_MEMBERS.has(property)) return Reflect.get(target, property, receiver);
      // Built against the RAW query, not the proxy: `boundedQuery` awaits what it is given, and
      // handing it the proxy would route straight back into this trap.
      waiting ??= boundedQuery(query as PromiseLike<unknown>, deadlineMs);
      const settled = waiting;
      const member = Reflect.get(settled, property) as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => member.apply(settled, args);
    },
  });
}

/**
 * A handle whose every query carries a client-side deadline.
 *
 * ## Why a Proxy
 *
 * `sql` is a callable with about twenty properties on it, and repositories use both halves:
 * the tagged template for queries and `sql(value)` for identifiers and fragments. A hand-
 * written wrapper would have to enumerate the surface and would silently drop whatever it
 * forgot. A Proxy forwards everything by default and intercepts exactly the two things that
 * need it — the tagged-template call, and the two functions that hand out a nested handle.
 *
 * `sql.unsafe`, `sql.file`, `sql.listen` and `sql.reserve` pass through unbounded. `.unsafe`
 * and `.file` are the migration runner's; `.listen` and `.reserve` are unused here.
 */
function deadlineBound<T extends object>(handle: T, deadlineMs: number): T {
  const proxy = new Proxy(handle, {
    apply: (target, thisArg, argArray: unknown[]): unknown => {
      const call = Reflect.apply(target as unknown as (...args: unknown[]) => unknown, thisArg, argArray);
      // `sql(name)` builds an identifier and `sql(object)` builds a fragment. Neither is a
      // query, and neither has anything to wait for.
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

/**
 * The `select 1` a previous probe gave up on, while it is still unanswered.
 *
 * A latch rather than a counter: what it prevents is a probe interval's worth of abandoned
 * queries piling up against `DATABASE_POOL_MAX` for the length of an outage. With it, a
 * frozen database costs readiness exactly one pooled connection however long the freeze
 * lasts, and every probe after the first answers immediately instead of waiting out its own
 * deadline first.
 */
let abandonedProbe: Promise<void> | null = null;

/**
 * Creates the process-wide client. Call once, early, from `server.ts`.
 *
 * Calling it twice is a programming error rather than something to paper over: two pools in
 * one process means two sets of connections against one `max_connections` budget, and the
 * second call's configuration silently losing to the first is exactly the kind of bug that
 * takes a day to find.
 *
 * Returns the DEADLINE-BOUND handle, which is the same one `getSql()` hands out. One module
 * returning two different wrappers around one pool, depending on which function you asked,
 * is precisely the sort of trap that ends up with the request path unbounded because
 * somebody held the wrong one.
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

/**
 * The process-wide client, with the request-path deadline on it.
 *
 * Throws rather than lazily creating one, because a lazily-created client would need
 * configuration from somewhere, and "somewhere" would mean reading `process.env` from deep
 * inside a repository — which is how a test suite ends up connecting to a developer's real
 * database.
 */
export function getSql(): Sql {
  if (bound === null) {
    throw new Error('getSql() before configureDatabase(); call configureDatabase(config) during boot');
  }
  return bound;
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
 *
 * `tx` arrives already deadline-bound, statement by statement, and the whole block carries a
 * deadline of its own — see `boundScope`. Nothing here has to arrange that, and deliberately
 * does not: `routes/auth.ts` calls `sql.begin` directly on a handle from `getSql()`, and it
 * gets the same bound because the bound lives on the handle rather than in this helper.
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
 *
 * The three `detail` values are three different incidents and are worded so an operator can
 * tell them apart from the 503 body alone: never configured, answered with an error, and
 * did not answer at all. The last one is the frozen-server case, and it is the one that used
 * to hang this function for the length of the outage.
 */
export async function ping(): Promise<DbCheck> {
  if (shared === null) return { ok: false, detail: 'database is not configured' };
  // A probe this function already gave up on is still outstanding, so the answer is known
  // without spending a second connection to ask again. The wording is the earlier probe's and
  // it is still true: nothing has come back. The latch clears the moment that query settles —
  // by the server answering or by the socket dying — so recovery costs at most one probe
  // interval of reporting degraded after the database is back.
  if (abandonedProbe !== null) {
    return { ok: false, detail: `database did not answer within ${PROBE_QUERY_DEADLINE_MS} ms` };
  }
  const query = shared`select 1 as ok`;
  try {
    await underDeadline(query, PROBE_QUERY_DEADLINE_MS);
    return { ok: true };
  } catch (error) {
    if (!(error instanceof DatabaseDeadlineError)) return { ok: false, detail: 'database did not answer' };
    const outstanding = error.abandoned;
    abandonedProbe = outstanding;
    // Cleared by whichever settlement comes first — the server finally answering, or the
    // socket dying and the driver rejecting. Compared by identity so that a probe issued
    // after a `closeDatabase`/`configureDatabase` cycle cannot be un-latched by the previous
    // pool's query resolving late.
    void outstanding.finally(() => {
      if (abandonedProbe === outstanding) abandonedProbe = null;
    });
    return { ok: false, detail: `database did not answer within ${error.deadlineMs} ms` };
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
  bound = null;
  abandonedProbe = null;
  await client.end({ timeout: Math.max(0, Math.ceil(timeoutMs / 1000)) });
}

/** The handle `buildApp` uses in production. A test passes its own stub instead. */
export const database: DatabaseHandle = { ping, close: closeDatabase };
