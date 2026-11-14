#!/usr/bin/env node
/**
 * Encrypted, verifiable PostgreSQL backups (`pnpm run backup <command>`, see --help).
 *
 *     create   dump, encrypt, checksum, sign a manifest
 *     verify   prove an archive is intact, and (--deep) restorable
 *     restore  restore into a NAMED target database
 *     list     inventory, with retention class and integrity state
 *     prune    apply the retention policy
 *     keygen   print a fresh 32-byte archive key
 *
 * Every payload, including the globals dump that holds the SCRAM verifiers, is AES-256-GCM
 * encrypted before it touches disk. The key comes from PRL_BACKUP_KEY or --key-file, never a flag,
 * and protects a stolen archive, not a compromised host. HKDF-SHA-256 with a per-archive salt
 * derives a separate key per payload. No WAL archiving, so the RPO is the schedule interval, and
 * live in-memory hands are not durable (ADR 0001). See docs/production/disaster-recovery.md.
 *
 * The payload is a sequence of sealed frames so `restore` never feeds pg_restore an unauthenticated
 * byte. Each frame's AAD binds the header hash, its index and a final flag, and an empty final frame
 * makes truncation detectable. The manifest is HMAC-signed, because whoever can corrupt an archive
 * can also rewrite a plain checksum.
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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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

export class BackupError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'BackupError';
    this.detail = detail ?? null;
  }
}

export const COMMANDS = ['create', 'verify', 'restore', 'list', 'prune', 'keygen'];

export const DEFAULTS = {
  // Outside the repository, so an archive is never one `git add -A` from a public remote. This is the
  // path the shipped systemd unit uses.
  dir: '/var/backups/poker-risk-lab',
  maintenanceDatabase: 'postgres',
  // Retention in whole backups. The reasoning is in docs/production/backup-restore.md.
  daily: 7,
  weekly: 4,
  monthly: 6,
};

// 1 MiB frames cost 0.002% in tags and bound a streaming restore to 1 MiB of plaintext in memory.
export const CHUNK_BYTES = 1024 * 1024;

const MAGIC = Buffer.from('PRLBAK1\n', 'ascii');
const FORMAT = 'prl-backup/1';
const TAG_BYTES = 16;
const NONCE_PREFIX_BYTES = 4;
const NONCE_BYTES = 12;
const SALT_BYTES = 32;
const KEY_BYTES = 32;
// Without a ceiling, a hostile length prefix allocates up to 4 GiB before any tag is checked. It
// leaves room for a future larger CHUNK_BYTES.
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

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
  // Only the first non-option argument is the subcommand. `backup create restore` is a typo.
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
  // A four-figure retention is a typo. 9999 dailies is 27 years of archives.
  if (value > 365) throw new BackupError(`${flag} of ${value} is implausible; the ceiling is 365`);
  return value;
}

export function resolveDirectory(env, flag) {
  if (flag !== null && flag !== undefined) return { path: resolve(flag), source: '--dir' };
  const fromEnv = env['PRL_BACKUP_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return { path: resolve(fromEnv), source: 'PRL_BACKUP_DIR' };
  return { path: DEFAULTS.dir, source: 'default' };
}

// The password reaches tools only through PGPASSWORD, never argv, a log or a manifest.
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
    describe() {
      return `${this.user}@${this.host}:${this.port}/${this.database}`;
    },
  };
}

// A malformed string still throws, or a DATABASE_URL typo would silently turn `verify --deep` into
// `verify`.
export function resolveOptionalConnection(env, flag) {
  const raw = flag ?? env['DATABASE_URL'];
  if (raw === undefined || raw === '') return null;
  return resolveConnection(env, flag);
}

// Accepts base64url, base64 or hex by shape, and reports the decoded length on a mismatch.
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

// Fixed key order, so the HMAC does not depend on how the object was built.
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

// Readable without the key, so an operator can tell what a file is, and covered by every frame's AAD,
// so no field can be edited.
export function archiveHeader({ archive, payload, salt, noncePrefix }) {
  return {
    format: FORMAT,
    cipher: 'aes-256-gcm',
    kdf: 'hkdf-sha256',
    archive,
    payload,
    salt: salt.toString('base64'),
    // The derived key is unique per archive and payload, and the random prefix removes any reliance on that.
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

// Binds a frame to its header and position, so a moved or transplanted frame fails its tag.
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

// Reports the plaintext digest, for restore, and the ciphertext digest, for keyless bit-rot checks.
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
  // The terminator, so a truncated stream lacks something only the key can make.
  yield emit(sealFrame(key, prefix, binding, index, Buffer.alloc(0), true));

  report({
    plainSha256: plainHash.digest('hex'),
    cipherSha256: cipherHash.digest('hex'),
    plainBytes,
    cipherBytes,
    frames: index + 1,
  });
}

function byteReader(source) {
  // Accepts sync and async iterables, since tests pass an array and production a ReadStream.
  const iterator =
    typeof source[Symbol.asyncIterator] === 'function'
      ? source[Symbol.asyncIterator]()
      : source[Symbol.iterator]();
  let buffered = Buffer.alloc(0);
  let done = false;
  return {
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

// Every yielded byte has passed its tag, because a consumer may execute it.
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
    // A file swapped in from another backup would still match that backup's checksums.
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
    // An empty ciphertext is the terminator. The flag is in the AAD, so it comes from the length.
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

/**
 * Builds the argv and environment for one PostgreSQL client invocation.
 *
 * On PATH, the tools run on the backup host. With `--container` they run inside the database
 * container over its unix socket, so --host is omitted. `docker exec -e PGPASSWORD` with no value
 * forwards the password without putting it in argv.
 */
function toolCommand(tool, toolArgs, ctx, bare) {
  const connection = [];
  // pg_dump 16 refuses `--version` beside any other option, so a version probe carries no connection flags.
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
      // `verify` without --deep may have no connection configured.
      ...(ctx.connection === null ? {} : { PGPASSWORD: ctx.connection.password }),
      // A hung connect fails the backup instead of holding the timer unit open.
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

// Tolerates a closed stdin because `pg_restore --list` exits after reading the table of contents.
// Measured, a 287.8 MiB archive failed with EPIPE while a 153 KiB one passed. The tool's exit code
// decides.
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

// One round trip via `query_to_xml`, with exact counts rather than reltuples estimates. It runs after
// pg_dump in its own transaction, so it corroborates the dump and reliably catches a restore with
// the schema and none of the rows.
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

export function archiveStamp(date) {
  return `${date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')}`;
}

// psql's `:"name"` already quotes the identifier. This also refuses mixed case, which would name a
// different database once quoted, and names over 63 bytes, which PostgreSQL truncates.
export function isSafeDatabaseName(name) {
  return typeof name === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(name);
}

const archiveFileName = (id, payload) => (payload === 'globals' ? `${id}.globals.sql.enc` : `${id}.dump.enc`);
const manifestFileName = (id) => `${id}.manifest.json`;

/**
 * True only for a plain basename, the only shape `archiveFileName` writes, because `prune --apply`
 * passes the manifest's name to `rm(join(directory, name))` and `../VICTIM.txt` would delete outside
 * the directory. The signature does not help, since unverified archives are exactly the delete set.
 * Contained shapes like `./file.enc` are refused too.
 */
export function isPlainArchiveFileName(name) {
  if (typeof name !== 'string' || name === '') return false;
  // NUL truncates a path at the syscall boundary. `\` is refused because `..\` escapes on Windows.
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) return false;
  if (name === '.' || name === '..') return false;
  if (isAbsolute(name)) return false;
  return basename(name) === name;
}

// Checked over the whole delete set before any unlink, so a tampered manifest cannot half-apply a prune.
export function unsafeArchiveFileNames(backups) {
  const offences = [];
  for (const backup of backups) {
    for (const file of backup.manifest?.files ?? []) {
      if (!isPlainArchiveFileName(file?.name)) {
        offences.push({ id: backup.id, name: String(file?.name), manifestPath: backup.manifestPath });
      }
    }
  }
  return offences;
}

// "Good" means the signature verifies and every named file is present at its recorded size. `prune`
// never deletes the newest good backup, so this definition is what protects the last real one.
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
        // Before the stat too, so a traversal name makes the archive not good.
        if (!isPlainArchiveFileName(file?.name)) {
          problems.push(
            `${String(file?.name)} is not a plain file name — a manifest that names a path is tampered with`,
          );
          continue;
        }
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
  // An unparseable createdAt sorts last, so `list` can still show a broken backup.
  backups.sort((a, b) => {
    const left = Number.isNaN(a.createdAtMs) ? -1 : a.createdAtMs;
    const right = Number.isNaN(b.createdAtMs) ? -1 : b.createdAtMs;
    return right - left;
  });
  return backups;
}

// From the HMAC-covered manifest body, not the id, which is cheap for an attacker to control.
export const sourceDatabaseOf = (backup) => backup?.manifest?.source?.database ?? null;

export function sourceDatabases(inventory) {
  const seen = [];
  for (const backup of inventory) {
    const source = sourceDatabaseOf(backup);
    if (!seen.includes(source)) seen.push(source);
  }
  return seen;
}

// An ambiguous directory is refused rather than resolved by timestamp. Measured, with two source
// databases in one directory, `restore` with no `--id` restored an empty newer archive of the other
// database and printed PASS. A shared store is what disaster-recovery.md §5.5 recommends.
function selectArchive(inventory, id) {
  if (id !== null && id !== undefined) {
    const found = inventory.find((backup) => backup.id === id);
    if (found === undefined) throw new BackupError(`no archive with id ${id} in this directory`);
    return found;
  }
  if (inventory.length === 0) throw new BackupError('no archives in this directory');
  const sources = sourceDatabases(inventory);
  if (sources.length > 1) {
    throw new BackupError(
      `this directory holds archives of ${sources.length} different databases ` +
        `(${sources.map((name) => name ?? '<unnamed>').join(', ')}), so "the newest archive" does not ` +
        'name one thing',
      'pass --id explicitly — `pnpm run backup list` shows every archive and its source',
    );
  }
  return inventory[0];
}

const dayBucket = (date) => date.toISOString().slice(0, 10);
const monthBucket = (date) => date.toISOString().slice(0, 7);

// ISO weeks start on Monday. Dividing epoch-milliseconds by 604800000 starts them on Thursday.
export function weekBucket(date) {
  const shifted = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoWeekday = shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay();
  shifted.setUTCDate(shifted.getUTCDate() + 4 - isoWeekday);
  const yearStart = new Date(Date.UTC(shifted.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((shifted.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${shifted.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Decides which backups the retention policy keeps, and why.
 *
 * Grandfather-father-son over UTC buckets, applied per source database. The newest good backup of
 * each source is never deleted, whatever the policy says, so an all-zero policy, a skewed clock or a
 * corrupt newest file cannot remove the last recovery. Only good backups can represent a bucket.
 *
 * It groups by source, not directory, because another host's newer archive in a shared directory
 * would otherwise plan the only copy of a database for deletion. A manifest with no source groups
 * under `null`.
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

  const groups = new Map();
  for (const backup of usable) {
    const source = sourceDatabaseOf(backup);
    const existing = groups.get(source);
    if (existing === undefined) groups.set(source, [backup]);
    else existing.push(backup);
  }

  const tiers = [
    { bucket: dayBucket, limit: policy.daily, label: 'daily' },
    { bucket: weekBucket, limit: policy.weekly, label: 'weekly' },
    { bucket: monthBucket, limit: policy.monthly, label: 'monthly' },
  ];
  for (const group of groups.values()) {
    const newestGood = group.find((backup) => backup.good === true) ?? null;
    if (newestGood !== null) note(newestGood, 'newest good backup (never deleted)');

    for (const tier of tiers) {
      const representatives = new Map();
      for (const backup of group) {
        if (backup.good !== true) continue;
        const key = tier.bucket(new Date(backup.createdAtMs));
        if (!representatives.has(key)) representatives.set(key, backup);
      }
      let kept = 0;
      for (const [key, backup] of representatives) {
        if (kept >= tier.limit) break;
        note(backup, `${tier.label} ${key}`);
        kept += 1;
      }
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

/**
 * Every reason this restore must be refused, as a list so an operator sees them all at once.
 *
 * An existing target needs `--drop-existing`. The live database needs `--overwrite-live-database`,
 * which --drop-existing does not imply, because a mistyped `--target` is the common mistake.
 * NODE_ENV=production also needs `--yes-i-am-restoring-production`.
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

async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: DIR_MODE });
  // mkdir's mode is subject to the umask and an existing directory keeps its mode.
  await chmod(directory, DIR_MODE);
}

// A `.partial` file renamed only after the tool exits 0, so an interrupted dump never sorts as the
// newest archive.
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
  // Takes the first dotted number. The last token of `16.15 (Debian 16.15-1.pgdg12+2)` is not a version.
  const versionBanner = await captureTool('pg_dump', ['--version'], ctx, undefined, true);
  const dumpVersion = (/\d+(?:\.\d+)?/.exec(versionBanner) ?? ['unknown'])[0];
  // pg_dump refuses a newer server, and a newer pg_dump writes archives an older pg_restore cannot read.
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
      // No --no-owner and no --no-privileges. RUNBOOK §11.4 measured a restore that then handed the runtime
      // role ownership of every table.
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
        // Roles and memberships are not in a single-database dump, so a fresh cluster needs this.
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
      // Reserved for a KMS-wrapped data key. Null means one static key.
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

/**
 * Four layers, each supporting a different claim.
 *
 *   1. Manifest signature, so the recorded checksums can be trusted.
 *   2. Ciphertext checksum, the keyless bit-rot check.
 *   3. Decryption to the terminator, which catches truncation and proves the plaintext digest.
 *   4. `pg_restore --list`, and with --deep a scratch restore plus a census comparison. Only --deep
 *      supports "this archive is restorable", since a dump killed mid-write decrypts perfectly.
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
  // `\bACL\b`, because table grants print as `ACL prl TABLE ...` with no dash. The dashed form matched
  // 2 of 16 entries and would pass a dump that lost every table grant.
  const acl = toc.split('\n').filter((line) => /\bACL\b/.test(line)).length;
  record(
    '4',
    entries > 0,
    entries > 0 ? `pg_restore parsed ${entries} table-of-contents entries` : 'pg_restore found no entries',
    // A dump taken with --no-privileges restores a database the API cannot read (RUNBOOK §11.4).
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
  let dropFailure = null;
  try {
    await createDatabase(ctx, scratch);
    await restoreInto(ctx, scratch, join(directory, dumpFile.name), material);
    restored = await census(ctx, scratch);
  } finally {
    // Always dropped. A failed drop leaves a plaintext copy on the cluster, so it is a recorded verdict.
    // `cross()` here only prints, and the old `.catch(cross)` let the command print PASS.
    await dropDatabase(ctx, scratch).catch((err) => {
      dropFailure = err.message;
    });
  }
  const comparison = compareCensus(backup.manifest.rowCounts, restored);
  for (const result of deepVerifyResults({
    comparison,
    dropFailure,
    scratch,
    elapsedMs: Date.now() - startedAt,
  })) {
    record(result.layer, result.ok, result.message, result.detail);
  }
  return results;
}

// Two records, so a message can never claim a drop that failed and a failed drop is never `ok`.
export function deepVerifyResults({ comparison, dropFailure, scratch, elapsedMs }) {
  const dropped = dropFailure === null || dropFailure === undefined;
  return [
    {
      layer: '4',
      ok: comparison.ok,
      message: comparison.ok
        ? `restored into a scratch database  (${seconds(elapsedMs)})`
        : 'the restored database does not carry the recorded rows',
      detail: comparison.summary,
    },
    {
      layer: '4',
      ok: dropped,
      message: dropped
        ? `dropped the scratch database ${scratch}`
        : `the scratch database ${scratch} is STILL ON THE CLUSTER`,
      detail: dropped
        ? 'no plaintext copy of the archive remains'
        : `${dropFailure} — it holds a plaintext copy of every row in this archive. Drop it by ` +
          `hand (\`DROP DATABASE ${scratch}\`) before treating this verification as done.`,
    },
  ];
}

// Fails only when a table recorded non-empty comes back empty. Other deltas are reported, because the
// census and the dump are different snapshots.
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
  // psql interpolates `:"name"` only for stdin input, not -c, so every statement is piped.
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
    // WITH (FORCE) ends other sessions, so one idle connection cannot fail the drop.
    'DROP DATABASE IF EXISTS :"name" WITH (FORCE);\n',
  );
}

async function restoreInto(ctx, database, encryptedPath, material) {
  const run = startTool(
    'pg_restore',
    [
      '--dbname',
      database,
      // RUNBOOK §11.4 measured the alternative, "errors ignored on restore: 20" and the wrong owner.
      '--exit-on-error',
      // Restored or untouched, and a rollback gives --exit-on-error its meaning.
      '--single-transaction',
    ],
    ctx,
    { stdin: 'pipe' },
  );
  await feedTool(run, decryptFrames(createReadStream(encryptedPath), { material }));
}

/**
 * Removes the `GRANTED BY <role>` clause from role-membership grants.
 *
 * PostgreSQL 16 dumps the source cluster's grantor, `poker`, and a fresh cluster refuses it even
 * for a superuser. Measured on postgres:16-bookworm, `restore --with-globals` failed with
 * `permission denied to grant privileges as role "poker"` and left five roles with no memberships.
 * Without the clause the restoring superuser is the grantor. Only lines that begin a GRANT change.
 */
export function neutraliseGrantedBy(sqlText) {
  let stripped = 0;
  const out = sqlText
    .split('\n')
    .map((line) => {
      if (!/^\s*GRANT\s/i.test(line)) return line;
      const rewritten = line.replace(/\s+GRANTED\s+BY\s+(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)(?=\s*;)/i, '');
      if (rewritten !== line) stripped += 1;
      return rewritten;
    })
    .join('\n');
  return { sql: out, stripped };
}

const MAX_GLOBALS_BYTES = 8 * 1024 * 1024;

async function applyGlobals(ctx, encryptedPath, material) {
  // Buffered, because a globals dump is kilobytes (1.9 KiB here) and must be rewritten before psql.
  const parts = [];
  let bytes = 0;
  for await (const chunk of decryptFrames(createReadStream(encryptedPath), { material })) {
    bytes += chunk.length;
    if (bytes > MAX_GLOBALS_BYTES) {
      throw new BackupError(
        `the globals payload is over ${humanBytes(MAX_GLOBALS_BYTES)}`,
        'a `pg_dumpall --globals-only` of this cluster is kilobytes; this archive is not one',
      );
    }
    parts.push(chunk);
  }
  const { sql, stripped } = neutraliseGrantedBy(Buffer.concat(parts).toString('utf8'));
  if (stripped > 0) {
    bang(
      `rewrote ${stripped} role-membership grant(s) to drop GRANTED BY`,
      'the grantor becomes the identity running this restore; PostgreSQL 16 refuses the recorded ' +
        'one on any cluster that did not create the role — see `neutraliseGrantedBy`',
    );
  }
  // --single-transaction, or a failure leaves some roles and some memberships.
  const run = startTool('psql', psqlArgs(ctx.maintenanceDatabase, ['--single-transaction']), ctx, {
    stdin: 'pipe',
  });
  await feedTool(run, [Buffer.from(sql, 'utf8')]);
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

async function commandList(options, _ctx, material, directory) {
  say(bold('\nbackup list'));
  say(dim(`  directory ${directory.path}  (from ${directory.source})\n`));
  const inventory = await readInventory(directory.path, material);
  const policy = { daily: options.daily, weekly: options.weekly, monthly: options.monthly };
  const plan = selectForRetention(inventory, policy);
  const keptIds = new Map(plan.keep.map((backup) => [backup.id, backup.reasons]));

  for (const backup of inventory) {
    const reasons = keptIds.get(backup.id);
    // Retention and restore are per database, so each line shows its source.
    const label = `${backup.id}  ${humanBytes(backup.bytes)}  ${dim(
      `of ${sourceDatabaseOf(backup) ?? '<unnamed>'}`,
    )}`;
    if (!backup.good) bang(label, backup.problems.join('; '));
    else if (reasons === undefined) say(`  ${dim('·')} ${label}  ${dim('would be pruned')}`);
    else tick(label, reasons.join(', '));
  }

  say(bold('\n  Summary'));
  say(`    archives    ${inventory.length}`);
  say(`    good        ${inventory.filter((backup) => backup.good).length}`);
  say(`    on disk     ${humanBytes(inventory.reduce((sum, backup) => sum + backup.bytes, 0))}`);
  say(`    policy      ${policy.daily} daily / ${policy.weekly} weekly / ${policy.monthly} monthly`);
  say(
    `    sources     ${
      sourceDatabases(inventory)
        .map((n) => n ?? '<unnamed>')
        .join(', ') || '(none)'
    }`,
  );
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

  // Every name in the whole delete set is checked before any unlink, in plan mode too. A path name is
  // evidence of tampering, so it fails the command and leaves the directory as the attacker left it.
  const offences = unsafeArchiveFileNames(plan.delete);
  if (offences.length > 0) {
    for (const offence of offences) {
      cross(
        `${offence.id} names a payload that is not a plain file name: ${offence.name}`,
        `--apply would have deleted ${join(directory.path, offence.name)}; ` +
          `${offence.manifestPath} has been tampered with`,
      );
    }
    say(`\n  ${red(bold('FAIL'))} prune — nothing was deleted\n`);
    say(
      dim(
        '  Do not run this with --apply. Somebody who can write to the archive directory wrote a\n' +
          '  path traversal into a manifest; treat the whole directory as untrusted and look at\n' +
          '  who has write access to it before anything else.\n',
      ),
    );
    if (options.json) console.log(JSON.stringify({ policy, applied: false, offences }));
    return 1;
  }

  for (const backup of plan.delete) {
    if (options.apply) {
      const names = (backup.manifest?.files ?? []).map((file) => file.name);
      for (const name of names) {
        // A throw, not a skip, in case the gate above ever moves.
        if (!isPlainArchiveFileName(name)) {
          throw new BackupError(
            `refusing to delete ${String(name)} named by ${backup.manifestPath}`,
            'it is not a plain file name, so it does not name a file in the archive directory',
          );
        }
        await rm(join(directory.path, name), { force: true });
      }
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
  if (inventory.length > 0 && survivors === 0) {
    cross('no good backup survives this prune', 'the directory contained none — nothing was protected');
    say(`\n  ${red(bold('FAIL'))} prune\n`);
    return 1;
  }
  say(`\n  ${green(bold('PASS'))} ${options.apply ? 'prune applied' : 'prune plan (nothing deleted)'}`);
  // Per source database, see `selectForRetention`.
  say(
    dim(
      '\n  The newest good backup OF EVERY SOURCE DATABASE is never in the delete set, whatever\n' +
        `  the policy says. Sources here: ${
          sourceDatabases(inventory)
            .map((n) => n ?? '<unnamed>')
            .join(', ') || '(none)'
        }\n`,
    ),
  );
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

async function run(options) {
  quiet = options.quiet;
  if (options.command === 'keygen') return commandKeygen();

  const directory = resolveDirectory(process.env, options.dir);
  const material = await resolveKey(process.env, options.keyFile);

  // `list`, `prune` and `verify` without --deep never connect, so an offsite archive can be inspected
  // without DATABASE_URL.
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
  // No fallthrough, so a new command without a branch fails loudly.
  throw new BackupError(`command ${options.command} has no implementation`);
}

// Tests import the pure halves, and this keeps the import from running `main()`.
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
