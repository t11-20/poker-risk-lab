/**
 * The signing half of "build once, promote the same bytes, and be able to say who built them".
 *
 * `scripts/registry-digest.mjs` closed the CONTENT IDENTITY question: a registry digest names one
 * set of bytes, the manifest was re-fetched and re-hashed in process, and the image was pulled back
 * by digest after every local reference to it had been deleted. Its own header ends with the
 * sentence this module exists to delete:
 *
 *     "Signatures. `cosign` is not installed and this module does not sign, verify or attest
 *      anything."
 *
 * ## The gap that left, stated precisely
 *
 * A content address proves that two parties hold the same bytes. It says nothing about whether the
 * bytes a deployer pulls are the bytes THIS repository built. Concretely, before this module
 * existed, all of the following were indistinguishable to every gate in the repository:
 *
 *   * the artefact `pnpm run release:artifacts` built and `pnpm run staging up` smoke-tested;
 *   * an artefact somebody else pushed to `127.0.0.1:5001/prl-api` over any tag they liked — the
 *     lab registry has no authentication, which `deploy/registry/README.md` says out loud;
 *   * an artefact a deployer typed the wrong digest for.
 *
 * All three resolve. All three pull. All three would have been deployed. `docs/production/
 * final-readiness-report.md` carried that as open residual #3: *"Images carry a registry digest but
 * no signature … nothing is signed, there is no transparency log, and a local registry is not a
 * third party."*
 *
 * A signature over the digest closes exactly one of those three, and it is worth being clear about
 * WHICH: it binds a digest to a private key. `pnpm run security:image-provenance` then refuses any
 * release image whose digest is not signed by the key whose PUBLIC half is committed at
 * `deploy/signing/cosign.pub`. An attacker who pushes different bytes gets a different digest, and
 * that digest carries no signature the committed key accepts.
 *
 * ## What a locally-held key does NOT prove, and this is the part that gets overclaimed
 *
 * Read this before quoting "the images are signed" anywhere.
 *
 *   * **It proves possession of a key, not the identity of a builder.** The key lives on the
 *     release machine, in `deploy/signing/cosign.key`, unlocked by a passphrase in
 *     `deploy/signing/signing.env`. Anybody who can read both can mint a signature this gate
 *     accepts, over any bytes at all. Keyless/OIDC signing exists precisely because that sentence
 *     is unavoidable for a long-lived local key: Fulcio issues a short-lived certificate bound to a
 *     workload identity (a GitHub Actions job in a named repository on a named ref), so the
 *     verifier can demand a builder rather than a key.
 *   * **There is no transparency log.** These signatures are made with `--tlog-upload=false` and
 *     verified with `--insecure-ignore-tlog`, because Rekor is a public log and this is a loopback
 *     registry holding a lab artefact. Without a log there is no third-party record that the
 *     signature existed at a time, so key compromise is not detectable after the fact and a
 *     signature cannot be shown to predate a revocation. cosign prints a warning saying so on every
 *     verification and this repository does not suppress it.
 *   * **Nothing here binds the artefact to a source tree.** The SBOM attestation describes what is
 *     INSIDE the image, which is a different question from what built it. A SLSA provenance
 *     predicate produced by the builder itself is what answers that, and this repository has no CI
 *     builder that can produce one.
 *
 * So the honest one-line summary, and the one the docs use: **the digest a deployer pulls is now
 * bound to a key this repository controls; it is not yet bound to a builder anybody else can
 * check.** Residual, not closed — and named as a residual rather than folded into the pass.
 *
 * ## Why the record is a sidecar and not a field in release-manifest.json
 *
 * `deploy/staging/release-manifest.json` is `release-artifacts.mjs`'s output and nothing else may
 * write it. Two concrete reasons, both load-bearing:
 *
 *   1. `scripts/staging.mjs` reads `images.<service>.registry` and switches the running stack from
 *      `pull_policy: never` to `pull_policy: always` when it is present. A signing step that wrote
 *      that block would silently change how a live staging stack resolves its images, which is a
 *      deployment change disguised as a security improvement.
 *   2. `existingManifestFor` in `release-artifacts.mjs` treats the manifest as the record of one
 *      build. A second writer means the file can describe a state no single build produced.
 *
 * So signatures live in `deploy/staging/release-signatures.json`, and the tie between the two files
 * is checked rather than assumed: `reconcileWithManifest` below fails unless every service in the
 * manifest has a signature record whose `buildDigest` is byte-identical to the manifest's digest for
 * that service. That check is the entire point of the sidecar. Without it the signatures could be
 * over some other, correctly-signed image, and every cosign verification would still pass.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIGEST, REGISTRY_DIGEST_REFERENCE } from './registry-digest.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The schema string the gate checks before trusting the sidecar's shape. */
export const SIGNATURES_SCHEMA = 'prl.release-signatures.v1';

/** Committed. The trust anchor, and the only key the verification gate needs. */
export const PUBLIC_KEY_PATH = 'deploy/signing/cosign.pub';

/** Never committed — `.gitignore` and `secret-scan.mjs` both assert that. */
export const PRIVATE_KEY_PATH = 'deploy/signing/cosign.key';

/** Where the passphrase for the private key lives on a release machine. Never committed. */
export const SIGNING_ENV_PATH = 'deploy/signing/signing.env';

/** The sidecar this module writes and the gate reads. */
export const SIGNATURES_PATH = 'deploy/staging/release-signatures.json';

/** What `release-artifacts.mjs` writes, and the only source of "what this repo built". */
export const MANIFEST_PATH = 'deploy/staging/release-manifest.json';

/**
 * The in-toto predicate type an SBOM attestation carries, and the `--type` shorthand cosign takes
 * for it. Both are asserted on the way out: `cosign attest --type cyclonedx` is what produced the
 * statement, and the gate re-derives the predicate type from the SIGNED payload rather than from
 * the flag it passed, so a cosign that quietly changed the mapping is a failure and not a silent
 * pass over a predicate nobody looked at.
 */
export const ATTESTATION_TYPE = 'cyclonedx';
export const ATTESTATION_PREDICATE_TYPE = 'https://cyclonedx.org/bom';

/**
 * The flags that turn cosign 3.x's Sigstore-by-default behaviour off, on BOTH sides.
 *
 * cosign 3 reads a TUF-provided signing config unless told not to, and then refuses
 * `--tlog-upload=false` as contradicting it:
 *
 *     Error: --tlog-upload=false is not supported with --signing-config or --use-signing-config
 *
 * `--use-signing-config=false` is what makes a keyed, log-free signature expressible at all. It is
 * written here once, as a named constant used by the signer and by the gate, so that the two can
 * never drift into signing under one policy and verifying under another — which would fail closed,
 * loudly, but for a reason that looks like a broken signature rather than a flag mismatch.
 *
 * `--allow-http-registry` and `--allow-insecure-registry` are the loopback registry's plain HTTP.
 * cosign's own help calls them testing-only flags and it is right to: they are acceptable here for
 * exactly the reason `deploy/registry/README.md` gives for the registry itself running without TLS
 * or auth on 127.0.0.1, and they would not be acceptable against a real registry.
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

/**
 * The keyless flags, and every difference from the keyed set above is deliberate.
 *
 * No `--key`, because there is none: the private key exists for ten minutes inside a GitHub Actions
 * job and is never written down. No `--use-signing-config=false`, because the Sigstore signing
 * config is exactly what we want — it is what names Fulcio and Rekor. And, most importantly, **no
 * `--tlog-upload=false` and no `--insecure-ignore-tlog`**: the keyed posture turns Rekor off
 * because it signs a loopback lab artefact, and pays for that with the residual it states out loud
 * (no third-party record, so a compromise is undetectable after the fact). Keyless signing without
 * Rekor would keep the cost and throw away the benefit, so the transparency log is not optional
 * here and `deploy/signing/keyless-policy.json` requires it.
 */
export const COSIGN_KEYLESS_SIGN_FLAGS = ['--yes'];

/**
 * `cosign verify` arguments for a keyless signature, built from the POLICY.
 *
 * A function rather than a constant because the identity is the argument that matters, and it must
 * come from the committed policy on every call — never from the signature record being checked,
 * which would let a record choose what it is compared against.
 *
 * cosign refuses to run a keyless verification with neither `--certificate-identity` nor
 * `--certificate-identity-regexp` ("required for verification in keyless mode", measured), so the
 * failure mode this guards is not a verification that asserts nothing. It is one that asserts
 * something wider than what was reviewed.
 */
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

// ---------------------------------------------------------------------------
// cosign
// ---------------------------------------------------------------------------

/**
 * cosign's version string, or null when it is not installed.
 *
 * Null is never a reason to skip anything. Both callers turn it into a refusal, for the reason
 * `container-scan.mjs` states about trivy: a verifier that exits 0 when it did not run converts
 * "nobody checked" into a green tick in a release report.
 */
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

/**
 * Runs cosign and hands back everything, including a non-zero exit.
 *
 * Deliberately never throws on a non-zero status. Every caller here has a case where cosign
 * failing is the DESIRED outcome — the negative controls in `image-provenance.mjs` assert three
 * refusals — and a helper that threw would make "it refused" and "the harness broke" the same
 * event.
 */
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

// ---------------------------------------------------------------------------
// The public key
// ---------------------------------------------------------------------------

/**
 * The SHA-256 of a PEM public key's DER body — a real key fingerprint, not a hash of the file.
 *
 * The distinction matters because the value is recorded in the sidecar and compared on every
 * verification. Hashing the FILE would make a trailing newline, a CRLF checkout or a re-export look
 * like a key rotation, and a gate that cries rotation at a line ending is a gate somebody stops
 * reading. Hashing the decoded SPKI bytes compares the key itself.
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

/** Reads and fingerprints the committed public key. Missing is a failure, never a skip. */
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

// ---------------------------------------------------------------------------
// The two records, and the tie between them
// ---------------------------------------------------------------------------

/**
 * Reads a JSON file and says why it could not, rather than throwing.
 *
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
 * Validates the shape of a signature sidecar without touching a registry.
 *
 * Pure, so `image-signing.test.mjs` can drive every malformed shape — including the ones that
 * matter most, a record that names no images and a record whose digest is not a digest. Both used
 * to be expressible: the first version of this reader iterated `Object.entries(record.images)` and
 * an empty object iterated zero times, verified zero images, and reported a pass. "A sweep of
 * nothing is not a pass" is the rule this function exists to hold; `problems` gets an entry when
 * there is nothing to check.
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

  // ## Which posture is this record in, and the answer is never "either"
  //
  // Two things can sign a release image here: a long-lived key on a release machine, or a GitHub
  // Actions job holding a ten-minute Fulcio certificate. They are verified with completely
  // different arguments — a public key against a fingerprint, or an identity and an issuer against
  // a committed policy — so a reader that guesses wrong does not verify the wrong thing, it
  // verifies NOTHING and says so.
  //
  // The failure this shape exists to prevent is subtler than a wrong guess: a record carrying
  // NEITHER a public key nor a keyless block reads, to a lazily-written reader, as "the other
  // posture, whichever that is" — and an unsigned release looks exactly like that. Absent is not
  // the other posture. Both present is not a posture either: it would let a verification that
  // failed under one be reported as a pass under the other.
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
    // Recorded, and checked against the committed policy by the gate. Never used AS the policy:
    // a record that chose what it is compared against would assert nothing at all.
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
 * The tie: every service the release manifest describes must have a signature record over THAT
 * service's build digest, and no other.
 *
 * ## Why this is the load-bearing check and cosign is not
 *
 * `cosign verify` answers "is this digest signed by this key". It cannot answer "is this digest the
 * one this repository built", because it has never seen the release manifest. Without this
 * function, a sidecar pointing at a correctly-signed but DIFFERENT image — an older release, a
 * probe image, anything the key has ever touched — passes every cosign check in the gate, and the
 * gate reports that the shipping artefacts are signed. That is the failure this whole exercise
 * exists to prevent, one level up.
 *
 * It runs in both directions on purpose. A service in the manifest with no signature entry is an
 * UNSIGNED release image, which is the original blocker. A service in the sidecar that the manifest
 * does not describe is a record that has drifted from the build, and a reader who trusts one file
 * to describe the other should be told rather than left to notice.
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

// ---------------------------------------------------------------------------
// Reading what cosign said
// ---------------------------------------------------------------------------

/**
 * The digests a successful `cosign verify` reported it had checked.
 *
 * cosign already refuses a signature whose payload names a different digest — measured, and
 * recorded in `image-provenance.mjs`'s negative-control section as the transplant case. This
 * re-derives the digest from the payload anyway, for one reason worth the twelve lines: the gate's
 * claim is "this exact digest is signed", and reading that back out of the signed statement is the
 * difference between checking the claim and trusting the tool's exit code.
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
 * Reads the SIGNED in-toto statements out of `cosign verify-attestation` output.
 *
 * The output is newline-delimited Sigstore bundles; the statement is base64 in `payload`. Parsing
 * it is not decoration: `cosign verify-attestation` exiting 0 means the envelope's signature
 * checked out, and the questions this gate has to answer are about the CONTENTS of that envelope —
 * does the statement's subject name the digest we asked about, is the predicate a CycloneDX SBOM,
 * and does that SBOM describe anything at all.
 *
 * That last one is the one with teeth. `cosign attest --predicate` will happily sign `{}`. An
 * attestation over an empty predicate verifies perfectly and describes nothing, which is the
 * file-exists-therefore-pass failure mode in cryptographic clothing. `componentCount` is what the
 * gate asserts on.
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
 * Judges one verified in-toto statement against the digest it is supposed to describe.
 *
 * Separate from the parsing above, and pure, so the tests can hand it a statement whose subject
 * names somebody else's image — the shape a transplanted or mis-recorded attestation has — without
 * a registry in the loop.
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

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

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

/** Repo-relative path to an absolute one. */
export function repoPath(...parts) {
  return join(REPO_ROOT, ...parts);
}
