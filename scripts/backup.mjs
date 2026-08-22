#!/usr/bin/env node
/**
 * backup.mjs — scheduled, encrypted, verifiable PostgreSQL backups for Poker Risk Lab.
 *
 * This is what `pnpm run backup` runs. Subcommands:
 *
 *     pnpm run backup create      dump, encrypt, checksum, sign a manifest
 *     pnpm run backup verify      prove an archive is intact, and (--deep) restorable
 *     pnpm run backup restore     restore into a NAMED target database
 *     pnpm run backup list        inventory, with retention class and integrity state
 *     pnpm run backup prune       apply the retention policy
 *     pnpm run backup keygen      print a fresh 32-byte archive key
 *
 * ## The defect this exists for
 *
 * docs/RUNBOOK.md §11.4 documents dump-and-restore by hand, in detail, including four
 * traps that each cost a rehearsal to learn. What it documents is a **procedure a human
 * types**. Nothing in the repository ran it, nothing scheduled it, nothing checked that
 * yesterday's dump was still readable, and its own closing sentence said so: "No gate
 * enforces any of this … nothing in the repository restores a dump."
 *
 * Three concrete consequences, each of which this file closes:
 *
 *  1. **A plain `pg_dump` file is a full copy of every learner's account.** Display names,
 *     lesson progress, hand history, session token *hashes*, keyed IP hashes. Sitting on a
 *     backup host or an object store, unencrypted, it is the single highest-value artefact
 *     this system produces — higher than the live database, because the live database is
 *     behind an application that enforces authorisation and the dump is behind nothing.
 *     Worse, §11.4 also tells you to keep `pg_dumpall --globals-only` beside it, and that
 *     file contains the **SCRAM verifiers of `prl_api` and `prl_deployer`**. So the
 *     documented backup set was a credential store in plain text. Everything this script
 *     writes is AES-256-GCM encrypted before it touches the disk.
 *  2. **A checksum is not a restore.** A sha256 sidecar proves the bytes did not rot. It
 *     says nothing about whether `pg_restore` can read them — a dump truncated by a full
 *     disk hashes perfectly, every time, forever. `verify` therefore has four layers and
 *     labels which claim each one supports (see `commandVerify`).
 *  3. **Nothing produced the globals dump at all.** There was no command for it. `create`
 *     takes it every time, encrypted, and refuses to be quiet about skipping it.
 *
 * ## What this does NOT do, stated plainly
 *
 *  * **No point-in-time recovery.** There is no WAL archiving here. The RPO is therefore
 *    the schedule interval and nothing better — 24 hours with the shipped timer. Adding
 *    `archive_command` and a base backup would take it to minutes; that is a change to the
 *    database deployment, not to this script, and it is deliberately out of scope. See
 *    docs/production/disaster-recovery.md.
 *  * **It does not back up live table state, because live table state is not durable.**
 *    ADR 0001 puts the authoritative `HandState` in the API process's memory. A crash
 *    mid-hand loses that hand. No backup tool can recover it, and this one does not pretend
 *    to. Completed hands are archived to PostgreSQL and are covered.
 *  * **It does not prove the application works.** `verify --deep` proves `pg_restore`
 *    accepts the archive and the row census survives. Proving the API boots against the
 *    restored database, answers `/ready`, and still refuses one learner's room to another
 *    is a drill with commands and measured timings in docs/production/backup-restore.md.
 *  * **It is not a secrets manager.** See the key-management note below, which is honest
 *    about exactly what an environment variable does and does not buy.
 *
 * ## Key management, without the comfortable version
 *
 * The archive key is 32 bytes of key material read from `PRL_BACKUP_KEY` (base64url, base64
 * or hex) or from a file named by `--key-file`. There is deliberately **no `--key` flag**:
 * an argument is visible in `ps`, in the shell history and in any process listing the host
 * ships to a log collector.
 *
 * What that protects against: **an attacker who obtains the archive but not the machine.**
 * A stolen object-store bucket, a copied backup volume, a decommissioned disk, a snapshot
 * shared with the wrong account, a misdirected file transfer, a backup host restored from
 * its own backup by someone who should not have it. That is the realistic threat for
 * offsite backups and it is the one this closes.
 *
 * What it does NOT protect against, exactly:
 *
 *  * Anyone who can read the environment of the backup process — `/proc/<pid>/environ`, a
 *    core dump, `docker inspect` on a container given the variable, a CI job log that
 *    echoes its environment, an `EnvironmentFile` readable by more than root.
 *  * Anyone with code execution on the backup host at the moment a backup runs.
 *  * A compromised source database. Encryption at rest protects the copy; it cannot make a
 *    dump of poisoned data good.
 *  * Rotation and revocation. One static key encrypts every archive it is used for. There
 *    is no per-archive escrow, no key hierarchy you can revoke a branch of, and no audit
 *    trail of who decrypted what. Getting those means a KMS or an HSM holding a root key
 *    and this script asking it to unwrap a per-archive data key. The format has room for
 *    that — `encryption.keyId` in the manifest exists so a future envelope scheme can say
 *    which root key an archive belongs to — and it is not implemented.
 *  * Losing the key. There is no recovery. An archive whose key is gone is noise. Escrow
 *    the key somewhere that is not the backup host, and test the escrow.
 *
 * The key material is stretched per archive and per payload with HKDF-SHA-256 over a fresh
 * random 32-byte salt, so the database dump and the globals dump in one backup are
 * encrypted under different derived keys, and no two archives share a key even though they
 * share key material.
 *
 * ## The container archive format, and why it is framed rather than one AEAD stream
 *
 * A single `createCipheriv` over the whole dump would be simpler, and it has a property
 * that is unacceptable here: the GCM tag arrives at the *end*, so a streaming restore would
 * have to feed unauthenticated plaintext to `pg_restore` and only discover the forgery
 * after `pg_restore` had already executed it. Restoring attacker-chosen SQL and then saying
 * "the tag was wrong" is not integrity.
 *
 * So the payload is a sequence of independently sealed frames (`CHUNK_BYTES` of plaintext
 * each), and `restore` streams frame by frame: nothing reaches `pg_restore` that has not
 * already had its tag checked. Each frame's nonce is `noncePrefix || counter` and each
 * frame's AAD is `sha256(header bytes) || counter || finalFlag`, which binds every frame to
 * this exact header and to its position. Reordering, splicing frames between archives,
 * dropping the tail, or swapping the header all fail the tag rather than producing
 * plausible SQL. The stream ends with an empty final frame, so truncation is detectable —
 * without it, "the file just stops" is indistinguishable from "the file is complete".
 *
 * The cost, stated: 20 bytes of overhead per megabyte, and a format only this script reads.
 * `openssl enc` will not open it. That is why `restore` and `verify` are subcommands here
 * rather than a paragraph telling an operator to pipe things together at 3am.
 *
 * ## Why the manifest is signed and not merely written
 *
 * The manifest holds the checksums. An attacker who can corrupt an archive on the backup
 * host can equally rewrite a plain-JSON checksum to match — "the checksum matched" then
 * means nothing. So the manifest carries an HMAC-SHA-256 over its canonical form under a
 * key derived from the same material, and `verify` checks that first. It is unencrypted on
 * purpose: an operator has to be able to read what an archive *is* without the key, and
 * what it reveals is metadata (database name, timestamps, sizes, and per-table row counts)
 * rather than any row of any table.
 *
 * Usage:
 *   node scripts/backup.mjs <command> [options]   (see --help)
 *
 * Exit codes: 0 success, 1 any failure or refusal, 0 for --help.
 */

import { spawn } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);

/** Thrown for every refusal and every operator-facing failure; the message is the reason. */
export class BackupError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'BackupError';
    this.detail = detail ?? null;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const COMMANDS = ['create', 'verify', 'restore', 'list', 'prune', 'keygen'];

export const DEFAULTS = {
  /**
   * Deliberately NOT inside the repository.
   *
   * A default of `./backups` puts a full, if encrypted, copy of every learner's account one
   * `git add -A` away from a public remote, in a repository whose .gitignore this script is
   * not allowed to edit. `/var/backups` is where a Debian host already keeps this kind of
   * thing, and it is the path the shipped systemd unit uses, so the documented production
   * layout and the default agree. On a developer machine it will not be writable, and the
   * error names both ways to change it rather than silently falling back to somewhere worse.
   */
  dir: '/var/backups/poker-risk-lab',
  /** The maintenance database `restore` connects to in order to CREATE or DROP another one. */
  maintenanceDatabase: 'postgres',
  /** Retention, in whole backups. The reasoning for these three numbers is in
   * docs/production/backup-restore.md; changing them here without changing that is how a
   * retention policy becomes folklore. */
  daily: 7,
  weekly: 4,
  monthly: 6,
};

/**
 * Plaintext bytes per sealed frame.
 *
 * 1 MiB is a compromise. Smaller frames mean more tags (20 bytes each) and more cipher
 * setups; larger frames mean more plaintext buffered in memory during a streaming restore
 * and a coarser truncation granularity. At 1 MiB the overhead is 0.002% and a restore holds
 * at most one megabyte of decrypted dump in memory at a time.
 */
export const CHUNK_BYTES = 1024 * 1024;

const MAGIC = Buffer.from('PRLBAK1\n', 'ascii');
const FORMAT = 'prl-backup/1';
const TAG_BYTES = 16;
const NONCE_PREFIX_BYTES = 4;
const NONCE_BYTES = 12;
const SALT_BYTES = 32;
const KEY_BYTES = 32;
/**
 * Read-side ceiling on a declared frame length. Without it a corrupted or hostile length
 * prefix makes this process allocate whatever number is in those four bytes — up to 4 GiB —
 * before a single tag has been checked. Generous enough that a future larger CHUNK_BYTES
 * still opens old archives.
 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** Same idea for the header: a plausible header is a few hundred bytes. */
const MAX_HEADER_BYTES = 64 * 1024;

/** Files are created 0600 and directories 0700: a backup readable by `other` is not a backup. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const HELP = `
${bold('pnpm run backup')} — encrypted PostgreSQL backups, and a restore you can prove

  ${bold('Commands')}
    create        pg_dump -Fc + pg_dumpall --globals-only, encrypted, checksummed, signed
    verify        integrity in four layers; --deep restores into a scratch database
    restore       restore into a NAMED target database (never over the live one by default)
    list          every archive, its retention class and its integrity state
    prune         apply the retention policy (prints a plan; --apply deletes)
    keygen        print a fresh 32-byte archive key

  ${bold('Common options')}
    --dir <path>        archive directory        (default ${DEFAULTS.dir}, or PRL_BACKUP_DIR)
    --url <conn>        source connection string (default: DATABASE_URL)
    --container <name>  run pg_dump/pg_restore/psql inside this docker container
    --key-file <path>   32-byte key material     (default: PRL_BACKUP_KEY)
    --id <archive-id>   which archive to act on  (default: the newest)
    --json              machine-readable output where a command offers it
    -q, --quiet         only the verdict
    -h, --help          this text

  ${bold('create')}
    --no-globals        skip pg_dumpall --globals-only. It carries the login roles' SCRAM
                        verifiers, which is why it is encrypted and why skipping it is a
                        flag rather than the default: without it a full-cluster rebuild
                        cannot restore the roles the API logs in as.

  ${bold('verify')}
    --deep              additionally restore into a scratch database and compare the row
                        census, then drop it. This is the only layer that proves the
                        archive is restorable rather than merely intact.
    --all               verify every archive in the directory, not just one
    --target <db>       scratch database name for --deep (default: a timestamped name)

  ${bold('restore')}
    --target <db>       REQUIRED. The database to restore into.
    --drop-existing     the target already exists: drop and recreate it. Destructive.
    --overwrite-live-database
                        the target is the database DATABASE_URL points at. Required in
                        addition to --drop-existing to restore over the live database.
    --yes-i-am-restoring-production
                        required in addition when NODE_ENV=production.
    --with-globals      apply the encrypted globals dump first. Cluster-wide: it changes
                        roles every other database on this cluster shares.
    --maintenance-database <db>
                        where to connect to CREATE/DROP the target (default ${DEFAULTS.maintenanceDatabase})

  ${bold('prune')}
    --daily <n>         (default ${DEFAULTS.daily})    --weekly <n>  (default ${DEFAULTS.weekly})
    --monthly <n>       (default ${DEFAULTS.monthly})
    --apply             actually delete. Without it, prune prints the plan and deletes nothing.

  Key material comes from PRL_BACKUP_KEY or --key-file. There is no --key flag on purpose:
  a key in argv is visible in ps and in shell history.

  Exit codes: 0 success, 1 any failure or refusal, 0 for --help.
`;

export function parseArgs(argv) {
  const options = {
    command: null,
    help: false,
    quiet: false,
    json: false,
    dir: null,
    url: null,
    container: null,
    keyFile: null,
    id: null,
    target: null,
    maintenanceDatabase: DEFAULTS.maintenanceDatabase,
    globals: true,
    deep: false,
    all: false,
    dropExisting: false,
    overwriteLive: false,
    productionAcknowledged: false,
    withGlobals: false,
    apply: false,
    daily: DEFAULTS.daily,
    weekly: DEFAULTS.weekly,
    monthly: DEFAULTS.monthly,
  };

  let index = 0;
  // The subcommand is the first non-option argument, and only the first: `backup create
  // restore` is a typo, not a request to do both, and it is caught below as an unknown
  // option rather than silently running one of them.
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    options.command = argv[0];
    index = 1;
  }

  for (; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new BackupError(`${arg} needs a value`);
      index += 1;
      return value;
    };
    // `pnpm run backup create -- --dir /x` forwards the `--` itself; absorb it so the
    // conventional invocation is not rejected as an unknown option.
    if (arg === '--') continue;
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-q':
      case '--quiet':
        options.quiet = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--dir':
        options.dir = next();
        break;
      case '--url':
        options.url = next();
        break;
      case '--container':
        options.container = next();
        break;
      case '--key-file':
        options.keyFile = next();
        break;
      case '--id':
        options.id = next();
        break;
      case '--target':
        options.target = next();
        break;
      case '--maintenance-database':
        options.maintenanceDatabase = next();
        break;
      case '--no-globals':
        options.globals = false;
        break;
      case '--deep':
        options.deep = true;
        break;
      case '--all':
        options.all = true;
        break;
      case '--drop-existing':
        options.dropExisting = true;
        break;
      case '--overwrite-live-database':
        options.overwriteLive = true;
        break;
      case '--yes-i-am-restoring-production':
        options.productionAcknowledged = true;
        break;
      case '--with-globals':
        options.withGlobals = true;
        break;
      case '--apply':
        options.apply = true;
        break;
      case '--daily':
        options.daily = retentionCount('--daily', next());
        break;
      case '--weekly':
        options.weekly = retentionCount('--weekly', next());
        break;
      case '--monthly':
        options.monthly = retentionCount('--monthly', next());
        break;
      default:
        throw new BackupError(`unknown option ${arg} (try --help)`);
    }
  }

  if (options.command !== null && !COMMANDS.includes(options.command)) {
    throw new BackupError(`unknown command ${options.command} (expected one of: ${COMMANDS.join(', ')})`);
  }
  return options;
}

function retentionCount(flag, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new BackupError(`${flag} must be a whole number of backups to keep, not ${raw}`);
  }
  // A four-figure retention is a typo, not a policy: 9999 dailies is 27 years of archives on
  // a disk sized for weeks. Refusing here is cheaper than discovering it when prune keeps
  // everything and the volume fills.
  if (value > 365) throw new BackupError(`${flag} of ${value} is implausible; the ceiling is 365`);
  return value;
}

// ---------------------------------------------------------------------------
// Configuration: flag > environment > default
// ---------------------------------------------------------------------------

export function resolveDirectory(env, flag) {
  if (flag !== null && flag !== undefined) return { path: resolve(flag), source: '--dir' };
  const fromEnv = env['PRL_BACKUP_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return { path: resolve(fromEnv), source: 'PRL_BACKUP_DIR' };
  return { path: DEFAULTS.dir, source: 'default' };
}

/**
 * The source connection, parsed once so every tool invocation agrees about it.
 *
 * The password is carried in the returned object and never printed, never put in argv, and
 * never written to a manifest. It reaches the child process through PGPASSWORD in its
 * environment, which is the one channel `pg_dump` offers that is not a file or a command
 * line.
 */
export function resolveConnection(env, flag) {
  const raw = flag ?? env['DATABASE_URL'];
  if (raw === undefined || raw === '') {
    throw new BackupError('no source connection: set DATABASE_URL or pass --url');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BackupError('--url / DATABASE_URL is not a parseable connection string');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (database === '') throw new BackupError('the connection string names no database');
  return {
    host: parsed.hostname === '' ? '127.0.0.1' : parsed.hostname,
    port: parsed.port === '' ? 5432 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    /** Printable, password-free. Everything this script logs about the target uses this. */
    describe() {
      return `${this.user}@${this.host}:${this.port}/${this.database}`;
    },
  };
}

/**
 * The same, but `null` when nothing names a database at all.
 *
 * A malformed connection string still throws: a typo in DATABASE_URL that silently became
 * "no database configured" would turn `verify --deep` into `verify`, which is the difference
 * between proving an archive restorable and proving it merely intact.
 */
export function resolveOptionalConnection(env, flag) {
  const raw = flag ?? env['DATABASE_URL'];
  if (raw === undefined || raw === '') return null;
  return resolveConnection(env, flag);
}

/**
 * Reads the 32 bytes of key material.
 *
 * Accepts base64url, base64 or hex, decided by shape rather than by a flag: an operator
 * pasting a key out of a secret manager should not also have to tell us which encoding that
 * manager chose. Anything that does not decode to exactly 32 bytes is refused with the
 * length it actually got, because "invalid key" sends people looking in the wrong place.
 */
export function decodeKeyMaterial(text, origin) {
  const trimmed = text.trim();
  if (trimmed === '') throw new BackupError(`${origin} is empty`);
  let bytes;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) bytes = Buffer.from(trimmed, 'hex');
  else if (/^[A-Za-z0-9_-]+$/.test(trimmed)) bytes = Buffer.from(trimmed, 'base64url');
  else if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) bytes = Buffer.from(trimmed, 'base64');
  else throw new BackupError(`${origin} is not hex, base64 or base64url`);
  if (bytes.length !== KEY_BYTES) {
    throw new BackupError(
      `${origin} decodes to ${bytes.length} bytes; ${KEY_BYTES} are required`,
      'generate one with `pnpm run backup keygen`',
    );
  }
  return bytes;
}

async function resolveKey(env, keyFile) {
  if (keyFile !== null && keyFile !== undefined) {
    let text;
    try {
      text = await readFile(keyFile, 'utf8');
    } catch (err) {
      throw new BackupError(`could not read --key-file ${keyFile}: ${err.message}`);
    }
    return decodeKeyMaterial(text, `--key-file ${keyFile}`);
  }
  const fromEnv = env['PRL_BACKUP_KEY'];
  if (fromEnv === undefined || fromEnv === '') {
    throw new BackupError(
      'no archive key: set PRL_BACKUP_KEY or pass --key-file',
      'generate one with `pnpm run backup keygen`, and escrow it somewhere that is not the backup host',
    );
  }
  return decodeKeyMaterial(fromEnv, 'PRL_BACKUP_KEY');
}

// ---------------------------------------------------------------------------
// Canonical JSON and the manifest signature
// ---------------------------------------------------------------------------

/**
 * JSON with object keys in a fixed order.
 *
 * `JSON.stringify` preserves insertion order, so two manifests with identical content but
 * different construction order would serialise differently and produce different HMACs. The
 * signature has to be over a canonical form or verification depends on how the object
 * happened to be built.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

const subKey = (material, salt, info) =>
  Buffer.from(hkdfSync('sha256', material, salt, Buffer.from(info, 'utf8'), KEY_BYTES));

export function manifestSignature(material, salt, body) {
  const key = subKey(material, salt, `${FORMAT} manifest ${body.id}`);
  return createHmac('sha256', key).update(canonicalJson(body), 'utf8').digest('hex');
}

/**
 * True only when the manifest was signed by this key material.
 *
 * `timingSafeEqual` rather than `===`: a manifest signature is checked against an attacker-
 * supplied value, and while a timing oracle on an offline file is a stretch, writing the
 * comparison the other way teaches the next person the wrong reflex.
 */
export function manifestSignatureValid(material, manifest) {
  const { hmac, ...body } = manifest;
  if (typeof hmac !== 'string' || !/^[0-9a-f]{64}$/.test(hmac)) return false;
  let expected;
  try {
    expected = manifestSignature(material, Buffer.from(body.encryption.salt, 'base64'), body);
  } catch {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hmac, 'hex'));
}

// ---------------------------------------------------------------------------
// The framed AEAD container
// ---------------------------------------------------------------------------

/**
 * The plaintext header that opens every archive file.
 *
 * Exported because scripts/backup.test.mjs seals and opens payloads directly: a container
 * format whose only construction path is `create` can only be tested by taking a backup, and a
 * test that needs a database is a test that does not run.
 *
 * Everything here is readable without the key, on purpose — an operator has to be able to tell
 * what a file is before deciding whether to go and find the key for it — and everything here is
 * covered by each frame's AAD, so none of it can be edited without every tag failing.
 */
export function archiveHeader({ archive, payload, salt, noncePrefix }) {
  return {
    format: FORMAT,
    cipher: 'aes-256-gcm',
    kdf: 'hkdf-sha256',
    archive,
    payload,
    salt: salt.toString('base64'),
    // One random prefix per archive, with a per-frame counter after it. The (key, nonce) pair
    // is unique because the derived key is unique per archive AND per payload, so the counter
    // alone would in fact be sufficient; the random prefix costs four bytes and removes any
    // dependence on that argument staying true if the KDF info string ever changes.
    noncePrefix: noncePrefix.toString('base64'),
    chunkBytes: CHUNK_BYTES,
  };
}

function serialiseHeader(header) {
  const json = Buffer.from(canonicalJson(header), 'utf8');
  if (json.length > MAX_HEADER_BYTES) throw new BackupError('archive header is implausibly large');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length, 0);
  return Buffer.concat([MAGIC, length, json]);
}

const headerBinding = (prologue) => createHash('sha256').update(prologue).digest();

function frameNonce(prefix, index) {
  const nonce = Buffer.alloc(NONCE_BYTES);
  prefix.copy(nonce, 0);
  nonce.writeBigUInt64BE(BigInt(index), NONCE_PREFIX_BYTES);
  return nonce;
}

/**
 * Additional authenticated data for one frame: the header it belongs to, its position, and
 * whether it is the terminator. This is what makes frames non-interchangeable — a frame
 * lifted from another archive, or moved within this one, fails its tag.
 */
function frameAad(binding, index, final) {
  const suffix = Buffer.alloc(9);
  suffix.writeBigUInt64BE(BigInt(index), 0);
  suffix.writeUInt8(final ? 1 : 0, 8);
  return Buffer.concat([binding, suffix]);
}

function sealFrame(key, prefix, binding, index, plain, final) {
  const cipher = createCipheriv('aes-256-gcm', key, frameNonce(prefix, index));
  cipher.setAAD(frameAad(binding, index, final));
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([length, body]);
}

function openFrame(key, prefix, binding, index, body, final) {
  const tag = body.subarray(body.length - TAG_BYTES);
  const ciphertext = body.subarray(0, body.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, frameNonce(prefix, index));
  decipher.setAAD(frameAad(binding, index, final));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypts an async iterable of Buffers into the framed container.
 *
 * Yields the finished bytes, and reports both digests through `report` — the plaintext
 * digest so a restore can prove it reproduced exactly what was dumped, the ciphertext digest
 * so `verify` can detect bit rot without holding the key.
 */
export async function* encryptFrames(source, { material, header, report }) {
  const prologue = serialiseHeader(header);
  const binding = headerBinding(prologue);
  const prefix = Buffer.from(header.noncePrefix, 'base64');
  const key = subKey(
    material,
    Buffer.from(header.salt, 'base64'),
    `${FORMAT} ${header.payload} ${header.archive}`,
  );
  const plainHash = createHash('sha256');
  const cipherHash = createHash('sha256');
  let plainBytes = 0;
  let cipherBytes = 0;

  const emit = (frame) => {
    cipherHash.update(frame);
    cipherBytes += frame.length;
    return frame;
  };

  cipherHash.update(prologue);
  cipherBytes += prologue.length;
  yield prologue;

  let index = 0;
  let pending = Buffer.alloc(0);
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    plainHash.update(bytes);
    plainBytes += bytes.length;
    pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
    while (pending.length >= CHUNK_BYTES) {
      yield emit(sealFrame(key, prefix, binding, index, pending.subarray(0, CHUNK_BYTES), false));
      pending = pending.subarray(CHUNK_BYTES);
      index += 1;
    }
  }
  if (pending.length > 0) {
    yield emit(sealFrame(key, prefix, binding, index, pending, false));
    index += 1;
  }
  // The terminator. Empty plaintext, final flag set, its own index — so a truncated stream
  // is missing something that cannot be manufactured without the key.
  yield emit(sealFrame(key, prefix, binding, index, Buffer.alloc(0), true));

  report({
    plainSha256: plainHash.digest('hex'),
    cipherSha256: cipherHash.digest('hex'),
    plainBytes,
    cipherBytes,
    frames: index + 1,
  });
}

/** A pull reader over an iterable of Buffers, synchronous or asynchronous. */
function byteReader(source) {
  // Both protocols, for the same reason `for await` accepts both: the production caller hands
  // this a `fs.ReadStream` (async), and a caller with the bytes already in hand — a test, or a
  // future in-memory verification path — hands it an array. Reaching only for
  // Symbol.asyncIterator turns the second case into
  // `TypeError: source[Symbol.asyncIterator] is not a function`, which reads like a bug in the
  // archive rather than in the call.
  const iterator =
    typeof source[Symbol.asyncIterator] === 'function'
      ? source[Symbol.asyncIterator]()
      : source[Symbol.iterator]();
  let buffered = Buffer.alloc(0);
  let done = false;
  return {
    /** Exactly `count` bytes, or null at a clean end of stream when nothing was buffered. */
    async take(count, { optional = false } = {}) {
      while (buffered.length < count && !done) {
        const next = await iterator.next();
        if (next.done === true) {
          done = true;
          break;
        }
        const bytes = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
        buffered = buffered.length === 0 ? bytes : Buffer.concat([buffered, bytes]);
      }
      if (buffered.length < count) {
        if (optional && buffered.length === 0) return null;
        throw new BackupError(
          `the archive ends mid-structure: wanted ${count} bytes, ${buffered.length} remain`,
          'the file is truncated — a partial write, a full disk, or an interrupted copy',
        );
      }
      const out = buffered.subarray(0, count);
      buffered = buffered.subarray(count);
      return out;
    },
  };
}

/**
 * Decrypts the framed container, yielding plaintext frame by frame.
 *
 * Every yielded byte has already had its tag checked, which is the whole point: a consumer
 * may execute what this yields. Ends by refusing a stream that never presented a terminator.
 */
export async function* decryptFrames(source, { material, expectHeader } = {}) {
  const reader = byteReader(source);
  const magic = await reader.take(MAGIC.length);
  if (!magic.equals(MAGIC)) {
    throw new BackupError('not a Poker Risk Lab archive', 'the magic bytes do not match');
  }
  const headerLength = (await reader.take(4)).readUInt32BE(0);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
    throw new BackupError(`archive header length ${headerLength} is out of range`);
  }
  const headerJson = await reader.take(headerLength);
  let header;
  try {
    header = JSON.parse(headerJson.toString('utf8'));
  } catch {
    throw new BackupError('the archive header is not valid JSON');
  }
  if (header.format !== FORMAT) {
    throw new BackupError(`unknown archive format ${String(header.format)}; this build reads ${FORMAT}`);
  }
  if (header.cipher !== 'aes-256-gcm') {
    throw new BackupError(`unknown cipher ${String(header.cipher)}`);
  }
  if (expectHeader !== undefined && expectHeader !== null) {
    // The manifest says which archive this file is. If the file's own header disagrees,
    // somebody has swapped files between backups and the checksums would still "match"
    // whichever manifest they were checked against.
    if (header.archive !== expectHeader.archive || header.payload !== expectHeader.payload) {
      throw new BackupError(
        `archive header says ${header.archive}/${header.payload}, manifest says ` +
          `${expectHeader.archive}/${expectHeader.payload}`,
      );
    }
  }

  const lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32BE(headerLength, 0);
  const binding = headerBinding(Buffer.concat([MAGIC, lengthBytes, headerJson]));
  const prefix = Buffer.from(header.noncePrefix, 'base64');
  const key = subKey(
    material,
    Buffer.from(header.salt, 'base64'),
    `${FORMAT} ${header.payload} ${header.archive}`,
  );

  let index = 0;
  let sawTerminator = false;
  for (;;) {
    const prefixBytes = await reader.take(4, { optional: true });
    if (prefixBytes === null) break;
    const bodyLength = prefixBytes.readUInt32BE(0);
    if (bodyLength < TAG_BYTES || bodyLength > MAX_FRAME_BYTES) {
      throw new BackupError(`frame ${index} declares an impossible length of ${bodyLength} bytes`);
    }
    const body = await reader.take(bodyLength);
    // An empty ciphertext IS the terminator; the flag is in the AAD, so this has to be
    // derivable from the length before the tag can be checked.
    const final = bodyLength === TAG_BYTES;
    if (sawTerminator) {
      throw new BackupError(
        'the archive continues past its terminator',
        'frames were appended after the end',
      );
    }
    let plain;
    try {
      plain = openFrame(key, prefix, binding, index, body, final);
    } catch {
      throw new BackupError(
        `frame ${index} failed authentication`,
        'wrong key, or the archive has been altered or corrupted',
      );
    }
    if (final) sawTerminator = true;
    else yield plain;
    index += 1;
  }
  if (!sawTerminator) {
    throw new BackupError(
      'the archive has no terminator frame',
      'it is truncated: the tail is missing, and a checksum over what is left would still match itself',
    );
  }
}

// ---------------------------------------------------------------------------
// Running the PostgreSQL tools
// ---------------------------------------------------------------------------

/**
 * Builds the argv and environment for one PostgreSQL client invocation.
 *
 * Two shapes, one interface:
 *
 *  * **On PATH** (production): the tools run on the backup host. `pg_dump` must be at least
 *    the server's major version, which is the operator's problem and is checked at the start
 *    of `create`.
 *  * **Inside a container** (`--container`): the tools run in the database container itself,
 *    which is how the compose developer stack works — there is no local `pg_dump` there, and
 *    the one in the container is by construction the right version. In that shape the
 *    host/port from DATABASE_URL are the wrong coordinates (they describe the published
 *    port, seen from outside), so the connection goes over the container's unix socket by
 *    omitting --host entirely. That is the same path the compose healthcheck uses.
 *
 * The password travels as PGPASSWORD in the child's environment. `docker exec -e PGPASSWORD`
 * with no `=value` forwards it from this process rather than placing it in argv, so it never
 * appears in `ps` on the host either.
 */
function toolCommand(tool, toolArgs, ctx, bare) {
  const connection = [];
  // `bare` exists for one real constraint rather than for tidiness: pg_dump 16 refuses
  // `--version` in the company of any other option — `pg_dump --username poker --version`
  // exits 1 with nothing but "Try pg_dump --help", which is a spectacularly unhelpful way to
  // fail a nightly backup at its first step. A version probe therefore carries no connection
  // flags at all.
  if (!bare) {
    if (ctx.container === null) {
      connection.push('--host', ctx.connection.host, '--port', String(ctx.connection.port));
    }
    connection.push('--username', ctx.connection.user);
  }
  const full = [...connection, ...toolArgs];
  if (ctx.container === null) return { command: tool, args: full };
  return { command: 'docker', args: ['exec', '-i', '-e', 'PGPASSWORD', ctx.container, tool, ...full] };
}

function startTool(tool, toolArgs, ctx, { stdin = 'pipe', stdout = 'pipe', bare = false } = {}) {
  const { command, args } = toolCommand(tool, toolArgs, ctx, bare);
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    stdio: [stdin, stdout, 'pipe'],
    env: {
      ...process.env,
      // `verify` without --deep runs `pg_restore --list`, which opens no connection, and is
      // allowed to run with no connection configured at all. Spreading a conditional rather
      // than reading `ctx.connection.password` unconditionally is what keeps that case from
      // dying on a TypeError one line before it would have succeeded.
      ...(ctx.connection === null ? {} : { PGPASSWORD: ctx.connection.password }),
      // A hung connect should fail the backup, not hold the timer unit open until somebody
      // notices. Ten seconds is far longer than a healthy local or in-VPC connect.
      PGCONNECT_TIMEOUT: '10',
    },
  });
  const stderrChunks = [];
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
  child.on('error', (err) => {
    child.spawnFailure = err;
  });
  const exited = new Promise((resolveExit) => {
    child.on('close', (code, signal) => resolveExit({ code, signal }));
    child.on('error', () => resolveExit({ code: null, signal: null }));
  });
  return {
    child,
    stdout: child.stdout,
    stdin: child.stdin,
    async settle() {
      const { code, signal } = await exited;
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (child.spawnFailure !== undefined) {
        const missing = child.spawnFailure.code === 'ENOENT';
        throw new BackupError(
          missing
            ? `${command} is not on PATH`
            : `${command} could not be started: ${child.spawnFailure.message}`,
          missing && ctx.container === null
            ? 'install the PostgreSQL 16 client tools, or pass --container to run them inside the database container'
            : null,
        );
      }
      if (code !== 0) {
        throw new BackupError(
          `${tool} exited ${code === null ? `on signal ${signal}` : String(code)}`,
          stderr === '' ? null : stderr.split('\n').slice(-6).join('\n'),
        );
      }
      return stderr;
    },
  };
}

/** Runs a tool that produces a modest amount of stdout, and returns it. */
async function captureTool(tool, toolArgs, ctx, input, bare = false) {
  const run = startTool(tool, toolArgs, ctx, { stdin: input === undefined ? 'ignore' : 'pipe', bare });
  const chunks = [];
  run.stdout.on('data', (chunk) => chunks.push(chunk));
  if (input !== undefined) {
    run.stdin.end(input);
  }
  await run.settle();
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Streams plaintext into a started tool's stdin, and tolerates the tool closing that pipe.
 *
 * The tolerance is not defensive padding; it is required by `pg_restore --list`, which reads
 * the table of contents at the head of a custom-format archive and then exits, closing stdin
 * while there is still a great deal of archive to write. Measured: a 153 KiB archive finished
 * writing before pg_restore got round to exiting and passed; the 287.8 MiB archive failed
 * `4. pg_restore cannot read the archive: write EPIPE` on an archive that was, in fact,
 * perfectly readable. A verification that gets less reliable as the database gets bigger is
 * worse than none, because it passes for exactly as long as nobody depends on it.
 *
 * A broken pipe therefore is not the verdict. `settle()` is: the tool's own exit code decides,
 * and a tool that failed reports its stderr rather than our write error.
 */
async function feedTool(run, source) {
  try {
    await pipeline(source, run.stdin);
  } catch (err) {
    const premature =
      err?.code === 'EPIPE' ||
      err?.code === 'ERR_STREAM_DESTROYED' ||
      err?.code === 'ERR_STREAM_PREMATURE_CLOSE';
    if (!premature) throw err;
  }
  await run.settle();
}

/** psql with the flags that make it a scripting tool rather than an interactive one. */
const psqlArgs = (database, extra = []) => [
  '--dbname',
  database,
  '--no-psqlrc',
  '--tuples-only',
  '--no-align',
  '--field-separator',
  '|',
  '--set',
  'ON_ERROR_STOP=1',
  ...extra,
];

async function psqlScalar(ctx, database, sql) {
  const out = await captureTool('psql', psqlArgs(database), ctx, sql);
  return out.trim();
}

/**
 * Row counts for every base table in schema `prl`.
 *
 * `query_to_xml` is the trick that turns "count every table" into one round trip instead of
 * one per table. The alternative — reltuples from pg_class — is an estimate, and an estimate
 * cannot answer "did the restore actually land the rows".
 *
 * TIMING, stated because it decides how the result may be used: this runs in its own
 * transaction, immediately after pg_dump finished, so on a database taking writes it is a
 * DIFFERENT snapshot to the dump's. The census is therefore corroboration, not proof. What
 * it does catch, reliably, is the failure that matters: a restore that produced the schema
 * and none of the rows.
 */
async function census(ctx, database) {
  const sql =
    "select table_name, (xpath('/row/cnt/text()', query_to_xml(format('select count(*) as cnt from %I.%I', " +
    "table_schema, table_name), false, true, '')))[1]::text::bigint from information_schema.tables " +
    "where table_schema = 'prl' and table_type = 'BASE TABLE' order by table_name;\n";
  const out = await captureTool('psql', psqlArgs(database), ctx, sql);
  const counts = {};
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const [name, count] = line.split('|');
    counts[name] = Number(count);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Archive identity and inventory
// ---------------------------------------------------------------------------

/** `20260822T130000Z` — sortable, filename-safe, unambiguously UTC. */
export function archiveStamp(date) {
  return `${date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')}`;
}

/**
 * A database name this script is willing to create, drop or restore into.
 *
 * The identifier cannot be a bind parameter — `CREATE DATABASE` takes none — so it is
 * interpolated by psql's `:"name"`, which quotes it as an identifier. This regex is defence
 * in depth on top of that, and it also rules out the names that merely *work* and then
 * surprise someone: mixed case (which PostgreSQL folds unless quoted, so the quoted form
 * would be a different database to the one they typed) and anything over 63 bytes (which
 * PostgreSQL silently truncates).
 */
export function isSafeDatabaseName(name) {
  return typeof name === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(name);
}

const archiveFileName = (id, payload) => (payload === 'globals' ? `${id}.globals.sql.enc` : `${id}.dump.enc`);
const manifestFileName = (id) => `${id}.manifest.json`;

/**
 * Reads every manifest in the directory and reports what is actually on disk beside it.
 *
 * A backup is "good" only when its manifest signature verifies AND every file it names is
 * present at the recorded size. That definition is load-bearing: `prune` refuses to delete
 * the newest GOOD backup, and a definition that counted a signed manifest whose dump file
 * had been deleted would let it delete the last real one.
 */
export async function readInventory(directory, material) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new BackupError(`no archive directory at ${directory}`, 'run `pnpm run backup create` first');
    }
    throw err;
  }
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.manifest.json')) continue;
    const path = join(directory, entry.name);
    const problems = [];
    let manifest = null;
    try {
      manifest = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      problems.push(`manifest is unreadable: ${err.message}`);
    }
    let signatureOk = false;
    if (manifest !== null) {
      if (manifest.format !== FORMAT) problems.push(`unknown manifest format ${String(manifest.format)}`);
      else {
        signatureOk = manifestSignatureValid(material, manifest);
        if (!signatureOk) problems.push('manifest signature does not verify');
      }
    }
    let bytes = 0;
    if (manifest !== null && Array.isArray(manifest.files)) {
      for (const file of manifest.files) {
        try {
          const info = await stat(join(directory, file.name));
          bytes += info.size;
          if (info.size !== file.cipherBytes) {
            problems.push(`${file.name} is ${info.size} bytes, manifest says ${file.cipherBytes}`);
          }
        } catch {
          problems.push(`${file.name} is missing`);
        }
      }
    }
    const createdAt = manifest?.createdAt ?? null;
    backups.push({
      id: manifest?.id ?? entry.name.replace(/\.manifest\.json$/, ''),
      createdAt,
      createdAtMs: createdAt === null ? Number.NaN : Date.parse(createdAt),
      manifestPath: path,
      manifest,
      bytes,
      signatureOk,
      problems,
      good: signatureOk && problems.length === 0,
    });
  }
  // Newest first. A backup whose createdAt is unparseable sorts last rather than throwing:
  // `list` has to be able to show a broken backup, that being the point of `list`.
  backups.sort((a, b) => {
    const left = Number.isNaN(a.createdAtMs) ? -1 : a.createdAtMs;
    const right = Number.isNaN(b.createdAtMs) ? -1 : b.createdAtMs;
    return right - left;
  });
  return backups;
}

function selectArchive(inventory, id) {
  if (id !== null && id !== undefined) {
    const found = inventory.find((backup) => backup.id === id);
    if (found === undefined) throw new BackupError(`no archive with id ${id} in this directory`);
    return found;
  }
  if (inventory.length === 0) throw new BackupError('no archives in this directory');
  return inventory[0];
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** UTC calendar day, e.g. 2026-08-22. */
const dayBucket = (date) => date.toISOString().slice(0, 10);
/** UTC month, e.g. 2026-08. */
const monthBucket = (date) => date.toISOString().slice(0, 7);

/**
 * ISO-8601 week bucket, e.g. 2026-W34.
 *
 * Computed rather than approximated by dividing epoch-milliseconds by 604800000, because
 * that puts the week boundary on a Thursday (the epoch was a Thursday) and produces weekly
 * buckets that no operator's calendar agrees with. ISO weeks start on Monday and belong to
 * the year containing their Thursday.
 */
export function weekBucket(date) {
  const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Sunday is 0 in JavaScript and 7 in ISO-8601.
  const isoWeekday = shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay();
  shifted.setUTCDate(shifted.getUTCDate() + 4 - isoWeekday);
  const yearStart = new Date(Date.UTC(shifted.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((shifted.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${shifted.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Decides which backups the retention policy keeps, and why.
 *
 * Grandfather-father-son over UTC buckets: within each day, week and month that has any
 * backup, the NEWEST one is that bucket's representative, and the most recent `daily`,
 * `weekly` and `monthly` buckets are kept. A backup can be its day's, its week's and its
 * month's representative at once; it is kept once, with every reason recorded, which is what
 * makes `list` able to explain a decision to an operator.
 *
 * ## The rule that overrides the policy
 *
 * **The newest good backup is never deleted, whatever the policy says.** Not the newest
 * backup — the newest *good* one, meaning its manifest signature verified and every file it
 * names is present at the recorded size. Three ways the plain reading gets somebody hurt:
 *
 *  * `--daily 0 --weekly 0 --monthly 0` is a legal policy, and without this rule it deletes
 *    everything and leaves the system with no backups at all.
 *  * A clock skew, a timezone mistake or a machine that came back with the wrong date puts
 *    every bucket in the past, and every backup falls out of the window on one run.
 *  * The newest backup is corrupt. Deleting the newest *good* one because a broken newer
 *    file occupies today's bucket is precisely the moment retention destroys the recovery.
 *
 * Bucket representatives are chosen from good backups only, for the same reason: a corrupt
 * archive must not be able to hold a slot and evict the intact one beneath it. Broken
 * backups are still deletable — they are what `--apply` is for once an operator has looked
 * at them — but they can never displace something that works.
 */
export function selectForRetention(backups, policy) {
  const usable = backups
    .filter((backup) => Number.isFinite(backup.createdAtMs))
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  const reasons = new Map();
  const note = (backup, reason) => {
    const existing = reasons.get(backup.id);
    if (existing === undefined) reasons.set(backup.id, [reason]);
    else if (!existing.includes(reason)) existing.push(reason);
  };

  const newestGood = usable.find((backup) => backup.good === true) ?? null;
  if (newestGood !== null) note(newestGood, 'newest good backup (never deleted)');

  const tiers = [
    { bucket: dayBucket, limit: policy.daily, label: 'daily' },
    { bucket: weekBucket, limit: policy.weekly, label: 'weekly' },
    { bucket: monthBucket, limit: policy.monthly, label: 'monthly' },
  ];
  for (const tier of tiers) {
    const representatives = new Map();
    for (const backup of usable) {
      if (backup.good !== true) continue;
      const key = tier.bucket(new Date(backup.createdAtMs));
      if (!representatives.has(key)) representatives.set(key, backup);
    }
    // Buckets are inserted newest-first because `usable` is sorted that way, so the first
    // `limit` entries are the most recent ones.
    let kept = 0;
    for (const [key, backup] of representatives) {
      if (kept >= tier.limit) break;
      note(backup, `${tier.label} ${key}`);
      kept += 1;
    }
  }

  const keep = [];
  const remove = [];
  for (const backup of backups) {
    const why = reasons.get(backup.id);
    if (why === undefined) remove.push({ ...backup, reason: reasonToDelete(backup, policy) });
    else keep.push({ ...backup, reasons: why });
  }
  return { keep, delete: remove };
}

function reasonToDelete(backup, policy) {
  if (!Number.isFinite(backup.createdAtMs)) return 'no usable createdAt in its manifest';
  if (backup.good !== true) return `not a good backup: ${backup.problems.join('; ')}`;
  return `outside the ${policy.daily}/${policy.weekly}/${policy.monthly} daily/weekly/monthly window`;
}

// ---------------------------------------------------------------------------
// Restore safety
// ---------------------------------------------------------------------------

/**
 * Every reason this restore must be refused, as a list rather than a boolean.
 *
 * A list because an operator who is refused for two reasons and fixes one should see the
 * second immediately, not on the next attempt. Pure, and exported, so the refusals have
 * tests that do not need a database.
 *
 * The three dangers are genuinely different and each gets its own acknowledgement:
 *
 *  1. **The target already exists.** Restoring into it means dropping it. `--drop-existing`.
 *  2. **The target IS the live database.** Every session, every hand and every lesson
 *     recorded since the backup is destroyed, and the API is holding connections to it.
 *     `--overwrite-live-database`, which is deliberately unmistakable and deliberately not
 *     implied by --drop-existing: the common case is a fat-fingered `--target` naming the
 *     developer's own database, and one flag protecting two very different mistakes means
 *     the person who wanted the first one gets the second for free.
 *  3. **NODE_ENV=production.** `--yes-i-am-restoring-production`, in addition to whichever
 *     of the above apply.
 */
export function assessRestoreSafety({
  target,
  liveDatabase,
  targetExists,
  nodeEnv,
  dropExisting,
  overwriteLive,
  productionAcknowledged,
}) {
  const refusals = [];
  if (target === null || target === undefined || target === '') {
    refusals.push('--target is required: name the database to restore INTO. There is no default.');
    return refusals;
  }
  if (!isSafeDatabaseName(target)) {
    refusals.push(
      `--target ${target} is not a usable database name: lower-case ASCII, starting with a letter or ` +
        'underscore, at most 63 characters',
    );
    return refusals;
  }
  if (targetExists && !dropExisting) {
    refusals.push(
      `database ${target} already exists. Restoring into it means DROPPING it first. ` +
        'Pass --drop-existing if that is what you mean, or choose a name that does not exist.',
    );
  }
  if (target === liveDatabase && !overwriteLive) {
    refusals.push(
      `${target} is the database DATABASE_URL points at. Everything written since this backup ` +
        'would be destroyed. Pass --overwrite-live-database as well if that is genuinely the intent.',
    );
  }
  if (nodeEnv === 'production' && !productionAcknowledged) {
    refusals.push(
      'NODE_ENV=production. A restore here destroys real learner progress and hand history. ' +
        'Pass --yes-i-am-restoring-production to acknowledge that, in addition to the flags above.',
    );
  }
  return refusals;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

let quiet = false;
const say = (line = '') => {
  if (!quiet) console.log(line);
};
const tick = (message, detail) => {
  say(`  ${green('✓')} ${message}`);
  if (detail !== undefined) say(dim(`      ${detail}`));
};
const cross = (message, detail) => {
  console.error(`  ${red('✗')} ${message}`);
  if (detail !== undefined && detail !== null) console.error(dim(`      ${detail}`));
};
const bang = (message, detail) => {
  say(`  ${yellow('!')} ${message}`);
  if (detail !== undefined) say(dim(`      ${detail}`));
};

const humanBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
};

const seconds = (ms) => `${(ms / 1000).toFixed(2)}s`;

const CAVEAT =
  'This tool proves the archive decrypts, parses and restores. It does not prove the application\n' +
  '  works against the restored data: that is the drill in docs/production/backup-restore.md.\n' +
  '  There is no WAL archiving here, so the RPO is the schedule interval and nothing better.';

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: DIR_MODE });
  // mkdir's mode is subject to the process umask, and an existing directory keeps whatever
  // mode it already had. An explicit chmod is the only way to be sure the archives are not
  // world-readable on a host with a permissive umask.
  await chmod(directory, DIR_MODE);
}

/**
 * Writes one encrypted payload, streaming, to a `.partial` file that is renamed into place
 * only after the producing tool has exited 0.
 *
 * The rename is what stops a failed run leaving a file that looks like a backup. A dump
 * interrupted by a full disk or an OOM kill produces a perfectly well-formed prefix; without
 * the staging name it would sit in the directory, sort as the newest archive, and be the one
 * `prune` protects and `restore` reaches for by default.
 */
async function writeEncryptedPayload({ ctx, tool, toolArgs, payload, header, material, destination }) {
  const staging = `${destination}.partial`;
  const run = startTool(tool, toolArgs, ctx, { stdin: 'ignore' });
  let digest = null;
  try {
    await pipeline(
      run.stdout,
      (source) => encryptFrames(source, { material, header, report: (r) => (digest = r) }),
      createWriteStream(staging, { mode: FILE_MODE }),
    );
    await run.settle();
  } catch (err) {
    await rm(staging, { force: true });
    throw err;
  }
  if (digest === null) throw new BackupError(`${tool} produced no output at all`);
  await chmod(staging, FILE_MODE);
  await rename(staging, destination);
  return { payload, name: basename(destination), ...digest };
}

async function commandCreate(options, ctx, material, directory) {
  say(bold('\nbackup create'));
  say(dim(`  source    ${ctx.connection.describe()}`));
  say(dim(`  directory ${directory.path}  (from ${directory.source})`));
  say(dim(`  tools     ${ctx.container === null ? 'from PATH' : `inside container ${ctx.container}`}\n`));

  await ensureDirectory(directory.path);

  const serverVersion = await psqlScalar(ctx, ctx.connection.database, 'show server_version;\n');
  // `pg_dump (PostgreSQL) 16.15 (Debian 16.15-1.pgdg12+2)` — take the first dotted number and
  // nothing else. Splitting on whitespace and taking the last token yields "16.15-1.pgdg12+2)",
  // trailing bracket included, which then parses as a major version by luck rather than by rule.
  const versionBanner = await captureTool('pg_dump', ['--version'], ctx, undefined, true);
  const dumpVersion = (/\d+(?:\.\d+)?/.exec(versionBanner) ?? ['unknown'])[0];
  // pg_dump refuses a server newer than itself, and produces an archive an older pg_restore
  // cannot read when it is newer. Checking the majors here turns that into a sentence now
  // rather than an obscure failure in the middle of a nightly run.
  const serverMajor = Number.parseInt(serverVersion, 10);
  const dumpMajor = Number.parseInt(dumpVersion ?? '0', 10);
  if (!Number.isNaN(serverMajor) && !Number.isNaN(dumpMajor) && dumpMajor < serverMajor) {
    throw new BackupError(
      `pg_dump ${dumpVersion} is older than the server (${serverVersion})`,
      'pg_dump refuses a newer server; install the matching client tools or pass --container',
    );
  }

  const startedAt = new Date();
  const id = `prl-${ctx.connection.database}-${archiveStamp(startedAt)}`;
  const salt = randomBytes(SALT_BYTES);
  const noncePrefix = randomBytes(NONCE_PREFIX_BYTES);
  const headerFor = (payload) => archiveHeader({ archive: id, payload, salt, noncePrefix });

  const files = [];
  const dumpStarted = Date.now();
  files.push(
    await writeEncryptedPayload({
      ctx,
      tool: 'pg_dump',
      // --format=custom for selective restore and compression. NO --no-owner and NO
      // --no-privileges: docs/RUNBOOK.md §11.4 measured what that costs — a restore that
      // exits 0 and hands the runtime role ownership of every table it serves, inverting the
      // entire least-privilege posture in a database that has every row.
      toolArgs: ['--format=custom', '--dbname', ctx.connection.database],
      payload: 'database',
      header: headerFor('database'),
      material,
      destination: join(directory.path, archiveFileName(id, 'database')),
    }),
  );
  const dumpMs = Date.now() - dumpStarted;
  tick(
    `database dumped and encrypted  ${humanBytes(files[0].cipherBytes)} in ${seconds(dumpMs)}`,
    `${files[0].frames} frames, plaintext ${humanBytes(files[0].plainBytes)}`,
  );

  if (options.globals) {
    files.push(
      await writeEncryptedPayload({
        ctx,
        tool: 'pg_dumpall',
        // --globals-only: roles, role memberships and tablespaces. NOT in a single-database
        // pg_dump, which is why a restore onto a fresh cluster fails with "role prl_migrator
        // does not exist" without it.
        toolArgs: ['--globals-only', '--database', ctx.connection.database],
        payload: 'globals',
        header: headerFor('globals'),
        material,
        destination: join(directory.path, archiveFileName(id, 'globals')),
      }),
    );
    tick(
      `cluster globals dumped and encrypted  ${humanBytes(files[1].cipherBytes)}`,
      'contains the login roles and their SCRAM verifiers — this is why the archive is encrypted',
    );
  } else {
    bang(
      'globals NOT captured (--no-globals)',
      'a full-cluster rebuild from this archive cannot recreate prl_api or prl_deployer',
    );
  }

  const rowCounts = await census(ctx, ctx.connection.database);
  const totalRows = Object.values(rowCounts).reduce((sum, n) => sum + n, 0);
  tick(
    `row census taken  ${Object.keys(rowCounts).length} tables, ${totalRows} rows`,
    'taken immediately after the dump, in its own snapshot — corroboration, not proof',
  );

  const body = {
    format: FORMAT,
    id,
    createdAt: startedAt.toISOString(),
    source: {
      database: ctx.connection.database,
      host: ctx.connection.host,
      port: ctx.connection.port,
      serverVersion,
      pgDumpVersion: dumpVersion,
    },
    encryption: {
      cipher: 'aes-256-gcm',
      kdf: 'hkdf-sha256',
      salt: salt.toString('base64'),
      chunkBytes: CHUNK_BYTES,
      // Reserved for an envelope scheme that does not exist yet: a KMS-wrapped data key
      // would name the root key here. Null is honest about there being one static key today.
      keyId: null,
    },
    files: files.map((file) => ({
      name: file.name,
      payload: file.payload,
      cipherBytes: file.cipherBytes,
      cipherSha256: file.cipherSha256,
      plainBytes: file.plainBytes,
      plainSha256: file.plainSha256,
      frames: file.frames,
    })),
    rowCounts,
  };
  const manifest = { ...body, hmac: manifestSignature(material, salt, body) };
  const manifestPath = join(directory.path, manifestFileName(id));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: FILE_MODE });
  await chmod(manifestPath, FILE_MODE);
  tick('manifest written and signed', `${manifestPath}`);

  say(bold('\n  Summary'));
  say(`    archive     ${id}`);
  say(`    files       ${files.length + 1} (${files.length} encrypted payload(s) + manifest)`);
  say(`    on disk     ${humanBytes(files.reduce((sum, file) => sum + file.cipherBytes, 0))}`);
  say(`    elapsed     ${seconds(Date.now() - startedAt.getTime())}`);
  say(`\n  ${green(bold('PASS'))} backup created`);
  say(dim(`\n  ${CAVEAT}\n`));
  if (options.json) console.log(JSON.stringify(manifest));
  return 0;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/**
 * Four layers, each supporting a strictly different claim. The distinction is the entire
 * reason this command exists rather than a `sha256sum -c`:
 *
 *   1. **Manifest signature.** The checksums below are worth checking. Without this, an
 *      attacker who can write to the backup directory rewrites both the archive and the
 *      recorded checksum and every layer under this one agrees with them.
 *   2. **Ciphertext checksum.** The bytes on disk are the bytes that were written. This is
 *      the bit-rot check, and it is the ONLY thing a checksum proves. It does not need the
 *      key, so a monitoring job can run it without one.
 *   3. **Decryption, frame by frame, to the terminator.** Every frame authenticates under the
 *      real key, in its recorded position, and the stream ends where it said it would. This
 *      is what catches truncation — which a checksum, computed over whatever is left, never
 *      will — and it proves the plaintext digest recorded at dump time.
 *   4. **`pg_restore --list`, and with --deep an actual restore.** Layer 3 proves we
 *      recovered the bytes pg_dump produced. It does not prove pg_dump produced a usable
 *      archive: a dump killed by the OOM reaper mid-write is a valid prefix, and it will
 *      decrypt perfectly. --list makes pg_restore parse the table of contents; --deep makes
 *      it execute the whole thing into a scratch database and compares the row census.
 *      Only layer 4 with --deep supports the sentence "this archive is restorable".
 */
async function verifyArchive(backup, { ctx, material, directory, deep, target }) {
  const results = [];
  const record = (layer, ok, message, detail) => {
    results.push({ layer, ok, message, detail: detail ?? null });
    if (ok) tick(`${layer}. ${message}`, detail);
    else cross(`${layer}. ${message}`, detail);
  };

  if (backup.manifest === null) {
    record('1', false, 'manifest unreadable', backup.problems.join('; '));
    return results;
  }
  record(
    '1',
    backup.signatureOk,
    backup.signatureOk ? 'manifest signature verifies' : 'manifest signature does NOT verify',
    backup.signatureOk ? 'so the checksums below are the ones that were recorded at dump time' : null,
  );
  if (!backup.signatureOk) return results;

  for (const file of backup.manifest.files) {
    const path = join(directory, file.name);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
        bytes += chunk.length;
      }
    } catch (err) {
      record('2', false, `${file.name} could not be read`, err.message);
      return results;
    }
    const digest = hash.digest('hex');
    const ok = digest === file.cipherSha256 && bytes === file.cipherBytes;
    record(
      '2',
      ok,
      ok ? `${file.name} matches its checksum` : `${file.name} does NOT match its checksum`,
      ok
        ? 'bytes did not rot — this proves nothing about whether pg_restore can read them'
        : `recorded ${file.cipherSha256.slice(0, 16)}… over ${file.cipherBytes} bytes, found ` +
            `${digest.slice(0, 16)}… over ${bytes} bytes`,
    );
    if (!ok) return results;

    const plainHash = createHash('sha256');
    let plainBytes = 0;
    try {
      for await (const plain of decryptFrames(createReadStream(path), {
        material,
        expectHeader: { archive: backup.manifest.id, payload: file.payload },
      })) {
        plainHash.update(plain);
        plainBytes += plain.length;
      }
    } catch (err) {
      record('3', false, `${file.name} failed authenticated decryption`, err.detail ?? err.message);
      return results;
    }
    const plainDigest = plainHash.digest('hex');
    const plainOk = plainDigest === file.plainSha256 && plainBytes === file.plainBytes;
    record(
      '3',
      plainOk,
      plainOk
        ? `${file.name} decrypts to the recorded plaintext`
        : `${file.name} decrypts to DIFFERENT plaintext than recorded`,
      plainOk
        ? `${file.frames} frames authenticated, terminator present, ${humanBytes(plainBytes)} recovered`
        : `recorded ${file.plainSha256.slice(0, 16)}…, got ${plainDigest.slice(0, 16)}…`,
    );
    if (!plainOk) return results;
  }

  const dumpFile = backup.manifest.files.find((file) => file.payload === 'database');
  if (dumpFile === undefined) {
    record('4', false, 'this archive has no database payload', 'nothing to restore');
    return results;
  }

  // `bare`: --list parses an archive and connects to nothing, so it must not be handed a
  // --host or a --username it would have to have been configured with.
  const listRun = startTool('pg_restore', ['--list'], ctx, { stdin: 'pipe', bare: true });
  const listChunks = [];
  listRun.stdout.on('data', (chunk) => listChunks.push(chunk));
  try {
    await feedTool(listRun, decryptFrames(createReadStream(join(directory, dumpFile.name)), { material }));
  } catch (err) {
    record('4', false, 'pg_restore cannot read the archive', err.detail ?? err.message);
    return results;
  }
  const toc = Buffer.concat(listChunks).toString('utf8');
  const entries = toc.split('\n').filter((line) => line !== '' && !line.startsWith(';')).length;
  // `\bACL\b`, not `'ACL - '`: pg_restore --list writes the schema grant as
  // `ACL - SCHEMA prl prl_migrator` but every table grant as `ACL prl TABLE users prl_migrator`,
  // with no dash. Matching the dashed form found 2 of the 16 entries in this dump, which is
  // 2 more than zero and would therefore have passed the check below on a dump that had lost
  // every table grant.
  const acl = toc.split('\n').filter((line) => /\bACL\b/.test(line)).length;
  record(
    '4',
    entries > 0,
    entries > 0 ? `pg_restore parsed ${entries} table-of-contents entries` : 'pg_restore found no entries',
    // The ACL count is the cheap detector for the §11.4 trap: a dump taken with
    // --no-privileges parses perfectly and restores a database the API cannot read.
    `${acl} ACL entries — a dump with 0 of these restores a database prl_app has no rights in`,
  );
  if (entries === 0) return results;
  if (acl === 0) {
    record(
      '4',
      false,
      'the dump carries no ACL entries',
      'it was taken with --no-privileges; see RUNBOOK §11.4',
    );
    return results;
  }

  if (!deep) {
    bang(
      'stopping here: --deep not given',
      'layers 1-3 prove the archive is intact; only --deep proves pg_restore can execute it',
    );
    return results;
  }

  const scratch = target ?? `prl_verify_${archiveStamp(new Date()).toLowerCase()}`;
  if (!isSafeDatabaseName(scratch))
    throw new BackupError(`--target ${scratch} is not a usable database name`);
  const exists = await databaseExists(ctx, scratch);
  if (exists) {
    throw new BackupError(
      `--deep will not reuse the existing database ${scratch}`,
      'it drops the scratch database when it is done, and it will not drop one it did not create',
    );
  }
  const startedAt = Date.now();
  let restored = null;
  try {
    await createDatabase(ctx, scratch);
    await restoreInto(ctx, scratch, join(directory, dumpFile.name), material);
    restored = await census(ctx, scratch);
  } finally {
    // Always. A verification run that leaves a copy of the production database lying around
    // on the cluster has created the exact exposure the encryption exists to prevent.
    await dropDatabase(ctx, scratch).catch((err) => {
      cross(`could not drop the scratch database ${scratch}`, err.message);
    });
  }
  const comparison = compareCensus(backup.manifest.rowCounts, restored);
  record(
    '4',
    comparison.ok,
    comparison.ok
      ? `restored into a scratch database and dropped it  (${seconds(Date.now() - startedAt)})`
      : 'the restored database does not carry the recorded rows',
    comparison.summary,
  );
  return results;
}

/**
 * Compares a recorded census against a restored one.
 *
 * The hard rule is deliberately narrow: a table the census recorded as non-empty must not
 * come back empty. That is the failure this can actually detect — schema restored, data not.
 * Any other delta is reported and is NOT a failure, because the census and the dump are two
 * different snapshots of a database that may have been taking writes (see `census`), and a
 * check that fires on ordinary drift is a check people learn to ignore.
 */
export function compareCensus(recorded, restored) {
  if (recorded === undefined || recorded === null) {
    return { ok: true, summary: 'no census recorded in this manifest; nothing to compare' };
  }
  const emptied = [];
  const drifted = [];
  const missing = [];
  for (const [table, count] of Object.entries(recorded)) {
    const now = restored[table];
    if (now === undefined) missing.push(table);
    else if (count > 0 && now === 0) emptied.push(table);
    else if (now !== count) drifted.push(`${table} ${count}→${now}`);
  }
  const ok = emptied.length === 0 && missing.length === 0;
  const parts = [`${Object.keys(recorded).length} tables compared`];
  if (missing.length > 0) parts.push(`MISSING: ${missing.join(', ')}`);
  if (emptied.length > 0) parts.push(`EMPTY after restore: ${emptied.join(', ')}`);
  if (drifted.length > 0) parts.push(`drift (expected on a live database): ${drifted.join(', ')}`);
  return { ok, summary: parts.join(' | '), emptied, missing, drifted };
}

async function commandVerify(options, ctx, material, directory) {
  say(bold('\nbackup verify'));
  say(dim(`  directory ${directory.path}  (from ${directory.source})\n`));
  const inventory = await readInventory(directory.path, material);
  const chosen = options.all ? inventory : [selectArchive(inventory, options.id)];
  if (chosen.length === 0) throw new BackupError('no archives in this directory');

  let failed = 0;
  const report = [];
  for (const backup of chosen) {
    say(bold(`  ${backup.id}`));
    const results = await verifyArchive(backup, {
      ctx,
      material,
      directory: directory.path,
      deep: options.deep,
      target: options.target,
    });
    const ok = results.every((result) => result.ok);
    if (!ok) failed += 1;
    report.push({ id: backup.id, ok, layers: results });
    say('');
  }

  say(bold('  Summary'));
  say(`    archives    ${chosen.length}`);
  say(`    intact      ${chosen.length - failed}`);
  say(`    failed      ${failed}`);
  say(
    `    depth       ${options.deep ? 'layers 1-4, including a real restore' : 'layers 1-4 without a restore'}`,
  );
  say(`\n  ${failed === 0 ? green(bold('PASS')) : red(bold('FAIL'))} verification`);
  say(dim(`\n  ${CAVEAT}\n`));
  if (options.json) console.log(JSON.stringify(report));
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

async function databaseExists(ctx, name) {
  const out = await captureTool(
    'psql',
    psqlArgs(ctx.maintenanceDatabase, ['--set', `name=${name}`]),
    ctx,
    "select 1 from pg_database where datname = :'name';\n",
  );
  return out.trim() === '1';
}

async function createDatabase(ctx, name) {
  // psql's `:"name"` quotes the value as an SQL identifier. Variable interpolation only
  // happens for input read from stdin — psql does NOT interpolate into -c — which is why
  // every statement here is piped rather than passed as an argument.
  await captureTool(
    'psql',
    psqlArgs(ctx.maintenanceDatabase, ['--set', `name=${name}`]),
    ctx,
    'CREATE DATABASE :"name";\n',
  );
}

async function dropDatabase(ctx, name) {
  await captureTool(
    'psql',
    psqlArgs(ctx.maintenanceDatabase, ['--set', `name=${name}`]),
    ctx,
    // WITH (FORCE) terminates other sessions. Without it a single idle connection — a
    // developer's psql, a pooler that has not noticed — makes the drop fail, and a restore
    // that half-happened is worse than one that refused.
    'DROP DATABASE IF EXISTS :"name" WITH (FORCE);\n',
  );
}

async function restoreInto(ctx, database, encryptedPath, material) {
  const run = startTool(
    'pg_restore',
    [
      '--dbname',
      database,
      // --exit-on-error, always. docs/RUNBOOK.md §11.4 measured the alternative: pg_restore
      // carries on past every rejected statement, finishes with "errors ignored on restore:
      // 20", and leaves a database that has every row and the wrong owner on every relation.
      '--exit-on-error',
      // Single transaction: the database is either restored or untouched. It also makes
      // --exit-on-error actually mean something, since a rollback undoes the partial work.
      '--single-transaction',
    ],
    ctx,
    { stdin: 'pipe' },
  );
  await feedTool(run, decryptFrames(createReadStream(encryptedPath), { material }));
}

async function applyGlobals(ctx, encryptedPath, material) {
  const run = startTool('psql', psqlArgs(ctx.maintenanceDatabase), ctx, { stdin: 'pipe' });
  await feedTool(run, decryptFrames(createReadStream(encryptedPath), { material }));
}

async function commandRestore(options, ctx, material, directory) {
  say(bold('\nbackup restore'));
  const inventory = await readInventory(directory.path, material);
  const backup = selectArchive(inventory, options.id);
  say(dim(`  archive   ${backup.id}  (${backup.createdAt})`));
  say(dim(`  target    ${options.target ?? '(none given)'}`));
  say(dim(`  cluster   ${ctx.connection.describe()}\n`));

  if (!backup.good) {
    throw new BackupError(
      `archive ${backup.id} does not pass its own integrity checks`,
      `${backup.problems.join('; ')} — run \`pnpm run backup verify --id ${backup.id}\``,
    );
  }

  // The existence probe runs before the safety assessment so the refusal can name the real
  // situation rather than "it might exist".
  const targetExists =
    options.target !== null && isSafeDatabaseName(options.target)
      ? await databaseExists(ctx, options.target)
      : false;
  const refusals = assessRestoreSafety({
    target: options.target,
    liveDatabase: ctx.connection.database,
    targetExists,
    nodeEnv: process.env['NODE_ENV'] ?? null,
    dropExisting: options.dropExisting,
    overwriteLive: options.overwriteLive,
    productionAcknowledged: options.productionAcknowledged,
  });
  if (refusals.length > 0) {
    for (const refusal of refusals) cross('refusing to restore', refusal);
    say(`\n  ${red(bold('FAIL'))} nothing was changed\n`);
    return 1;
  }

  const startedAt = Date.now();
  if (options.withGlobals) {
    const globals = backup.manifest.files.find((file) => file.payload === 'globals');
    if (globals === undefined) {
      throw new BackupError('--with-globals, but this archive has no globals payload');
    }
    await applyGlobals(ctx, join(directory.path, globals.name), material);
    tick('cluster globals applied', 'roles, memberships and their passwords now match the backup');
  }

  if (targetExists) {
    await dropDatabase(ctx, options.target);
    tick(`dropped the existing database ${options.target}`);
  }
  await createDatabase(ctx, options.target);
  const createdAtMs = Date.now();

  const dumpFile = backup.manifest.files.find((file) => file.payload === 'database');
  if (dumpFile === undefined) throw new BackupError('this archive has no database payload');
  await restoreInto(ctx, options.target, join(directory.path, dumpFile.name), material);
  const restoredAtMs = Date.now();
  tick(
    `restored ${humanBytes(dumpFile.plainBytes)} of dump into ${options.target}`,
    `decrypt + pg_restore --exit-on-error --single-transaction, ${seconds(restoredAtMs - createdAtMs)}`,
  );

  const restoredCensus = await census(ctx, options.target);
  const comparison = compareCensus(backup.manifest.rowCounts, restoredCensus);
  if (comparison.ok) tick('row census matches the archive', comparison.summary);
  else cross('row census does NOT match the archive', comparison.summary);

  const totals = Object.values(restoredCensus).reduce((sum, n) => sum + n, 0);
  say(bold('\n  Summary'));
  say(`    restored    ${options.target}  (${Object.keys(restoredCensus).length} tables, ${totals} rows)`);
  say(`    restore     ${seconds(restoredAtMs - createdAtMs)}  (decrypt + pg_restore)`);
  say(`    total       ${seconds(Date.now() - startedAt)}  (including create and census)`);
  say(`\n  ${comparison.ok ? green(bold('PASS')) : red(bold('FAIL'))} restore`);
  say(dim('\n  Next, and this tool cannot do it for you:'));
  say(dim('    DATABASE_URL=<target> node --env-file-if-exists=.env apps/api/scripts/verify-schema.mjs'));
  say(dim('    then start the API against it and check /api/v1/ready.'));
  say(dim(`\n  ${CAVEAT}\n`));
  if (options.json)
    console.log(JSON.stringify({ target: options.target, census: restoredCensus, comparison }));
  return comparison.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// list and prune
// ---------------------------------------------------------------------------

async function commandList(options, _ctx, material, directory) {
  say(bold('\nbackup list'));
  say(dim(`  directory ${directory.path}  (from ${directory.source})\n`));
  const inventory = await readInventory(directory.path, material);
  const policy = { daily: options.daily, weekly: options.weekly, monthly: options.monthly };
  const plan = selectForRetention(inventory, policy);
  const keptIds = new Map(plan.keep.map((backup) => [backup.id, backup.reasons]));

  for (const backup of inventory) {
    const reasons = keptIds.get(backup.id);
    const label = `${backup.id}  ${humanBytes(backup.bytes)}`;
    if (!backup.good) bang(label, backup.problems.join('; '));
    else if (reasons === undefined) say(`  ${dim('·')} ${label}  ${dim('would be pruned')}`);
    else tick(label, reasons.join(', '));
  }

  say(bold('\n  Summary'));
  say(`    archives    ${inventory.length}`);
  say(`    good        ${inventory.filter((backup) => backup.good).length}`);
  say(`    on disk     ${humanBytes(inventory.reduce((sum, backup) => sum + backup.bytes, 0))}`);
  say(`    policy      ${policy.daily} daily / ${policy.weekly} weekly / ${policy.monthly} monthly`);
  say(`\n  ${inventory.length > 0 ? green(bold('PASS')) : yellow(bold('EMPTY'))} inventory read`);
  say(
    dim(
      '\n  "good" means the manifest signature verified and every file it names is present at the\n' +
        '  recorded size. It does NOT mean the archive was decrypted or restored — run\n' +
        '  `pnpm run backup verify --deep` for that.\n',
    ),
  );
  if (options.json) console.log(JSON.stringify({ policy, inventory, plan }));
  return 0;
}

async function commandPrune(options, _ctx, material, directory) {
  say(bold('\nbackup prune'));
  const policy = { daily: options.daily, weekly: options.weekly, monthly: options.monthly };
  say(dim(`  directory ${directory.path}  (from ${directory.source})`));
  say(dim(`  policy    ${policy.daily} daily / ${policy.weekly} weekly / ${policy.monthly} monthly`));
  say(
    dim(
      `  mode      ${options.apply ? 'APPLY — files will be deleted' : 'plan only (pass --apply to delete)'}\n`,
    ),
  );

  const inventory = await readInventory(directory.path, material);
  const plan = selectForRetention(inventory, policy);

  for (const backup of plan.keep) tick(`keep    ${backup.id}`, backup.reasons.join(', '));
  for (const backup of plan.delete) {
    if (options.apply) {
      const names = (backup.manifest?.files ?? []).map((file) => file.name);
      for (const name of names) await rm(join(directory.path, name), { force: true });
      await rm(backup.manifestPath, { force: true });
      say(`  ${red('✗')} deleted ${backup.id}`);
    } else {
      say(`  ${dim('·')} would delete ${backup.id}`);
    }
    say(dim(`      ${backup.reason}`));
  }

  const survivors = plan.keep.filter((backup) => backup.good).length;
  say(bold('\n  Summary'));
  say(`    kept        ${plan.keep.length} (${survivors} good)`);
  say(`    ${options.apply ? 'deleted    ' : 'deletable  '} ${plan.delete.length}`);
  say(`    freed       ${humanBytes(plan.delete.reduce((sum, backup) => sum + backup.bytes, 0))}`);
  // A prune that ends with no good backup left is a failure whatever the policy said, and
  // the only way to reach it is an archive directory that had none to begin with.
  if (inventory.length > 0 && survivors === 0) {
    cross('no good backup survives this prune', 'the directory contained none — nothing was protected');
    say(`\n  ${red(bold('FAIL'))} prune\n`);
    return 1;
  }
  say(`\n  ${green(bold('PASS'))} ${options.apply ? 'prune applied' : 'prune plan (nothing deleted)'}`);
  say(dim('\n  The newest good backup is never in the delete set, whatever the policy says.\n'));
  if (options.json) console.log(JSON.stringify({ policy, applied: options.apply, plan }));
  return 0;
}

function commandKeygen() {
  const key = randomBytes(KEY_BYTES);
  say(bold('\nbackup keygen'));
  say(dim('  32 bytes from node:crypto randomBytes (the OS CSPRNG), base64url.\n'));
  console.log(key.toString('base64url'));
  say(dim('\n  Put it in PRL_BACKUP_KEY on the backup host, mode 0600, owned by the backup user.'));
  say(dim('  Escrow a copy somewhere that is NOT the backup host, and test the escrow.'));
  say(dim('  Archives encrypted with a key you lose are noise. There is no recovery.\n'));
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run(options) {
  quiet = options.quiet;
  if (options.command === 'keygen') return commandKeygen();

  const directory = resolveDirectory(process.env, options.dir);
  const material = await resolveKey(process.env, options.keyFile);

  // Which commands genuinely need somewhere to connect, and no more than that. `list` and
  // `prune` never touch a database. `verify` without --deep does not either: layers 1-3 are
  // file arithmetic, and `pg_restore --list` reads an archive on stdin without opening a
  // connection. Demanding DATABASE_URL for those would make the ordinary case — an operator
  // inspecting an archive directory on a machine that is not the database host, which is
  // where offsite copies live — impossible.
  const needsConnection =
    options.command === 'create' ||
    options.command === 'restore' ||
    (options.command === 'verify' && options.deep);
  const ctx = {
    connection: needsConnection
      ? resolveConnection(process.env, options.url)
      : resolveOptionalConnection(process.env, options.url),
    container: options.container ?? process.env['PRL_BACKUP_PG_CONTAINER'] ?? null,
    maintenanceDatabase: options.maintenanceDatabase,
  };

  if (options.command === 'create') return commandCreate(options, ctx, material, directory);
  if (options.command === 'verify') return commandVerify(options, ctx, material, directory);
  if (options.command === 'restore') return commandRestore(options, ctx, material, directory);
  if (options.command === 'list') return commandList(options, ctx, material, directory);
  if (options.command === 'prune') return commandPrune(options, ctx, material, directory);
  // No `else` fallthrough, for the same reason migrate.mjs has none: adding a name to
  // COMMANDS without a branch here must fail loudly rather than run whichever command
  // happened to be last.
  throw new BackupError(`command ${options.command} has no implementation`);
}

/**
 * True when this file was started from the command line rather than imported.
 *
 * scripts/backup.test.mjs imports the pure halves — the retention selector, the container
 * format, the refusal assessment — and without this guard the import would run `main()` and
 * try to reach a database.
 */
function startedFromCommandLine() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedFromCommandLine()) {
  let exitCode = 1;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || options.command === null) {
      console.log(HELP);
      process.exit(0);
    }
    exitCode = await run(options);
  } catch (error) {
    console.error('');
    if (error instanceof BackupError) cross(error.message, error.detail);
    else cross(error?.message ?? String(error), process.env['PRL_DEBUG'] ? error?.stack : null);
    console.error('');
    exitCode = 1;
  }
  process.exit(exitCode);
}
