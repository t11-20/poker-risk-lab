#!/usr/bin/env node
/**
 * Gate: no denied package may appear anywhere in the resolved dependency graph.
 *
 * Checks the logical graph (what we depend on) *and* the installed store (what is
 * actually on disk), because a lockfile can be correct while the store is not.
 */

import { denyReason } from './denied-packages.mjs';
import { Gate, installedManifests, resolvedGraph, runGate } from './lib.mjs';

const gate = new Gate('deny-list');

await runGate(gate, () => {
  const { packages } = resolvedGraph();
  const installed = installedManifests();

  gate.note(`resolved graph: ${packages.size} third-party package versions`);
  gate.note(`installed store: ${installed.size} package versions on disk`);

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
});
