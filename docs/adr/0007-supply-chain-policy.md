# ADR 0007 — Release-blocking supply-chain gates

**Status:** Accepted · **Date:** 2026-08-17

## Context

At the time of writing, the "Mini Shai-Hulud" campaign has compromised on the order of
1,300 npm package versions across ~2 billion monthly downloads, propagating through
package-manager lifecycle scripts and forging Sigstore provenance attestations. It writes
persistence into `.claude/setup.mjs` and `.vscode/tasks.json` so that opening a project
re-runs the payload. Full snapshot: `docs/security/shai-hulud-snapshot-2026-08-17.md`.

## Decision

Eleven gates, all release-blocking, all runnable with `pnpm run security:audit`. This ADR was
written when there were nine; gates 6 and 11 were added later, and the list is kept in the
audit's own order so that it can be read against the `GATES` array in
`scripts/supply-chain/audit.mjs`:

1. **policy-in-effect** — asserts the policy is actually active
2. **repo-hygiene** — source encoding and hidden characters
3. **deny-list** — banned packages anywhere in the graph
4. **dependency-shapes** — registry-only resolutions, no install scripts, exact versions
5. **IOC sweep** — campaign artefacts in the tree *and* the installed store
6. **committed credentials** — a secret scan of the working tree; `--history` is opt-in and
   is not run here, because a finding whose only remedy is a history rewrite would turn the
   release audit permanently red
7. **CI + container pinning** — GitHub Actions by commit SHA, base images by digest
8. **integrity + release age** — lockfile hashes cross-checked against the registry
9. **OSV** — known vulnerabilities
10. **SBOM** — CycloneDX 1.6 with per-artefact hashes
11. **container image CVEs** — trivy against the built release images

The order is the audit's own: gates 1–7 need no network, 8 and 9 do, 10 writes the artefact,
and 11 needs both the network and a built image. `--offline` skips 8, 9 and 11 — the offline
branch is evaluated before the artefact branch, so the container gate is reported as skipped
rather than as not-applicable — and then **exits 2**, because an audit that did not run its
gates has not passed. It used to exit 0, which made the skip indistinguishable from a clean
release audit in any pipeline that only reads the exit code.

Gate 11 is the one gate whose scope is not the repository: it reads the images
`pnpm run release:artifacts` builds, so on a checkout that has not built them it reports
*not applicable* and the summary says in as many words that the audit did not cover container
images. `.github/workflows/release.yml` therefore runs `pnpm run security:containers` as a
named step of its own rather than relying on that inference.

## Amendment 2026-08-19 — CI + container pinning, added after the release audit

The pinning gate was gate 6 when this amendment was written; the secret scan was inserted
ahead of it and it is now gate 7. The other gates hold *this repository's dependencies* to
"no mutable references". The
**pipeline's** dependencies were held to the same standard by nothing but header comments.
`uses: actions/cache@v4` added tomorrow would have passed all eight original gates, and
`actions/cache@v4` is a pointer its owner can repoint at new code that then runs inside this
repository's CI with this repository's secrets. The campaign snapshot lists GitHub Actions
and Docker images among the supply chains it compromised, and records that it hijacks
workflows to mint publish tokens.

`scripts/supply-chain/ci-pinning.mjs` therefore fails on an unpinned `uses:` (anything but a
40-character commit SHA), an unpinned `FROM` or compose `image:` (anything without
`@sha256:`), a floating `runs-on: *-latest`, and — the part that is not about pinning — **a
workflow file nobody declared**, because `.github/workflows/codeql.yml` is a named campaign
IOC: the worm injects a workflow whose name squats on one a reviewer expects to see. Adding
a workflow is now a two-file diff.

Measured 2026-08-19: `2 workflow(s), 24 action reference(s), 2 Dockerfile(s) with 2 external
base image(s), 1 compose file(s) with 2 image reference(s)` — pass. The consequence to plan
for is the same friction as the npm policy: bumping an action is a digest change, not a tag
change, and the digest has to be looked up.

## The finding that shaped the implementation

**pnpm 11 reads only auth and registry settings from `.npmrc`.** A policy written there —
`ignore-scripts=true`, `minimum-release-age=...` — is *silently ignored*. The repository
would look hardened while being wide open, and nothing would say otherwise.

That is why gate 1 exists, and why it does not read a file: it asks pnpm for its
**effective** configuration and asserts on that, and it separately **fails** if a policy
key appears in `.npmrc` at all, because a setting sitting where it is ignored is worse
than one that is absent — it reads as protection.

## Deliberate choice: provenance is evidence, not proof

The campaign forges Sigstore attestations. The audit records attestation state for
incident response, but the gate does **not** rely on it, and a missing attestation is not
a failure. Treating "has provenance" as "is safe" would be exactly the wrong lesson.

## Deliberate choice: the auditors have no dependencies

Every gate uses only the Node standard library. A supply-chain checker that imports
third-party packages is checking the thing it depends on. This is also why the SBOM
generator and the OSV client are hand-written rather than pulled from npm.

## Consequences

* Adding a dependency is a reviewed event with a 7-day cooldown, and the newest patch is
  frequently *not* installable. Versions are pinned exact and chosen for age.
* Some tooling is unavailable. A headless browser needs install scripts, so the
  accessibility audit is static and says so plainly (`docs/THREAT-MODEL.md` G5).
* `pnpm run deps:quarantine` resolves dependencies in a throwaway directory with a
  throwaway `HOME` and a scrubbed environment, because resolution is the moment of
  credential exposure.
* There is no flag that turns any gate off. The only escape hatch is an OSV allowlist
  entry, which requires a reason and an expiry date, and fails once it lapses.
