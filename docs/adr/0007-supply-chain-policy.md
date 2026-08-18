# ADR 0007 — Release-blocking supply-chain gates

**Status:** Accepted · **Date:** 2026-08-17

## Context

At the time of writing, the "Mini Shai-Hulud" campaign has compromised on the order of
1,300 npm package versions across ~2 billion monthly downloads, propagating through
package-manager lifecycle scripts and forging Sigstore provenance attestations. It writes
persistence into `.claude/setup.mjs` and `.vscode/tasks.json` so that opening a project
re-runs the payload. Full snapshot: `docs/security/shai-hulud-snapshot-2026-08-17.md`.

## Decision

Eight gates, all release-blocking, all runnable with `pnpm run security:audit`:

1. **policy-in-effect** — asserts the policy is actually active
2. **repo-hygiene** — source encoding and hidden characters
3. **deny-list** — banned packages anywhere in the graph
4. **dependency-shapes** — registry-only resolutions, no install scripts, exact versions
5. **IOC sweep** — campaign artefacts in the tree *and* the installed store
6. **integrity + release age** — lockfile hashes cross-checked against the registry
7. **OSV** — known vulnerabilities
8. **SBOM** — CycloneDX 1.6 with per-artefact hashes

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
