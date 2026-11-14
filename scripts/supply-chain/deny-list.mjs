#!/usr/bin/env node
/**
 * Gate: no denied package appears in the resolved graph or in the installed store, since a correct
 * lockfile does not imply a correct store. A sweep over 0 installed versions is not a pass, so it
 * requires store coverage (`requireStoreCoverage` in lib.mjs).
 */

import { denyReason } from './denied-packages.mjs';
import {
  Gate,
  installedManifests,
  requireStoreCoverage,
  resolvedGraph,
  runGate,
  storeCoverage,
} from './lib.mjs';

/**
 * @param {Gate} gate
 * @param {Map<string, {name: string, importers: Set<string>}>} packages
 */
export function checkResolvedGraph(gate, packages) {
  for (const [key, pkg] of packages) {
    const reason = denyReason(pkg.name);
    if (reason) {
      const importers = [...pkg.importers].join(', ');
      gate.fail(
        `denied package in resolved graph: ${key}`,
        `reason: ${reason}\n      reached from: ${importers}`,
      );
    }
  }
}

/**
 * @param {Gate} gate
 * @param {Map<string, {manifest: {name?: string}|null, manifestPath: string, dir: string}>} installed
 */
export function checkInstalledStore(gate, installed) {
  for (const [key, entry] of installed) {
    if (key.startsWith('UNPARSEABLE:')) {
      gate.fail('unparseable package.json in the installed store', entry.manifestPath);
      continue;
    }
    const reason = denyReason(entry.manifest.name);
    if (reason) {
      gate.fail(`denied package on disk: ${key}`, `reason: ${reason}\n      at: ${entry.dir}`);
    }
  }
}

export function runDenyListGate() {
  const gate = new Gate('deny-list');
  return runGate(gate, () => {
    const { packages } = resolvedGraph();
    const installed = installedManifests();

    gate.note(`resolved graph: ${packages.size} third-party package versions`);
    gate.note(`installed store: ${installed.size} package versions on disk`);

    checkResolvedGraph(gate, packages);
    requireStoreCoverage(gate, storeCoverage(packages, installed), 'the on-disk deny check');
    checkInstalledStore(gate, installed);
  });
}

if (import.meta.main) await runDenyListGate();
