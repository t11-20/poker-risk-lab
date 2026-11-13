#!/usr/bin/env node
/**
 * Gate: per resolved package version, the lockfile integrity hash equals the registry's, the
 * version is older than `minimumReleaseAge` (re-checked independently of pnpm), and npm's
 * provenance attestation is recorded. An attestation is not proof, because Mini Shai-Hulud forges
 * SLSA provenance (snapshot §2), and its absence is not a failure. It also checks install hooks of
 * versions pnpm skipped for this platform, which `dep-shapes.mjs` cannot read from disk.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchJson,
  Gate,
  INSTALL_HOOKS,
  installedManifests,
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

/**
 * Judges a published `scripts` block for install-time hooks, only for versions not on disk. On macOS
 * that is 58 of 162 versions, all Linux or Windows binaries, which the release container installs.
 * npm returns `scripts` verbatim (checked against esbuild and sharp), so an absent block means none.
 * A non-object fails closed.
 *
 * @param {Gate} gate
 * @param {string} key  `name@version`
 * @param {{scripts?: unknown}} meta  the registry's document for that version
 * @returns {boolean} true when the hooks were established either way
 */
export function checkPublishedInstallHooks(gate, key, meta) {
  const scripts = meta?.scripts;
  if (scripts === undefined) return true;
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) {
    gate.fail(
      `cannot read the published scripts block for ${key}`,
      'this version is not installed on this platform, so the registry manifest is the only ' +
        'evidence available and it is not in the expected shape — failing closed',
    );
    return false;
  }
  const installHooks = INSTALL_HOOKS.filter((h) => typeof scripts[h] === 'string');
  if (installHooks.length > 0) {
    gate.fail(
      `install-time lifecycle hook published by ${key}`,
      `${installHooks.map((h) => `${h}: ${scripts[h]}`).join('\n      ')}\n      ` +
        'This version is an optional dependency pnpm skipped on this platform, so it is absent ' +
        'from node_modules here — but it installs on the platform it targets, which for a Linux ' +
        'binary is the release container. Install scripts are the campaign delivery path.',
    );
  }
  return true;
}

export function runProvenanceGate() {
  return runGate(gate, async () => {
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

    // Read the configured cooldown so this gate and pnpm agree.
    const minReleaseAgeMinutes = Number(/^minimumReleaseAge:\s*(\d+)/m.exec(workspaceYamlText())?.[1] ?? '0');
    if (!Number.isFinite(minReleaseAgeMinutes) || minReleaseAgeMinutes < 10_080) {
      gate.fail(
        `minimumReleaseAge in pnpm-workspace.yaml is ${minReleaseAgeMinutes} minutes`,
        'a cooldown of at least 10080 (7 days) is required',
      );
    }
    const cooldownMs = minReleaseAgeMinutes * 60_000;
    const now = Date.now();

    // Versions with no manifest on disk, whose hooks must come from the registry.
    const installed = installedManifests();
    const targets = [...packages.values()].map((p) => ({
      name: p.name,
      version: p.version,
      dev: p.dev,
      onDisk: installed.has(`${p.name}@${p.version}`),
    }));
    const notOnDisk = targets.filter((t) => !t.onDisk);
    gate.note(`querying the registry for ${targets.length} package versions (concurrency 8)`);
    if (notOnDisk.length > 0) {
      gate.note(
        `${notOnDisk.length} of them are not installed on this platform, so their install hooks are ` +
          'checked against the published manifest here rather than on disk',
      );
    }
    let hooksCheckedFromRegistry = 0;
    let hooksUnverifiable = 0;

    // Returns the shared in-flight promise, not an awaited one, so a scoped family costs one request.
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

      if (!target.onDisk) {
        if (checkPublishedInstallHooks(gate, key, meta)) hooksCheckedFromRegistry += 1;
        else hooksUnverifiable += 1;
      }

      report.push({
        name: target.name,
        version: target.version,
        dev: target.dev,
        installedOnThisPlatform: target.onDisk,
        publishedAt,
        ageDays: publishedAt ? Number(((now - Date.parse(publishedAt)) / 86_400_000).toFixed(2)) : null,
        integrity: lockIntegrity,
        integrityMatchesRegistry: Boolean(
          lockIntegrity && registryIntegrity && lockIntegrity === registryIntegrity,
        ),
        // For incident response only. Forgeable.
        npmAttestationPresent: hasAttestation,
      });
    });

    if (notOnDisk.length > 0) {
      gate.note(
        `install hooks read from the registry for ${hooksCheckedFromRegistry}/${notOnDisk.length} ` +
          `platform-skipped version(s)${hooksUnverifiable > 0 ? `, ${hooksUnverifiable} unverifiable` : ''}`,
      );
      if (hooksCheckedFromRegistry + hooksUnverifiable < notOnDisk.length) {
        gate.fail(
          `install hooks were not established for ${notOnDisk.length - hooksCheckedFromRegistry - hooksUnverifiable} platform-skipped version(s)`,
          'these versions are in neither the on-disk scan nor this one, so nothing has checked them ' +
            'for the campaign delivery path',
        );
      }
    }

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
}

if (import.meta.main) await runProvenanceGate();
