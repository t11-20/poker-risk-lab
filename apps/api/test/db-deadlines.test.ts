/**
 * Client-side deadlines, so a frozen database cannot hang this process. `statement_timeout` is
 * server-side and a frozen server enforces nothing. The drill measured `/ready` answering 200 after
 * 16,772 ms across a 16,641 ms outage. A freeze is modelled two ways, a handle whose `ping()` never
 * settles and a loopback TCP server that never replies. Each timing case runs the unbounded path as
 * its negative control. Real-Postgres behaviour is measured by `test:drills --only postgres-outage`.
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

/** Generous, because the property is "bounded at all" and a flaky bound teaches people to re-run. */
const TIMING_SLACK_MS = 500;

const UNBOUNDED_PROOF_MULTIPLE = 3;

/** The floor of the legal range, giving the shortest request-path deadline (2,100 ms). */
const TEST_STATEMENT_TIMEOUT_MS = 100;

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    // `/ready` is not exempt from the rate limit.
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

/** Accepts and never replies, as `docker pause` looks to a client. Sockets are kept for teardown. */
async function frozenPostgres(): Promise<{ readonly port: number }> {
  const server = createServer((socket) => {
    openSockets.push(socket);
    // Consume the startup packet so a full kernel buffer cannot turn the hang into another failure.
    socket.on('data', () => undefined);
    socket.on('error', () => undefined);
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the frozen server must have a port');
  return { port: address.port };
}

/** The connect timeout is far above any wait here, so postgres.js never fires first. */
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
  readonly lastProbe: () => Promise<DbCheck> | null;
}

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

const NEVER = (): Promise<DbCheck> => new Promise<DbCheck>(() => undefined);

async function appWith(database: DatabaseHandle): Promise<FastifyInstance> {
  const app = await buildApp({ config: testConfig(), database, metrics: new AppMetrics() });
  openApps.push(app);
  return app;
}

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

    // NEGATIVE CONTROL. The handle is still pending, so the 503 came from the deadline.
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

    // Not awaited, so `/health` is measured while readiness is outstanding.
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
    // A liveness ping would make the orchestrator's kill decision depend on Postgres.
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
    // A 500 from `/ready` says "bug" to an orchestrator that needed "do not send me traffic".
    const broken = handle(() => Promise.reject(new Error('pool exploded')));
    const app = await appWith(broken);

    const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(response.statusCode, 503);
    const body = response.json<{ status: string; checks: { database: { detail?: string } } }>();
    assert.equal(body.status, 'degraded');
    assert.equal(body.checks.database.detail, 'database did not answer');
    assert.doesNotMatch(response.body, /pool exploded|Error:|at /, 'no internal detail may be returned');
  });
});

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

      // The latch. A second probe while the first is outstanding spends no further pooled connection.
      const latchedAt = performance.now();
      const second = await ping();
      const latchedMs = performance.now() - latchedAt;
      assert.equal(second.ok, false);
      assert.ok(latchedMs < TIMING_SLACK_MS, `the latched probe must be immediate, took ${latchedMs} ms`);

      // NEGATIVE CONTROL. The same `select 1` with no client-side deadline is still waiting.
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
      assert.equal(thrown.code, 'service_unavailable');
      assert.equal(thrown.statusCode, 503);
      assert.ok(
        elapsed < deadlineMs + TIMING_SLACK_MS,
        `the request path must be bounded at ${deadlineMs} ms, took ${Math.round(elapsed)} ms`,
      );
      assert.ok(elapsed > TEST_STATEMENT_TIMEOUT_MS, 'the deadline must sit above statement_timeout');
    } finally {
      await closeDatabase(0);
    }
  });

  it('bounds a whole transaction, because the driver’s rollback is not ours to bound', async () => {
    // postgres.js awaits its own `rollback` after a failed statement, which no per-statement bound
    // reaches, so without a whole-block bound every write would hang through the outage.
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

describe('the deadlines are ordered so that each can only catch what the one below cannot', () => {
  it('bounds the probe more tightly than the endpoint that calls it', () => {
    assert.ok(
      PROBE_QUERY_DEADLINE_MS < READINESS_DEADLINE_MS,
      'the informative bound must fire first; the endpoint bound is the backstop for a broken handle',
    );
    // Kubernetes' `readinessProbe.timeoutSeconds` defaults to one second.
    assert.ok(
      READINESS_DEADLINE_MS < 1_000,
      'the endpoint bound must fit inside a one-second orchestrator probe timeout',
    );
  });

  it('keeps the request-path deadline above the server’s own ceiling at every legal setting', () => {
    // Above statement_timeout, the deadline never cancels work PostgreSQL would have run.
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

/** Copied from `server-randomness.test.ts`. Not a parser. `db.ts` names these methods in prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Modifiers that return a separate iterator or stream, so the deadline on `then`/`catch`/`finally`
 * never reaches them. Modifiers that return the query itself stay bounded.
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
        // The receiver must be a closing backtick or a `sql`-shaped identifier.
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
    // NEGATIVE CONTROL for the scan above.
    const violation = 'const rows = await getSql()`select 1`.cursor(100);';
    const pattern = new RegExp(`(\`|\\bsql|\\btx|\\bhandle|\\bdb)\\s*${escapeForRegExp('.cursor(')}`);
    assert.equal(pattern.test(stripComments(violation)), true, 'the detector must see a real violation');
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
