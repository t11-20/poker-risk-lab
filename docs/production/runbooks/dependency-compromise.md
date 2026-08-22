# Dependency compromise

A package in the dependency graph is malicious, has been taken over, or is suspected of either.

The controls this repository already carries are unusually strong for its size — exact pins, a frozen lockfile, lifecycle scripts disabled, an IOC sweep, a deny list, dependency-shape checks, an SBOM and an OSV scan. This runbook assumes those held and asks what to do when something gets past them anyway.

Reference: `docs/adr/0007-supply-chain-policy.md`, `docs/security/shai-hulud-snapshot-2026-08-17.md`, `docs/audit/supply-chain-audit.md`.

---

## Symptoms

- An advisory, a registry takedown, or a report naming a package in the graph.
- `pnpm run security:audit` fails on the deny list, the IOC sweep, dependency shapes, or OSV.
- An unexpected lockfile change in a diff nobody made.
- A build or a container reaching the network when it should not.
- A published version that does not match its source repository.

## Detection

```bash
pnpm run security:audit         # every gate, in order
pnpm run security:denylist      # known-bad packages and versions
pnpm run security:ioc           # indicator sweep, including the Shai-Hulud family
pnpm run security:shapes        # lifecycle scripts, binaries, unexpected shapes
pnpm run security:osv           # published vulnerabilities
pnpm run security:sbom          # regenerate and compare the component graph
pnpm run security:containers    # image CVE scan
```

The gates run in CI on every commit and on a daily schedule, so the realistic detection paths are a scheduled run turning red, or an external report arriving before the scanners know about it.

## Immediate containment

**Stop shipping first.** In order:

1. **Freeze deployments.** Nothing goes to production until the graph is understood. A compromised dependency in a built image is already inside the artefact.
2. **Stop CI from installing.** A malicious package typically acts during install. Lifecycle scripts are already disabled — both Dockerfiles pass `--ignore-scripts` explicitly and CI does too — but a package can still act when it is first *imported*.
3. **Establish whether it is in a built image.** Tags lie; digests do not. List the digests currently deployed and the digests of everything built since the suspect version was published.
4. **Quarantine the package:**

```bash
pnpm run deps:quarantine        # the repo's own containment tool
```

**Do not** run `pnpm install` to "see what happens", and **do not** run `pnpm update`. Both fetch and execute. If you need to inspect a version, fetch the tarball and read it without installing.

**Do not** delete the lockfile. It is the record of exactly what was installed, and it is the primary evidence for what the blast radius was.

## Diagnosis

### 1. Is it actually in the graph, and how?

```bash
pnpm why <package>
grep -n '<package>' pnpm-lock.yaml
```

Direct dependency, or transitive? Transitive is more common and harder: the fix is usually an override or a bump of the direct parent, not of the package itself.

### 2. Was the compromised version ever installed here?

The lockfile pins exact versions with integrity hashes. So this is answerable rather than a guess:

```bash
git log -p --follow pnpm-lock.yaml | grep -n -A3 -B3 '<package>'
```

If the pinned version predates the compromise, the graph was never exposed and this is a "do not upgrade" situation rather than an incident. **That is the most likely outcome and it is worth establishing before anything else** — exact pinning exists precisely to make this question answerable in a minute.

### 3. What could it have reached?

| Where it ran | Reach |
| --- | --- |
| A developer machine | that developer's environment, including `.env` and any credentials → [leaked-secret.md](leaked-secret.md) |
| CI | the workflow's token and secrets. CI runs with `permissions: contents: read` and no secrets, which bounds this severely |
| A built image | whatever the container can reach at runtime: the database credential, the session secret, learner data |
| Not installed | nothing |

Least privilege is doing real work here: CI has no publish rights, no registry credentials and nothing to steal beyond the source, which is not secret.

### 4. Is it in the running images?

```bash
pnpm run security:sbom                       # regenerate for the current graph
trivy image --format json <image@sha256:...> # or: pnpm run security:containers
```

Compare the SBOM against the one recorded for the digest that is deployed. The SBOM is per build, so this is a comparison rather than an inference.

### 5. Did anything actually execute?

Lifecycle scripts are disabled, so the realistic execution paths are import-time code in a package the application actually loads, or a build-time plugin. A package present in the graph but never imported did not run — establish which it is rather than assuming the worse case, and say which you established.

## Recovery

1. **Remove or pin away from the compromised version.** Bump the direct parent, add an override, or drop the dependency. Bumping the direct parent is the durable fix; an override is a stopgap that must be tracked.
2. **Regenerate the lockfile deliberately**, with `--frozen-lockfile` in every subsequent install so the change is a reviewed diff rather than a drift.
3. **Re-run every gate.** All of them, not the one that fired.
4. **Rebuild every artefact.** A rebuilt image is the only way the fix reaches production; a patched source tree changes nothing about a running container. New digests, through the normal pipeline.
5. **Rotate anything the package could have reached** → [leaked-secret.md](leaked-secret.md). If it ran anywhere with credentials, rotate them; do not reason your way out of it.
6. **Add it to the deny list** so a future bump cannot reintroduce it silently.
7. **Redeploy by digest**, and verify the deployed digest is the rebuilt one.

## Verification

```bash
# 1. Every supply-chain gate passes, on the fixed tree.
pnpm run security:audit

# 2. The package is gone, or pinned to a safe version. Both checks, not one.
pnpm why <package> || echo "not in the graph"
grep -n '<package>' pnpm-lock.yaml

# 3. A frozen install reproduces exactly the intended graph.
pnpm install --frozen-lockfile --ignore-scripts

# 4. The SBOM reflects the fixed graph, and the image scan is clean at the severity floor.
pnpm run security:sbom
pnpm run security:containers

# 5. The rebuilt image is what is actually deployed. Digests, never tags.
docker image inspect <image> --format '{{index .RepoDigests 0}}'

# 6. The application still works.
pnpm run test
pnpm run test:smoke --strict
```

Step 5 is the one that is skipped and the one that decides whether any of this reached production.

## Escalation

Escalate when:

- The compromised version was ever installed anywhere with access to real credentials or learner data.
- The package executed — import-time or build-time — rather than merely being present.
- A built image that reached production contains it.
- The lockfile changed without a corresponding reviewed commit. That is a compromise of the change process, which is worse than the package.
- Removing it is not possible without a functional change to the product, which is a decision with a product owner, not an on-call one.

The incident record must state: the package and version, whether it was ever installed here and on what evidence, what executed, which digests contain it, what was rotated, and which gate should have caught it and why it did not. That last question is the one that improves the next outcome.
