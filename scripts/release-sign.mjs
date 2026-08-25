#!/usr/bin/env node
/**
 * Publishes the release images to the promotion registry and SIGNS them by digest.
 *
 * Invoked by `pnpm run release:sign`. This is the only script in the repository that touches the
 * private key, and it is separate from the verification gate for one reason that is the whole point
 * of the exercise: `pnpm run security:image-provenance` must be runnable by somebody who has only
 * `deploy/signing/cosign.pub`. If signing and verifying lived in one file, the natural thing to do
 * would be to share a key path, and the day somebody "simplified" that the gate would need the
 * private key to run — at which point every machine that can check a signature can also forge one,
 * and the control is gone. Two entry points, one direction of trust.
 *
 * ## The blocker this closes
 *
 * `docs/production/final-readiness-report.md`, residual 3: *"Images carry a registry digest but no
 * signature. `release:artifacts --push` publishes to a registry and the round trip is proven … What
 * does not exist is provenance: nothing is signed, there is no transparency log, and a local
 * registry is not a third party."*
 *
 * The round trip was real and it answered a different question. A digest proves that two parties
 * hold the same bytes; it does not say those bytes came from here. The lab registry has no
 * authentication — `deploy/registry/README.md` says so in as many words — so anything that can
 * reach 127.0.0.1:5001 could push an artefact under `prl-api`, and a deployer pulling by digest
 * would get exactly what they asked for and no way at all to tell whose it was.
 *
 * ## What this does, in order, and why each step is not the previous one
 *
 *   1. **Reads the release manifest.** The digests come from `release-artifacts.mjs`'s output and
 *      from nowhere else. This script cannot build an image and must never learn how: the moment it
 *      can, "the signed artefact is the artefact staging tested" stops being true by construction.
 *   2. **Pushes each image to the registry and proves the registry holds the same artefact.**
 *      Reusing `verifyRegistryDigest` from `scripts/registry-digest.mjs`, which re-fetches the
 *      manifest over HTTP and re-hashes it here, and refusing outright if the registry digest is
 *      not the build digest — the multi-platform conversion case that module's header documents.
 *      Signing a converted artefact would produce a signature over bytes staging never ran.
 *   3. **Signs the DIGEST reference.** Never the tag. cosign's own help says it and it is the
 *      difference between signing an artefact and signing a pointer somebody else can move.
 *   4. **Attests a CycloneDX SBOM** produced by trivy against that same digest reference, so the
 *      inventory is bound by signature to the artefact it inventories rather than sitting in a file
 *      beside it. `docs/sbom/` already holds an SBOM of the dependency graph; this one is of the
 *      IMAGE, which is the thing a deployer runs, and it is signed.
 *   5. **Writes the sidecar** `deploy/staging/release-signatures.json` — and writes it only if every
 *      step above succeeded for every image. A half-written record claiming one of two images is
 *      signed is worse than no record: the gate would pass on the half it can check.
 *
 * ## What this deliberately does NOT do
 *
 * It does not touch `deploy/staging/release-manifest.json`. `scripts/staging.mjs` switches a running
 * stack from `pull_policy: never` to `pull_policy: always` when that file grows a `registry` block,
 * so a signing step that wrote one would change how a live staging stack resolves its images.
 * Security work that silently redeploys something is not security work.
 *
 * It does not rebuild anything, and it refuses if the manifest's images are not present. A signature
 * over an image this machine cannot show you is a claim, not a check.
 *
 * ## The honest limit, stated here because this is where somebody reads it before signing
 *
 * This signs with a long-lived key held on the release machine. That binds a digest to POSSESSION
 * OF A KEY. It does not bind it to a builder, a source tree, or a moment in time, because there is
 * no transparency log behind it (`--tlog-upload=false`, against a loopback registry). Keyless/OIDC
 * signing in CI is what turns "somebody who had the key" into "a named workflow in a named
 * repository at a named commit", and this repository has no CI signing identity. See
 * `deploy/signing/README.md` § "What this does not prove".
 *
 * Usage:
 *     node scripts/release-sign.mjs [--manifest <path>] [--out <path>] [--registry <host:port>]
 *                                   [--key <path>] [--public-key <path>] [--no-attest] [--json]
 *     node scripts/release-sign.mjs --generate-key
 *
 * Exit codes: 0 every image pushed, signed, attested and recorded; 1 anything else. 0 for --help.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ATTESTATION_PREDICATE_TYPE,
  ATTESTATION_TYPE,
  COSIGN_SIGN_FLAGS,
  cosignVersion,
  MANIFEST_PATH,
  PRIVATE_KEY_PATH,
  PUBLIC_KEY_PATH,
  REPO_ROOT,
  readJsonFile,
  readPublicKey,
  runCosign,
  SIGNATURES_PATH,
  SIGNATURES_SCHEMA,
  SIGNING_ENV_PATH,
} from './image-signing.mjs';
import {
  DEFAULT_REGISTRY,
  DIGEST,
  parsePushDigest,
  parseRegistryHost,
  registryReference,
  registryRepoDigests,
  registryTagReference,
  verifyRegistryDigest,
} from './registry-digest.mjs';

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);

const failures = [];
const tick = (line, detail) => {
  console.log(`${green('  ✓')} ${line}`);
  if (detail) console.log(dim(`      ${detail}`));
};
const cross = (line, detail) => {
  failures.push(detail === undefined ? line : `${line} — ${detail}`);
  console.log(`${red('  ✗')} ${line}`);
  if (detail) console.log(dim(`      ${detail}`));
};

const HELP = `
${bold('pnpm run release:sign')} — push the release images and sign them by digest

  Options:
    --manifest <path>    release manifest to read              (default ${MANIFEST_PATH})
    --out <path>         where the signature record is written (default ${SIGNATURES_PATH})
    --registry <host>    registry to publish to                (default ${DEFAULT_REGISTRY})
    --key <path>         cosign private key                    (default ${PRIVATE_KEY_PATH})
    --public-key <path>  cosign public key, recorded           (default ${PUBLIC_KEY_PATH})
    --no-attest          sign only; do not attest an SBOM
    --json               print the signature record to stdout as well
    --generate-key       create a new keypair and passphrase, refusing to overwrite
    -h, --help           this text

  Needs COSIGN_PASSWORD. \`pnpm run release:sign\` loads it from ${SIGNING_ENV_PATH},
  which is gitignored and must never be committed.

  Verification needs NONE of that — only the committed public key:

      pnpm run security:image-provenance

  Exit codes: 0 everything signed and recorded, 1 anything else.
`;

function parseArgs(argv) {
  const options = {
    manifest: MANIFEST_PATH,
    out: SIGNATURES_PATH,
    registry: DEFAULT_REGISTRY,
    key: PRIVATE_KEY_PATH,
    publicKey: PUBLIC_KEY_PATH,
    attest: true,
    json: false,
    generateKey: false,
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
      case '--out':
        options.out = next();
        break;
      case '--registry':
        options.registry = next();
        break;
      case '--key':
        options.key = next();
        break;
      case '--public-key':
        options.publicKey = next();
        break;
      case '--no-attest':
        options.attest = false;
        break;
      case '--json':
        options.json = true;
        break;
      case '--generate-key':
        options.generateKey = true;
        break;
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/**
 * Creates the keypair and the passphrase file, and refuses to overwrite either.
 *
 * The refusal is the important half. Overwriting a signing key silently is how every artefact ever
 * signed with the old one becomes unverifiable at the same moment the gate starts passing again —
 * green, and describing signatures nobody can now check. Rotation is a procedure with a re-signing
 * step in it (`deploy/signing/README.md` § Rotation), not a file write.
 *
 * The passphrase is generated here rather than prompted for, because a human-chosen passphrase on a
 * key that only ever unlocks non-interactively is a passphrase that ends up being `password`.
 */
function generateKey(options) {
  const keyPath = resolve(REPO_ROOT, options.key);
  const publicPath = resolve(REPO_ROOT, options.publicKey);
  const envPath = resolve(REPO_ROOT, SIGNING_ENV_PATH);
  for (const [label, path] of [
    ['private key', keyPath],
    ['public key', publicPath],
    ['passphrase file', envPath],
  ]) {
    if (existsSync(path)) {
      console.error(
        red(
          `release:sign --generate-key — a ${label} already exists at ${path}.\n` +
            '  Refusing to overwrite it. Replacing a signing key invalidates every signature ever\n' +
            '  made with it, and doing that as a side effect of a command is how a release ends up\n' +
            '  green over signatures nobody can verify. See deploy/signing/README.md § Rotation.',
        ),
      );
      return 1;
    }
  }
  mkdirSync(dirname(keyPath), { recursive: true });
  const passphrase = randomBytes(24).toString('base64url');
  writeFileSync(
    envPath,
    '# The passphrase protecting deploy/signing/cosign.key. NEVER commit this file.\n' +
      `COSIGN_PASSWORD=${passphrase}\n`,
    { mode: 0o600 },
  );
  const result = spawnSync('cosign', ['generate-key-pair'], {
    cwd: dirname(keyPath),
    encoding: 'utf8',
    env: { ...process.env, COSIGN_PASSWORD: passphrase },
  });
  if (result.status !== 0) {
    console.error(red(`cosign generate-key-pair failed: ${result.stderr ?? ''}`));
    return 1;
  }
  console.log(green(`  ✓ keypair written to ${dirname(options.key)}`));
  console.log(dim(`      private key ${options.key} — gitignored, never commit`));
  console.log(dim(`      passphrase  ${SIGNING_ENV_PATH} — gitignored, never commit`));
  console.log(dim(`      public key  ${options.publicKey} — COMMIT THIS; it is the trust anchor`));
  console.log(
    dim(
      '\n  Every image signed with the previous key is now unverifiable against the committed\n' +
        '  public key. Re-sign them: `pnpm run release:sign`.\n',
    ),
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Pushes one built image to the registry and returns the registry facts, or a problem.
 *
 * This is deliberately the same shape of check as `pushArtefact` in `release-artifacts.mjs`, and
 * for the same reasons — read that function's header for why `RepoDigests` is cross-checked rather
 * than believed. The one difference is what happens when the registry digest and the build digest
 * are not equal: `release-artifacts.mjs` records both and explains, this REFUSES. A signature is
 * over one digest, and if the registry holds a converted artefact then the digest a deployer pulls
 * is not the digest staging tested — signing it would put a cryptographic guarantee on the wrong
 * bytes, which is worse than not signing at all.
 */
async function publish(image, registry, tagLabel) {
  const localReference = image.reference;
  if (capture(['image', 'inspect', localReference, '--format', '{{.Id}}']) === null) {
    return {
      problem:
        `${localReference} is not on this machine. This script signs an artefact it can point at; ` +
        'it cannot build one, and a signature over an image nobody can produce is a claim rather ' +
        'than a check. Run `pnpm run release:artifacts` first.',
    };
  }
  const registryTag = registryTagReference(registry.host, image.repository, tagLabel);
  const tagged = spawnSync('docker', ['tag', localReference, registryTag], { encoding: 'utf8' });
  if (tagged.status !== 0) {
    return { problem: `docker tag ${localReference} ${registryTag} failed: ${tagged.stderr?.trim()}` };
  }
  const push = spawnSync('docker', ['push', registryTag], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (push.status !== 0) {
    return {
      problem:
        `docker push ${registryTag} failed: ${push.stderr?.trim() || push.stdout?.trim()}\n      Is the ` +
        'registry up? `docker compose -f deploy/registry/docker-compose.registry.yml up -d`',
    };
  }
  const pushedDigest = parsePushDigest(`${push.stdout}\n${push.stderr}`);
  if (pushedDigest === null) {
    return { problem: `docker push ${registryTag} printed no "digest: sha256:…" line` };
  }
  const raw = capture(['image', 'inspect', registryTag, '--format', '{{json .RepoDigests}}']);
  let repoDigests = [];
  try {
    const parsed = JSON.parse(raw ?? 'null');
    if (Array.isArray(parsed)) repoDigests = parsed;
  } catch {
    repoDigests = [];
  }
  const reported = registryRepoDigests(repoDigests, registry.host, image.repository);
  if (reported.length > 0 && !reported.includes(pushedDigest)) {
    return {
      problem:
        `the push returned ${pushedDigest} but docker image inspect reports ${reported.join(', ')}. ` +
        'That is the multi-platform conversion case; the two digests describe different artefacts.',
    };
  }
  if (pushedDigest !== image.digest) {
    return {
      problem:
        `the registry assigned ${pushedDigest} to an image the build recorded as ${image.digest}. ` +
        'Refusing to sign: the digest a deployer would pull is not the digest staging tested, and a ' +
        'signature over it would attach a cryptographic guarantee to the wrong bytes.',
    };
  }
  const verified = await verifyRegistryDigest({
    host: registry.host,
    repository: image.repository,
    digest: pushedDigest,
    localDigest: image.digest,
  });
  if (!verified.ok) return { problem: verified.problem };
  return {
    registryDigest: pushedDigest,
    reference: registryReference(registry.host, image.repository, pushedDigest),
    tag: registryTag,
    tiedBy: verified.tie,
  };
}

/** `docker …`, trimmed stdout, or null. Local to this file; the daemon is only used here. */
function capture(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? (result.stdout ?? '').trim() : null;
}

// ---------------------------------------------------------------------------
// Signing and attesting
// ---------------------------------------------------------------------------

function sign(reference, keyPath, env) {
  const result = runCosign(['sign', '--key', keyPath, ...COSIGN_SIGN_FLAGS, reference], { env });
  if (result.status !== 0) {
    return { problem: `cosign sign ${reference} exited ${result.status}: ${result.stderr.trim()}` };
  }
  return { ok: true };
}

/**
 * Produces a CycloneDX SBOM of the image with trivy and attests it against the same digest.
 *
 * trivy is already a hard dependency of `pnpm run security:containers`, which refuses rather than
 * skipping when it is absent, so requiring it here adds no new tool to the release machine. The
 * SBOM is generated from the REGISTRY reference rather than the local one so that the bytes
 * inventoried are the bytes a deployer would pull.
 *
 * The component count is returned and recorded, and the gate re-derives it from the SIGNED payload.
 * `cosign attest` will sign `{}` without complaint; an attestation over an empty predicate is a
 * perfectly valid signature over no information, and "an attestation exists" would otherwise be
 * treated as evidence that something was inventoried.
 */
function attest(reference, keyPath, env, scratch) {
  const sbomPath = join(scratch, 'sbom.cdx.json');
  const trivy = spawnSync(
    'trivy',
    ['image', '--quiet', '--format', 'cyclonedx', '--output', sbomPath, reference],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (trivy.status !== 0 || !existsSync(sbomPath)) {
    return {
      problem:
        `trivy could not produce an SBOM for ${reference}: ` +
        `${(trivy.stderr ?? '').trim().split('\n').slice(-3).join(' ') || 'no output'}`,
    };
  }
  let components = 0;
  let specVersion = null;
  try {
    const sbom = JSON.parse(readFileSync(sbomPath, 'utf8'));
    components = Array.isArray(sbom?.components) ? sbom.components.length : 0;
    specVersion = typeof sbom?.specVersion === 'string' ? sbom.specVersion : null;
  } catch (err) {
    return { problem: `trivy's SBOM for ${reference} is not JSON: ${err.message}` };
  }
  if (components === 0) {
    return {
      problem:
        `trivy's SBOM for ${reference} lists zero components. Attesting it would produce a valid ` +
        'signature over an inventory of nothing, which reads as provenance and is not.',
    };
  }
  const result = runCosign(
    [
      'attest',
      '--key',
      keyPath,
      '--type',
      ATTESTATION_TYPE,
      '--predicate',
      sbomPath,
      ...COSIGN_SIGN_FLAGS,
      reference,
    ],
    { env },
  );
  if (result.status !== 0) {
    return { problem: `cosign attest ${reference} exited ${result.status}: ${result.stderr.trim()}` };
  }
  return { components, specVersion, predicateType: ATTESTATION_PREDICATE_TYPE };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(red(`release:sign — ${err.message}`));
    process.exit(1);
  }
  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  const version = cosignVersion();
  if (version === null) {
    console.error(
      red(
        '  ✗ cosign is not installed, so nothing can be signed.\n' +
          '      Install it — `brew install cosign` — and run this again. This REFUSES rather than\n' +
          '      skipping: a signing step that exits 0 without signing leaves unsigned images behind\n' +
          '      a green tick, which is the exact state this script exists to end.\n',
      ),
    );
    process.exit(1);
  }

  if (options.generateKey) process.exit(generateKey(options));

  console.log(bold('\nRelease signatures'));
  console.log(dim(`  cosign   ${version}`));

  const registry = parseRegistryHost(options.registry);
  if ('problem' in registry) {
    console.error(red(`release:sign — --registry ${registry.problem}`));
    process.exit(1);
  }
  if (!registry.loopback) {
    console.error(
      red(
        `release:sign — --registry ${registry.host} is not a loopback address. This script sends no ` +
          'registry credentials and talks plain HTTP, exactly as release-artifacts.mjs --push does. ' +
          'Signing into a real registry needs authentication, TLS and a key that is not sitting in a ' +
          'file on the release machine; that belongs in CI with keyless signing.',
      ),
    );
    process.exit(1);
  }

  const keyPath = resolve(REPO_ROOT, options.key);
  if (!existsSync(keyPath)) {
    console.error(
      red(
        `release:sign — no private key at ${options.key}.\n` +
          '  Create one with `pnpm run release:sign --generate-key`, then COMMIT the public half\n' +
          `  (${options.publicKey}) and never the private half. See deploy/signing/README.md.`,
      ),
    );
    process.exit(1);
  }
  if (process.env.COSIGN_PASSWORD === undefined) {
    console.error(
      red(
        'release:sign — COSIGN_PASSWORD is not set. `pnpm run release:sign` loads it from\n' +
          `  ${SIGNING_ENV_PATH}; that file is gitignored and this run found nothing in the\n` +
          '  environment. Refusing rather than prompting: an unattended prompt is a hung release.',
      ),
    );
    process.exit(1);
  }
  const publicKey = readPublicKey(options.publicKey);
  if ('problem' in publicKey) {
    console.error(red(`release:sign — ${publicKey.problem}`));
    process.exit(1);
  }

  const manifestRead = readJsonFile(options.manifest);
  if ('problem' in manifestRead) {
    console.error(red(`release:sign — ${manifestRead.problem}. Run \`pnpm run release:artifacts\`.`));
    process.exit(1);
  }
  const manifest = manifestRead.value;
  const services = Object.entries(manifest?.images ?? {});
  if (services.length === 0) {
    console.error(red(`release:sign — ${options.manifest} names no images, so there is nothing to sign.`));
    process.exit(1);
  }
  const commitSha = manifest?.commit?.sha ?? null;
  const tagLabel = `${manifest?.commit?.shortSha ?? 'local'}${manifest?.commit?.dirty === true ? '-dirty' : ''}`;
  console.log(dim(`  registry ${registry.host}`));
  console.log(dim(`  manifest ${options.manifest}  (commit ${commitSha ?? 'unknown'})`));
  console.log(dim(`  key      ${options.key}  → fingerprint ${publicKey.fingerprint.slice(0, 16)}…\n`));

  const scratch = mkdtempSync(join(tmpdir(), 'prl-sign-'));
  const signed = {};
  const env = { ...process.env };

  try {
    for (const [service, image] of services) {
      console.log(bold(`▸ ${service}`));
      if (!DIGEST.test(String(image?.digest))) {
        cross(`${service}: the release manifest records no usable digest`);
        continue;
      }
      const published = await publish({ ...image, service }, registry, tagLabel);
      if ('problem' in published) {
        cross(`${service}: not published`, published.problem);
        continue;
      }
      tick(
        `published ${published.tag}`,
        `${published.registryDigest}\n      registry manifest re-fetched and re-hashed here ` +
          `(${published.tiedBy}); it is the build digest, unchanged`,
      );

      const signature = sign(published.reference, keyPath, env);
      if ('problem' in signature) {
        cross(`${service}: not signed`, signature.problem);
        continue;
      }
      tick(`signed ${service} by digest`, published.reference);

      let attestation = null;
      if (options.attest) {
        const result = attest(published.reference, keyPath, env, scratch);
        if ('problem' in result) {
          cross(`${service}: not attested`, result.problem);
          continue;
        }
        attestation = result;
        tick(
          `attested a CycloneDX SBOM of ${service}`,
          `${result.components} components, CycloneDX ${result.specVersion ?? '?'}, predicate ` +
            `${result.predicateType}`,
        );
      }

      signed[service] = {
        service,
        repository: image.repository ?? null,
        // The digest `release-artifacts.mjs` recorded. The gate refuses unless this is byte-identical
        // to the manifest's digest for this service — that comparison is what ties a signature to
        // THIS repository's build rather than to some other correctly-signed image.
        buildDigest: image.digest,
        registryDigest: published.registryDigest,
        reference: published.reference,
        tag: published.tag,
        tiedBy: published.tiedBy,
        signed: true,
        signedAt: new Date().toISOString(),
        attestation,
      };
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failures.length > 0 || Object.keys(signed).length !== services.length) {
    console.log(red(bold(`\nFAIL — ${failures.length} problem(s); no signature record was written.`)));
    for (const failure of failures) console.log(red(`    - ${failure}`));
    console.log(
      dim(
        '\n  Deliberately all-or-nothing. A record claiming one of two images is signed would let the\n' +
          '  gate pass on the half it can check while an unsigned image ships beside it.\n',
      ),
    );
    process.exit(1);
  }

  const record = {
    schema: SIGNATURES_SCHEMA,
    signedAt: new Date().toISOString(),
    cosignVersion: version,
    registry: registry.host,
    commit: manifest?.commit ?? null,
    publicKey: {
      path: options.publicKey,
      // SHA-256 of the DER body, not of the file: a trailing newline is not a key rotation.
      fingerprint: publicKey.fingerprint,
    },
    transparencyLog: {
      used: false,
      why:
        'signed with --tlog-upload=false and verified with --insecure-ignore-tlog. Rekor is a public ' +
        'log and this is a loopback registry holding a lab artefact. The cost, stated rather than ' +
        'implied: there is no third-party record that these signatures existed at a time, so key ' +
        'compromise is not detectable after the fact and a signature cannot be shown to predate a ' +
        'revocation.',
    },
    provenanceLimit:
      'These signatures prove possession of the key whose public half is committed at ' +
      `${options.publicKey}. They do NOT identify a builder, a source tree or a build environment: ` +
      'that needs keyless/OIDC signing from a CI workload identity, which this repository does not ' +
      'have. Do not quote this file as SLSA provenance.',
    images: signed,
  };
  const outPath = resolve(REPO_ROOT, options.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
  tick(`signature record written to ${options.out}`);
  if (options.json) console.log(JSON.stringify(record, null, 2));

  console.log(green(bold('\nPASS — every release image is published, signed and attested by digest.')));
  console.log(
    dim(
      '\n  Verify with the COMMITTED PUBLIC KEY and nothing else:\n\n' +
        '      pnpm run security:image-provenance\n\n' +
        '  What is now true: the digest a deployer pulls is bound by signature to the key this\n' +
        '  repository controls, and each image carries a signed SBOM of its own contents.\n' +
        '  What is still NOT true: nothing binds these bytes to a builder or a source tree that an\n' +
        '  outsider could check, and there is no transparency log. A locally-held key proves\n' +
        '  possession of a key. See deploy/signing/README.md before quoting any of this.\n',
    ),
  );
}

if (import.meta.main) await main();
