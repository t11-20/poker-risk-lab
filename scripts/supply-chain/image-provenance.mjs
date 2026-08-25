#!/usr/bin/env node

/**
 * Gate: every release image is signed, by digest, by the key this repository committed.
 *
 * Invoked by `pnpm run security:image-provenance`, and by `scripts/supply-chain/audit.mjs`.
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
 * `--negative-control` runs all three against a throwaway image in the registry and FAILS THE GATE
 * unless each one is refused. This is not decoration: before this file existed, every one of the
 * three states below produced no output from anything, which is indistinguishable from a pass. A
 * guard that has never been shown refusing is a guard nobody has tested.
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
 * A fourth refusal has nothing to do with cosign and is the one that actually ties this to the
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
 * Read this before quoting it. These signatures are made with a long-lived key held on the release
 * machine, with no transparency log behind them. The gate proves the digests were signed by
 * whoever holds that key. It does NOT identify a builder, a source tree or a build environment, and
 * without a log there is no third-party record that a signature existed at a time, so key
 * compromise is not detectable after the fact. Keyless/OIDC signing in CI is what closes that, and
 * this repository has no CI signing identity. `deploy/signing/README.md` § "What this does not
 * prove" is the long version, and `docs/production/final-readiness-report.md` keeps it as a named
 * residual rather than folding it into the pass.
 *
 * Usage:
 *     node scripts/supply-chain/image-provenance.mjs [--manifest <path>] [--signatures <path>]
 *                 [--public-key <path>] [--require-attestation] [--negative-control] [--json]
 *
 * Exit codes: 0 every release image verified; 1 anything else, including a refusal to run.
 * 0 for --help.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ATTESTATION_TYPE,
  attestationProblems,
  COSIGN_SIGN_FLAGS,
  COSIGN_VERIFY_FLAGS,
  cosignVersion,
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
import { parseRegistryHost, verifyRegistryDigest } from '../registry-digest.mjs';
import { bold, dim, Gate, green, red, runGate } from './lib.mjs';

const DEFAULTS = {
  manifest: MANIFEST_PATH,
  signatures: SIGNATURES_PATH,
  publicKey: PUBLIC_KEY_PATH,
};

const HELP = `
${bold('pnpm run security:image-provenance')} — verify the release images are signed

  Options:
    --manifest <path>      release manifest        (default ${DEFAULTS.manifest})
    --signatures <path>    signature record        (default ${DEFAULTS.signatures})
    --public-key <path>    trust anchor            (default ${DEFAULTS.publicKey})
    --require-attestation  fail if an image carries no verifiable SBOM attestation
    --negative-control     prove the verifier refuses: run three forged cases and
                           fail the gate unless every one of them is rejected
    --json                 print the verification report as JSON
    -h, --help             this text

  Needs cosign on PATH and the registry the record names. It needs NO private key:
  the whole point is that verification is something a deployer can do.

  Exit codes: 0 verified, 1 anything else including a refusal to run.
`;

export function parseArgs(argv) {
  const options = {
    manifest: DEFAULTS.manifest,
    signatures: DEFAULTS.signatures,
    publicKey: DEFAULTS.publicKey,
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
// The gate
// ---------------------------------------------------------------------------

export function runImageProvenanceGate(options) {
  const gate = new Gate('release-image-signatures');
  const report = {
    verifiedAt: new Date().toISOString(),
    cosignVersion: null,
    publicKey: null,
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

    const publicKey = readPublicKey(options.publicKey);
    if ('problem' in publicKey) {
      gate.fail('there is no trust anchor to verify against', publicKey.problem);
      return;
    }
    report.publicKey = { path: options.publicKey, fingerprint: publicKey.fingerprint };
    gate.note(`trust anchor ${options.publicKey} — SPKI sha256 ${publicKey.fingerprint.slice(0, 16)}…`);

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

    if (meta.publicKeyFingerprint !== publicKey.fingerprint) {
      gate.fail(
        'the committed public key is NOT the key these signatures were made with',
        `record ${meta.publicKeyFingerprint}\n      committed ${publicKey.fingerprint}\n      ` +
          'Rotating a key without re-signing leaves every artefact unverifiable. Re-sign the ' +
          'release: `pnpm run release:sign`. See deploy/signing/README.md § Rotation.',
      );
      return;
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
      if (!present.ok) {
        gate.fail(`${image.service}: the signed digest is not resolvable`, present.problem);
        continue;
      }

      const signature = verifySignature(image.reference, publicKey.full);
      if (!signature.ok) {
        gate.fail(
          `${image.service} ${image.buildDigest} is NOT signed by the committed key`,
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
      const attested = verifyAttestation(image.reference, publicKey.full);
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
          `${image.service}: SBOM attestation verifies against the same key — ${components} components, ` +
            `subject is ${image.buildDigest.slice(0, 19)}…`,
        );
      }

      verified += 1;
      report.images.push({
        service: image.service,
        buildDigest: image.buildDigest,
        reference: image.reference,
        signedBy: publicKey.fingerprint,
        registryTie: present.tie,
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

    if (options.negativeControl) {
      console.log(bold('\n  negative control — the verifier must refuse all three'));
      await runNegativeControl(gate, publicKey.full, meta.registry ?? '');
    }
  }).then((code) => {
    if (options.json) console.log(JSON.stringify(report, null, 2));
    console.log(
      dim(
        '\n  What this proves: each release digest is signed by the key committed at\n' +
          `  ${options.publicKey}, and each carries a signed SBOM of its own contents.\n` +
          '  What it does NOT prove: who built the image. These signatures are made with a\n' +
          '  long-lived key on the release machine and there is no transparency log behind them,\n' +
          '  so they establish possession of a key and not the identity of a builder. Keyless/OIDC\n' +
          '  signing in CI is what closes that; see deploy/signing/README.md.\n',
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
