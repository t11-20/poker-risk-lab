#!/usr/bin/env node

/**
 * Gate: every release image is signed, by digest, in whichever posture its signature record is in.
 * KEY posture verifies against `deploy/signing/cosign.pub`. KEYLESS posture verifies a Fulcio
 * certificate against the identity and issuer in `deploy/signing/keyless-policy.json`, never against
 * values from the record itself. `parseSignatureRecord` refuses a record in neither posture, because
 * that is what an unsigned release looks like, and a record in both.
 *
 * The keyless posture is implemented and unexercised. No signing workflow run has happened, so every
 * release image today is in the KEY posture.
 *
 * This file reads only the public key. `scripts/release-sign.mjs` holds the signer, so a machine that
 * can check a signature cannot mint one. `--negative-control` generates an ephemeral keypair and must
 * see each forged case refused: an unsigned digest (cosign exits 10), a different key, a signature
 * transplanted onto another digest, and for keyless a wrong owner, wrong workflow file, wrong issuer
 * and no asserted identity. `reconcileWithManifest` ties each signed digest to the release manifest.
 *
 * KEY posture proves possession of a key, with no transparency log. KEYLESS posture proves which
 * workflow signed, recorded in Rekor. Neither proves what went into the image. See
 * `deploy/signing/README.md`.
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

/**
 * Returns the digests the signed payloads name, so the caller compares them to the digest it asked
 * about instead of trusting the exit code.
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
 * Keyless verify. The identity and issuer come from the committed policy. Without them cosign
 * refuses to run, and with wider ones it accepts any GitHub Actions job Fulcio certified.
 * `--insecure-ignore-tlog` is never passed, so a signature missing from Rekor fails.
 * `extraFlags` is only for the negative control's throwaway CA.
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

// Separate from `verifyAttestation` so the keyed path stays byte-identical.
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

// `node:http` and not `fetch`: the tamper control PUTs raw manifest bytes back unaltered.
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
 * Pushes a synthetic OCI image over HTTP so the control needs no docker daemon. `unique` makes two
 * calls produce two different digests.
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
 * The three key-posture refusals, demonstrated against the registry. A control the verifier accepts
 * fails the gate. The positive control at the end shows the verifier discriminates rather than
 * refusing everything.
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
    // Ephemeral keypair, discarded below. The release private key is never read.
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

    // The registry has no authentication, so image A's signature index can be PUT under image B's
    // `sha256-<digest>` fallback tag. It answers 201.
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

/**
 * The keyless refusals, demonstrated offline. A throwaway CA stands in for Fulcio via
 * `--trusted-root`, and the leaf carries a SAN URI and the OIDC-issuer extension
 * (1.3.6.1.4.1.57264.1.8) as a real Fulcio certificate does. This proves cosign refuses a wrong
 * identity, a wrong issuer and an unasserted identity. It does NOT prove the OIDC exchange, Fulcio
 * issuance or a Rekor entry.
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
  // Never a real owner, so the probe certificate cannot be mistaken for anything.
  const probeRepository = `prl-negative-control/${policy.repositoryName}`;
  const probeIdentity = expectedCertificateIdentity(policy, probeRepository);

  try {
    const openssl = (args, input) => {
      const result = spawnSync('openssl', args, { cwd: scratch, encoding: 'utf8', input });
      return result.status === 0 ? { ok: true } : { problem: (result.stderr ?? '').trim() };
    };
    const write = (name, text) => writeFileSync(join(scratch, name), text);

    // Both values come from the committed policy, which `parseKeylessPolicy` limits to safe
    // character sets. Arbitrary text here would be config injection into openssl's parser.
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

    // Without this trusted root every case below would fail identically and prove nothing.
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

    // Substitutions for Fulcio and Rekor. The real path (`verifyKeylessSignature` with no extra
    // flags) passes none of them.
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
        // Omits the identity flags on purpose. This refusal is cosign's own rule.
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

    // Read the certificate back and parse it, so the refusals are shown to be about the identity.
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
 * Reads the certificate from a cosign v0.3 bundle over plain HTTP (index, manifest, bundle layer).
 * Used only against the loopback registry, because this module implements no token flow.
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

    // The verifier is chosen by the record's posture, so one per-image loop serves both.
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
      // The policy is what verification asserts, but a record naming a different workflow describes
      // a signature this gate is not verifying.
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

    // The tie to the build. cosign cannot check this.
    const reconciled = reconcileWithManifest(images, manifestRead.value);
    for (const problem of reconciled.problems) gate.fail('signatures do not match the release', problem);
    if (reconciled.problems.length > 0) return;
    gate.note(
      `${reconciled.matched.length} of ${Object.keys(manifestRead.value?.images ?? {}).length} release ` +
        'image(s) have a signature record over the exact digest the build recorded: ' +
        `${reconciled.matched.join(', ')}`,
    );

    // cosign is required only here. Asked first, a machine without it answered every file-level
    // refusal with "cosign is not installed" and failed five image-provenance.test.mjs cases on CI.
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

    let verified = 0;
    for (const image of images) {
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
        // GHCR wants credentials and this module has no token flow, so the re-hash is not performed.
        // cosign below still fails if the registry does not hold the digest.
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
    if (code !== 0) {
      // The pass epilogue must not print on a failed run, where it could name an attacker-org identity.
      const anchor = report.posture === 'keyless' ? 'the committed identity policy' : 'the committed key';
      console.log(
        red(
          '\n  This gate FAILED, so nothing here is proven. The images named in the signature\n' +
            `  record were NOT verified against ${anchor}, and this run establishes\n` +
            '  nothing whatever about their provenance. Fix the failures above and run it again.\n',
        ),
      );
      return code;
    }
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
