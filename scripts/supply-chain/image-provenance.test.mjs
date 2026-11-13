#!/usr/bin/env node
/**
 * Tests for the release-image signature gate: the states in which it must refuse to run. The pure
 * library decisions are in `scripts/image-signing.test.mjs`. `--negative-control` needs a loopback
 * `registry:2`, so it is run by hand and not from here.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SIGNATURES_SCHEMA } from '../image-signing.mjs';
import { REPO_ROOT } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'image-provenance.mjs');

/** Runs the gate with paths pointed at a scratch directory, so nothing real is consulted. */
function runGate(args) {
  const result = spawnSync(process.execPath, [GATE, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const scratch = () => mkdtempSync(join(tmpdir(), 'prl-provenance-test-'));

describe('argument parsing', () => {
  it('refuses an unknown option instead of ignoring it', () => {
    // An ignored flag is how somebody believes they ran a stricter check than they did.
    const { status, out } = runGate(['--require-attestations']);
    assert.equal(status, 1);
    assert.match(out, /unknown option/);
  });

  it('prints help and exits 0', () => {
    const { status, out } = runGate(['--help']);
    assert.equal(status, 0);
    assert.match(out, /verify the release images are signed/);
  });
});

describe('refusals — every one of these used to be indistinguishable from a pass', () => {
  it('FAILS when there is no signature record', () => {
    // The unsigned state. Treating an absent record as "not applicable" would let deleting it turn
    // the gate green.
    const dir = scratch();
    const manifest = join(dir, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ images: { api: { digest: `sha256:${'a'.repeat(64)}` } } }));
    const { status, out } = runGate(['--manifest', manifest, '--signatures', join(dir, 'absent.json')]);
    assert.equal(status, 1);
    assert.match(out, /there is no signature record for the release images/);
    assert.match(out, /That IS the unsigned state/);
  });

  it('FAILS when there is no trust anchor', () => {
    // The record is written here because deploy/staging holds no release on CI's runners.
    const dir = scratch();
    const manifest = join(dir, 'manifest.json');
    const signatures = join(dir, 'signatures.json');
    const digest = `sha256:${'a'.repeat(64)}`;
    writeFileSync(manifest, JSON.stringify({ images: { api: { digest } } }));
    writeFileSync(
      signatures,
      JSON.stringify({
        schema: SIGNATURES_SCHEMA,
        registry: '127.0.0.1:5001',
        publicKey: { fingerprint: '0'.repeat(64) },
        images: {
          api: {
            service: 'api',
            repository: 'prl-api',
            buildDigest: digest,
            registryDigest: digest,
            reference: `127.0.0.1:5001/prl-api@${digest}`,
            signed: true,
          },
        },
      }),
    );
    const { status, out } = runGate([
      '--manifest',
      manifest,
      '--signatures',
      signatures,
      '--public-key',
      join(dir, 'absent.pub'),
    ]);
    assert.equal(status, 1);
    assert.match(out, /there is no trust anchor to verify against/);
  });

  it('FAILS on a signature record that names no images', () => {
    const dir = scratch();
    const manifest = join(dir, 'manifest.json');
    const signatures = join(dir, 'signatures.json');
    writeFileSync(manifest, JSON.stringify({ images: { api: { digest: `sha256:${'a'.repeat(64)}` } } }));
    writeFileSync(
      signatures,
      JSON.stringify({
        schema: SIGNATURES_SCHEMA,
        publicKey: { fingerprint: 'f'.repeat(64) },
        images: {},
      }),
    );
    const { status, out } = runGate(['--manifest', manifest, '--signatures', signatures]);
    assert.equal(status, 1);
    assert.match(out, /names no images/);
  });

  it('FAILS when the committed key is not the key the record was signed with', () => {
    const dir = scratch();
    const manifest = join(dir, 'manifest.json');
    const signatures = join(dir, 'signatures.json');
    const digest = `sha256:${'a'.repeat(64)}`;
    writeFileSync(manifest, JSON.stringify({ images: { api: { digest } } }));
    writeFileSync(
      signatures,
      JSON.stringify({
        schema: SIGNATURES_SCHEMA,
        registry: '127.0.0.1:5001',
        publicKey: { fingerprint: '0'.repeat(64) },
        images: {
          api: {
            service: 'api',
            repository: 'prl-api',
            buildDigest: digest,
            registryDigest: digest,
            reference: `127.0.0.1:5001/prl-api@${digest}`,
            signed: true,
          },
        },
      }),
    );
    const { status, out } = runGate(['--manifest', manifest, '--signatures', signatures]);
    assert.equal(status, 1);
    assert.match(out, /is NOT the key these signatures were made with/);
  });

  it('FAILS when a release image has no signature entry', () => {
    // The sidecar is internally perfect and covers only one of the two images that ship.
    const dir = scratch();
    const manifest = join(dir, 'manifest.json');
    const signatures = join(dir, 'signatures.json');
    const digest = `sha256:${'a'.repeat(64)}`;
    writeFileSync(
      manifest,
      JSON.stringify({ images: { api: { digest }, web: { digest: `sha256:${'b'.repeat(64)}` } } }),
    );
    const fingerprint = spawnSync(
      process.execPath,
      [
        '-e',
        "import('./scripts/image-signing.mjs').then((m) => " +
          'process.stdout.write(m.readPublicKey().fingerprint))',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ).stdout;
    writeFileSync(
      signatures,
      JSON.stringify({
        schema: SIGNATURES_SCHEMA,
        registry: '127.0.0.1:5001',
        publicKey: { fingerprint },
        images: {
          api: {
            service: 'api',
            repository: 'prl-api',
            buildDigest: digest,
            registryDigest: digest,
            reference: `127.0.0.1:5001/prl-api@${digest}`,
            signed: true,
          },
        },
      }),
    );
    const { status, out } = runGate(['--manifest', manifest, '--signatures', signatures]);
    assert.equal(status, 1);
    assert.match(out, /is in the release manifest and is NOT signed/);
  });
});
