#!/usr/bin/env node
/**
 * Gate: no credential material in the repository, and no way for one to get in by accident.
 *
 * Node standard library only, no network, no external tool, so it runs everywhere the repo runs.
 * It asks two questions. Does a tracked file contain a credential? Can a credential become tracked
 * by accident? The second is checked against the ignore rules, not the files: for every path the
 * docs tell an operator to create with a secret in it, `git check-ignore --no-index` must match,
 * whether or not the file exists. This gate exists because `deploy/backup/backup.env` (which holds
 * PRL_BACKUP_KEY) was matched by no ignore rule.
 *
 * Findings print redacted (first four characters and the length), because CI logs outlive the file.
 *
 * Suppression is an inline `prl-allow-secret: <reason>` pragma, not an expiring allowlist, because a
 * false positive here never held a credential. The reason is mandatory. On the finding's own line it
 * suppresses every finding on that line. On the line above it suppresses only the leftmost finding,
 * so a real token appended to a blessed line is still reported. A value published on purpose
 * belongs in `PUBLISHED_CONSTANTS`, keyed by SHA-256, because `--history` can consult a hash but not
 * a comment that only exists in today's blob.
 *
 * `--history` scans every reachable blob. It is opt-in because its only remedy is a history rewrite
 * plus rotation (docs/production/runbooks/leaked-secret.md), and a permanently red gate gets turned off.
 *
 * Not proved: that there are no secrets. A password that looks like a word, a key split across two
 * literals, a file type it does not read, and a generic name-and-value on a line longer than
 * `MAX_GENERIC_LINE_LENGTH` all pass.
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

/**
 * Not text, or generated content whose high-entropy fields are integrity hashes. Lockfiles are
 * excluded by name in `SKIP_NAMES`, since every `sha512-` hash in them would be reported.
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

/**
 * Every path the docs tell somebody to create with a real credential in it. The `why` is printed
 * on failure, so the operator knows what would have been published.
 *
 * Exported as the authority on credential paths. `scripts/release-artifacts.mjs` probes the built
 * images for these too, so an entry added here extends both gates.
 */
export const MUST_BE_IGNORED = [
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
     * A leaked signing key lets any reader mint signatures `security:image-provenance` accepts.
     * `NEVER_TRACKED` matches `\.key$` only after the file is tracked; this rule stops `git add -A`.
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
 * Paths that are credential material by their nature. There is no pragma for a path rule, because
 * the file being tracked is the finding. To allow a public certificate, edit this list and say why.
 */
export const NEVER_TRACKED = [
  { pattern: /(^|\/)\.env$/, what: 'an environment file' },
  /**
   * `.env.<anything>` except templates (final dot-segment `example`) and `.env.d.ts` type
   * declarations. `.env.test`, `.env.local`, `.env.production` and friends stay blocked because
   * they hold real values on somebody's disk.
   */
  { pattern: /(^|\/)\.env\.(?!(?:[^/]*\.)?example$)(?!d\.ts$)[^/]+$/, what: 'an environment file' },
  { pattern: /\.(?:pem|key|p12|pfx|jks|keystore)$/, what: 'key or certificate material' },
  { pattern: /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/, what: 'an SSH private key' },
];

/**
 * `.npmrc` is tracked on purpose, because pnpm reads its registry pinning from there
 * (`policy-check.mjs` depends on it). So auth fields are a content detector, not a path rule.
 */
const NPMRC_AUTH = /^\s*(?:\/\/.*:)?_(?:auth|authToken|password)\s*=\s*(\S+)/gim;

/** Provider token shapes with a fixed prefix. They fire regardless of entropy or name. */
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
 * A URL with a password in it, pointing at a host somebody else can reach. Loopback, private
 * addresses and single-label compose hosts are skipped, because `postgres://prl:prl@localhost` is
 * the dev stack's published throwaway credential in fifty places. The password allows `/`.
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
  // `.internal` is reserved for private use and resolves only inside its network.
  if (lowered.endsWith('.internal')) return true;
  return !lowered.includes('.');
}

/**
 * Names whose value is a credential by definition, anchored as a suffix so `TOKEN_BUDGET` does not
 * match. The separator is optional so camelCase `awsSecretAccessKey` matches like
 * `AWS_SECRET_ACCESS_KEY`. A bare `key` is included because `PRL_BACKUP_KEY` needs it.
 *
 * The cost of bare `key` is accepted. A hashed cache key, a hex idempotency token, a commit SHA and
 * a public VAPID key all pass every value test and are reported, so each needs a pragma.
 */
const SECRET_NAME_PART =
  '(?:[A-Za-z0-9_.-]*[_.-]?)?(?:secret|password|passwd|passphrase|pwd|key|auth[_-]?token|token|credential)s?';

/**
 * A credential-shaped name assigned a quoted literal. Quotes are required because the first run
 * reported thirty lines like `const secret = config.sessionCookieSecret`, and only a literal leaks.
 */
const SECRET_LITERAL = new RegExp(
  `(?:^|[^A-Za-z0-9])(${SECRET_NAME_PART})\\s*[:=]\\s*(['"\`])([^'"\`\\n]+)\\2`,
  'gi',
);

/**
 * `NAME=value` in an env file, unquoted, to end of line. Spaces around `=` are allowed because
 * `~/.aws/credentials` writes them.
 */
const SECRET_ENV_ASSIGNMENT =
  /^\s*(?:export\s+)?((?:[A-Za-z0-9_-]*[_-])?(?:secret|password|passwd|passphrase|pwd|key|auth[_-]?token|token|credential)s?)\s*=\s*(\S+)\s*$/i;

/**
 * `key: value` in a YAML or JSON mapping, where `SECRET_LITERAL` (quotes) and
 * `SECRET_ENV_ASSIGNMENT` (`=`) cannot see an unquoted scalar.
 *
 * Gated on the extension. Run over the whole repo, `key: 'x'` object literals gave 62 false
 * positives; over the 42 tracked YAML and JSON files it gave 0.
 *
 * A credential-shaped key with a passing value is a finding. So is any key whose value is
 * `Bearer|Basic|Token <t>`, with the scheme word stripped first because `isPlaceholder` rejects
 * spaces. A `#` comment line matches neither.
 */
const STRUCTURED_MAPPING =
  /^[\s-]*"?([A-Za-z0-9_.-]+)"?\s*:\s*(?:'([^']*)'|"([^"]*)"|([^\s#,][^#,]*?))\s*,?\s*(?:#.*)?$/;

/** The `key:` half of `STRUCTURED_MAPPING`, tested whole rather than as a substring. */
const STRUCTURED_SECRET_NAME = new RegExp(`^${SECRET_NAME_PART}$`, 'i');

/** `Bearer <token>`, and its two siblings, in a config file's value position. */
const AUTH_SCHEME_VALUE = /^(?:Bearer|Basic|Token)\s+(\S+)$/i;

/** Extensions where a `name: value` line is configuration and cannot be code. */
const STRUCTURED_EXTENSIONS = new Set(['.yml', '.yaml', '.json']);

/** False for an empty path, so a caller that forgets the path loses a detector instead. */
export function isStructuredConfig(path) {
  const lower = String(path ?? '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  const slash = lower.lastIndexOf('/');
  return dot > slash && STRUCTURED_EXTENSIONS.has(lower.slice(dot));
}

/** The shortest value the generic detector will look at. */
const MIN_SECRET_LENGTH = 20;

/** Shannon entropy per character, in bits. */
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

/** Values that are obviously not credentials. Each shape is one this repo uses. */
export function isPlaceholder(value) {
  const trimmed = value.trim();
  if (trimmed === '') return true;
  // Interpolation reads a secret held elsewhere.
  if (trimmed.includes('${')) return true;
  // Nothing generates a credential with a space in it; a quoted phrase is prose.
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
  // The shipped `.env.example` value, which `config.ts` refuses in production.
  if (/^(?:your|my|the|some|a|replace|generate|insert|fill|set)[-_]/i.test(trimmed)) return true;
  if (/^x{4,}$/i.test(trimmed)) return true;
  // An ISO-8601 timestamp, reached through cursor names like `startedAtKey`.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(trimmed)) return true;
  if (/^\.{3,}$/.test(trimmed)) return true;
  // One character repeated is a fixture ('a'.repeat(64) and its literal twin).
  if (/^(.)\1+$/.test(trimmed)) return true;
  return isTypedName(trimmed);
}

/**
 * A typed name: kebab or snake with three segments, camelCase with no digits, or a dotted
 * namespace. Generated credentials have none of these shapes. The cost is that a genuine
 * four-word passphrase is invisible to this gate.
 */
export function isTypedName(value) {
  if (/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+){2,}$/.test(value)) return true;
  if (/^[a-z]+(?:[A-Z][a-z]+)+$/.test(value)) return true;
  return /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/.test(value);
}

/**
 * Values published on purpose, recorded by SHA-256 so the value is not restated here. The API test
 * suite shares one SESSION_COOKIE_SECRET across thirty-five files. An entry claims the value grants
 * nothing. To add one:
 *
 *     node -e "console.log(require('node:crypto').createHash('sha256').update('VALUE').digest('hex'))"
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

/** Four characters identify a provider prefix without disclosing a credential's entropy. */
export function redact(value) {
  const head = value.slice(0, 4);
  return `${head}… (${value.length} chars)`;
}

/**
 * Past this width only the anchored `TOKEN_DETECTORS` run. They are linear, and a minified config
 * is a likely place for an injected credential. The generic detectors open with greedy runs that
 * are O(n^2) in line length, so they stay bounded. The longest hand-written line here is 1,608
 * characters.
 */
const MAX_GENERIC_LINE_LENGTH = 4096;

/**
 * Every finding in one text. `note` explains a finding that would otherwise look arbitrary.
 * `path` only decides whether `STRUCTURED_MAPPING` runs, and its default turns that detector off.
 *
 * @param {string} text
 * @param {string} [path] repo-relative path, for extension-gated detectors
 * @returns {Array<{line: number, column: number, detector: string, evidence: string, note?: string}>}
 */
export function scanText(text, path = '') {
  const findings = [];
  const lines = text.split('\n');
  const structured = isStructuredConfig(path);

  const looksLikeSecret = (value) =>
    value.length >= MIN_SECRET_LENGTH &&
    !isPlaceholder(value) &&
    shannonEntropy(value) >= MIN_ENTROPY_BITS &&
    !PUBLISHED_CONSTANTS.has(createHash('sha256').update(value).digest('hex'));

  for (const [index, line] of lines.entries()) {
    const oversized = line.length > MAX_GENERIC_LINE_LENGTH;

    // Collected before suppression, so a preceding-line pragma can be spent on one finding.
    const candidates = [];
    const record = (detector, value, column, note) => {
      const finding = { line: index + 1, column, detector, evidence: redact(value) };
      if (note !== undefined) finding.note = note;
      candidates.push(finding);
    };

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

      if (structured) {
        const mapping = STRUCTURED_MAPPING.exec(line);
        if (mapping !== null) {
          const name = mapping[1];
          const value = (mapping[2] ?? mapping[3] ?? mapping[4] ?? '').trim();
          const scheme = AUTH_SCHEME_VALUE.exec(value);
          if (scheme !== null) {
            if (looksLikeSecret(scheme[1])) record('config-auth-scheme', scheme[1], 1);
          } else if (STRUCTURED_SECRET_NAME.test(name) && looksLikeSecret(value)) {
            record('config-secret-value', value, 1);
          }
        }
      }
    }

    // A pragma on the line itself suppresses every finding on it.
    if (PRAGMA.test(line)) continue;

    // A pragma on the line above suppresses only the leftmost finding. The rest are reported with
    // a note, so a real token appended to a blessed line is not hidden.
    if (candidates.length > 0 && index > 0 && PRAGMA.test(lines[index - 1] ?? '')) {
      let leftmost = 0;
      for (let i = 1; i < candidates.length; i++) {
        const candidate = candidates[i];
        const best = candidates[leftmost];
        if (candidate !== undefined && best !== undefined && candidate.column < best.column) leftmost = i;
      }
      candidates.splice(leftmost, 1);
      for (const finding of candidates) {
        // Appended, because an oversized line can carry both notes.
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

/** Auth fields in an `.npmrc`. `_auth=` in a markdown fence is documentation. */
export function scanNpmrc(text) {
  const findings = [];
  const lines = text.split('\n');
  NPMRC_AUTH.lastIndex = 0;
  let match = NPMRC_AUTH.exec(text);
  while (match !== null) {
    const index = text.slice(0, match.index).split('\n').length - 1;
    // The same suppressions as `scanText`. `NPMRC_AUTH` matches at most once per line, so the
    // one-finding limit is already the shape of this loop. Without them `_authToken=${NODE_AUTH_TOKEN}`,
    // the correct way to write a CI npmrc, was reported.
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

/** Every blob reachable from every ref, scanned once per unique object. */
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
    // Path-aware, so a deleted YAML/JSON config is scanned as one. Identical content at two paths is
    // one scan under the first path git lists.
    for (const finding of scanText(content, path)) {
      findings.push({ ...finding, path, oid });
    }
  }
  return { findings, blobs };
}

const options = {
  history: process.argv.includes('--history'),
  json: process.argv.includes('--json'),
  out: (() => {
    const at = process.argv.indexOf('--out');
    return at === -1 ? null : (process.argv[at + 1] ?? null);
  })(),
};

/**
 * Guarded so importing this module from `secret-scan.test.mjs` does not run the gate and set
 * `process.exitCode`, which `node --test` never resets.
 */
function main() {
  return runGate(gate, () => {
    const tracked = trackedFiles();
    if (tracked.length === 0) {
      // A sweep of nothing is not a pass.
      gate.fail('git tracks no files here', 'a scan of an empty file list is not a clean scan');
      return;
    }

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
      const found = scanText(text, path);
      if ((path.split('/').pop() ?? path) === '.npmrc') found.push(...scanNpmrc(text));
      for (const finding of found) {
        trackedFindings.push({ ...finding, path });
        gate.fail(
          `${path}:${finding.line}:${finding.column} ${finding.detector}`,
          `${finding.evidence} — if this is not a credential, say so with a \`prl-allow-secret: <reason>\` comment` +
            (finding.note === undefined ? '' : `. ${finding.note}`),
        );
      }
    }
    gate.note(`${scanned} tracked file(s) read, ${tracked.length} tracked in total`);
    gate.note(`${MUST_BE_IGNORED.length} secret-bearing path(s) checked against the ignore rules`);

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
