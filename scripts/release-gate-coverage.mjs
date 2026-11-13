#!/usr/bin/env node
/**
 * Gate: the release pipeline runs every gate in `pnpm run verify`.
 * It reads the `for gate in ...` clause of `verify` and fails when a gate does not run in release.yml's
 * artefact job or a job it transitively `needs`, or nowhere in ci.yml. Gates drifted out of
 * release.yml before (eight of fourteen once ran nowhere in it), so adding a gate is a three-file change.
 * Comment lines are stripped before the search, because prose full of gate names matches anything.
 *
 * Run with:  node scripts/release-gate-coverage.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ARTEFACT_JOB = 'build';

// The `for gate in ... ; do` clause is the list, so it is read rather than copied.
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

// A hand-rolled parser, to avoid a YAML dependency. It accepts the three `needs` shapes GitHub
// allows, and `assertParserSawTheFile` refuses a parse that found no jobs.
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

    // `.*?`, not `.+?`. A bare `needs:` opening a block sequence has nothing after the colon.
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

// The trailing guard stops `pnpm run test` matching inside `pnpm run test:a11y`.
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

  // The weaker claim for the pull-request workflow: every gate runs somewhere in ci.yml.
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
