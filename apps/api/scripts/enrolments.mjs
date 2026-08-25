#!/usr/bin/env node

/**
 * enrolments.mjs — the operator tool for cohorts and entitlements.
 *
 *   pnpm run enrolments cohorts
 *   pnpm run enrolments cohort-create --key spring-2026 --name "Spring 2026" --starts 2026-03-02 \
 *                                     --ends 2026-06-26
 *   pnpm run enrolments grant  --cohort spring-2026 --by "J. Okafor" --reference PO-4471 \
 *                              --expires 2026-06-26 --file class.txt
 *   pnpm run enrolments revoke --cohort spring-2026 --by "J. Okafor" --reason "place transferred" \
 *                              --user usr_...
 *   pnpm run enrolments list   --cohort spring-2026 [--all]
 *   pnpm run enrolments show   --user usr_...
 *
 * ############################################################################
 * ## THERE IS DELIBERATELY NO HTTP ADMIN API. THIS IS THE DECISION, NOT AN  ##
 * ## OMISSION, AND IT IS THE REASON THIS FILE EXISTS AT ALL.                ##
 * ############################################################################
 *
 * The obvious shape for this would have been `POST /admin/enrolments` behind a new role. It was
 * considered and rejected, at the end of a hardening run, for four reasons that are worth writing
 * down because the next person will think of it too:
 *
 *  1. **It is a new privilege level, and this product has never had one.** `prl.users.kind` is
 *     `'guest' | 'oidc'` and nothing else; there is no admin, no instructor, no staff flag. An
 *     authenticated surface that can grant access to a paid cohort needs an authorisation model, a
 *     way to appoint the people who hold it, a way to remove them, and an answer for what happens
 *     when one of their sessions is stolen. Every one of those is a design, and none of them can be
 *     done well in the last week before a cohort starts.
 *  2. **The attack surface is permanent and the audience is thirty people.** A route is reachable
 *     by everybody on the internet forever; the tool below is reachable by whoever already has the
 *     migrating credential and a shell. For a class of thirty enrolled a few times a year, a route
 *     is an enormous amount of new exposed surface for an operation that happens rarely.
 *  3. **The database says the same thing, so this is enforced rather than promised.**
 *     `db/migrations/0006` grants `prl_app` — the role the API connects as — SELECT and nothing
 *     else on `prl.cohorts` and `prl.enrolments`. So an injection that reaches the request path
 *     cannot enrol anybody, cannot extend its own access and cannot erase a revocation, and that
 *     is true whatever any future route handler tries to do. Adding the route would mean widening
 *     that grant, which is the part that would actually cost something.
 *  4. **Least authority beats most convenience here.** Everything this tool does is rare,
 *     deliberate and done by somebody who can already reach the database. A CLI is exactly the
 *     right amount of ceremony for that; a web form is the wrong amount.
 *
 * If a route is ever genuinely needed — self-service enrolment, say — this comment is not an
 * argument against it. It is a record that the absence was chosen, so that whoever adds one starts
 * by designing the authorisation model rather than by assuming nobody had thought about it.
 *
 * ## Design, following apps/api/scripts/migrate.mjs
 *
 * **Every SQL statement is in the repository, not here.** `apps/api/src/repositories/enrolments.ts`
 * holds the window arithmetic, the supersede-then-insert order and the audit writes; this file
 * parses arguments, resolves identifiers and prints. A second copy of the grant statement in a
 * script is how an operator tool and a request path come to disagree about who is entitled.
 *
 * **It connects as the migrating identity.** `DATABASE_MIGRATION_URL`, falling back to
 * `DATABASE_URL`, exactly as `migrate.mjs` does — and for a sharper reason: `DATABASE_URL` names a
 * member of `prl_app`, which holds SELECT only on both tables, so `grant` and `revoke` through it
 * fail with `permission denied`. The reads work either way.
 *
 * **Nothing secret is ever printed.** The connection string is read from the environment, never
 * echoed, and every line — including errors thrown from inside the driver — goes through the same
 * redactor `migrate.mjs` uses.
 *
 * **A bulk grant is one transaction.** Thirty enrolments and their thirty audit entries commit
 * together or not at all, so a terminal closed halfway through leaves a class either wholly
 * enrolled or wholly not, and never a state nobody can describe.
 *
 * **An identifier that resolves to nobody stops the run before anything is written.** A class list
 * with a typo in it is the normal case, and the useless behaviour is to enrol twenty-nine people
 * and mention the thirtieth in passing. `--skip-unknown` is the explicit way to say "go ahead
 * without them", and it names each one that was skipped.
 */

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import * as enrolments from '../src/repositories/enrolments.ts';

const COMMANDS = ['cohorts', 'cohort-create', 'grant', 'revoke', 'list', 'show'];

// ---------------------------------------------------------------------------
// Output. Colour only when a human is watching. Copied from migrate.mjs on
// purpose: two operator tools in one repository that format differently are two
// things to learn, and the redactor in particular must not be reimplemented.
// ---------------------------------------------------------------------------

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, text) => (NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`);
const red = (text) => paint('31', text);
const green = (text) => paint('32', text);
const yellow = (text) => paint('33', text);
const dim = (text) => paint('2', text);
const bold = (text) => paint('1', text);

/**
 * Strips anything that could be a credential from a string before it is printed.
 * Driver errors are written by code this script does not own, so they go through here too.
 */
function redact(value) {
  return String(value ?? '')
    .replace(/\b(?:postgres|postgresql):\/\/\S*/gi, 'postgres://[redacted]')
    .replace(/\bpassword=[^\s&;'"]*/gi, 'password=[redacted]');
}

const line = (text = '') => console.log(redact(text));
const note = (text) => line(`${dim('  ·')} ${text}`);
const ok = (text) => line(`${green('  ✓')} ${text}`);
const warn = (text) => line(`${yellow('  !')} ${text}`);

/** An error with a message meant for a human, printed without a stack trace. */
class OperatorError extends Error {
  name = 'OperatorError';
}

/**
 * What each schema constraint means to the person who just typed a command.
 *
 * Not in `VIOLATION_CODES` in `repositories/sql.ts`, and deliberately: that map turns a constraint
 * into a wire code for an HTTP client, and none of these has a wire. What an operator needs is the
 * sentence, and the sentence is different from the 23514 the driver prints — the first one that
 * happened in real use was `--expires 2026-06-26` typed after that date had passed, which reports
 * itself as "violates check constraint enrolments_expiry_after_start" and a dump of the row.
 */
const CONSTRAINT_HELP = {
  enrolments_expiry_after_start:
    '--expires is not after the start of the enrolment. An expiry already in the past is the ' +
    'usual cause: the enrolment starts now unless --starts says otherwise.',
  enrolments_granted_by_shape: '--by must be 2 to 128 characters with no surrounding whitespace.',
  enrolments_reference_shape: '--reference must be 1 to 200 characters with no surrounding whitespace.',
  enrolments_revoked_reason_shape: '--reason must be 1 to 200 characters with no surrounding whitespace.',
  cohorts_key_shape: '--key must be 3 to 64 lowercase characters, digits and single hyphens.',
  cohorts_name_shape: '--name must be 2 to 120 characters with no surrounding whitespace.',
  cohorts_period_ordered: '--ends must be after --starts.',
  cohorts_key_key: '--key is already taken by another cohort. `cohorts` lists them.',
};

// ---------------------------------------------------------------------------
// Environment and connection.
// ---------------------------------------------------------------------------

/**
 * The connection string, preferring the migration identity over the runtime one.
 *
 * See the file header: the runtime identity can read these tables and cannot write them, so a
 * `grant` run with only `DATABASE_URL` set will fail at the first INSERT with `permission denied`.
 * That is the privilege model working; the message below is what makes it legible.
 */
function databaseUrl() {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  if (typeof migrationUrl === 'string' && migrationUrl.trim() !== '') return migrationUrl;

  const url = process.env.DATABASE_URL;
  if (typeof url !== 'string' || url.trim() === '') {
    throw new OperatorError(
      [
        'Neither DATABASE_MIGRATION_URL nor DATABASE_URL is set, so there is no database to reach.',
        '',
        'Point one at the database with a libpq URL of the form',
        '  <postgres|postgresql>://<user>:<password>@<host>:5432/<database>',
        '',
        'either exported in your shell or as a line in .env at the repo root. Writing an enrolment',
        'needs the MIGRATING identity: prl_app holds SELECT and nothing else on prl.enrolments, on',
        'purpose, so that no request path can grant anybody anything.',
      ].join('\n'),
    );
  }
  return url;
}

function connect(url) {
  return postgres(url, {
    max: 1,
    connect_timeout: 15,
    connection: { application_name: 'prl-enrolments' },
    onnotice: (notice) => {
      const message = notice?.message;
      if (typeof message === 'string' && message !== '') note(`postgres: ${message}`);
    },
  });
}

// ---------------------------------------------------------------------------
// Argument parsing.
// ---------------------------------------------------------------------------

/** Options that take a value, and the ones that are bare flags. Anything else is refused. */
const VALUE_OPTIONS = new Set([
  'cohort',
  'key',
  'name',
  'starts',
  'ends',
  'expires',
  'by',
  'reference',
  'reason',
  'user',
  'file',
]);
const FLAG_OPTIONS = new Set(['all', 'dry-run', 'skip-unknown', 'help']);

/**
 * `--key value`, `--key=value` and repeatable `--user`.
 *
 * Deliberately not a general-purpose parser: an unknown option is refused rather than ignored,
 * because a typo in `--refernce` on a grant would otherwise write thirty rows with an empty
 * reference and no way to tell which run they came from.
 */
export function parseArgs(argv) {
  const options = { command: null, users: [], flags: new Set(), values: new Map() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h') {
      options.flags.add('help');
      continue;
    }
    if (!arg.startsWith('--')) {
      if (options.command !== null) {
        throw new OperatorError(`Unexpected argument "${arg}". One command at a time.`);
      }
      options.command = arg;
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    const name = equals === -1 ? body : body.slice(0, equals);
    if (FLAG_OPTIONS.has(name)) {
      if (equals !== -1) throw new OperatorError(`Option --${name} takes no value.`);
      options.flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new OperatorError(`Unknown option "--${name}". Try --help.`);
    let value;
    if (equals === -1) {
      value = argv[index + 1];
      index += 1;
    } else {
      value = body.slice(equals + 1);
    }
    if (value === undefined || value.startsWith('--')) {
      throw new OperatorError(`Option --${name} needs a value.`);
    }
    if (name === 'user') options.users.push(value);
    else options.values.set(name, value);
  }
  return options;
}

function required(options, name, why) {
  const value = options.values.get(name);
  if (value === undefined || value.trim() === '') {
    throw new OperatorError(`--${name} is required: ${why}`);
  }
  return value.trim();
}

/**
 * An ISO 8601 instant or a plain `YYYY-MM-DD` date, refused rather than guessed at.
 *
 * A plain date is read as UTC midnight, which is what `Date` does with it and what an operator
 * writing `--ends 2026-06-26` means closely enough. Anything `Date` cannot parse is refused: a
 * silent `Invalid Date` would reach the database as NULL and produce an entitlement with no end.
 */
export function parseInstant(raw, what) {
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new OperatorError(
      `${what} "${raw}" is not a date this can read. Use an ISO instant (2026-06-26T17:00:00Z) or ` +
        'a plain date (2026-06-26), which is read as UTC midnight.',
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Identifiers.
// ---------------------------------------------------------------------------

/**
 * The identifiers to act on: `--user` repeated, `--file <path>`, or `--file -` for stdin.
 *
 * The file format is one identifier per line; blank lines and `#` comments are ignored, so a class
 * list can carry the name of the class and where it came from. Duplicates are collapsed, in first
 * appearance order, because a list assembled by hand from two other lists usually has some.
 */
async function identifiersFor(options) {
  const collected = [...options.users];
  const file = options.values.get('file');
  if (file !== undefined) {
    const text = file === '-' ? await readStdin() : await readFile(file, 'utf8');
    for (const raw of text.split('\n')) {
      const trimmed = raw.split('#')[0].trim();
      if (trimmed !== '') collected.push(trimmed);
    }
  }
  if (collected.length === 0) {
    throw new OperatorError(
      'No identifiers. Pass --user <id> (repeatable), --file <path> with one per line, or --file - ' +
        'to read them from standard input.',
    );
  }
  return [...new Set(collected)];
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Turns operator-supplied identifiers into account ids, or refuses.
 *
 * Two kinds are accepted, and which one an identifier is decided by its shape rather than by a
 * flag: anything starting `usr_` is an account id, and everything else is looked up as an OIDC
 * subject — the identifier an institution's identity provider issues, which is the one an operator
 * enrolling a class actually has.
 *
 * ## Ambiguity is refused, never resolved
 *
 * A subject is unique only WITHIN an issuer (`users_oidc_identity_key` is on the pair), so the same
 * subject string can legitimately name two people from two providers. Picking one would enrol the
 * wrong person, and the wrong person in a paid cohort is exactly the mistake nobody notices until
 * somebody is refused. So an ambiguous identifier is reported with both account ids and the run
 * stops.
 */
async function resolveIdentifiers(sql, identifiers) {
  const rows = await sql`
    select id, display_name, kind, oidc_issuer, oidc_subject
      from prl.users
     where id = any(${identifiers}::text[])
        or oidc_subject = any(${identifiers}::text[])
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const bySubject = new Map();
  for (const row of rows) {
    if (row.oidc_subject === null) continue;
    const existing = bySubject.get(row.oidc_subject) ?? [];
    existing.push(row);
    bySubject.set(row.oidc_subject, existing);
  }

  const resolved = [];
  const unknown = [];
  const ambiguous = [];
  for (const identifier of identifiers) {
    const direct = byId.get(identifier);
    if (direct !== undefined) {
      resolved.push({ identifier, user: direct });
      continue;
    }
    const candidates = bySubject.get(identifier) ?? [];
    if (candidates.length === 1) {
      resolved.push({ identifier, user: candidates[0] });
      continue;
    }
    if (candidates.length > 1) {
      ambiguous.push({ identifier, candidates });
      continue;
    }
    unknown.push(identifier);
  }
  return { resolved, unknown, ambiguous };
}

/**
 * Prints what could not be resolved and decides whether the run continues.
 *
 * Ambiguity always stops the run — there is no flag for it, because there is no safe guess. An
 * unknown identifier stops it unless `--skip-unknown` says otherwise.
 */
function refuseUnresolved(options, resolution) {
  for (const { identifier, candidates } of resolution.ambiguous) {
    warn(`"${identifier}" names ${candidates.length} accounts: ${candidates.map((c) => c.id).join(', ')}`);
  }
  if (resolution.ambiguous.length > 0) {
    throw new OperatorError(
      `${resolution.ambiguous.length} identifier(s) name more than one account. An OIDC subject is ` +
        'unique only within its issuer. Use the usr_ id shown above for the person you mean.',
    );
  }
  if (resolution.unknown.length === 0) return;
  for (const identifier of resolution.unknown) warn(`no account matches "${identifier}"`);
  if (!options.flags.has('skip-unknown')) {
    throw new OperatorError(
      `${resolution.unknown.length} identifier(s) match no account, so nothing has been written. ` +
        'An identifier is a usr_ id or an OIDC subject; somebody who has never signed in has ' +
        'neither. Fix the list, or re-run with --skip-unknown to enrol the rest and be told again ' +
        'which ones were left out.',
    );
  }
  note(`--skip-unknown: continuing without ${resolution.unknown.length} identifier(s)`);
}

// ---------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------

const iso = (value) => (value === null || value === undefined ? '—' : value.toISOString());

/** One enrolment as one line: what it is, who said so, and whether it is live right now. */
function describeEnrolment(record) {
  const who = record.displayName === null ? record.userId : `${record.displayName} (${record.userId})`;
  const state =
    record.revokedAt !== null
      ? red(`revoked ${iso(record.revokedAt)} by ${record.revokedBy}: ${record.revokedReason}`)
      : record.entitledNow
        ? green(`entitled until ${iso(record.effectiveUntil)}`)
        : yellow(`not entitled (window ${iso(record.effectiveFrom)} .. ${iso(record.effectiveUntil)})`);
  return `  ${who}\n      ${state}\n      ${dim(
    `granted ${iso(record.grantedAt)} by ${record.grantedBy}, reference ${record.reference}`,
  )}`;
}

function describeCohort(cohort) {
  const ends = cohort.endsAt === null ? 'no scheduled end' : `ends ${iso(cohort.endsAt)}`;
  return `  ${bold(cohort.key)}  ${cohort.name}\n      ${dim(`starts ${iso(cohort.startsAt)}, ${ends}`)}`;
}

/** The cohort named by `--cohort`, or a refusal that lists what does exist. */
async function requireCohort(sql, options) {
  const key = required(options, 'cohort', 'which cohort this is about, by its key');
  const cohort = await enrolments.cohortByKey(sql, key);
  if (cohort === null) {
    const all = await enrolments.listCohorts(sql);
    const known = all.length === 0 ? '(none exist yet)' : all.map((c) => c.key).join(', ');
    throw new OperatorError(`No cohort with key "${key}". Known keys: ${known}`);
  }
  return cohort;
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

async function commandCohorts(sql) {
  const all = await enrolments.listCohorts(sql);
  if (all.length === 0) {
    note('no cohorts exist yet — create one with `cohort-create`');
    return;
  }
  line(`${bold('Cohorts')} (${all.length})`);
  for (const cohort of all) line(describeCohort(cohort));
}

async function commandCohortCreate(sql, options) {
  const key = required(options, 'key', 'the stable handle operators will type, e.g. spring-2026');
  const name = required(options, 'name', 'what a human calls this class');
  const startsAt = parseInstant(required(options, 'starts', 'when the class begins'), '--starts');
  const endsRaw = options.values.get('ends');
  const endsAt = endsRaw === undefined ? null : parseInstant(endsRaw, '--ends');

  const cohort = await sql.begin((tx) => enrolments.createCohort(tx, { key, name, startsAt, endsAt }));
  ok(`created ${cohort.key} (${cohort.id})`);
  line(describeCohort(cohort));
  if (endsAt === null) {
    warn(
      'this cohort has no end date, so an enrolment in it with no --expires entitles somebody ' +
        'indefinitely. That may be right; it is worth having decided it.',
    );
  }
}

async function commandGrant(sql, options) {
  const cohort = await requireCohort(sql, options);
  const grantedBy = required(options, 'by', 'on whose authority this is granted');
  const reference = required(options, 'reference', 'the external reference this grant rests on');
  const startsRaw = options.values.get('starts');
  const expiresRaw = options.values.get('expires');
  const startsAt = startsRaw === undefined ? null : parseInstant(startsRaw, '--starts');
  const expiresAt = expiresRaw === undefined ? null : parseInstant(expiresRaw, '--expires');

  const identifiers = await identifiersFor(options);
  const resolution = await resolveIdentifiers(sql, identifiers);
  refuseUnresolved(options, resolution);

  line(
    `${bold('Granting')} ${resolution.resolved.length} enrolment(s) in ${cohort.key} ` +
      `${dim(`by ${grantedBy}, reference ${reference}`)}`,
  );
  if (options.flags.has('dry-run')) {
    for (const { user } of resolution.resolved) note(`would enrol ${user.display_name} (${user.id})`);
    warn('--dry-run: nothing was written');
    return;
  }

  // One transaction for the whole list. Thirty rows and their thirty audit entries land together,
  // so a closed terminal leaves a class either wholly enrolled or wholly not.
  const outcomes = await sql.begin(async (tx) => {
    const results = [];
    for (const { user } of resolution.resolved) {
      const outcome = await enrolments.grant(tx, {
        cohortId: cohort.id,
        userId: user.id,
        grantedBy,
        reference,
        startsAt,
        expiresAt,
      });
      results.push({ user, outcome });
    }
    return results;
  });

  let granted = 0;
  let already = 0;
  for (const { user, outcome } of outcomes) {
    const who = `${user.display_name} (${user.id})`;
    if (outcome.outcome === 'granted') {
      granted += 1;
      const superseded =
        outcome.supersededId === null ? '' : dim(` (replacing expired ${outcome.supersededId})`);
      ok(`${who}${superseded}`);
    } else {
      already += 1;
      note(`${who} already holds an enrolment in ${cohort.key}; left alone`);
    }
  }
  line();
  note(`${granted} granted, ${already} already enrolled, ${resolution.unknown.length} unknown`);
}

async function commandRevoke(sql, options) {
  const cohort = await requireCohort(sql, options);
  const revokedBy = required(options, 'by', 'on whose authority this is withdrawn');
  const reason = required(options, 'reason', 'why — this is the column worth most six months later');

  const identifiers = await identifiersFor(options);
  const resolution = await resolveIdentifiers(sql, identifiers);
  refuseUnresolved(options, resolution);

  line(`${bold('Revoking')} ${resolution.resolved.length} enrolment(s) in ${cohort.key} ${dim(reason)}`);
  if (options.flags.has('dry-run')) {
    for (const { user } of resolution.resolved) note(`would revoke ${user.display_name} (${user.id})`);
    warn('--dry-run: nothing was written');
    return;
  }

  const outcomes = await sql.begin(async (tx) => {
    const results = [];
    for (const { user } of resolution.resolved) {
      const record = await enrolments.revoke(tx, {
        cohortId: cohort.id,
        userId: user.id,
        revokedBy,
        reason,
      });
      results.push({ user, record });
    }
    return results;
  });

  let revoked = 0;
  let nothing = 0;
  for (const { user, record } of outcomes) {
    if (record === null) {
      nothing += 1;
      note(`${user.display_name} (${user.id}) held no live enrolment in ${cohort.key}`);
      continue;
    }
    revoked += 1;
    ok(`${user.display_name} (${user.id}) — ${record.id}`);
  }
  line();
  note(`${revoked} revoked, ${nothing} had nothing to revoke`);
}

async function commandList(sql, options) {
  const cohort = await requireCohort(sql, options);
  const includeRevoked = options.flags.has('all');
  const rows = await enrolments.listForCohort(sql, cohort.id, { includeRevoked });
  line(describeCohort(cohort));
  line();
  if (rows.length === 0) {
    note(includeRevoked ? 'no enrolments at all' : 'nobody is enrolled — add --all to see revoked ones');
    return;
  }
  for (const record of rows) line(describeEnrolment(record));
  line();
  const live = rows.filter((record) => record.entitledNow).length;
  note(`${rows.length} enrolment(s) listed, ${live} entitled right now`);
}

async function commandShow(sql, options) {
  const identifiers = await identifiersFor(options);
  if (identifiers.length !== 1) {
    throw new OperatorError('`show` is about one person. Pass a single --user.');
  }
  const resolution = await resolveIdentifiers(sql, identifiers);
  refuseUnresolved(options, resolution);
  const found = resolution.resolved[0];
  if (found === undefined) {
    note('nothing to show');
    return;
  }
  const { user } = found;
  line(`${bold(user.display_name)} ${dim(`${user.id} · ${user.kind}`)}`);

  const entitlement = await enrolments.entitlementFor(sql, user.id);
  if (entitlement === null) {
    line(`  ${yellow('not entitled right now')}`);
  } else {
    const until = entitlement.until === null ? 'no recorded end' : `until ${iso(entitlement.until)}`;
    line(`  ${green(`entitled via ${entitlement.cohortKey}, ${until}`)}`);
  }

  const history = await enrolments.forUser(sql, user.id);
  line();
  if (history.length === 0) {
    note('no enrolments, ever');
    return;
  }
  for (const record of history) {
    line(`  ${bold(record.cohortKey)}`);
    line(describeEnrolment(record));
  }
  note(`${history.length} enrolment(s) in total, including withdrawn ones`);
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function usage() {
  line(`${bold('enrolments.mjs')} — Poker Risk Lab cohorts and entitlements`);
  line();
  line('  cohorts                                       list every cohort');
  line('  cohort-create --key K --name N --starts D     create one; --ends D is optional');
  line('  grant  --cohort K --by WHO --reference REF    enrol people; --starts/--expires optional');
  line('  revoke --cohort K --by WHO --reason WHY       withdraw entitlements');
  line('  list   --cohort K [--all]                     who is in a cohort; --all shows revoked');
  line('  show   --user ID                              one person: entitled now, and every record');
  line();
  line('  Who to act on, for grant/revoke/show:');
  line('    --user ID          an account id (usr_...) or an OIDC subject. Repeatable');
  line('    --file PATH        one identifier per line; # comments and blank lines ignored');
  line('    --file -           read that list from standard input');
  line('    --skip-unknown     enrol the rest when some identifiers match no account');
  line('    --dry-run          resolve and report, write nothing');
  line();
  line(`${dim('  DATABASE_MIGRATION_URL')}   the migrating identity. Required to WRITE: prl_app holds`);
  line(`${dim('                          ')}   SELECT only on prl.enrolments, on purpose`);
  line(`${dim('  DATABASE_URL')}             fallback; never printed`);
  line();
  line(dim('  There is deliberately no HTTP admin API. The reasoning is at the top of this file.'));
}

/** True for the commands that write, which is what decides whether the target is announced. */
const WRITING = new Set(['cohort-create', 'grant', 'revoke']);

async function run(options) {
  const sql = connect(databaseUrl());
  try {
    if (WRITING.has(options.command)) {
      // Named from the server rather than parsed out of the connection string, so nothing secret
      // is anywhere near this line. `migrate.mjs` does the same before it applies role files: an
      // operator about to write should be able to see which database is about to be written to.
      const [target] = await sql`select current_database() as database, current_user as role`;
      line(`${bold('Target')} database "${target.database}" as "${target.role}"`);
    }
    if (options.command === 'cohorts') await commandCohorts(sql);
    else if (options.command === 'cohort-create') await commandCohortCreate(sql, options);
    else if (options.command === 'grant') await commandGrant(sql, options);
    else if (options.command === 'revoke') await commandRevoke(sql, options);
    else if (options.command === 'list') await commandList(sql, options);
    else if (options.command === 'show') await commandShow(sql, options);
    // No `else` fallthrough, for migrate.mjs's reason: a command added to COMMANDS without a
    // branch here must fail rather than silently running whichever one happened to be last.
    else throw new OperatorError(`Command "${options.command}" has no implementation.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.flags.has('help') || options.command === null) {
    usage();
    return;
  }
  if (!COMMANDS.includes(options.command)) {
    throw new OperatorError(`Unknown command "${options.command}". Expected one of: ${COMMANDS.join(', ')}.`);
  }
  await run(options);
}

/**
 * True when this file was started from the command line rather than imported.
 *
 * `parseArgs` and `parseInstant` are exported so `enrolments-cli.test.mjs` can assert on them
 * without a database — an argument parser that silently accepts `--refernce` would write thirty
 * rows with no reference, and that is a behaviour, so it gets a test. Without this guard the
 * import would run `main()` as a side effect.
 */
function startedFromCommandLine() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedFromCommandLine()) {
  try {
    await main();
  } catch (error) {
    line();
    if (error instanceof OperatorError) {
      line(`${red('  ✗')} ${error.message}`);
    } else {
      const help = CONSTRAINT_HELP[error?.constraint_name];
      line(`${red('  ✗')} ${help ?? error?.message ?? String(error)}`);
      if (help !== undefined) {
        // The raw message stays, dimmed and after the sentence: an operator who needs to search
        // for the constraint name has it, and one who does not never has to read it. The driver's
        // `detail` is deliberately NOT printed here — on a check violation it is a dump of the
        // whole failing row, which puts every value of the attempted grant in a terminal for no
        // benefit once the sentence above has explained the problem.
        note(dim(`${error.constraint_name}: ${error?.message ?? ''}`));
      } else {
        const detail = [error?.detail, error?.hint, error?.where].filter(Boolean).join(' | ');
        if (detail !== '') note(detail);
      }
      if (process.env.PRL_DEBUG) console.error(redact(error?.stack ?? String(error)));
    }
    line();
    process.exitCode = 1;
  }
}
