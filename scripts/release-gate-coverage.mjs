#!/usr/bin/env node
/**
 * Gate: the release pipeline actually runs the release gate.
 *
 * ## The hole this closes
 *
 * `pnpm run verify` is *defined* as the release gate — fourteen named gates, run
 * one after another, every one of them after a failure so a run reports all of
 * them rather than the first. `docs/production/go-live.md` says a release is a
 * commit that passed it.
 *
 * `.github/workflows/release.yml` did not run it. Its `tests` job ran
 * `pnpm run test`, which is `test:unit && test:integration && test:scripts`.
 * Measured with this parser against the workflow as it stood, EIGHT of the
 * fourteen ran nowhere in the release pipeline:
 *
 *     security:hygiene  design:contrast  test:a11y  test:ax
 *     test:csp          test:age-gate    test:exhaustive  test:simulation
 *
 * So a commit that fails the contrast budget, ships an inaccessible control,
 * loses the CSP negative control or breaks the age gate — a LEGAL control — was
 * built into an immutable artefact, scanned, staged and offered for signing, and
 * the release pipeline was green throughout. `ci.yml` would have gone red in a
 * different workflow, which is a thing a person has to notice.
 *
 * ## Why a guard and not just a fix
 *
 * The eight were not omitted on purpose. They accumulated: each gate was added to
 * `verify` and wired into `ci.yml`, and `release.yml` — a separate file, with a
 * separate job graph — was not touched. `ci.yml` already carries the scar of the
 * same drift in a header comment: `test:ax` was one of the fourteen gates for
 * some time while `grep -n 'test:ax' .github/workflows/*.yml` matched nothing.
 *
 * Fixing the eight without a guard buys silence until the fifteenth gate is
 * written. This reads BOTH lists — the `for gate in ...` clause in the `verify`
 * script, and the workflow's job graph — and fails when they disagree, so adding
 * a gate is a two-file change by construction.
 *
 * ## What "runs it" means here, and why the needs-graph matters
 *
 * A gate running in a job that sits BESIDE `build` is not enough. The workflow
 * would go red, but the artefact is built, scanned and pushed through staging
 * regardless, and `release-sign.yml` signs a digest from the manifest. The
 * invariant worth having is stronger: no artefact exists unless every gate has
 * already passed. So a gate counts only when it runs in the artefact-producing
 * job or in a job that job transitively `needs`.
 *
 * `pnpm run verify` in a job counts as running all of them, which is the shape a
 * pipeline that simply calls the gate should be allowed to take.
 *
 * Comment lines are stripped before the search, because this whole file is full
 * of gate names and a parser that reads prose finds whatever it hopes to find —
 * a mistake made twice on this branch already.
 *
 * Run with:  node scripts/release-gate-coverage.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The job whose output is an immutable artefact. Everything must pass before it. */
export const ARTEFACT_JOB = 'build';

/**
 * The gate list, read from the `verify` script rather than copied.
 *
 * A copy is a third list to forget. `verify` is a shell loop whose gates are the
 * words in its `for gate in ... ; do` clause, so that clause IS the list.
 */
export function gatesInVerify(packageJson) {
  const verify = packageJson?.scripts?.verify;
  if (typeof verify !== 'string') throw new Error('package.json has no `verify` script to read gates from');
  const clause = /for\s+gate\s+in\s+([^;]+);\s*do/u.exec(verify);
  if (clause === null) {
    throw new Error(
      'the `verify` script no longer has a `for gate in ...; do` clause, so this gate cannot read ' +
        'the gate list. It was rewritten in a shape this parser does not know — teach it the new ' +
        'shape rather than deleting the check, or the coverage claim becomes unfounded.',
    );
  }
  const gates = clause[1].trim().split(/\s+/u).filter(Boolean);
  if (gates.length === 0) throw new Error('parsed an EMPTY gate list out of `verify`');
  return gates;
}

/**
 * Jobs, their `needs`, and their non-comment body text.
 *
 * A hand-rolled parser rather than a YAML dependency: the repository has none,
 * adding one to the supply chain to read its own workflow is a poor trade, and
 * `ci-pinning.mjs` already reads these files by line. The shapes accepted are the
 * three GitHub allows for `needs` — a scalar, a flow sequence, and a block
 * sequence — and `assertParserSawTheFile` below refuses a parse that found
 * nothing, so a workflow written in a shape this does not understand fails loudly
 * instead of reporting universal coverage over zero jobs.
 */
function unquote(value) {
  return value.trim().replace(/^["']|["']$/gu, '');
}

export function parseWorkflow(text) {
  const lines = text.split('\n');
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  if (jobsAt === -1) throw new Error('no top-level `jobs:` key; this is not a workflow this gate can read');

  const jobs = new Map();
  let current = null;
  for (const raw of lines.slice(jobsAt + 1)) {
    const header = /^ {2}([A-Za-z][\w-]*):\s*$/u.exec(raw);
    if (header !== null) {
      current = { id: header[1], needs: [], body: [] };
      jobs.set(current.id, current);
      continue;
    }
    if (current === null) continue;
    if (/^\S/u.test(raw) && raw.trim() !== '') break; // left the `jobs:` block entirely
    if (/^\s*#/u.test(raw)) continue; // a comment is not a command
    current.body.push(raw);

    // `.*?`, not `.+?`. A bare `needs:` introducing a block sequence has NOTHING
    // after the colon, so a one-or-more match never saw it, `needsBlockOpen` was
    // never set, and every job that used that spelling was read as depending on
    // nothing. The gating set then shrinks silently, which reports gates as
    // uncovered — or, with the dependency pointing the other way, as covered.
    const declaration = /^ {4}needs:\s*(.*?)\s*$/u.exec(raw);
    if (declaration !== null) {
      const value = declaration[1];
      const flow = /^\[(.*)\]$/u.exec(value);
      if (flow !== null) {
        current.needs.push(...flow[1].split(',').map(unquote).filter(Boolean));
        current.needsBlockOpen = false;
      } else if (value === '') {
        current.needsBlockOpen = true;
      } else {
        current.needs.push(unquote(value));
        current.needsBlockOpen = false;
      }
      continue;
    }
    if (current.needsBlockOpen === true) {
      const item = /^ {6}-\s*(.+?)\s*$/u.exec(raw);
      if (item !== null) {
        current.needs.push(unquote(item[1]));
        continue;
      }
      current.needsBlockOpen = false;
    }
  }
  return jobs;
}

/** Every job `id` transitively depends on, plus `id` itself. */
export function withAncestors(jobs, id) {
  const seen = new Set();
  const stack = [id];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    for (const parent of jobs.get(next)?.needs ?? []) stack.push(parent);
  }
  return seen;
}

/**
 * Does this text run `pnpm run <gate>`?
 *
 * The trailing guard is what stops `pnpm run test` matching inside
 * `pnpm run test:a11y`. Without it every `test:*` gate would be reported as
 * covered by the one `pnpm run test` step, which is precisely the false pass this
 * file exists to prevent — and is how the parser behaved when first written.
 */
export function runsGate(text, gate) {
  const escaped = gate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(String.raw`pnpm run ${escaped}(?![\w:-])`, 'u').test(text);
}

export function coverage(jobs, gates, sink = ARTEFACT_JOB) {
  if (!jobs.has(sink)) {
    throw new Error(
      `the workflow has no \`${sink}\` job, so this gate cannot tell which jobs run before an ` +
        'artefact exists. Rename the check or the job — do not leave it reporting on nothing.',
    );
  }
  const gating = withAncestors(jobs, sink);
  const text = [...gating].map((id) => (jobs.get(id)?.body ?? []).join('\n')).join('\n');
  const runsVerifyWholesale = runsGate(text, 'verify');
  return {
    gating: [...gating].sort(),
    covered: gates.filter((gate) => runsVerifyWholesale || runsGate(text, gate)),
    missing: gates.filter((gate) => !runsVerifyWholesale && !runsGate(text, gate)),
  };
}

/** A sweep of nothing is not a pass. */
export function assertParserSawTheFile(jobs, label) {
  if (jobs.size < 2) {
    throw new Error(
      `${label}: parsed ${jobs.size} job(s). A workflow with fewer than two jobs is not one this ` +
        'repository has; the parser has stopped understanding the file and every coverage claim ' +
        'below it would be vacuous.',
    );
  }
}

function main() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const gates = gatesInVerify(pkg);
  const problems = [];

  const releasePath = join(REPO_ROOT, '.github', 'workflows', 'release.yml');
  const release = parseWorkflow(readFileSync(releasePath, 'utf8'));
  assertParserSawTheFile(release, 'release.yml');
  const released = coverage(release, gates);

  console.log(`verify declares ${gates.length} gates: ${gates.join(' ')}`);
  console.log(
    `release.yml: ${released.gating.length} job(s) run before an artefact exists ` +
      `(${released.gating.join(', ')})`,
  );
  console.log(`  covered: ${released.covered.length}/${gates.length}`);
  if (released.missing.length > 0) {
    problems.push(
      `release.yml builds an immutable artefact without running ${released.missing.length} of the ` +
        `${gates.length} gates in \`pnpm run verify\`: ${released.missing.join(', ')}. ` +
        `Add them to a job that \`${ARTEFACT_JOB}\` transitively needs — beside it is not enough, ` +
        'because the artefact is still built, scanned, staged and offered for signing when a ' +
        'parallel job goes red.',
    );
  }

  // The weaker claim, for the pull-request workflow: a gate must run SOMEWHERE in
  // ci.yml. `test:ax` was in `verify` while matching nothing in any workflow, and
  // nothing noticed; this is the check that would have.
  const ciPath = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
  const ci = parseWorkflow(readFileSync(ciPath, 'utf8'));
  assertParserSawTheFile(ci, 'ci.yml');
  const ciText = [...ci.values()].map((job) => job.body.join('\n')).join('\n');
  const ciMissing = runsGate(ciText, 'verify') ? [] : gates.filter((gate) => !runsGate(ciText, gate));
  console.log(`ci.yml:      covered ${gates.length - ciMissing.length}/${gates.length}`);
  if (ciMissing.length > 0) {
    problems.push(
      `ci.yml runs none of these gates in any job: ${ciMissing.join(', ')}. A gate no workflow ` +
        'runs is a gate only developers who type `pnpm run verify` will ever see fail.',
    );
  }

  if (problems.length > 0) {
    console.error('');
    for (const problem of problems) console.error(`FAIL: ${problem}\n`);
    process.exit(1);
  }
  console.log('\nevery gate in `verify` runs before an artefact exists, and again in ci.yml.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
