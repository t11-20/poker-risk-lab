#!/usr/bin/env node
/**
 * Gate: no denied package may appear anywhere in the resolved dependency graph.
 *
 * Checks the logical graph (what we depend on) *and* the installed store (what is
 * actually on disk), because a lockfile can be correct while the store is not.
 *
 * The on-disk half used to print `installed store: 0 package versions on disk`
 * and pass. Two facts are indistinguishable in that line — "nothing denied is
 * installed" and "nothing is installed" — and only one of them is evidence. It
 * now refuses to report success over a store that cannot account for the
 * resolved graph; see `requireStoreCoverage` in lib.mjs.
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
