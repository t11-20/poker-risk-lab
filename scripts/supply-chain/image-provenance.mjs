#!/usr/bin/env node

/**
 * Gate: every release image is signed, by digest, by whichever posture the release is actually in —
 * the key this repository committed, or the CI workflow identity the committed policy names.
 *
 * Invoked by `pnpm run security:image-provenance`, and by `scripts/supply-chain/audit.mjs`.
 *
 * ## Two postures, and never "either"
 *
 * A release built on a workstation is signed with a long-lived key and verified against
 * `deploy/signing/cosign.pub`. A release signed by `.github/workflows/release-sign.yml` carries no
 * key at all: a ten-minute Fulcio certificate naming the workflow, verified against the identity
 * and issuer in `deploy/signing/keyless-policy.json`, with a Rekor entry behind it. The gate reads
 * the signature record, decides which posture it is in, and verifies THAT one.
 *
 * The rule that makes this safe is in `parseSignatureRecord`: a record carrying neither a public
 * key nor a keyless identity is REFUSED, because that is precisely what an unsigned release looks
 * like, and "absent" must never be read as "the other posture, presumably". A record carrying both
 * is refused too — it would let a check that failed under one be reported as a pass under the other.
 *
 * ## What the keyless posture adds, and what it does not
 *
 * A keyless signature verifies against SOME Fulcio certificate, and Fulcio issues one to anybody's
 * GitHub Actions job. What makes it provenance is that this gate demands a specific
 * `--certificate-identity` and `--certificate-oidc-issuer`, taken from the committed policy and
 * never from the record being checked. A verification that omitted them would accept a signature
 * made by a workflow in a repository nobody has heard of — see `runKeylessNegativeControl`, which
 * demonstrates the refusals with real cosign output and no network.
 *
 * **Status: the keyless posture is IMPLEMENTED AND UNEXERCISED.** No run of the signing workflow
 * has happened, so no Fulcio certificate and no Rekor entry exist for this repository, and every
 * release image today is in the KEY posture. Nothing here should be read as saying otherwise.
 *
 * ## The defect this exists for
 *
 * `docs/production/final-readiness-report.md` carried this as open residual 3, and the wording is
 * worth keeping because it is exactly right about what was and was not proven:
 *
 *     "Images carry a registry digest but no signature. `release:artifacts --push` publishes to a
 *      registry and the round trip is proven — the manifest is re-fetched and re-hashed in process,
 *      and every local reference is deleted and pulled back by digest before the ids are compared.
 *      So content identity across a push/pull boundary holds … What does not exist is provenance:
 *      nothing is signed, there is no transparency log, and a local registry is not a third party."
 *
 * Content identity answers "do two machines hold the same bytes". It does not answer "are these the
 * bytes this repository built", and the lab registry has no authentication at all — anything that
 * can reach 127.0.0.1:5001 can push under `prl-api`. A deployer pulling `prl-api@sha256:…` got
 * precisely the bytes they named and no way whatsoever to tell whose they were.
 *
 * ## What this gate refuses, and each one is a demonstrated refusal
 *
 * `--negative-control` runs all of these against throwaway images in the registry and FAILS THE
 * GATE unless each one is refused. This is not decoration: before this file existed, every one of
 * the three key states below produced no output from anything, which is indistinguishable from a
 * pass. A guard that has never been shown refusing is a guard nobody has tested.
 *
 *   1. **An UNSIGNED digest.** `cosign verify` exits 10 with "no signatures found".
 *   2. **A digest signed by a DIFFERENT key.** Exits 1: "accepted signatures do not match
 *      threshold, Found: 0, Expected 1".
 *   3. **A TAMPERED digest carrying a transplanted signature.** An attacker who re-pushes different
 *      content gets a different digest, so control 1 already covers the naive case. Control 3 is
 *      the interesting one: copy the valid signature index from image A onto image B's
 *      `sha256-<digest>` fallback tag, which the unauthenticated registry accepts with a 201, and
 *      verify B. Exits 1: "provided artifact digest does not match any digest in statement" —
 *      because the digest is inside the SIGNED payload, so moving the signature does not move what
 *      it says.
 *
 * And four more for the keyless posture, against a certificate minted by a throwaway CA that stands
 * in for Fulcio (`runKeylessNegativeControl` is explicit about what that substitution does and does
 * not demonstrate):
 *
 *   4. **A certificate identity from ANOTHER OWNER.** Exits 1: `expected SAN value "…attacker-org…",
 *      got "…prl-negative-control…"`.
 *   5. **A certificate identity naming ANOTHER WORKFLOW FILE.** Same refusal — the file name is
 *      part of the identity, which is why renaming the signing workflow is release-blocking.
 *   6. **A certificate from ANOTHER ISSUER.** Exits 1: `expected issuer value "https://gitlab…"`.
 *   7. **A verification that asserts NO identity at all.** cosign's own rule, and worth knowing:
 *      `--certificate-identity or --certificate-identity-regexp is required for verification in
 *      keyless mode`. The dangerous verifier is not one that asserts nothing — it is one that
 *      asserts something wider than what was reviewed.
 *
 * A further refusal has nothing to do with cosign and is the one that actually ties this to the
 * release: `reconcileWithManifest` in `scripts/image-signing.mjs` fails unless the signed digest is
 * byte-identical to the digest `deploy/staging/release-manifest.json` records for that service.
 * Without it, a sidecar pointing at some OTHER correctly-signed image passes every cryptographic
 * check here and the gate reports that the shipping artefacts are signed.
 *
 * ## Public key only. This is a property, not a convenience.
 *
 * Nothing in this file reads `deploy/signing/cosign.key` and nothing may. The signer is a separate
 * script (`scripts/release-sign.mjs`) precisely so that a machine which can CHECK a signature
 * cannot MINT one. `--negative-control` needs a signing key to produce its own probe signature and
 * generates an EPHEMERAL keypair in a temp directory for it, discarded at the end; the release key
 * is never involved, and the ephemeral public key doubles as the wrong key for control 2.
 *
 * ## Refusing is the whole point
 *
 *   * cosign missing            → FAIL, with how to install it. Never a skip.
 *   * no signature record       → FAIL. "The file is absent" is the unsigned state, not an
 *                                 exemption from being checked.
 *   * record names no images    → FAIL. A verification with no subject proves nothing.
 *   * registry unreachable      → FAIL. A signature nobody can fetch is a signature nobody has.
 *   * attestation over an empty
 *     predicate                 → FAIL. `cosign attest` signs `{}` happily; the signature over it
 *                                 verifies perfectly and describes nothing.
 *
 * ## What this gate does NOT prove
 *
 * Read this before quoting it, and read which posture the run reported first — the gate prints it,
 * and the two claims are genuinely different.
 *
 * **KEY posture** (every release image as things stand). These signatures are made with a
 * long-lived key held on the release machine, with no transparency log behind them. The gate proves
 * the digests were signed by whoever holds that key. It does NOT identify a builder, a source tree
 * or a build environment, and without a log there is no third-party record that a signature existed
 * at a time, so key compromise is not detectable after the fact.
 *
 * **KEYLESS posture** (what a CI-built release gets, once the workflow has ever run). The signature
 * identifies the workflow, the repository and the ref, and Rekor is a witness that the certificate
 * was issued when it says. It still does NOT describe what went INTO the image: that is a SLSA
 * provenance predicate emitted by the builder, and nothing here emits one. The SBOM attestation
 * says what is inside the artefact, which is a third question again.
 *
 * `deploy/signing/README.md` § "What this does not prove" is the long version, and
 * `docs/production/final-readiness-report.md` keeps the remainder as a named residual rather than
 * folding it into the pass.
 *
 * Usage:
 *     node scripts/supply-chain/image-provenance.mjs [--manifest <path>] [--signatures <path>]
 *                 [--public-key <path>] [--policy <path>] [--require-attestation]
 *                 [--negative-control] [--json]
 *
 * Exit codes: 0 every release image verified; 1 anything else, including a refusal to run.
 * 0 for --help.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTESTATION_TYPE,
  attestationProblems,
  COSIGN_SIGN_FLAGS,
  COSIGN_VERIFY_FLAGS,
  cosignVersion,
  keylessVerifyFlags,
  MANIFEST_PATH,
  PUBLIC_KEY_PATH,
  parseAttestationStatements,
  parseSignatureRecord,
  readJsonFile,
  readPublicKey,
  reconcileWithManifest,
  runCosign,
  SIGNATURES_PATH,
  verifiedDigests,
} from '../image-signing.mjs';
import {
  bundleCertificate,
  certificateIdentity,
  expectedCertificateIdentity,
  identityProblems,
  KEYLESS_POLICY_PATH,
  parseKeylessPolicy,
  resolveRepository,
} from '../keyless-identity.mjs';
import { parseRegistryHost, verifyRegistryDigest } from '../registry-digest.mjs';
import { bold, dim, Gate, green, red, runGate } from './lib.mjs';

const DEFAULTS = {
  manifest: MANIFEST_PATH,
  signatures: SIGNATURES_PATH,
  publicKey: PUBLIC_KEY_PATH,
  policy: KEYLESS_POLICY_PATH,
};

const HELP = `
${bold('pnpm run security:image-provenance')} — verify the release images are signed

  Options:
    --manifest <path>      release manifest        (default ${DEFAULTS.manifest})
    --signatures <path>    signature record        (default ${DEFAULTS.signatures})
    --public-key <path>    trust anchor, KEY posture      (default ${DEFAULTS.publicKey})
    --policy <path>        identity policy, KEYLESS posture (default ${DEFAULTS.policy})
    --require-attestation  fail if an image carries no verifiable SBOM attestation
    --negative-control     prove the verifier refuses: run the forged cases and
                           fail the gate unless every one of them is rejected
    --json                 print the verification report as JSON
    -h, --help             this text

  Verifies whichever POSTURE the signature record is actually in — a key held on a
  release machine, or a keyless GitHub Actions identity — and refuses a record that
  is in neither. "Unsigned" is never read as "the other posture".

  Needs cosign on PATH and the registry the record names. It needs NO private key:
  the whole point is that verification is something a deployer can do.

  Exit codes: 0 verified, 1 anything else including a refusal to run.
`;

export function parseArgs(argv) {
  const options = {
    manifest: DEFAULTS.manifest,
    signatures: DEFAULTS.signatures,
    publicKey: DEFAULTS.publicKey,
    policy: DEFAULTS.policy,
    requireAttestation: false,
    negativeControl: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--') continue;
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--manifest':
        options.manifest = next();
        break;
      case '--signatures':
        options.signatures = next();
        break;
      case '--public-key':
        options.publicKey = next();
        break;
      case '--policy':
        options.policy = next();
        break;
      case '--require-attestation':
        options.requireAttestation = true;
        break;
      case '--negative-control':
        options.negativeControl = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Verifying one image
// ---------------------------------------------------------------------------

/**
 * `cosign verify --key <pub>` against one registry digest reference.
 *
 * Returns the digests the SIGNED payloads named rather than a boolean, so the caller can compare
 * them to the digest it asked about. cosign already makes that comparison itself — control 3 above
 * is the measurement — and re-deriving it here is the difference between checking the claim and
 * trusting an exit code.
 */
export function verifySignature(reference, publicKeyPath) {
  const result = runCosign(['verify', '--key', publicKeyPath, ...COSIGN_VERIFY_FLAGS, reference]);
  if (result.status !== 0) {
    return {
      ok: false,
      problem:
        `cosign verify exited ${result.status} for ${reference}: ` +
        `${result.stderr.trim().split('\n').slice(0, 3).join(' ') || 'no output'}`,
    };
  }
  const { digests, problem } = verifiedDigests(result.stdout);
  if (problem !== null) return { ok: false, problem };
  return { ok: true, digests };
}

/**
 * `cosign verify` against a KEYLESS signature, asserting the identity the committed policy demands.
 *
 * The two flags this passes are the entire difference between provenance and arithmetic. Without
 * them cosign will not even run — "--certificate-identity or --certificate-identity-regexp is
 * required for verification in keyless mode" — and with a WIDER version of them it accepts a
 * signature made by a workflow in a repository nobody has heard of, because Fulcio issues a
 * certificate to anybody's GitHub Actions job. The values come from `deploy/signing/
 * keyless-policy.json` and never from the record being checked.
 *
 * Note what is NOT passed: `--insecure-ignore-tlog`. The keyed posture turns Rekor off and states
 * the cost as a residual; a keyless signature that skipped the log would keep that cost and lose
 * the point, so the log verification is mandatory here and a signature that is not in Rekor fails.
 *
 * @param {string} reference
 * @param {{identity: string, issuer: string}} demanded
 * @param {string[]} extraFlags used only by the negative control, which verifies against a
 *   throwaway certificate authority instead of the real Fulcio roots
 */
export function verifyKeylessSignature(reference, demanded, extraFlags = []) {
  const result = runCosign(['verify', ...keylessVerifyFlags(demanded), ...extraFlags, reference]);
  if (result.status !== 0) {
    return {
      ok: false,
      problem:
        `cosign verify exited ${result.status} for ${reference}: ` +
        `${result.stderr.trim().split('\n').slice(0, 3).join(' ') || 'no output'}`,
    };
  }
  const { digests, problem } = verifiedDigests(result.stdout);
  if (problem !== null) return { ok: false, problem };
  return { ok: true, digests };
}

/** `cosign verify-attestation --key <pub> --type cyclonedx` against one reference. */
export function verifyAttestation(reference, publicKeyPath) {
  const result = runCosign([
    'verify-attestation',
    '--key',
    publicKeyPath,
    '--type',
    ATTESTATION_TYPE,
    ...COSIGN_VERIFY_FLAGS,
    reference,
  ]);
  if (result.status !== 0) {
    return {
      ok: false,
      problem:
        `cosign verify-attestation exited ${result.status} for ${reference}: ` +
        `${result.stderr.trim().split('\n').slice(0, 3).join(' ') || 'no output'}`,
    };
  }
  const { statements, problem } = parseAttestationStatements(result.stdout);
  if (problem !== null) return { ok: false, problem };
  return { ok: true, statements };
}

/**
 * `cosign verify-attestation` against a KEYLESS attestation, with the same identity assertion.
 *
 * Separate from the keyed function above rather than a flag on it, so that the keyed path is
 * byte-identical to what it was: this change adds a posture, and a change that also rewrites the
 * working one is a change whose failures cannot be attributed.
 */
export function verifyKeylessAttestation(reference, demanded, extraFlags = []) {
  const result = runCosign([
    'verify-attestation',
    '--type',
    ATTESTATION_TYPE,
    ...keylessVerifyFlags(demanded),
    ...extraFlags,
    reference,
  ]);
  if (result.status !== 0) {
    return {
      ok: false,
      problem:
        `cosign verify-attestation exited ${result.status} for ${reference}: ` +
        `${result.stderr.trim().split('\n').slice(0, 3).join(' ') || 'no output'}`,
    };
  }
  const { statements, problem } = parseAttestationStatements(result.stdout);
  if (problem !== null) return { ok: false, problem };
  return { ok: true, statements };
}

// ---------------------------------------------------------------------------
// The negative control
// ---------------------------------------------------------------------------

/**
 * A minimal HTTP call to the registry. `node:http` and not `fetch` because the tamper control PUTs
 * raw manifest bytes back and the whole point is that they are unaltered.
 */
function registryCall({ host, port, method, path, headers = {}, body = null }) {
  return new Promise((resolveCall) => {
    const req = request({ method, host, port, path, headers, timeout: 10_000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolveCall({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on('timeout', () => req.destroy(new Error('registry timeout')));
    req.on('error', (err) => resolveCall({ status: 0, headers: {}, body: Buffer.alloc(0), error: err }));
    if (body === null) req.end();
    else req.end(body);
  });
}

const digestOf = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * Uploads a synthetic OCI image to the registry and returns its digest.
 *
 * Synthetic, over HTTP, rather than `docker build` of a `FROM scratch` image. Two reasons and the
 * second is the one that decided it: it needs no docker daemon, so the refusal demonstration runs
 * on a machine that can only verify; and the tamper control has to PUT a manifest by hand anyway,
 * so the HTTP path is code this file needs regardless.
 *
 * The blobs are never pulled by anything — cosign signs a manifest, and a manifest is what this
 * creates. `unique` guarantees two calls produce two different digests, which is what makes "image
 * B is not image A" true rather than assumed.
 */
async function pushSyntheticImage({ host, port, repository, unique }) {
  const putBlob = async (bytes) => {
    const start = await registryCall({
      host,
      port,
      method: 'POST',
      path: `/v2/${repository}/blobs/uploads/`,
    });
    if (start.status !== 202) return { problem: `blob upload start answered ${start.status}` };
    const location = String(start.headers.location ?? '');
    if (location === '') return { problem: 'the registry accepted an upload but returned no Location' };
    const separator = location.includes('?') ? '&' : '?';
    const put = await registryCall({
      host,
      port,
      method: 'PUT',
      path: `${location}${separator}digest=${digestOf(bytes)}`,
      headers: { 'content-type': 'application/octet-stream', 'content-length': bytes.length },
      body: bytes,
    });
    if (put.status !== 201) return { problem: `blob PUT answered ${put.status}` };
    return { digest: digestOf(bytes) };
  };

  const layer = Buffer.from(`poker-risk-lab provenance negative control ${unique}\n`);
  const layerBlob = await putBlob(layer);
  if ('problem' in layerBlob) return layerBlob;
  const config = Buffer.from(
    JSON.stringify({
      architecture: 'amd64',
      os: 'linux',
      config: {},
      rootfs: { type: 'layers', diff_ids: [layerBlob.digest] },
    }),
  );
  const configBlob = await putBlob(config);
  if ('problem' in configBlob) return configBlob;
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        digest: configBlob.digest,
        size: config.length,
      },
      layers: [
        {
          mediaType: 'application/vnd.oci.image.layer.v1.tar',
          digest: layerBlob.digest,
          size: layer.length,
        },
      ],
    }),
  );
  const digest = digestOf(manifest);
  const put = await registryCall({
    host,
    port,
    method: 'PUT',
    path: `/v2/${repository}/manifests/${digest}`,
    headers: {
      'content-type': 'application/vnd.oci.image.manifest.v1+json',
      'content-length': manifest.length,
    },
    body: manifest,
  });
  if (put.status !== 201) return { problem: `manifest PUT answered ${put.status}` };
  return { digest };
}

/**
 * The three refusals, demonstrated against a real registry rather than asserted in prose.
 *
 * Every case here failed to be a failure before this gate existed: an unsigned digest, a digest
 * signed by somebody else's key, and a digest carrying a transplanted signature all deployed
 * identically, because nothing looked. "A sweep of nothing is not a pass" applies to the guard as
 * much as to the thing it guards, so a control that PASSES is a gate failure — it would mean the
 * verifier accepted something it must refuse.
 *
 * The positive control at the end is not padding. Three refusals prove nothing on their own: a
 * cosign that refused everything, a registry that answered 500 to every request, or a typo in the
 * reference would produce exactly the same three failures. Signing image A with the ephemeral key
 * and verifying it with the ephemeral public key is what distinguishes "the verifier discriminates"
 * from "the verifier is broken".
 */
async function runNegativeControl(gate, releasePublicKeyPath, registryHost) {
  const parsed = parseRegistryHost(registryHost);
  if ('problem' in parsed) {
    gate.fail(`--negative-control cannot parse the registry host ${registryHost}`, parsed.problem);
    return;
  }
  const host = parsed.hostname;
  const port = parsed.port ?? 5000;
  const repository = 'prl-provenance-probe';
  const scratch = mkdtempSync(join(tmpdir(), 'prl-provenance-nc-'));

  try {
    // An EPHEMERAL keypair. The release private key is never read by this file, and this one is
    // discarded below — so the demonstration runs on a machine that holds only the public trust
    // anchor, which is the property the gate is supposed to have.
    const passphrase = randomBytes(18).toString('base64url');
    const generated = spawnSync('cosign', ['generate-key-pair'], {
      cwd: scratch,
      encoding: 'utf8',
      env: { ...process.env, COSIGN_PASSWORD: passphrase },
    });
    if (generated.status !== 0) {
      gate.fail('--negative-control could not generate an ephemeral keypair', generated.stderr ?? '');
      return;
    }
    const probeKey = join(scratch, 'cosign.key');
    const probePub = join(scratch, 'cosign.pub');
    const signEnv = { ...process.env, COSIGN_PASSWORD: passphrase };

    const good = await pushSyntheticImage({ host, port, repository, unique: randomBytes(8).toString('hex') });
    if ('problem' in good) {
      gate.fail('--negative-control could not stage a probe image', good.problem);
      return;
    }
    const bad = await pushSyntheticImage({ host, port, repository, unique: randomBytes(8).toString('hex') });
    if ('problem' in bad) {
      gate.fail('--negative-control could not stage a second probe image', bad.problem);
      return;
    }
    const goodReference = `${registryHost}/${repository}@${good.digest}`;
    const badReference = `${registryHost}/${repository}@${bad.digest}`;

    const signed = runCosign(['sign', '--key', probeKey, ...COSIGN_SIGN_FLAGS, goodReference], {
      env: signEnv,
    });
    if (signed.status !== 0) {
      gate.fail('--negative-control could not sign its probe image', signed.stderr.trim());
      return;
    }

    /** A control passes when the verifier REFUSES. Accepting is the gate failure. */
    const mustRefuse = (label, result, why) => {
      if (result.ok) {
        gate.fail(
          `NEGATIVE CONTROL DID NOT FIRE: ${label}`,
          `${why} The verifier accepted it. Until this refuses, the gate is decoration: it has ` +
            'never been shown rejecting anything, and a guard nobody has seen refuse is a guard ' +
            'nobody has tested.',
        );
        return;
      }
      gate.note(`negative control refused — ${label}: ${result.problem.split('\n')[0]}`);
    };

    mustRefuse(
      'an UNSIGNED digest',
      verifySignature(badReference, probePub),
      'A digest with no signature at all is the state every release image was in before this gate.',
    );
    mustRefuse(
      'a digest signed by a DIFFERENT key',
      verifySignature(goodReference, releasePublicKeyPath),
      "The probe image is validly signed — by the ephemeral key, not by this repository's key.",
    );

    // Control 3: transplant. The registry has no authentication, so the valid signature index for
    // image A can simply be PUT under image B's `sha256-<digest>` fallback tag. It answers 201.
    const fallbackTag = `sha256-${good.digest.replace('sha256:', '')}`;
    const signatureIndex = await registryCall({
      host,
      port,
      method: 'GET',
      path: `/v2/${repository}/manifests/${fallbackTag}`,
      headers: {
        accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json',
      },
    });
    if (signatureIndex.status !== 200) {
      gate.fail(
        '--negative-control could not read back the signature it just made',
        `GET /v2/${repository}/manifests/${fallbackTag} answered ${signatureIndex.status}`,
      );
      return;
    }
    const transplant = await registryCall({
      host,
      port,
      method: 'PUT',
      path: `/v2/${repository}/manifests/sha256-${bad.digest.replace('sha256:', '')}`,
      headers: {
        'content-type': String(
          signatureIndex.headers['content-type'] ?? 'application/vnd.oci.image.index.v1+json',
        ),
        'content-length': signatureIndex.body.length,
      },
      body: signatureIndex.body,
    });
    if (transplant.status !== 201) {
      gate.fail(
        '--negative-control could not stage the signature transplant',
        `PUT answered ${transplant.status}. The control is not being demonstrated, so its result ` +
          'cannot be reported either way.',
      );
      return;
    }
    mustRefuse(
      'a TAMPERED digest carrying a transplanted signature',
      verifySignature(badReference, probePub),
      'A valid signature for image A was copied onto image B in the registry, which accepted it ' +
        'with a 201 because it has no authentication.',
    );

    // The positive control. Without it, three refusals are equally consistent with a verifier that
    // refuses everything.
    const positive = verifySignature(goodReference, probePub);
    if (!positive.ok) {
      gate.fail(
        'the negative-control POSITIVE case did not verify',
        `${positive.problem}\n      A run in which everything is refused proves nothing about ` +
          'discrimination: it is what a broken cosign, an unreachable registry or a typo in the ' +
          'reference would also produce.',
      );
    } else {
      gate.note(
        `negative control positive case verified — the same verifier ACCEPTS ${good.digest.slice(0, 19)}… ` +
          'signed by the ephemeral key, so the three refusals above are discrimination and not breakage',
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The keyless negative control
// ---------------------------------------------------------------------------

/**
 * The keyless refusals, demonstrated offline against a THROWAWAY certificate authority.
 *
 * ## Why this is possible without a network, and exactly what it does and does not show
 *
 * A real keyless signature needs Fulcio and Rekor, and neither exists on a workstation. But the
 * property that makes a keyless signature *provenance* rather than arithmetic is not the network
 * round trip — it is that the verifier demands a specific certificate identity and a specific OIDC
 * issuer, and refuses a certificate carrying anything else. That is a decision cosign makes locally
 * about bytes in a certificate, so it can be demonstrated locally with a certificate this function
 * mints itself:
 *
 *   * a throwaway CA plays Fulcio (`--trusted-root` substitutes it for the real Sigstore roots);
 *   * a leaf certificate carries a SAN URI naming a workflow, and Fulcio's OIDC-issuer extension
 *     (1.3.6.1.4.1.57264.1.8) naming GitHub's issuer — the same two fields a real Fulcio
 *     certificate carries, in the same places;
 *   * `cosign sign --certificate/--certificate-chain` attaches it to a real signature over a real
 *     image in the registry.
 *
 * **What this therefore proves:** cosign refuses a signature whose certificate identity is not the
 * one demanded, refuses a wrong issuer, and refuses to verify at all when no identity is asserted.
 * Those are the three ways a keyless verification silently becomes worthless.
 *
 * **What it does NOT prove, and must not be quoted as proving:** that the OIDC exchange works, that
 * Fulcio would issue this repository a certificate, or that a Rekor entry exists. Nothing offline
 * can show any of that. The real thing is unexercised until `.github/workflows/release-sign.yml`
 * runs, and the trusted-root substitution below is exactly the part that would be Fulcio's job.
 */
async function runKeylessNegativeControl(gate, options, registryHost) {
  const parsedHost = parseRegistryHost(registryHost);
  if ('problem' in parsedHost) {
    gate.fail('the keyless negative control cannot parse the registry host', parsedHost.problem);
    return;
  }
  const policyRead = readJsonFile(options.policy);
  if ('problem' in policyRead) {
    gate.fail('the keyless negative control has no identity policy to demand', policyRead.problem);
    return;
  }
  const { policy, problems } = parseKeylessPolicy(policyRead.value);
  if (policy === null) {
    for (const problem of problems) gate.fail('the keyless identity policy is not usable', problem);
    return;
  }
  if (spawnSync('openssl', ['version'], { encoding: 'utf8' }).status !== 0) {
    gate.fail(
      'the keyless negative control needs openssl and it is not on PATH',
      'This REFUSES rather than skipping. The refusals below are the only evidence in this ' +
        'repository that identity matching works at all; a run that quietly omitted them would ' +
        'report a pass over a control nobody ran.',
    );
    return;
  }

  const host = parsedHost.hostname;
  const port = parsedHost.port ?? 5000;
  const repository = 'prl-keyless-probe';
  const scratch = mkdtempSync(join(tmpdir(), 'prl-keyless-nc-'));
  // The owner in the probe identity. Never a real one: this certificate must not be mistakable for
  // anything, and the policy's own owner is null until this repository is published.
  const probeRepository = `prl-negative-control/${policy.repositoryName}`;
  const probeIdentity = expectedCertificateIdentity(policy, probeRepository);

  try {
    const openssl = (args, input) => {
      const result = spawnSync('openssl', args, { cwd: scratch, encoding: 'utf8', input });
      return result.status === 0 ? { ok: true } : { problem: (result.stderr ?? '').trim() };
    };
    const write = (name, text) => writeFileSync(join(scratch, name), text);

    // The extensions are what make this a Fulcio-SHAPED certificate rather than any old leaf: a URI
    // SAN carrying the workflow identity, and the OIDC-issuer extension. Both values come from the
    // committed policy, whose fields are already constrained to safe character sets by
    // `parseKeylessPolicy` — an identity assembled from arbitrary text would be config injection
    // into openssl's own parser.
    write(
      'ext.cnf',
      '[ca_ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' +
        'subjectKeyIdentifier=hash\n\n' +
        '[leaf_ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n' +
        'extendedKeyUsage=codeSigning\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n' +
        'subjectAltName=critical,@san\n' +
        `1.3.6.1.4.1.57264.1.8=ASN1:UTF8String:${policy.issuer}\n\n` +
        `[san]\nURI.1=${probeIdentity}\n`,
    );
    const steps = [
      ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key'],
      // prettier-ignore
      [
        'req',
        '-x509',
        '-new',
        '-key',
        'ca.key',
        '-sha256',
        '-days',
        '1',
        '-subj',
        '/O=prl-negative-control/CN=not-fulcio',
        '-extensions',
        'ca_ext',
        '-config',
        'ext.cnf',
        '-out',
        'ca.pem',
      ],
      ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key'],
      ['req', '-new', '-key', 'leaf.key', '-subj', '/O=prl-negative-control', '-out', 'leaf.csr'],
      // prettier-ignore
      [
        'x509',
        '-req',
        '-in',
        'leaf.csr',
        '-CA',
        'ca.pem',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-days',
        '1',
        '-sha256',
        '-extfile',
        'ext.cnf',
        '-extensions',
        'leaf_ext',
        '-out',
        'leaf.pem',
      ],
      // cosign will not load a bare PEM key; import-key-pair converts it to cosign's own format.
      ['pkcs8', '-topk8', '-nocrypt', '-in', 'leaf.key', '-out', 'leaf.pk8.pem'],
    ];
    for (const args of steps) {
      const result = openssl(args);
      if ('problem' in result) {
        gate.fail(
          `the keyless negative control could not mint its certificate (openssl ${args[0]})`,
          result.problem,
        );
        return;
      }
    }

    const passphrase = randomBytes(18).toString('base64url');
    const env = { ...process.env, COSIGN_PASSWORD: passphrase };
    const imported = spawnSync(
      'cosign',
      ['import-key-pair', '--key', 'leaf.pk8.pem', '--output-key-prefix', 'imported'],
      { cwd: scratch, encoding: 'utf8', env },
    );
    if (imported.status !== 0) {
      gate.fail('the keyless negative control could not import its signing key', imported.stderr ?? '');
      return;
    }

    // `--trusted-root` is what stands in for Fulcio: a Sigstore trusted-root document naming the
    // throwaway CA. Without it cosign has no root that would accept this certificate and every case
    // below would fail identically — which would look like three refusals and prove nothing.
    const caPem = readFileSync(join(scratch, 'ca.pem'), 'utf8');
    const caDer = Buffer.from(caPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
    write(
      'trusted-root.json',
      JSON.stringify({
        mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
        certificateAuthorities: [
          {
            subject: { organization: 'prl-negative-control', commonName: 'not-fulcio' },
            uri: 'https://not-fulcio.invalid',
            certChain: { certificates: [{ rawBytes: caDer.toString('base64') }] },
            validFor: { start: '2020-01-01T00:00:00Z' },
          },
        ],
        tlogs: [],
        ctlogs: [],
        timestampAuthorities: [],
      }),
    );

    const image = await pushSyntheticImage({
      host,
      port,
      repository,
      unique: randomBytes(8).toString('hex'),
    });
    if ('problem' in image) {
      gate.fail('the keyless negative control could not stage a probe image', image.problem);
      return;
    }
    const reference = `${registryHost}/${repository}@${image.digest}`;
    const signed = runCosign(
      [
        'sign',
        '--key',
        join(scratch, 'imported.key'),
        '--certificate',
        join(scratch, 'leaf.pem'),
        '--certificate-chain',
        join(scratch, 'ca.pem'),
        ...COSIGN_SIGN_FLAGS,
        reference,
      ],
      { env },
    );
    if (signed.status !== 0) {
      gate.fail('the keyless negative control could not sign its probe image', signed.stderr.trim());
      return;
    }

    // The substitutions that replace Fulcio and Rekor for this demonstration, and nothing else. The
    // REAL verification path (`verifyKeylessSignature` with no extra flags) passes none of these:
    // it uses the shipped Sigstore roots and requires a transparency-log entry.
    const asIfFulcio = [
      '--trusted-root',
      join(scratch, 'trusted-root.json'),
      // The bundle carries a chain (leaf + throwaway CA); cosign 3 requires this to read one.
      '--allow-certificate-chain',
      // No Rekor and no CT log exists for a certificate this function minted a second ago.
      '--insecure-ignore-tlog',
      '--insecure-ignore-sct',
    ];

    const mustRefuse = (label, result, why) => {
      if (result.ok) {
        gate.fail(
          `KEYLESS NEGATIVE CONTROL DID NOT FIRE: ${label}`,
          `${why} The verifier accepted it. A keyless verification that accepts a certificate the ` +
            'policy does not name is worth almost nothing: Fulcio issues a certificate to ' +
            "anybody's GitHub Actions job, so without the identity check this is a signature by " +
            '"somebody, somewhere, on GitHub".',
        );
        return;
      }
      gate.note(`keyless control refused — ${label}: ${result.problem.split('\n')[0]}`);
    };

    mustRefuse(
      'a certificate identity from ANOTHER OWNER',
      verifyKeylessSignature(
        reference,
        {
          identity: expectedCertificateIdentity(policy, `attacker-org/${policy.repositoryName}`),
          issuer: policy.issuer,
        },
        asIfFulcio,
      ),
      `The certificate is valid and names ${probeIdentity}; the policy asked for the same workflow ` +
        'in a repository somebody else owns.',
    );
    mustRefuse(
      'a certificate identity naming ANOTHER WORKFLOW FILE',
      verifyKeylessSignature(
        reference,
        {
          identity: probeIdentity.replace(/\/[^/]+\.ya?ml@/, '/release-sign-innocuous.yml@'),
          issuer: policy.issuer,
        },
        asIfFulcio,
      ),
      'The file name is part of the identity, which is why renaming the signing workflow is a ' +
        'release-blocking change and not a tidy-up.',
    );
    mustRefuse(
      'a certificate from ANOTHER ISSUER',
      verifyKeylessSignature(
        reference,
        { identity: probeIdentity, issuer: 'https://gitlab.example.com' },
        asIfFulcio,
      ),
      'An identity string is not self-authenticating — another provider can assert any subject it ' +
        "likes — so the issuer is what makes it GitHub's statement.",
    );
    mustRefuse(
      'a verification that asserts NO identity at all',
      (() => {
        // Not `verifyKeylessSignature`: this deliberately omits the flags that function always
        // passes, to show what cosign does when a verifier does not assert an identity. It is the
        // one refusal here that is cosign's own rule rather than a comparison it performed.
        const result = runCosign([
          'verify',
          '--allow-http-registry',
          '--allow-insecure-registry',
          ...asIfFulcio,
          reference,
        ]);
        return result.status === 0
          ? { ok: true, digests: [] }
          : { ok: false, problem: result.stderr.trim().split('\n').slice(0, 2).join(' ') };
      })(),
      'This is the shape of a verifier that checks the maths and calls it provenance.',
    );

    // Corroboration: read the certificate back out of the registry and parse it here, so the three
    // refusals above are demonstrably ABOUT the identity rather than about a broken chain. Same
    // reasoning as `verifiedDigests` — checking the claim, not the exit code.
    const readBack = await readCertificateFromRegistry({ host, port, repository, digest: image.digest });
    if ('problem' in readBack) {
      gate.fail('the keyless negative control could not read its own certificate back', readBack.problem);
    } else {
      const parsed = certificateIdentity(readBack.der);
      if ('problem' in parsed) {
        gate.fail('the certificate in the registry could not be parsed', parsed.problem);
      } else if (parsed.identity !== probeIdentity || parsed.issuer !== policy.issuer) {
        gate.fail(
          'the certificate in the registry is not the certificate this control minted',
          `read ${parsed.identity} / ${parsed.issuer}`,
        );
      } else {
        const wouldRefuse = identityProblems(parsed, policy, `attacker-org/${policy.repositoryName}`);
        gate.note(
          `keyless control read the certificate back from the registry — SAN ${parsed.identity}, ` +
            `issuer ${parsed.issuer}; judged against a policy naming another owner it produces ` +
            `${wouldRefuse.length} problem(s), so the refusals above are about the identity`,
        );
        if (wouldRefuse.length === 0) {
          gate.fail(
            'the identity policy accepted a certificate belonging to another repository',
            'This is the same comparison cosign makes, made again here on the parsed certificate. ' +
              'If it passes, the policy is not bounding anything.',
          );
        }
      }
    }

    // The positive control. Three refusals are equally consistent with a verifier that refuses
    // everything — a broken trusted root would produce exactly this.
    const positive = verifyKeylessSignature(
      reference,
      { identity: probeIdentity, issuer: policy.issuer },
      asIfFulcio,
    );
    if (!positive.ok) {
      gate.fail(
        'the keyless POSITIVE case did not verify',
        `${positive.problem}\n      Without it the refusals above prove nothing about ` +
          'discrimination: an unusable trusted root, a mis-minted certificate or an unreachable ' +
          'registry would refuse everything just as thoroughly.',
      );
    } else {
      gate.note(
        `keyless control positive case verified — the same verifier ACCEPTS ${image.digest.slice(0, 19)}… ` +
          `when the policy names ${probeIdentity}`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The signing certificate a cosign v0.3 bundle in the registry carries.
 *
 * Three hops — the fallback `sha256-<digest>` tag is an index, the index names a manifest, the
 * manifest's single layer IS the bundle — over plain HTTP, which is why this is used by the
 * negative control against the loopback registry and NOT by the gate against GHCR. `fetchManifest`
 * in `registry-digest.mjs` says the same thing about credentials: this module implements no token
 * flow, so it reports what it could not do rather than pretending.
 */
async function readCertificateFromRegistry({ host, port, repository, digest }) {
  const accept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.oci.image.manifest.v1+json',
  ].join(', ');
  const get = async (path) => {
    const answer = await registryCall({ host, port, method: 'GET', path, headers: { accept } });
    if (answer.status !== 200) return { problem: `GET ${path} answered ${answer.status}` };
    try {
      return { value: JSON.parse(answer.body.toString('utf8')) };
    } catch (err) {
      return { problem: `GET ${path} did not return JSON: ${err.message}` };
    }
  };
  const tag = `sha256-${String(digest).replace('sha256:', '')}`;
  const index = await get(`/v2/${repository}/manifests/${tag}`);
  if ('problem' in index) return index;
  const manifestDigest = index.value?.manifests?.[0]?.digest;
  if (typeof manifestDigest !== 'string') return { problem: 'the signature index names no manifest' };
  const manifest = await get(`/v2/${repository}/manifests/${manifestDigest}`);
  if ('problem' in manifest) return manifest;
  const layer = manifest.value?.layers?.[0]?.digest;
  if (typeof layer !== 'string') return { problem: 'the signature manifest carries no bundle layer' };
  const bundle = await get(`/v2/${repository}/blobs/${layer}`);
  if ('problem' in bundle) return bundle;
  return bundleCertificate(bundle.value);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function runImageProvenanceGate(options) {
  const gate = new Gate('release-image-signatures');
  const report = {
    verifiedAt: new Date().toISOString(),
    cosignVersion: null,
    posture: null,
    publicKey: null,
    keyless: null,
    transparencyLog: false,
    images: [],
  };

  return runGate(gate, async () => {
    const version = cosignVersion();
    if (version === null) {
      gate.fail(
        'cosign is not installed, so no signature was verified',
        'This REFUSES rather than skipping. An unsigned release image and an unverified one look ' +
          'identical from the outside, and the whole reason this gate exists is that they were ' +
          'treated identically. Install it — `brew install cosign`, or ' +
          'https://docs.sigstore.dev/cosign/system_config/installation/ — and run this again.',
      );
      return;
    }
    report.cosignVersion = version;
    gate.note(`cosign ${version}`);

    const manifestRead = readJsonFile(options.manifest);
    if ('problem' in manifestRead) {
      gate.fail('the release manifest could not be read', `${manifestRead.problem}`);
      return;
    }
    const signaturesRead = readJsonFile(options.signatures);
    if ('problem' in signaturesRead) {
      gate.fail(
        'there is no signature record for the release images',
        `${signaturesRead.problem}. That IS the unsigned state — the file being absent is what an ` +
          'unsigned release looks like, not an exemption from being checked. Run ' +
          '`pnpm run release:sign`.',
      );
      return;
    }

    const { images, meta, problems } = parseSignatureRecord(signaturesRead.value);
    for (const problem of problems) gate.fail('the signature record cannot be trusted', problem);
    if (problems.length > 0) return;
    report.posture = meta.posture;

    // ## The two postures, and why the gate follows the record rather than a flag
    //
    // A release built on a workstation is signed with the key committed at `deploy/signing/
    // cosign.pub`. A release built in CI is signed keylessly, by a workflow identity, with no key
    // anywhere. Both are legitimate, they are verified with completely different arguments, and the
    // one thing that must never happen is a record in NEITHER posture being read as one of them —
    // `parseSignatureRecord` refuses that above, in as many words, because an unsigned release is
    // exactly what "neither" looks like.
    //
    // `verifier` is chosen here and used below, so the per-image loop is identical in both
    // postures. The alternative — two loops — is how one of them quietly stops checking the
    // attestation, or the registry tie, or the digest inside the payload.
    let publicKey = null;
    let verifier = null;
    if (meta.posture === 'key') {
      publicKey = readPublicKey(options.publicKey);
      if ('problem' in publicKey) {
        gate.fail('there is no trust anchor to verify against', publicKey.problem);
        return;
      }
      report.publicKey = { path: options.publicKey, fingerprint: publicKey.fingerprint };
      gate.note(`trust anchor ${options.publicKey} — SPKI sha256 ${publicKey.fingerprint.slice(0, 16)}…`);
      if (meta.publicKeyFingerprint !== publicKey.fingerprint) {
        gate.fail(
          'the committed public key is NOT the key these signatures were made with',
          `record ${meta.publicKeyFingerprint}\n      committed ${publicKey.fingerprint}\n      ` +
            'Rotating a key without re-signing leaves every artefact unverifiable. Re-sign the ' +
            'release: `pnpm run release:sign`. See deploy/signing/README.md § Rotation.',
        );
        return;
      }
      verifier = {
        posture: 'key',
        verify: (reference) => verifySignature(reference, publicKey.full),
        attest: (reference) => verifyAttestation(reference, publicKey.full),
        describes: `the key committed at ${options.publicKey}`,
      };
    } else {
      const policyRead = readJsonFile(options.policy);
      if ('problem' in policyRead) {
        gate.fail(
          'this record is a KEYLESS signature and there is no identity policy to check it against',
          `${policyRead.problem}. Without the policy the only available verification is "some ` +
            'Fulcio certificate signed this", which accepts a signature made by anybody\'s GitHub ' +
            'Actions job. Refusing rather than verifying the maths and calling it provenance.',
        );
        return;
      }
      const { policy, problems: policyProblems } = parseKeylessPolicy(policyRead.value);
      for (const problem of policyProblems) gate.fail('the keyless identity policy is not usable', problem);
      if (policy === null) return;

      const resolved = resolveRepository(policy, process.env);
      if ('problem' in resolved) {
        gate.fail('the keyless identity cannot be resolved to a repository', resolved.problem);
        return;
      }
      const demanded = {
        identity: expectedCertificateIdentity(policy, resolved.repository),
        issuer: policy.issuer,
      };
      if (policy.repository === null) {
        gate.warn(
          `the identity's owner came from the environment, not from ${options.policy}`,
          `${resolved.source}. This run therefore checked something an outsider could NOT check: ` +
            'they have no environment to resolve. Commit the owner in the policy — ' +
            '`scripts/supply-chain/keyless-provenance.mjs` fails outright on a COMMITTED keyless ' +
            'record while it is null.',
        );
      }
      // The record states an identity too. It is not what the verification asserts — the policy is
      // — but the two must agree, because a record naming a different workflow is a record
      // describing a signature this gate is not verifying.
      const recordProblems = identityProblems(meta.keyless ?? {}, policy, resolved.repository);
      for (const problem of recordProblems) {
        gate.fail('the signature record claims an identity the policy does not accept', problem);
      }
      if (recordProblems.length > 0) return;

      report.keyless = { ...demanded, policy: options.policy, resolvedFrom: resolved.source };
      report.transparencyLog = true;
      gate.note(`identity demanded: ${demanded.identity}`);
      gate.note(`issuer demanded:   ${demanded.issuer}`);
      verifier = {
        posture: 'keyless',
        verify: (reference) => verifyKeylessSignature(reference, demanded),
        attest: (reference) => verifyKeylessAttestation(reference, demanded),
        describes: `the workflow identity ${demanded.identity}`,
      };
    }

    // The tie to the build. This is the check cosign cannot make, and the one an attacker with a
    // valid signature over SOME image would walk straight past.
    const reconciled = reconcileWithManifest(images, manifestRead.value);
    for (const problem of reconciled.problems) gate.fail('signatures do not match the release', problem);
    if (reconciled.problems.length > 0) return;
    gate.note(
      `${reconciled.matched.length} of ${Object.keys(manifestRead.value?.images ?? {}).length} release ` +
        'image(s) have a signature record over the exact digest the build recorded: ' +
        `${reconciled.matched.join(', ')}`,
    );

    let verified = 0;
    for (const image of images) {
      // The registry must actually serve those bytes under that digest, checked by re-hashing here
      // rather than by asking docker. A signature over a digest the registry no longer holds is a
      // signature nobody can use.
      const parsedHost = parseRegistryHost(meta.registry ?? '');
      if ('problem' in parsedHost) {
        gate.fail(`${image.service}: the signature record's registry host is unusable`, parsedHost.problem);
        continue;
      }
      const present = await verifyRegistryDigest({
        host: parsedHost.host,
        repository: image.repository ?? '',
        digest: image.registryDigest,
        localDigest: image.buildDigest,
      });
      if (!present.ok && present.unauthenticated === true) {
        // A registry that wants credentials — GHCR, which is where the keyless posture publishes.
        // This module deliberately implements no token flow (see `fetchManifest`), so the
        // independent re-hash is NOT PERFORMED rather than performed and passed. Said out loud
        // rather than swallowed: the cosign verification below still fails if the registry does not
        // hold this digest, because cosign resolves the same reference through the docker keychain.
        gate.warn(
          `${image.service}: the registry answered ${present.status}, so the manifest was not re-hashed here`,
          `${present.problem}\n      What still holds: cosign resolves this digest through the ` +
            'authenticated keychain below, so an absent digest fails there. What does NOT hold: ' +
            'this gate did not independently re-fetch and re-hash the manifest, which it does do ' +
            'against the unauthenticated lab registry.',
        );
      } else if (!present.ok) {
        gate.fail(`${image.service}: the signed digest is not resolvable`, present.problem);
        continue;
      }

      const signature = verifier.verify(image.reference);
      if (!signature.ok) {
        gate.fail(
          verifier.posture === 'key'
            ? `${image.service} ${image.buildDigest} is NOT signed by the committed key`
            : `${image.service} ${image.buildDigest} is NOT signed by ${verifier.describes}`,
          signature.problem,
        );
        continue;
      }
      if (!signature.digests.includes(image.buildDigest)) {
        gate.fail(
          `${image.service}: the signature payload names a different artefact`,
          `signed: ${signature.digests.join(', ')}\n      expected: ${image.buildDigest}`,
        );
        continue;
      }

      let attestation = null;
      const attested = verifier.attest(image.reference);
      if (!attested.ok) {
        const message = `${image.service}: no verifiable SBOM attestation — ${attested.problem}`;
        if (options.requireAttestation || image.attested) {
          gate.fail(`${image.service}: the recorded SBOM attestation does not verify`, attested.problem);
          continue;
        }
        gate.warn(message, 'the signature above still verifies; the SBOM is an additional claim');
      } else {
        const judged = attested.statements.map((statement) =>
          attestationProblems(statement, image.buildDigest),
        );
        const attestationFailures = judged.flatMap((entry) => entry.problems);
        if (attestationFailures.length > 0) {
          for (const problem of attestationFailures) {
            gate.fail(`${image.service}: the SBOM attestation cannot be trusted`, problem);
          }
          continue;
        }
        const components = Math.max(...judged.map((entry) => entry.components));
        attestation = { statements: judged.length, components };
        gate.note(
          `${image.service}: SBOM attestation verifies against ${verifier.describes} — ` +
            `${components} components, subject is ${image.buildDigest.slice(0, 19)}…`,
        );
      }

      verified += 1;
      report.images.push({
        service: image.service,
        buildDigest: image.buildDigest,
        reference: image.reference,
        posture: verifier.posture,
        signedBy: publicKey === null ? report.keyless?.identity : publicKey.fingerprint,
        registryTie: present.tie ?? null,
        attestation,
      });
      gate.note(`${image.service}: signature verifies over ${image.buildDigest}`);
    }

    if (verified === 0) {
      gate.fail(
        'no release image was verified',
        'The gate got as far as having something to check and checked nothing. A run that verifies ' +
          'zero images must never report a pass.',
      );
    }

    gate.note(
      `posture: ${meta.posture.toUpperCase()} — every image above was verified against ` +
        `${verifier.describes}`,
    );

    if (options.negativeControl) {
      console.log(bold('\n  negative control — the verifier must refuse every one of these'));
      // The key controls need a key to forge WITH, and generate an ephemeral one; the keyless
      // controls need a certificate authority to forge with, and mint a throwaway one. Neither
      // touches the release key, and both run against the loopback registry with no network.
      const anchor = publicKey ?? readPublicKey(options.publicKey);
      if ('problem' in anchor) {
        gate.fail('the negative control could not read the public key it forges against', anchor.problem);
      } else {
        await runNegativeControl(gate, anchor.full, meta.registry ?? '');
      }
      await runKeylessNegativeControl(gate, options, meta.registry ?? '');
    }
  }).then((code) => {
    if (options.json) console.log(JSON.stringify(report, null, 2));
    console.log(
      dim(
        report.posture === 'keyless'
          ? '\n  What this proves: each release digest was signed by a GitHub Actions workflow whose\n' +
              `  certificate identity is ${report.keyless?.identity ?? '(unresolved)'},\n` +
              `  as asserted by ${options.policy}, with the certificate issued by\n` +
              `  ${report.keyless?.issuer ?? '(unresolved)'} and the signature recorded in Rekor.\n` +
              '  What it does NOT prove: that the workflow built what it signed. The identity says\n' +
              '  WHO signed; a SLSA provenance predicate emitted by the builder is what would say\n' +
              '  what went in. See deploy/signing/README.md.\n'
          : '\n  What this proves: each release digest is signed by the key committed at\n' +
              `  ${options.publicKey}, and each carries a signed SBOM of its own contents.\n` +
              '  What it does NOT prove: who built the image. These signatures are made with a\n' +
              '  long-lived key on the release machine and there is no transparency log behind them,\n' +
              '  so they establish possession of a key and not the identity of a builder. That is\n' +
              '  the KEY posture, and it is what a release built on a workstation gets. A release\n' +
              '  built by .github/workflows/release-sign.yml is signed keylessly and carries an\n' +
              '  identity instead; see deploy/signing/README.md.\n',
      ),
    );
    return code;
  });
}

if (import.meta.main) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(red(`security:image-provenance — ${err.message}`));
    process.exit(1);
  }
  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }
  const code = await runImageProvenanceGate(options);
  console.log(code === 0 ? green(bold('PASS')) : red(bold('FAIL')));
  console.log(dim(`  scripts/supply-chain/image-provenance.mjs exit ${code}\n`));
}
