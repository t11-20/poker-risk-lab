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
 * The checks are pure functions over file text so
 * `scripts/supply-chain/ci-pinning.test.mjs` can feed them the real attacks.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EXPECTED_WORKFLOWS } from './denied-packages.mjs';
import { Gate, REPO_ROOT, runGate } from './lib.mjs';

/** A full git commit SHA. Anything shorter is ambiguous and anything else is a moving pointer. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;
/** An OCI content digest. */
const IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/;

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

    const image = /^\s*image:\s*(\S+)/.exec(line);
    if (image) {
      const reference = image[1] ?? '';
      if (!IMAGE_DIGEST.test(reference)) {
        gate.fail(
          `service container is not digest-pinned at ${at}: ${reference}`,
          'a tag is mutable; pin image:tag@sha256:<64 hex> with the tag kept in a comment',
        );
      }
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
 * Check: every `image:` in a compose file carries a digest. Services built from
 * a local Dockerfile have no `image:` and are covered by the Dockerfile check.
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
    const image = /^\s*image:\s*(\S+)/.exec(line);
    if (!image) continue;
    judged += 1;
    const reference = image[1] ?? '';
    if (!IMAGE_DIGEST.test(reference)) {
      gate.fail(
        `compose image is not digest-pinned at ${label}:${index + 1}: ${reference}`,
        'pin image:tag@sha256:<64 hex>; a tag is mutable and this is the artefact that ships',
      );
    }
  }
  return judged;
}

/** Root-level files the pinning rules apply to, in the order they are reported. */
function containerFiles() {
  const names = readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  return {
    dockerfiles: names.filter((n) => /^Dockerfile(\..+)?$/.test(n)).sort(),
    composeFiles: names.filter((n) => /^docker-compose(\..+)?\.ya?ml$/.test(n)).sort(),
  };
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

    const { dockerfiles, composeFiles } = containerFiles();
    if (dockerfiles.length === 0) {
      gate.fail('no Dockerfile found', 'the base-image pinning check examined nothing');
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

if (import.meta.main) await runCiPinningGate();
