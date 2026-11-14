/**
 * Refuses to serve a database whose migration ledger (`prl.schema_migrations`, written only by
 * `migrate.mjs`) is behind or has drifted from the migrations this build shipped. Without it the API
 * boots green against a schema one column short and fails archive writes on the missing column.
 * Feature routes are gated too, not only `/ready`, because the staging nginx has no active health
 * checks and keeps routing learners to a degraded API. A refusal found by a probe never exits the
 * process, because a readiness handler that can kill it is a kill switch on a public route.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DbCheck, databaseIdentity, type Sql } from './db.ts';

/**
 * Three steps up from both `src/` and `dist/`, because `tsconfig.json` maps one onto the other.
 * `Dockerfile.api` copies the directory into the runtime image for this path.
 */
export const SHIPPED_MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));

/** `migrate.mjs`'s FILE_NAME_PATTERN. A file it cannot order is one it will not apply. */
const FILE_NAME_PATTERN = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/** The migration that lets the runtime role read the ledger, named in the refusal it prevents. */
export const LEDGER_GRANT_MIGRATION = '0010_schema_migrations_readable.sql';

export interface MigrationRecord {
  readonly version: string;
  readonly checksum: string;
}

export type SchemaVerdict =
  | {
      readonly kind: 'current';
      /** Logged at boot as evidence of a real comparison. */
      readonly applied: number;
      readonly ahead: readonly string[];
    }
  | {
      readonly kind: 'refused';
      readonly summary: string;
      readonly problems: readonly string[];
      readonly fix: string;
    }
  | {
      readonly kind: 'unverified';
      /** Never a driver message, which can name hosts, users and databases. */
      readonly reason: string;
    };

const MIGRATE_FIX =
  'Apply them with `pnpm run db:migrate` (development: it reads DATABASE_MIGRATION_URL, else ' +
  'DATABASE_URL, from .env), or in a deployment run `node apps/api/scripts/migrate.mjs up` from a ' +
  'clone of this commit with DATABASE_MIGRATION_URL naming the migrating identity ' +
  '(docs/RUNBOOK.md §11.3). Then start the API again.';

const DRIFT_FIX =
  '`migrate.mjs up` refuses this too, so migrating will not fix it. An applied migration is ' +
  'immutable: restore the file from git (or deploy the build the database was migrated by) and write ' +
  'the change as a new migration.';

/**
 * The checksum `migrate.mjs` records, byte for byte. Reimplemented because the runtime image does not
 * ship `apps/api/scripts/`.
 */
export function migrationChecksum(contents: string): string {
  const normalised = contents.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return `sha256:${createHash('sha256').update(normalised, 'utf8').digest('hex')}`;
}

export class ShippedMigrationsError extends Error {
  override readonly name = 'ShippedMigrationsError';
}

/** Throws on an unreadable or empty directory, because a comparison against nothing passes every database. */
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
 * No I/O, so every verdict is unit-tested. Behind (a shipped file with no row) and drifted (a checksum
 * mismatch) are refused. Ahead (a row with no file) is allowed, because migrate-then-roll deploys and
 * image rollbacks run an older build against a newer additive schema by design.
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
    // `migrate.mjs` refuses a pending file that sorts below the highest applied one, so say so.
    const highest = [...ledger.map((row) => row.version)].sort().at(-1);
    const outOfOrder = highest === undefined ? [] : pending.filter((version) => version < highest);
    if (outOfOrder.length > 0 && highest !== undefined) {
      problems.push(
        `${outOfOrder.join(', ')} sort(s) before ${highest}, which is already applied, so ` +
          '`migrate.mjs up` will refuse them as out of order: renumber them to follow it',
      );
    }
    // Ahead beside pending is the state branch switching leaves, and `up` refuses it too.
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

export interface LedgerReading {
  /** Compared with `ping()`'s, never shown. */
  readonly identity: string;
  readonly rows: readonly MigrationRecord[];
}

/**
 * One statement for the rows and the identity, because two queries on the shared pool can reach two
 * different databases. Throws the driver's own error.
 */
export async function readLedger(sql: Sql): Promise<LedgerReading> {
  const [row] = await sql<{ identity: string; rows: MigrationRecord[] }[]>`
    select ${databaseIdentity(sql)} as identity,
           coalesce(
             (select json_agg(json_build_object('version', version, 'checksum', checksum))
              from prl.schema_migrations),
             '[]'::json
           ) as rows
  `;
  if (row === undefined) throw new Error('the ledger read returned no row');
  return { identity: row.identity, rows: row.rows };
}

/**
 * A missing ledger or a refused read is the database answering, so it is a refusal. Anything else
 * (a refused connection, a deadline, `57P03`) is unverified. Boot does not refuse that, because an API
 * started during an outage must come up degraded, not crash-loop (`runbooks/db-unavailable.md`).
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

/** Never throws. Every failure is a verdict. */
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

export function describeRefusal(verdict: Extract<SchemaVerdict, { kind: 'refused' }>): string {
  return (
    'Refusing to start: the database schema does not match this build.\n' +
    `${verdict.problems.map((problem) => `  - ${problem}`).join('\n')}\n\n${verdict.fix}`
  );
}

export interface SchemaGateOptions {
  readonly readLedger: () => Promise<LedgerReading>;
  /** Defaults to `readShippedMigrations()`, read once, because the file list is fixed by the build. */
  readonly shipped?: () => readonly MigrationRecord[];
  readonly probeDeadlineMs: number;
  readonly onDatabaseChanged?: () => void;
  /** Not called for the first verdict, which `server.ts` reports itself. */
  readonly onVerdictChanged?: (verdict: SchemaVerdict) => void;
}

export interface SchemaGate {
  readonly verify: () => Promise<SchemaVerdict>;
  readonly readiness: (database: DbCheck) => Promise<DbCheck>;
  /** On every request, so it reads no database and answers from the last verification. */
  readonly admits: () => DbCheck;
}

export function createSchemaGate(options: SchemaGateOptions): SchemaGate {
  let files: readonly MigrationRecord[] | null = null;
  const shipped = (): readonly MigrationRecord[] => {
    files ??= (options.shipped ?? readShippedMigrations)();
    return files;
  };
  /** The database identity a current verdict holds for, or null. */
  let verified: string | null = null;
  let refusal = 'schema not yet verified: no verification has finished';
  let previous: SchemaVerdict | null = null;
  let inflight: Promise<{ verdict: SchemaVerdict; identity: string | null }> | null = null;

  const record = (verdict: SchemaVerdict, identity: string | null): void => {
    verified = verdict.kind === 'current' ? identity : null;
    if (verdict.kind === 'refused') refusal = verdict.summary;
    if (verdict.kind === 'unverified') refusal = `schema not yet verified: ${verdict.reason}`;
    const changed =
      previous !== null &&
      (previous.kind !== verdict.kind ||
        (previous.kind === 'refused' && verdict.kind === 'refused' && previous.summary !== verdict.summary));
    previous = verdict;
    if (changed) options.onVerdictChanged?.(verdict);
  };

  const verifyAt = (): Promise<{ verdict: SchemaVerdict; identity: string | null }> => {
    // Single-flight, so a slow database costs one ledger query, not one per probe.
    inflight ??= (async () => {
      let identity: string | null = null;
      const verdict = await verifySchema(async () => {
        const reading = await options.readLedger();
        identity = reading.identity;
        return reading.rows;
      }, shipped);
      inflight = null;
      record(verdict, identity);
      return { verdict, identity };
    })();
    return inflight;
  };

  const verify = async (): Promise<SchemaVerdict> => (await verifyAt()).verdict;

  const readiness = async (database: DbCheck): Promise<DbCheck> => {
    // Once verified, a probe costs only `ping()`, since a schema can fall behind only when a different
    // database answers. A failed ping is returned as is, so the ledger read spends no second connection.
    if (!database.ok) return database;
    if (verified !== null) {
      if (database.identity === verified) return database;
      // A different database, or one that cannot say. The verdict is dropped before asking again, so
      // feature requests are refused during re-verification. That is the safe direction.
      verified = null;
      refusal = 'schema not yet verified: a different database is answering DATABASE_URL';
      options.onDatabaseChanged?.();
    }
    let timer: NodeJS.Timeout | null = null;
    const expiry = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), options.probeDeadlineMs);
      timer.unref();
    });
    try {
      const outcome = await Promise.race([verifyAt(), expiry]);
      if (outcome === null) {
        return {
          ok: false,
          detail: `schema not yet verified: the migration ledger did not answer within ${options.probeDeadlineMs} ms`,
        };
      }
      const { verdict, identity } = outcome;
      if (verdict.kind === 'current' && identity !== database.identity) {
        // The probe and the ledger read can reach different databases mid-switch. A verdict about
        // another database closes the gate again.
        if (verified === identity) {
          verified = null;
          refusal = 'schema not yet verified: the probe and the migration ledger reached different databases';
        }
        return {
          ok: false,
          detail: 'schema not yet verified: the probe and the migration ledger reached different databases',
        };
      }
      if (verdict.kind === 'current') return database;
      if (verdict.kind === 'refused') return { ok: false, detail: verdict.summary };
      return { ok: false, detail: `schema not yet verified: ${verdict.reason}` };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  const admits = (): DbCheck => (verified !== null ? { ok: true } : { ok: false, detail: refusal });

  return { verify, readiness, admits };
}
