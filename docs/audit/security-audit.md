# Security & Supply-Chain Audit

**Audit date:** 2026-08-18
**Reviewers:** D (security & multiplayer, offensive testing) and E (supply chain), working
independently and in parallel.

**Evidence standard.** Reviewer D attacked a live API instance it started itself (port 3101,
isolated database `prl_audit_d`) using HTTP and WebSocket clients it wrote itself — the repo's own
security tests were not accepted as evidence. Reviewer E audited the **final resolved dependency
graph** (162 third-party versions), not just direct dependencies, and — critically — built a
sandbox for **every** supply-chain gate and fed it hostile input to establish whether the gate
*can fail at all*.

---

## Part 1 — Application security (Reviewer D)

**Counts: 25 PASS · 0 FAIL · 2 PARTIAL · 1 UNVERIFIED · 0 N/A**

**No P0 and no P1 security issues were found.**

### The P0 objective: hidden information

The audit's primary security objective was to obtain, as another player or as an unauthenticated
attacker, any of: another player's hole cards, future/undealt deck cards, deck RNG material, or
unauthorized table state. **Any leak would be P0.**

Reviewer D seated two independent sessions at one private table and inspected **every frame each
received** against the server's own deal, across REST responses, every WebSocket frame type, error
messages, hand-history and hand-review endpoints, the commitment reveal, logs, reconnect, and the
documented seat-reuse path.

**No leak was found through any channel.**

The Merkle deck commitment behaves exactly as designed: the reveal proves **only** the board plus
the hands that actually showed. Verified in showdown, fold-out, and 3-handed mixed cases — e.g.
3-handed with seat 1 folding `[51,37]`, the reveal contained `board + seats 0 & 2 holes` only, with
the folder's cards absent; salt is emitted solely for public positions. This is the control that
the project's own history records as having been redesigned after a whole-deck commitment was found
to leak folded hands, and the redesign holds under attack.

Redaction is keyed by **`playerId`, not seat index**, constructs a narrow type field-by-field
(fails closed), and is broadcast per-recipient.

Independent corroboration by the lead auditor: `scripts/smoke-test.mjs --strict` scanned 37 live
frames and confirmed *“no socket frame carried a deck, cursor or salt”* and *“no live frame carried
another seat's hole cards mid-hand”*, plus hand-history isolation between two users.

### Attacks attempted and repelled

| Attack surface | Result |
|---|---|
| Session forge / tamper / fixation / replay-after-logout | All rejected |
| Cookie flags | `__Host-` prefix + `Secure` + `HttpOnly` + `SameSite=Lax` confirmed in a **production-mode boot** |
| Authorization: act as another seat, out of turn, in a room never joined | All rejected |
| Private room join without invite | Rejected; uninvited user gets **404, not 403** — the error does not confirm the room exists |
| WebSocket Origin | Foreign, missing, null, empty, lookalike and wrong-port all rejected (close **4406**); cross-site WebSocket hijacking blocked |
| CSRF double-submit | Omission, cross-session reuse, and cross-origin state change all blocked |
| SQL injection | Rejected (parameterised throughout) |
| Prototype pollution (`__proto__`, `constructor`) | Rejected |
| Oversized / malformed / wrong-type / NaN / Infinity / negative / fractional amounts | Rejected |
| Rate limiting | Real, and **not** bypassable via `X-Forwarded-For` |
| Idempotency | Replayed action deduplicated without double-apply |
| Sequence handling | Stale and future sequences rejected |
| Reconnect | State restored correctly, no leak, no session hijack |
| Race conditions (concurrent conflicting actions) | No double-spend; **chips conserved 400 → 400** |

### Multiplayer functional proof
Private multiplayer **completes a full hand to showdown** with two independent cookie jars and
sockets (real frames captured). Disconnect mid-hand → reconnect restores exact state.
Independently corroborated by the lead auditor's load run: 3 concurrent sessions, **5 of 5 hands
completed**, 0 errors.

> **Important scope boundary.** This proves the *server* supports private multiplayer. It does
> **not** mean a user can reach it — see the P1 in `requirements-traceability.md` (PROD-011): the
> web client never displays an invite code and has no join flow.

### Non-PASS items (all P3)
- **SEC-025 (PARTIAL)** — web/RSC hidden information not exercised at runtime (D was restricted to
  the API port). Mitigated by static analysis: `apps/web` has no direct database access and renders
  only already-redacted API data.
- **SEC-027 (PARTIAL)** — timing side-channels not measured (loopback timing is unreliable). Code
  uses `timingSafeEquals` and hash-based token lookup.
- **SEC-026 (UNVERIFIED)** — OIDC flow: the instance is guest-only (`oidcEnabled:false`) and there
  is no IdP to drive start→callback. Code reads as strong (state double-submit, PKCE-hash-before-
  code-spend, single-use attempts). **Marked UNVERIFIED, not PASS.**
- Two notes: a comment in web `api.ts` says `SameSite=Strict` while the server correctly sets
  `Lax`; and any room member (not only the owner) may `startHand` — acceptable for invite-only
  rooms, but worth confirming as intent.

---

## Part 2 — Supply chain (Reviewer E)

**Counts: 12 PASS · 3 FAIL · 4 PARTIAL · 0 UNVERIFIED · 0 N/A**

Network was available, so both network-backed gates produced real results; nothing was skipped for
lack of connectivity.

### The dependency graph itself is clean — and this was verified upstream, not just in format

- 162 resolved third-party versions; **zero** OSV advisories (independently confirmed with
  `pnpm audit`: 0/162).
- **Zero** `preinstall`/`install`/`postinstall` hooks across **all 162** — E checked the 104 on disk
  itself and fetched the other 58 platform-skipped manifests from the registry rather than assuming.
- Every acquisition from `registry.npmjs.org`; every lockfile integrity hash matches what the
  registry serves today; no git, tarball or `file:` dependencies; no `npx`/`dlx`.
- Youngest package 8.3 days against a 7-day cooldown.
- The `packageManager` sha256 matches the pnpm 11.10.0 tarball E downloaded and hashed; all 3 CI
  action SHAs match `git ls-remote`; all 3 container image digests match Docker Hub.
- SBOM regenerates **byte-identical**, is 100 % complete against both lockfile and disk, and
  validates against the real CycloneDX 1.6 schema.
- Container security (verified by Reviewer G at runtime): all five capability sets empty,
  `NoNewPrivs=1`, read-only rootfs proven by a failed write, non-root uid read from `id` **inside**
  the container, no secrets in any layer.

**On the facts, this dependency graph is safe to ship.** There is no P0 here.

### But four of the gates protecting it cannot fail

This is the substantive supply-chain finding, and it exists only because E built negative controls
the repo does not have.

**SUP-015 — FAIL (P1). `dep-shapes.mjs:50-66` cannot fail.** All six “no git/tarball/directory
dependency” lockfile patterns **miss** when fed a git and a directory resolution written in the
format pnpm actually emits — proven **0/6 matches**. pnpm writes `resolution: {...}` inline on one
line, so the four line-anchored patterns are unreachable; pnpm records git as
`repo: github.com/...` with no `git+ssh://` scheme, so that pattern misses too. This is the control
the repo's own threat model names against the campaign's documented delivery **Pattern B**.

**SUP-016 — FAIL (P1). The store-reading checks pass while inspecting nothing.** With no
`node_modules`, the install-time lifecycle-hook scan — the control against delivery **Pattern A** —
reports `✓ dependency-shapes — pass` having examined **zero** packages, with no note or warning;
the deny-list prints “installed store: 0” and passes; the IOC store sweep warns but exits 0. Even
with a store present, **58 of 162 versions (36 %) are never inspected** because pnpm skips
platform-inapplicable optionals. Notably `repo-hygiene.mjs:236` does this correctly (*“a scan of
nothing proves nothing”*) — the principle exists in the codebase and was applied to 1 gate of 8.

**SUP-017 — FAIL (P1). `lib.mjs:171` exempts every `@prl/*` name from all dependency analysis** —
deny-list, host, integrity, release-age, OSV and SBOM. The `@prl` scope is **unclaimed on npm
(404)**, `.npmrc` maps it to the public registry, and pnpm ≥ 10 defaults
`link-workspace-packages: false`. A single `"@prl/x": "1.0.0"` specifier — a typo, or a malicious
PR — would pull a stranger's package from the public registry with **zero** gate coverage. This is
a textbook dependency-confusion exposure.

**SUP-007 — PARTIAL (P1 sub-finding).** The IOC persistence-artefact sweep over `node_modules`
checks `<store>/<pkg>@<ver>/`, a directory level pnpm **never populates** (files live at
`.../node_modules/<pkg>/`) — proven both ways. It also omits `.vscode/tasks.json`, which
`ioc-scan.mjs`'s **own header names verbatim as the reason the gate exists**, and
`.claude/settings.json`; an injected `codeql.yml` only warns.

> **The pattern worth naming:** the two gates aimed squarely at the campaign's two documented
> delivery mechanisms are the two that cannot fire. “All 8 gates passed” is *true*, and it
> materially overstates what was verified.

### P2 supply-chain findings
- **SUP-006** — the deny-list is 10 names + 2 scopes against a ~1,300-**version** campaign; it omits
  `@tanstack/`, `@mistralai/` and `@opensearch-project/`, which the repo's **own cited sources**
  name; and not one of its entries can ever occur in this graph, making it a permanent no-op here.
- **SUP-018** — `audit.mjs --offline` **exits 0** with 2 of 8 gates unrun; `deps:quarantine`
  consumes that exit code, and it overwrites `pnpm-lock.yaml` *before* asking the operator to review
  the diff.
- **SUP-019** — `sbom.mjs:9` claims validation in `scripts/supply-chain/sbom.test.mjs`, which **does
  not exist**; 7 of 8 gates have no test at all. Nothing gates CI action SHA pinning or Dockerfile
  base-image digest pinning — both currently correct, held by header comments only, so a
  `uses: actions/cache@v4` added tomorrow passes all 8 gates. **CI never builds either Dockerfile**,
  so the release artefact is the one thing no automated check exercises.

### P3
SBOM marks every component `scope: "required"` including dev-only ones and carries no `licenses`;
`docs/sbom/*.json` is `.gitignore`d, so the SBOM's stated incident-response purpose depends
entirely on CI artefact retention; `policy-check.mjs`'s `INERT_IN_NPMRC` omits several policy keys
and examines only the root `.npmrc`; `ioc-scan.mjs` skips files over 8 MiB; `.dockerignore` does not
exclude `.npmrc` from the build context; 19 of 162 versions are under 14 days old (within the 7-day
policy, but worth a conscious release decision).

> **Operational note from Reviewer E:** writing a report *about* the campaign into the tree turned
> the repo's own IOC gate red, because the scanner's self-exclusion is a hardcoded three-path list.
> No new document about the campaign can coexist with the gate. Recorded as P3.

---

## Part 3 — Additional finding from the lead auditor

**LEAD-1 — Least-privilege database roles exist but are never exercised. P2.**
Corroborated independently by Reviewer G (OPS-008).

`pg_roles` on the live cluster: `poker` (`rolsuper = t`, `rolbypassrls = t`), `prl_migrator` (f),
`prl_app` (f). The API connects as **`poker` — a superuser that also bypasses RLS** — because that
is what `.env.example:109` and `docker-compose.yml` ship as `DATABASE_URL`.

`docs/RUNBOOK.md:187-220,300` now **correctly** documents connecting as a login role that is a
*member of* `prl_app` (the prior review's finding G11 is fixed at the documentation level), and
Reviewer G proved the role model genuinely works — 44/44 smoke checks as a `prl_api` member, with
`CREATE`/`TRUNCATE`/`DROP`/`DELETE` all denied.

But `.env.example`, `docker-compose.yml` and **both CI database jobs** connect as a superuser, so
**nothing automated ever exercises the privilege model**. A query needing an ungranted privilege
fails in production rather than in CI. The previous review recommended exactly this change; it
remains open.

---

## Conclusion

The application's security posture is **genuinely strong**, and the hidden-information guarantee —
the one property whose failure would be unrecoverable for a poker product — **holds under direct
attack**. The dependency graph is clean and was verified against upstream sources rather than
merely parsed.

The security failures that matter are not breaches; they are **controls that cannot detect one**:
four supply-chain gates that pass vacuously, a dependency-confusion exemption on an unclaimed npm
scope, and a privilege model that is never exercised outside documentation.
