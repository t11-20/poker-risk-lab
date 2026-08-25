#!/usr/bin/env node
/**
 * Runs every supply-chain gate and aggregates the result.
 *
 * Each gate runs as its own child process so that one crashing gate cannot
 * prevent the others from reporting, and so that a gate can never accidentally
 * mutate shared state to make a later gate pass.
 *
 * Exit code 0 only if every gate ran AND every gate exited 0. This is the
 * release gate.
 *
 * ## `--offline` does not exit 0
 *
 * It used to. The summary said "2 network gate(s) skipped — NOT a valid release
 * audit" and then exited 0, so the honest sentence was addressed to a human while
 * the dishonest number was addressed to every script. `quarantine.mjs` consumed
 * that exit code and reported success after checking a brand-new lockfile with
 * six of eight gates. An audit that did not run its gates is not a passed audit;
 * the exit code now says the same thing the prose does.
 *
 * ## The container-image gate has a scope the others do not
 *
 * Every other gate reads the repository: the lockfile, the installed store, the
 * workflow files. They can run on any checkout at any time. `container-scan.mjs`
 * reads the two Docker IMAGES, which exist only after `pnpm run release:artifacts`
 * has built them, and this audit is invoked long before that — by
 * `.github/workflows/ci.yml` on every push, by `pnpm run verify`, and by
 * `quarantine.mjs` against a proposed lockfile. There is no honest way for a
 * commit-time audit to scan an artefact that does not exist yet.
 *
 * So it runs when it CAN, and the three states are kept distinct rather than
 * collapsed into a green tick:
 *
 *   * **Artefacts present** (a release manifest whose digests still resolve): the
 *     gate runs, and a blocking finding fails the audit like any other.
 *   * **No artefacts on this machine**: reported as `not applicable`, and the
 *     Summary says in as many words that this audit did NOT cover container
 *     images. Exit code unchanged — the audit's own scope, the dependency graph
 *     at this commit, was covered completely, and it says exactly what it did.
 *   * **`--skip-containers` with artefacts present**: an explicit refusal to run a
 *     gate that could have run, which exits **2**, the same "incomplete" code
 *     `--offline` uses. A flag is the only way to skip a runnable gate, and using
 *     it is never a pass.
 *
 * The release path does not rely on that inference: `.github/workflows/release.yml`
 * builds the artefacts and then runs `pnpm run security:containers` as a step of
 * its own, so the scan on the path that ships is mandatory and visible by name.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, dim, green, red, yellow } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

/**
 * `network: true` gates reach the internet and are skipped by `--offline`.
 * `artefact: true` gates need a built release image; see the header.
 */
const GATES = [
  { file: 'policy-check.mjs', label: 'policy in effect', network: false },
  { file: 'repo-hygiene.mjs', label: 'source encoding hygiene', network: false },
  { file: 'deny-list.mjs', label: 'denied packages', network: false },
  { file: 'dep-shapes.mjs', label: 'dependency shapes', network: false },
  { file: 'ioc-scan.mjs', label: 'Shai-Hulud IOC sweep', network: false },
  // The working tree only. `--history` is opt-in and is not run here; see that
  // file's header for why a gate whose only remedy is a history rewrite must not
  // be able to turn the release audit permanently red.
  { file: 'secret-scan.mjs', label: 'committed credentials', network: false },
  { file: 'ci-pinning.mjs', label: 'CI + container pinning', network: false },
  { file: 'provenance.mjs', label: 'integrity + release age', network: true },
  { file: 'osv-scan.mjs', label: 'OSV vulnerabilities', network: true },
  { file: 'sbom.mjs', label: 'SBOM generation', network: false },
  { file: 'container-scan.mjs', label: 'container image CVEs', network: true, artefact: true },
];

/** Where `release-artifacts.mjs` writes, and therefore where this looks. */
const RELEASE_MANIFEST = join(REPO_ROOT, 'deploy', 'staging', 'release-manifest.json');

/**
 * Are the release images actually here?
 *
 * "The manifest exists" is not enough: a manifest whose images have since been
 * pruned describes artefacts nothing can scan, and running the gate against them
 * would fail for a reason that has nothing to do with vulnerabilities. Both the
 * record and the images have to be present for the scan to mean anything.
 */
function releaseArtefactsPresent() {
  if (!existsSync(RELEASE_MANIFEST)) return { present: false, why: 'no release manifest on this machine' };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(RELEASE_MANIFEST, 'utf8'));
  } catch {
    return { present: false, why: 'the release manifest is unreadable' };
  }
  const references = Object.values(manifest?.images ?? {})
    .map((image) => image?.reference)
    .filter((reference) => typeof reference === 'string');
  if (references.length === 0) return { present: false, why: 'the release manifest names no images' };
  for (const reference of references) {
    const probe = spawnSync('docker', ['image', 'inspect', reference, '--format', '{{.Id}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (probe.status !== 0) {
      return { present: false, why: `${reference} is in the manifest but not on this machine` };
    }
  }
  return { present: true, why: `${references.length} release image(s) present` };
}

const offline = process.argv.includes('--offline');
const skipContainers = process.argv.includes('--skip-containers');
const results = [];

const artefacts = releaseArtefactsPresent();

console.log(bold('\nPoker Risk Lab — supply-chain audit'));
console.log(dim(`  ${GATES.length} gates${offline ? ' (offline: network gates skipped)' : ''}\n`));

for (const gate of GATES) {
  if (offline && gate.network) {
    console.log(`${dim('  ○')} ${gate.label} ${dim('— skipped (--offline)')}`);
    results.push({ ...gate, skipped: true, notApplicable: false, code: 0 });
    continue;
  }
  if (gate.artefact === true && !artefacts.present) {
    console.log(`${dim('  ○')} ${gate.label} ${dim(`— not applicable here: ${artefacts.why}`)}`);
    results.push({ ...gate, skipped: false, notApplicable: true, code: 0 });
    continue;
  }
  if (gate.artefact === true && skipContainers) {
    console.log(`${dim('  ○')} ${gate.label} ${dim('— skipped (--skip-containers)')}`);
    results.push({ ...gate, skipped: true, notApplicable: false, code: 0 });
    continue;
  }
  console.log(bold(`▸ ${gate.label}`));
  const res = spawnSync(process.execPath, [join(HERE, gate.file)], {
    stdio: 'inherit',
    env: process.env,
  });
  const code = res.status === null ? 1 : res.status;
  results.push({ ...gate, skipped: false, notApplicable: false, code });
  console.log('');
}

const failed = results.filter((r) => r.code !== 0);
const skipped = results.filter((r) => r.skipped);
const notApplicable = results.filter((r) => r.notApplicable);

console.log(bold('Summary'));
for (const r of results) {
  const mark = r.notApplicable
    ? dim('○ n/a    ')
    : r.skipped
      ? dim('○ skipped')
      : r.code === 0
        ? green('✓ pass   ')
        : red('✗ FAIL   ');
  console.log(`  ${mark}  ${r.label}`);
}

if (failed.length > 0) {
  console.log(red(bold(`\n${failed.length} gate(s) failed — this is release-blocking.`)));
  console.log(dim('  Supply-chain findings are never waived to unblock a release. Fix the dependency,'));
  console.log(dim('  pin an older version, or remove it. See docs/SECURITY.md.\n'));
  process.exit(1);
}

if (skipped.length > 0) {
  // "network gate(s)" is deliberately unchanged from when `--offline` was the only
  // way to skip one. Every gate that CAN be skipped by a flag reaches the network —
  // the container scan fetches trivy's vulnerability database — so the sentence is
  // still literally true, and `audit.test.mjs` asserts it verbatim.
  console.log(red(bold(`\n${skipped.length} network gate(s) skipped — NOT a valid release audit.`)));
  console.log(dim('  Exiting non-zero on purpose: an audit that did not run its gates has not passed.'));
  console.log(dim('  Run `pnpm run security:audit` with network access, and without'));
  console.log(dim('  --skip-containers, before releasing.\n'));
  // A distinct code so a caller can tell "incomplete" from "something failed".
  process.exit(2);
}

console.log(green(bold('\nAll supply-chain gates passed.\n')));

if (notApplicable.length > 0) {
  // Deliberately after the green line and deliberately loud: the audit passed and
  // its scope was smaller than the full list, and a reader who takes the tick
  // without the caveat would believe the shipped images had been scanned.
  console.log(yellow(bold(`  Scope: ${notApplicable.length} gate(s) did not apply on this machine.`)));
  for (const r of notApplicable) console.log(dim(`    ${r.label} — ${artefacts.why}`));
  console.log(
    dim(
      '\n  This audit therefore covered the dependency graph at this commit and NOT the container\n' +
        '  images that ship. Those are scanned after they are built:\n\n' +
        '      pnpm run release:artifacts && pnpm run security:containers\n\n' +
        '  which is exactly what .github/workflows/release.yml does, as a mandatory step.\n',
    ),
  );
}
