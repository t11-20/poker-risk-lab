#!/usr/bin/env node
/**
 * Validates the generated SBOM against the CycloneDX 1.6 JSON schema *shape*.
 *
 * Run with:  node --test scripts/supply-chain/sbom.test.mjs
 *
 * ## Why this file exists
 *
 * `scripts/supply-chain/sbom.mjs:9` has always said: "The output here is
 * validated against the CycloneDX 1.6 JSON schema shape in
 * `scripts/supply-chain/sbom.test.mjs`." That file did not exist. The statement
 * is the kind a reviewer takes at face value and stops checking, which is worse
 * than saying nothing: it converts an untested generator into a tested one in the
 * reader's head. `pnpm run test:scripts` globbed every `.test.mjs` under
 * `scripts/` and found exactly one file, and it was about a different gate.
 *
 * "Shape", not the published schema document: fetching cyclonedx-1.6.schema.json
 * at test time would make an offline test suite network-dependent, and vendoring
 * a 3,000-line schema into a repository whose policy is dependency minimisation
 * buys less than the assertions below. What is checked here is every structural
 * rule the spec imposes that this generator could plausibly break — required
 * fields, enum values, purl well-formedness, hash algorithm names and hex digest
 * lengths, and the referential integrity of the `dependencies` graph.
 *
 * `validateCycloneDx16` is exercised in both directions: against the real output,
 * and against deliberately broken copies of it. A validator that has never
 * rejected anything is not evidence.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(REPO_ROOT, 'docs', 'sbom', 'poker-risk-lab.cdx.json');

const HASH_ALGORITHMS = new Map([
  ['SHA-1', 40],
  ['SHA-256', 64],
  ['SHA-384', 96],
  ['SHA-512', 128],
]);
const COMPONENT_TYPES = new Set([
  'application',
  'framework',
  'library',
  'container',
  'platform',
  'operating-system',
  'device',
  'device-driver',
  'firmware',
  'file',
  'machine-learning-model',
  'data',
  'cryptographic-asset',
]);
const SCOPES = new Set(['required', 'optional', 'excluded']);
const SERIAL_NUMBER = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PURL = /^pkg:[a-z]+\/[^@]+@[^@]+$/;

/**
 * @param {unknown} bom
 * @returns {string[]} one message per structural violation; empty means valid
 */
export function validateCycloneDx16(bom) {
  const problems = [];
  const fail = (message) => problems.push(message);

  if (bom === null || typeof bom !== 'object') return ['the document is not an object'];

  if (bom.bomFormat !== 'CycloneDX')
    fail(`bomFormat must be "CycloneDX", got ${JSON.stringify(bom.bomFormat)}`);
  if (bom.specVersion !== '1.6') fail(`specVersion must be "1.6", got ${JSON.stringify(bom.specVersion)}`);
  if (!Number.isInteger(bom.version) || bom.version < 1) fail('version must be a positive integer');
  if (typeof bom.serialNumber !== 'string' || !SERIAL_NUMBER.test(bom.serialNumber)) {
    fail(`serialNumber must be a urn:uuid, got ${JSON.stringify(bom.serialNumber)}`);
  }

  const metadata = bom.metadata;
  if (metadata === null || typeof metadata !== 'object') {
    fail('metadata is missing');
  } else {
    const root = metadata.component;
    if (root === null || typeof root !== 'object') fail('metadata.component is missing');
    else {
      if (!COMPONENT_TYPES.has(root.type))
        fail(`metadata.component.type is not a CycloneDX type: ${root.type}`);
      if (typeof root.name !== 'string' || root.name === '') fail('metadata.component.name is missing');
      if (typeof root['bom-ref'] !== 'string' || root['bom-ref'] === '') {
        fail('metadata.component.bom-ref is missing');
      }
    }
    if (metadata.lifecycles !== undefined && !Array.isArray(metadata.lifecycles)) {
      fail('metadata.lifecycles must be an array');
    }
  }

  const components = bom.components;
  if (!Array.isArray(components)) {
    fail('components must be an array');
    return problems;
  }

  const refs = new Set();
  if (typeof bom.metadata?.component?.['bom-ref'] === 'string') refs.add(bom.metadata.component['bom-ref']);
  for (const [index, component] of components.entries()) {
    const where = `components[${index}]`;
    if (component === null || typeof component !== 'object') {
      fail(`${where} is not an object`);
      continue;
    }
    if (!COMPONENT_TYPES.has(component.type))
      fail(`${where}.type is not a CycloneDX type: ${component.type}`);
    if (typeof component.name !== 'string' || component.name === '') fail(`${where}.name is missing`);
    if (typeof component.version !== 'string' || component.version === '')
      fail(`${where}.version is missing`);
    const ref = component['bom-ref'];
    if (typeof ref !== 'string' || ref === '') fail(`${where}.bom-ref is missing`);
    else if (refs.has(ref)) fail(`${where}.bom-ref is duplicated: ${ref}`);
    else refs.add(ref);
    if (component.scope !== undefined && !SCOPES.has(component.scope)) {
      fail(`${where}.scope is not a CycloneDX scope: ${component.scope}`);
    }
    if (component.purl !== undefined && !PURL.test(component.purl)) {
      fail(`${where}.purl is not a package URL: ${component.purl}`);
    }
    for (const [h, hash] of (component.hashes ?? []).entries()) {
      const expected = HASH_ALGORITHMS.get(hash?.alg);
      if (expected === undefined) {
        fail(`${where}.hashes[${h}].alg is not a CycloneDX algorithm: ${hash?.alg}`);
        continue;
      }
      if (typeof hash.content !== 'string' || !new RegExp(`^[0-9a-f]{${expected}}$`).test(hash.content)) {
        fail(`${where}.hashes[${h}].content is not a ${expected}-character hex digest`);
      }
    }
    for (const [p, property] of (component.properties ?? []).entries()) {
      if (typeof property?.name !== 'string') fail(`${where}.properties[${p}].name is missing`);
    }
    for (const [e, reference] of (component.externalReferences ?? []).entries()) {
      if (typeof reference?.url !== 'string' || reference.url === '') {
        fail(`${where}.externalReferences[${e}].url is missing`);
      }
      if (typeof reference?.type !== 'string') fail(`${where}.externalReferences[${e}].type is missing`);
    }
  }

  const dependencies = bom.dependencies;
  if (dependencies !== undefined) {
    if (!Array.isArray(dependencies)) fail('dependencies must be an array');
    else {
      const seen = new Set();
      for (const [index, record] of dependencies.entries()) {
        const where = `dependencies[${index}]`;
        if (typeof record?.ref !== 'string') {
          fail(`${where}.ref is missing`);
          continue;
        }
        if (!refs.has(record.ref)) fail(`${where}.ref names no component: ${record.ref}`);
        if (seen.has(record.ref)) fail(`${where}.ref is declared twice: ${record.ref}`);
        seen.add(record.ref);
        for (const target of record.dependsOn ?? []) {
          if (!refs.has(target)) fail(`${where}.dependsOn names no component: ${target}`);
        }
      }
    }
  }

  return problems;
}

describe('CycloneDX 1.6 output', () => {
  /** @type {Record<string, unknown>} */
  let bom;

  before(() => {
    // Generate rather than read whatever a previous run left behind: the claim in
    // sbom.mjs is about what the generator produces now.
    const res = spawnSync(process.execPath, [join(HERE, 'sbom.mjs')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(res.status, 0, `the SBOM gate failed:\n${res.stdout}${res.stderr}`);
    bom = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
  });

  it('is structurally valid', () => {
    const problems = validateCycloneDx16(bom);
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  it('describes the whole graph, not a fragment of it', () => {
    // A validator is happy with an empty document. The SBOM's purpose is incident
    // response, so "it parses" is not the assertion that matters.
    assert.ok(bom.components.length > 100, `only ${bom.components.length} components`);
    assert.ok(
      bom.components.filter((c) => Array.isArray(c.hashes) && c.hashes.length > 0).length > 100,
      'most components must carry the integrity hash that names the exact artefact',
    );
    assert.ok(bom.dependencies.length > 100, `only ${bom.dependencies.length} dependency records`);
  });

  it('regenerates byte-identically from an unchanged graph', () => {
    // The generator derives its serial number from the graph and writes no
    // timestamp, so a diff of this file is a diff of the dependencies.
    const first = readFileSync(OUT_PATH, 'utf8');
    const res = spawnSync(process.execPath, [join(HERE, 'sbom.mjs')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(res.status, 0);
    assert.equal(readFileSync(OUT_PATH, 'utf8'), first);
  });
});

describe('the validator can fail', () => {
  const valid = () => ({
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: 'urn:uuid:9e1ff9ca-f049-46d2-8399-6c83f7eb7204',
    version: 1,
    metadata: { component: { type: 'application', 'bom-ref': 'pkg:npm/root@1.0.0', name: 'root' } },
    components: [
      {
        type: 'library',
        'bom-ref': 'pkg:npm/fastify@5.11.3',
        name: 'fastify',
        version: '5.11.3',
        purl: 'pkg:npm/fastify@5.11.3',
        scope: 'required',
        hashes: [{ alg: 'SHA-512', content: 'a'.repeat(128) }],
      },
    ],
    dependencies: [{ ref: 'pkg:npm/root@1.0.0', dependsOn: ['pkg:npm/fastify@5.11.3'] }],
  });

  it('accepts a minimal valid document, so the negative cases mean something', () => {
    assert.deepEqual(validateCycloneDx16(valid()), []);
  });

  for (const [what, mutate, expected] of [
    ['a wrong specVersion', (b) => (b.specVersion = '1.5'), /specVersion/],
    ['a missing serial number', (b) => (b.serialNumber = undefined), /serialNumber/],
    ['an unknown component type', (b) => (b.components[0].type = 'widget'), /type is not a CycloneDX type/],
    ['a missing component version', (b) => (b.components[0].version = undefined), /version is missing/],
    ['a duplicated bom-ref', (b) => b.components.push({ ...b.components[0] }), /bom-ref is duplicated/],
    [
      'an unknown hash algorithm',
      (b) => (b.components[0].hashes[0].alg = 'MD5'),
      /not a CycloneDX algorithm/,
    ],
    ['a truncated digest', (b) => (b.components[0].hashes[0].content = 'abc'), /hex digest/],
    ['a malformed purl', (b) => (b.components[0].purl = 'fastify'), /not a package URL/],
    [
      'a dangling dependency ref',
      (b) => b.dependencies[0].dependsOn.push('pkg:npm/ghost@1.0.0'),
      /names no component/,
    ],
    ['an unknown scope', (b) => (b.components[0].scope = 'sometimes'), /not a CycloneDX scope/],
  ]) {
    it(`rejects ${what}`, () => {
      const broken = valid();
      mutate(broken);
      const problems = validateCycloneDx16(broken);
      assert.ok(problems.length > 0, `${what} was accepted`);
      assert.match(problems.join('\n'), expected);
    });
  }
});
