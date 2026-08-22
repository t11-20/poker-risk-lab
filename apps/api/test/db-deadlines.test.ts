/**
 * The client-side deadlines: a frozen database must not be able to hang this process.
 *
 * ## The defect these tests hold closed
 *
 * `ping()` ran `select 1` with nothing bounding it and `/api/v1/ready` awaited it
 * unconditionally. With PostgreSQL FROZEN rather than stopped — `docker pause`, a suspended VM,
 * a partition that leaves the TCP connection established — the socket stays open, no FIN
 * arrives, and nothing ever comes back. So the readiness probe did not answer 503. It did not
 * answer at all. `scripts/reliability-drills.mjs --only postgres-outage` measured three of three
 * probes exceeding a 4,000 ms deadline, and a `/ready` issued the instant the freeze began
 * answering **200 READY** after 16,772 ms, having spanned a 16,641 ms outage — a monitoring
 * system that waited would have recorded the outage as healthy. Every database-touching request
 * hung with it: an authenticated `GET /api/v1/rooms` had not answered four seconds in.
 *
 * `DATABASE_STATEMENT_TIMEOUT_MS` could not have caught any of it. It is a SERVER-side
 * `statement_timeout`, and a server that is frozen enforces nothing.
 *
 * ## How a freeze is modelled here, and why no container is needed
 *
 * Two models, deliberately, because they prove different halves.
 *
 *   * A `DatabaseHandle` whose `ping()` returns a promise that never settles. That is the
 *     honest model of a frozen dependency at the seam `/ready` actually depends on, and it is
 *     what proves the endpoint's own contract holds for ANY handle rather than only for the one
 *     `db.ts` ships.
 *   * A real `net` server on loopback that accepts the connection and then says nothing, with
 *     the real `postgres` driver pointed at it. TCP connects, the startup packet is sent, and no
 *     byte ever comes back — which is precisely what `docker pause` looks like from the client,
 *     and it exercises the real pool, the real proxy and the real `ping()`.
 *
 * ## Would these fail if the behaviour broke?
 *
 * Yes, and it is demonstrated rather than asserted. Every timing test carries the defect itself
 * as its negative control, run in the same case:
 *
 *   * `the endpoint answers while its handle never does` awaits the handle's own promise against
 *     a timer of three times the bound and requires it to be STILL PENDING. So the 503 cannot
 *     have come from the handle.
 *   * `ping reports degraded` runs an UNBOUNDED `select 1` from a second pool against the same
 *     dead server and requires it to be still pending after three times the bound. That is the
 *     old code path, reproduced, failing, beside the new one passing.
 *   * `the query-modifier restriction` feeds its scanner a source string that contains a real
 *     violation and requires it to fire.
 *
 * Checked by hand as well, by reverting each half: with the race in `pingWithinDeadline`
 * replaced by a bare `await db.ping()`, the first three cases below time out rather than
 * failing an assertion; with `boundedQuery` in `deadlineBound`'s apply trap replaced by the raw
 * call, the query-path cases do the same.
 *
 * ## What these tests do NOT prove
 *
 * Nothing about a real Postgres under a real freeze — `pnpm run test:drills --only
 * postgres-outage` is what measures that, and it is where the numbers in the header came from.
 * Nothing about latency under load. And the wall-clock assertions here are upper bounds with
 * room for a loaded machine, not performance measurements.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import {
  closeDatabase,
  configureDatabase,
  createDatabaseClient,
  type DatabaseHandle,
  type DbCheck,
  getSql,
  PROBE_QUERY_DEADLINE_MS,
  ping,
  queryDeadlineMs,
  READINESS_DEADLINE_MS,
  withTransaction,
} from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import { AppMetrics } from '../src/observability/metrics.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, '..', 'src');

/**
 * Headroom over a deadline before a timing assertion fails.
 *
 * Generous on purpose. These are upper bounds on an event-loop timer, measured on whatever
 * machine happens to be running the suite, and a bound that fails on a loaded laptop teaches
 * people to re-run tests rather than to read them. The property being asserted — "bounded at
 * all", as against the unbounded wait that shipped — survives half a second of slack intact.
 */
const TIMING_SLACK_MS = 500;

/** The multiple of a deadline that a negative control waits before calling something hung. */
const UNBOUNDED_PROOF_MULTIPLE = 3;

/**
 * The statement timeout these tests configure, and why it is the floor of the accepted range.
 *
 * `queryDeadlineMs` is `statement_timeout` plus two seconds of slack, so the smallest legal
 * statement timeout gives the smallest request-path deadline — 2,100 ms — and therefore the
 * shortest honest test. Anything larger would only make this file slower without asserting
 * anything more.
 */
const TEST_STATEMENT_TIMEOUT_MS = 100;

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    // Never connected to by the cases that use it: they pass `buildApp` a stub handle.
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    // Generous, so the limiter is never why a probe assertion fails. `/ready` is deliberately
    // NOT exempt from the rate limit, so a run of probes here would otherwise reach it.
    RATE_LIMIT_MAX: '5000',
    ...overrides,
  });
}

const openApps: FastifyInstance[] = [];
const openServers: Server[] = [];
const openSockets: Socket[] = [];

after(async () => {
  for (const app of openApps) await app.close();
  for (const socket of openSockets) socket.destroy();
  for (const server of openServers) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * A TCP server that accepts a connection and then never says a word.
 *
 * This is the whole freeze, faithfully: the kernel completes the handshake, the driver sends its
 * startup packet, and no reply ever comes. Every accepted socket is kept in `openSockets` so
 * that the teardown can destroy it — dropping the reference would leave the driver waiting on a
 * socket nobody closes and the test process would not exit.
 */
async function frozenPostgres(): Promise<{ readonly port: number }> {
  const server = createServer((socket) => {
    openSockets.push(socket);
    // Deliberately empty: saying nothing IS the behaviour under test. The `data` listener exists
    // so the incoming startup packet is consumed rather than backing up in the kernel buffer,
    // which would eventually stall the writer and turn a hang into a different failure.
    socket.on('data', () => undefined);
    socket.on('error', () => undefined);
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the frozen server must have a port');
  return { port: address.port };
}

/**
 * Configuration pointed at a server that will never answer.
 *
 * `DATABASE_CONNECT_TIMEOUT_SECONDS` is set far above anything this file waits for, and that is
 * load-bearing rather than tidy: if the driver's own connect timeout could fire first, every
 * assertion below would be about postgres.js rather than about the deadlines being tested.
 */
function frozenConfig(port: number): AppConfig {
  return testConfig({
    DATABASE_URL: `postgresql://frozen:frozen@127.0.0.1:${port}/frozen`,
    DATABASE_CONNECT_TIMEOUT_SECONDS: '120',
    DATABASE_STATEMENT_TIMEOUT_MS: String(TEST_STATEMENT_TIMEOUT_MS),
    DATABASE_POOL_MAX: '2',
  });
}

/** Resolves to `pending` when `work` has not settled within `ms`. */
async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<'pending' | 'settled'> {
  let timer: NodeJS.Timeout | null = null;
  const expiry = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms);
    timer.unref();
  });
  try {
    return await Promise.race([
      work.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      expiry,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

interface CountingHandle extends DatabaseHandle {
  readonly pings: () => number;
  /** The promise the last `ping()` returned, so a test can ask whether it ever settled. */
  readonly lastProbe: () => Promise<DbCheck> | null;
}

/** A handle that counts its probes and answers however the case needs. */
function handle(answer: () => Promise<DbCheck>): CountingHandle {
  let count = 0;
  let last: Promise<DbCheck> | null = null;
  return {
    ping: () => {
      count += 1;
      last = answer();
      return last;
    },
    close: () => Promise.resolve(),
    pings: () => count,
    lastProbe: () => last,
  };
}

/** Never settles. The frozen dependency, at the seam `/ready` depends on. */
const NEVER = (): Promise<DbCheck> => new Promise<DbCheck>(() => undefined);

async function appWith(database: DatabaseHandle): Promise<FastifyInstance> {
  const app = await buildApp({ config: testConfig(), database, metrics: new AppMetrics() });
  openApps.push(app);
  return app;
}

// ---------------------------------------------------------------------------
// The endpoint contract: /ready always answers, /health never depends on it
// ---------------------------------------------------------------------------

describe('readiness answers within a bound whatever the database is doing', () => {
  it('answers degraded while its handle never answers at all', async () => {
    const frozen = handle(NEVER);
    const app = await appWith(frozen);

    const startedAt = performance.now();
    const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    const elapsed = performance.now() - startedAt;

    assert.equal(response.statusCode, 503, 'a degraded instance must be taken out of rotation');
    const body = response.json<{ status: string; checks: { database: { ok: boolean; detail?: string } } }>();
    assert.equal(body.status, 'degraded');
    assert.equal(body.checks.database.ok, false);
    assert.match(
      body.checks.database.detail ?? '',
      /did not answer within \d+ ms/,
      'the reason must distinguish a silent database from one that answered with an error',
    );
    assert.ok(
      elapsed < READINESS_DEADLINE_MS + TIMING_SLACK_MS,
      `the probe must answer inside ${READINESS_DEADLINE_MS} ms, took ${Math.round(elapsed)} ms`,
    );
    assert.equal(frozen.pings(), 1, 'the route must have actually probed, or this proves nothing');

    // NEGATIVE CONTROL, on this very case: the handle's own promise is still pending. So the
    // answer above came from the deadline and could not have come from the database. Without the
    // race in `pingWithinDeadline`, this request is the one that never returns.
    const probe = frozen.lastProbe();
    assert.ok(probe !== null);
    assert.equal(
      await settlesWithin(probe, READINESS_DEADLINE_MS * UNBOUNDED_PROOF_MULTIPLE),
      'pending',
      'the stub is meant to model a freeze; if it settled, this test proves nothing',
    );
  });

  it('keeps answering liveness from memory while readiness is wedged', async () => {
    const frozen = handle(NEVER);
    const app = await appWith(frozen);

    // Issued first and deliberately not awaited: the point is what `/health` does WHILE the
    // readiness probe is outstanding against a database that will never answer.
    const readiness = app.inject({ method: 'GET', url: '/api/v1/ready' });

    const liveness: { status: number; elapsedMs: number }[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const startedAt = performance.now();
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      liveness.push({ status: response.statusCode, elapsedMs: performance.now() - startedAt });
      assert.equal(
        response.json<{ status: string }>().status,
        'ok',
        'a live process with a dead dependency must not be killed and replaced',
      );
    }

    assert.deepEqual(
      liveness.map((entry) => entry.status),
      [200, 200, 200, 200, 200],
      'every liveness probe must answer 200 while the database is frozen',
    );
    const slowest = Math.max(...liveness.map((entry) => entry.elapsedMs));
    assert.ok(slowest < TIMING_SLACK_MS, `liveness answered from memory, slowest ${Math.round(slowest)} ms`);
    // The property that matters more than the timing: liveness never asked the database anything.
    // One extra `ping` here would mean an orchestrator's kill decision now depends on Postgres.
    assert.equal(frozen.pings(), 1, 'only the readiness probe may touch the handle');

    assert.equal((await readiness).statusCode, 503);
  });

  it('does not fire for a database that answers normally', async () => {
    const healthy = handle(() => Promise.resolve({ ok: true }));
    const app = await appWith(healthy);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = performance.now();
      const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });
      const elapsed = performance.now() - startedAt;
      assert.equal(response.statusCode, 200, 'a healthy instance must stay in rotation');
      const body = response.json<{
        status: string;
        checks: { database: { ok: boolean; detail?: string } };
      }>();
      assert.equal(body.status, 'ready');
      assert.equal(body.checks.database.ok, true);
      assert.equal(body.checks.database.detail, undefined, 'a ready answer carries no reason');
      assert.ok(elapsed < TIMING_SLACK_MS, `took ${Math.round(elapsed)} ms for an in-memory answer`);
    }
    assert.equal(healthy.pings(), 3, 'each probe is a fresh question, never a cached one');
  });

  it('reports degraded rather than 500 when a handle breaks its contract and throws', async () => {
    // `ping()` is documented never to throw. `/ready` is the wrong place to find out that a
    // handle disagrees: a 500 from the readiness endpoint says "bug" to an orchestrator that
    // needed to hear "do not send me traffic".
    const broken = handle(() => Promise.reject(new Error('pool exploded')));
    const app = await appWith(broken);

    const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(response.statusCode, 503);
    const body = response.json<{ status: string; checks: { database: { detail?: string } } }>();
    assert.equal(body.status, 'degraded');
    assert.equal(body.checks.database.detail, 'database did not answer');
    // And nothing about the failure reached the client.
    assert.doesNotMatch(response.body, /pool exploded|Error:|at /, 'no internal detail may be returned');
  });
});

// ---------------------------------------------------------------------------
// The driver, against a socket that never answers
// ---------------------------------------------------------------------------

describe('the real pool against a frozen server', () => {
  it('reports degraded within the probe deadline, and the unbounded query proves it was frozen', async () => {
    const { port } = await frozenPostgres();
    const config = frozenConfig(port);
    configureDatabase(config);
    try {
      const startedAt = performance.now();
      const check = await ping();
      const elapsed = performance.now() - startedAt;

      assert.equal(check.ok, false);
      assert.equal(check.detail, `database did not answer within ${PROBE_QUERY_DEADLINE_MS} ms`);
      assert.ok(
        elapsed < PROBE_QUERY_DEADLINE_MS + TIMING_SLACK_MS,
        `ping must be bounded at ${PROBE_QUERY_DEADLINE_MS} ms, took ${Math.round(elapsed)} ms`,
      );

      // The latch: a second probe while the first is still outstanding answers at once and does
      // not spend another pooled connection. Over a long outage this is the difference between
      // one stranded connection and one per probe interval.
      const latchedAt = performance.now();
      const second = await ping();
      const latchedMs = performance.now() - latchedAt;
      assert.equal(second.ok, false);
      assert.ok(latchedMs < TIMING_SLACK_MS, `the latched probe must be immediate, took ${latchedMs} ms`);

      // NEGATIVE CONTROL: the same `select 1`, from a second pool against the same server, with
      // no client-side deadline on it. This is exactly the code that shipped, and it is still
      // waiting when everything above has finished.
      const unbounded = createDatabaseClient(config);
      try {
        const raw = Promise.resolve(unbounded`select 1 as ok`).then(
          () => undefined,
          () => undefined,
        );
        assert.equal(
          await settlesWithin(raw, PROBE_QUERY_DEADLINE_MS * UNBOUNDED_PROOF_MULTIPLE),
          'pending',
          'an unbounded select 1 must still be waiting, or this server is not modelling a freeze',
        );
      } finally {
        await unbounded.end({ timeout: 0 }).catch(() => undefined);
      }
    } finally {
      await closeDatabase(0);
    }
  });

  it('fails a request-path query with service_unavailable instead of hanging', async () => {
    const { port } = await frozenPostgres();
    const config = frozenConfig(port);
    const deadlineMs = queryDeadlineMs(config);
    configureDatabase(config);
    try {
      const startedAt = performance.now();
      const thrown = await getSql()`select 1 as ok`.then(
        () => null,
        (error: unknown) => error,
      );
      const elapsed = performance.now() - startedAt;

      assert.ok(
        thrown instanceof AppError,
        `a bounded query must fail as an AppError, got ${String(thrown)}`,
      );
      // 503 and "try again shortly", not 500 and "something went wrong": a retrying client and a
      // load balancer both need to hear that this is temporary and not a bug.
      assert.equal(thrown.code, 'service_unavailable');
      assert.equal(thrown.statusCode, 503);
      assert.ok(
        elapsed < deadlineMs + TIMING_SLACK_MS,
        `the request path must be bounded at ${deadlineMs} ms, took ${Math.round(elapsed)} ms`,
      );
      // Above the server's own ceiling, so this deadline cannot have pre-empted work Postgres
      // itself would have allowed.
      assert.ok(elapsed > TEST_STATEMENT_TIMEOUT_MS, 'the deadline must sit above statement_timeout');
    } finally {
      await closeDatabase(0);
    }
  });

  it('bounds a whole transaction, because the driver’s rollback is not ours to bound', async () => {
    // The case a per-statement deadline alone does not cover. When a statement inside `begin`
    // fails, postgres.js awaits `rollback` on the same connection — a statement this module never
    // sees and cannot wrap. Against a frozen server that rollback never returns, so without a
    // bound on the block as a whole, every WRITE would still hang for the length of the outage
    // while reads were correctly failing.
    const { port } = await frozenPostgres();
    const config = frozenConfig(port);
    const deadlineMs = queryDeadlineMs(config);
    configureDatabase(config);
    try {
      const startedAt = performance.now();
      const thrown = await withTransaction(async (tx) => {
        await tx`select 1 as ok`;
        return 'unreachable';
      }).then(
        (value) => value,
        (error: unknown) => error,
      );
      const elapsed = performance.now() - startedAt;

      assert.ok(thrown instanceof AppError, `a transaction must fail as an AppError, got ${String(thrown)}`);
      assert.equal(thrown.code, 'service_unavailable');
      assert.ok(
        elapsed < deadlineMs * 2 + TIMING_SLACK_MS,
        `a transaction must be bounded, took ${Math.round(elapsed)} ms`,
      );
    } finally {
      await closeDatabase(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The invariants the numbers have to satisfy
// ---------------------------------------------------------------------------

describe('the deadlines are ordered so that each can only catch what the one below cannot', () => {
  it('bounds the probe more tightly than the endpoint that calls it', () => {
    assert.ok(
      PROBE_QUERY_DEADLINE_MS < READINESS_DEADLINE_MS,
      'the informative bound must fire first; the endpoint bound is the backstop for a broken handle',
    );
    // Kubernetes' `readinessProbe.timeoutSeconds` defaults to one second, and it is the tightest
    // probe timeout any realistic deployment points at this endpoint. A bound at or above it puts
    // the defect straight back: the orchestrator learns "no answer" instead of "degraded".
    assert.ok(
      READINESS_DEADLINE_MS < 1_000,
      'the endpoint bound must fit inside a one-second orchestrator probe timeout',
    );
  });

  it('keeps the request-path deadline above the server’s own ceiling at every legal setting', () => {
    // The property that makes a blanket deadline safe: it can never cancel work that PostgreSQL
    // itself was willing to run, so it only ever fires for a server enforcing nothing. Asserted
    // across the whole accepted range rather than for the shipped default, because the range is
    // what an operator can actually choose.
    for (const statementTimeoutMs of [100, 1_000, 5_000, 30_000, 60_000]) {
      const config = testConfig({ DATABASE_STATEMENT_TIMEOUT_MS: String(statementTimeoutMs) });
      assert.equal(config.database.statementTimeoutMs, statementTimeoutMs, 'the setting must be accepted');
      assert.ok(
        queryDeadlineMs(config) > statementTimeoutMs,
        `at statement_timeout ${statementTimeoutMs} ms the client deadline must still be larger`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The restriction the bound handle imposes, kept visible
// ---------------------------------------------------------------------------

/**
 * Removes block and line comments, so a prose mention of a banned API is not read as a use of it.
 *
 * Taken from `test/server-randomness.test.ts` unchanged, including its limitation: it is not a
 * parser, so a `//` or a `/*` inside a string literal would confuse it. The `[^:]` before the
 * line-comment match is what stops it eating the rest of a line after `https://`. `db.ts` names
 * every one of these methods in prose, explaining why they are unavailable, so scanning raw text
 * would fail on the comment that documents the rule.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * The postgres.js modifiers that ESCAPE the deadline, and are therefore banned from `src/`.
 *
 * `boundQuery` attaches the bound to `then`/`catch`/`finally`, so every modifier that returns the
 * query itself — `.values()`, `.raw()`, `.simple()`, `.describe()`, `.execute()`, `.forEach()` —
 * stays inside it. These three do not: each hands back a separate object (an async iterator, a
 * stream) whose settlement is not the query's promise, so a query reached through `getSql()` and
 * then read this way would wait for a frozen server for ever, exactly as everything did before.
 *
 * Nothing in `apps/api/src` uses them. This is what makes that a checked fact rather than a
 * sentence in a comment, and it is why the gap is stated in `db.ts` rather than hidden.
 */
const UNBOUNDED_MODIFIERS = ['.cursor(', '.readable(', '.writable('];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

describe('nothing in the API reaches for a driver feature the bound handle cannot give it', () => {
  const files = sourceFiles(SRC_DIR);

  it('scans a tree it actually found', () => {
    assert.ok(files.length > 20, `expected the api source tree under src/, found ${files.length} files`);
  });

  it('uses none of the modifiers that would escape the deadline', () => {
    const offences: string[] = [];
    let scanned = 0;
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      scanned += 1;
      for (const modifier of UNBOUNDED_MODIFIERS) {
        // Only a call on something that could be a query matters, so the receiver has to be a
        // template literal's closing backtick or a `sql`-shaped identifier. A bare `.cursor(` on
        // some unrelated object is not this rule's business.
        const pattern = new RegExp(`(\`|\\bsql|\\btx|\\bhandle|\\bdb)\\s*${escapeForRegExp(modifier)}`);
        if (pattern.test(code)) offences.push(`${relative(SRC_DIR, file)} uses ${modifier}`);
      }
    }
    assert.ok(scanned > 20, `expected to scan the src tree, scanned ${scanned} files`);
    assert.deepEqual(
      offences,
      [],
      'these read a query in a way the client-side deadline cannot reach, so they would wait out ' +
        'a frozen server. Take a handle from `createDatabaseClient` and bound it yourself:\n' +
        offences.join('\n'),
    );
  });

  it('fires on a source that really does use one', () => {
    // NEGATIVE CONTROL for the scan above. Without this, a detector that had stopped matching
    // anything at all would report a clean tree for ever.
    const violation = 'const rows = await getSql()`select 1`.cursor(100);';
    const pattern = new RegExp(`(\`|\\bsql|\\btx|\\bhandle|\\bdb)\\s*${escapeForRegExp('.cursor(')}`);
    assert.equal(pattern.test(stripComments(violation)), true, 'the detector must see a real violation');
    // And it must not fire on the prose that documents the rule, which is the reason comments are
    // stripped in the first place.
    assert.equal(
      pattern.test(stripComments('// `.cursor(` is deliberately unavailable on a bound handle.')),
      false,
      'the detector must not fire on the comment explaining itself',
    );
  });
});

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
