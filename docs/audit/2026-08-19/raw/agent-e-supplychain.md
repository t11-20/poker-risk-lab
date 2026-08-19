# Agent E — Supply Chain (independent re-audit)

- **Auditor:** Reviewer E (did not author this tree)
- **Workspace:** `/Users/terence/Projects/exploration-sites/poker-risk-lab`
- **HEAD:** `f20bbad2f082e9fe135ce98070da16eff7cc3f14` (`f20bbad`)
- **Date:** 2026-08-19
- **Scope:** release/security supply-chain gates, resolved graph, CI/container pinning, negative controls
- **Not used as evidence:** `docs/audit/**` prior write-ups
- **Did not:** modify source, run `pnpm install` in the workspace, run `docker compose down`
- **Did:** read configs/scripts/CI/Docker/ADR 0007/`docs/SECURITY.md`; ask pnpm for *effective* config; run `pnpm run security:audit` and individual gates; inspect `pnpm-lock.yaml` + `pnpm list`; copy scripts/lockfile to `/tmp` for hostile fixtures

## Method (brief)

1. Effective policy via `pnpm config get` / `pnpm config list --json` (not file claims).
2. Live `pnpm run security:audit` (9/9 pass) and each offline-safe individual gate.
3. Resolved graph: `pnpm list -r --depth Infinity --json` + structured lockfile parse (`162` third-party versions, lockfile ↔ graph key-identical).
4. Negative controls in `/tmp/prl-nc-e-20260819` (and in-process fixtures importing exported checkers). A control that cannot fail was treated as theatre.
5. Public Mini Shai-Hulud reporting (Aikido, Snyk, SafeDep, StepSecurity, Orca, Datadog) used only to judge denylist *adequacy*, not as a substitute for graph inspection.

---

## Requirement table

| ID | Requirement | Verdict | Severity if not PASS | Evidence (short) |
| --- | --- | --- | --- | --- |
| SUP-001 | Exact version pins in every `package.json` (no `^`/`~`) | **PASS** | — | 9 manifests scanned. Every third-party specifier matches `X.Y.Z`. First-party uses `workspace:*` only. Mutating a copy to `^5.11.3` / `~1.3.0` made `checkWorkspaceManifests` fail (NC7). `packageExtensions` in `pnpm-workspace.yaml` still carry upstream `^` peer ranges — not `package.json`, not a SUP-001 miss (P3 note). |
| SUP-002 | `packageManager` pinned with integrity hash; `engines` constraints | **PASS** | — | Root `package.json`: `pnpm@11.10.0+sha256.620b6605ea4f62fc56a6d0a98733f479071d0321e03e486b522c7e9a74617431`; `engines.node` `>=24.18.0 <25`, `engines.pnpm` `>=11.10.0 <12`. Policy gate asserts the hash form. `.node-version` is `24.18.0`. Live toolchain: Node `v24.18.0`, pnpm `11.10.0`. |
| SUP-003 | `ignoreScripts` in **effect**; policy in workspace yaml not `.npmrc`; `.npmrc` gate works | **PASS** | — | `pnpm config get ignore-scripts` → `true`. `pnpm config list --json` → `ignoreScripts: true`. `.npmrc` contains only `registry` / `@prl:registry`. Copying `ignore-scripts=true` and `minimum-release-age=10080` into a sandbox `.npmrc` made `policy-check.mjs` exit 1 (NC3). |
| SUP-004 | Empty build allowlist; no installed package can run an install script | **PASS** | — | Effective `onlyBuiltDependencies: []`, `dangerouslyAllowAllBuilds: false`. On-disk scan: **0** of 104 installed manifests declare `preinstall`/`install`/`postinstall`. 58 platform-skipped versions: provenance read published `scripts` for **58/58**. NC9: `ignoreScripts: true` → local `file:` package with pre/install/postinstall did **not** write the marker file; same package with scripts enabled **did** (PREINSTALL/INSTALL/POSTINSTALL). |
| SUP-005 | `minimumReleaseAge` (7-day) configured **and** effective | **PASS** | — | Effective `minimumReleaseAge: 10080`, `minimumReleaseAgeExclude: []`. Policy gate asserts `>= 10080` and empty exclude. NC10: `pnpm add vitest@4.1.11` (published 2026-08-18, **0.70 d** old) → `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. Current graph youngest: `ip-address@10.5.0` at **9.06 d**; **0** under 7 d. |
| SUP-006 | Denied families adequate **and** enforced against the **resolved** graph | **PASS (residual P2)** | P2 | Gate walks `pnpm list` graph **and** on-disk store (`checkResolvedGraph` / `checkInstalledStore`). Live: 0 denied names. NC2: inserting `keyv`, `@antv/g2`, `@tanstack/react-query`, `@mistralai/client`, `@opensearch-project/opensearch`, `timeago.js`, `echarts-for-react` each produced a failure; `fastify` did not. Cache family + `@antv/` + snapshot standalones + `@tanstack/` / `@mistralai/` / `@opensearch-project/` are denied. **Gap:** public Mini Shai-Hulud reporting also names `@uipath/*`, `@squawk/*`, `@tallyui/*`, `@beproduct/*`, `canvas-nest.js`, `intercom-client` — none denied, none present. Not P0: the list *is* applied to the resolved graph; no known-compromised package is installed. |
| SUP-007 | Mini Shai-Hulud IOC scan is meaningful, not theatre | **PASS (residual P2)** | P2 | Live sweep: **10564** files / **125.9 MiB**, 9 string markers, 2 hashes, 6 artefact paths; **104** physical package dirs. NC5: payload string hits; empty store **fails**; poisoned dep at `node_modules/.pnpm/evil@1.0.0/node_modules/evil/.claude/setup.mjs` **blocks**. Not a no-op. Residuals: empty `IOC_STRINGS`/`IOC_HASHES`/`IOC_PATHS` are not asserted (fail-open catalog); repo-root `.vscode/tasks.json` is **warn-only**. |
| SUP-008 | No git/tarball deps; no `npx`/`dlx`; no `file:`/`link:` outside the repo | **PASS** | — | Structured parse of `pnpm-lock.yaml`: 162 resolutions, **only** keys `integrity` (0 `type`/`repo`/`commit`/`directory`/`path`/`tarball`). All 162 `resolved` hosts = `registry.npmjs.org`. 21 `link:` importers, all under `packages/*`. First-party grep of manifests/scripts/workflows/Dockerfiles: no `npx`, `pnpm dlx`, `yarn dlx`, `bunx`, `git+`, `github:`. (`sharp@0.35.3` *declares* an unused `docs-publish` containing `npx`; that script is not an install hook and is not invoked here.) |
| SUP-009 | SBOM generated, complete, valid CycloneDX | **PASS** | — | Live gate wrote `docs/sbom/poker-risk-lab.cdx.json` (gitignored artefact). `bomFormat=CycloneDX`, `specVersion=1.6`, schema 1.6. **170** components = **162** third-party + **8** workspace (root is `metadata.component`; 9 workspace projects − root). **0** resolved keys missing; **0** extras. 10-package spot-check (fastify, next, react, postgres, typescript, `@biomejs/biome`, `@fastify/helmet`, axe-core, `@swc/helpers`, ws): each in graph + lock + SBOM; SHA-512 digest **equals** lockfile SRI. Dependency graph: 0 dangling refs. Regenerates without wall-clock `timestamp`. |
| SUP-010 | OSV / vulnerability scan run; real advisory results (or honest empty) | **PASS** | — | Live: queried **162** versions; `no advisories matched any resolved version`; `osv-report.json` has `packagesQueried: 162`, `findings: []`. Allowlist file is empty (`allow: []`) and requires `expires`. NC6: `fetchJson` to `127.0.0.1:1` → gate **crashed**, exit **1** (fail-closed). Not a silent skip. |
| SUP-011 | Every third-party CI action pinned to a full 40-char commit SHA | **PASS** | — | 2 workflows, **24** `uses:` lines, each `owner/repo@<40 hex>` + version comment. Cross-checked tags: `actions/checkout@v7.0.1` → `3d3c42e5aac5ba805825da76410c181273ba90b1`; `actions/setup-node@v7.0.0` → `820762786026740c76f36085b0efc47a31fe5020`; `actions/upload-artifact@v7.0.1` → `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`. NC4: `actions/cache@v4` / `ubuntu-latest` fail. |
| SUP-012 | CI permissions least-privilege; no `pull_request_target`; no secret exposure | **PASS (residual P3)** | P3 | Both workflows: top-level `permissions: { contents: read }` only; no job-level widening; `persist-credentials: false`; no `secrets.*`, `id-token`, `NPM_TOKEN`, `pull_request_target`. No secrets referenced. Residual: `ci-pinning.mjs` does **not** fail a future `pull_request_target` or `permissions: write-all` — pinning is gated, privilege posture is review-only. |
| SUP-013 | Container deps: base images digest-pinned; scripts disabled in image build | **PASS** | — | `Dockerfile.api` / `Dockerfile.web`: `FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`; both `pnpm install … --frozen-lockfile --ignore-scripts`; runtime `USER node`. Compose: `postgres:16-bookworm@sha256:60f4…b537`, `nginxinc/nginx-unprivileged:1.29.8-alpine@sha256:0c79…fbe6`. No `# syntax=` frontend. NC4: tag-only `FROM` / compose `image:` fail. |
| SUP-014 | `pnpm run security:audit` runs all claimed gates and blocks on failure | **PASS** | — | Aggregator wires 9 scripts: policy, hygiene, deny-list, dep-shapes, ioc-scan, ci-pinning, provenance, osv-scan, sbom. Live run: all 9 executed and passed. Inventory self-test: every non-helper `*.mjs` in `scripts/supply-chain/` is wired. Offline skip is **exit 2**, not 0 (NC-offline). A failing child sets aggregator exit 1. |
| SUP-015 | Lockfile non-registry-resolution patterns can actually fire | **PASS** | — | NC1: injected pnpm-format git (`resolution: {commit, repo, type: git}`), off-registry tarball, and directory resolution into a copy of the real lockfile → **9** failures, exit 1. No `git+ssh://` needed (that was the old dead regex). Unknown key `bundle` also fails (unit + design). Empty lockfile fails (`parsed zero package entries`). |
| SUP-016 | Install-hook / on-disk / IOC-store checks are not vacuous | **PASS (residual P2)** | P2 | `requireStoreCoverage` fails on missing/empty store and on unexplained missing versions (NC5). Hook scan fails on a fixture `preinstall` (NC7). Deny-list fails on disk `cacheable`. IOC store sweep is the same coverage helper. Residual: **empty IOC definition arrays are not a failure** (catalog can be deleted and the sweep still “passes” if the store exists). |
| SUP-017 | No dependency name exempt from analysis unless justified | **PASS** | — | Workspace packages excluded by **resolution** (`link:` to a project path), not by `@prl/` name prefix (`lib.mjs` documents the old name-based hole). OSV allowlist empty. `minimumReleaseAgeExclude: []`. Deny-list has no allow-exceptions. Platform-skipped optionals are still in the resolved graph and are integrity/age/hook-checked via the registry. |
| SUP-018 | `--offline` / failed-network audit cannot report success if it skipped work | **PASS** | — | `node scripts/supply-chain/audit.mjs --offline` printed `2 network gate(s) skipped — NOT a valid release audit` and exited **2**. OSV transport failure exits **1** (NC6). Provenance fetch errors are `gate.fail` (`could not fetch registry metadata`). |
| SUP-019 | Claimed self-tests exist; CI/container pinning is gated | **PASS (residual P3)** | P3 | `node --test scripts/supply-chain/*.test.mjs`: **92/92 pass**. Pinning is a first-class gate (`ci-pinning.mjs`) with negative tests (`@v4`, `ubuntu-latest`, tag-only `FROM`, injected `codeql.yml`). Honest gap: `KNOWN_UNTESTED = ['repo-hygiene', 'osv-scan']` — named, not silently missing. |
| SUP-020 | Lifecycle scripts cannot run in CI or local install | **PASS (residual P2)** | P2 | Effective `ignoreScripts: true` + empty allowlist. NC9 proves the setting actually blocks hooks. Dockerfiles pass `--ignore-scripts` as well. **CI does not:** every `pnpm install` is `pnpm install --frozen-lockfile` with **no** `--ignore-scripts` flag (9 in `ci.yml`, 1 in `supply-chain.yml`). Relies on workspace yaml. Policy-check runs **after** install, so a hypothetical env override (`pnpm_config_ignore_scripts=false`) would execute hooks before the gate. Not current: CI does not set that override; effective config is `true`. |
| SUP-021 | `verifyDepsBeforeRun` / frozen lockfile in CI | **PASS** | — | Effective `verifyDepsBeforeRun: "error"`, `preferFrozenLockfile: true`. Policy gate asserts `verifyDepsBeforeRun` is `error` or `true` (and strips pnpm’s re-entrancy `pnpm_config_verify_deps_before_run=false` when spawned via `pnpm run`). All 10 CI installs use `--frozen-lockfile`; none use `--no-frozen-lockfile`. |
| SUP-022 | Provenance not treated as a security control | **PASS** | — | `provenance.mjs` records `npmAttestationPresent` and writes a note that Mini Shai-Hulud forged Sigstore attestations. Missing attestation is **not** `gate.fail`. Integrity mismatch and age `< cooldown` **are** failures. ADR 0007 / `docs/SECURITY.md` match the code. |
| SUP-023 | Release-age policy cannot be bypassed by a just-published package | **PASS** | — | NC10: resolution refuses `vitest@4.1.11`. NC11: lockfile generated with `minimumReleaseAge: 0`, then `pnpm install --frozen-lockfile` under `minimumReleaseAge: 10080` → `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, **vitest not installed**. pnpm 11 re-verifies the lockfile against the cooldown even when resolution is skipped. Provenance would also fail (`ageDays 0.70 < 7`). Residual P3: missing registry `time` is a **warn**, not a fail (no such package in this graph). |
| SUP-024 | No prohibited git/tarball deps in lockfile resolutions | **PASS** | — | Same parse as SUP-008: 162 `packages:` entries, 0 non-registry resolution keys, 0 off-registry tarball hosts, 0 odd importer versions. Snapshots section is the peer/optional graph only (no alternate acquisition channel). |

### Additional items (SUP-020+)

| ID | Item | Verdict | Severity | Notes |
| --- | --- | --- | --- | --- |
| SUP-025 | CI install belt-and-braces `--ignore-scripts` | **PARTIAL** | P2 | Docker has the flag; CI does not. Policy is in effect today (SUP-003/020). |
| SUP-026 | Denylist covers all *publicly named* Mini Shai-Hulud families | **PARTIAL** | P2 | Snapshot families yes; `@uipath` / `@squawk` / several standalones no. Not in graph. |
| SUP-027 | IOC catalog fail-closed if emptied | **FAIL (quality)** | P2 | No minimum-length assertion on `IOC_STRINGS` / `IOC_HASHES` / `IOC_PATHS`. |
| SUP-028 | Repo-root campaign editor IOCs block the release | **PARTIAL** | P2 | `.claude/setup.mjs` / `.vscode/setup.mjs` / `cat.py` block. `.vscode/tasks.json` and `.claude/settings.json` at repo root **warn**; `security:audit` still exits 0. `codeql.yml` is blocked by the pinning inventory, not by IOC severity. |

---

## Negative-control results

All hostile work was under `/tmp/prl-nc-e-20260819` or in-process Maps. The workspace lockfile/manifests were not mutated.

| ID | Control | Expected if the gate is real | Observed | Fires? |
| --- | --- | --- | --- | --- |
| NC-offline | `audit.mjs --offline` | non-zero | Exit **2**; two network gates named as skipped; “NOT a valid release audit” | **YES** |
| NC1 | Insert pnpm-format `type: git` + off-registry `.tgz` + `type: directory` into a **copy** of `pnpm-lock.yaml`; `dep-shapes.mjs --lockfile` | fail | Exit 1; 9 findings (`git commit/repo`, `non-registry resolution type`, `off-registry tarball`, `local directory`, raw-text tarball backstop) | **YES** |
| NC2 | Feed `checkResolvedGraph` denied names/scopes; `checkInstalledStore` `cacheable` | fail | Each denied name → 1 failure; `fastify` → 0; disk `cacheable` → fail | **YES** |
| NC3 | Sandbox repo: policy keys in `.npmrc` (`ignore-scripts=true`, `minimum-release-age=10080`) | fail | Exit 1: `policy setting "ignore-scripts" found in .npmrc` (and minimum-release-age) | **YES** |
| NC4 | Workflow `uses: actions/checkout@v4` + `runs-on: ubuntu-latest`; `FROM node:…` without digest; compose `image: postgres:16-bookworm`; inventory + `codeql.yml` | fail | 4 workflow failures; 1 FROM; 1 compose; `unexpected workflow file: .github/workflows/codeql.yml`. Pinned 40-char SHA → 0 failures | **YES** |
| NC5 | Empty store / incomplete store / poisoned pnpm layout / campaign string | fail (store + payload); warn (repo `tasks.json`) | Empty store fails; unexplained missing versions fail; `.claude/setup.mjs` in package root **blocking**; string (campaign title fingerprint) hits; repo-root `tasks.json` **blocking=false** | **YES** (store/payload); **warn-only** (repo `tasks.json`) |
| NC6 | OSV `fetchJson` to `https://127.0.0.1:1` (timeout 800 ms, 0 retries) | fail-closed | `osv-vulnerability-scan — gate crashed: fetch failed`, code **1** | **YES** |
| NC7 | Installed manifest with `preinstall`/`postinstall`; workspace manifest with `^`/`~` and `@prl/evil: 1.0.0` | fail | Hook failure on `evil@1.0.0`; 6 manifest failures (ranges + missing `workspace:`) | **YES** |
| NC8 | Empty IOC definition arrays | fail-closed *if claimed* | `ioc-scan.mjs` does **not** assert `IOC_STRINGS.length > 0` (or hashes/paths). Count is only `note`d | **NO** (catalog fail-open) |
| NC9 | Local `file:` package with pre/install/postinstall; install with `ignoreScripts: true` vs `false` | on: no hook; off: hook | **ON:** `POLICY_ON_HOOK_FILE_EXISTS=NO`. **OFF:** file written `PREINSTALL` / `INSTALL` / `POSTINSTALL` | **YES** (control is real) |
| NC10 | `pnpm add vitest@4.1.11` under `minimumReleaseAge: 10080` | reject | `ERR_PNPM_NO_MATURE_MATCHING_VERSION` (vitest + 14 related versions). Exit 1. No lockfile adopted | **YES** |
| NC11 | Resolve vitest with age=0; then `--frozen-lockfile` with age=10080 | reject | `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` (24 lockfile entries). `VITEST_INSTALLED=NO`. Same without `--ignore-scripts` (CI shape) | **YES** |
| NC12 | Provenance age math on `vitest@4.1.11` | would fail | `ageDays: 0.70`, `wouldFail: true`. Attestation is not a fail path | **YES** (logic) |

**Theatre check:** the one control that *did not* fail is NC8 (empty IOC catalog). That is a quality defect in the *definitions*, not a dead checker: the same functions fail on a real payload and on an empty store.

---

## Live audit (this tree, this machine)

```
pnpm run security:audit          # exit 0 — 9/9 pass
node scripts/supply-chain/audit.mjs --offline   # exit 2
pnpm run security:policy|denylist|shapes|ioc|pinning|hygiene|sbom  # each exit 0
```

| Gate | Live notes |
| --- | --- |
| policy-in-effect | 12 settings vs effective config; stripped `pnpm_config_verify_deps_before_run`; `packageManager` hashed |
| repo-hygiene | 468 first-party files; 203 files / 8 `src/` trees for `Math.random` |
| deny-list | 162 resolved / 104 on disk / 58 platform-skipped; 0 hits |
| dependency-shapes | lockfileVersion 9.0; 162 resolutions; 49 importer edges; 7 source-time hooks (`prepare`/`prepack`) only; 9 manifests exact |
| ioc-sweep | 10564 files, 125.9 MiB, 104 package dirs |
| ci-and-container-pinning | 2 workflows, 24 action refs, 2 Dockerfiles / 2 external bases, 1 compose / 2 images |
| integrity + release age | 162 registry queries; 58/58 skipped manifests hook-checked; 65/162 have npm attestation (recorded only); 0 integrity mismatches |
| OSV | 162 queried, 0 findings |
| SBOM | 170 components, 171 dependency records |

Effective pnpm config (abridged): `ignoreScripts=true`, `onlyBuiltDependencies=[]`, `dangerouslyAllowAllBuilds=false`, `minimumReleaseAge=10080`, `minimumReleaseAgeExclude=[]`, `verifyStoreIntegrity=true`, `verifyDepsBeforeRun=error`, `saveExact=true`, `strictPeerDependencies=true`, `autoInstallPeers=false`, `engineStrict=true`, `packageManagerStrict=true`, `preferFrozenLockfile=true`, `registry=https://registry.npmjs.org/`.

Graph vs lockfile: **162 = 162**, 0 only-lock, 0 only-list. Hosts: `registry.npmjs.org` × 162. Denied in graph/disk: 0. Install hooks on disk: 0. Fastify caches via `toad-cache@3.7.4`, not `keyv`.

---

## Findings

### P0

*None.* Scripts are disabled and that setting can be shown to block a real hook. CI actions are 40-char SHA pins (tags cross-checked). The denylist *does* inspect the resolved graph (negative control). No named compromised package is present.

### P1

*None* that meet the stated bar (claimed gate that cannot fail; missing SHA pin; release-age not effective). Offline mode used to exit 0; it now exits 2 (reproduced). Frozen lockfiles that already pin a young package are still rejected by pnpm 11’s lockfile policy check (reproduced with `vitest@4.1.11`).

### P2

1. **CI install omits `--ignore-scripts` (SUP-020 / SUP-025).** Dockerfiles pass the flag. GitHub Actions does not. Today the workspace yaml value is `true` and NC9 shows that is sufficient — but the policy gate that *asserts* it runs after `pnpm install`. An env override in CI would execute lifecycle scripts before any gate could stop them.
2. **Denylist is snapshot-complete, not campaign-complete (SUP-006 / SUP-026).** `@uipath/*`, `@squawk/*`, `@tallyui/*`, `@beproduct/*`, `canvas-nest.js`, `intercom-client` appear in 2026 Mini Shai-Hulud write-ups and are absent from `denied-packages.mjs`. None are in this graph. Structural controls (no scripts, no git, 7-day age) still apply. A new dependency from those families would not trip the name gate.
3. **IOC catalog can be emptied without failing (SUP-007 / SUP-016 / SUP-027).** `ioc-scan.mjs` notes marker counts; it does not require them to be non-zero. A one-line deletion of `IOC_STRINGS` / `IOC_HASHES` / `IOC_PATHS` would leave a green sweep of an intact store.
4. **Repo-root editor persistence is warn-only (SUP-028).** `.vscode/tasks.json` and `.claude/settings.json` at the repo root do not fail `security:audit`. The campaign’s *payload* paths (`.claude/setup.mjs`, `.vscode/setup.mjs`, `cat.py`) do fail. Injected `codeql.yml` fails via workflow inventory, not via IOC severity.

### P3

1. **`osv-scan.mjs` and `repo-hygiene.mjs` have no dedicated tests** (`KNOWN_UNTESTED`). OSV fail-closed was proven independently (NC6). Hygiene was not given a hostile fixture in this audit.
2. **Missing registry publish time is a warning** in `provenance.mjs`, not a failure. No current package lacks `time`.
3. **`preferFrozenLockfile` is not in the policy-check `REQUIRED` list** (it is set, and CI passes `--frozen-lockfile` explicitly).
4. **Pinning gate does not encode least-privilege or `pull_request_target`** (current YAML is clean).
5. **The ioc-scan unit named “FAILS on a known payload hash” asserts a *string* hit** (Linux `/proc/self` + `/mem` in a tiny `cat.py`), not `IOC_HASHES` lookup of the recorded SHA-256. The hash map itself is present (2 entries); this audit did not possess the payload bytes.
6. **`packageExtensions` peer ranges** (`fastify: ^5.0.0`, etc.) are copied from upstream and are not install specifiers.

---

## Counts

| Metric | Count |
| --- | --- |
| Catalog IDs (SUP-001–028) | 28 |
| **PASS** | 22 |
| **PASS (residual)** (counted in PASS) | 5 of those 22 |
| **PARTIAL** | 3 (SUP-025, 026, 028) |
| **FAIL (quality)** | 1 (SUP-027 empty IOC catalog) |
| **P0** | 0 |
| **P1** | 0 |
| **P2** | 4 |
| **P3** | 6 |
| Third-party resolved versions | 162 |
| On-disk / platform-skipped | 104 / 58 |
| Denied hits in graph | 0 |
| Install-time hooks on disk | 0 |
| OSV findings | 0 |
| Action refs SHA-pinned | 24 / 24 |
| External container images digest-pinned | 4 / 4 (2 Dockerfile FROM + 2 compose) |
| Self-tests | 92 pass / 0 fail |
| Live `security:audit` | 9/9 pass, exit 0 |
| `--offline` | exit 2 |

---

## Verdict

The supply-chain program is **real, not theatre**. The gates that previous reviews claimed were dead (lockfile acquisition-channel regexes, empty-store “pass”, offline exit 0, `.npmrc` policy, unpinned Actions) **fail when fed the attack they name**. `ignoreScripts` and `minimumReleaseAge` are in *effective* pnpm config and were shown to block a hook and a 0.7-day-old package, including a frozen lockfile that already pinned it.

No P0/P1. Residuals are defense-in-depth (CI `--ignore-scripts`), denylist breadth vs the public campaign, and IOC catalog/severity edges.

**Do not treat this file as a remediation patch.** No source was changed.
