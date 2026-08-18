#!/usr/bin/env node
/**
 * Gate: integrity, release age and provenance of every resolved package version.
 *
 * Three independent assertions per package:
 *
 *  1. INTEGRITY — the hash recorded in our lockfile must equal the hash the
 *     registry reports for that exact version. A mismatch means the lockfile was
 *     written against a different artefact than the registry now serves, i.e. the
 *     tarball was replaced or the lockfile was tampered with.
 *
 *  2. RELEASE AGE — the version must have been published at least
 *     `minimumReleaseAge` ago. pnpm already enforces this at install time; this
 *     re-checks it independently so a lockfile produced elsewhere (or with the
 *     setting disabled) still fails here.
 *
 *  3. PROVENANCE — records whether npm holds a signed attestation for the version.
 *
 * On (3), read docs/security/shai-hulud-snapshot-2026-08-17.md §2: the Mini
 * Shai-Hulud worm *forges SLSA provenance attestations through Sigstore*. A
 * present attestation is therefore recorded as evidence but is NOT treated as
 * proof of integrity, and a missing attestation is NOT a failure — most of the
 * ecosystem still does not publish them. Treating "has provenance" as "is safe"
 * would be exactly the wrong lesson from this campaign.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchJson,
  Gate,
  lockfileText,
  mapLimit,
  REPO_ROOT,
  resolvedGraph,
  runGate,
  workspaceYamlText,
} from './lib.mjs';
import { parseLockPackages } from './lockfile-integrity.mjs';

const gate = new Gate('integrity-and-release-age');
const REPORT_PATH = join(REPO_ROOT, 'docs', 'sbom', 'provenance-report.json');

await runGate(gate, async () => {
  const lock = parseLockPackages(lockfileText());
  const { packages } = resolvedGraph();

  if (lock.size === 0) {
    gate.fail(
      'parsed zero packages from pnpm-lock.yaml',
      'the lockfile reader is out of step with the lockfile format',
    );
    return;
  }
  gate.note(`lockfile records ${lock.size} package versions`);

  // Read the configured cooldown so this gate and pnpm cannot disagree.
  const minReleaseAgeMinutes = Number(/^minimumReleaseAge:\s*(\d+)/m.exec(workspaceYamlText())?.[1] ?? '0');
  if (!Number.isFinite(minReleaseAgeMinutes) || minReleaseAgeMinutes < 10_080) {
    gate.fail(
      `minimumReleaseAge in pnpm-workspace.yaml is ${minReleaseAgeMinutes} minutes`,
      'a cooldown of at least 10080 (7 days) is required',
    );
  }
  const cooldownMs = minReleaseAgeMinutes * 60_000;
  const now = Date.now();

  const targets = [...packages.values()].map((p) => ({ name: p.name, version: p.version, dev: p.dev }));
  gate.note(`querying the registry for ${targets.length} package versions (concurrency 8)`);

  /**
   * name -> a *promise* of the registry document, cached so that a scoped family
   * costs one request even when several of its packages are fetched concurrently.
   * Deliberately not `async`: it hands back the shared in-flight promise rather
   * than awaiting and re-wrapping it, which is what makes the dedup work.
   */
  const docCache = new Map();
  const getDoc = (name) => {
    if (!docCache.has(name)) {
      docCache.set(
        name,
        fetchJson(`https://registry.npmjs.org/${name.replace('/', '%2F')}`).catch((err) => ({
          __error: err.message,
        })),
      );
    }
    return docCache.get(name);
  };

  const report = [];
  await mapLimit(targets, 8, async (target) => {
    const key = `${target.name}@${target.version}`;
    const doc = await getDoc(target.name);
    if (doc.__error) {
      gate.fail(`could not fetch registry metadata for ${key}`, doc.__error);
      return;
    }
    const meta = doc.versions?.[target.version];
    if (!meta) {
      gate.fail(
        `version not present in registry metadata: ${key}`,
        'the version was unpublished, or the lockfile references something the registry does not serve',
      );
      return;
    }

    const registryIntegrity = meta.dist?.integrity ?? null;
    const lockEntry = lock.get(key);
    const lockIntegrity = lockEntry?.integrity ?? null;
    const publishedAt = doc.time?.[target.version] ?? null;
    const hasAttestation = Boolean(meta.dist?.attestations);

    // (1) integrity
    if (!lockEntry) {
      gate.fail(
        `no lockfile entry for resolved package ${key}`,
        'the resolved graph and the lockfile disagree — run `pnpm install --frozen-lockfile`',
      );
    } else if (!lockIntegrity) {
      gate.fail(`lockfile entry for ${key} has no integrity hash`);
    } else if (!registryIntegrity) {
      gate.warn(
        `registry reports no integrity hash for ${key}`,
        'cannot cross-check; very old packages may predate integrity metadata',
      );
    } else if (lockIntegrity !== registryIntegrity) {
      gate.fail(
        `INTEGRITY MISMATCH for ${key}`,
        `lockfile:  ${lockIntegrity}\n      registry:  ${registryIntegrity}\n      The artefact our lockfile pins is not the artefact the registry now serves.`,
      );
    }

    // (2) release age
    if (!publishedAt) {
      gate.warn(
        `registry reports no publish time for ${key}`,
        'cannot verify the release-age cooldown for this version',
      );
    } else {
      const ageMs = now - Date.parse(publishedAt);
      if (ageMs < cooldownMs) {
        const ageDays = (ageMs / 86_400_000).toFixed(1);
        gate.fail(
          `${key} is younger than the release-age cooldown (${ageDays}d old, cooldown ${(cooldownMs / 86_400_000).toFixed(0)}d)`,
          `published ${publishedAt} — pin an older patch, or wait out the cooldown`,
        );
      }
    }

    report.push({
      name: target.name,
      version: target.version,
      dev: target.dev,
      publishedAt,
      ageDays: publishedAt ? Number(((now - Date.parse(publishedAt)) / 86_400_000).toFixed(2)) : null,
      integrity: lockIntegrity,
      integrityMatchesRegistry: Boolean(
        lockIntegrity && registryIntegrity && lockIntegrity === registryIntegrity,
      ),
      // Recorded for incident response only — forgeable, see the header comment.
      npmAttestationPresent: hasAttestation,
    });
  });

  report.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const withAttestation = report.filter((r) => r.npmAttestationPresent).length;
  writeFileSync(
    REPORT_PATH,
    `${JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        note: 'npmAttestationPresent is recorded for incident response only. Mini Shai-Hulud forged Sigstore attestations, so presence is not evidence of integrity.',
        minimumReleaseAgeMinutes: minReleaseAgeMinutes,
        packageCount: report.length,
        withAttestation,
        packages: report,
      },
      null,
      2,
    )}\n`,
  );
  gate.note(
    `provenance report written to docs/sbom/provenance-report.json (${withAttestation}/${report.length} have an npm attestation)`,
  );
});
