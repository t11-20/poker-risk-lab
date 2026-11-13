#!/usr/bin/env node
/**
 * Tests for the release-signature library. They cover every way the repo could report "the release
 * images are signed" while it is false. cosign's cryptography is not re-tested. The live three-refusal
 * control is `scripts/supply-chain/image-provenance.mjs --negative-control`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ATTESTATION_PREDICATE_TYPE,
  attestationProblems,
  COSIGN_KEYLESS_SIGN_FLAGS,
  COSIGN_SIGN_FLAGS,
  COSIGN_VERIFY_FLAGS,
  keylessVerifyFlags,
  parseAttestationStatements,
  parseSignatureRecord,
  publicKeyFingerprint,
  reconcileWithManifest,
  SIGNATURES_SCHEMA,
  verifiedDigests,
} from './image-signing.mjs';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const FINGERPRINT = 'f'.repeat(64);

const goodRecord = () => ({
  schema: SIGNATURES_SCHEMA,
  signedAt: '2026-08-25T00:00:00.000Z',
  registry: '127.0.0.1:5001',
  publicKey: { path: 'deploy/signing/cosign.pub', fingerprint: FINGERPRINT },
  images: {
    api: {
      service: 'api',
      repository: 'prl-api',
      buildDigest: DIGEST_A,
      registryDigest: DIGEST_A,
      reference: `127.0.0.1:5001/prl-api@${DIGEST_A}`,
      signed: true,
      attestation: { components: 18 },
    },
  },
});

const manifestWith = (images) => ({ schema: 'prl.release-artifacts.v1', images });

describe('parseSignatureRecord', () => {
  it('accepts a well-formed record', () => {
    const { images, meta, problems } = parseSignatureRecord(goodRecord());
    assert.deepEqual(problems, []);
    assert.equal(images.length, 1);
    assert.equal(images[0].buildDigest, DIGEST_A);
    assert.equal(meta.publicKeyFingerprint, FINGERPRINT);
  });

  it('refuses a record that names no images', () => {
    // `Object.entries({})` iterates zero times, so an empty record must not pass.
    const record = goodRecord();
    record.images = {};
    const { problems } = parseSignatureRecord(record);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /names no images/);
  });

  it('refuses an unknown schema rather than guessing at the shape', () => {
    const record = goodRecord();
    record.schema = 'prl.release-signatures.v99';
    const { problems, images } = parseSignatureRecord(record);
    assert.equal(images.length, 0);
    assert.match(problems[0], /schema/);
  });

  it('refuses a TAG reference where a digest reference belongs', () => {
    // A tag would verify whatever it points at during verification.
    const record = goodRecord();
    record.images.api.reference = '127.0.0.1:5001/prl-api:4320f1c4ad21';
    const { problems } = parseSignatureRecord(record);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not a registry digest reference/);
  });

  it('refuses an entry that does not claim to be signed', () => {
    const record = goodRecord();
    record.images.api.signed = false;
    const { problems, images } = parseSignatureRecord(record);
    assert.equal(images.length, 0);
    assert.match(problems[0], /nothing claims this was signed/);
  });

  it('refuses a record with no public key fingerprint', () => {
    const record = goodRecord();
    record.publicKey = {};
    const { problems } = parseSignatureRecord(record);
    assert.ok(problems.some((p) => /publicKey\.fingerprint/.test(p)));
  });

  it('refuses a digest that is not a digest', () => {
    const record = goodRecord();
    record.images.api.buildDigest = 'sha256:not-a-digest';
    const { problems, images } = parseSignatureRecord(record);
    assert.equal(images.length, 0);
    assert.match(problems[0], /buildDigest is not a sha256 digest/);
  });
});

describe('reconcileWithManifest — the tie cosign cannot make', () => {
  const signature = { service: 'api', buildDigest: DIGEST_A };

  it('matches when the signed digest is the digest the build recorded', () => {
    const { problems, matched } = reconcileWithManifest(
      [signature],
      manifestWith({ api: { digest: DIGEST_A } }),
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(matched, ['api']);
  });

  it('refuses a signature over a DIFFERENT, correctly-signed image', () => {
    // Every cosign check passes here, because the signature is valid over another artefact.
    const { problems, matched } = reconcileWithManifest(
      [signature],
      manifestWith({ api: { digest: DIGEST_B } }),
    );
    assert.deepEqual(matched, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /is not the artefact this commit produced/);
  });

  it('refuses a release image that has no signature entry at all', () => {
    // The blocker in its original form: an unsigned release image.
    const { problems } = reconcileWithManifest(
      [signature],
      manifestWith({ api: { digest: DIGEST_A }, web: { digest: DIGEST_B } }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /is in the release manifest and is NOT signed/);
  });

  it('refuses a signature for a service the manifest does not describe', () => {
    const { problems } = reconcileWithManifest(
      [signature, { service: 'ghost', buildDigest: DIGEST_B }],
      manifestWith({ api: { digest: DIGEST_A } }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /the release manifest does not describe/);
  });

  it('refuses a manifest with no images rather than passing over an empty loop', () => {
    const { problems } = reconcileWithManifest([signature], manifestWith({}));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /names no images/);
  });
});

describe('verifiedDigests', () => {
  it('reads the digest back out of the signed payload', () => {
    const stdout = JSON.stringify([
      { critical: { image: { 'docker-manifest-digest': DIGEST_A } }, optional: {} },
    ]);
    assert.deepEqual(verifiedDigests(stdout).digests, [DIGEST_A]);
  });

  it('refuses an exit-0 run that reported no signatures', () => {
    const result = verifiedDigests('[]');
    assert.deepEqual(result.digests, []);
    assert.match(result.problem, /reported no signatures/);
  });

  it('refuses output that is not JSON', () => {
    assert.match(verifiedDigests('Verification for … --').problem, /not JSON/);
  });
});

describe('attestationProblems', () => {
  const statement = (overrides = {}) => ({
    _type: 'https://in-toto.io/Statement/v0.1',
    predicateType: ATTESTATION_PREDICATE_TYPE,
    subject: [{ name: '127.0.0.1:5001/prl-api', digest: { sha256: DIGEST_A.replace('sha256:', '') } }],
    predicate: { components: [{ name: 'busybox' }] },
    ...overrides,
  });

  it('accepts a CycloneDX statement whose subject is the image being verified', () => {
    const { problems, components } = attestationProblems(statement(), DIGEST_A);
    assert.deepEqual(problems, []);
    assert.equal(components, 1);
  });

  it('refuses an attestation whose subject is a different artefact', () => {
    const { problems } = attestationProblems(statement(), DIGEST_B);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /describes a different artefact/);
  });

  it('refuses an attestation over an EMPTY predicate', () => {
    // `cosign attest` signs `{}` and it verifies.
    const { problems, components } = attestationProblems(statement({ predicate: {} }), DIGEST_A);
    assert.equal(components, 0);
    assert.match(problems[0], /zero components/);
  });

  it('reads the predicate type from the signed payload, not from the flag we passed', () => {
    const { problems } = attestationProblems(
      statement({ predicateType: 'https://slsa.dev/provenance/v1' }),
      DIGEST_A,
    );
    assert.match(problems[0], /predicateType/);
  });
});

describe('parseAttestationStatements', () => {
  it('decodes the base64 in-toto payload', () => {
    const payload = Buffer.from(JSON.stringify({ predicateType: 'x' })).toString('base64');
    const { statements, problem } = parseAttestationStatements(`${JSON.stringify({ payload })}\n`);
    assert.equal(problem, null);
    assert.equal(statements[0].predicateType, 'x');
  });

  it('refuses an exit-0 run that printed nothing', () => {
    assert.match(parseAttestationStatements('').problem, /printed nothing/);
  });

  it('refuses a bundle with no payload', () => {
    assert.match(parseAttestationStatements('{"foo":1}').problem, /no base64 payload/);
  });
});

describe('publicKeyFingerprint', () => {
  const pem =
    '-----BEGIN PUBLIC KEY-----\n' +
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEeyppUOZWJri38JLQdQXez5jSnGOE\n' +
    'Px79jUdEdFLeQRAn5N4dX9nSP3OJpu/owuuWXmxIejqz0ygVNXTcuPIsaA==\n' +
    '-----END PUBLIC KEY-----\n';

  it('fingerprints the KEY, not the file', () => {
    const a = publicKeyFingerprint(pem);
    const b = publicKeyFingerprint(pem.replace(/\n/g, '\r\n').trimEnd());
    assert.equal(a.fingerprint, b.fingerprint);
    assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  });

  it('refuses anything that is not a PEM public key', () => {
    assert.match(publicKeyFingerprint('not a key').problem, /BEGIN PUBLIC KEY/);
    assert.match(publicKeyFingerprint('').problem, /empty/);
  });
});

describe('the cosign flag sets', () => {
  it('turn the Sigstore signing config off on both sides', () => {
    // cosign 3 refuses `--tlog-upload=false` unless the TUF signing config is also off.
    assert.ok(COSIGN_SIGN_FLAGS.includes('--use-signing-config=false'));
    assert.ok(COSIGN_SIGN_FLAGS.includes('--tlog-upload=false'));
    assert.ok(COSIGN_VERIFY_FLAGS.includes('--insecure-ignore-tlog'));
  });

  it('never carries a private key path into the verify side', () => {
    // A machine that can check a signature must not be able to mint one.
    assert.ok(!COSIGN_VERIFY_FLAGS.some((flag) => /cosign\.key|--key/.test(flag)));
  });
});

// The keyless flag sets. Before this block the whole suite passed with the identity widened to a
// regexp, the issuer dropped, or the tlog switched off. Pairs are asserted in order, because
// `includes('--certificate-identity')` cannot see a wrong value after it.
describe('the keyless flag sets — who signed, not merely that somebody did', () => {
  const DEMANDED = {
    identity: 'https://github.com/prl/poker-risk-lab/.github/workflows/release-sign.yml@refs/heads/main',
    issuer: 'https://token.actions.githubusercontent.com',
  };

  it('pins the certificate identity to the value it was given, as a literal and not a pattern', () => {
    const flags = keylessVerifyFlags(DEMANDED);
    const at = flags.indexOf('--certificate-identity');
    assert.notEqual(at, -1, 'a keyless verification with no identity is a signature by "somebody"');
    assert.equal(flags[at + 1], DEMANDED.identity, 'the identity flag carries something else');
    // The regexp forms are what a widening looks like, and cosign accepts them happily.
    assert.ok(
      !flags.some((flag) => /^--certificate-identity-regexp$/.test(String(flag))),
      'a regexp identity accepts a workflow in a repository nobody reviewed',
    );
  });

  it('pins the OIDC issuer the same way, because an identity string is not self-authenticating', () => {
    const flags = keylessVerifyFlags(DEMANDED);
    const at = flags.indexOf('--certificate-oidc-issuer');
    assert.notEqual(at, -1, 'without an issuer, any provider may assert any subject');
    assert.equal(flags[at + 1], DEMANDED.issuer);
    assert.ok(!flags.some((flag) => /^--certificate-oidc-issuer-regexp$/.test(String(flag))));
  });

  it('takes both values from its argument, so a record cannot choose what it is compared against', () => {
    // Positive control. A function returning the policy's constants regardless of input would pass above.
    const other = keylessVerifyFlags({
      identity: 'https://example.invalid/x@refs/tags/v9',
      issuer: 'https://idp.invalid',
    });
    assert.equal(
      other[other.indexOf('--certificate-identity') + 1],
      'https://example.invalid/x@refs/tags/v9',
    );
    assert.equal(other[other.indexOf('--certificate-oidc-issuer') + 1], 'https://idp.invalid');
  });

  it('never turns the transparency log off on either side of the keyless posture', () => {
    // `deploy/signing/keyless-policy.json` requires the transparency log.
    for (const flag of keylessVerifyFlags(DEMANDED)) {
      assert.ok(!/tlog|transparency/i.test(String(flag)), `keyless verify must not carry ${flag}`);
    }
    for (const flag of COSIGN_KEYLESS_SIGN_FLAGS) {
      assert.ok(!/tlog|transparency/i.test(String(flag)), `keyless signing must not carry ${flag}`);
    }
    // Both sets must have been read.
    assert.ok(keylessVerifyFlags(DEMANDED).length >= 4);
    assert.ok(COSIGN_KEYLESS_SIGN_FLAGS.length >= 1);
  });

  it('carries no key material into the keyless path at all', () => {
    // A `--key` here would mean keyless had become keyed.
    for (const flag of [...keylessVerifyFlags(DEMANDED), ...COSIGN_KEYLESS_SIGN_FLAGS]) {
      assert.ok(!/cosign\.key|^--key$/.test(String(flag)));
    }
  });
});
