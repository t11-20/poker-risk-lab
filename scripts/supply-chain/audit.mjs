#!/usr/bin/env node
/**
 * Runs every supply-chain gate as its own child process, so one crash cannot hide the others and no
 * gate can mutate state for a later one. Exit 0 only if every gate ran and exited 0. `--offline`
 * exits 2, because an audit that skipped gates has not passed.
 *
 * `container-scan.mjs` and `image-provenance.mjs` read the built release images, which exist only
 * after `release:artifacts`. With no images they report `not applicable` and the summary says the
 * images were not covered. Skipping one by flag while images exist exits 2. `release.yml` runs
 * `security:containers` as its own step. The signature gate uses a loopback registry and a
 * committed key, so `--offline` leaves it running.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, dim, green, red, yellow } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

/**
 * `network: true` gates are skipped by `--offline`. `artefact: true` gates need a built image.
 * `skipFlag` is per gate, so `--skip-containers` cannot also skip the signature check.
 */
const GATES = [
  { file: 'policy-check.mjs', label: 'policy in effect', network: false },
  { file: 'repo-hygiene.mjs', label: 'source encoding hygiene', network: false },
  { file: 'deny-list.mjs', label: 'denied packages', network: false },
  { file: 'dep-shapes.mjs', label: 'dependency shapes', network: false },
  { file: 'ioc-scan.mjs', label: 'Shai-Hulud IOC sweep', network: false },
  // Working tree only. `--history` stays opt-in so a history-rewrite remedy cannot block releases.
  { file: 'secret-scan.mjs', label: 'committed credentials', network: false },
  { file: 'ci-pinning.mjs', label: 'CI + container pinning', network: false },
  // Hermetic: reads the committed policy and workflows, so a rename that breaks the keyless
  // identity fails at push time.
  { file: 'keyless-provenance.mjs', label: 'keyless signing identity', network: false },
  // Both shipped nginx configs once logged the OIDC authorization code and nothing read them.
  { file: 'log-policy.mjs', label: 'log policy', network: false },
  { file: 'provenance.mjs', label: 'integrity + release age', network: true },
  { file: 'osv-scan.mjs', label: 'OSV vulnerabilities', network: true },
  // Separate from OSV because OSV's version query returns nothing for `GitHub Actions`.
  { file: 'action-advisories.mjs', label: 'pinned action advisories', network: true },
  { file: 'sbom.mjs', label: 'SBOM generation', network: false },
  {
    file: 'container-scan.mjs',
    label: 'container image CVEs',
    network: true,
    artefact: true,
    skipFlag: '--skip-containers',
  },
  // Reads the release images, but its registry is loopback, so `--offline` leaves it running.
  {
    file: 'image-provenance.mjs',
    label: 'release image signatures',
    network: false,
    artefact: true,
    skipFlag: '--skip-signatures',
  },
];

const RELEASE_MANIFEST = join(REPO_ROOT, 'deploy', 'staging', 'release-manifest.json');

/** Both the manifest and its images must be present. Pruned images would fail for the wrong reason. */
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
  if (gate.skipFlag !== undefined && process.argv.includes(gate.skipFlag)) {
    console.log(`${dim('  ○')} ${gate.label} ${dim(`— skipped (${gate.skipFlag})`)}`);
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
  // Computed, not literal, because `--skip-signatures` skips a gate that uses no network.
  // `--offline` still prints the original wording, which `audit.test.mjs` asserts.
  const noun = skipped.every((r) => r.network) ? 'network gate(s)' : 'gate(s)';
  console.log(red(bold(`\n${skipped.length} ${noun} skipped — NOT a valid release audit.`)));
  console.log(dim('  Exiting non-zero on purpose: an audit that did not run its gates has not passed.'));
  console.log(dim('  Run `pnpm run security:audit` with network access, and without'));
  console.log(dim('  --skip-containers or --skip-signatures, before releasing.\n'));
  // A distinct code so a caller can tell "incomplete" from "something failed".
  process.exit(2);
}

console.log(green(bold('\nAll supply-chain gates passed.\n')));

if (notApplicable.length > 0) {
  // Loud and after the green line, so nobody reads the tick as covering the images.
  console.log(yellow(bold(`  Scope: ${notApplicable.length} gate(s) did not apply on this machine.`)));
  for (const r of notApplicable) console.log(dim(`    ${r.label} — ${artefacts.why}`));
  console.log(
    dim(
      '\n  This audit therefore covered the dependency graph at this commit and NOT the container\n' +
        '  images that ship — neither their known CVEs nor whether they are signed. Both are\n' +
        '  checked after the images are built:\n\n' +
        '      pnpm run release:artifacts && pnpm run security:containers\n' +
        '      pnpm run release:sign      && pnpm run security:image-provenance\n\n' +
        '  The first line is exactly what .github/workflows/release.yml does, as a mandatory step.\n' +
        '  The second is not wired into CI and cannot be: signing needs a private key, and this\n' +
        '  repository has no CI signing identity. See deploy/signing/README.md.\n',
    ),
  );
}
