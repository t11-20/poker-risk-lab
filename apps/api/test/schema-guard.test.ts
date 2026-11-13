/**
 * The schema guard's comparison and its readiness gate, with no database.
 *
 * ## The incident these exist for
 *
 * Two PRs in one day added a migration the development database did not have (#25's 0008, #32's
 * 0009). The API booted green and `/ready` said 200 against a schema one column short; the first
 * sign was `column "automatic_reason" does not exist` from an archive write, after units had
 * silently stopped moving. `src/schema-guard.ts` compares the shipped files with the ledger, and
 * every verdict it can reach is pinned here, including the two that must NOT refuse — a schema
 * ahead of the build, which every rolling deploy produces, and a database that did not answer,
 * which `db-unavailable.md` says must leave the process up and degraded.
 *
 * `test/schema-guard-database.test.ts` is the other half: the same verdicts against a ledger the
 * real runner wrote, read as the runtime role, and the boot path in a spawned server.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import websocketPlugin from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp, type RouteModule, registerRoutes } from '../src/app.ts';
import { type AppConfig, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { AppMetrics } from '../src/observability/metrics.ts';
import {
  classifyLedgerFailure,
  compareSchema,
  createSchemaGate,
  describeRefusal,
  LEDGER_GRANT_MIGRATION,
  type LedgerReading,
  type MigrationRecord,
  migrationChecksum,
  readShippedMigrations,
  type SchemaVerdict,
  SHIPPED_MIGRATIONS_DIR,
  verifySchema,
} from '../src/schema-guard.ts';

const SHIPPED: readonly MigrationRecord[] = [
  { version: '0001_initial.sql', checksum: 'sha256:aaaa' },
  { version: '0002_second.sql', checksum: 'sha256:bbbb' },
  { version: '0003_third.sql', checksum: 'sha256:cccc' },
];

function refused(verdict: SchemaVerdict): Extract<SchemaVerdict, { kind: 'refused' }> {
  assert.equal(verdict.kind, 'refused', `expected a refusal, got ${JSON.stringify(verdict)}`);
  return verdict as Extract<SchemaVerdict, { kind: 'refused' }>;
}

describe('compareSchema — the verdicts', () => {
  it('passes a ledger that holds exactly the shipped files, and says how many it compared', () => {
    assert.deepEqual(compareSchema(SHIPPED, SHIPPED), { kind: 'current', applied: 3, ahead: [] });
  });

  it('refuses a ledger missing the newest file, naming it and the command', () => {
    const verdict = refused(compareSchema(SHIPPED, SHIPPED.slice(0, 2)));
    assert.match(verdict.summary, /behind this build: 1 pending migration\(s\) \(0003_third\.sql\)/);
    assert.match(verdict.summary, /pnpm run db:migrate/);
    assert.match(verdict.problems.join('\n'), /not applied: 0003_third\.sql/);
    assert.match(verdict.fix, /pnpm run db:migrate/);
    assert.match(verdict.fix, /DATABASE_MIGRATION_URL/);
    assert.match(verdict.fix, /RUNBOOK\.md §11\.3/);
  });

  it('refuses an empty ledger as a database that was never migrated', () => {
    const verdict = refused(compareSchema(SHIPPED, []));
    assert.match(verdict.problems.join('\n'), /empty: this database has never been migrated/);
    assert.match(verdict.summary, /3 pending migration\(s\)/);
  });

  it('refuses an empty list of shipped files — a comparison with nothing is not a pass', () => {
    // The ledger is "complete" relative to nothing, which is exactly how a guard over an image
    // whose COPY stopped matching would otherwise answer.
    const verdict = refused(compareSchema([], SHIPPED));
    assert.match(verdict.problems.join('\n'), /nothing to compare/);
  });

  it('refuses a checksum mismatch, and says migrating will not fix it', () => {
    const ledger = SHIPPED.map((row) =>
      row.version === '0002_second.sql' ? { ...row, checksum: 'sha256:edited' } : row,
    );
    const verdict = refused(compareSchema(SHIPPED, ledger));
    assert.match(verdict.summary, /1 applied migration\(s\) were edited/);
    assert.match(verdict.problems.join('\n'), /0002_second\.sql: the ledger recorded edited, .* bbbb/);
    assert.match(verdict.fix, /refuses this too/);
    assert.doesNotMatch(verdict.fix, /pnpm run db:migrate/);
  });

  it('gives the drift fix when a file is both edited and another pending', () => {
    const ledger = [SHIPPED[0], { ...SHIPPED[1], checksum: 'sha256:edited' }] as MigrationRecord[];
    const verdict = refused(compareSchema(SHIPPED, ledger));
    assert.equal(verdict.problems.length, 2);
    assert.match(verdict.fix, /immutable/);
  });

  it('allows a ledger AHEAD of the build, and reports what it does not know', () => {
    // Migrate-then-roll (RUNBOOK §11.3): the outgoing build always sees this during a deploy.
    const ledger = [...SHIPPED, { version: '0004_from_a_newer_build.sql', checksum: 'sha256:dddd' }];
    assert.deepEqual(compareSchema(SHIPPED, ledger), {
      kind: 'current',
      applied: 3,
      ahead: ['0004_from_a_newer_build.sql'],
    });
  });

  it('warns that a pending file below an applied one will be refused as out of order', () => {
    // Two branches that each added a migration: the database has the other branch's 0004.
    const ledger = [
      SHIPPED[0],
      SHIPPED[1],
      { version: '0004_other_branch.sql', checksum: 'sha256:eeee' },
    ] as MigrationRecord[];
    const verdict = refused(compareSchema(SHIPPED, ledger));
    assert.match(verdict.problems.join('\n'), /0003_third\.sql sort\(s\) before 0004_other_branch\.sql/);
  });

  it("says migrate will also refuse the other branch's file when behind AND ahead", () => {
    // Switching branches: the database has another branch's 0004 and lacks this one's 0003 — and
    // `migrate.mjs up` refuses a ledger row with no file, so "run db:migrate" alone would be a
    // second refusal.
    const ledger = [SHIPPED[0], SHIPPED[1], { version: '0009_other_branch.sql', checksum: 'sha256:ffff' }];
    const verdict = refused(compareSchema(SHIPPED, ledger as MigrationRecord[]));
    assert.match(
      verdict.problems.join('\n'),
      /1 migration\(s\) this build has no file for: 0009_other_branch\.sql/,
    );
    assert.match(verdict.problems.join('\n'), /--allow-missing/);
  });

  it('prints in the shape the configuration refusal uses', () => {
    const text = describeRefusal(refused(compareSchema(SHIPPED, SHIPPED.slice(0, 1))));
    assert.match(text, /^Refusing to start: the database schema does not match this build\.\n {2}- /);
    assert.match(text, /0002_second\.sql, 0003_third\.sql/);
  });
});

describe('classifyLedgerFailure — an answer versus no answer', () => {
  it('refuses a missing ledger', () => {
    for (const code of ['42P01', '3F000']) {
      assert.match(refused(classifyLedgerFailure({ code })).problems[0] ?? '', /never been migrated/);
    }
  });

  it('refuses a ledger the identity may not read, naming the migration that grants it', () => {
    const verdict = refused(classifyLedgerFailure({ code: '42501' }));
    assert.ok(verdict.summary.includes(LEDGER_GRANT_MIGRATION));
    assert.match(verdict.problems[0] ?? '', /member of prl_app/);
  });

  it('leaves the question open when the database did not answer, and never echoes a driver message', () => {
    for (const error of [
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:5432 user=prl_api'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('the database system is starting up'), { code: '57P03' }),
      new Error('host db.internal said something'),
    ]) {
      const verdict = classifyLedgerFailure(error);
      assert.equal(verdict.kind, 'unverified');
      assert.doesNotMatch(JSON.stringify(verdict), /10\.0\.0\.7|prl_api|db\.internal/);
    }
  });
});

describe('verifySchema — never throws', () => {
  it('turns an unreadable shipped directory into a refusal, not an exception', async () => {
    const verdict = await verifySchema(
      () => Promise.resolve(SHIPPED),
      () => {
        throw new Error('no migrations at /app/db/migrations');
      },
    );
    assert.match(refused(verdict).problems[0] ?? '', /no migrations at/);
  });

  it('turns a rejected ledger read into its classification', async () => {
    const verdict = await verifySchema(
      () => Promise.reject(Object.assign(new Error('permission denied'), { code: '42501' })),
      () => SHIPPED,
    );
    assert.equal(refused(verdict).problems.length, 1);
  });
});

describe('migrationChecksum — the rule migrate.mjs records', () => {
  it('ignores a BOM and CRLF line endings, and nothing else', () => {
    const lf = 'CREATE TABLE prl.x (id int);\nGRANT SELECT ON prl.x TO prl_app;\n';
    assert.equal(migrationChecksum(`\uFEFF${lf}`), migrationChecksum(lf));
    assert.equal(migrationChecksum(lf.replace(/\n/g, '\r\n')), migrationChecksum(lf));
    assert.notEqual(migrationChecksum(lf.replace('int', 'bigint')), migrationChecksum(lf));
    assert.match(migrationChecksum(lf), /^sha256:[0-9a-f]{64}$/);
  });
});

describe('readShippedMigrations — a sweep of nothing is not a pass', () => {
  it('reads the real directory, in order, and finds the ledger grant among it', () => {
    const files = readShippedMigrations();
    // Counted independently, so a reader that dropped files would not agree with itself.
    const onDisk = readdirSync(SHIPPED_MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'));
    assert.ok(onDisk.length > 0, `no migrations at ${SHIPPED_MIGRATIONS_DIR}`);
    assert.equal(files.length, onDisk.length);
    assert.deepEqual(
      files.map((file) => file.version),
      files.map((file) => file.version).sort(),
    );
    assert.ok(files.some((file) => file.version === LEDGER_GRANT_MIGRATION));
  });

  it('refuses a missing directory, an empty one, and a file it cannot order', () => {
    const root = mkdtempSync(join(tmpdir(), 'prl-schema-guard-'));
    try {
      assert.throws(() => readShippedMigrations(join(root, 'absent')), /could not be read .*ENOENT/);
      const empty = join(root, 'empty');
      mkdirSync(empty);
      assert.throws(() => readShippedMigrations(empty), /holds no migrations/);
      writeFileSync(join(empty, '0001_ok.sql'), 'select 1;\n');
      writeFileSync(join(empty, 'Later Fix.sql'), 'select 1;\n');
      assert.throws(() => readShippedMigrations(empty), /refuse to order: Later Fix\.sql/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** A ledger read from the database called `identity`. */
const reading = (rows: readonly MigrationRecord[], identity = 'db-a'): LedgerReading => ({ identity, rows });

describe('createSchemaGate — readiness', () => {
  const ok = { ok: true, identity: 'db-a' } as const;

  it('passes the database answer through untouched when ping failed, without reading the ledger', async () => {
    let reads = 0;
    const gate = createSchemaGate({
      readLedger: () => {
        reads += 1;
        return Promise.resolve(reading(SHIPPED));
      },
      shipped: () => SHIPPED,
      probeDeadlineMs: 50,
    });
    const down = { ok: false, detail: 'database did not answer within 600 ms' };
    assert.deepEqual(await gate.readiness(down), down);
    assert.equal(
      reads,
      0,
      "a dead probe must not be followed by a second query; ping's latch exists for that",
    );
  });

  it('is degraded while behind, recovers when the ledger catches up, and then stops asking', async () => {
    let ledger: readonly MigrationRecord[] = SHIPPED.slice(0, 2);
    let reads = 0;
    const gate = createSchemaGate({
      readLedger: () => {
        reads += 1;
        return Promise.resolve(reading(ledger));
      },
      shipped: () => SHIPPED,
      probeDeadlineMs: 50,
    });

    const behind = await gate.readiness(ok);
    assert.equal(behind.ok, false);
    assert.match(behind.detail ?? '', /0003_third\.sql/);

    ledger = SHIPPED; // somebody ran `migrate up` while this instance was degraded
    assert.deepEqual(await gate.readiness(ok), ok);

    // Sticky: from here `/ready` is the one probe query again. A reader that would now fail proves
    // it is not consulted — for the same database.
    const before = reads;
    ledger = [];
    assert.deepEqual(await gate.readiness(ok), ok);
    assert.equal(reads, before);
  });

  it('answers "not yet verified" inside its deadline when the ledger hangs, and shares one read', async () => {
    let reads = 0;
    let release: (value: LedgerReading) => void = () => undefined;
    const hanging = new Promise<LedgerReading>((resolve) => {
      release = resolve;
    });
    const gate = createSchemaGate({
      readLedger: () => {
        reads += 1;
        return hanging;
      },
      shipped: () => SHIPPED,
      probeDeadlineMs: 30,
    });
    const [first, second] = await Promise.all([gate.readiness(ok), gate.readiness(ok)]);
    assert.match(first.detail ?? '', /not yet verified: the migration ledger did not answer within 30 ms/);
    assert.deepEqual(second, first);
    assert.equal(reads, 1, 'concurrent probes must share one outstanding ledger read');
    release(reading(SHIPPED));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await gate.readiness(ok), ok);
  });

  it('records a boot verification, so the first probe after a clean boot reads nothing', async () => {
    let reads = 0;
    const gate = createSchemaGate({
      readLedger: () => {
        reads += 1;
        return Promise.resolve(reading(SHIPPED));
      },
      shipped: () => SHIPPED,
      probeDeadlineMs: 50,
    });
    assert.equal((await gate.verify()).kind, 'current');
    assert.deepEqual(await gate.readiness(ok), ok);
    assert.equal(reads, 1);
  });

  it('reports a database that answered with no ledger as a refusal, not as "not yet verified"', async () => {
    const gate = createSchemaGate({
      readLedger: () =>
        Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' })),
      shipped: () => SHIPPED,
      probeDeadlineMs: 50,
    });
    const answer = await gate.readiness(ok);
    assert.equal(answer.ok, false);
    assert.match(answer.detail ?? '', /does not exist; run pnpm run db:migrate/);
  });
});

/**
 * PR #38's review (Devin): a verdict used to be trusted for the life of the process, so a database
 * replaced behind the same DSN — restored into a recreated database, failed over, a newer
 * container — was served on the strength of a check made against a different one.
 */
describe('createSchemaGate — a verdict belongs to one database', () => {
  it('re-verifies when a different database answers, and refuses one that is behind', async () => {
    // Database A is current; B, which replaces it, is one file behind.
    let answering = reading(SHIPPED, 'db-a');
    let reads = 0;
    let changes = 0;
    const gate = createSchemaGate({
      readLedger: () => {
        reads += 1;
        return Promise.resolve(answering);
      },
      shipped: () => SHIPPED,
      probeDeadlineMs: 50,
      onDatabaseChanged: () => {
        changes += 1;
      },
    });
    assert.equal((await gate.verify()).kind, 'current');
    assert.deepEqual(await gate.readiness({ ok: true, identity: 'db-a' }), { ok: true, identity: 'db-a' });
    assert.equal(reads, 1, 'the same database is not asked twice');

    answering = reading(SHIPPED.slice(0, 2), 'db-b');
    const swapped = await gate.readiness({ ok: true, identity: 'db-b' });
    assert.equal(swapped.ok, false, 'a verdict for A must not admit B');
    assert.match(swapped.detail ?? '', /0003_third\.sql/);
    assert.equal(reads, 2, 'a different identity must cost exactly one ledger read');
    assert.equal(changes, 1);
    assert.equal(gate.admits().ok, false, 'and the feature routes close with it');

    // B is migrated in place: the same identity, now current, and sticky again.
    answering = reading(SHIPPED, 'db-b');
    assert.equal((await gate.readiness({ ok: true, identity: 'db-b' })).ok, true);
    assert.equal(gate.admits().ok, true);
    const settled = reads;
    assert.equal((await gate.readiness({ ok: true, identity: 'db-b' })).ok, true);
    assert.equal(reads, settled);
  });

  it('never trusts a verdict for a probe that cannot say which database answered', async () => {
    let reads = 0;
    const gate = createSchemaGate({
      readLedger: () => {
        reads += 1;
        return Promise.resolve(reading(SHIPPED, 'db-a'));
      },
      shipped: () => SHIPPED,
      probeDeadlineMs: 50,
    });
    await gate.verify();
    await gate.readiness({ ok: true });
    await gate.readiness({ ok: true });
    // Fail closed: an identity-less answer re-asks every time rather than inheriting A's verdict.
    assert.equal(reads, 3);
  });

  it('does not answer for a database the ledger read did not reach', async () => {
    // PR #38's review: mid-switch the probe reaches replacement B, which is behind, while the
    // ledger read reuses a pooled connection to A, which is current. Both are one pool's answers.
    let answering = reading(SHIPPED, 'db-a');
    const gate = createSchemaGate({
      readLedger: () => Promise.resolve(answering),
      shipped: () => SHIPPED,
      probeDeadlineMs: 50,
    });
    await gate.verify();
    assert.equal(gate.admits().ok, true);
    const mixed = await gate.readiness({ ok: true, identity: 'db-b' });
    assert.equal(mixed.ok, false, "A's ledger is no answer for B");
    assert.match(mixed.detail ?? '', /reached different databases/);
    assert.equal(gate.admits().ok, false, 'and the feature routes stay closed');

    // Once the ledger read reaches B too, B's own answer decides: here, one file behind.
    answering = reading(SHIPPED.slice(0, 2), 'db-b');
    const behind = await gate.readiness({ ok: true, identity: 'db-b' });
    assert.equal(behind.ok, false);
    assert.match(behind.detail ?? '', /0003_third\.sql/);
    assert.equal(gate.admits().ok, false);
  });

  it('closes the gate for the length of the re-verification, not after it', async () => {
    let release: (value: LedgerReading) => void = () => undefined;
    let first = true;
    const gate = createSchemaGate({
      readLedger: () => {
        if (first) {
          first = false;
          return Promise.resolve(reading(SHIPPED, 'db-a'));
        }
        return new Promise<LedgerReading>((resolve) => {
          release = resolve;
        });
      },
      shipped: () => SHIPPED,
      probeDeadlineMs: 20,
    });
    await gate.verify();
    assert.equal(gate.admits().ok, true);
    const probe = await gate.readiness({ ok: true, identity: 'db-b' });
    assert.match(probe.detail ?? '', /not yet verified/);
    const closed = gate.admits();
    assert.equal(closed.ok, false, 'feature requests must not be served while B is being looked at');
    assert.match(closed.detail ?? '', /different database is answering/);
    release(reading(SHIPPED, 'db-b'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gate.admits().ok, true);
  });
});

describe('createSchemaGate — admits, the feature gate', () => {
  it('refuses before any verdict, admits after current, refuses after a refusal found later', async () => {
    let ledger: Promise<LedgerReading> = Promise.reject(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );
    ledger.catch(() => undefined);
    const verdicts: string[] = [];
    const gate = createSchemaGate({
      readLedger: () => ledger,
      shipped: () => SHIPPED,
      probeDeadlineMs: 50,
      onVerdictChanged: (verdict) => verdicts.push(verdict.kind),
    });
    assert.equal(gate.admits().ok, false, 'nothing has been verified yet');

    assert.equal((await gate.verify()).kind, 'unverified'); // boot, during the outage
    const closed = gate.admits();
    assert.equal(closed.ok, false);
    assert.match(
      closed.detail ?? '',
      /not yet verified: the migration ledger could not be read \(ECONNREFUSED\)/,
    );

    ledger = Promise.resolve(reading(SHIPPED.slice(0, 2))); // back, and behind
    assert.equal((await gate.readiness({ ok: true, identity: 'db-a' })).ok, false);
    assert.match(gate.admits().detail ?? '', /schema is behind this build/);

    ledger = Promise.resolve(reading(SHIPPED)); // migrated
    assert.equal((await gate.readiness({ ok: true, identity: 'db-a' })).ok, true);
    assert.deepEqual(gate.admits(), { ok: true });
    assert.deepEqual(verdicts, ['refused', 'current'], 'each change reported once; boot reports itself');
  });
});

// ---------------------------------------------------------------------------
// The hook in `buildApp`
// ---------------------------------------------------------------------------

function gateConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    // Syntactically valid and never dialled.
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    RATE_LIMIT_EXPENSIVE_MAX: '5000',
  });
}

const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(undefined),
};

/** A feature route that touches nothing, and a WebSocket route that would accept anybody. */
const features: RouteModule = async (app) => {
  app.get('/feature', async () => ({ served: true }));
  await app.register(websocketPlugin);
  app.get('/socket', { websocket: true }, (socket) => {
    socket.close(1000, 'opened');
  });
};

async function gatedApp(
  admits: () => { ok: boolean; detail?: string },
  featureGate = true,
): Promise<FastifyInstance> {
  const app = await buildApp({
    config: gateConfig(),
    database: stubDatabase,
    metrics: new AppMetrics(),
    ...(featureGate ? { featureGate: { admits, retryAfterSeconds: 5 } } : {}),
  });
  await registerRoutes(app, [features]);
  await app.ready();
  return app;
}

/** The upgrade's answer: the HTTP status it was refused with, or 101 when the handshake completed. */
async function upgradeStatus(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/socket`);
    socket.once('unexpected-response', (_request, response) => {
      // Not terminated from this side: the server must hang up itself, or the refused upgrade is a
      // socket that holds a shutdown drain open. `close` never firing fails this as a timeout.
      response.socket.once('close', () => resolve(response.statusCode ?? 0));
      response.resume();
    });
    socket.once('upgrade', () => {
      resolve(101);
    });
    socket.once('error', (error) => {
      if (!/Unexpected server response/.test(error.message)) reject(error);
    });
  });
}

describe('buildApp featureGate — feature routes wait for a verdict', () => {
  it('answers 503 service_unavailable with Retry-After while closed, in the contract shape', async () => {
    const app = await gatedApp(() => ({ ok: false, detail: 'schema not yet verified: test' }));
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/feature' });
      assert.equal(response.statusCode, 503);
      assert.equal(response.headers['retry-after'], '5');
      assert.equal(response.headers['cache-control'], 'no-store');
      const body = response.json<{ error: { code: string; retryAfterSeconds?: number; message: string } }>();
      assert.equal(body.error.code, 'service_unavailable');
      assert.equal(body.error.retryAfterSeconds, 5);
      // The reason is logged, never sent.
      assert.doesNotMatch(response.body, /schema|verified/);
    } finally {
      await app.close();
    }
  });

  it('keeps liveness, readiness and metrics reachable while closed', async () => {
    const app = await gatedApp(() => ({ ok: false, detail: 'closed' }));
    try {
      for (const url of ['/api/v1/health', '/api/v1/ready', '/metrics']) {
        const response = await app.inject({ method: 'GET', url });
        assert.equal(response.statusCode, 200, `${url} must not be gated: ${response.body}`);
      }
      // An unknown path is refused too while closed: there is no route pattern to exempt.
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/nope' })).statusCode, 503);
    } finally {
      await app.close();
    }
  });

  it('serves once the gate admits, and follows it when it closes again', async () => {
    let open = false;
    const app = await gatedApp(() => (open ? { ok: true } : { ok: false, detail: 'refused' }));
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/feature' })).statusCode, 503);
      open = true;
      const served = await app.inject({ method: 'GET', url: '/api/v1/feature' });
      assert.equal(served.statusCode, 200);
      assert.deepEqual(served.json(), { served: true });
      open = false; // a refusal found later, or a different database answering
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/feature' })).statusCode, 503);
    } finally {
      await app.close();
    }
  });

  it('refuses the WebSocket upgrade with an HTTP 503 while closed, and completes it once open', async () => {
    const closed = await gatedApp(() => ({ ok: false, detail: 'closed' }));
    try {
      assert.equal(await upgradeStatus(closed), 503, 'no socket may open onto an unverified schema');
    } finally {
      await closed.close();
    }
    const open = await gatedApp(() => ({ ok: true }));
    try {
      assert.equal(await upgradeStatus(open), 101, 'the positive control: the same route upgrades');
    } finally {
      await open.close();
    }
  });

  it('counts a refused request against the limiter, like every other answer this server gives', async () => {
    const app = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
        PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
        SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
        RATE_LIMIT_MAX: '3',
      }),
      database: stubDatabase,
      metrics: new AppMetrics(),
      featureGate: { admits: () => ({ ok: false, detail: 'closed' }), retryAfterSeconds: 5 },
    });
    await registerRoutes(app, [features]);
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        statuses.push((await app.inject({ method: 'GET', url: '/api/v1/feature' })).statusCode);
      }
      assert.deepEqual(statuses, [503, 503, 503, 429, 429]);
    } finally {
      await app.close();
    }
  });

  it('is absent by default, so an app built without it is ungated (the seam every test uses)', async () => {
    const app = await gatedApp(() => ({ ok: false, detail: 'never consulted' }), false);
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/feature' })).statusCode, 200);
    } finally {
      await app.close();
    }
  });
});
