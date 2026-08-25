# Release image signing

The key material that binds a release digest to this repository, and the procedures around it:
custody, rotation, and what to do when a verification fails.

```bash
pnpm run release:sign               # push + sign + attest.  NEEDS the private key.
pnpm run security:image-provenance  # verify.  Needs ONLY deploy/signing/cosign.pub.
```

## The blocker this closes

`docs/production/final-readiness-report.md` carried it as open residual 3:

> **Images carry a registry digest but no signature.** `release:artifacts --push` publishes to a
> registry and the round trip is proven — the manifest is re-fetched and re-hashed in process, and
> every local reference is deleted and pulled back by digest before the ids are compared. So content
> identity across a push/pull boundary holds, and cross-machine promotion works. What does not exist
> is **provenance**: nothing is signed, there is no transparency log, and a local registry is not a
> third party.

Content identity answers *"do two machines hold the same bytes"*. It does not answer *"are these the
bytes this repository built"*. The lab registry has no authentication — `deploy/registry/README.md`
says so plainly — so anything that can reach `127.0.0.1:5001` can push under `prl-api`, and a
deployer pulling by digest would get exactly the bytes they named with no way at all to tell whose
they were.

---

## The three files, and which one is committed

| File | Committed? | What it is |
| --- | --- | --- |
| `deploy/signing/cosign.pub` | **Yes** | The trust anchor. The only thing verification needs. |
| `deploy/signing/cosign.key` | **Never** | The signing key. Whoever holds it can mint signatures the gate accepts. |
| `deploy/signing/signing.env` | **Never** | `COSIGN_PASSWORD`, the passphrase that unlocks the key. |

Both secret paths are in `.gitignore`, and `scripts/supply-chain/secret-scan.mjs` **asserts those
ignore rules exist** — not that the files are absent, which is trivially true on a machine that never
had them, but that `git check-ignore --no-index` matches the paths whether anything is there or not.
That check exists because `deploy/backup/backup.env` was matched by no ignore rule at all until
somebody looked, and one `git add -A` on a backup host would have committed the key that decrypts
every archive. This is the same shape of file on the same kind of host.

A leaked *verification* key is a non-event. A leaked *signing* key is worse than it first looks: it
does not expose any data, it silently converts the gate into decoration. Everything stays green.

---

## Custody

- **The private key never leaves the release machine.** It is not in the repository, not in CI, not
  in a shared password manager entry that half the team can read. If it has to be backed up, back it
  up somewhere with an access log, and treat reading it as an event.
- **The passphrase lives beside it, in `signing.env`, mode 0600.** That is deliberately not a
  security boundary — anyone who can read one file can read the other. What it buys is that a key
  file copied off the machine on its own is not immediately usable, and that the passphrase never
  appears in shell history or in a process listing.
- **`pnpm run release:sign` refuses to prompt.** If `COSIGN_PASSWORD` is unset it exits non-zero
  with an explanation. An unattended prompt is a hung release.
- **Verification never touches any of this.** `pnpm run security:image-provenance` reads
  `cosign.pub` and nothing else, by design: a machine that can *check* a signature must not be able
  to *mint* one. That is why signing and verifying are two scripts rather than two flags on one.

### Creating the keypair

```bash
pnpm run release:sign --generate-key
git add deploy/signing/cosign.pub     # the PUBLIC half, and only the public half
```

It refuses to overwrite an existing key, passphrase file, or public key. Replacing a signing key
invalidates every signature ever made with it, and doing that as a side effect of a command is how a
release ends up green over signatures nobody can verify.

---

## Rotation

Rotation is a procedure with a re-signing step in it, not a file write. In order:

```bash
# 1. Move the old material aside. Do not delete it yet — you may need it to identify
#    what an old signature was, and deleting it before step 4 passes is irreversible.
mv deploy/signing/cosign.key deploy/signing/cosign.key.retired
mv deploy/signing/cosign.pub deploy/signing/cosign.pub.retired
mv deploy/signing/signing.env deploy/signing/signing.env.retired

# 2. New keypair.
pnpm run release:sign --generate-key

# 3. Re-sign every artefact that must remain verifiable. There is no way to
#    "re-point" an existing signature at a new key: a signature is over a digest by a key.
pnpm run release:sign

# 4. Verify against the NEW committed key before committing anything.
pnpm run security:image-provenance

# 5. Commit the new public key and the regenerated signature record together.
#    They are one change: a public key without matching signatures fails the gate,
#    and matching signatures without the public key cannot be checked.
git add deploy/signing/cosign.pub deploy/staging/release-signatures.json
```

**Rotate when:** the machine holding the key is decommissioned or reimaged; anybody who had access
to it leaves; the key or passphrase is copied anywhere you did not intend; or you cannot answer
"who can read this file today" with a short list of names.

The gate names this case rather than letting it surface as a signature error. If the committed
public key's SPKI fingerprint is not the one `deploy/staging/release-signatures.json` records, it
fails with *"the committed public key is NOT the key these signatures were made with"* and points
here — because the difference between "somebody tampered with an image" and "somebody rotated a key
and forgot step 3" matters enormously at 3am and the raw cosign error does not distinguish them.

---

## When verification fails

`pnpm run security:image-provenance` failing means one of five things. Work down the list; they are
ordered by how likely they are, not by how bad they are.

1. **The images were never signed.** `there is no signature record for the release images`, or a
   service is *"in the release manifest and is NOT signed"*. This is the ordinary case after a fresh
   `pnpm run release:artifacts`. Run `pnpm run release:sign`.
2. **A key was rotated without re-signing.** *"the committed public key is NOT the key these
   signatures were made with"*. Follow Rotation above from step 3.
3. **The registry does not hold the digest.** *"the signed digest is not resolvable"*. The registry
   is down, or `down --volumes` forgot the artefacts. Bring it up and re-push:
   `docker compose -f deploy/registry/docker-compose.registry.yml up -d && pnpm run release:sign`.
4. **The signature record and the release manifest disagree.** *"the signed artefact is not the
   artefact this commit produced"*. Something rebuilt without re-signing, or the sidecar was edited.
   Re-sign; do not edit the sidecar by hand to make the numbers match, which is fixing the report
   rather than the fact.
5. **A signature is genuinely bad.** *"is NOT signed by the committed key"* on a digest that IS in
   the registry and IS the manifest's digest. Treat as an incident and stop:
   [`docs/production/runbooks/unverified-image.md`](../../docs/production/runbooks/unverified-image.md).

---

## Proving the gate refuses

A gate that has never rejected anything is decoration. This one carries its own demonstration:

```bash
node scripts/supply-chain/image-provenance.mjs --negative-control
```

It generates an **ephemeral** keypair in a temp directory (the release key is never read), stages two
throwaway images in the registry, and requires the verifier to reject all three of:

| Control | What is staged | cosign's answer |
| --- | --- | --- |
| An **unsigned** digest | image B, never signed | exit 10, `no signatures found` |
| A **wrong key** | image A signed by the ephemeral key, verified with this repository's key | exit 1, `accepted signatures do not match threshold, Found: 0, Expected 1` |
| A **transplanted signature** | image A's valid signature index PUT onto image B's `sha256-<digest>` tag, which the unauthenticated registry accepts with a 201 | exit 1, `provided artifact digest does not match any digest in statement` |

A control that *passes* fails the gate: the verifier accepted something it must refuse.

The run ends with a **positive** control — image A verified with the ephemeral public key — because
three refusals on their own are equally consistent with a broken cosign, an unreachable registry, or
a typo in the reference. The positive case is what makes them discrimination rather than breakage.

The fourth refusal is not cosign's and is the one that ties any of this to the release:
`reconcileWithManifest` in `scripts/image-signing.mjs` fails unless the signed digest is
byte-identical to the digest `deploy/staging/release-manifest.json` records for that service.
Without it, a sidecar pointing at some *other* correctly-signed image passes every cryptographic
check and the gate reports that the shipping artefacts are signed.

---

## What this does NOT prove

Read this before quoting "the images are signed" anywhere.

- **It proves possession of a key, not the identity of a builder.** The key is a long-lived file on
  the release machine. Anybody who can read it and its passphrase can sign anything, and the gate
  cannot tell the difference — that is what "possession of a key" means. **Keyless/OIDC signing** is
  the thing that closes this: Fulcio issues a short-lived certificate bound to a workload identity —
  a named GitHub Actions workflow, in a named repository, on a named ref — and the verifier then
  demands `--certificate-identity` and `--certificate-oidc-issuer` rather than a key. The claim
  changes from *"somebody who had the key"* to *"this workflow, in this repository, at this commit"*,
  and no long-lived secret exists to steal. This repository has **no CI signing identity**, so that
  is a residual and is recorded as one.
- **There is no transparency log.** Signing uses `--tlog-upload=false` and verification uses
  `--insecure-ignore-tlog`, because Rekor is a *public* log and this is a loopback registry holding a
  lab artefact. cosign prints a warning on every verification saying exactly that, and this
  repository does not suppress it. The cost, stated rather than implied: there is no third-party
  record that a signature existed at a time, so **key compromise is not detectable after the fact**
  and a signature cannot be shown to predate a revocation. Log-backed signing is what turns "this
  key signed it" into "this key signed it before it was revoked, and here is a witness".
- **The SBOM attestation is about contents, not origin.** `cosign attest --type cyclonedx` binds a
  trivy inventory of the image to the image's digest by signature, so the inventory cannot be swapped
  for a friendlier one. It says what is *inside* the artefact. What *built* it is a different
  question and needs a SLSA provenance predicate emitted by the builder itself.
- **The registry is not a third party.** It is an unauthenticated container on this host. It can
  prove two parties hold the same bytes; it vouches for nothing. The signature is what makes the
  difference, and the signature is verified against a key committed in this repository — so a
  consumer who does not already trust this repository still has nothing independent to check.

The honest one-line summary, and the one the docs use verbatim: **the digest a deployer pulls is now
bound by signature to a key this repository controls; it is not yet bound to a builder anybody else
can check.**
