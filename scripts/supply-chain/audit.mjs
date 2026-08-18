#!/usr/bin/env node
/**
 * Runs every supply-chain gate and aggregates the result.
 *
 * Each gate runs as its own child process so that one crashing gate cannot
 * prevent the others from reporting, and so that a gate can never accidentally
 * mutate shared state to make a later gate pass.
 *
 * Exit code 0 only if every gate exits 0. This is the release gate.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bold, dim, green, red } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const GATES = [
  { file: 'policy-check.mjs', label: 'policy in effect', network: false },
  { file: 'repo-hygiene.mjs', label: 'source encoding hygiene', network: false },
  { file: 'deny-list.mjs', label: 'denied packages', network: false },
  { file: 'dep-shapes.mjs', label: 'dependency shapes', network: false },
  { file: 'ioc-scan.mjs', label: 'Shai-Hulud IOC sweep', network: false },
  { file: 'provenance.mjs', label: 'integrity + release age', network: true },
  { file: 'osv-scan.mjs', label: 'OSV vulnerabilities', network: true },
  { file: 'sbom.mjs', label: 'SBOM generation', network: false },
];

const offline = process.argv.includes('--offline');
const results = [];

console.log(bold('\nPoker Risk Lab — supply-chain audit'));
console.log(dim(`  ${GATES.length} gates${offline ? ' (offline: network gates skipped)' : ''}\n`));

for (const gate of GATES) {
  if (offline && gate.network) {
    console.log(`${dim('  ○')} ${gate.label} ${dim('— skipped (--offline)')}`);
    results.push({ ...gate, skipped: true, code: 0 });
    continue;
  }
  console.log(bold(`▸ ${gate.label}`));
  const res = spawnSync(process.execPath, [join(HERE, gate.file)], {
    stdio: 'inherit',
    env: process.env,
  });
  const code = res.status === null ? 1 : res.status;
  results.push({ ...gate, skipped: false, code });
  console.log('');
}

const failed = results.filter((r) => r.code !== 0);
const skipped = results.filter((r) => r.skipped);

console.log(bold('Summary'));
for (const r of results) {
  const mark = r.skipped ? dim('○ skipped') : r.code === 0 ? green('✓ pass') : red('✗ FAIL');
  console.log(`  ${mark}  ${r.label}`);
}

if (failed.length > 0) {
  console.log(red(bold(`\n${failed.length} gate(s) failed — this is release-blocking.`)));
  console.log(dim('  Supply-chain findings are never waived to unblock a release. Fix the dependency,'));
  console.log(dim('  pin an older version, or remove it. See docs/SECURITY.md.\n'));
  process.exit(1);
}

if (skipped.length > 0) {
  console.log(dim(`\n${skipped.length} network gate(s) skipped — NOT a valid release audit.\n`));
  process.exit(0);
}

console.log(green(bold('\nAll supply-chain gates passed.\n')));
