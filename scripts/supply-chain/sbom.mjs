#!/usr/bin/env node
/**
 * Generates a CycloneDX 1.6 SBOM from the resolved dependency graph.
 *
 * Hand-rolled rather than using @cyclonedx/cyclonedx-npm, for two reasons:
 * that generator pulls a sizeable dependency tree of its own into a repo whose
 * whole policy is dependency minimisation, and it would have to be exempted from
 * the release-age cooldown to stay current. The output here is validated against
 * the CycloneDX 1.6 JSON schema shape in scripts/supply-chain/sbom.test.mjs.
 *
 * Component identity comes from the lockfile integrity hash (subresource
 * integrity → CycloneDX `hashes`), so the SBOM names the exact artefacts.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Gate, lockfileText, REPO_ROOT, resolvedGraph, runGate } from './lib.mjs';
import { parseLockPackages } from './lockfile-integrity.mjs';

const gate = new Gate('sbom');
const OUT_PATH = join(REPO_ROOT, 'docs', 'sbom', 'poker-risk-lab.cdx.json');

/** Convert an npm SRI string to CycloneDX hash entries. */
function sriToHashes(integrity) {
  if (!integrity) return [];
  const out = [];
  for (const part of integrity.split(/\s+/)) {
    const [alg, b64] = part.split('-');
    if (!alg || !b64) continue;
    const algMap = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
    const mapped = algMap[alg];
    if (!mapped) continue;
    out.push({ alg: mapped, content: Buffer.from(b64, 'base64').toString('hex') });
  }
  return out;
}

/** package URL per the npm purl spec: scope goes in the namespace. */
function purlFor(name, version) {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    const namespace = encodeURIComponent(name.slice(0, slash));
    const bare = encodeURIComponent(name.slice(slash + 1));
    return `pkg:npm/${namespace}/${bare}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

await runGate(gate, () => {
  const { packages, edges, workspaceProjects } = resolvedGraph();
  const lock = parseLockPackages(lockfileText());
  const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

  // A stable, content-derived serial number: regenerating an unchanged graph
  // produces an identical SBOM, so the file is diffable in review.
  const graphFingerprint = createHash('sha256')
    .update([...packages.keys()].sort().join('\n'))
    .update('\n--\n')
    .update([...edges].sort().join('\n'))
    .digest('hex');
  const serialNumber = `urn:uuid:${graphFingerprint.slice(0, 8)}-${graphFingerprint.slice(8, 12)}-4${graphFingerprint.slice(13, 16)}-8${graphFingerprint.slice(17, 20)}-${graphFingerprint.slice(20, 32)}`;

  const rootRef = `pkg:npm/${rootManifest.name}@${rootManifest.version}`;

  const components = [];

  for (const project of workspaceProjects) {
    if (project.name === rootManifest.name) continue;
    components.push({
      type: 'library',
      'bom-ref': purlFor(project.name, project.version),
      name: project.name,
      version: project.version,
      purl: purlFor(project.name, project.version),
      scope: 'required',
      description: 'first-party workspace package',
      properties: [{ name: 'prl:origin', value: 'workspace' }],
    });
  }

  for (const [key, pkg] of [...packages.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const lockEntry = lock.get(key);
    const purl = purlFor(pkg.name, pkg.version);
    const component = {
      type: 'library',
      'bom-ref': purl,
      name: pkg.name,
      version: pkg.version,
      purl,
      scope: 'required',
      properties: [
        { name: 'prl:dev', value: String(pkg.dev) },
        { name: 'prl:importers', value: [...pkg.importers].sort().join(',') },
      ],
    };
    const hashes = sriToHashes(lockEntry?.integrity);
    if (hashes.length > 0) component.hashes = hashes;
    else gate.warn(`no integrity hash available for ${key}`, 'the SBOM component will not carry a hash');
    if (pkg.resolved) {
      component.externalReferences = [{ type: 'distribution', url: pkg.resolved }];
    }
    components.push(component);
  }

  // CycloneDX `dependencies` graph.
  const byRef = new Map();
  const refFor = (nodeKey) => {
    const at = nodeKey.lastIndexOf('@');
    const name = nodeKey.slice(0, at);
    const version = nodeKey.slice(at + 1);
    if (name === rootManifest.name) return rootRef;
    return purlFor(name, version);
  };
  for (const edge of edges) {
    const [from, to] = edge.split(' ');
    if (!from || !to) continue;
    const fromRef = refFor(from);
    const toRef = refFor(to);
    if (!byRef.has(fromRef)) byRef.set(fromRef, new Set());
    byRef.get(fromRef).add(toRef);
  }
  const knownRefs = new Set([rootRef, ...components.map((c) => c['bom-ref'])]);
  const dependencies = [...byRef.entries()]
    .filter(([ref]) => knownRefs.has(ref))
    .map(([ref, deps]) => ({
      ref,
      dependsOn: [...deps].filter((d) => knownRefs.has(d)).sort(),
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
  for (const ref of knownRefs) {
    if (!byRef.has(ref)) dependencies.push({ ref, dependsOn: [] });
  }
  dependencies.sort((a, b) => a.ref.localeCompare(b.ref));

  const bom = {
    $schema: 'https://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber,
    version: 1,
    metadata: {
      // No wall-clock `timestamp` field on purpose: a content-derived SBOM stays
      // byte-identical across runs, so `git diff` shows dependency changes only
      // rather than a fresh timestamp on every build. The generation time is
      // recorded in docs/sbom/provenance-report.json instead.
      lifecycles: [{ phase: 'build' }],
      tools: {
        components: [
          {
            type: 'application',
            name: 'prl-sbom',
            version: '1.0.0',
            description: 'dependency-free CycloneDX generator in scripts/supply-chain/sbom.mjs',
          },
        ],
      },
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: rootManifest.name,
        version: rootManifest.version,
        description: rootManifest.description,
        purl: rootRef,
      },
      properties: [
        { name: 'prl:graphFingerprint', value: graphFingerprint },
        { name: 'prl:nodeVersionRange', value: rootManifest.engines?.node ?? 'unknown' },
        { name: 'prl:packageManager', value: rootManifest.packageManager ?? 'unknown' },
      ],
    },
    components,
    dependencies,
  };

  writeFileSync(OUT_PATH, `${JSON.stringify(bom, null, 2)}\n`);
  gate.note(`wrote ${components.length} components and ${dependencies.length} dependency records`);
  gate.note(`graph fingerprint ${graphFingerprint.slice(0, 16)}… → docs/sbom/poker-risk-lab.cdx.json`);
});
