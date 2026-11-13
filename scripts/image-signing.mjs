/**
 * Signs release image digests with cosign and reads the signature records back.
 * A keyed signature binds a digest to a key on the release machine. It does not prove who built the
 * image, there is no transparency log (`--tlog-upload=false`), and nothing binds it to a source tree.
 *
 * Signatures live in `deploy/staging/release-signatures.json`, not in release-manifest.json, because
 * `staging.mjs` switches `pull_policy` when the manifest has a `registry` block, and the manifest is
 * the record of one build. `reconcileWithManifest` ties the two files by build digest.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIGEST, REGISTRY_DIGEST_REFERENCE } from './registry-digest.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SIGNATURES_SCHEMA = 'prl.release-signatures.v1';

// Committed. The trust anchor.
export const PUBLIC_KEY_PATH = 'deploy/signing/cosign.pub';

// Never committed. `.gitignore` and `secret-scan.mjs` both assert that.
export const PRIVATE_KEY_PATH = 'deploy/signing/cosign.key';

export const SIGNING_ENV_PATH = 'deploy/signing/signing.env';

export const SIGNATURES_PATH = 'deploy/staging/release-signatures.json';

export const MANIFEST_PATH = 'deploy/staging/release-manifest.json';

// The gate re-derives the predicate type from the signed payload, so a changed cosign mapping fails.
export const ATTESTATION_TYPE = 'cyclonedx';
export const ATTESTATION_PREDICATE_TYPE = 'https://cyclonedx.org/bom';

/**
 * cosign 3 reads a TUF signing config by default and then refuses `--tlog-upload=false`. One constant
 * serves signer and gate so they cannot drift. The HTTP flags are for the loopback lab registry only.
 */
export const COSIGN_SIGN_FLAGS = [
  '--use-signing-config=false',
  '--tlog-upload=false',
  '--allow-http-registry',
  '--allow-insecure-registry',
  '--yes',
];

export const COSIGN_VERIFY_FLAGS = [
  '--insecure-ignore-tlog',
  '--allow-http-registry',
  '--allow-insecure-registry',
];

// Keyless keeps the Sigstore signing config and Rekor on purpose. `deploy/signing/keyless-policy.json`
// requires the transparency log.
export const COSIGN_KEYLESS_SIGN_FLAGS = ['--yes'];

// The identity comes from the committed policy on every call, never from the record being checked.
export function keylessVerifyFlags({ identity, issuer }) {
  return [
    '--certificate-identity',
    identity,
    '--certificate-oidc-issuer',
    issuer,
    '--allow-http-registry',
    '--allow-insecure-registry',
  ];
}

// Null is never a reason to skip. Both callers refuse on it.
export function cosignVersion() {
  const result = spawnSync('cosign', ['version', '--json'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout ?? '');
    return typeof parsed?.gitVersion === 'string' ? parsed.gitVersion : null;
  } catch {
    return null;
  }
}

// Never throws on a non-zero exit, because the negative controls expect cosign to refuse.
export function runCosign(args, { env = process.env } = {}) {
  const result = spawnSync('cosign', args, {
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

/**
 * SHA-256 of the PEM's DER body. Hashing the file would report a line-ending change as a key rotation.
 *
 * @param {string} pem
 * @returns {{fingerprint: string, der: Buffer} | {problem: string}}
 */
export function publicKeyFingerprint(pem) {
  if (typeof pem !== 'string' || pem.trim() === '') return { problem: 'the public key file is empty' };
  const match = /-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/.exec(pem);
  if (match === null) {
    return {
      problem:
        'the public key file does not contain a PEM "BEGIN PUBLIC KEY" block. A verification gate ' +
        'anchored on an unreadable key is a gate anchored on nothing.',
    };
  }
  const base64 = (match[1] ?? '').replace(/\s+/g, '');
  if (base64 === '') return { problem: 'the PEM block in the public key file is empty' };
  let der;
  try {
    der = Buffer.from(base64, 'base64');
  } catch (err) {
    return { problem: `the PEM block is not base64: ${err.message}` };
  }
  if (der.length < 32) {
    return { problem: `the PEM block decodes to ${der.length} bytes, which is not a public key` };
  }
  return { fingerprint: createHash('sha256').update(der).digest('hex'), der };
}

// Missing is a failure, never a skip.
export function readPublicKey(path = PUBLIC_KEY_PATH) {
  const full = resolve(REPO_ROOT, path);
  if (!existsSync(full)) {
    return {
      problem:
        `no public key at ${path}. This is the trust anchor: without it nothing can be verified, ` +
        'and a verification step with no key is not a weaker check, it is no check. See ' +
        'deploy/signing/README.md.',
    };
  }
  const parsed = publicKeyFingerprint(readFileSync(full, 'utf8'));
  if ('problem' in parsed) return { problem: `${path}: ${parsed.problem}` };
  return { ...parsed, path, full };
}

/**
 * @param {string} path repo-relative
 */
export function readJsonFile(path) {
  const full = resolve(REPO_ROOT, path);
  if (!existsSync(full)) return { problem: `${path} does not exist` };
  try {
    return { value: JSON.parse(readFileSync(full, 'utf8')), full };
  } catch (err) {
    return { problem: `${path} is not valid JSON: ${err.message}` };
  }
}

/**
 * Validates a signature sidecar's shape without a registry. A record with no images is a problem,
 * not a pass over zero images.
 *
 * @param {unknown} raw
 * @returns {{images: Array<object>, meta: object, problems: string[]}}
 */
export function parseSignatureRecord(raw) {
  const problems = [];
  const images = [];
  const meta = {
    schema: null,
    signedAt: null,
    publicKeyFingerprint: null,
    registry: null,
    posture: null,
    keyless: null,
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { images, meta, problems: ['the signature record is not a JSON object'] };
  }
  if (raw.schema !== SIGNATURES_SCHEMA) {
    problems.push(
      `the signature record's schema is ${JSON.stringify(raw.schema ?? null)}, expected ` +
        `${SIGNATURES_SCHEMA}. A reader that guesses at an unknown shape is a reader that can ` +
        'report a pass over fields it never found.',
    );
    return { images, meta, problems };
  }
  meta.schema = raw.schema;
  meta.signedAt = typeof raw.signedAt === 'string' ? raw.signedAt : null;
  meta.registry = typeof raw.registry === 'string' ? raw.registry : null;

  // A record is keyed or keyless, never both and never neither. An unsigned release carries neither.
  const hasKey = raw.publicKey != null;
  const hasKeyless = raw.keyless != null;
  if (hasKey && hasKeyless) {
    problems.push(
      'the signature record claims BOTH a public key and a keyless identity. A signature is made ' +
        'one way; a record in two postures lets a check that failed under one be reported as a ' +
        'pass under the other.',
    );
    return { images, meta, problems };
  }
  if (!hasKey && !hasKeyless) {
    problems.push(
      'the signature record names no signing posture at all — no publicKey, no keyless identity. ' +
        'Nothing says what these signatures could be verified against, and "absent" must never be ' +
        'read as "the other posture": an unsigned release looks precisely like this.',
    );
    return { images, meta, problems };
  }
  meta.posture = hasKeyless ? 'keyless' : 'key';
  if (raw.posture !== undefined && raw.posture !== meta.posture) {
    problems.push(
      `the record says posture ${JSON.stringify(raw.posture)} and its contents are ${meta.posture}. ` +
        'The label and the material disagree; the label is the part a human reads.',
    );
    return { images, meta, problems };
  }

  if (hasKeyless) {
    const identity = raw.keyless?.identity;
    const issuer = raw.keyless?.issuer;
    if (typeof identity !== 'string' || identity === '') {
      problems.push(
        'the keyless signature record carries no certificate identity. A keyless signature ' +
          "verifies against SOME Fulcio certificate, and Fulcio issues one to anybody's GitHub " +
          'Actions job — the identity is the whole difference between "signed" and "signed by this ' +
          'builder".',
      );
    }
    if (typeof issuer !== 'string' || issuer === '') {
      problems.push('the keyless signature record carries no OIDC issuer');
    }
    if (raw.transparencyLog?.used !== true) {
      problems.push(
        'the keyless signature record does not claim a transparency-log entry. Keyless signing ' +
          'without Rekor keeps the cost of the keyed posture — no third-party record, so a ' +
          'compromise is undetectable after the fact — and throws away the reason for the exercise.',
      );
    }
    // Recorded and checked against the committed policy. Never used as the policy.
    meta.keyless = {
      identity: typeof identity === 'string' ? identity : null,
      issuer: typeof issuer === 'string' ? issuer : null,
      workflow: raw.keyless?.workflow ?? null,
      rekor: raw.transparencyLog ?? null,
    };
  } else {
    const fingerprint = raw.publicKey?.fingerprint;
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      problems.push(
        'the signature record carries no usable publicKey.fingerprint, so the gate cannot tell ' +
          'whether the committed key is the key these signatures were made with',
      );
    } else {
      meta.publicKeyFingerprint = fingerprint;
    }
  }

  const entries = Object.entries(raw.images ?? {});
  if (entries.length === 0) {
    problems.push(
      'the signature record names no images. An empty record verifies nothing and would otherwise ' +
        'report a pass for having found nothing to check.',
    );
    return { images, meta, problems };
  }
  for (const [service, image] of entries) {
    const where = `images.${service}`;
    if (image === null || typeof image !== 'object') {
      problems.push(`${where} is not an object`);
      continue;
    }
    if (!DIGEST.test(String(image.buildDigest))) {
      problems.push(`${where}.buildDigest is not a sha256 digest: ${JSON.stringify(image.buildDigest)}`);
      continue;
    }
    if (!DIGEST.test(String(image.registryDigest))) {
      problems.push(
        `${where}.registryDigest is not a sha256 digest: ${JSON.stringify(image.registryDigest)}`,
      );
      continue;
    }
    if (!REGISTRY_DIGEST_REFERENCE.test(String(image.reference))) {
      problems.push(
        `${where}.reference is not a registry digest reference: ${JSON.stringify(image.reference)}. ` +
          'A signature is over a digest; a tag reference here would mean the gate verified whatever ' +
          'that tag points at today.',
      );
      continue;
    }
    if (image.signed !== true) {
      problems.push(`${where} is recorded without \`signed: true\` — nothing claims this was signed`);
      continue;
    }
    images.push({
      service,
      repository: typeof image.repository === 'string' ? image.repository : null,
      buildDigest: image.buildDigest,
      registryDigest: image.registryDigest,
      reference: image.reference,
      attested: image.attestation != null,
      attestation: image.attestation ?? null,
    });
  }
  return { images, meta, problems };
}

/**
 * Every manifest service must have a signature over that service's build digest, and the sidecar may
 * name no other service. `cosign verify` cannot see the manifest, so without this a correctly signed
 * but different image would pass.
 *
 * @param {Array<{service: string, buildDigest: string}>} signatures
 * @param {unknown} manifest parsed release-manifest.json
 * @returns {{problems: string[], matched: string[]}}
 */
export function reconcileWithManifest(signatures, manifest) {
  const problems = [];
  const matched = [];
  const manifestImages = Object.entries(manifest?.images ?? {});
  if (manifestImages.length === 0) {
    problems.push(
      'the release manifest names no images, so there is nothing to tie the signatures to. This is ' +
        'a failure and not a skip: a verification with no subject proves nothing.',
    );
    return { problems, matched };
  }
  const byService = new Map(signatures.map((entry) => [entry.service, entry]));
  for (const [service, image] of manifestImages) {
    const digest = image?.digest;
    if (!DIGEST.test(String(digest))) {
      problems.push(`the release manifest's ${service} entry has no usable digest`);
      continue;
    }
    const signature = byService.get(service);
    if (signature === undefined) {
      problems.push(
        `${service} ${digest} is in the release manifest and is NOT signed — no entry for it in ` +
          'the signature record. This is the blocker in its original form: an unsigned release ' +
          'image. Run `pnpm run release:sign`.',
      );
      continue;
    }
    if (signature.buildDigest !== digest) {
      problems.push(
        `${service}: the signature record covers ${signature.buildDigest} and the release manifest ` +
          `built ${digest}. The signed artefact is not the artefact this commit produced, so every ` +
          'cosign check below would pass over the wrong image.',
      );
      continue;
    }
    matched.push(service);
  }
  for (const entry of signatures) {
    if (manifestImages.some(([service]) => service === entry.service)) continue;
    problems.push(
      `the signature record covers a service the release manifest does not describe: ${entry.service}. ` +
        'The two files have drifted; re-run `pnpm run release:sign` against the current manifest.',
    );
  }
  return { problems, matched };
}

/**
 * The digests a successful `cosign verify` reports. Read back from the signed payload so the gate
 * checks the claim rather than the exit code.
 *
 * @param {string} stdout
 * @returns {{digests: string[], problem: string|null}}
 */
export function verifiedDigests(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return { digests: [], problem: `cosign verify printed output that is not JSON: ${err.message}` };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { digests: [], problem: 'cosign verify exited 0 but reported no signatures at all' };
  }
  const digests = [];
  for (const entry of parsed) {
    const digest = entry?.critical?.image?.['docker-manifest-digest'];
    if (typeof digest === 'string' && DIGEST.test(digest)) digests.push(digest);
  }
  if (digests.length === 0) {
    return { digests, problem: 'no signature payload carried a docker-manifest-digest' };
  }
  return { digests, problem: null };
}

/**
 * Reads the signed in-toto statements from `cosign verify-attestation` output (base64 `payload` in
 * newline-delimited bundles). `cosign attest` signs `{}` happily, so the gate asserts `componentCount`.
 *
 * @param {string} stdout
 * @returns {{statements: Array<object>, problem: string|null}}
 */
export function parseAttestationStatements(stdout) {
  const lines = String(stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) {
    return { statements: [], problem: 'cosign verify-attestation exited 0 and printed nothing' };
  }
  const statements = [];
  for (const [index, line] of lines.entries()) {
    let bundle;
    try {
      bundle = JSON.parse(line);
    } catch (err) {
      return { statements, problem: `attestation ${index} is not JSON: ${err.message}` };
    }
    const payload = bundle?.payload;
    if (typeof payload !== 'string') {
      return { statements, problem: `attestation ${index} carries no base64 payload` };
    }
    let statement;
    try {
      statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    } catch (err) {
      return { statements, problem: `attestation ${index}'s payload is not JSON: ${err.message}` };
    }
    statements.push(statement);
  }
  return { statements, problem: null };
}

/**
 * Pure, so tests can pass a statement whose subject names another image.
 *
 * @param {object} statement
 * @param {string} digest `sha256:…`
 * @returns {{problems: string[], components: number}}
 */
export function attestationProblems(statement, digest) {
  const problems = [];
  const predicateType = statement?.predicateType;
  if (predicateType !== ATTESTATION_PREDICATE_TYPE) {
    problems.push(
      `the attestation's predicateType is ${JSON.stringify(predicateType ?? null)}, expected ` +
        `${ATTESTATION_PREDICATE_TYPE}. Read from the signed statement, not from the --type flag ` +
        'this gate passed: the flag is what we asked for and the payload is what was signed.',
    );
  }
  const subjects = Array.isArray(statement?.subject) ? statement.subject : [];
  const hex = String(digest).replace(/^sha256:/, '');
  const names = subjects.map((subject) => subject?.digest?.sha256).filter((value) => value != null);
  if (!names.includes(hex)) {
    problems.push(
      `the attestation's subject is ${names.length === 0 ? '(none)' : names.join(', ')} and the ` +
        `image being verified is ${hex}. An attestation that describes a different artefact is ` +
        'evidence about that other artefact, not about this one.',
    );
  }
  const components = Array.isArray(statement?.predicate?.components)
    ? statement.predicate.components.length
    : 0;
  if (components === 0) {
    problems.push(
      'the attested SBOM lists zero components. `cosign attest` will sign an empty predicate and ' +
        'the signature over it verifies perfectly, so "an attestation exists" is not evidence that ' +
        'anything was inventoried. A sweep of nothing is not a pass.',
    );
  }
  return { problems, components };
}

/** Trimmed stdout of a command expected to succeed, or null. */
export function capture(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function repoPath(...parts) {
  return join(REPO_ROOT, ...parts);
}
