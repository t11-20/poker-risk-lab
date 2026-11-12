/**
 * The schema guard: this build refuses to serve a database whose migration ledger is behind the
 * migrations it shipped with.
 *
 * ## The incident
 *
 * The API neither migrates at boot nor asked whether anybody had. Twice in one day an open PR added
 * a migration (#25's 0008, then #32's 0009) and the development database stayed behind it until
 * somebody happened to run `migrate.mjs up`. Meanwhile the API booted green and `/ready` answered
 * 200 — `select 1` is perfectly happy against a schema one column short — and the only symptom was
 * archive writes failing with `column "automatic_reason" does not exist`: units silently stopped
 * moving, and the whole API test file failed with an error that named a column rather than a cause.
 * Nothing anywhere said "the schema is behind the code", which is a sentence this file can say
 * because both halves of it are on hand at boot: the files in `db/migrations/` and the ledger
 * `apps/api/scripts/migrate.mjs` writes into `prl.schema_migrations`.
 *
 * ## The verdicts, and which direction each one fails in
 *
 *   * **Behind** — a shipped file has no ledger row. Refused: the code was written against a column
 *     or a constraint that is not there, and the failure is a wrong answer on some later request
 *     rather than an error now. The refusal names the files and the command that applies them.
 *   * **Drifted** — a ledger row's checksum is not the file's. Refused, mirroring `migrate.mjs`,
 *     which aborts on the same comparison: the database and this build describe different schemas,
 *     and neither "reapply" nor "carry on" is safe.
 *   * **Ahead** — the ledger holds a file this build does not know. ALLOWED, with a warning. The
 *     RUNBOOK's deploy order is "migrate, then roll the API" (§11.3), so every rolling deploy runs
 *     the outgoing build against a ledger one file ahead of it, and a rollback of the image runs
 *     the previous build against the schema the new one migrated. Migrations are additive by
 *     policy — `up` refuses a destructive statement that does not declare itself irreversible, and
 *     a destructive change takes two releases — so an older build against a newer schema is the
 *     designed state of a deploy, not a fault. Refusing it would turn every deploy into an outage
 *     of the instances still draining.
 *   * **Unreadable** — the ledger does not exist, or this identity may not read it. Refused: that
 *     is the database ANSWERING, and the answer is "never migrated" or "behind 0010", which grants
 *     the read. A guess in the serving direction is the incident again.
 *   * **Unverified** — the database did not answer at all. NOT refused at boot, because
 *     `docs/production/runbooks/db-unavailable.md` makes "liveness 200, readiness 503, process
 *     stays up" the designed posture for an outage, drilled by `test:drills --only
 *     postgres-outage`: an API rescheduled during an outage must come up degraded, not crash-loop.
 *     Readiness reports degraded until a probe gets an answer, and then applies the same verdicts.
 *
 * ## Why readiness asks only until it has an answer
 *
 * A schema can only be BEHIND this build at boot. The file list is fixed when the build is, so a
 * row that appears in the ledger while the process runs is the AHEAD case, which is allowed. So
 * once the schema has been verified, the gate is sticky and `/ready` goes back to being `select 1`
 * and nothing else (`db.ts` says why that matters: the probe must be cheaper than the cheapest real
 * request). Only an instance that has not yet seen an answer spends a ledger query per probe, and
 * that one is single-flight and bounded by `PROBE_QUERY_DEADLINE_MS`. It runs after `ping()`, so
 * a slow `select 1` followed by a slow ledger read can outlast `READINESS_DEADLINE_MS` and answer
 * "readiness probe did not answer" rather than the schema's own detail: still a 503, only in the
 * not-yet-verified state, and the next probe usually has the answer the first one started.
 *
 * A refusal found by a probe, rather than at boot, does NOT exit. Traffic is already withheld by
 * the 503, and a readiness handler that can kill the process is a kill switch on a public route.
 * It keeps asking, so `migrate up` run while the instance is degraded makes it ready without a
 * restart.
 *
 * ## Why the ledger, and not the columns
 *
 * Comparing the live catalogue against what the code expects would need a second, hand-maintained
 * description of the schema, which is a list that drifts. The ledger already records exactly which
 * file ran, with a checksum of what it contained, and `migrate.mjs` is the only writer. The runtime
 * role reads it with the SELECT that `db/migrations/0010_schema_migrations_readable.sql` grants and
 * nothing more; it still cannot write a row.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbCheck, Sql } from './db.ts';

/**
 * `db/migrations/` at the repository root.
 *
 * The same three steps up from `src/` (development, tests) and from `dist/` (the built server),
 * because `tsconfig.json` maps `rootDir: src` to `outDir: dist` one-for-one. `Dockerfile.api` copies
 * the directory into the runtime image for exactly this path; before this file the image pruned
 * `db` altogether.
 */
export const SHIPPED_MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));

/** `migrate.mjs`'s FILE_NAME_PATTERN. A file it cannot order is one it will not apply. */
const FILE_NAME_PATTERN = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/** The migration that lets the runtime role read the ledger, named in the refusal it prevents. */
export const LEDGER_GRANT_MIGRATION = '0010_schema_migrations_readable.sql';

/** What both sides of the comparison are reduced to. */
export interface MigrationRecord {
  readonly version: string;
  readonly checksum: string;
}

export type SchemaVerdict =
  | {
      readonly kind: 'current';
      /** How many shipped files the ledger matched. Logged at boot as evidence of a real comparison. */
      readonly applied: number;
      /** Ledger rows this build has no file for: a newer build migrated this database. */
      readonly ahead: readonly string[];
    }
  | {
      readonly kind: 'refused';
      /** One line, short enough for the readiness body. */
      readonly summary: string;
      /** Every finding, for stderr at boot. */
      readonly problems: readonly string[];
      /** What to run or do about it. */
      readonly fix: string;
    }
  | {
      readonly kind: 'unverified';
      /** Why no answer was had. Never a driver message: those name hosts, users and databases. */
      readonly reason: string;
    };

const MIGRATE_FIX =
  'Apply them with `pnpm run db:migrate` (development: it reads DATABASE_MIGRATION_URL, else ' +
  'DATABASE_URL, from .env), or in a deployment run `node apps/api/scripts/migrate.mjs up` from a ' +
  'checkout of this commit with DATABASE_MIGRATION_URL naming the migrating identity ' +
  '(docs/RUNBOOK.md §11.3). Then start the API again.';

const DRIFT_FIX =
  '`migrate.mjs up` refuses this too, so migrating will not fix it. An applied migration is ' +
  'immutable: restore the file from git (or deploy the build the database was migrated by) and write ' +
  'the change as a new migration.';

/**
 * The checksum `migrate.mjs` records, byte for byte: BOM stripped, CRLF collapsed, `sha256:` prefix.
 *
 * A second implementation rather than an import, because the runtime image ships neither
 * `apps/api/scripts/` nor a reason to. That the two agree is not assumed:
 * `test/schema-guard-database.test.ts` migrates an empty database with the real runner and asserts
 * this module finds every row matching, which fails the moment either side changes its rule.
 */
export function migrationChecksum(contents: string): string {
  const normalised = contents.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return `sha256:${createHash('sha256').update(normalised, 'utf8').digest('hex')}`;
}

/** A shipped directory this guard cannot read is a refusal, not a skip. */
export class ShippedMigrationsError extends Error {
  override readonly name = 'ShippedMigrationsError';
}

/**
 * Every migration this build shipped, in apply order.
 *
 * Throws rather than returning an empty list, and an empty directory throws too: a guard that read
 * nothing and compared nothing would pass every database, which is a sweep of nothing reported as
 * a pass. The likeliest way to get there is an image whose prune or COPY stopped matching.
 */
export function readShippedMigrations(dir: string = SHIPPED_MIGRATIONS_DIR): readonly MigrationRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    throw new ShippedMigrationsError(
      `this build's migrations could not be read from ${dir} (${typeof code === 'string' ? code : 'error'}). ` +
        'Without them there is nothing to compare the database with. In an image, Dockerfile.api copies ' +
        'db/migrations into the runtime stage; check that the COPY line is still there.',
    );
  }
  const unordered = names.filter((name) => !FILE_NAME_PATTERN.test(name));
  if (unordered.length > 0) {
    throw new ShippedMigrationsError(
      `${dir} holds file(s) migrate.mjs would refuse to order: ${unordered.join(', ')}. ` +
        'Rename them NNNN_lower_snake_case.sql or move them out.',
    );
  }
  if (names.length === 0) {
    throw new ShippedMigrationsError(
      `${dir} holds no migrations, so this build has nothing to compare the database with — and a ` +
        'comparison against nothing would pass every database.',
    );
  }
  return names.sort().map((version) => ({
    version,
    checksum: migrationChecksum(readFileSync(join(dir, version), 'utf8')),
  }));
}

const shortChecksum = (checksum: string): string => checksum.replace(/^sha256:/, '').slice(0, 12);

function listed(versions: readonly string[]): string {
  const shown = versions.slice(0, 3).join(', ');
  return versions.length > 3 ? `${shown} and ${versions.length - 3} more` : shown;
}

/**
 * The comparison, with no I/O, so every verdict is a unit test.
 *
 * Mirrors `planMigrations` in `migrate.mjs` deliberately — pending, drifted and orphaned are its
 * three categories too — with one difference: an orphan (here, `ahead`) is allowed. The runner
 * refuses one because it is about to change the schema and wants the repository to describe the
 * result; this process changes nothing and is asked only whether it can serve.
 */
export function compareSchema(
  shipped: readonly MigrationRecord[],
  ledger: readonly MigrationRecord[],
): SchemaVerdict {
  if (shipped.length === 0) {
    return {
      kind: 'refused',
      summary: 'this build shipped no migrations to compare the schema with',
      problems: [
        'this build shipped no migrations, so there is nothing to compare the ledger with. A ' +
          'comparison of nothing passes every database, so it is refused rather than reported as a match.',
      ],
      fix: 'Rebuild with db/migrations present; Dockerfile.api copies it into the runtime stage.',
    };
  }

  const recorded = new Map(ledger.map((row) => [row.version, row]));
  const pending: string[] = [];
  const drifted: string[] = [];
  for (const file of shipped) {
    const row = recorded.get(file.version);
    if (row === undefined) {
      pending.push(file.version);
      continue;
    }
    recorded.delete(file.version);
    if (row.checksum !== file.checksum) {
      drifted.push(
        `${file.version}: the ledger recorded ${shortChecksum(row.checksum)}, this build's file hashes ` +
          `to ${shortChecksum(file.checksum)}`,
      );
    }
  }
  const ahead = [...recorded.keys()].sort();

  if (pending.length === 0 && drifted.length === 0) {
    return { kind: 'current', applied: shipped.length, ahead };
  }

  const problems: string[] = [];
  if (drifted.length > 0) {
    problems.push(
      `${drifted.length} applied migration(s) no longer match the file this build shipped: ` +
        drifted.join('; '),
    );
  }
  if (pending.length > 0) {
    problems.push(
      ledger.length === 0
        ? 'prl.schema_migrations is empty: this database has never been migrated, and this build ' +
            `expects ${pending.length} migration(s), ${listed(pending)}`
        : `${pending.length} migration(s) this build expects are not applied: ${pending.join(', ')}`,
    );
    // `migrate.mjs` refuses a pending file that sorts below the highest applied one, so telling
    // somebody to run it without saying so sends them straight into a second refusal.
    const highest = [...ledger.map((row) => row.version)].sort().at(-1);
    const outOfOrder = highest === undefined ? [] : pending.filter((version) => version < highest);
    if (outOfOrder.length > 0 && highest !== undefined) {
      problems.push(
        `${outOfOrder.join(', ')} sort(s) before ${highest}, which is already applied, so ` +
          '`migrate.mjs up` will refuse them as out of order: renumber them to follow it',
      );
    }
    // Served on its own, an ahead ledger is fine. Beside a pending file it is the state switching
    // branches leaves — another branch's 0009 applied, this one's 0010 not — and `up` refuses a
    // ledger row with no file unless told otherwise, so "run db:migrate" alone is a second refusal.
    if (ahead.length > 0) {
      problems.push(
        `the ledger also holds ${ahead.length} migration(s) this build has no file for: ` +
          `${listed(ahead)}. \`migrate.mjs up\` refuses those unless run with --allow-missing; on a ` +
          'development database left by another branch, `pnpm run db:reset --confirm-database <name>` ' +
          'and then `pnpm run db:migrate && pnpm run db:seed` is the clean way back',
      );
    }
  }

  const summary =
    drifted.length > 0
      ? `schema does not match this build: ${drifted.length} applied migration(s) were edited`
      : `schema is behind this build: ${pending.length} pending migration(s) (${listed(pending)}); ` +
        'run pnpm run db:migrate';
  return { kind: 'refused', summary, problems, fix: drifted.length > 0 ? DRIFT_FIX : MIGRATE_FIX };
}

/** The ledger, as the connecting identity sees it. Throws the driver's own error. */
export async function readLedger(sql: Sql): Promise<readonly MigrationRecord[]> {
  return await sql<MigrationRecord[]>`select version, checksum from prl.schema_migrations`;
}

/**
 * "The database answered badly" versus "the database did not answer".
 *
 * Three SQLSTATEs are answers about the ledger itself, and are refusals. Everything else —
 * a refused connection, a deadline, `57P03` while Postgres is still starting — says nothing about
 * the schema, so it leaves the question open rather than guessing in either direction.
 */
export function classifyLedgerFailure(error: unknown): SchemaVerdict {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '42P01' || code === '3F000') {
    return {
      kind: 'refused',
      summary: 'schema is behind this build: prl.schema_migrations does not exist; run pnpm run db:migrate',
      problems: [
        'prl.schema_migrations does not exist: this database has never been migrated (or DATABASE_URL ' +
          'names the wrong database)',
      ],
      fix: MIGRATE_FIX,
    };
  }
  if (code === '42501') {
    return {
      kind: 'refused',
      summary: `schema is behind this build: the ledger is not readable, so ${LEDGER_GRANT_MIGRATION} is not applied`,
      problems: [
        `this identity may not read prl.schema_migrations. ${LEDGER_GRANT_MIGRATION} grants prl_app ` +
          'SELECT on it, so the database is behind at least that migration — or DATABASE_URL names a ' +
          'login role that is not a member of prl_app (docs/RUNBOOK.md §5)',
      ],
      fix: MIGRATE_FIX,
    };
  }
  const named = typeof code === 'string' ? code : error instanceof Error ? error.name : 'error';
  return { kind: 'unverified', reason: `the migration ledger could not be read (${named})` };
}

/** Reads the ledger and compares it. Never throws: every failure is a verdict. */
export async function verifySchema(
  read: () => Promise<readonly MigrationRecord[]>,
  shipped: () => readonly MigrationRecord[],
): Promise<SchemaVerdict> {
  let files: readonly MigrationRecord[];
  try {
    files = shipped();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: 'refused',
      summary: "this build's migrations could not be read",
      problems: [message],
      fix: 'Rebuild with db/migrations present; Dockerfile.api copies it into the runtime stage.',
    };
  }
  let ledger: readonly MigrationRecord[];
  try {
    ledger = await read();
  } catch (error) {
    return classifyLedgerFailure(error);
  }
  return compareSchema(files, ledger);
}

/** The text a refusal at boot prints to stderr, in `ConfigError`'s shape. */
export function describeRefusal(verdict: Extract<SchemaVerdict, { kind: 'refused' }>): string {
  return (
    'Refusing to start: the database schema does not match this build.\n' +
    `${verdict.problems.map((problem) => `  - ${problem}`).join('\n')}\n\n${verdict.fix}`
  );
}

export interface SchemaGateOptions {
  readonly readLedger: () => Promise<readonly MigrationRecord[]>;
  /** Defaults to `readShippedMigrations()`, read once and kept: the file list IS the build. */
  readonly shipped?: () => readonly MigrationRecord[];
  /** How long a readiness probe waits for the ledger before answering "not yet verified". */
  readonly probeDeadlineMs: number;
}

export interface SchemaGate {
  /** Asks now, records the answer, and returns it. Boot calls this once. */
  readonly verify: () => Promise<SchemaVerdict>;
  /** A readiness answer that also requires a verified schema. See the header for when it queries. */
  readonly readiness: (database: DbCheck) => Promise<DbCheck>;
}

export function createSchemaGate(options: SchemaGateOptions): SchemaGate {
  let files: readonly MigrationRecord[] | null = null;
  const shipped = (): readonly MigrationRecord[] => {
    files ??= (options.shipped ?? readShippedMigrations)();
    return files;
  };
  let verified = false;
  let inflight: Promise<SchemaVerdict> | null = null;

  const verify = (): Promise<SchemaVerdict> => {
    // Single-flight: probes that arrive while one verification is outstanding share it, so an
    // instance waiting on a slow database costs it one ledger query, not one per probe.
    inflight ??= verifySchema(options.readLedger, shipped).then((verdict) => {
      inflight = null;
      if (verdict.kind === 'current') verified = true;
      return verdict;
    });
    return inflight;
  };

  const readiness = async (database: DbCheck): Promise<DbCheck> => {
    // `ping()` first, and its answer unchanged when it failed: its latch exists so an outage costs
    // the pool one connection, and asking for the ledger behind a dead `select 1` would spend another.
    if (!database.ok || verified) return database;
    let timer: NodeJS.Timeout | null = null;
    const expiry = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), options.probeDeadlineMs);
      timer.unref();
    });
    try {
      const verdict = await Promise.race([verify(), expiry]);
      if (verdict === null) {
        return {
          ok: false,
          detail: `schema not yet verified: the migration ledger did not answer within ${options.probeDeadlineMs} ms`,
        };
      }
      if (verdict.kind === 'current') return database;
      if (verdict.kind === 'refused') return { ok: false, detail: verdict.summary };
      return { ok: false, detail: `schema not yet verified: ${verdict.reason}` };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  return { verify, readiness };
}
