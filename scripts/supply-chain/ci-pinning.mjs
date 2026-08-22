#!/usr/bin/env node
/**
 * Gate: the build pipeline's own dependencies are pinned to immutable references.
 *
 * ## Why this gate exists
 *
 * The repository's dependency policy is "mutable references are how supply-chain
 * attacks land": exact versions, a frozen lockfile, a 7-day cooldown, integrity
 * hashes checked against the registry. Every one of those controls is enforced by
 * a gate. The *pipeline's* dependencies — GitHub Actions and container base
 * images — were held to the same standard by nothing but header comments in
 * ci.yml and Dockerfile.api. They were, and are, correct; but
 * `uses: actions/cache@v4` added tomorrow passed all eight gates, and
 * `actions/cache@v4` is a pointer its owner can repoint at new code that then
 * runs inside this repository's CI. The campaign in
 * docs/security/shai-hulud-snapshot-2026-08-17.md §1 lists **GitHub Actions and
 * Docker images** among the supply chains it compromised, and §2 says it hijacks
 * workflows to mint publish tokens.
 *
 * So: an unpinned `uses:`, an unpinned `FROM`, a floating `runs-on: *-latest`, or
 * a workflow file nobody declared is a release-blocking failure, the same as an
 * unpinned npm dependency.
 *
 * ## The workflow inventory
 *
 * `.github/workflows/codeql.yml` is a campaign IOC (§3): the worm injects a
 * workflow whose name squats on one people expect to see, so a reviewer's eye
 * slides past it. `ioc-scan.mjs` warns about that one filename. This gate takes
 * the stronger position available to a repository that knows its own workflows:
 * anything not in `EXPECTED_WORKFLOWS` fails, whatever it is called. Adding a
 * workflow is then a two-file diff, which is the point.
 *
 * ## Discovery is recursive, and that is a fix rather than a tidy-up
 *
 * This gate used to find its container files with a NON-recursive
 * `readdirSync(REPO_ROOT)` matching `/^Dockerfile(\..+)?$/` and
 * `/^docker-compose(\..+)?\.ya?ml$/`. Two whole classes of file were therefore
 * invisible to all nine gates:
 *
 *   * anything in a subdirectory — `deploy/staging/compose.yml`, a Dockerfile
 *     under `docker/`, an overlay under `k8s/`;
 *   * anything using Compose v2's filenames — `compose.yml`, `compose.yaml`,
 *     `compose.override.yml`, which is the spelling `docker compose` has
 *     preferred since v2 and which every new file is likely to use.
 *
 * An `image: postgres:16` in either of those passed the release audit in silence:
 * not "was checked and allowed", but "was never read". The walk below is
 * recursive and matches both naming conventions, and
 * `ci-pinning.test.mjs` feeds it a nested `compose.yml` with an unpinned image to
 * prove it now fires.
 *
 * ## The one thing an `image:` may be other than a digest
 *
 * `docker-compose.staging.yml` deploys the two application images **by digest**,
 * and those digests are produced per build by `pnpm run release:artifacts`. They
 * cannot be literals in a committed file. The value is therefore a compose
 * interpolation that is REQUIRED and has NO default —
 * `${PRL_API_IMAGE:?the API image DIGEST...}` — and that exact shape is accepted
 * here, for a reason worth stating precisely:
 *
 *   * `${VAR:-postgres:16}` is REJECTED. The default is a committed mutable tag,
 *     which is exactly what this gate exists to forbid, and it is the shape a
 *     reader is most likely to reach for.
 *   * `${VAR}` is REJECTED. Compose substitutes empty and fails obscurely, and
 *     nothing about the value is constrained.
 *   * `${VAR:?message}` is ACCEPTED. Nothing mutable is committed, and compose
 *     refuses to run at all without a value.
 *
 * What this gate cannot see is whether the injected value is itself a digest. That
 * is checked where it can be: `scripts/staging.mjs` refuses a manifest whose
 * references are not `name@sha256:<64 hex>`, and after `up` it compares the
 * running containers' images against the manifest and fails on a difference. The
 * split is deliberate — a static gate should not pretend to know a runtime value —
 * and it is recorded here so the exception is not read as a loophole.
 *
 * ## `--freshness`: a reporter, not a gate
 *
 * Passing `--freshness` re-resolves every pinned tag against its registry and
 * reports which digests have moved upstream. It exits 0 whatever it finds, and
 * that is deliberate rather than lax: a base image rebuilt for a security patch
 * must be VISIBLE, but failing the build on it would make every offline or
 * rate-limited run red and would put a network dependency in the middle of an
 * otherwise hermetic gate. Drift is a prompt to review and refresh a digest, in a
 * reviewed diff, which is the whole point of pinning.
 *
 * The checks are pure functions over file text so
 * `scripts/supply-chain/ci-pinning.test.mjs` can feed them the real attacks.
 *
 * Usage:
 *     node scripts/supply-chain/ci-pinning.mjs               the gate
 *     node scripts/supply-chain/ci-pinning.mjs --freshness   the drift report
 *     node scripts/supply-chain/ci-pinning.mjs --freshness --json
 *
 * Exit codes: 0 pass (and 0 from --freshness whatever it finds), 1 a gate failure
 * or a bad argument.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EXPECTED_WORKFLOWS } from './denied-packages.mjs';
import { bold, dim, Gate, green, REPO_ROOT, red, runGate, yellow } from './lib.mjs';

/** A full git commit SHA. Anything shorter is ambiguous and anything else is a moving pointer. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;
/** An OCI content digest. */
const IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/;

/**
 * A compose value that is entirely a required interpolation with no default:
 * `${VAR:?message}` or `${VAR?message}`. See the header for why this shape, and
 * only this shape, is an acceptable `image:`.
 */
const REQUIRED_INTERPOLATION = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?\?[^}]*\}$/;

/** Directories that never contain first-party container files. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  'coverage',
  '.pnpm-store',
  '.turbo',
  'sbom',
]);

/** `Dockerfile`, `Dockerfile.api`, `Dockerfile.web`. */
const DOCKERFILE_NAME = /^Dockerfile(\..+)?$/;
/**
 * Compose v1 (`docker-compose.yml`, `docker-compose.staging.yml`) and Compose v2
 * (`compose.yaml`, `compose.override.yml`). The `docker-` prefix is optional
 * because v2 dropped it, and a file named `compose.yml` matched neither of the
 * old patterns — so an unpinned image in one was invisible to every gate.
 */
const COMPOSE_NAME = /^(?:docker-)?compose(\..+)?\.ya?ml$/;

/**
 * Strips YAML/Dockerfile line comments so prose *about* an unpinned reference is
 * not read as one. ci.yml's own header contains the literal text
 * `uses: actions/checkout@v7` as an example of what not to write.
 */
function uncomment(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#')) return '';
  const hash = line.indexOf(' #');
  return hash === -1 ? line : line.slice(0, hash);
}

/** Every `.yml`/`.yaml` file under `.github/workflows`, by bare filename. */
export function listWorkflowFiles(workflowDir) {
  if (!existsSync(workflowDir)) return [];
  return readdirSync(workflowDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * Check: only the declared workflows exist, and all of them do.
 *
 * @param {Gate} gate
 * @param {string[]} present bare filenames
 */
export function checkWorkflowInventory(gate, present) {
  for (const name of present) {
    if (EXPECTED_WORKFLOWS.has(name)) continue;
    gate.fail(
      `unexpected workflow file: .github/workflows/${name}`,
      'this repository declares its workflows in EXPECTED_WORKFLOWS (scripts/supply-chain/denied-packages.mjs). ' +
        'An injected workflow is how the campaign mints publish tokens from CI — .github/workflows/codeql.yml ' +
        'is a named IOC. If this file is legitimate, add it there in the same reviewed diff.',
    );
  }
  for (const name of EXPECTED_WORKFLOWS) {
    if (present.includes(name)) continue;
    gate.fail(
      `declared workflow is missing: .github/workflows/${name}`,
      'a workflow that silently disappears takes its gate with it',
    );
  }
  if (present.length === 0) {
    gate.fail('no workflow files found', 'this gate examined nothing — a scan of nothing proves nothing');
  }
}

/**
 * Reads the value of an `image:` line.
 *
 * Takes the rest of the line rather than the first whitespace-delimited token,
 * because a required compose interpolation carries a human-readable message and
 * therefore contains spaces: `image: ${PRL_API_IMAGE:?the API image DIGEST...}`.
 * A `\S+` capture read that as `${PRL_API_IMAGE:?the` and judged a fragment.
 */
function imageValue(line) {
  const match = /^\s*image:\s*(.+?)\s*$/.exec(line);
  if (match === null) return null;
  const raw = match[1] ?? '';
  // A quoted value is the same value; compose and Actions both accept either.
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Check: every `uses:` is a full commit SHA, a local action, or a digest-pinned
 * container action; and no job runs on a floating `*-latest` runner label.
 *
 * @param {Gate} gate
 * @param {string} label  how to name this file in a message
 * @param {string} text
 * @returns {number} how many `uses:` references were judged
 */
export function checkWorkflowPinning(gate, label, text) {
  let judged = 0;
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = uncomment(rawLine);
    const at = `${label}:${index + 1}`;

    const uses = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
    if (uses) {
      judged += 1;
      const reference = uses[1] ?? '';
      if (reference.startsWith('./') || reference.startsWith('.\\')) {
        // A local action lives in this repository and is reviewed with it.
      } else if (reference.startsWith('docker://')) {
        if (!IMAGE_DIGEST.test(reference)) {
          gate.fail(
            `container action is not digest-pinned at ${at}: ${reference}`,
            'use docker://image@sha256:<64 hex> so the image cannot be replaced under the tag',
          );
        }
      } else {
        const atSign = reference.lastIndexOf('@');
        const ref = atSign === -1 ? '' : reference.slice(atSign + 1);
        if (!COMMIT_SHA.test(ref)) {
          gate.fail(
            `action is not pinned to a full commit SHA at ${at}: ${reference}`,
            'a tag or branch is a pointer the action owner — or whoever compromises them — can repoint ' +
              "at new code that then runs in this repository's CI. Use owner/repo@<40-char SHA> with the " +
              'version in a trailing comment; see the ci.yml header for how to obtain one.',
          );
        }
      }
      continue;
    }

    const runsOn = /^\s*runs-on:\s*(\S+)/.exec(line);
    if (runsOn) {
      const runner = runsOn[1] ?? '';
      if (runner.endsWith('-latest')) {
        gate.fail(
          `floating runner image at ${at}: ${runner}`,
          'pin the runner version (e.g. ubuntu-24.04) so a runner-image rollout is a reviewed change ' +
            'rather than an overnight one',
        );
      }
      continue;
    }

    const image = imageValue(line);
    if (image !== null && !IMAGE_DIGEST.test(image)) {
      // A workflow is not interpolated by compose, so the required-interpolation
      // exception below deliberately does not apply here: a service container
      // reference is either a digest or it is mutable.
      gate.fail(
        `service container is not digest-pinned at ${at}: ${image}`,
        'a tag is mutable; pin image:tag@sha256:<64 hex> with the tag kept in a comment',
      );
    }
  }
  return judged;
}

/**
 * Check: every `FROM` either refers to a stage declared earlier in the same file
 * or carries an image digest.
 *
 * @param {Gate} gate
 * @param {string} label
 * @param {string} text
 * @returns {number} how many external base images were judged
 */
export function checkDockerfilePinning(gate, label, text) {
  const stages = new Set();
  let judged = 0;
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = uncomment(rawLine);
    const from = /^\s*FROM\s+(.+)$/i.exec(line);
    if (!from) continue;
    const at = `${label}:${index + 1}`;
    const parts = (from[1] ?? '').trim().split(/\s+/);
    const words = parts.filter((p) => !p.startsWith('--'));
    const image = words[0] ?? '';
    const asIndex = words.findIndex((w) => w.toLowerCase() === 'as');
    if (asIndex !== -1) {
      const stage = words[asIndex + 1];
      if (stage !== undefined) stages.add(stage);
    }
    // A reference to an earlier stage in the same file is internal to this build.
    if (stages.has(image) || image === '') continue;
    judged += 1;
    if (!IMAGE_DIGEST.test(image)) {
      gate.fail(
        `base image is not digest-pinned at ${at}: ${image}`,
        'a tag can be repointed at a new image after review; pin image:tag@sha256:<64 hex> and keep ' +
          'the human-readable tag in a comment above it',
      );
    }
  }
  return judged;
}

/**
 * Check: every `image:` in a compose file carries a digest, or is a required
 * interpolation with no default. Services built from a local Dockerfile have no
 * `image:` and are covered by the Dockerfile check.
 *
 * @param {Gate} gate
 * @param {string} label
 * @param {string} text
 * @returns {number}
 */
export function checkComposePinning(gate, label, text) {
  let judged = 0;
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = uncomment(rawLine);
    const reference = imageValue(line);
    if (reference === null) continue;
    judged += 1;
    if (IMAGE_DIGEST.test(reference)) continue;
    if (REQUIRED_INTERPOLATION.test(reference)) continue;
    gate.fail(
      `compose image is not digest-pinned at ${label}:${index + 1}: ${reference}`,
      'pin image:tag@sha256:<64 hex>; a tag is mutable and this is the artefact that ships. The only ' +
        'other accepted form is a compose interpolation that is REQUIRED and has no default — the ' +
        'colon-question-mark form, as in PRL_API_IMAGE:?why — because nothing mutable is then ' +
        'committed and compose refuses to run at all without a value. The colon-dash form is not ' +
        'that: its default is a committed mutable tag.',
    );
  }
  return judged;
}

/**
 * Every Dockerfile and compose file in the repository, recursively.
 *
 * Exported so the tests discover exactly what the gate discovers; a test that
 * re-implements the walk is a test that cannot catch a walk that stopped walking.
 *
 * @param {string} root
 * @returns {{dockerfiles: string[], composeFiles: string[]}} repo-relative paths
 */
export function discoverContainerFiles(root) {
  const dockerfiles = [];
  const composeFiles = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, full).split('\\').join('/');
      if (DOCKERFILE_NAME.test(entry.name)) dockerfiles.push(rel);
      else if (COMPOSE_NAME.test(entry.name)) composeFiles.push(rel);
    }
  };
  walk(root);
  return { dockerfiles: dockerfiles.sort(), composeFiles: composeFiles.sort() };
}

export function runCiPinningGate() {
  const gate = new Gate('ci-and-container-pinning');
  return runGate(gate, () => {
    const workflowDir = join(REPO_ROOT, '.github', 'workflows');
    const workflows = listWorkflowFiles(workflowDir);
    checkWorkflowInventory(gate, workflows);

    let actionRefs = 0;
    for (const name of workflows) {
      const path = join(workflowDir, name);
      actionRefs += checkWorkflowPinning(gate, relative(REPO_ROOT, path), readFileSync(path, 'utf8'));
    }

    const { dockerfiles, composeFiles } = discoverContainerFiles(REPO_ROOT);
    if (dockerfiles.length === 0) {
      gate.fail('no Dockerfile found', 'the base-image pinning check examined nothing');
    }
    if (composeFiles.length === 0) {
      gate.fail('no compose file found', 'the compose image check examined nothing');
    }
    let baseImages = 0;
    for (const name of dockerfiles) {
      baseImages += checkDockerfilePinning(gate, name, readFileSync(join(REPO_ROOT, name), 'utf8'));
    }
    let composeImages = 0;
    for (const name of composeFiles) {
      composeImages += checkComposePinning(gate, name, readFileSync(join(REPO_ROOT, name), 'utf8'));
    }

    gate.note(
      `${workflows.length} workflow(s), ${actionRefs} action reference(s), ` +
        `${dockerfiles.length} Dockerfile(s) with ${baseImages} external base image(s), ` +
        `${composeFiles.length} compose file(s) with ${composeImages} image reference(s)`,
    );
  });
}

// ---------------------------------------------------------------------------
// --freshness: is a pinned digest still what its tag points at?
// ---------------------------------------------------------------------------

/**
 * Splits `registry/name:tag@sha256:...` into its parts.
 *
 * The awkward case is a registry with a port (`localhost:5000/x:1`), where the
 * first colon is not the tag separator. The rule used is the one the reference
 * grammar uses: a colon introduces a tag only if what follows it contains no `/`.
 *
 * @returns {{name: string, tag: string|null, digest: string} | null}
 */
export function parsePinnedReference(reference) {
  const at = reference.lastIndexOf('@');
  if (at === -1) return null;
  const digest = reference.slice(at + 1);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return null;
  const left = reference.slice(0, at);
  const colon = left.lastIndexOf(':');
  if (colon === -1 || left.slice(colon + 1).includes('/')) return { name: left, tag: null, digest };
  return { name: left.slice(0, colon), tag: left.slice(colon + 1), digest };
}

/**
 * Every digest-pinned image reference in the repository's container and workflow
 * files, with where it was found.
 *
 * Reads the same files the gate reads, through the same discovery, so a reference
 * the gate judges is a reference this can re-check — and one it cannot see is one
 * neither of them sees, which is a single failure rather than two.
 */
export function collectPinnedImages(root) {
  const found = [];
  const add = (file, index, reference) => {
    const parsed = parsePinnedReference(reference);
    if (parsed !== null) found.push({ ...parsed, reference, at: `${file}:${index + 1}` });
  };

  const workflowDir = join(root, '.github', 'workflows');
  for (const name of listWorkflowFiles(workflowDir)) {
    const rel = `.github/workflows/${name}`;
    for (const [index, rawLine] of readFileSync(join(workflowDir, name), 'utf8').split('\n').entries()) {
      const line = uncomment(rawLine);
      const image = imageValue(line);
      if (image !== null) add(rel, index, image);
      const uses = /^\s*-?\s*uses:\s*docker:\/\/(\S+)/.exec(line);
      if (uses) add(rel, index, uses[1] ?? '');
    }
  }

  const { dockerfiles, composeFiles } = discoverContainerFiles(root);
  for (const rel of dockerfiles) {
    for (const [index, rawLine] of readFileSync(join(root, rel), 'utf8').split('\n').entries()) {
      const line = uncomment(rawLine);
      const from = /^\s*FROM\s+(.+)$/i.exec(line);
      if (!from) continue;
      const words = (from[1] ?? '')
        .trim()
        .split(/\s+/)
        .filter((p) => !p.startsWith('--'));
      add(rel, index, words[0] ?? '');
    }
  }
  for (const rel of composeFiles) {
    for (const [index, rawLine] of readFileSync(join(root, rel), 'utf8').split('\n').entries()) {
      const image = imageValue(uncomment(rawLine));
      if (image !== null) add(rel, index, image);
    }
  }

  // Deduplicated by reference, keeping every place it appears: the same base image
  // is pinned in both Dockerfiles and the report should say so once.
  const byReference = new Map();
  for (const entry of found) {
    const existing = byReference.get(entry.reference);
    if (existing === undefined) byReference.set(entry.reference, { ...entry, at: [entry.at] });
    else existing.at.push(entry.at);
  }
  return [...byReference.values()];
}

/**
 * Re-resolves one tag against Docker Hub and returns the digest it points at now.
 *
 * Only Docker Hub is supported, and a reference to any other registry is reported
 * as unchecked rather than assumed current — an "everything is fine" that came
 * from not looking is the failure mode this whole file exists to avoid.
 *
 * The two `Accept` headers matter: without them the registry returns a
 * single-platform manifest for the daemon's architecture and its digest is NOT
 * the digest a multi-arch tag resolves to, so every multi-arch pin would look
 * like it had drifted.
 */
async function resolveTagDigest(name, tag) {
  if (name.includes('.') || name.startsWith('localhost')) {
    return { digest: null, why: 'not on Docker Hub; this reporter only speaks to registry-1.docker.io' };
  }
  const repository = name.includes('/') ? name : `library/${name}`;
  try {
    const tokenResponse = await fetch(
      `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!tokenResponse.ok) return { digest: null, why: `token endpoint answered ${tokenResponse.status}` };
    const token = (await tokenResponse.json()).token;
    if (typeof token !== 'string') return { digest: null, why: 'the token endpoint returned no token' };

    const manifest = await fetch(`https://registry-1.docker.io/v2/${repository}/manifests/${tag}`, {
      method: 'HEAD',
      headers: {
        authorization: `Bearer ${token}`,
        accept: [
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.v2+json',
        ].join(', '),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!manifest.ok) return { digest: null, why: `the registry answered ${manifest.status} for :${tag}` };
    const digest = manifest.headers.get('docker-content-digest');
    return digest === null ? { digest: null, why: 'no docker-content-digest header' } : { digest, why: null };
  } catch (err) {
    return { digest: null, why: err?.message ?? String(err) };
  }
}

/**
 * The drift report. Always exits 0 — see the header for why that is deliberate.
 *
 * @param {boolean} asJson
 */
async function runFreshnessReport(asJson) {
  const pinned = collectPinnedImages(REPO_ROOT);
  const results = [];
  for (const entry of pinned) {
    if (entry.tag === null) {
      results.push({
        ...entry,
        state: 'no-tag',
        current: null,
        why: 'pinned by digest with no tag to re-resolve',
      });
      continue;
    }
    const resolved = await resolveTagDigest(entry.name, entry.tag);
    if (resolved.digest === null) {
      results.push({ ...entry, state: 'unresolved', current: null, why: resolved.why });
    } else if (resolved.digest === entry.digest) {
      results.push({ ...entry, state: 'current', current: resolved.digest, why: null });
    } else {
      results.push({ ...entry, state: 'drifted', current: resolved.digest, why: null });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), images: results }, null, 2));
    return;
  }

  console.log(bold('\nBase-image digest freshness'));
  for (const result of results) {
    const where = result.at.join(', ');
    if (result.state === 'current') {
      console.log(`${green('  ✓')} ${result.name}:${result.tag}`);
      console.log(dim(`      still ${result.digest}  (${where})`));
    } else if (result.state === 'drifted') {
      console.log(`${yellow('  !')} ${result.name}:${result.tag} ${bold('has been rebuilt upstream')}`);
      console.log(dim(`      pinned  ${result.digest}`));
      console.log(dim(`      now     ${result.current}`));
      console.log(dim(`      at      ${where}`));
    } else {
      console.log(
        `${yellow('  !')} ${result.name}${result.tag === null ? '' : `:${result.tag}`} not checked`,
      );
      console.log(dim(`      ${result.why}  (${where})`));
    }
  }

  const drifted = results.filter((r) => r.state === 'drifted');
  const unresolved = results.filter((r) => r.state === 'unresolved');
  console.log(bold('\nSummary'));
  console.log(`  pinned references  ${results.length}`);
  console.log(`  still current      ${results.length - drifted.length - unresolved.length}`);
  console.log(`  drifted            ${drifted.length === 0 ? green('0') : yellow(String(drifted.length))}`);
  console.log(`  not checked        ${unresolved.length}`);
  console.log(
    drifted.length === 0
      ? green(bold('\nNo drift: every pinned tag still resolves to the digest beside it.\n'))
      : yellow(bold(`\n${drifted.length} pinned tag(s) now resolve elsewhere.\n`)),
  );
  console.log(
    dim(
      '  This is a REPORT, not a gate: it exits 0 whatever it finds. Drift is usually a base-OS\n' +
        '  security rebuild and is a reason to refresh the digest in a reviewed diff — which is the\n' +
        '  point of pinning. Failing the build on it would make every offline run red and would put\n' +
        '  a network call in the middle of a hermetic gate.\n' +
        '\n' +
        '  It also proves nothing about the CONTENT of the new image. A moved digest says the bytes\n' +
        '  changed, not that they are safe; review the upstream release notes before repinning.\n',
    ),
  );
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((arg) => arg !== '--' && arg !== '--freshness' && arg !== '--json');
  if (unknown.length > 0) {
    console.error(red(`ci-pinning — unknown option ${unknown[0]} (try --freshness or no arguments)`));
    process.exit(1);
  }
  if (argv.includes('--freshness')) await runFreshnessReport(argv.includes('--json'));
  else await runCiPinningGate();
}
