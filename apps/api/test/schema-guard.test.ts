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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  classifyLedgerFailure,
  compareSchema,
  createSchemaGate,
  describeRefusal,
  LEDGER_GRANT_MIGRATION,
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

describe('createSchemaGate — readiness', () => {
  const ok = { ok: true } as const;

  it('passes the database answer through untouched when ping failed, without reading the ledger', async () => {
    let reads = 0;
    const gate = createSchemaGate({
      readLedger: () => {
        reads += 1;
        return Promise.resolve(SHIPPED);
      },
      shipped: () => SHIPPED,
      probeDeadlineMs: 50,
    });
    const down = { ok: false, detail: 'database did not answer within 600 ms' };
    assert.deepEqual(await gate.readiness(down), down);
    assert.equal(
      reads,
      0,
      "a dead `select 1` must not be followed by a second query; ping's latch exists for that",
    );
  });

  it('is degraded while behind, recovers when the ledger catches up, and then stops asking', async () => {
    let ledger: readonly MigrationRecord[] = SHIPPED.slice(0, 2);
    let reads = 0;
    const gate = createSchemaGate({
      readLedger: () => {
        reads += 1;
        return Promise.resolve(ledger);
      },
      shipped: () => SHIPPED,
      probeDeadlineMs: 50,
    });

    const behind = await gate.readiness(ok);
    assert.equal(behind.ok, false);
    assert.match(behind.detail ?? '', /0003_third\.sql/);

    ledger = SHIPPED; // somebody ran `migrate up` while this instance was degraded
    assert.deepEqual(await gate.readiness(ok), ok);

    // Sticky: from here `/ready` is `select 1` again. A reader that would now fail proves it is
    // not consulted.
    const before = reads;
    ledger = [];
    assert.deepEqual(await gate.readiness(ok), ok);
    assert.equal(reads, before);
  });

  it('answers "not yet verified" inside its deadline when the ledger hangs, and shares one read', async () => {
    let reads = 0;
    let release: (rows: readonly MigrationRecord[]) => void = () => undefined;
    const hanging = new Promise<readonly MigrationRecord[]>((resolve) => {
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
    release(SHIPPED);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await gate.readiness(ok), ok);
  });

  it('records a boot verification, so the first probe after a clean boot reads nothing', async () => {
    let reads = 0;
    const gate = createSchemaGate({
      readLedger: () => {
        reads += 1;
        return Promise.resolve(SHIPPED);
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
