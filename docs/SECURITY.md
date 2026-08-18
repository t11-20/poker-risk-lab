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
pnpm run security:audit       # all eight gates must pass
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
  `src/` tree, not just engine and server code — `pnpm run security:hygiene` scans all of them and
  reports what it covered (`scanned 194 source files across 8 src/ trees`, 2026-08-18), and the scan
  has its own test proving it can fail. The ban was once enforced over two of those trees by
  per-package tests, which is why it is a repository gate now.
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
pnpm run security:audit          # all eight supply-chain gates
pnpm run security:audit -- --offline   # skip the network gates (NOT a valid release audit)

pnpm run security:policy         # is the policy actually in effect?
pnpm run security:hygiene        # source encoding, hidden characters
pnpm run security:denylist       # banned packages
pnpm run security:shapes         # resolution shapes, install scripts, exact versions
pnpm run security:ioc            # Shai-Hulud IOC sweep
pnpm run security:provenance     # lockfile ↔ registry integrity, release age
pnpm run security:osv            # OSV.dev vulnerabilities
pnpm run security:sbom           # CycloneDX 1.6 SBOM
```

Artifacts land in `docs/sbom/`: the SBOM, the OSV report and the provenance report. The
SBOM is content-derived and byte-stable, so `git diff` shows dependency changes rather than
a fresh timestamp.

`security:audit` and `security:hygiene` are **two of the eleven gates in `pnpm run verify`**, which
is the release gate as a whole (`RUNBOOK.md` §3). They are the first two it runs, and it runs the
other nine whether or not they pass — a supply-chain failure must not be the reason nobody found out
that the schema check also fails.

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
* **Container base images may not be digest-pinned** where a digest could not be verified
  at authoring time; those are marked `TODO` rather than filled with a fabricated digest.
