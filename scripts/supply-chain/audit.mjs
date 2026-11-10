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
 * ## Two gates have a scope the others do not
 *
 * Every other gate reads the repository: the lockfile, the installed store, the
 * workflow files. They can run on any checkout at any time. `container-scan.mjs`
 * and `image-provenance.mjs` read the two Docker IMAGES — one for known CVEs, the
 * other to check they are signed by the committed key — and those exist only
 * after `pnpm run release:artifacts` has built them, while this audit is invoked
 * long before that — by
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
 *   * **`--skip-containers` or `--skip-signatures` with artefacts present**: an
 *     explicit refusal to run a gate that could have run, which exits **2**, the
 *     same "incomplete" code `--offline` uses. A flag is the only way to skip a
 *     runnable gate, and using it is never a pass.
 *
 * The release path does not rely on that inference: `.github/workflows/release.yml`
 * builds the artefacts and then runs `pnpm run security:containers` as a step of
 * its own, so the scan on the path that ships is mandatory and visible by name.
 *
 * The signature gate is deliberately NOT a network gate. Its registry is loopback
 * and its trust anchor is a committed file, so it is exactly the check that still
 * works for a deployer with no internet — `--offline` leaves it running.
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
 *
 * `skipFlag` names the ONE command-line flag that may skip that gate, and it is per-gate rather
 * than shared. It used to be shared: the condition read `gate.artefact === true && skipContainers`,
 * so the moment a second artefact gate existed — the signature check — `--skip-containers` would
 * have silently skipped it too. A flag named after the CVE scan turning off the signature
 * verification is the sort of thing nobody notices until a release ships unsigned behind a flag
 * somebody passed for an unrelated reason.
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
  // Hermetic, and deliberately NOT an artefact gate: it reads a committed policy
  // and the committed workflows, so it runs on every push, long before any image
  // exists. What it holds is the identity a keyless signature must carry — the
  // workflow file name, the ref, and the rule that exactly one job in exactly one
  // workflow may hold `id-token: write`. A rename that breaks that binding fails
  // here rather than surfacing as an unverifiable signature months later.
  { file: 'keyless-provenance.mjs', label: 'keyless signing identity', network: false },
  // Not a dependency gate, and it belongs here anyway: the deployment configuration
  // is supply chain in the sense that matters, and D2 in the legal register is what
  // happens when nothing reads it. Both shipped nginx configs logged the OIDC
  // authorization code — `access_log ... combined;` writes "$request" verbatim —
  // and no gate, test or lint rule read either file, so it shipped silently past
  // every check in this list. Offline, hermetic, and it reads only committed text.
  { file: 'log-policy.mjs', label: 'log policy', network: false },
  { file: 'provenance.mjs', label: 'integrity + release age', network: true },
  { file: 'osv-scan.mjs', label: 'OSV vulnerabilities', network: true },
  // Sits beside the OSV gate because it asks the same question of the other half
  // of the dependency graph, and it is a separate gate because that half needed a
  // different answer: `osv-scan.mjs` queries the `npm` ecosystem, and OSV's
  // version-qualified query returns an empty result for the `GitHub Actions`
  // ecosystem even when the version is squarely inside a published range —
  // measured, see that file's header. `ci-pinning.mjs` proves every action is
  // pinned to a commit SHA; nothing re-checked whether that SHA is a version an
  // advisory has since been published against, and a pinned vulnerable version
  // stays pinned for ever.
  { file: 'action-advisories.mjs', label: 'pinned action advisories', network: true },
  { file: 'sbom.mjs', label: 'SBOM generation', network: false },
  {
    file: 'container-scan.mjs',
    label: 'container image CVEs',
    network: true,
    artefact: true,
    skipFlag: '--skip-containers',
  },
  // Same scope as the CVE scan and for the same reason: it reads the release IMAGES, which exist
  // only after `pnpm run release:artifacts`. Not a network gate — the registry it verifies against
  // is loopback — so `--offline` leaves it running, which is correct: signature verification is
  // exactly the check an air-gapped deployer needs and it needs nothing but the committed key.
  {
    file: 'image-provenance.mjs',
    label: 'release image signatures',
    network: false,
    artefact: true,
    skipFlag: '--skip-signatures',
  },
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
  // The noun is computed rather than written, and that is a correction rather than
  // a flourish. It used to be the literal string "network gate(s)", justified by a
  // comment saying every skippable gate reached the network — true when the only
  // skippable gates were the OSV query, the registry integrity check and the CVE
  // scan. `image-provenance.mjs` breaks it: it verifies signatures against a
  // loopback registry and a committed key, reaches no network at all, and
  // `--skip-signatures` skips it. Printing "1 network gate(s) skipped" for it would
  // be a false sentence in the one message a reader consults to find out what did
  // not run. `--offline` still produces the original wording verbatim, which is
  // what `audit.test.mjs` asserts.
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
  // Deliberately after the green line and deliberately loud: the audit passed and
  // its scope was smaller than the full list, and a reader who takes the tick
  // without the caveat would believe the shipped images had been scanned.
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
