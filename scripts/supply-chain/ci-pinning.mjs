#!/usr/bin/env node
/**
 * Gate: the pipeline's own dependencies are pinned to immutable references. An unpinned `uses:`,
 * an unpinned `FROM` or compose `image:`, a floating `runs-on: *-latest`, or a workflow not in
 * `EXPECTED_WORKFLOWS` fails the release, like an unpinned npm dependency. A mutable tag is a
 * pointer its owner can repoint at new code (docs/security/shai-hulud-snapshot-2026-08-17.md §1).
 *
 * A reference this gate cannot read is a failure, never a pass. Discovery is recursive and knows
 * Compose v2 names, `runs-on` is read in all five spellings GitHub accepts, a key in YAML flow style
 * is refused, and local `action.yml` files are read too. Each of those was once a green tick over
 * nothing; `ci-pinning.test.mjs` pins every case.
 *
 * `--freshness` re-resolves pinned tags and reports drift. It always exits 0, because failing on an
 * upstream rebuild would make every offline run red.
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
const IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/;

/**
 * A compose value that is only a required interpolation with no default, `${VAR:?message}`. This
 * is the one non-digest `image:` accepted, for `docker-compose.staging.yml`, whose digests come per
 * build from `release:artifacts`. `${VAR:-tag}` commits a mutable default and `${VAR}` constrains
 * nothing, so both fail. `scripts/staging.mjs` checks the injected value is a digest.
 */
const REQUIRED_INTERPOLATION = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?\?[^}]*\}$/;

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

/** `Dockerfile`, `Dockerfile.api`, and the suffix form `api.Dockerfile`. */
const DOCKERFILE_NAME = /^(?:Dockerfile(?:\..+)?|.+\.Dockerfile)$/;
/** Compose v1 `docker-compose*.yml` and Compose v2 `compose*.yaml`. */
const COMPOSE_NAME = /^(?:docker-)?compose(\..+)?\.ya?ml$/;

/** Strips YAML/Dockerfile comments. ci.yml's header quotes an unpinned `uses:` as an example. */
function uncomment(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#')) return '';
  const hash = line.indexOf(' #');
  return hash === -1 ? line : line.slice(0, hash);
}

export function listWorkflowFiles(workflowDir) {
  if (!existsSync(workflowDir)) return [];
  return readdirSync(workflowDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * Every local `action.yml`/`action.yaml`. Without this a composite action was a two-hop bypass,
 * since `./...` passes in a workflow and the action file was never read. There are none today, so
 * there is no minimum.
 *
 * @param {string} root
 * @returns {string[]} repo-relative paths
 */
export function discoverLocalActionFiles(root) {
  const found = [];
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
      if (entry.isFile() && /^action\.ya?ml$/.test(entry.name)) {
        found.push(relative(root, full).split('\\').join('/'));
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
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

/** The rest of the line, because `${PRL_API_IMAGE:?message}` contains spaces. */
function imageValue(line) {
  const match = /^\s*image:\s*(.+?)\s*$/.exec(line);
  if (match === null) return null;
  return unquote(match[1] ?? '');
}

/**
 * The job-level `container: node:22` shorthand. It was never judged before, and a job container is
 * where every step runs. Returns null for the map form, which `imageValue` covers.
 */
function containerValue(line) {
  const match = /^\s*container:\s*(.+?)\s*$/.exec(line);
  if (match === null) return null;
  const value = unquote(match[1] ?? '');
  return value === '' ? null : value;
}

function unquote(value) {
  const v = value.trim();
  const quoted =
    v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")));
  return quoted ? v.slice(1, -1) : v;
}

function scalarOrFlowSequence(value) {
  const v = value.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map(unquote)
      .filter((s) => s !== '');
  }
  const single = unquote(v);
  return single === '' ? [] : [single];
}

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Every scalar under a `matrix:` block, by key, so `${{ matrix.os }}` resolves. It over-collects
 * (no job tracking, `include:` folded in), which can only make the gate judge more labels.
 *
 * @returns {Map<string, Set<string>>}
 */
export function matrixValues(text) {
  /** @type {Map<string, Set<string>>} */
  const values = new Map();
  const add = (key, list) => {
    const bag = values.get(key) ?? new Set();
    for (const value of list) if (value !== '') bag.add(value);
    values.set(key, bag);
  };
  const lines = text.split('\n').map(uncomment);
  for (const [index, line] of lines.entries()) {
    const header = /^(\s*)matrix:\s*$/.exec(line);
    if (header === null) continue;
    const baseIndent = (header[1] ?? '').length;
    let currentKey = null;
    for (let j = index + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (raw.trim() === '') continue;
      if (indentOf(raw) <= baseIndent) break;
      const body = raw.trim();
      const item = /^-\s*(.*)$/.exec(body);
      if (item !== null) {
        const rest = (item[1] ?? '').trim();
        const inlinePair = /^([A-Za-z_][\w.-]*):\s*(.+)$/.exec(rest);
        if (inlinePair !== null) add(inlinePair[1] ?? '', scalarOrFlowSequence(inlinePair[2] ?? ''));
        else if (currentKey !== null) add(currentKey, [unquote(rest)]);
        continue;
      }
      const pair = /^([A-Za-z_][\w.-]*):\s*(.*)$/.exec(body);
      if (pair === null) continue;
      currentKey = pair[1] ?? null;
      const inline = (pair[2] ?? '').trim();
      if (currentKey !== null && inline !== '') add(currentKey, scalarOrFlowSequence(inline));
    }
  }
  return values;
}

/**
 * Every `runs-on`, as concrete labels plus deferred `${{ ... }}` expressions. Handles a plain or
 * quoted scalar, a flow sequence, a block sequence, and a runner-group mapping whose `labels:` names
 * the image. A bare-scalar-only regex passes five of six spellings.
 *
 * @returns {Array<{line: number, labels: string[], expressions: string[]}>}
 */
export function parseRunsOn(text) {
  const lines = text.split('\n').map(uncomment);
  const found = [];
  for (const [index, line] of lines.entries()) {
    const head = /^(\s*)runs-on:\s*(.*)$/.exec(line);
    if (head === null) continue;
    const baseIndent = (head[1] ?? '').length;
    const inline = (head[2] ?? '').trim();
    let labels;
    if (inline !== '') {
      labels = scalarOrFlowSequence(inline);
    } else {
      const sequence = [];
      const labelled = [];
      let collect = sequence;
      for (let j = index + 1; j < lines.length; j++) {
        const raw = lines[j];
        if (raw.trim() === '') continue;
        if (indentOf(raw) <= baseIndent) break;
        const body = raw.trim();
        const item = /^-\s*(.*)$/.exec(body);
        if (item !== null) {
          const value = unquote(item[1] ?? '');
          if (value !== '') collect.push(value);
          continue;
        }
        const pair = /^([A-Za-z_][\w.-]*):\s*(.*)$/.exec(body);
        if (pair === null) continue;
        const value = (pair[2] ?? '').trim();
        if (pair[1] === 'labels') {
          if (value === '') collect = labelled;
          else labelled.push(...scalarOrFlowSequence(value));
          continue;
        }
        collect = sequence;
      }
      labels = labelled.length > 0 ? labelled : sequence;
    }
    found.push({
      line: index + 1,
      labels: labels.filter((l) => !l.includes('${{')),
      expressions: labels.filter((l) => l.includes('${{')),
    });
  }
  return found;
}

/**
 * One string per matrix combination. A result still containing `${{` could not be resolved from the
 * file, and the caller must fail it.
 */
function expandMatrixExpression(expression, matrix) {
  let current = [expression];
  // Bounded, since this loops over untrusted text.
  for (let pass = 0; pass < 4; pass++) {
    if (!current.some((s) => s.includes('${{'))) break;
    const next = [];
    for (const candidate of current) {
      const match = /\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/.exec(candidate);
      const bag = match === null ? undefined : matrix.get(match[1] ?? '');
      if (match === null || bag === undefined || bag.size === 0) {
        next.push(candidate);
        continue;
      }
      for (const value of bag) {
        next.push(candidate.slice(0, match.index) + value + candidate.slice(match.index + match[0].length));
      }
    }
    current = next;
  }
  return current;
}

/**
 * @param {Gate} gate
 * @param {string} label
 * @param {string} text
 * @returns {number} how many `runs-on` declarations were judged
 */
export function checkRunnerPinning(gate, label, text) {
  const matrix = matrixValues(text);
  const declarations = parseRunsOn(text);
  for (const declaration of declarations) {
    const at = `${label}:${declaration.line}`;
    const runners = [...declaration.labels];
    let unresolved = 0;
    for (const expression of declaration.expressions) {
      for (const expanded of expandMatrixExpression(expression, matrix)) {
        if (expanded.includes('${{')) {
          unresolved += 1;
          gate.fail(
            `runs-on cannot be resolved to a runner label at ${at}: ${expanded}`,
            'this gate refuses to call a runner pinned when it could not read which runner it is. ' +
              'The expression names something outside this file (an input, a repository variable, a ' +
              'matrix key defined elsewhere), so "ubuntu-latest" and "ubuntu-24.04" are indistinguishable ' +
              "from here. Name the runner literally, or put the value in this workflow's matrix.",
          );
          continue;
        }
        runners.push(expanded);
      }
    }
    // An unresolved expression has already failed above.
    if (runners.length === 0 && unresolved === 0) {
      gate.fail(
        `runs-on names no runner label at ${at}`,
        'the gate parsed this runs-on and came away with nothing to judge — a runner-group mapping with ' +
          'no `labels:` key, or a form this parser does not read. Either is an unjudged runner, which is ' +
          'the exact failure this check was rewritten to stop reporting as a pass.',
      );
      continue;
    }
    for (const runner of runners) {
      if (!runner.endsWith('-latest')) continue;
      gate.fail(
        `floating runner image at ${at}: ${runner}`,
        'pin the runner version (e.g. ubuntu-24.04) so a runner-image rollout is a reviewed change ' +
          'rather than an overnight one',
      );
    }
  }
  return declarations.length;
}

/** The four judged keys anywhere on a line. `[\s{,[]`, not `-`, so `Base-image` is not a key. */
const READ_KEY_MENTION = /(?:^|[\s{,[])(uses|runs-on|image|container)\s*:/g;

/** Whether the `^\s*`-anchored reader for `key` reads this line. `uses` needs its value on the line. */
function readsKeyOnLine(key, line) {
  if (key === 'uses') return /^\s*-?\s*uses:\s*\S/.test(line);
  if (key === 'runs-on') return /^\s*runs-on:/.test(line);
  if (key === 'image') return /^\s*image:/.test(line);
  return /^\s*container:/.test(line);
}

/**
 * Fails a line that carries one of the four keys in a shape the anchored readers cannot see, such
 * as `- {uses: x@v7}` or `- uses:` with the value on the next line. Each of those would pass with
 * 0 references judged. The remedy is block style, which every workflow here uses.
 *
 * @param {Gate} gate
 * @param {string} line  already passed through `uncomment`
 * @param {string} at   `<file>:<line>`, which already carries the file name
 */
function checkNothingWasUnread(gate, line, at) {
  READ_KEY_MENTION.lastIndex = 0;
  const seen = new Map();
  for (const match of line.matchAll(READ_KEY_MENTION)) {
    const key = match[1] ?? '';
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, mentions] of seen) {
    const read = readsKeyOnLine(key, line) ? 1 : 0;
    if (mentions <= read) continue;
    gate.fail(
      `a \`${key}:\` at ${at} is in a shape this gate cannot read: ${line.trim()}`,
      'the readers in ci-pinning.mjs are anchored at the start of a line, so a key written in a YAML ' +
        'FLOW mapping (`- {uses: …}`, `[{image: …}]`) or with its value on the following line is never ' +
        'judged at all — and an unjudged reference used to print a green tick. Write it in block style, ' +
        'one key per line, which is what every workflow in this repository already does.',
    );
  }
}

/**
 * @param {Gate} gate
 * @param {string} label  how to name this file in a message
 * @param {string} text
 * @returns {number} how many `uses:` references were judged
 */
export function checkWorkflowPinning(gate, label, text) {
  let judged = 0;
  checkRunnerPinning(gate, label, text);
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = uncomment(rawLine);
    const at = `${label}:${index + 1}`;
    checkNothingWasUnread(gate, line, at);

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

    const container = containerValue(line);
    if (container !== null && !IMAGE_DIGEST.test(container)) {
      gate.fail(
        `job container is not digest-pinned at ${at}: ${container}`,
        'this is the image every step in the job runs inside; a tag is a pointer its publisher can ' +
          'repoint. Pin image:tag@sha256:<64 hex> with the tag kept in a comment.',
      );
      continue;
    }

    const image = imageValue(line);
    if (image !== null && !IMAGE_DIGEST.test(image)) {
      // Workflows are not compose-interpolated, so the required-interpolation exception does not apply.
      gate.fail(
        `service container is not digest-pinned at ${at}: ${image}`,
        'a tag is mutable; pin image:tag@sha256:<64 hex> with the tag kept in a comment',
      );
    }
  }
  return judged;
}

/**
 * Every `FROM` refers to an earlier stage or carries a digest. A stage is registered after the
 * test, because `FROM node AS node` would match itself and pass an unpinned image.
 *
 * The first `FROM` can never be a stage reference, so `FROM` lines with zero external images judged
 * is a failure.
 *
 * @param {Gate} gate
 * @param {string} label
 * @param {string} text
 * @returns {number} how many external base images were judged
 */
export function checkDockerfilePinning(gate, label, text) {
  const stages = new Set();
  let judged = 0;
  let fromLines = 0;
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = uncomment(rawLine);
    const from = /^\s*FROM\s+(.+)$/i.exec(line);
    if (!from) continue;
    fromLines += 1;
    const at = `${label}:${index + 1}`;
    const parts = (from[1] ?? '').trim().split(/\s+/);
    const words = parts.filter((p) => !p.startsWith('--'));
    const image = words[0] ?? '';
    const asIndex = words.findIndex((w) => w.toLowerCase() === 'as');
    const stage = asIndex === -1 ? undefined : words[asIndex + 1];
    const declareStage = () => {
      if (stage !== undefined) stages.add(stage);
    };

    if (image === '') {
      gate.fail(
        `FROM names no image at ${at}: ${(from[1] ?? '').trim()}`,
        'the gate could not read a base image from this line, and a line it cannot read is not a line ' +
          'it has cleared',
      );
      declareStage();
      continue;
    }
    if (stages.has(image)) {
      declareStage();
      continue;
    }
    judged += 1;
    declareStage();
    if (!IMAGE_DIGEST.test(image)) {
      gate.fail(
        `base image is not digest-pinned at ${at}: ${image}`,
        'a tag can be repointed at a new image after review; pin image:tag@sha256:<64 hex> and keep ' +
          'the human-readable tag in a comment above it',
      );
    }
  }

  if (fromLines === 0) {
    gate.fail(
      `no FROM instruction in ${label}`,
      'this file was discovered as a Dockerfile and the base-image check found nothing in it to judge. ' +
        'A scan of nothing proves nothing.',
    );
  } else if (judged === 0) {
    gate.fail(
      `${label} declares ${fromLines} FROM line(s) and no external base image`,
      'impossible in a real Dockerfile: the first FROM cannot reference a stage because none has been ' +
        'declared yet. This is what `FROM <image> AS <image>` looked like — every FROM absorbed as an ' +
        'internal stage reference and nothing judged at all.',
    );
  }
  return judged;
}

/**
 * Every compose `image:` carries a digest or is a required interpolation. Services built from a
 * local Dockerfile have no `image:` and are covered by the Dockerfile check.
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
 * Every Dockerfile and compose file, recursively. Exported so the tests use the gate's own walk.
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

/**
 * Every `uses:` reference, one per occurrence, with its trailing `# v7.0.1` comment. Exported for
 * `action-advisories.mjs` so both gates read the same set. The comment is a claim that gate checks,
 * never the version.
 *
 * @param {string} root
 * @returns {Array<{reference: string, comment: string|null, at: string, line: string}>}
 */
export function collectActionReferences(root) {
  const found = [];
  const readFile = (rel) => {
    for (const [index, rawLine] of readFileSync(join(root, rel), 'utf8').split('\n').entries()) {
      const line = uncomment(rawLine);
      const uses = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
      if (uses === null) continue;
      const trailing = /\s#\s*(.+?)\s*$/.exec(rawLine);
      found.push({
        reference: uses[1] ?? '',
        comment: trailing === null ? null : (trailing[1] ?? null),
        at: `${rel}:${index + 1}`,
        line: rawLine.trim(),
      });
    }
  };

  const workflowDir = join(root, '.github', 'workflows');
  for (const name of listWorkflowFiles(workflowDir)) readFile(`.github/workflows/${name}`);
  for (const rel of discoverLocalActionFiles(root)) readFile(rel);
  return found;
}

export function runCiPinningGate() {
  const gate = new Gate('ci-and-container-pinning');
  return runGate(gate, () => {
    const workflowDir = join(REPO_ROOT, '.github', 'workflows');
    const workflows = listWorkflowFiles(workflowDir);
    checkWorkflowInventory(gate, workflows);

    let actionRefs = 0;
    let runners = 0;
    for (const name of workflows) {
      const path = join(workflowDir, name);
      const text = readFileSync(path, 'utf8');
      actionRefs += checkWorkflowPinning(gate, relative(REPO_ROOT, path), text);
      // Counted for the note, so a parser that stops matching shows up.
      runners += parseRunsOn(text).length;
    }

    const localActions = discoverLocalActionFiles(REPO_ROOT);
    for (const name of localActions) {
      actionRefs += checkWorkflowPinning(gate, name, readFileSync(join(REPO_ROOT, name), 'utf8'));
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
      `${workflows.length} workflow(s) and ${localActions.length} local action file(s), ` +
        `${actionRefs} action reference(s), ${runners} runs-on ` +
        `declaration(s), ${dockerfiles.length} Dockerfile(s) with ${baseImages} external base image(s), ` +
        `${composeFiles.length} compose file(s) with ${composeImages} image reference(s)`,
    );
  });
}

/**
 * Splits `registry/name:tag@sha256:...`. A colon introduces a tag only if no `/` follows it, so a
 * registry port is not read as a tag.
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

/** Every digest-pinned image reference, found through the gate's own discovery. */
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

  const byReference = new Map();
  for (const entry of found) {
    const existing = byReference.get(entry.reference);
    if (existing === undefined) byReference.set(entry.reference, { ...entry, at: [entry.at] });
    else existing.at.push(entry.at);
  }
  return [...byReference.values()];
}

/**
 * The digest a Docker Hub tag points at now. Other registries are reported unchecked. The `Accept`
 * headers make a multi-arch tag resolve to its index digest, not one platform's manifest.
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

/** @param {boolean} asJson */
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
