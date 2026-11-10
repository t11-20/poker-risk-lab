# Unverified release image

`pnpm run security:image-provenance` failed, or a deployment is about to run an image whose
signature nobody has checked.

The ordinary causes are boring — nobody has signed yet, somebody rotated a key, the registry is
down — and [`deploy/signing/README.md` § When verification fails](../../../deploy/signing/README.md)
walks those in order. **This file is for the case where the boring causes have been ruled out**: the
digest is the one the release manifest records, the registry holds it, the committed key is the key
the record names, and the signature still does not verify. That combination means the bytes in the
registry are not the bytes this repository signed.

Reference: `deploy/signing/README.md`, `deploy/registry/README.md`,
`docs/production/final-readiness-report.md` residual 3.

---

## Symptoms

- `pnpm run security:image-provenance` exits 1 with `is NOT signed by the committed key` on a digest
  that IS in the release manifest.
- `the signature payload names a different artefact` — cosign verified a signature whose signed
  statement is about some other digest.
- `the signed digest is not resolvable` while the registry is demonstrably up and serving other
  repositories.
- `the SBOM attestation cannot be trusted` — the attested inventory's subject is not this image.
- `pnpm run security:audit` red on **release image signatures**.

## Detection

```bash
pnpm run security:image-provenance --json     # which image, which digest, which check
node scripts/supply-chain/image-provenance.mjs --negative-control   # is the VERIFIER sound?
```

Run the negative control before believing the failure. It generates an ephemeral key, stages two
throwaway images, and requires three refusals **and one acceptance**. If the positive control also
fails, the problem is cosign, the registry or the environment — not the artefact — and you are about
to chase the wrong thing.

Then look at the artefact directly:

```bash
# What the release manifest says was built.
node -e "const m=require('./deploy/staging/release-manifest.json');
         for (const [s,i] of Object.entries(m.images)) console.log(s, i.digest)"

# What the registry actually holds under that digest, hashed OUTSIDE docker.
curl -s -H 'Accept: application/vnd.oci.image.manifest.v1+json,application/vnd.oci.image.index.v1+json' \
  http://127.0.0.1:5001/v2/prl-api/manifests/sha256:<digest> | shasum -a 256

# Every tag in the repository. An unexpected one is somebody else's push.
curl -s http://127.0.0.1:5001/v2/prl-api/tags/list
```

## Immediate containment

**Do not deploy the image, and do not re-sign it to make the gate green.** Re-signing an artefact you
cannot account for is signing an unknown, and it destroys the only evidence that something was wrong.

1. **Stop the promotion.** Nothing goes to staging or production on an unverified digest. `pnpm run
   staging up` deploys manifest digests; leave the running stack alone until the digest is
   understood (it is already running the previously-verified bytes).
2. **Freeze the registry state.** Do not `down --volumes`, do not prune, do not re-push. The
   registry contents are the evidence.
3. **Treat the signing key as suspect until shown otherwise.** A valid signature over an artefact
   you did not build means either the registry was written by someone else *or* the key was used by
   someone else. The second is much worse and cannot be ruled out from the artefact alone. Follow
   [`leaked-secret.md`](leaked-secret.md) for the key in parallel with this.

## Diagnosis

Three questions, in this order. Each one narrows what happened.

### 1. Is the digest the one this repository built?

Compare `deploy/staging/release-manifest.json` against
`deploy/staging/release-signatures.json`. The gate already does this, and the failure text names both
values. If they differ, nothing was tampered with — something rebuilt without re-signing, or the
sidecar was edited. Re-sign and move on; this is not an incident.

### 2. Does the registry serve bytes that hash to that digest?

The gate re-fetches the manifest over HTTP and re-hashes it in process
(`verifyRegistryDigest` in `scripts/registry-digest.mjs`). If that check is the one that failed, the
registry is serving content under a digest it does not match, which is the one thing a registry is
defined by not doing. Treat the registry, or anything in front of it, as compromised.

### 3. Is the signature over this digest, or over another one?

`provided artifact digest does not match any digest in statement` is a **transplant**: a real
signature made over some other image, copied onto this one's `sha256-<digest>` tag. The lab registry
is unauthenticated and accepts that PUT with a 201 — this is exactly negative control 3, and it means
someone with network access to the registry wrote to it. It does *not* by itself mean the key leaked;
the transplanted signature was valid for its own subject.

`accepted signatures do not match threshold` with the right key and the right digest is the serious
one: a signature exists, and it is not this key's. Somebody signed this artefact with something else.

## Recovery

1. **Establish what should be there.** Rebuild from the recorded commit in a clean checkout:
   `pnpm run release:artifacts --force`. If the digests come out equal to the manifest's, the source
   tree is intact and the problem is downstream of the build.
2. **If the key is suspect, rotate it** — `deploy/signing/README.md` § Rotation — and re-sign
   everything that must stay verifiable. Do this before re-populating the registry, so nothing is
   ever signed with a key under suspicion.
3. **Re-populate the registry from the local build**, then sign and verify:

   ```bash
   pnpm run release:sign
   pnpm run security:image-provenance
   node scripts/supply-chain/image-provenance.mjs --negative-control
   ```

4. **If a transplant was found, assume anything else in that registry may have been written too.**
   Digests are unaffected — a push cannot change what an existing digest resolves to — but tags and
   signature tags can be. Re-verify every artefact you intend to keep.

## Verification

Not done until all four are true:

```bash
pnpm run security:image-provenance                                  # exit 0
node scripts/supply-chain/image-provenance.mjs --negative-control    # three refusals, one acceptance
pnpm run security:containers                                        # the artefact is also scanned
pnpm run security:audit                                             # the whole gate set, in one run
```

And one thing a command cannot check: the digests in
`deploy/staging/release-signatures.json` are the digests you expect, read by a person against the
build you believe happened.

## Escalation

Page if any of these hold, because each one means a control failed rather than a step being missed:

- the registry served bytes that do not hash to their digest;
- a signature verified against a key that is not the committed one;
- a transplanted signature was found (someone wrote to the registry);
- the private key or its passphrase cannot be accounted for.

For the last, [`leaked-secret.md`](leaked-secret.md) is the runbook and rotation is mandatory rather
than precautionary.

**What this incident cannot tell you**, and it is worth saying at the point somebody wants a
conclusion: these signatures carry no transparency log
(`--tlog-upload=false` / `--insecure-ignore-tlog`, see `deploy/signing/README.md`). There is no
third-party record of when a signature was made, so you cannot establish whether a signature predates
a suspected compromise. The answer to "when was this signed" is only ever this repository's own
record of it. That is the residual keyless/OIDC signing in CI exists to close, and it is not closed
here.
