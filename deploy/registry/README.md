# The promotion registry

A loopback OCI registry, opt-in, that turns the release artefacts from images this
machine can identify into images another machine can **fetch**.

## The blocker this closes

`pnpm run release:artifacts` records the digest BuildKit's exporter assigns in the
local image store. That value is a content address and it has always been honest,
but it names bytes that exist on exactly one machine.
`docs/production/final-readiness-report.md` carried the consequence as an open
residual: *the release images are identified only by a local BuildKit digest, so
they cannot be promoted across machines*. `docker-compose.staging.yml` said the
same thing from the other side — `pull_policy: never`, because a pull would have
gone to Docker Hub for a repository called `prl-api` that belongs to somebody
else.

What was missing was not a better digest. It was a place to put it.

```bash
docker compose -f deploy/registry/docker-compose.registry.yml up -d
pnpm run release:artifacts -- --push
pnpm run staging up          # now deploys the registry digests, pull_policy always
pnpm run staging promote     # now reports the artefacts as promotable across machines
```

and back out again:

```bash
docker compose -f deploy/registry/docker-compose.registry.yml down            # keep the artefacts
docker compose -f deploy/registry/docker-compose.registry.yml down --volumes  # forget them
```

**None of this is required.** With no registry running, `release:artifacts`,
`staging up`, `staging status` and `staging promote` behave exactly as they did
before: local digests, `pull_policy: never`, and a `promote` that says
cross-machine promotion is not available and how to make it so. That is the common
case and it is not allowed to regress; `scripts/staging.test.mjs` has a test
asserting precisely that path.

---

## What a push proves, and how each step is measured

`--push` does not merely run `docker push`. Every step below is a way the claim
"another machine can fetch this exact artefact" could quietly be false.

| # | Step | Why it is not assumed |
| --- | --- | --- |
| 1 | Read the digest from the **push output** | It is the registry's own answer. |
| 2 | Cross-check `docker image inspect {{.RepoDigests}}` against it | Measured disagreeing — see below. |
| 3 | GET the manifest from the registry over HTTP and **re-hash it here** | Turns "the registry said so" into arithmetic. |
| 4 | Tie those bytes to the local build digest | Same manifest, or the config blob the local id names. |
| 5 | Remove every local reference and **pull back by digest** | The reference has to resolve through the registry. |

If any step fails, no registry block is written and the manifest keeps saying what
it has always said. A half-recorded promotion is worse than none.

### Step 2 exists because `RepoDigests` was measured lying

Pushing a multi-architecture image to a local registry, 2026-08-25:

```
$ docker push 127.0.0.1:5099/probe:t1
t1: digest: sha256:fa647fc1e5d5df7d8d923fb6332aab8e78783f8fca1a1394efb4011f68f5a793 size: 1917
 Info -> Not all multiplatform-content is present and only the available single-platform image was pushed
         sha256:a3d8aaa63ed8…415373 -> sha256:fa647fc1e5d5…f5a793

$ docker image inspect 127.0.0.1:5099/probe:t1 --format '{{json .RepoDigests}}'
["127.0.0.1:5099/probe@sha256:a3d8aaa63ed8…415373", …]
```

The registry holds `fa647fc1…`. `RepoDigests` reports `a3d8aaa6…`, the digest of
the local multi-platform index, which that registry has never seen. A pipeline
that recorded the inspect value would have written a reference that resolves to
nothing on the machine it was promoted to — the exact failure a registry digest is
supposed to remove. So the push output is the authority and a disagreement is a
release-blocking failure with that explanation attached.

The two agree for this repository's own images, because they are single-platform
builds pushed unchanged, and that agreement is checked rather than assumed.

---

## The round trip, demonstrated

### On the release artefacts

```
$ pnpm run release:artifacts -- --push
Push → 127.0.0.1:5001
  ✓ api pushed to 127.0.0.1:5001/prl-api:091d67ac39ce-dirty
      sha256:7d3f6c23454db65db856376e838d1c3a6917a207226877d1759f7a7a142cac17
      registry manifest re-fetched and re-hashed here (manifest-digest); 1 local reference(s) to it
      removed, then pulled back by digest and the image that came back is sha256:7d3f6c23454d…
  ✓ web pushed to 127.0.0.1:5001/prl-web:091d67ac39ce-dirty
      sha256:aa894fcfab4157a8ce5bd864cf9d6aaafa447f4ed70c114cc6cc2ba23bd320a3
      …
```

The local BuildKit digest and the registry digest are the **same value** for these
images — `7d3f6c23…` before the push and `7d3f6c23…` after it. That is not a
coincidence to wave at, it is the property being checked: docker transferred the
manifest bytes unchanged, and the registry independently re-derived the same
content address from them. Verified by hand, without docker in the loop:

```
$ curl -s -D - -H 'Accept: application/vnd.oci.image.index.v1+json' \
    http://127.0.0.1:5001/v2/prl-api/manifests/sha256:7d3f6c23…cac17 -o man.json
HTTP/1.1 200 OK
Content-Type: application/vnd.oci.image.index.v1+json
Docker-Content-Digest: sha256:7d3f6c23454db65db856376e838d1c3a6917a207226877d1759f7a7a142cac17

$ shasum -a 256 man.json
7d3f6c23454db65db856376e838d1c3a6917a207226877d1759f7a7a142cac17  man.json
```

The bytes the registry serves under that digest hash to that digest, computed
outside docker entirely.

### Cold, on a throwaway image, where the bytes really move

On the machine that built an image, a pull-by-digest is served from the local
content store: it proves the reference resolves, and it would be dishonest to call
it proof of transfer. So the transfer was demonstrated separately, on an image
built for the purpose (`FROM scratch` plus one unique file, so nothing about it
can already exist anywhere):

```
$ docker build -t 127.0.0.1:5001/prl-roundtrip-probe:cold --iidfile iid.txt .
$ cat iid.txt
sha256:0168f3bda7c6c0e9c22febe5d4d5087c5b4b924a7b1098a71eac8fe195cdb94f

$ docker push 127.0.0.1:5001/prl-roundtrip-probe:cold
f2c72bf365a5: Pushed
cold: digest: sha256:0168f3bda7c6c0e9c22febe5d4d5087c5b4b924a7b1098a71eac8fe195cdb94f size: 855

$ docker rmi 127.0.0.1:5001/prl-roundtrip-probe:cold
Untagged: 127.0.0.1:5001/prl-roundtrip-probe:cold
Deleted: sha256:0168f3bda7c6c0e9c22febe5d4d5087c5b4b924a7b1098a71eac8fe195cdb94f

$ docker image inspect sha256:0168f3bda7c6…cdb94f
Error: No such image                       # genuinely gone from the local store

$ docker pull 127.0.0.1:5001/prl-roundtrip-probe@sha256:0168f3bda7c6…cdb94f
f2c72bf365a5: Download complete
521edd38a420: Pull complete
Status: Downloaded newer image for 127.0.0.1:5001/prl-roundtrip-probe@sha256:0168f3bda7c6…cdb94f

$ docker image inspect 127.0.0.1:5001/prl-roundtrip-probe@sha256:0168f3bda7c6…cdb94f --format '{{.Id}}'
sha256:0168f3bda7c6c0e9c22febe5d4d5087c5b4b924a7b1098a71eac8fe195cdb94f
```

Deleted locally, fetched back from the registry by digest, byte-identical
identity. That is the cross-machine property with the machine boundary replaced by
an empty local store, which is the same boundary from the artefact's point of
view.

### Why a digest pull cannot return different bytes

Because the registry will not store different bytes under an existing digest. Not
an argument — a measurement, made by taking the manifest above, changing one
character of whitespace, and offering it back under the original digest:

```
$ curl -X PUT -H 'Content-Type: application/vnd.oci.image.index.v1+json' \
    --data-binary @tampered.json \
    http://127.0.0.1:5001/v2/prl-roundtrip-probe/manifests/sha256:0168f3bda7c6…cdb94f
{"errors":[{"code":"DIGEST_INVALID","message":"provided digest did not match uploaded content"}]}
HTTP 400

$ curl -s .../manifests/sha256:0168f3bda7c6…cdb94f | shasum -a 256
0168f3bda7c6c0e9c22febe5d4d5087c5b4b924a7b1098a71eac8fe195cdb94f   # unchanged
```

A registry that accepted that would be a broken registry, and the pull side checks
the hash again anyway. This is why `pull_policy: always` is safe here while it
would not be for a tag: a tag is a pointer somebody can repoint, and a digest is
the content itself.

---

## What this does NOT prove, precisely

This is the part to read before quoting any of the above in a release note.

- **A push signs nothing.** Everything on this page is about content identity. The
  signatures are a separate command with a separate record —
  `pnpm run release:sign` writes `deploy/staging/release-signatures.json`, and
  `pnpm run security:image-provenance` verifies it against the committed public key
  — so a digest that has been pushed and not signed is exactly as unverifiable as
  it was before. *(This bullet used to read "cosign is not installed in this
  environment". That stopped being true on 2026-08-25.)*
- **Still no transparency log entry.** Signing uses `--tlog-upload=false` and
  verification `--insecure-ignore-tlog`, because Rekor is a public log and this is
  a loopback registry holding a lab artefact. So there is no third-party record
  that a signature existed at a time.
- **Still no provenance in the SLSA sense.** The manifest records a commit sha, a
  Docker version and a timestamp because this repository wrote them there; the
  signature adds a key this repository also controls. Both are this repository
  vouching for itself. Nothing binds the artefact to a source tree, a builder, or
  a build environment in a way an outsider could check — that is what a signed
  SLSA provenance predicate emitted by the BUILDER exists to do, and keyless/OIDC
  signing is what makes the identity in it mean anything. See
  [`../signing/README.md`](../signing/README.md).
- **The registry is not a third party.** It is a container on this host with no
  authentication and no TLS, published on loopback. It can prove two parties hold
  the same bytes; it cannot say where those bytes came from, and anything that can
  reach it can push over any tag it likes. Digests are unaffected by that — a
  pushed tag cannot change what an existing digest resolves to — which is exactly
  why the pipeline promotes digests and not tags.
- **It is not durable.** `down --volumes` deletes every artefact ever pushed. The
  release manifest keeps working (the local digests are still there); what stops
  working is the cross-machine claim, and `staging up` and `staging promote` both
  re-check the registry rather than trusting a recorded reference, so they say so
  instead of failing obscurely.
- **It is not a deployment target.** `staging promote` still only verifies. There
  is no production environment in this repository to promote *to*.

- **It carries the signatures, and does not vouch for them.** `cosign` stores a
  signature as another object in the same repository, under a `sha256-<digest>`
  tag. Because the registry is unauthenticated, anything that can reach it can
  write those tags too — which is why negative control 3 in
  [`../signing/README.md`](../signing/README.md) transplants a valid signature
  onto a different image and gets a 201. It is refused at verification, by the
  digest inside the signed payload, and not by the registry.

The honest one-line summary, updated 2026-08-25: **content identity across a
push/pull boundary is proven, and each digest is now signed by a key this
repository controls and checked by `pnpm run security:image-provenance`. What is
still absent is provenance bound to a BUILDER — a keyless/OIDC signature from a
CI workload identity, with a transparency log behind it.**

---

## The container itself

See the comments in `docker-compose.registry.yml` for the reasoning behind each
line. The two that surprise people:

- **Port 5001, not 5000.** macOS AirPlay Receiver holds 5000
  (`lsof -nP -iTCP:5000 -sTCP:LISTEN` → `ControlCe`), and a registry published
  there fails pushes with somebody else's 403.
- **It runs as root inside the container** — the only container in this repository
  that does. Measured: with `user: 65532:65532` the registry starts, answers
  `/v2/` with 200, and then cannot write a blob (`Unavailable`, `error from
  registry: unknown error`), because docker initialises a fresh named volume from
  the image's own root-owned `/var/lib/registry`. The alternative is a root helper
  container to chown the volume — a second root process to avoid one. The trade
  taken instead is `cap_drop: ALL`, `no-new-privileges`, a read-only root
  filesystem, and loopback-only publishing, on a build tool that is not part of
  the deployment being rehearsed.
