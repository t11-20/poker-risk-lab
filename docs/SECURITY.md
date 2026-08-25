# Security

**Last reviewed:** 2026-08-17

Companion to `docs/THREAT-MODEL.md`, which covers *what* is being defended and against
whom. This document is the operational half: the rules contributors must follow, the gates
that enforce them, and what to do when something goes wrong.

---

## 1. Reporting a vulnerability

This is a portfolio/education project with no production deployment. If you find something,
open an issue describing the impact and a reproduction, and mark it clearly. Do not include
working credentials or live tokens in the report.

## 2. The supply-chain policy

**Read this before touching `package.json`.** The full rationale is in ADR 0007 and the
advisory snapshot the controls were built against is
`docs/security/shai-hulud-snapshot-2026-08-17.md`.

### The one thing most likely to trip you up

**pnpm 11 reads only auth and registry settings from `.npmrc`.** Every other setting —
`ignoreScripts`, `minimumReleaseAge`, `verifyStoreIntegrity`, `saveExact` — must live in
`pnpm-workspace.yaml`. Put a policy key in `.npmrc` and it is **silently ignored**: the
repository looks hardened while being wide open.

`scripts/supply-chain/policy-check.mjs` exists because of this. It does not read a file; it
asks pnpm for its *effective* configuration and asserts on that, and it **fails** if a
policy key appears in `.npmrc` at all — a setting sitting where it is ignored is worse than
one that is absent, because it reads as protection.

### The rules

| Rule | Enforced by |
| --- | --- |
| Lifecycle scripts never run | `ignoreScripts: true`, `onlyBuiltDependencies: []`, `dangerouslyAllowAllBuilds: false` |
| No version published in the last 7 days | `minimumReleaseAge: 10080` |
| Exact versions only, no ranges | `saveExact: true` + `dependency-shapes` gate |
| Registry resolutions only — no git, tarball, CDN or `file:` | `dependency-shapes` gate |
| Lockfile hashes match the registry | `provenance` gate |
| No denied package anywhere in the graph | `deny-list` gate |
| No known vulnerability in any resolved version | `osv-scan` gate |
| No campaign IOC on disk | `ioc-scan` gate |
| Every GitHub Action pinned to a 40-hex commit SHA, never a tag | `ci-pinning` gate |
| Every container base image pinned by `@sha256:` digest | `ci-pinning` gate |
| No workflow file this repository has not declared | `ci-pinning` gate |
| Frozen lockfile in CI | `pnpm install --frozen-lockfile` |
| `node_modules` matches the lockfile before any script runs | `verifyDepsBeforeRun: error` |

Banned outright, at every version: `keyv`, `cacheable`, `flat-cache`,
`file-entry-cache`, `cacheable-request`, `cache-manager`, `@cacheable/*`, `@antv/*`,
`echarts-for-react`, `size-sensor`, `timeago.js`, `jest-canvas-mock`.

Also banned: `npx`, `pnpm dlx`, remote installer pipes (`curl … | bash`), and any tool
fetched at build time rather than pinned.

### Adding a dependency

```bash
pnpm run deps:quarantine      # resolve in a throwaway dir with a scrubbed environment
git diff -- pnpm-lock.yaml    # review every added line
pnpm install --frozen-lockfile
pnpm run security:audit       # all fourteen gates must pass
```

`deps:quarantine` resolves in a temporary directory with a throwaway `HOME`, no `.git`, no
source, no `.env`, and an environment stripped to `PATH`/`LANG`/`TMPDIR`. Resolution is the
moment credentials are exposed, so it happens where there is nothing worth stealing.

A dependency that declares an install script requires **human approval and a hermetic
review**, recorded in an ADR. There is no flag that bypasses this.

### Provenance is evidence, not proof

The Mini Shai-Hulud campaign **forges Sigstore attestations**. The audit records
attestation state for incident response, but no gate relies on it and a missing attestation
is not a failure. Treating "has provenance" as "is safe" would be exactly the wrong lesson
from this campaign.

### Release images: two signing postures, and which claim each one supports

A release image is signed one of two ways, and `pnpm run security:image-provenance` verifies
whichever posture the signature record is actually in. It refuses a record in **neither** —
that is what an unsigned release looks like, and "absent" must never be read as "the other
posture, presumably" — and refuses a record claiming both.

| Posture | Signed by | Verified against | What it establishes |
| --- | --- | --- | --- |
| **key** | a long-lived cosign key on the release machine | `deploy/signing/cosign.pub` | **possession of a key.** Anybody who can read the key and its passphrase can sign anything. No transparency log, so compromise is not detectable after the fact |
| **keyless** | `.github/workflows/release-sign.yml`, via a ten-minute Fulcio certificate | the identity and issuer in `deploy/signing/keyless-policy.json`, plus Rekor | **the identity of a builder** — a named workflow file, in a named repository, on a named ref. No long-lived secret exists to steal |

The thing to understand about the keyless posture before quoting it: a keyless signature
verifies against *some* Fulcio certificate, and **Fulcio issues one to anybody's GitHub
Actions job.** What makes it provenance is that the verifier demands a specific
`--certificate-identity` and `--certificate-oidc-issuer`, taken from the committed policy and
never from the record being checked. A verification that omits them accepts a signature made
by a workflow in a repository nobody has heard of. `pnpm run security:keyless` holds the
policy and the workflow to the same answer, so a rename, a retrigger onto another ref, or an
`id-token: write` grant appearing in any other workflow fails a gate rather than silently
widening what is accepted.

**Status: the keyless posture is implemented and UNEXERCISED.** Every release image today is
in the key posture. No run of the signing workflow has happened, so no Fulcio certificate and
no Rekor entry exist for this repository. `deploy/signing/README.md` is the long form.

## 3. Secure coding rules

These are the rules a reviewer will actually check.

### Hidden information

* **`redactFor()` is the only way state leaves the server.** Never serialise a `HandState`.
* Redaction **constructs** a `PlayerView`; it does not delete fields from a clone. Adding a
  field to the client's view is a deliberate two-place change. See ADR 0003.
* Never log a card, a deck, a salt, or a hole-card array.
* Any change to `redact.ts` or `commitment.ts` triggers a threat-model review.

### Randomness

* Cards come only from `createSecureRandom()`. `Math.random` is banned in **every** first-party
  `src/` tree — **eight** of them: `apps/api`, `apps/web` and the six packages — not just engine
  and server code. `pnpm run security:hygiene` scans them all and prints what it covered:

  ```
  · scanned <N> source files across 8 src/ trees for Math.random
  ```

  **Read that line, not a number in this document.** `N` moves with every file added — it changed
  twice in one afternoon while this paragraph was being written — and a constant copied into a
  document is a number nobody re-derives. The tree count is the part worth asserting, because a
  tree disappearing from the scan is how a ban quietly stops covering something. The scan has its
  own test proving it can fail. The ban was once enforced over two of those trees by per-package
  tests, which is why it is a repository gate now.
* Index selection uses rejection sampling (`unbiasedInt`). `x % n` on a 32-bit draw is not
  uniform, and for a 52-card deck the low indices would be favoured.
* `createDeterministicRandomForTests` throws under `NODE_ENV=production`, and any hand it
  deals is permanently labelled in `randomSourceKind`.

### Trust

* Never accept a client's claim about game state. A client may express intent only.
* Re-derive the legal action set server-side on every submission. The client's rendered
  buttons are a convenience, never an authorisation.
* Every mutating action carries an idempotency key **and** an expected sequence. Both are
  needed; they defend different failures.

### Data handling

* **Never store a secret in the clear.** Session tokens, invite codes, OIDC
  `state`/`nonce`/PKCE verifier, IPs and user agents are all stored hashed.
* **Never persist the deck or the salts.** There is no column for them, and the migration
  says so in a comment. Do not add one.
* All SQL goes through the `postgres` driver's tagged templates, which parameterise by
  construction. The only permitted `.unsafe()` use is whole-file DDL in the migration
  runner.
* Compare secrets in constant time (`crypto.timingSafeEqual`) on their hashes.

### Input

* Every request body, query and socket frame is validated by a **closed** JSON Schema
  (`additionalProperties: false`). An open schema is how mass-assignment bugs happen.
* Every string has a `maxLength`; every number a `minimum` and `maximum`. Unbounded input
  is how a request becomes a denial of service.
* `redirectAfter` accepts a **path only** — never an absolute or protocol-relative URL. A
  sign-in flow is the classic place an open redirect is weaponised.

### Output

* Never return an internal error message, stack trace or SQL fragment. Log the detail
  server-side, return `internal_error` with a request id.
* "Not found" and "not permitted" return the **same** response for rooms. A
  distinguishable answer lets anyone enumerate private tables.
* `Cache-Control: no-store` on every authenticated response.

### Logging

* Redact: cookies, `authorization`, `set-cookie`, `x-csrf-token`, session tokens, invite
  codes, OIDC codes and tokens, and any key matching
  `/token|secret|password|cookie|authorization|invite/i`.
* Do not log raw IPs — log a keyed hash.
* Do not log user-supplied text (display names, room names).

## 4. Running the gates

```bash
pnpm run security:audit          # all fourteen supply-chain gates
pnpm run security:audit -- --offline   # skip the three network gates — EXITS 2, see below

pnpm run security:policy         # is the policy actually in effect?
pnpm run security:hygiene        # source encoding, hidden characters
pnpm run security:denylist       # banned packages
pnpm run security:shapes         # resolution shapes, install scripts, exact versions
pnpm run security:ioc            # Shai-Hulud IOC sweep
pnpm run security:secrets        # committed credentials, and the ignore rules that prevent them
pnpm run security:pinning        # CI actions by commit SHA, base images by digest
pnpm run security:provenance     # lockfile ↔ registry integrity, release age
pnpm run security:osv            # OSV.dev vulnerabilities
pnpm run security:sbom           # CycloneDX 1.6 SBOM
pnpm run security:containers     # trivy against the built release images
pnpm run security:image-provenance  # are those images signed — and by WHICH posture?
pnpm run security:keyless        # does the keyless identity policy match the workflow?
```

**`--offline` exits 2, deliberately.** It skips *integrity + release age*, *OSV* and
*container image CVEs*, prints `3 network gate(s) skipped — NOT a valid release audit`, and
then exits non-zero. It used to exit 0, which is the defect: an audit that did not run three
of its gates is indistinguishable, to anything reading only the exit code, from one that ran
all eleven and passed. Exit 2 rather than 1 so a caller can still tell "skipped" from "a gate
failed".

This section said *two* network gates and pasted a `2 network gate(s) skipped` transcript,
which was true when the container scan did not exist. There are three, and the container scan
is skipped by `--offline` even on a machine with no release images: `audit.mjs` evaluates the
offline branch before the artefact branch, so the gate is reported as **skipped** — which
exits 2 — rather than as *not applicable*, which would not. Re-captured 2026-08-25:

```
$ node scripts/supply-chain/audit.mjs --offline; echo $?
Summary
  ✓ pass     policy in effect
  ✓ pass     source encoding hygiene
  ✓ pass     denied packages
  ✓ pass     dependency shapes
  ✓ pass     Shai-Hulud IOC sweep
  ✓ pass     committed credentials
  ✓ pass     CI + container pinning
  ✓ pass     keyless signing identity
  ✓ pass     log policy
  ○ skipped  integrity + release age
  ○ skipped  OSV vulnerabilities
  ✓ pass     SBOM generation
  ○ skipped  container image CVEs
  ✓ pass     release image signatures

3 network gate(s) skipped — NOT a valid release audit.
2
```

Re-captured again on 2026-08-25 when the keyless-identity gate was added. Note which
gates the offline run still executes: *keyless signing identity* reads a committed policy
and the committed workflows, and *release image signatures* verifies against a loopback
registry and a committed trust anchor. Neither reaches the network, and both are exactly
the checks an air-gapped deployer needs.

Artifacts land in `docs/sbom/`: the SBOM, the OSV report and the provenance report. The
SBOM is content-derived and byte-stable, so `git diff` shows dependency changes rather than
a fresh timestamp.

`security:audit` and `security:hygiene` are **two of the fourteen gates in `pnpm run verify`**, which
is the release gate as a whole (`RUNBOOK.md` §3). They are the first two it runs, and it runs the
other twelve whether or not they pass — a supply-chain failure must not be the reason nobody found out
that the schema check also fails. (This has said *eleven and nine*, then *thirteen and eleven*, and
is now fourteen and twelve: the loop in `package.json` gained `test:ax` and `test:csp`, and then
`test:age-gate`. Do not read the eleven inside `security:audit` as the same number — it was the same
one by coincidence for a while, and is not any more.)

Findings are not waived to unblock a release — fix the dependency, pin an older version, or remove
it. The single escape hatch is an entry in `scripts/supply-chain/osv-allowlist.json`, which requires
a reason and an expiry date and fails the build once it lapses.

## 5. If a compromise is suspected

1. **Rotate everything reachable from CI and from developer machines.** The payload reads
   runner memory, so secrets that were masked in logs are also exposed. GitHub tokens, npm
   tokens, cloud keys, Vault tokens, Kubernetes service accounts.
2. **Sweep for persistence.** `pnpm run security:ioc` checks the working tree and the
   installed store for the known artefacts — including `.claude/setup.mjs` and
   `.vscode/setup.mjs`, which the campaign uses so that opening the project re-runs the
   payload.
3. **Audit your GitHub account** for repositories carrying the campaign fingerprint
   (a description that is the reversed string, or Dune-themed names).
4. **Rebuild from a known-good lockfile.** `rm -rf node_modules && pnpm install
   --frozen-lockfile` after confirming the lockfile itself is clean.
5. **Re-run the full audit** and record what was found in a new dated snapshot under
   `docs/security/`. Do not edit the existing snapshot — the history is evidence.

## 6. What is deliberately not protected

Listed in full in `docs/THREAT-MODEL.md` §9, with why each is accepted and what would close
it. The headline items:

* A dishonest **operator** can grind a favourable deck before committing. The commitment
  proves the deck was fixed before any action, not that it was chosen fairly.
* **Out-of-band collusion** between players who know each other is undetectable.
* The **accessibility audit does not run a real browser**, because a headless browser needs
  install scripts.
* **A digest pins bytes, not trustworthiness.** As of 2026-08-19 every base image and every
  GitHub Action *is* digest/SHA-pinned and the `ci-pinning` gate fails the release if one is
  not — this bullet used to say the opposite, and the opposite was true. What the gate proves
  is that the reference is immutable and that the reference is one somebody reviewed. It does
  not prove the image or the action was benign when that digest was taken, and it cannot: a
  pinned digest of a compromised artefact is pinned to the compromise. The control it buys is
  that an upstream cannot change what runs here without a diff in this repository.
* **Nothing re-checks a pin for a newly disclosed advisory.** OSV covers npm packages only.
  An advisory against `node:24.18.0-alpine3.24` or a pinned action surfaces through
  whatever watches those ecosystems, which today is a human.
