#!/usr/bin/env node
/**
 * Gate: no credential material in the repository, and no way for one to get in
 * by accident.
 *
 * Two independent release reviews of this project recorded "standalone secret
 * scanning is unavailable" as an open gap, on the grounds that no `gitleaks` or
 * `trufflehog` binary exists on the machine. Depending on a binary that may or
 * may not be installed is exactly the shape the rest of this directory refuses:
 * `container-scan.mjs` fails closed when trivy is missing rather than skipping,
 * and every other gate here is dependency-free on purpose, because a
 * supply-chain checker that installs a package to do its job is checking the
 * thing it depends on. So this gate is written the same way — Node standard
 * library, no network, no external tool — and it therefore runs everywhere the
 * repository runs.
 *
 * ## The two questions, and why the second one matters more
 *
 * **1. Does a tracked file contain a credential?** This is what a secret scanner
 * is usually asked. It is the smaller half.
 *
 * **2. Can a credential become tracked by accident?** Every real secret in this
 * deployment already exists on somebody's disk — `.env`, the staging CA's private
 * key under `deploy/staging/tls/`, the backup identity's `backup.env` holding
 * `PRL_BACKUP_KEY`, which decrypts every archive ever taken. None of them are
 * committed. They stay uncommitted because of `.gitignore` entries, and an entry
 * that was never written looks exactly like an entry that works: the file is
 * absent from `git status` either way, right up until somebody runs `git add -A`
 * on the host where the file exists.
 *
 * That is not hypothetical here. This gate was written after finding that
 * `deploy/backup/backup.env` — the file `deploy/backup/README.md` tells an
 * operator to create, containing the archive encryption key and the backup
 * role's database password — was matched by no ignore rule at all, while
 * `.env` and `deploy/staging/tls/` were both covered. One `git add -A` on a
 * backup host would have committed the key that decrypts every backup, and
 * question 1 could never have found it, because on the machine where this gate
 * runs the file does not exist.
 *
 * So the second check asserts the *rules*, not the *files*: for every path this
 * deployment is documented to create, `git check-ignore --no-index` must say the
 * ignore rules match it, whether or not anything is there today.
 *
 * ## Findings are printed redacted, and that is not a nicety
 *
 * A scanner that prints the secret it found has published it a second time, into
 * CI logs that are usually retained longer and read more widely than the file
 * was. Findings here carry the path, the line, the detector, and the first four
 * characters with the length — enough to find it, not enough to use it.
 *
 * ## What suppresses a finding, and why it is not an expiring allowlist
 *
 * `container-allowlist.json` and `osv-allowlist.json` take entries with a
 * reason, an approver and an expiry, and this gate deliberately does NOT copy
 * that shape. Those files record a decision to ship a real finding anyway, until
 * a date. A false positive here is a different thing: a documented example token
 * in a runbook, or a fixture that must *look* like a credential to test the code
 * that rejects one, is not an exception to policy that should lapse in ninety
 * days — it is a line that never held a credential in the first place.
 *
 * So the suppression is an inline pragma, on the finding's line or the line
 * above it:
 *
 *     const EXAMPLE = 'ghp_0000000000000000000000000000000000';  // prl-allow-secret: docs fixture, not a real token
 *
 * The reason text is mandatory — a bare pragma fails the gate.
 *
 * ### The two placements are NOT equivalent, and this used to claim they were
 *
 * This paragraph used to say the pragma "travels with the line, so a copy of that
 * line pasted into real code arrives carrying a visible claim about itself that a
 * reviewer can check". That is true of the SAME-LINE form and false of the
 * PRECEDING-LINE form, and the difference had a consequence:
 *
 *     // prl-allow-secret: the fixture below is fake
 *     const FIXTURE='ghp_0000…'; const REAL='ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
 *
 * Both were suppressed. Nothing on the second line carries any claim at all, so a
 * real token appended to an already-blessed line inherited a blessing written for
 * something else, silently, and the line that a reviewer would have to notice
 * looks exactly like the line they approved.
 *
 * So the two forms now have two rules, and the rule follows the visibility:
 *
 *   * **On the finding's own line** — suppresses EVERY finding on that line. The
 *     claim is written on the line it excuses, so a copy-paste carries it and a
 *     reviewer reading the line reads the claim. Appending a second value to such
 *     a line does inherit the suppression, and that is accepted: the line the
 *     reviewer is looking at says out loud that it has been excused.
 *   * **On the line above** — suppresses AT MOST ONE finding, the leftmost. A
 *     pragma written above a line is a claim about the one thing the author was
 *     about to write. Every further finding on that line is reported, and carries
 *     a note saying the pragma above it was already spent, so the report explains
 *     why one of two identical-looking tokens is a failure.
 *
 * The limit that remains, stated rather than left to be discovered: a
 * preceding-line pragma still cannot tell WHICH finding it was written for. It
 * spends itself on the leftmost, which is where the author's own value was when
 * they wrote it, and an attacker who prepends rather than appends still inherits
 * it. Matching the pragma to the value it was written for — recording the value's
 * hash beside the reason — was the alternative, and it is what
 * `PUBLISHED_CONSTANTS` already does for values worth that ceremony. Spending one
 * pragma on one finding is the cheap ninety percent; it bounds the blast radius
 * of a stale pragma to one value instead of a whole line.
 *
 * The pragma annotates a LINE. When what is published on purpose is a VALUE —
 * the one session secret thirty-five test files share — the claim belongs in
 * `PUBLISHED_CONSTANTS` below instead, keyed by SHA-256. Two reasons, and the
 * second is the one that decided it: a value is one entry with one reason rather
 * than thirty-five copies of the same sentence, and `--history` can consult a
 * hash but cannot consult a comment that only exists in today's blob. A pragma
 * added now does not travel backwards into the commits that already published
 * the line.
 *
 * ## Git history is scanned only when asked, and here is the trade
 *
 * `--history` walks every blob reachable from every ref. A secret removed in a
 * later commit is still published, so this is a real question — but its only
 * remedy is a history rewrite plus credential rotation, which is not something a
 * release gate can require on the day it first notices. A permanently red gate
 * is a gate somebody turns off, and turning this one off costs the working-tree
 * check too. Same trade, and the same reasoning, as unfixable base-image CVEs in
 * `container-scan.mjs`. The audit runs the working tree; `--history` is for the
 * incident in `docs/production/runbooks/leaked-secret.md`.
 *
 * ## What this does NOT prove
 *
 * That there are no secrets here. It matches shapes a scanner can recognise and
 * flags high-entropy strings assigned to credential-shaped names. A password
 * that looks like a word, a key split across two string literals, or a
 * credential in a file type it does not read will all pass. It also says nothing
 * about secrets that were never in git: the images, the running processes and
 * the operator's shell history are out of its reach.
 *
 * Two bounds worth naming because they are deliberate and they are gaps:
 *
 *   * **Very long lines get the anchored detectors only.** A line past
 *     `MAX_GENERIC_LINE_LENGTH` is minified output or embedded data. Provider
 *     prefixes are still matched on it — they are literal-anchored and linear,
 *     and a minified config is the likeliest place a build-time-injected
 *     credential lands — but the generic name-and-value detectors do not run,
 *     because they contain unanchored quantifiers whose cost is quadratic in the
 *     line length. So `SESSION_SECRET:"…"` inside a 40,000-character minified
 *     JSON is still missed. `MAX_GENERIC_LINE_LENGTH` carries the arithmetic.
 *   * **A preceding-line pragma spends itself on one finding.** See the
 *     suppression section above.
 *
 * Usage:
 *     node scripts/supply-chain/secret-scan.mjs [--history] [--json] [--out <file>]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dim, Gate, REPO_ROOT, runGate } from './lib.mjs';

const gate = new Gate('secret-scan');

// ---------------------------------------------------------------------------
// What is read
// ---------------------------------------------------------------------------

/**
 * Extensions never worth reading: either they are not text, or they are
 * generated content whose high-entropy fields are integrity hashes.
 *
 * `pnpm-lock.yaml` is the important entry and it is excluded by NAME below
 * rather than by extension: it is a wall of base64 `sha512-` integrity hashes,
 * every one of which is high-entropy, none of which is a credential, and the
 * generic detector would report several thousand of them. The lockfile's own
 * integrity is `lockfile-integrity.mjs`'s job, and the hosts it resolves from
 * are `policy-check.mjs`'s.
 */
const SKIP_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.avif',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.br',
  '.wasm',
  '.mp3',
  '.mp4',
  '.webm',
]);

/** Generated files whose contents are hashes rather than prose or code. */
const SKIP_NAMES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);

/** A file larger than this is not source and reading it line by line is waste. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Paths that must never be tracked, and must be ignored whether they exist or not
// ---------------------------------------------------------------------------

/**
 * Every path this deployment's own documentation instructs somebody to create
 * with a real credential in it, and where that instruction is written down.
 *
 * The `why` is not decoration: when this gate fails, the operator reading the
 * failure needs to know what would have been published, and "an env file" is not
 * that. Add an entry here whenever a document starts telling somebody to write a
 * secret to a path inside this repository.
 */
const MUST_BE_IGNORED = [
  {
    path: '.env',
    why: 'the API session cookie secret and the database URL (.env.example, docs/production/deployment.md)',
  },
  {
    path: '.env.local',
    why: 'the same, under the Next convention',
  },
  {
    path: 'deploy/backup/backup.env',
    why: 'PRL_BACKUP_KEY, which decrypts every archive ever taken with it, and the backup role password (deploy/backup/README.md)',
  },
  {
    path: 'deploy/staging/.env.staging',
    why: 'the staging session secret, metrics token and generated database passwords (pnpm run staging init)',
  },
  {
    path: 'deploy/staging/observability/metrics-token',
    why: 'the bearer token that reads /metrics, written from PRL_STAGING_METRICS_TOKEN (scripts/alert-delivery.mjs)',
  },
  {
    path: 'deploy/staging/tls/staging-ca-key.pem',
    why: "the local CA's private key, which signs anything (pnpm run staging init)",
  },
  {
    path: 'deploy/staging/tls/staging-key.pem',
    why: "the staging leaf certificate's private key (pnpm run staging init)",
  },
  {
    /**
     * The release signing key.
     *
     * This one is the same shape of hole as `deploy/backup/backup.env` and it is worth saying why
     * it is not merely another private key. Committing it would not leak data — it decrypts
     * nothing. It would hand every reader of the repository the ability to MINT signatures that
     * `pnpm run security:image-provenance` accepts, over any bytes at all, and the gate would go on
     * reporting a pass while meaning nothing. A leaked verification key is a non-event; a leaked
     * signing key silently converts the control into decoration, which is the worse failure because
     * nothing turns red.
     *
     * `NEVER_TRACKED` also matches it by extension (`\.key$`), and that is not redundancy to be
     * tidied away: that rule fires only once the file is already tracked, i.e. after the mistake.
     * This rule is the one that stops `git add -A` on the release machine, where the file exists.
     */
    path: 'deploy/signing/cosign.key',
    why: 'the release image signing key — anybody holding it can mint signatures the provenance gate accepts (deploy/signing/README.md)',
  },
  {
    path: 'deploy/signing/signing.env',
    why: 'COSIGN_PASSWORD, the passphrase that unlocks the signing key above (deploy/signing/README.md)',
  },
];

/**
 * Shapes that are credential material by their nature, wherever they appear.
 *
 * Tracked as a separate check from the content scan because the answer does not
 * depend on reading the file: a committed `.pem` holding a private key is a
 * finding even if this gate cannot parse it, and `git ls-files` already knows
 * every path.
 *
 * A path rule has no pragma, deliberately — a pragma lives inside the file, and
 * the file being tracked at all is the finding. A public certificate chain with
 * no key in it is the one legitimate case this refuses, and the escape hatch is
 * to edit this list with a comment saying which file and why. That friction is
 * the right amount for a decision that puts a `.pem` in a public repository.
 */
const NEVER_TRACKED = [
  { pattern: /(^|\/)\.env$/, what: 'an environment file' },
  /**
   * `.env.<anything>`, with two exemptions carved out by name.
   *
   * This used to read `/(^|\/)\.env\.(?!example$)[^/]+$/` — exempting the single
   * literal filename `.env.example` and nothing else. That rule blocked
   * `.env.staging.example` and `.env.local.example`, which are the SAME CLASS of
   * file as the one it deliberately exempts: a committed template with
   * `CHANGE_ME` where the value goes, whose whole purpose is to be tracked. It
   * also blocked `.env.d.ts`, which is not an environment file at all — it is a
   * TypeScript ambient declaration naming the shape of `process.env`, and it
   * holds type names, not values.
   *
   * Nothing in this repository is caught by any of that today, which is exactly
   * what made it worth fixing now: a rule that over-blocks a file nobody has
   * added yet is a trap that springs on whoever adds it, in a release gate, with
   * a message telling them to rotate a credential that never existed. A gate that
   * cries wolf about a template is a gate somebody adds an exemption to in a
   * hurry, and hurried exemptions are how the real one gets through.
   *
   * The exemption is now "the final dot-segment is `example`", so `.env.example`,
   * `.env.staging.example` and `.env.local.example` are all templates and all
   * fine, while `.env.myexample` — one word, not a suffix — is still blocked.
   *
   * What deliberately stays BLOCKED: `.env.test`, `.env.development`,
   * `.env.local`, `.env.production`, `.env.staging`. Every one of those is a real
   * environment file that holds real values on somebody's disk, whatever the
   * suffix suggests about its importance, and `.env.local` is on the
   * `MUST_BE_IGNORED` list above for precisely that reason. The exemption is for
   * files whose NAME says they carry no values, not for files whose environment
   * sounds unimportant.
   */
  { pattern: /(^|\/)\.env\.(?!(?:[^/]*\.)?example$)(?!d\.ts$)[^/]+$/, what: 'an environment file' },
  { pattern: /\.(?:pem|key|p12|pfx|jks|keystore)$/, what: 'key or certificate material' },
  { pattern: /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/, what: 'an SSH private key' },
];

/**
 * `.npmrc` is deliberately NOT in the list above, and the reason is worth
 * stating: this repository tracks one on purpose, because pnpm 11 reads the
 * registry pinning that stops a scoped install falling back to another host
 * from that file and nowhere else (`policy-check.mjs` depends on it). What must
 * never be in it is an auth field, so that is a content detector below rather
 * than a path rule — a rule that banned the file would ban the pinning too.
 */
const NPMRC_AUTH = /^\s*(?:\/\/.*:)?_(?:auth|authToken|password)\s*=\s*(\S+)/gim;

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

/**
 * Provider token shapes. Every one of these is a published format with a fixed
 * prefix, which is what makes them worth matching literally: a string beginning
 * `ghp_` followed by thirty-six base62 characters is a GitHub token or a
 * deliberate imitation of one, and there is no third possibility worth a
 * reviewer's time.
 *
 * These fire regardless of entropy and regardless of the surrounding name,
 * because the prefix IS the evidence.
 */
const TOKEN_DETECTORS = [
  { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'github-fine-grained-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'stripe-live-key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai-api-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { name: 'pypi-token', pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/g },
  { name: 'sendgrid-key', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { name: 'private-key-block', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { name: 'putty-private-key', pattern: /PuTTY-User-Key-File-\d/g },
];

/**
 * A URL with the password written into it, pointing somewhere that is not this
 * machine or this container network.
 *
 * The host restriction is the difference between a useful detector and noise.
 * `postgres://prl:prl@localhost:5432/...` appears in `.env.example`, in three
 * CI jobs and in most of the API test files, deliberately and documented as
 * such: it is the development stack's throwaway credential, it is published on
 * purpose, and it grants nothing to anybody who cannot already reach loopback on
 * that machine. A gate that reports it reports fifty lines of intentional
 * configuration, and a gate with fifty known-false lines is a gate people stop
 * reading — which is how the fifty-first, the real one, gets through.
 *
 * So a credentialed URL is a finding only when its host could name a service
 * somebody else can reach: it contains a dot and is not a loopback or private
 * address. A single-label host (`postgres`, `db`, `api`) resolves only inside a
 * compose network and is treated the same way as loopback.
 *
 * Deliberately not `[^:@/]+` for the password: a password containing a slash is
 * legal and common, and a detector that cannot see one is a detector somebody's
 * password walks straight past.
 */
const URL_CREDENTIAL = /\b[a-z][a-z0-9+.-]*:\/\/([A-Za-z0-9._~%+-]+):([^\s@'"`<>]+)@([A-Za-z0-9._-]+)/g;

/** Hosts that nobody outside this machine or this compose network can reach. */
export function isLocalHost(host) {
  const lowered = host.toLowerCase();
  if (lowered === 'localhost' || lowered.endsWith('.localhost') || lowered.endsWith('.local')) return true;
  if (lowered === '127.0.0.1' || lowered === '0.0.0.0' || lowered === '::1') return true;
  if (/^10\./.test(lowered) || /^192\.168\./.test(lowered)) return true;
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(lowered)) return true;
  if (lowered === 'host.docker.internal') return true;
  // `.internal` is reserved for private use and resolves nowhere else; compose
  // networks and cloud VPCs both use it, and `db.internal` names a database that
  // is only a database to something already inside that network.
  if (lowered.endsWith('.internal')) return true;
  // A single-label name is a compose service or a hosts-file entry, never a
  // public one: there is no such thing as a reachable `postgres` on the internet.
  return !lowered.includes('.');
}

/**
 * Names whose value is a credential by definition.
 *
 * The suffix anchoring matters: `TOKEN_BUDGET`, `KEYBOARD_AUDIT` and
 * `SECRETS_DOC` are not credentials, and a substring match on `TOKEN` would
 * report all three.
 *
 * A bare `key` is in the list, and it earns its place: this deployment's most
 * consequential secret is `PRL_BACKUP_KEY`, which decrypts every archive, and an
 * alternation of `api_key|access_key|private_key` — the usual set — does not
 * match it.
 *
 * The separator before the credential word is OPTIONAL, and that is a fix rather
 * than a nicety. It used to be mandatory (`[A-Za-z0-9_.-]*[_.-]`), which meant the
 * character before `key`/`secret`/`password` had to be a non-alphanumeric — so
 * `API_KEY` matched and `apiKey` did not. This is a TypeScript monorepo where
 * camelCase is the default identifier convention, so the generic detector was
 * switched off for most of the code it was written to read: `const
 * awsSecretAccessKey = 'wJalrXUtn…'` passed while the same value under
 * `AWS_SECRET_ACCESS_KEY=` was caught. The AWS secret access key has no prefix of
 * its own, so this detector is the only one that can ever see it.
 *
 * ## The cost of a bare `key`, measured rather than assumed
 *
 * This paragraph used to say the cost was paid for by the value tests — that
 * `CACHE_KEY` and friends "reach the value tests" and only "can" get through. It
 * is not paid for, and the hedge was the inaccurate part. The value tests are
 * length ≥ 20, not a placeholder, entropy ≥ 3.2 bits/char, and not a
 * `PUBLISHED_CONSTANTS` hash; the following four were fed to `scanText` and every
 * one of them clears all four and is reported as `secret-literal`. Each carries
 * the pragma this paragraph goes on to recommend, because these four lines are
 * inside a tracked file and the gate reads its own source like any other — a
 * worked example that would fail the gate it documents is not a worked example:
 *
 *     const CACHE_KEY = 'v3:profile:f4a9c1e8b27d3a6f9012cd45ef6789ab'; // prl-allow-secret: a hashed cache key, documentation
 *     const IDEMPOTENCY_KEY = '9f8e7d6c5b4a39281706f5e4d3c2b1a0'; // prl-allow-secret: a hex idempotency token, documentation
 *     const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'; // prl-allow-secret: a git SHA, documentation
 *     vapidPublicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' // prl-allow-secret: a PUBLIC VAPID key, documentation
 *
 * There is nothing in the value tests that could separate any of them from a
 * credential, because there is nothing to separate: a cache key derived by
 * hashing, a hex idempotency token, a commit SHA and a VAPID public key are
 * indistinguishable from a secret by length, entropy and shape. Only a human
 * knows which of them grants anything, and the last one grants nothing while
 * looking more like a credential than the rest.
 *
 * That is the accepted policy, not a defect: each of those lines needs a
 * `prl-allow-secret: <reason>` pragma, and writing one is the human saying which
 * it is. The alternative — dropping bare `key` from the name list — makes
 * `PRL_BACKUP_KEY`, the value that decrypts every archive this deployment has
 * ever taken, invisible to the only detector that can see it. A pragma on a
 * commit SHA is a cheap price for that; a comment claiming the pragma is not
 * needed was not.
 */
const SECRET_NAME_PART =
  '(?:[A-Za-z0-9_.-]*[_.-]?)?(?:secret|password|passwd|passphrase|pwd|key|auth[_-]?token|token|credential)s?';

/**
 * A credential-shaped name assigned a QUOTED LITERAL.
 *
 * The quotes are the whole point, and this detector was rewritten to require
 * them after the first run of this gate reported thirty lines of the form
 * `const secret = config.sessionCookieSecret` and `const token = headers.authorization`.
 * Those are references to a credential, which is what correct code looks like:
 * the value is not in the file, it came from the environment, and reporting the
 * line that reads it teaches the reader that this gate does not know the
 * difference. Only a literal can be a leak.
 */
const SECRET_LITERAL = new RegExp(
  `(?:^|[^A-Za-z0-9])(${SECRET_NAME_PART})\\s*[:=]\\s*(['"\`])([^'"\`\\n]+)\\2`,
  'gi',
);

/**
 * The same question in an environment file: `NAME=value`, unquoted, to end of
 * line. `.env`, `deploy/staging/.env.staging` and systemd `EnvironmentFile`
 * entries all have this shape, and none of them can carry a quote.
 *
 * Spaces around the `=` are allowed because `~/.aws/credentials` writes them, and
 * that file's `aws_secret_access_key` is the single most valuable thing this gate
 * can find.
 */
const SECRET_ENV_ASSIGNMENT =
  /^\s*(?:export\s+)?((?:[A-Za-z0-9_-]*[_-])?(?:secret|password|passwd|passphrase|pwd|key|auth[_-]?token|token|credential)s?)\s*=\s*(\S+)\s*$/i;

/**
 * The same question again, in a YAML or JSON mapping — and gated on the file
 * EXTENSION, which is the whole reason it is safe to have at all.
 *
 * ## Why this is separate from `SECRET_LITERAL`
 *
 * `SECRET_LITERAL` requires quotes around the value. YAML does not use them:
 * `metricsToken: aZ9kQ2vR…` is an unquoted scalar and the quoted detector cannot
 * see it. `SECRET_ENV_ASSIGNMENT` handles the unquoted case but only for `=`, not
 * for `:`. So a credential-shaped key with a bare scalar value in a `.yml` sat in
 * the gap between the two, and this deployment's configuration is YAML: the
 * compose files, the Prometheus scrape config, three CI workflows.
 *
 * ## Why the extension gate is load-bearing and not a convenience
 *
 * A general `name: value` detector across the whole repository was tried and
 * reverted. In a TypeScript monorepo `key: 'someIdentifier'` is object-literal
 * syntax — a property of a config object, a discriminant, a map entry — and the
 * general form produced **62 false positives on this repository alone**. Sixty-two
 * known-false lines is a gate people stop reading, which is how the
 * sixty-third — the real one — gets through.
 *
 * Restricted to `.yml`, `.yaml` and `.json`, that failure mode cannot occur,
 * because object-literal syntax cannot occur: in those files a `name: value` at
 * the start of a line IS a configuration mapping and nothing else. Measured over
 * the 42 tracked YAML and JSON files in this repository (lockfiles excluded by
 * `SKIP_NAMES`, as everywhere): **0 findings, 0 false positives**. That is the
 * number that decided this ships and the general form does not.
 *
 * ## Two shapes
 *
 * `STRUCTURED_MAPPING` matches one `key: value` line in either format — JSON
 * quotes the key and trails a comma, YAML does neither, and a leading `- ` is a
 * sequence entry. What is done with the value depends on the key:
 *
 *   * a credential-shaped key (`SECRET_NAME_PART`) with a value that passes the
 *     ordinary value tests is a finding;
 *   * ANY key whose value is `Bearer <token>` / `Basic <b64>` / `Token <t>` is a
 *     finding, whatever the key is called. `authorization: Bearer …` is the
 *     canonical shape of a credential in a scrape config or a webhook definition
 *     and `authorization` is not a credential-shaped name. The scheme word is
 *     stripped before the value tests run, because `isPlaceholder` rejects
 *     anything containing a space and would otherwise reject every one of them.
 *
 * A `#` comment line matches neither: both are anchored at the start of the line
 * through optional whitespace and an optional `- `, so a commented-out example
 * is not a finding. A real prefixed token in a YAML comment is still caught by
 * `TOKEN_DETECTORS`, which do not care where they are.
 */
const STRUCTURED_MAPPING =
  /^[\s-]*"?([A-Za-z0-9_.-]+)"?\s*:\s*(?:'([^']*)'|"([^"]*)"|([^\s#,][^#,]*?))\s*,?\s*(?:#.*)?$/;

/** The `key:` half of `STRUCTURED_MAPPING`, tested whole rather than as a substring. */
const STRUCTURED_SECRET_NAME = new RegExp(`^${SECRET_NAME_PART}$`, 'i');

/** `Bearer <token>`, and its two siblings, in a config file's value position. */
const AUTH_SCHEME_VALUE = /^(?:Bearer|Basic|Token)\s+(\S+)$/i;

/** Extensions where a `name: value` line is configuration and cannot be code. */
const STRUCTURED_EXTENSIONS = new Set(['.yml', '.yaml', '.json']);

/**
 * Is this path one where `STRUCTURED_MAPPING` may run?
 *
 * Defaults to false, including for the empty path a caller passes when it has
 * only text. Failing closed here means a caller that forgets the path loses a
 * detector rather than gaining sixty-two false positives.
 */
export function isStructuredConfig(path) {
  const lower = String(path ?? '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  const slash = lower.lastIndexOf('/');
  return dot > slash && STRUCTURED_EXTENSIONS.has(lower.slice(dot));
}

/** The shortest value the generic detector will look at. */
const MIN_SECRET_LENGTH = 20;

/**
 * Shannon entropy per character, in bits.
 *
 * Used only by the generic name-and-value detector. A credential-shaped name
 * assigned a low-entropy value is nearly always a reference to a variable, a
 * path, a description or a placeholder, and reporting those is how a scanner
 * teaches people to ignore it.
 */
export function shannonEntropy(value) {
  if (value.length === 0) return 0;
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Below this, a credential-named value is prose, a path or a placeholder. */
const MIN_ENTROPY_BITS = 3.2;

/**
 * Values that are obviously not credentials.
 *
 * Every entry here is a shape this repository actually uses. `${...}` and
 * `$VAR` are compose and shell interpolation, which is the *correct* way to
 * reference a secret and must never be reported as one. `CHANGE_ME` is what
 * `.env.example` and `deploy/backup/backup.env.example` use. `process.env.X` is
 * the same thing in JavaScript.
 */
export function isPlaceholder(value) {
  const trimmed = value.trim();
  if (trimmed === '') return true;
  // Anything interpolated is a reference to a value held elsewhere, which is
  // what correct code looks like: `${config.clientSecret}` is the secret being
  // read, not the secret being written down.
  if (trimmed.includes('${')) return true;
  // Nothing generates a credential with a space in it, and a credential-shaped
  // name followed by a quoted phrase is prose: the first run of this gate
  // reported the comment `// Deterministic under one secret: "which sessions
  // are mine" has to keep working.` as a secret named `secret`.
  if (/\s/.test(trimmed)) return true;
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return true;
  if (/^process\.env\./.test(trimmed)) return true;
  if (/^<[^>]*>$/.test(trimmed)) return true;
  if (
    /^(?:change[_-]?me|redacted|placeholder|example|sample|todo|tbd|none|null|undefined|unset|false|true)$/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  // `replace-me-this-example-value-is-rejected-in-production` is the shipped
  // `.env.example` value, and `config.ts` refuses to boot production with it.
  if (/^(?:your|my|the|some|a|replace|generate|insert|fill|set)[-_]/i.test(trimmed)) return true;
  if (/^x{4,}$/i.test(trimmed)) return true;
  // An ISO-8601 timestamp is high-entropy, twenty-plus characters, and not a credential. It
  // reaches the value tests through names like `startedAtKey`, which is an ordinary cursor field.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(trimmed)) return true;
  if (/^\.{3,}$/.test(trimmed)) return true;
  // One character repeated is a fixture ('a'.repeat(64) and its literal twin).
  if (/^(.)\1+$/.test(trimmed)) return true;
  return isTypedName(trimmed);
}

/**
 * A name somebody typed, in one of the three shapes this repository writes them:
 *
 *   kebab or snake   `sorter-token-for-the-hand-ordering-tests`, `poker-dev-only`
 *   camelCase        `stackDepthAdjustment`, `dangerouslyAllowAllBuilds`
 *   dotted namespace `prl.learn.onboarding.dismissed`
 *
 * Nothing that generates a credential produces any of them. `crypto.randomBytes`
 * gives base64 or hex, every provider prefixes and mixes case, and a password
 * manager's output has digits in it. Each pattern below requires word structure
 * that a random string of twenty-plus characters effectively never has: three
 * separated segments, or strictly alternating lowercase/capitalised words with
 * no digits at all.
 *
 * All three arrived the same way — as false positives against this repository —
 * and the camelCase and dotted cases arrived together, the moment a bare `key`
 * joined the name list and `const DISMISSED_KEY = 'prl.learn.onboarding.dismissed'`
 * became a finding.
 *
 * The cost, stated because it is real: a genuine four-word passphrase is
 * invisible to this gate. The header says so too. Catching it would mean
 * reporting every identifier in the repository, which trades one missed shape
 * for a gate nobody reads.
 */
export function isTypedName(value) {
  if (/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+){2,}$/.test(value)) return true;
  if (/^[a-z]+(?:[A-Z][a-z]+)+$/.test(value)) return true;
  return /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/.test(value);
}

/**
 * Values published on purpose, recorded by SHA-256 rather than by value.
 *
 * `apps/api/test/*` boots the API thirty-five times with one shared
 * `SESSION_COOKIE_SECRET`, because `config.ts` refuses a short one and a test
 * that generates a fresh secret per file makes every failure unreproducible.
 * That literal IS a high-entropy string assigned to a credential name in
 * tracked files — the detector is right about its shape and wrong about its
 * consequence, and thirty-five inline pragmas would put a suppression marker in
 * thirty-five files to say one thing once.
 *
 * Recorded as a hash so that adding an entry here does not restate the value
 * inside a file that gets read aloud in reviews. To add one:
 *
 *     node -e "console.log(require('node:crypto').createHash('sha256').update('VALUE').digest('hex'))"
 *
 * An entry is a claim that the value grants nothing. Anything used against a
 * real deployment does not belong here — it belongs in a rotation.
 */
const PUBLISHED_CONSTANTS = new Map([
  [
    'ed123af4c9fb426796c25d07b1d1fb2576ae4dafec8412ef5f66195d4ee894fa',
    'the shared SESSION_COOKIE_SECRET of the API test suite; it signs cookies for ephemeral test servers only',
  ],
  [
    '2ef6b3dae635f1432ac6f31a27795febcb07a8811f85aec624fde659afe543b1',
    'the METRICS_TOKEN of apps/api/test/observability-metrics.test.ts, which scrapes an in-process server',
  ],
  [
    'd05162f33bfd7b3d97459f8be27043f70521d8af2f706a1c274d8cd70af528cd',
    'the RATE_LIMIT_RESET_TOKEN of apps/api/test/rate-limit-isolation.test.ts; config.ts refuses it in production',
  ],
  [
    '94bf1602ef8771c71d87462ebaf905a88ddb0bbcfdcb962356e8beb45dbdf7f6',
    'the second session secret of apps/api/test/repositories.test.ts, used only to prove two secrets differ',
  ],
]);

/** Hosts nobody can register, and elisions in prose. */
export function isUnroutableHost(host) {
  const lowered = host.toLowerCase();
  if (/^[.…]+$/.test(lowered)) return true;
  // RFC 2606 / RFC 6761 reserve these precisely so documentation can use them.
  return (
    /(?:^|\.)(?:example|test|invalid)$/.test(lowered) || /(?:^|\.)example\.(?:com|net|org)$/.test(lowered)
  );
}

/** `prl-allow-secret: <reason>` on this line or the one above it. */
const PRAGMA = /prl-allow-secret:\s*(\S.*)$/;

/**
 * Redacted evidence: enough to find the string, not enough to use it.
 *
 * Four characters is a deliberate number. It identifies a provider prefix
 * (`ghp_`, `AKIA`) without disclosing a meaningful fraction of any real
 * credential's entropy.
 */
export function redact(value) {
  const head = value.slice(0, 4);
  return `${head}… (${value.length} chars)`;
}

/**
 * The width past which only the ANCHORED detectors run.
 *
 * This line used to be `if (line.length > 4096) continue;` — the whole line
 * dropped, provider prefixes included. Fed
 * `'x'.repeat(4100) + ' ghp_aaaa…'`, `scanText` returned `[]`; the same token on a
 * short line returned one `github-token` finding. That is the wrong half to give
 * up. A minified `.json` or `.js` config is one line by construction, and it is
 * the most likely single place for a build-time-injected credential to land, so
 * the bound was switching the scanner off exactly where a real one would be.
 *
 * The split is by COST, not by usefulness. Every `TOKEN_DETECTORS` pattern is
 * anchored on a literal prefix (`ghp_`, `AKIA`, `-----BEGIN `) with no nested
 * quantifier, so it scans a long line in one linear pass and still runs. The
 * generic detectors are not: `URL_CREDENTIAL` opens with `[a-z][a-z0-9+.-]*` and
 * then looks for `://`, and `SECRET_LITERAL` opens with `[A-Za-z0-9_.-]*` — a
 * greedy run that backtracks at every starting position, which is O(n²) in the
 * line length. On a 40,000-character line that is 1.6 billion steps to learn
 * nothing, and on a 2 MB one it is a hung release gate. Those stay bounded.
 *
 * 4096 is unchanged and is comfortably above anything written by hand: the
 * longest line in any tracked file here is 1,608 characters, in
 * `packages/content/data/scenarios/risk-and-sizing.json`. So today the bound
 * costs nothing at all, and the reason to get it right is the minified asset or
 * generated config that has not been added yet.
 */
const MAX_GENERIC_LINE_LENGTH = 4096;

/**
 * Every finding in one text, as `{line, column, detector, evidence, note?}`.
 *
 * Exported and pure so the tests can drive it with strings rather than a
 * repository: a scanner whose behaviour can only be observed by committing a
 * fake credential is a scanner nobody writes tests for.
 *
 * `note` is present only where the finding needs explaining rather than just
 * reporting — a column that points into minified output, or a finding that
 * survived a preceding-line pragma somebody else's value had already spent. Both
 * cases produce a report that looks arbitrary without the sentence.
 *
 * `path` is optional and is used for one thing: deciding whether the file is a
 * YAML or JSON config, where `STRUCTURED_MAPPING` may run. It defaults to a value
 * that turns that detector OFF, so a caller that forgets it loses a detector
 * instead of gaining the sixty-two false positives the unrestricted form
 * produced.
 *
 * @param {string} text
 * @param {string} [path] repo-relative path, for extension-gated detectors
 * @returns {Array<{line: number, column: number, detector: string, evidence: string, note?: string}>}
 */
export function scanText(text, path = '') {
  const findings = [];
  const lines = text.split('\n');
  const structured = isStructuredConfig(path);

  /** A value is only a leak if it is long, unpredictable and not a stand-in. */
  const looksLikeSecret = (value) =>
    value.length >= MIN_SECRET_LENGTH &&
    !isPlaceholder(value) &&
    shannonEntropy(value) >= MIN_ENTROPY_BITS &&
    !PUBLISHED_CONSTANTS.has(createHash('sha256').update(value).digest('hex'));

  for (const [index, line] of lines.entries()) {
    const oversized = line.length > MAX_GENERIC_LINE_LENGTH;

    // Collected first and suppressed second, which is the change that lets a
    // preceding-line pragma be spent on ONE finding: the old code decided
    // suppression before it knew how many findings the line had, so it could only
    // ever decide for all of them.
    const candidates = [];
    const record = (detector, value, column, note) => {
      const finding = { line: index + 1, column, detector, evidence: redact(value) };
      if (note !== undefined) finding.note = note;
      candidates.push(finding);
    };

    // Anchored, literal-prefixed, linear: these run at any line length.
    const oversizedNote = oversized
      ? `found at offset ${'{n}'} on a ${line.length}-character line — that column is a byte offset into ` +
        'minified output, not somewhere an editor can take you, so search for the redacted prefix instead. ' +
        'The generic name-and-value detectors did NOT run on this line (MAX_GENERIC_LINE_LENGTH).'
      : undefined;
    for (const detector of TOKEN_DETECTORS) {
      detector.pattern.lastIndex = 0;
      let match = detector.pattern.exec(line);
      while (match !== null) {
        const column = match.index + 1;
        record(detector.name, match[0], column, oversizedNote?.replace('{n}', String(column)));
        match = detector.pattern.exec(line);
      }
    }

    if (!oversized) {
      URL_CREDENTIAL.lastIndex = 0;
      let url = URL_CREDENTIAL.exec(line);
      while (url !== null) {
        if (!isPlaceholder(url[2]) && !isLocalHost(url[3]) && !isUnroutableHost(url[3])) {
          record('url-embedded-password', url[2], url.index + 1);
        }
        url = URL_CREDENTIAL.exec(line);
      }

      SECRET_LITERAL.lastIndex = 0;
      let literal = SECRET_LITERAL.exec(line);
      while (literal !== null) {
        if (looksLikeSecret(literal[3])) record('secret-literal', literal[3], literal.index + 1);
        literal = SECRET_LITERAL.exec(line);
      }

      const assignment = SECRET_ENV_ASSIGNMENT.exec(line);
      if (assignment !== null && looksLikeSecret(assignment[2])) {
        record('secret-env-assignment', assignment[2], 1);
      }

      // Only in a `.yml`/`.yaml`/`.json`, where `name: value` cannot be an object
      // literal. See `STRUCTURED_MAPPING` for the measurement that gates it.
      if (structured) {
        const mapping = STRUCTURED_MAPPING.exec(line);
        if (mapping !== null) {
          const name = mapping[1];
          const value = (mapping[2] ?? mapping[3] ?? mapping[4] ?? '').trim();
          const scheme = AUTH_SCHEME_VALUE.exec(value);
          if (scheme !== null) {
            // `authorization: Bearer <token>` under any key at all.
            if (looksLikeSecret(scheme[1])) record('config-auth-scheme', scheme[1], 1);
          } else if (STRUCTURED_SECRET_NAME.test(name) && looksLikeSecret(value)) {
            record('config-secret-value', value, 1);
          }
        }
      }
    }

    // --- suppression, now that the line's findings are known ----------------
    //
    // On the line itself: suppresses everything on it. The claim is written where
    // a reviewer and a copy-paste both carry it.
    if (PRAGMA.test(line)) continue;

    // On the line above: spends itself on ONE finding, the leftmost — the
    // position the author's own value occupied when they wrote the pragma above
    // it. Everything else on the line is reported and says why.
    //
    // The defect: `// prl-allow-secret: the fixture below is fake` above
    // `const FIXTURE='ghp_0000…'; const REAL='ghp_A1b2…';` suppressed BOTH, so a
    // real token appended to a blessed line inherited the blessing in silence.
    // Fed that pair, `scanText` returned `[]`; it now returns the second token.
    if (candidates.length > 0 && index > 0 && PRAGMA.test(lines[index - 1] ?? '')) {
      let leftmost = 0;
      for (let i = 1; i < candidates.length; i++) {
        const candidate = candidates[i];
        const best = candidates[leftmost];
        if (candidate !== undefined && best !== undefined && candidate.column < best.column) leftmost = i;
      }
      candidates.splice(leftmost, 1);
      for (const finding of candidates) {
        // Appended, not assigned: an oversized line can carry BOTH notes, and the one
        // saying the column is unnavigable is the one a reader needs first.
        const spent =
          'The `prl-allow-secret` on the line above was already spent on the first value on this line. ' +
          'A pragma written above a line covers one finding, not the line — otherwise a real credential ' +
          'appended to a blessed line inherits the blessing. Move the pragma onto this line, or give this ' +
          'value its own.';
        finding.note = finding.note === undefined ? spent : `${finding.note} ${spent}`;
      }
    }

    findings.push(...candidates);
  }
  return findings;
}

/**
 * Auth fields in an `.npmrc`, which is the one thing that file must never hold.
 *
 * Separate from `scanText` because the question is only meaningful for that
 * filename: `_auth=` in a markdown code fence is documentation, and in an
 * `.npmrc` it is a registry credential.
 */
export function scanNpmrc(text) {
  const findings = [];
  const lines = text.split('\n');
  NPMRC_AUTH.lastIndex = 0;
  let match = NPMRC_AUTH.exec(text);
  while (match !== null) {
    const index = text.slice(0, match.index).split('\n').length - 1;
    // The same two suppressions `scanText` applies, and for the same reasons. `scanText`'s
    // one-finding limit on a PRECEDING-line pragma is deliberately not copied here, because the
    // case it bounds cannot arise: `NPMRC_AUTH` is anchored with `^` under `m`, so it produces at
    // most one match per line, and "at most one finding" is already the shape of this loop.
    // Without them this
    // detector reported `_authToken=${NODE_AUTH_TOKEN}` — the standard, CORRECT way to write a
    // CI npmrc, and the exact shape this file's own header calls "the correct way to reference a
    // secret [which] must never be reported as one" — and then told the operator to add a pragma
    // that this function did not read. A gate that cannot be satisfied is a gate somebody removes.
    const suppressed =
      isPlaceholder(match[1]) ||
      PRAGMA.test(lines[index] ?? '') ||
      (index > 0 && PRAGMA.test(lines[index - 1] ?? ''));
    if (!suppressed) {
      findings.push({ line: index + 1, column: 1, detector: 'npmrc-auth', evidence: redact(match[1]) });
    }
    match = NPMRC_AUTH.exec(text);
  }
  return findings;
}

/** A bare `prl-allow-secret:` with no reason is a suppression nobody can review. */
export function findReasonlessPragmas(text) {
  const bad = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!/prl-allow-secret:/.test(line)) continue;
    if (!PRAGMA.test(line)) bad.push(index + 1);
  }
  return bad;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(' ')} failed: ${err?.stderr ?? err?.message ?? err}`);
  }
}

/** Tracked paths, repo-relative, with `/` separators on every platform. */
function trackedFiles() {
  const out = git(['ls-files', '-z']);
  return out.split('\0').filter((path) => path !== '');
}

/** Does an ignore rule match this path, whether or not anything is there? */
function isIgnored(path) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', '--', path], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function extensionOf(path) {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

function isReadable(path) {
  const name = path.split('/').pop() ?? path;
  if (SKIP_NAMES.has(name)) return false;
  if (SKIP_EXTENSIONS.has(extensionOf(path))) return false;
  const full = join(REPO_ROOT, path);
  if (!existsSync(full)) return false;
  try {
    return statSync(full).size <= MAX_FILE_BYTES;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Every blob reachable from every ref, scanned once per unique object.
 *
 * Unique per OBJECT, not per path: git stores one blob for identical content, so
 * a file that survived two hundred commits unchanged is one scan, and a secret
 * that was committed and removed is still exactly one blob to find.
 */
function scanHistory() {
  const listing = git(['rev-list', '--objects', '--all'], { allowFailure: true });
  if (listing === null) return { findings: [], blobs: 0 };
  const seen = new Map();
  for (const line of listing.split('\n')) {
    const space = line.indexOf(' ');
    if (space <= 0) continue;
    const oid = line.slice(0, space);
    const path = line.slice(space + 1);
    if (path === '' || !seen.has(oid)) seen.set(oid, path);
  }
  const findings = [];
  let blobs = 0;
  for (const [oid, path] of seen) {
    const name = path.split('/').pop() ?? path;
    if (SKIP_NAMES.has(name) || SKIP_EXTENSIONS.has(extensionOf(path))) continue;
    const type = git(['cat-file', '-t', oid], { allowFailure: true })?.trim();
    if (type !== 'blob') continue;
    const size = Number(git(['cat-file', '-s', oid], { allowFailure: true })?.trim() ?? '0');
    if (!Number.isFinite(size) || size > MAX_FILE_BYTES) continue;
    const content = git(['cat-file', 'blob', oid], { allowFailure: true });
    if (content === null) continue;
    blobs += 1;
    // Path-aware, like the working-tree scan: the blob's path is what says whether it
    // was a YAML/JSON config, and history is where a config that has since been
    // deleted still lives. One caveat, since `seen` keys by OID: identical content at
    // two paths is one scan under whichever path git listed first, so a blob that was
    // both `a.json` and `a.txt` may be scanned as the `.txt`. Identical content is one
    // secret either way, and `TOKEN_DETECTORS` are not gated on the path.
    for (const finding of scanText(content, path)) {
      findings.push({ ...finding, path, oid });
    }
  }
  return { findings, blobs };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const options = {
  history: process.argv.includes('--history'),
  json: process.argv.includes('--json'),
  out: (() => {
    const at = process.argv.indexOf('--out');
    return at === -1 ? null : (process.argv[at + 1] ?? null);
  })(),
};

/**
 * Guarded, unlike the first version of this file.
 *
 * `secret-scan.test.mjs` imports this module to drive its parsers, and without the guard the whole
 * gate — `git ls-files` plus six hundred file reads — ran as an import side effect, and worse,
 * `runGate` set `process.exitCode` on a finding. `node --test` never resets that, so a repository
 * holding one real finding would have exited the unit-test run non-zero with every test green.
 * `container-scan.mjs` has had this guard all along; this file should have copied it.
 */
function main() {
  return runGate(gate, () => {
    const tracked = trackedFiles();
    if (tracked.length === 0) {
      // Same principle as repo-hygiene and container-scan: a sweep of nothing
      // proves nothing, and must not read as a pass.
      gate.fail('git tracks no files here', 'a scan of an empty file list is not a clean scan');
      return;
    }

    // --- 1. Shapes that are credentials by their path -----------------------
    const trackedFindings = [];
    for (const path of tracked) {
      for (const rule of NEVER_TRACKED) {
        if (rule.pattern.test(path)) {
          gate.fail(
            `${path} is tracked and is ${rule.what}`,
            'remove it from the index, rotate what it held, and add an ignore rule',
          );
        }
      }
    }

    // --- 2. Ignore rules exist for every path an operator is told to write ---
    for (const entry of MUST_BE_IGNORED) {
      if (tracked.includes(entry.path)) {
        gate.fail(`${entry.path} is tracked`, `it holds ${entry.why}`);
        continue;
      }
      if (!isIgnored(entry.path)) {
        gate.fail(
          `no ignore rule matches ${entry.path}`,
          `it holds ${entry.why}; nothing stops \`git add -A\` on a host where it exists. Add it to .gitignore.`,
        );
      }
    }

    // --- 3. Contents of tracked files ---------------------------------------
    let scanned = 0;
    for (const path of tracked) {
      if (!isReadable(path)) continue;
      let text;
      try {
        text = readFileSync(join(REPO_ROOT, path), 'utf8');
      } catch {
        continue;
      }
      scanned += 1;
      for (const line of findReasonlessPragmas(text)) {
        gate.fail(
          `${path}:${line} has a prl-allow-secret pragma with no reason`,
          'a suppression nobody can review is a suppression nobody should trust',
        );
      }
      // The path is passed, not just the text: `STRUCTURED_MAPPING` runs only in a
      // `.yml`/`.yaml`/`.json`, where a `name: value` line cannot be an object literal.
      const found = scanText(text, path);
      if ((path.split('/').pop() ?? path) === '.npmrc') found.push(...scanNpmrc(text));
      for (const finding of found) {
        trackedFindings.push({ ...finding, path });
        gate.fail(
          `${path}:${finding.line}:${finding.column} ${finding.detector}`,
          `${finding.evidence} — if this is not a credential, say so with a \`prl-allow-secret: <reason>\` comment` +
            // The note is what makes a finding on a minified line, or a second finding
            // under a spent pragma, read as an explanation rather than as caprice.
            (finding.note === undefined ? '' : `. ${finding.note}`),
        );
      }
    }
    gate.note(`${scanned} tracked file(s) read, ${tracked.length} tracked in total`);
    gate.note(`${MUST_BE_IGNORED.length} secret-bearing path(s) checked against the ignore rules`);

    // --- 4. History, only when asked ----------------------------------------
    let history = null;
    if (options.history) {
      history = scanHistory();
      gate.note(`${history.blobs} unique blob(s) in history scanned`);
      for (const finding of history.findings) {
        gate.fail(
          `history ${finding.oid.slice(0, 12)} ${finding.path}:${finding.line} ${finding.detector}`,
          `${finding.evidence} — a removed secret is still published: rotate it, then decide about a history rewrite (docs/production/runbooks/leaked-secret.md)` +
            (finding.note === undefined ? '' : `. ${finding.note}`),
        );
      }
    } else {
      gate.note(dim('history not scanned (--history); the working tree is what this gate covers'));
    }

    if (options.json || options.out !== null) {
      const report = {
        schema: 'prl.secret-scan.v1',
        trackedFiles: tracked.length,
        filesRead: scanned,
        ignoreRulesChecked: MUST_BE_IGNORED.map((entry) => entry.path),
        findings: trackedFindings,
        history: history === null ? null : { blobs: history.blobs, findings: history.findings },
      };
      const text = `${JSON.stringify(report, null, 2)}\n`;
      if (options.out !== null) writeFileSync(resolve(REPO_ROOT, options.out), text);
      if (options.json) console.log(text);
    }
  });
}

if (import.meta.main) {
  await main();
}
