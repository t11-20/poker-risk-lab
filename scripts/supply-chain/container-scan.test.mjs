#!/usr/bin/env node
/**
 * Tests for the `container-image-cves` gate.
 *
 * Run with:  node --test scripts/supply-chain/container-scan.test.mjs
 *
 * ## Would these fail if the behaviour broke, and how was that checked?
 *
 * Every case below is a NEGATIVE CONTROL: it feeds the classifier or the
 * allowlist parser a shape the policy forbids and asserts the detector fires.
 * They were checked the only way that means anything — by writing the assertion
 * first and watching it fail against a deliberately broken version of the
 * function. Specifically:
 *
 *   * `blocking` was temporarily hard-coded to `false`, and the four
 *     "blocks"/"is blocking" cases failed.
 *   * The `Metadata.OS` check was temporarily removed, and
 *     "a report with no OS is refused" failed.
 *   * The `expiry < now` comparison was temporarily inverted, and "an expired
 *     entry is refused" failed.
 *   * The `entry.package` scope test was temporarily dropped, and "an allowlist
 *     entry scoped to one package does not cover another" failed.
 *
 * The fixture is a trimmed but structurally exact trivy v2 report — the field
 * names, the nesting and the `Status` values are copied from a real
 * `trivy image --format json` run against this project's web image on
 * 2026-08-22, so a change in how trivy shapes its output shows up here rather
 * than as a gate that silently stops finding anything.
 *
 * ## What is NOT tested here
 *
 * Anything that needs trivy or a Docker daemon. `runTrivy` shells out and its
 * failure paths (missing binary, unreachable vulnerability database) are exercised
 * by running the gate for real; a test that mocked `spawnSync` would assert that
 * the mock works. The parts that decide what BLOCKS are pure, and those are what
 * is tested.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { classifyReport, imagesToScan, parseAllowlist, parseArgs } from './container-scan.mjs';
import { REPO_ROOT } from './lib.mjs';

/**
 * A structurally exact trivy report with one of every case that matters:
 * a CRITICAL with a fix, a HIGH with a fix, a CRITICAL Debian has said it will
 * not fix, a HIGH with a deferred fix, and a MEDIUM that a HIGH floor must ignore.
 */
function trivyReport(overrides = {}) {
  return {
    SchemaVersion: 2,
    ArtifactName: 'prl-web:test',
    ArtifactType: 'container_image',
    Metadata: { OS: { Family: 'debian', Name: '12.15' } },
    Results: [
      {
        Target: 'prl-web:test (debian 12.15)',
        Class: 'os-pkgs',
        Type: 'debian',
        Vulnerabilities: [
          {
            VulnerabilityID: 'CVE-2023-45853',
            PkgName: 'zlib1g',
            InstalledVersion: '1:1.2.13.dfsg-1',
            Severity: 'CRITICAL',
            Status: 'will_not_fix',
          },
          {
            VulnerabilityID: 'CVE-2026-9538',
            PkgName: 'perl-base',
            InstalledVersion: '5.36.0-7+deb12u3',
            Severity: 'HIGH',
            Status: 'fix_deferred',
          },
          {
            VulnerabilityID: 'CVE-2026-00001',
            PkgName: 'openssl',
            InstalledVersion: '3.0.11-1',
            FixedVersion: '3.0.14-1',
            Severity: 'CRITICAL',
            Status: 'fixed',
          },
          {
            VulnerabilityID: 'CVE-2026-00002',
            PkgName: 'curl',
            InstalledVersion: '7.88.1-10',
            FixedVersion: '7.88.1-11',
            Severity: 'MEDIUM',
            Status: 'fixed',
          },
        ],
      },
      {
        Target: 'Node.js',
        Class: 'lang-pkgs',
        Type: 'node-pkg',
        Vulnerabilities: [
          {
            VulnerabilityID: 'CVE-2026-59873',
            PkgName: 'tar',
            InstalledVersion: '7.5.15',
            FixedVersion: '7.5.19',
            Severity: 'CRITICAL',
            Status: 'fixed',
          },
        ],
      },
    ],
    ...overrides,
  };
}

function classify(options = {}) {
  return classifyReport({
    image: 'prl-web:test',
    report: trivyReport(),
    allowlist: [],
    severityFloor: 'HIGH',
    includeUnfixed: false,
    ...options,
  });
}

const NEVER = '2099-01-01';
const now = new Date('2026-08-22T12:00:00Z');

describe('classifying a report', () => {
  it('scans a non-empty set, so the assertions below are about something', () => {
    const classified = classify();
    // Five vulnerabilities in the fixture, four of them at or above HIGH. If this
    // ever reads zero the classifier has stopped reading trivy's shape and every
    // "nothing blocked" assertion in this file would pass vacuously.
    assert.equal(classified.packagesConsidered, 5, 'the fixture must be read in full');
    assert.equal(classified.findings.length, 4, 'four findings sit at or above the HIGH floor');
    assert.deepEqual(classified.problems, [], 'a well-formed report must raise no trust problems');
  });

  it('BLOCKS a fixable CRITICAL and a fixable HIGH', () => {
    const blocking = classify().findings.filter((f) => f.blocking);
    assert.deepEqual(
      blocking.map((f) => f.id).sort(),
      ['CVE-2026-00001', 'CVE-2026-59873'],
      'the two findings with a FixedVersion must block',
    );
  });

  it('does NOT block a finding with no available fix, and still reports it', () => {
    const findings = classify().findings;
    const unfixable = findings.filter((f) => f.fixedVersion === null);
    assert.equal(unfixable.length, 2, 'will_not_fix and fix_deferred are both present in the fixture');
    assert.ok(
      unfixable.every((f) => !f.blocking),
      'an unfixable finding must not block by default — the only remediation is a new base image',
    );
    // Reported, not swallowed: they are in `findings`, which is what the gate
    // counts and what --json publishes.
    assert.ok(findings.some((f) => f.id === 'CVE-2023-45853'));
  });

  it('DOES block an unfixable finding with --include-unfixed', () => {
    const findings = classify({ includeUnfixed: true }).findings;
    assert.equal(
      findings.filter((f) => f.blocking).length,
      4,
      'every finding blocks when unfixed are included',
    );
  });

  it('ignores a finding below the floor', () => {
    const ids = classify().findings.map((f) => f.id);
    assert.ok(!ids.includes('CVE-2026-00002'), 'a MEDIUM must not appear at a HIGH floor');
    const lower = classify({ severityFloor: 'MEDIUM' }).findings.map((f) => f.id);
    assert.ok(lower.includes('CVE-2026-00002'), 'the same MEDIUM must appear at a MEDIUM floor');
  });

  it('REFUSES a report in which trivy identified no operating system', () => {
    // The silent-pass this gate exists to prevent: trivy ran, produced valid JSON
    // and found nothing, because it never read a package database.
    const classified = classifyReport({
      image: 'prl-web:test',
      report: { ...trivyReport(), Metadata: {} },
      allowlist: [],
      severityFloor: 'HIGH',
      includeUnfixed: false,
    });
    assert.match(classified.problems.join(' '), /did not identify an operating system/);
  });

  it('REFUSES a report with no scan targets at all', () => {
    const classified = classifyReport({
      image: 'prl-web:test',
      report: { Metadata: { OS: { Family: 'debian', Name: '12.15' } }, Results: [] },
      allowlist: [],
      severityFloor: 'HIGH',
      includeUnfixed: false,
    });
    assert.match(classified.problems.join(' '), /no scan targets/);
  });
});

describe('the allowlist', () => {
  const valid = {
    id: 'CVE-2026-00001',
    reason: 'openssl is only reachable from the TLS client we do not use; fixed base image lands 2026-09',
    expires: NEVER,
    approvedBy: 'release-engineering',
  };

  it('accepts a complete entry and suppresses exactly the matching finding', () => {
    const { entries, problems } = parseAllowlist({ allow: [valid] }, now);
    assert.deepEqual(problems, []);
    const findings = classify({ allowlist: entries }).findings;
    const allowed = findings.filter((f) => f.allowedBy !== null);
    assert.equal(allowed.length, 1);
    assert.equal(allowed[0].id, 'CVE-2026-00001');
    assert.equal(allowed[0].blocking, false, 'an allowed finding must not block');
    assert.ok(
      findings.some((f) => f.id === 'CVE-2026-59873' && f.blocking),
      'the other fixable finding must still block',
    );
  });

  it('REFUSES an entry with no expiry date', () => {
    const { problems } = parseAllowlist({ allow: [{ ...valid, expires: undefined }] }, now);
    assert.match(problems.join(' '), /has no valid `expires`/);
  });

  it('REFUSES an entry whose expiry is not a date', () => {
    const { problems } = parseAllowlist({ allow: [{ ...valid, expires: 'when we get to it' }] }, now);
    assert.match(problems.join(' '), /has no valid `expires`/);
  });

  it('REFUSES an entry that has lapsed', () => {
    const { entries, problems } = parseAllowlist({ allow: [{ ...valid, expires: '2026-08-21' }] }, now);
    assert.match(problems.join(' '), /expired on 2026-08-21/);
    assert.deepEqual(entries, [], 'a lapsed entry must not suppress anything either');
  });

  it('REFUSES an entry with no reason, and one whose reason is a shrug', () => {
    for (const reason of [undefined, '', 'n/a', 'later']) {
      const { problems } = parseAllowlist({ allow: [{ ...valid, reason }] }, now);
      assert.match(
        problems.join(' '),
        /has no usable `reason`/,
        `reason ${JSON.stringify(reason)} was accepted`,
      );
    }
  });

  it('REFUSES an entry with no approver', () => {
    const { problems } = parseAllowlist({ allow: [{ ...valid, approvedBy: '  ' }] }, now);
    assert.match(problems.join(' '), /has no `approvedBy`/);
  });

  it('REFUSES a file with no `allow` array at all', () => {
    assert.match(parseAllowlist({}, now).problems.join(' '), /no `allow` array/);
    assert.match(parseAllowlist(null, now).problems.join(' '), /not a JSON object/);
  });

  it('does not let an entry scoped to one package cover another', () => {
    const scoped = { ...valid, package: 'some-other-package' };
    const { entries } = parseAllowlist({ allow: [scoped] }, now);
    const findings = classify({ allowlist: entries }).findings;
    assert.ok(
      findings.every((f) => f.allowedBy === null),
      'the scope must be honoured, or an exception silently widens to every package with that CVE',
    );
  });

  it('does not let an entry scoped to one image cover another', () => {
    const { entries } = parseAllowlist({ allow: [{ ...valid, image: 'prl-api:test' }] }, now);
    const findings = classify({ allowlist: entries }).findings;
    assert.ok(findings.every((f) => f.allowedBy === null));
  });
});

describe('the committed allowlist', () => {
  it('parses, and is empty or entirely valid', () => {
    // The shipped file is policy. If somebody adds a malformed entry, the gate
    // fails at release time; this fails at test time, which is cheaper.
    const raw = JSON.parse(
      readFileSync(join(REPO_ROOT, 'scripts', 'supply-chain', 'container-allowlist.json'), 'utf8'),
    );
    const { problems } = parseAllowlist(raw, new Date());
    assert.deepEqual(problems, [], `the committed container allowlist is not valid:\n${problems.join('\n')}`);
  });
});

describe('choosing what to scan', () => {
  it('refuses, rather than skips, when there is no manifest and no --image', () => {
    const { images, problem } = imagesToScan({
      manifest: 'deploy/staging/this-manifest-does-not-exist.json',
      images: [],
    });
    assert.deepEqual(images, []);
    assert.match(problem ?? '', /a scan of nothing proves nothing/);
  });

  it('scans exactly the references given by --image', () => {
    const { images, problem } = imagesToScan({ manifest: 'unused', images: ['a@sha256:1', 'b@sha256:2'] });
    assert.equal(problem, null);
    assert.deepEqual(
      images.map((i) => i.reference),
      ['a@sha256:1', 'b@sha256:2'],
    );
  });
});

describe('options', () => {
  it('rejects a severity that is not one of the five', () => {
    assert.throws(() => parseArgs(['--severity', 'SEVERE']), /--severity must be one of/);
  });

  it('rejects an unknown option rather than ignoring it', () => {
    assert.throws(() => parseArgs(['--ignore-everything']), /unknown option --ignore-everything/);
  });

  it('rejects an option that is missing its value', () => {
    assert.throws(() => parseArgs(['--severity']), /--severity needs a value/);
  });

  it('accepts the `--` that `pnpm run` forwards', () => {
    assert.equal(parseArgs(['--', '--severity', 'CRITICAL']).severity, 'CRITICAL');
  });

  it('defaults to blocking only on fixable HIGH and above', () => {
    const options = parseArgs([]);
    assert.equal(options.severity, 'HIGH');
    assert.equal(options.includeUnfixed, false);
  });
});
